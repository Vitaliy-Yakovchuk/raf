import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceLifecycleController, ServiceProducerRuntime } from '../src/service-lifecycle.ts';
import type { ServiceLifecyclePorts, ServiceLifecycleRecord, ServiceReadiness, ServiceProducerPorts, SharedSystemDelivery } from '../src/service-lifecycle.ts';
import type { BackgroundRuntimeOptions, ServiceFailure, ServiceStatus } from '../src/background-runtime.ts';
import type { ResourceWaitIdentity } from '../src/resource-wait-protocol.ts';
import type { MainNotifier } from '../src/bug-sync.ts';

const owner: ResourceWaitIdentity = { pid: 41, startedAt: 'start-A', machineId: 'machine', bootId: 'boot' };
const generation = '/verified/generations/A/raf-main';
const readyRecord = (): ServiceLifecycleRecord => ({ pid: owner.pid, identity: { ...owner }, serviceEpoch: 'epoch-A', mainPath: generation, state: 'ready', stopReason: null });
const readiness = (): ServiceReadiness => ({ pid: owner.pid, identity: { ...owner }, serviceEpoch: 'epoch-A', mainPath: generation, exclusiveOwner: true, databaseOpen: true, lastGrantLoaded: true, resourceWaitReady: true });
const readyStatus = (): ServiceStatus => ({ exitCode: 0, state: 'ready', pid: owner.pid, mainPath: generation, stopReason: null, reasonKnown: false, serviceEpoch: 'epoch-A', resourceWaitReady: true });
const options: BackgroundRuntimeOptions = { stateDirectory: '/isolated/state', socketPath: '/isolated/service.sock', entryRelativePath: 'bin/service.ts', readinessTimeoutMs: 80 };

function fixture() {
  let now = 100;
  let record: ServiceLifecycleRecord | null = null;
  let proof: ServiceReadiness | null = null;
  let observation: 'alive' | 'dead' | 'unknown' = 'dead';
  const calls: { name: string; value?: unknown }[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const ports: ServiceLifecyclePorts = {
    now: () => now,
    exclusive: async (deadline, operation) => {
      calls.push({ name: 'exclusive', value: deadline });
      const result = tail.then(operation);
      tail = result.catch(() => {});
      return result;
    },
    readRecord: async () => structuredClone(record),
    observe: async identity => { calls.push({ name: 'observe', value: identity }); return observation; },
    resolveMainPath: async () => { calls.push({ name: 'route' }); return generation; },
    validateMainSnapshot: async root => { calls.push({ name: 'validate', value: root }); return true; },
    entryExists: async entry => { calls.push({ name: 'entry', value: entry }); return true; },
    spawn: async input => {
      calls.push({ name: 'spawn', value: input });
      record = readyRecord(); proof = readiness(); observation = 'alive';
      return { ...owner };
    },
    handshake: async deadline => { calls.push({ name: 'handshake', value: deadline }); return structuredClone(proof); },
    waitForChange: async deadline => { calls.push({ name: 'wait', value: deadline }); now = Math.min(deadline, now + 20); },
    shutdown: async (identity, deadline) => { calls.push({ name: 'shutdown', value: { identity, deadline } }); return { acknowledged: true }; },
    awaitShutdown: async identity => {
      calls.push({ name: 'awaitShutdown', value: identity });
      observation = 'dead'; proof = null;
      record = { ...identity, state: 'stopped', stopReason: 'Service stopped normally' };
      return true;
    },
    exchange: async (request, epoch) => { calls.push({ name: 'exchange', value: { request, epoch } }); return { exitCode: 0, value: 'accepted' }; },
  };
  const runtime = new ServiceLifecycleController(options, ports);
  return {
    runtime, ports, calls,
    setRecord(value: ServiceLifecycleRecord | null) { record = structuredClone(value); },
    setProof(value: ServiceReadiness | null) { proof = structuredClone(value); },
    setObservation(value: typeof observation) { observation = value; },
    setNow(value: number) { now = value; },
    makeReady() { record = readyRecord(); proof = readiness(); observation = 'alive'; },
    named(name: string) { return calls.filter(call => call.name === name); },
  };
}

function failed(result: ServiceStatus | ServiceFailure, source: RegExp) {
  assert.equal(result.exitCode, 1);
  const failure = result as ServiceFailure;
  assert.match(failure.reason + ' ' + failure.details, source);
  assert.ok(failure.remediation.trim());
}

for (const flag of ['exclusiveOwner', 'databaseOpen', 'lastGrantLoaded', 'resourceWaitReady'] as const) {
  test(`U1: readiness requires ${flag}, not spawn or a live PID`, async () => {
    const f = fixture();
    f.ports.spawn = async input => {
      f.calls.push({ name: 'spawn', value: input }); f.setRecord(readyRecord());
      f.setObservation('alive'); f.setProof({ ...readiness(), [flag]: false }); return owner;
    };
    failed(await f.runtime.start(), /ready|initial|epoch|timeout|deadline/i);
    assert.equal(f.named('exchange').length, 0);
  });
}

for (const mismatch of ['serviceEpoch', 'identity', 'pid', 'mainPath'] as const) {
  test(`U1: stale handshake ${mismatch} cannot authorize an enqueue`, async () => {
    const f = fixture();
    f.makeReady();
    const proof = readiness();
    if (mismatch === 'identity') proof.identity.startedAt = 'reused-PID';
    else if (mismatch === 'pid') proof.pid = 99;
    else proof[mismatch] = 'different';
    f.setProof(proof);
    failed(await f.runtime.request({ operation: 'resource.wait', payload: {} }), /ready|owner|identity|epoch|path/i);
    assert.equal(f.named('exchange').length, 0);
    assert.equal(f.named('spawn').length, 0);
  });
}

test('U1: first start confirms initialization and the current owner before returning ready', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.start(), readyStatus());
  assert.equal(f.named('spawn').length, 1);
  assert.ok(f.named('handshake').length > 0);
  assert.ok(f.named('observe').length > 0);
});

test('U2: concurrent starts and repeated start share one verified service', async () => {
  const f = fixture();
  const results = await Promise.all([f.runtime.start(), f.runtime.start(), f.runtime.ensureReady()]);
  for (const result of results) assert.deepEqual(result, readyStatus());
  assert.equal(f.named('spawn').length, 1);
  assert.deepEqual(await f.runtime.start(), readyStatus());
  assert.equal(f.named('spawn').length, 1);
});

test('U2: lock contention and retries consume one readiness budget', async () => {
  const f = fixture();
  f.ports.exclusive = async (deadline, operation) => { f.calls.push({ name: 'exclusive', value: deadline }); f.setNow(150); return operation(); };
  f.ports.spawn = async input => { f.calls.push({ name: 'spawn', value: input }); f.setRecord(readyRecord()); f.setObservation('alive'); return owner; };
  failed(await f.runtime.start(), /ready|timeout|deadline/i);
  assert.equal(f.named('exclusive')[0].value, 180);
  assert.ok(f.named('handshake').length > 0);
  for (const call of [...f.named('handshake'), ...f.named('wait')]) assert.equal(call.value, 180);
  assert.equal((f.named('spawn')[0].value as { deadline: number }).deadline, 180);
});

test('U2: exhausted lock budget does not spawn or enqueue', async () => {
  const f = fixture();
  f.ports.exclusive = async (_deadline, operation) => { f.setNow(180); return operation(); };
  failed(await f.runtime.request({ operation: 'resource.wait', payload: {} }), /timeout|deadline|ready/i);
  assert.equal(f.named('spawn').length, 0);
  assert.equal(f.named('exchange').length, 0);
});

test('U2: aborted resource caller cannot spawn or enqueue', async () => {
  const f = fixture();
  const abort = new AbortController(); abort.abort();
  failed(await f.runtime.request({ operation: 'resource.wait', payload: {} }, { signal: abort.signal }), /abort|cancel/i);
  assert.equal(f.named('spawn').length, 0);
  assert.equal(f.named('exchange').length, 0);
});

test('U3: main route, entry and spawn cwd use the same verified generation', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.start(), readyStatus());
  assert.deepEqual(f.named('validate').map(call => call.value), [generation]);
  assert.deepEqual(f.named('entry').map(call => call.value), [generation + '/bin/service.ts']);
  assert.deepEqual(f.named('spawn')[0].value, { entry: generation + '/bin/service.ts', cwd: generation, mainPath: generation, deadline: 180 });
});

for (const defect of ['missing-main', 'missing-entry', 'invalid-origin', 'route-error'] as const) {
  test(`U3: ${defect} refuses start without develop fallback`, async () => {
    const f = fixture();
    if (defect === 'missing-main') f.ports.resolveMainPath = async () => '';
    if (defect === 'missing-entry') f.ports.entryExists = async () => false;
    if (defect === 'invalid-origin') f.ports.validateMainSnapshot = async () => false;
    if (defect === 'route-error') f.ports.resolveMainPath = async () => { throw new Error('route source unavailable'); };
    failed(await f.runtime.start(), /main|entry|origin|snapshot|route/i);
    assert.equal(f.named('spawn').length, 0);
  });
}

for (const entryRelativePath of ['../develop/bin/service.ts', '/develop/bin/service.ts']) {
  test(`U3: unsafe entry ${entryRelativePath} cannot escape the pinned root`, async () => {
    const f = fixture();
    const runtime = new ServiceLifecycleController({ ...options, entryRelativePath }, f.ports);
    failed(await runtime.start(), /entry|relative|within|path/i);
    assert.equal(f.named('spawn').length, 0);
  });
}

test('U3: publication of another logical main does not replace the live generation', async () => {
  const f = fixture(); f.makeReady();
  f.ports.resolveMainPath = async () => { assert.fail('ready service must retain its current generation'); };
  assert.deepEqual(await f.runtime.start(), readyStatus());
  assert.deepEqual(await f.runtime.status(), readyStatus());
  assert.equal(f.named('spawn').length, 0);
});

test('U4: first status is stopped with explicitly unknown diagnostics and no spawn', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.status(), { exitCode: 0, state: 'stopped', pid: null, mainPath: null, stopReason: null, reasonKnown: false });
  assert.equal(f.named('spawn').length, 0);
  assert.equal(f.named('route').length, 0);
});

for (const state of ['failed', 'stopped'] as const) {
  test(`U4: ${state} preserves the current lifecycle diagnostic across status instances`, async () => {
    const f = fixture();
    const reason = state === 'failed' ? 'SQLite lastGrant read failed' : 'Service stopped normally';
    f.setRecord({ ...readyRecord(), state, stopReason: reason });
    const expected = { exitCode: 0, state, pid: null, mainPath: generation, stopReason: reason, reasonKnown: true };
    assert.deepEqual(await f.runtime.status(), expected);
    assert.deepEqual(await new ServiceLifecycleController(options, f.ports).status(), expected);
    assert.equal(f.named('spawn').length, 0);
  });
}

test('U4: dead formerly ready owner has unknown reason instead of invented crash details', async () => {
  const f = fixture(); f.setRecord(readyRecord());
  assert.deepEqual(await f.runtime.status(), { exitCode: 0, state: 'failed', pid: null, mainPath: generation, stopReason: null, reasonKnown: false });
});

test('U4: persisted ready plus live PID without a current handshake is not ready', async () => {
  const f = fixture(); f.setRecord(readyRecord()); f.setObservation('alive');
  const result = await f.runtime.status();
  assert.equal(result.exitCode, 0);
  assert.equal((result as ServiceStatus).state, 'failed');
  assert.equal((result as ServiceStatus).reasonKnown, false);
  assert.equal(f.named('spawn').length, 0);
});

for (const source of ['record', 'identity'] as const) {
  test(`U4: ${source} read failure returns diagnostics rather than a successful stopped status`, async () => {
    const f = fixture(); f.makeReady();
    if (source === 'record') f.ports.readRecord = async () => { throw new Error('record EACCES'); };
    else f.ports.observe = async () => { throw new Error('identity EPERM'); };
    failed(await f.runtime.status(), new RegExp(source + '.*E(?:ACCES|PERM)'));
    assert.equal(f.named('spawn').length, 0);
  });
}

test('U5: stop awaits verified shutdown and repeated stop preserves normal diagnostics', async () => {
  const f = fixture(); f.makeReady();
  const expected = { exitCode: 0, state: 'stopped', pid: null, mainPath: generation, stopReason: 'Service stopped normally', reasonKnown: true };
  assert.deepEqual(await f.runtime.stop(), expected);
  assert.deepEqual(await f.runtime.stop(), expected);
  assert.equal(f.named('shutdown').length, 1);
  assert.equal(f.named('awaitShutdown').length, 1);
  assert.equal(f.named('spawn').length, 0);
});

test('U5: accepted stop request is not successful shutdown', async () => {
  const f = fixture(); f.makeReady();
  f.ports.awaitShutdown = async () => false;
  failed(await f.runtime.stop(), /shutdown|stop|deadline|timeout/i);
});

for (const defect of ['unknown-identity', 'reused-pid', 'foreign-epoch'] as const) {
  test(`U5: ${defect} refuses stop without signalling or deleting a foreign endpoint`, async () => {
    const f = fixture(); f.makeReady();
    if (defect === 'unknown-identity') f.setObservation('unknown');
    if (defect === 'reused-pid') f.setProof({ ...readiness(), identity: { ...owner, startedAt: 'different-start' } });
    if (defect === 'foreign-epoch') f.setProof({ ...readiness(), serviceEpoch: 'foreign-epoch' });
    failed(await f.runtime.stop(), /identity|owner|epoch|verified|ready/i);
    assert.equal(f.named('shutdown').length, 0);
    assert.equal(f.named('awaitShutdown').length, 0);
    assert.equal(f.named('spawn').length, 0);
  });
}

test('U5: stop after crash retains failure and does not replace it with normal stop', async () => {
  const f = fixture();
  f.setRecord({ ...readyRecord(), state: 'failed', stopReason: 'lastGrant corrupt' });
  const expected = { exitCode: 0, state: 'failed', pid: null, mainPath: generation, stopReason: 'lastGrant corrupt', reasonKnown: true };
  assert.deepEqual(await f.runtime.stop(), expected);
  assert.deepEqual(await f.runtime.status(), expected);
  assert.equal(f.named('shutdown').length, 0);
  assert.equal(f.named('spawn').length, 0);
});

test('U5: resource request uses the confirmed epoch and loss does not re-enqueue', async () => {
  const f = fixture();
  f.ports.exchange = async (request, epoch) => {
    f.calls.push({ name: 'exchange', value: { request, epoch } });
    throw new Error('queue channel lost before grant');
  };
  const request = { operation: 'resource.wait', payload: { requestId: 'wait-A' } };
  failed(await f.runtime.request(request), /channel lost before grant/);
  assert.deepEqual(f.named('exchange').map(call => call.value), [{ request, epoch: 'epoch-A' }]);
  assert.equal(f.named('spawn').length, 1);
});

function producers(delivery?: SharedSystemDelivery) {
  const calls: string[] = [];
  let notifier: MainNotifier | undefined;
  const allowed: ServiceProducerPorts = {
    sharedDelivery: delivery,
    bugSync: { start: async value => { calls.push('bug.start'); notifier = value; }, stop: async () => { calls.push('bug.stop'); } },
    resourceWait: { start: async epoch => { calls.push('queue.start:' + epoch); }, stop: async () => { calls.push('queue.stop'); } },
  };
  const forbidden = new Set(['sessions', 'reminders', 'events', 'quotas', 'reports', 'reservations', 'registerMain', 'launchMain', 'scheduler', 'reconcileLaunches']);
  const ports = new Proxy(allowed, { get(target, key, receiver) {
    assert.ok(!forbidden.has(String(key)), 'forbidden service dependency: ' + String(key));
    return Reflect.get(target, key, receiver);
  } });
  return { runtime: new ServiceProducerRuntime(ports), calls, notice: () => { assert.ok(notifier); return notifier; } };
}

test('U6: service composition starts and stops only bug sync and the resource queue', async () => {
  const f = producers(async () => ({ accepted: true, receiptId: 'receipt' }));
  await f.runtime.recover({ serviceEpoch: 'epoch-A' });
  await f.runtime.shutdown();
  assert.deepEqual([...f.calls].sort(), ['bug.start', 'bug.stop', 'queue.start:epoch-A', 'queue.stop'].sort());
});

test('U6: lifecycle restart has no main/session/reminder/event/quota/report/reservation effects', async () => {
  const f = fixture();
  const ports = new Proxy(f.ports, { get(target, key, receiver) {
    assert.ok(key in target, 'unexpected lifecycle dependency: ' + String(key));
    return Reflect.get(target, key, receiver);
  } });
  const runtime = new ServiceLifecycleController(options, ports);
  await runtime.start(); await runtime.stop(); await runtime.start();
  assert.equal(f.named('spawn').length, 2);
});

test('U7: shared transport receives literal text, address main and verified system identity', async () => {
  const calls: unknown[] = [];
  const receipt = { accepted: true as const, receiptId: 'accepted-A' };
  const f = producers(async (request, sender) => { calls.push({ request, sender }); return receipt; });
  const text = '[main] $(touch /forbidden) `id` ;\nnew bug projects/raf/bug#51';
  assert.deepEqual(await f.runtime.notifyMain(text), receipt);
  assert.deepEqual(calls, [{ request: { to: 'main', text }, sender: { kind: 'system' } }]);
  assert.deepEqual(f.calls, []);
});

test('U7: producer preserves rejected acceptance instead of claiming delivered', async () => {
  const rejected = { accepted: false as const, reason: 'main not attached' };
  const f = producers(async () => rejected);
  assert.deepEqual(await f.runtime.notifyMain('notice'), rejected);
  assert.deepEqual(f.calls, []);
});

test('U7: missing shared transport is an explicit unaccepted delivery', async () => {
  const f = producers();
  const receipt = await f.runtime.notifyMain('notice');
  assert.equal(receipt.accepted, false);
  assert.match((receipt as { reason: string }).reason, /transport|delivery|unavailable/i);
  assert.deepEqual(f.calls, []);
});

test('U8: transport exception stays unaccepted without starting service or main', async () => {
  const f = producers(async () => { throw new Error('acceptance channel unavailable'); });
  const receipt = await f.runtime.notifyMain('notice');
  assert.equal(receipt.accepted, false);
  assert.match((receipt as { reason: string }).reason, /acceptance channel unavailable/);
  assert.deepEqual(f.calls, []);
});

test('U8: bug-sync notifier uses shared transport without adding a second raf signature', async () => {
  const calls: unknown[] = [];
  const f = producers(async (request, sender) => { calls.push({ request, sender }); return { accepted: true, receiptId: 'notice-A' }; });
  await f.runtime.recover({ serviceEpoch: 'epoch-A' });
  await f.notice().notify({ noticeKey: 'notice-51', kind: 'new-bug', bugKey: 'projects/raf/bug#51', commentId: null });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { request: { to: 'main', text: 'New bug projects/raf/bug#51' }, sender: { kind: 'system' } });
});

test('U8: bug-sync rejection remains retryable by its own pending contract', async () => {
  let accepted = false;
  const f = producers(async () => accepted ? { accepted: true, receiptId: 'retry-51' } : { accepted: false, reason: 'main not attached' });
  await f.runtime.recover({ serviceEpoch: 'epoch-A' });
  const notice = { noticeKey: 'notice-51', kind: 'new-bug' as const, bugKey: 'projects/raf/bug#51', commentId: null };
  await assert.rejects(f.notice().notify(notice), /main not attached/);
  accepted = true;
  await f.notice().notify(notice);
  assert.deepEqual([...f.calls].sort(), ['queue.start:epoch-A', 'bug.start'].sort());
});

test('U4: restart does not reuse a previous lifecycle failure reason', async () => {
  const f = fixture();
  f.setRecord({ ...readyRecord(), state: 'failed', stopReason: 'old crash' });
  assert.deepEqual(await f.runtime.start(), readyStatus());
  assert.deepEqual(await f.runtime.status(), readyStatus());
});

test('U5: shutdown transport failure stays a failure with its actual source', async () => {
  const f = fixture(); f.makeReady();
  f.ports.shutdown = async () => { throw new Error('shutdown socket EACCES'); };
  failed(await f.runtime.stop(), /shutdown socket EACCES/);
  assert.equal(f.named('spawn').length, 0);
});

test('U7: an unacknowledged shared transport return cannot become accepted', async () => {
  const f = producers(async () => undefined as never);
  const result = await f.runtime.notifyMain('notice');
  assert.equal(result.accepted, false);
  assert.ok((result as { reason: string }).reason.trim());
});

test('U8: human-comment notice includes its full bug key and comment ID via shared delivery', async () => {
  const calls: unknown[] = [];
  const f = producers(async (request, sender) => { calls.push({ request, sender }); return { accepted: true, receiptId: 'comment-A' }; });
  await f.runtime.recover({ serviceEpoch: 'epoch-A' });
  await f.notice().notify({ noticeKey: 'notice-comment', kind: 'human-comment', bugKey: 'projects/raf/bug#51', commentId: 'comment-7' });
  assert.deepEqual(calls, [{ request: { to: 'main', text: 'New human comment comment-7 on projects/raf/bug#51' }, sender: { kind: 'system' } }]);
});
