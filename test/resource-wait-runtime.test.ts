import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServiceHost, createBackgroundRuntime } from '../src/background-runtime.ts';
import { readWaitIdentity, tryWaitLease } from '../src/resource-wait-identity.ts';
import { connectResourceWait, createResourceWaitSocketHost } from '../src/resource-wait-transport.ts';
import type { ResourceWaitProtocol } from '../src/resource-wait-protocol.ts';
import { runResourceWaitCommand } from '../src/resource-wait-protocol.ts';

async function fixture() {
  const directory = await mkdtemp('/tmp/raf-wait-runtime-');
  const socketPath = join(directory, 'service.sock');
  const identity = await readWaitIdentity();
  let epoch = '';
  let enqueued = 0;
  let finishReady!: () => void;
  let enteredReady!: () => void;
  let receivedCancel!: () => void;
  const readyBarrier = new Promise<void>(resolve => { finishReady = resolve; });
  const readyEntered = new Promise<void>(resolve => { enteredReady = resolve; });
  const cancelled = new Promise<void>(resolve => { receivedCancel = resolve; });
  const ticket = { requestId: 'request', serviceEpoch: '' };
  const protocol = {
    enqueue: () => { enqueued++; return { ...ticket, serviceEpoch: epoch }; },
    ready: async () => { enteredReady(); await readyBarrier; return 'ignored'; },
    cancel: async () => { receivedCancel(); return 'cancelled'; },
    disconnect: async () => {},
  } as unknown as ResourceWaitProtocol;
  const sockets = createResourceWaitSocketHost(() => protocol, () => epoch, 30000);
  const host = await runServiceHost({ stateDirectory: directory, socketPath, handlers: {
    recover: async bootstrap => { epoch = bootstrap!.serviceEpoch; }, resourceWait: sockets.attach,
    handle: async () => null, shutdown: async () => {},
  } });
  return { directory, socketPath, identity, readyEntered, cancelled, finishReady, enqueued: () => enqueued,
    endpoint: { endpoint: socketPath, serviceEpoch: epoch },
    close: async () => { finishReady(); await host.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('[resource-wait/runtime] OS lease survives helper exit and releases without deleting the lock inode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raf-wait-lock-'));
  const path = join(directory, 'owner.lock');
  let first = await tryWaitLease(path);
  if (!first) throw new Error('First owner did not acquire OS lock');
  try {
    assert.equal(await tryWaitLease(path), null);
    await first.release(); first = null;
    const second = await tryWaitLease(path);
    if (!second) throw new Error('Second owner did not acquire released OS lock');
    await second.release();
    assert.equal((await readFile(path)).length, 0);
  } finally { await first?.release(); await rm(directory, { recursive: true, force: true }); }
});

test('[resource-wait/runtime] actual Unix peer enqueues; cancel is read while ready awaits an OS barrier', async () => {
  const f = await fixture();
  const connection = await connectResourceWait(f.endpoint);
  try {
    const ticket = await connection.enqueue({ level: 'normal', developmentDirectory: f.directory, clientIdentity: f.identity, connectionId: 'untrusted' });
    assert.equal(ticket.serviceEpoch, f.endpoint.serviceEpoch);
    await connection.sendReady({ ...ticket, offerId: 'offer', deadline: 100 });
    await f.readyEntered;
    await connection.cancel(ticket);
    await f.cancelled;
    assert.equal(f.enqueued(), 1);
  } finally { await connection.close(); await f.close(); }
});

test('[resource-wait/runtime] forged peer PID and stale epoch cannot enqueue', async () => {
  const f = await fixture();
  try {
    for (const [serviceEpoch, identity] of [[f.endpoint.serviceEpoch, { ...f.identity, pid: f.identity.pid + 1 }], ['stale', f.identity]] as const) {
      const connection = await connectResourceWait({ ...f.endpoint, serviceEpoch });
      try { await assert.rejects(connection.enqueue({ level: 'normal', developmentDirectory: f.directory, clientIdentity: identity, connectionId: 'claimed' }), /peer|PID|epoch/i); }
      finally { await connection.close(); }
    }
    assert.equal(f.enqueued(), 0);
  } finally { await f.close(); }
});

test('[resource-wait/runtime] reuse requires the current ready epoch and OS owner; a live mismatched endpoint is not replaced', async () => {
  const f = await fixture();
  let spawns = 0;
  const runtime = createBackgroundRuntime({ stateDirectory: f.directory, socketPath: f.socketPath, entryRelativePath: 'bin/service.ts', readinessTimeoutMs: 30000 }, {
    resolveMainPath: async () => { spawns++; throw new Error('Must reuse or refuse live owner'); },
  });
  try {
    const ready = await runtime.ensureReady();
    assert.equal(ready.exitCode, 0);
    assert.equal('serviceEpoch' in ready && ready.serviceEpoch, f.endpoint.serviceEpoch);
    const path = join(f.directory, 'service.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...record, token: 'stale' }));
    const rejected = await runtime.ensureReady();
    assert.equal(rejected.exitCode, 1);
    assert.match('details' in rejected ? rejected.details : '', /alive|readiness/i);
    assert.equal(spawns, 0);
  } finally { await f.close(); }
});

test('[resource-wait/runtime] cancellation during readiness never opens a connection', async () => {
  const controller = new AbortController();
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const readiness = new Promise<void>(resolve => { finish = resolve; });
  let connects = 0;
  const waiting = runResourceWaitCommand({ level: 'normal', developmentDirectory: '/tmp', clientIdentity: await readWaitIdentity(), connectionId: '', signal: controller.signal }, { levels: [{ id: 'normal', priority: 1 }] }, {
    ensureReady: async () => { start(); await readiness; return { endpoint: 'unused', serviceEpoch: 'e1' }; },
    connect: async () => { connects++; throw new Error('Cancelled caller must not connect'); }, recordDuration: () => {},
  });
  await started;
  controller.abort();
  try { assert.equal((await waiting).exitCode, 1); assert.equal(connects, 0); }
  finally { finish(); }
});


test('[resource-wait/runtime] cancelling startup releases its OS lease while the resolver is blocked', async () => {
  const directory = await mkdtemp('/tmp/raf-wait-cancel-');
  const controller = new AbortController();
  let entered!: () => void;
  const resolving = new Promise<void>(resolve => { entered = resolve; });
  let finish!: (path: string) => void;
  const path = new Promise<string>(resolve => { finish = resolve; });
  const runtime = createBackgroundRuntime({ stateDirectory: directory, socketPath: join(directory, 'service.sock'), entryRelativePath: 'unused.ts', readinessTimeoutMs: 30000 }, {
    resolveMainPath: async signal => { assert.equal(signal, controller.signal); entered(); return path; },
  });
  try {
    const waiting = runtime.ensureReady({ signal: controller.signal });
    await resolving;
    controller.abort();
    const result = await waiting;
    assert.equal(result.exitCode, 1);
    assert.match('details' in result ? result.details : '', /cancelled/);
    const lease = await tryWaitLease(join(directory, 'service-start.lock'));
    assert.ok(lease, 'startup ownership must not remain held by its pending resolver');
    await lease.release();
  } finally { finish(directory); await rm(directory, { recursive: true, force: true }); }
});
