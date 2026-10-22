import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { executeCommand, observeProcesses } from '../src/os-runtime.ts';
import { closeSessionInTransaction } from '../src/session-state.ts';
import { openStateStore } from '../src/state-store.ts';
import {
  claimTaskReservations, completeTaskReservations, handoffTaskReservations,
  listTaskReservations, reconcileTaskReservations, releaseTaskReservations, startTaskReservations,
  type MachineBootIdentity, type ReservationProcessIdentity, type ReservedTaskResolution,
  type ReservedTaskSnapshot, type TaskReservationDependencies, type TaskReservationLease,
} from '../src/task-reservations.ts';

type SourceRow = { task: ReservedTaskSnapshot; state: 'open' | 'completed'; location: 'active' | 'archive' };
type WorkerConfig = { directory: string; runId: string; boot: MachineBootIdentity; token: string };
type Call = {
  id: number; kind: string; tasks?: ReservedTaskSnapshot[]; lease?: TaskReservationLease;
  identity?: ReservationProcessIdentity; addressId?: string; barrier?: boolean; boot?: MachineBootIdentity;
  reason?: 'cancelled' | 'succeeded' | 'failed';
};
type WorkerReply = { id?: number; kind?: string; result?: any; identity?: ReservationProcessIdentity; error?: { message: string; code?: string } };

async function processIdentity(runId: string, boot: MachineBootIdentity, token: string): Promise<ReservationProcessIdentity> {
  const result = await executeCommand({ executable: 'ps', args: ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='] });
  assert.equal(result.exitCode, 0);
  const row = result.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  assert.ok(row);
  assert.ok(row[2].includes(token));
  return {
    pid: process.pid, startedAt: new Date(row[1]).toISOString(), runner: 'qa-controlled-node',
    runnerSessionId: `${runId}:${token}`, tmuxSession: `qa-no-tmux:${token}`,
    evidence: { ...boot, runId, command: row[2], qaToken: token },
  };
}

async function worker(config: WorkerConfig): Promise<void> {
  const identity = await processIdentity(config.runId, config.boot, config.token);
  let boot = config.boot;
  let store = openStateStore(join(config.directory, 'state.sqlite'));
  let barrier = false;
  let unblock: (() => void) | undefined;
  const dependencies = (): TaskReservationDependencies => ({
    store,
    currentBoot: async () => boot,
    observe: async expected => (await observeProcesses([expected]))[0],
    newFence: randomUUID,
    resolveTasks: async snapshots => {
      const rows: SourceRow[] = JSON.parse(await readFile(join(config.directory, 'authoritative-fixture.json'), 'utf8'));
      const resolutions: ReservedTaskResolution[] = snapshots.map(requested => {
        const row = rows.find(candidate => JSON.stringify(candidate.task.key) === JSON.stringify(requested.key));
        if (!row) return { state: 'unknown', requested, reason: 'Synthetic authoritative fixture has no matching task' };
        return row;
      });
      if (barrier) {
        barrier = false;
        await new Promise<void>(resolve => { unblock = resolve; process.send!({ kind: 'barrier' }); });
      }
      return resolutions;
    },
  });
  async function dispatch(call: Call): Promise<unknown> {
    switch (call.kind) {
      case 'claim':
        barrier = call.barrier ?? false;
        return claimTaskReservations(dependencies(), {
          runId: config.runId, addressId: call.addressId ?? config.runId, tasks: call.tasks!, starter: identity,
          reserveLaunch: tx => {
            const session = { runId: config.runId, addressId: call.addressId ?? config.runId, revision: 0, state: 'reserved' as const };
            tx.putSession(session);
            tx.putReservation({ runId: config.runId, resource: 'qa-synthetic-admission', amount: 1 });
            return session;
          },
        });
      case 'handoff': return handoffTaskReservations(dependencies(), { lease: call.lease!, wrapper: call.identity! });
      case 'start': return startTaskReservations(dependencies(), { lease: call.lease!, agent: call.identity! });
      case 'reconcile': return reconcileTaskReservations(dependencies());
      case 'complete': return completeTaskReservations(dependencies(), { lease: call.lease!, tasks: call.tasks! });
      case 'release': return releaseTaskReservations(dependencies(), {
        lease: call.lease!, reason: call.reason ?? 'cancelled', closeLaunch: tx => {
          const session = tx.getSession(call.lease!.owner.runId);
          assert.ok(session);
          closeSessionInTransaction(tx, session, new Date().toISOString());
        },
      });
      case 'boot': boot = call.boot!; return true;
      case 'reopen': store.close(); store = openStateStore(join(config.directory, 'state.sqlite')); return true;
      case 'snapshot': return {
        claims: listTaskReservations(store),
        ...store.sessionRepository.transaction(tx => ({ sessions: tx.listSessions(), admission: tx.listReservations() })),
      };
      default: throw new Error(`Unknown QA worker operation ${call.kind}`);
    }
  }
  let queue = Promise.resolve();
  process.on('message', (call: Call) => {
    if (call.kind === 'unblock') { unblock?.(); return; }
    queue = queue.then(async () => {
      try { process.send!({ id: call.id, result: await dispatch(call) }); }
      catch (error) {
        const failure = error as Error & { code?: string };
        process.send!({ id: call.id, error: { message: failure.message, code: failure.code } });
      }
    });
  });
  process.on('disconnect', () => { store.close(); process.exit(0); });
  process.send!({ kind: 'ready', identity });
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'raf-claims-qa-'));
  const machineId = `${platform()}:${hostname()}`;
  const bootResult = platform() === 'darwin'
    ? await executeCommand({ executable: 'sysctl', args: ['-n', 'kern.boottime'] })
    : { exitCode: 0, stdout: await readFile('/proc/sys/kernel/random/boot_id', 'utf8') };
  assert.equal(bootResult.exitCode, 0);
  const boot = { machineId, bootId: bootResult.stdout.trim() };
  const instance = randomUUID();
  const tasks = ['R.4.a', 'R.4.b', 'R.4.c'].map(taskId => ({
    key: { project: 'raf', changeId: 'qa-synthetic-change', taskId },
    changeInstance: instance, fingerprint: `synthetic-original-content:${taskId}`,
  }));
  const rows: SourceRow[] = tasks.map(task => ({ task, state: 'open', location: 'active' }));
  const saveSource = () => writeFile(join(directory, 'authoritative-fixture.json'), JSON.stringify(rows));
  await saveSource();
  const initial = openStateStore(join(directory, 'state.sqlite'));
  initial.close();
  const children: { child: ChildProcess; identity?: ReservationProcessIdentity; exit: Promise<unknown>; stop: () => Promise<void> }[] = [];
  t.after(async () => {
    for (const child of children) await child.stop();
    const identities = children.flatMap(child => child.identity ? [child.identity] : []);
    const observations = await observeProcesses(identities);
    assert.equal(observations.length, children.length);
    assert.ok(observations.every(observation => observation.state === 'exited'), JSON.stringify(observations));
    t.diagnostic(`cleanup verified ${children.length} own process identities exited; removing exact directory ${directory}`);
    await rm(directory, { recursive: true, force: true });
  });
  async function launch(runId = randomUUID()) {
    const config: WorkerConfig = { directory, runId, boot, token: `raf-qa-${randomUUID()}` };
    const child = fork(fileURLToPath(import.meta.url), ['--qa-claims-worker', JSON.stringify(config)], {
      execArgv: [], env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.stdout!.resume();
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let serial = 0;
    let signalBarrier: (() => void) | undefined;
    const ready = new Promise<ReservationProcessIdentity>((resolve, reject) => {
      child.on('message', (message: WorkerReply) => {
        if (message.kind === 'ready') { resolve(message.identity!); return; }
        if (message.kind === 'barrier') { signalBarrier?.(); return; }
        const waiter = pending.get(message.id!);
        if (!waiter) return;
        pending.delete(message.id!);
        if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else waiter.resolve(message.result);
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        const error = new Error(`Own QA child exited (${code}/${signal}): ${stderr}`);
        reject(error);
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
      });
    });
    const record = {
      child, identity: undefined as ReservationProcessIdentity | undefined, exit: once(child, 'exit'),
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await record.exit;
      },
    };
    children.push(record);
    record.identity = await ready;
    assert.equal((await observeProcesses([record.identity]))[0].state, 'alive');
    t.diagnostic(`own process ${runId} pid=${record.identity.pid} start=${record.identity.startedAt} command=${record.identity.evidence.command}`);
    return {
      identity: record.identity, stop: record.stop,
      barrier: () => new Promise<void>(resolve => { signalBarrier = resolve; }),
      unblock: () => child.send({ kind: 'unblock' }),
      call: (kind: string, args: Omit<Partial<Call>, 'kind' | 'id'> = {}): Promise<any> => new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        child.send({ kind, id, ...args });
      }),
    };
  }
  return { directory, boot, tasks, rows, saveSource, launch };
}

function leaseOf(result: any): TaskReservationLease {
  assert.equal(result.reserved, true);
  return result.lease;
}

if (process.argv[2] === '--qa-claims-worker') {
  await worker(JSON.parse(process.argv[3]));
} else {
  test('R.4 QA real subprocess simultaneous overlap is all-or-none, disjoint claims both commit', async t => {
    for (const overlap of [true, false]) {
      const f = await fixture(t);
      const left = await f.launch();
      const right = await f.launch();
      const leftBarrier = left.barrier();
      const rightBarrier = right.barrier();
      const leftClaim = left.call('claim', { tasks: overlap ? f.tasks.slice(0, 2) : f.tasks.slice(0, 1), barrier: true });
      const rightClaim = right.call('claim', { tasks: overlap ? f.tasks.slice(1) : f.tasks.slice(1), barrier: true });
      await Promise.all([leftBarrier, rightBarrier]);
      left.unblock();
      right.unblock();
      const results = await Promise.all([leftClaim, rightClaim]);
      assert.equal(results.filter(result => result.reserved).length, overlap ? 1 : 2);
      const snapshot = await left.call('snapshot');
      assert.equal(snapshot.claims.length, overlap ? 1 : 2);
      assert.equal(snapshot.sessions.length, snapshot.claims.length);
      assert.equal(snapshot.admission.length, snapshot.claims.length);
      assert.equal(snapshot.claims.flatMap((claim: any) => claim.tasks).length, overlap ? 2 : 3);
      if (overlap) {
        const loser = results.find(result => !result.reserved);
        assert.deepEqual(loser.conflicts.map((conflict: any) => conflict.task), [f.tasks[1]]);
        assert.deepEqual(loser.conflicts[0].owner, snapshot.claims[0].lease.owner);
      }
    }
  });

  test('R.4 QA SIGKILL starter before spawn reclaims automatically and fences late handoff', async t => {
    const f = await fixture(t);
    const starter = await f.launch('starter-before-spawn');
    const lease = leaseOf(await starter.call('claim', { tasks: f.tasks, addressId: 'reused-address' }));
    const lateWrapper = await f.launch('starter-before-spawn');
    await starter.stop();
    const next = await f.launch('replacement-starter');
    const newLease = leaseOf(await next.call('claim', { tasks: f.tasks, addressId: 'reused-address' }));
    assert.notEqual(newLease.owner.fence, lease.owner.fence);
    assert.equal(await lateWrapper.call('handoff', { lease, identity: lateWrapper.identity }), null);
    assert.equal(await lateWrapper.call('release', { lease }), false);
    const snapshot = await next.call('snapshot');
    assert.equal(snapshot.sessions.find((session: any) => session.runId === lease.owner.runId).state, 'finished');
    assert.deepEqual(snapshot.admission.map((reservation: any) => reservation.runId), [newLease.owner.runId]);
    assert.deepEqual(snapshot.claims.map((claim: any) => claim.lease), [newLease]);
  });

  test('R.4 QA durable handoff survives starter SIGKILL; wrapper SIGKILL fences parked agent registration', async t => {
    const f = await fixture(t);
    const runId = 'handoff-run';
    const starter = await f.launch(runId);
    const wrapper = await f.launch(runId);
    const agent = await f.launch(runId);
    const lease = leaseOf(await starter.call('claim', { tasks: f.tasks }));
    const handed = await starter.call('handoff', { lease, identity: wrapper.identity });
    assert.ok(handed);
    assert.equal(handed.revision, lease.revision + 1);
    await starter.stop();
    const service = await f.launch('service-handoff');
    assert.deepEqual((await service.call('reconcile')).retained, [handed]);
    const conflict = await service.call('claim', { tasks: [f.tasks[0]] });
    assert.equal(conflict.reserved, false);
    assert.equal(await wrapper.call('release', { lease: handed }), false);
    await wrapper.stop();
    leaseOf(await service.call('claim', { tasks: f.tasks }));
    assert.equal(await agent.call('start', { lease: handed, identity: agent.identity }), null);
    assert.equal((await observeProcesses([agent.identity]))[0].state, 'alive');
    assert.equal((await service.call('snapshot')).claims[0].stage, 'starting');
  });

  test('R.4 QA running agent survives wrapper and service SIGKILL/restart, then agent death reclaims', async t => {
    const f = await fixture(t);
    const runId = 'surviving-agent';
    const starter = await f.launch(runId);
    const wrapper = await f.launch(runId);
    const agent = await f.launch(runId);
    const service = await f.launch('service-original');
    const initial = leaseOf(await starter.call('claim', { tasks: f.tasks }));
    const handed = await starter.call('handoff', { lease: initial, identity: wrapper.identity });
    const running = await wrapper.call('start', { lease: handed, identity: agent.identity });
    assert.ok(running);
    assert.equal(running.revision, handed.revision + 1);
    await starter.stop();
    await wrapper.stop();
    await service.stop();
    const restarted = await f.launch('service-restarted');
    assert.deepEqual((await restarted.call('reconcile')).retained, [running]);
    await restarted.call('reopen');
    assert.deepEqual((await restarted.call('reconcile')).retained, [running]);
    assert.equal((await restarted.call('claim', { tasks: f.tasks })).reserved, false);
    assert.equal((await restarted.call('snapshot')).claims[0].agent.pid, agent.identity.pid);
    await agent.stop();
    const replacement = leaseOf(await restarted.call('claim', { tasks: f.tasks }));
    assert.notEqual(replacement.owner.fence, running.owner.fence);
    assert.equal(await restarted.call('start', { lease: running, identity: restarted.identity }), null);
    assert.deepEqual((await restarted.call('snapshot')).admission.map((entry: any) => entry.runId), [replacement.owner.runId]);
  });

  test('R.4 QA controlled boot emulation reclaims old guard without rebooting host', async t => {
    const f = await fixture(t);
    const starter = await f.launch();
    const observer = await f.launch();
    const lease = leaseOf(await starter.call('claim', { tasks: f.tasks }));
    await observer.call('boot', { boot: { ...f.boot, bootId: `emulated-next-boot:${randomUUID()}` } });
    assert.deepEqual((await observer.call('reconcile')).released, [lease.owner]);
    assert.equal((await observeProcesses([starter.identity]))[0].state, 'alive');
    await observer.call('boot', { boot: f.boot });
    leaseOf(await observer.call('claim', { tasks: f.tasks }));
  });

  test('R.4 QA controlled PID reuse emulation uses real own PID with changed start or command evidence', async t => {
    for (const field of ['startedAt', 'command']) {
      const f = await fixture(t);
      const starter = await f.launch();
      const observer = await f.launch();
      const lease = leaseOf(await starter.call('claim', { tasks: f.tasks }));
      const store = openStateStore(join(f.directory, 'state.sqlite'));
      try {
        store.taskReservationRepository.transaction(tx => {
          const set = tx.listTaskReservations()[0];
          const guard = structuredClone(set.starter);
          if (field === 'startedAt') guard.startedAt = new Date(Date.parse(guard.startedAt) - 1000).toISOString();
          else guard.evidence = { ...guard.evidence, command: `${guard.evidence.command} emulated-old-owner` };
          tx.putTaskReservation({ ...set, starter: guard });
        });
      } finally { store.close(); }
      assert.deepEqual((await observer.call('reconcile')).released, [lease.owner]);
      assert.equal((await observeProcesses([starter.identity]))[0].state, 'alive');
      leaseOf(await observer.call('claim', { tasks: f.tasks }));
    }
  });

  test('R.4 QA authoritative synthetic identity completes active/archive snapshots and rejects reused change', async t => {
    const f = await fixture(t);
    const owner = await f.launch();
    const lease = leaseOf(await owner.call('claim', { tasks: f.tasks }));
    f.rows[0].state = 'completed';
    f.rows[1].state = 'completed';
    f.rows[1].location = 'archive';
    await f.saveSource();
    const partial = await owner.call('complete', { lease, tasks: f.tasks.slice(0, 2) });
    assert.equal(partial.applied, true);
    assert.equal(partial.lease.revision, lease.revision + 1);
    assert.deepEqual((await owner.call('snapshot')).claims[0].tasks, [f.tasks[2]]);
    f.rows[2] = { task: { ...f.tasks[2], changeInstance: randomUUID() }, state: 'completed', location: 'active' };
    await f.saveSource();
    await assert.rejects(owner.call('complete', { lease: partial.lease, tasks: [f.tasks[2]] }), { code: 'TASK_IDENTITY_MISMATCH' });
    assert.deepEqual((await owner.call('snapshot')).claims[0].tasks, [f.tasks[2]]);
    f.rows[2] = { task: f.tasks[2], state: 'open', location: 'archive' };
    await f.saveSource();
    await assert.rejects(owner.call('complete', { lease: partial.lease, tasks: [f.tasks[2]] }), { code: 'TASK_IDENTITY_MISMATCH' });
    f.rows[2] = { task: f.tasks[2], state: 'completed', location: 'archive' };
    await f.saveSource();
    assert.deepEqual(await owner.call('complete', { lease: partial.lease, tasks: [f.tasks[2]] }), { applied: true, lease: null });
    assert.deepEqual((await owner.call('snapshot')).claims, []);
    assert.deepEqual(await owner.call('complete', { lease, tasks: [f.tasks[0]] }), { applied: false });
  });

  test('R.4 QA terminal release requires actual guard death for succeeded and failed and closes admission', async t => {
    for (const reason of ['succeeded', 'failed'] as const) {
      const f = await fixture(t);
      const runId = `terminal-${reason}`;
      const starter = await f.launch(runId);
      const wrapper = await f.launch(runId);
      const agent = await f.launch(runId);
      const service = await f.launch();
      const initial = leaseOf(await starter.call('claim', { tasks: f.tasks }));
      const handed = await starter.call('handoff', { lease: initial, identity: wrapper.identity });
      const running = await wrapper.call('start', { lease: handed, identity: agent.identity });
      assert.ok(running);
      assert.equal(await service.call('release', { lease: running, reason }), false);
      assert.equal((await service.call('snapshot')).claims.length, 1);
      await agent.stop();
      assert.equal(await service.call('release', { lease: running, reason }), true);
      const snapshot = await service.call('snapshot');
      assert.deepEqual(snapshot.claims, []);
      assert.deepEqual(snapshot.admission, []);
      assert.equal(snapshot.sessions[0].state, 'finished');
      assert.equal(await service.call('release', { lease: running, reason }), false);
    }
  });

  test('R.4 QA incomplete or changed authoritative snapshot rejects an entire completion subset', async t => {
    const f = await fixture(t);
    const owner = await f.launch();
    const lease = leaseOf(await owner.call('claim', { tasks: f.tasks }));
    f.rows[0].state = 'completed';
    await f.saveSource();
    await assert.rejects(owner.call('complete', { lease, tasks: f.tasks.slice(0, 2) }), { code: 'TASK_NOT_COMPLETED' });
    assert.deepEqual((await owner.call('snapshot')).claims[0].tasks, f.tasks);
    f.rows[1] = { task: { ...f.tasks[1], fingerprint: 'changed-authoritative-content' }, state: 'completed', location: 'active' };
    await f.saveSource();
    await assert.rejects(owner.call('complete', { lease, tasks: f.tasks.slice(0, 2) }), { code: 'TASK_IDENTITY_MISMATCH' });
    assert.deepEqual((await owner.call('snapshot')).claims[0].lease, lease);
    assert.deepEqual((await owner.call('snapshot')).claims[0].tasks, f.tasks);
    f.rows[1] = { task: f.tasks[1], state: 'completed', location: 'active' };
    await f.saveSource();
    const completed = await owner.call('complete', { lease, tasks: f.tasks.slice(0, 2) });
    assert.equal(completed.applied, true);
    assert.deepEqual((await owner.call('snapshot')).claims[0].tasks, [f.tasks[2]]);
  });

  test('R.4 QA foreign machine evidence fails closed and retry reconciles after actual death', async t => {
    const f = await fixture(t);
    const owner = await f.launch();
    const service = await f.launch();
    const lease = leaseOf(await owner.call('claim', { tasks: f.tasks }));
    await service.call('boot', { boot: { ...f.boot, machineId: `emulated-other-machine:${randomUUID()}` } });
    await assert.rejects(service.call('reconcile'), { code: 'TASK_LIVENESS_UNKNOWN' });
    assert.deepEqual((await service.call('snapshot')).claims[0].lease, lease);
    await service.call('boot', { boot: f.boot });
    assert.deepEqual((await service.call('reconcile')).retained, [lease]);
    await owner.stop();
    assert.deepEqual((await service.call('reconcile')).released, [lease.owner]);
    leaseOf(await service.call('claim', { tasks: f.tasks }));
  });
}
