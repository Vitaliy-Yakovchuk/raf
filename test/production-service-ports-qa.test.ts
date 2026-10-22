import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createProductionServiceDependencies, createServicePorts } from '../src/production-service-ports.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';
import { createEventRegistry } from '../src/event-registry.ts';
import { ReminderService } from '../src/reminders.ts';
import { createSessionState, type ProcessIdentity, type SessionRecord } from '../src/session-state.ts';
import { createResourceSnapshotReader, executeCommand, observeProcesses, type ResourceSnapshot } from '../src/os-runtime.ts';
import { evaluateResourceAdmission } from '../src/resource-admission.ts';

const catalog = {
  events: ['agent.failed', 'agent.closed', 'reminder.activated', 'reminder.closed'].map(id => ({ id, idKind: id.startsWith('agent.') ? 'agentAddress' : 'reminderId', description: id })),
  eventIdKinds: { agentAddress: 'Address', reminderId: 'Reminder' },
  resourceWaitLevels: [{ id: 'hotfix', priority: 0 }, { id: 'normal', priority: 1 }],
};
const bundle = { ramBytes: 47 * 2 ** 30, diskBytes: { volume: 0 } };

async function fixture(t: TestContext, interval = 80) {
  const root = await mkdtemp(join(tmpdir(), 'raf-host-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { orchestratorRoot: join(root, 'orchestrator'), homeDirectory: join(root, 'home'), stateDirectory: join(root, 'home', '.raf'), socketPath: join(root, 'service.sock') };
  await mkdir(join(context.orchestratorRoot, 'conf'), { recursive: true });
  await mkdir(context.stateDirectory, { recursive: true });
  await writeFile(join(context.orchestratorRoot, 'conf', 'raf.json'), JSON.stringify({ version: 1, state: { fileName: 'shared.sqlite' }, service: { hostTickIntervalMs: 25 }, resourceWait: { grantIntervalMs: interval } }));
  await writeFile(join(context.orchestratorRoot, 'conf', 'raf-constants.json'), JSON.stringify(catalog));
  return { root, context, path: join(context.stateDirectory, 'shared.sqlite'), paths: [context.orchestratorRoot, context.stateDirectory, root] };
}

function snapshot(paths: string[]): ResourceSnapshot {
  return { measurement: { machineId: 'qa-machine', loadAverage1m: 0, availableCores: 8, totalRamBytes: 64 * 2 ** 30, availableRamBytes: 48 * 2 ** 30, memoryPressure: 'normal', fileSystems: [{ id: 'volume', totalBytes: 1024 * 2 ** 30, availableBytes: 512 * 2 ** 30 }] }, reasons: [], fileSystemByPath: Object.fromEntries(paths.map(path => [path, 'volume'])) };
}

function record(identity?: ProcessIdentity, succeeded = false): SessionRecord {
  return { runId: 'qa-run', addressId: 'qa-worker', revision: 1, state: 'running', ...(identity ? { process: identity } : {}), ...(succeeded ? { result: { status: 'succeeded', response: 'previously accepted result', proof: null } } : {}) };
}

function seed(store: StateStore, session: SessionRecord, reserve = false) {
  store.sessionRepository.transaction(tx => {
    tx.putSession(session);
    if (reserve) tx.putReservation({ runId: session.runId, resource: 'bundle', amount: 1, resourceBundle: { machineId: 'qa-machine', resources: bundle } });
  });
}

function reminders(store: StateStore) {
  let id = 0;
  return new ReminderService({ repository: store.reminderRepository, now: () => new Date().toISOString(), nextId: () => `qa-reminder-${++id}`, approvedEventKinds: catalog.events.map(event => event.id) });
}

async function managed(t: TestContext) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  let identity: ProcessIdentity | undefined;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const observation = identity ? (await observeProcesses([identity]))[0] : undefined;
    assert.ok(!identity || observation?.state === 'alive', 'Only the verified owned child can be killed');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    console.log(JSON.stringify({ scenario: t.name, cleanup: { pid: child.pid, startedAt: identity?.startedAt, signal: child.signalCode, observed: identity ? (await observeProcesses([identity]))[0].state : 'owned child exited' } }));
  };
  t.after(stop);
  const measured = await executeCommand({ executable: 'ps', args: ['-ww', '-p', String(child.pid), '-o', 'lstart=,command='] });
  assert.equal(measured.exitCode, 0);
  const match = measured.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  assert.ok(match);
  identity = { pid: child.pid!, startedAt: new Date(match[1]).toISOString(), runner: 'codex', runnerSessionId: 'qa-synthetic', tmuxSession: 'qa-synthetic', evidence: { command: match[2], runId: 'qa-run' } };
  assert.equal((await observeProcesses([identity]))[0].state, 'alive');
  console.log(JSON.stringify({ scenario: t.name, managedProcess: identity }));
  return { identity, stop };
}

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 4000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

test('qa reservation: running without observed identity remains an unused reservation', async t => {
  const { context, path, paths } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store, record(), true);
  const measured = snapshot(paths);
  const deps = await createProductionServiceDependencies(context, { resourcePaths: paths, resourceReader: { read: async () => measured } });
  deps.eventPorts(store);
  const expected = evaluateResourceAdmission({ measurement: measured.measurement, requested: { ramBytes: 0, diskBytes: { volume: 0 } }, unusedReservations: [bundle], requiredFileSystemIds: ['volume'] });
  assert.equal(expected.level, 'NO_RESOURCES');
  assert.equal((await deps.resourceWait.readSnapshot()).status, expected.level);
  assert.equal(store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
});

test('qa reservation: successful scan with absent real child remains conservative', async t => {
  const { context, path, paths } = await fixture(t);
  const process = await managed(t);
  await process.stop();
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store, record(process.identity), true);
  const deps = await createProductionServiceDependencies(context, { resourcePaths: paths, resourceReader: { read: async () => snapshot(paths) } });
  deps.eventPorts(store);
  assert.equal((await deps.observeProcesses([process.identity]))[0].state, 'exited');
  assert.equal((await deps.resourceWait.readSnapshot()).status, 'NO_RESOURCES');
});

test('qa reservation: OS scan failure stays UNKNOWN instead of consuming running reservation', async t => {
  const { context, path, paths } = await fixture(t);
  const process = await managed(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store, record(process.identity), true);
  const deps = await createProductionServiceDependencies(context, { resourcePaths: paths, resourceReader: { read: async () => snapshot(paths) }, processScan: { execute: async () => ({ exitCode: 1, stdout: '', stderr: 'qa scan failure' }) } });
  deps.eventPorts(store);
  const result = await deps.resourceWait.readSnapshot();
  assert.equal(result.status, 'UNKNOWN');
  assert.match(result.reason, /scan|observ|process/i);
});

test('qa reservation: verified live process is already measured and not subtracted twice', async t => {
  const { context, path, paths } = await fixture(t);
  const process = await managed(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store, record(process.identity), true);
  const deps = await createProductionServiceDependencies(context, { resourcePaths: paths, resourceReader: { read: async () => snapshot(paths) } });
  deps.eventPorts(store);
  assert.equal((await deps.resourceWait.readSnapshot()).status, 'ANY_RUN');
  assert.equal(store.sessionRepository.transaction(tx => tx.listSessions()).length, 1);
  assert.equal(store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
});

test('qa sqlite: event apply and ack rollback, reopen, two handles and foreign pending cleanup', async t => {
  const { context, path } = await fixture(t);
  let first = openStateStore(path);
  t.after(() => first.close());
  seed(first, record());
  const service = reminders(first);
  const reminder = service.add({ to: 'qa-worker', text: 'atomic event', at: new Date(Date.now() + 60000).toISOString(), binding: { kind: 'agent.failed', id: 'qa-worker', action: 'activate' } });
  const foreign = [{ id: 'foreign-delivery', runId: null, event: 'delivery.pending', payload: { target: 'main' } }, { id: 'foreign-claim', runId: null, event: 'claims.release', payload: { kind: 'claim', id: 'qa-claim' } }];
  first.sessionRepository.transaction(tx => foreign.forEach(intent => tx.putPending(intent)));
  const deps = await createProductionServiceDependencies(context);
  let ports = deps.eventPorts(first);
  createEventRegistry(catalog, ports).enqueue({ key: 'qa-failure', event: { kind: 'agent.failed', id: 'qa-worker' } });
  assert.throws(() => ports.transaction(tx => { tx.applyReminderEvent({ kind: 'agent.failed', id: 'qa-worker' }); tx.deletePending('qa-failure'); throw new Error('qa rollback after ack'); }), /qa rollback/);
  assert.equal(service.list()[0].state, 'pending');
  assert.deepEqual(ports.transaction(tx => tx.listPending()).map(fact => fact.key), ['qa-failure']);
  first.close();
  first = openStateStore(path);
  const second = openStateStore(path);
  t.after(() => second.close());
  ports = (await createProductionServiceDependencies(context)).eventPorts(first);
  assert.deepEqual(createEventRegistry(catalog, ports).dispatch().delivered, ['qa-failure']);
  const secondPorts = (await createProductionServiceDependencies(context)).eventPorts(second);
  createEventRegistry(catalog, secondPorts).dispatch();
  assert.equal(reminders(second).list().find(item => item.id === reminder.id)?.state, 'active');
  assert.deepEqual(first.sessionRepository.transaction(tx => tx.listPending()), foreign);
  assert.deepEqual(second.sessionRepository.transaction(tx => tx.listPending()), foreign);
});

for (const succeeded of [false, true]) test(`qa process: real death closes once with ${succeeded ? 'accepted succeeded priority' : 'one failure and reminder transfer'}`, async t => {
  const { context, path, paths } = await fixture(t);
  const process = await managed(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store, record(process.identity), true);
  if (succeeded) {
    const proof = { fixture: 'trusted-local-qa-result' };
    const sessions = createSessionState({ repository: store.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: (runId, result) => runId === 'qa-run' && result.proof === proof });
    assert.equal(sessions.acceptWorkResult('qa-run', { status: 'succeeded', response: 'accepted before actual death', proof }, { pending: [], domain: [] }), true);
  }
  const service = reminders(store);
  const at = new Date(Date.now() + 60000).toISOString();
  const own = service.add({ to: 'qa-worker', text: 'literal $(unchanged)', at });
  const failure = service.add({ to: 'qa-worker', text: 'failure listener', at, binding: { kind: 'agent.failed', id: 'qa-worker', action: 'activate' } });
  const closed = service.add({ to: 'qa-worker', text: 'closure listener', at, binding: { kind: 'agent.closed', id: 'qa-worker', action: 'activate' } });
  let failureCount = 0;
  let closureCount = 0;
  let domainCount = 0;
  const deps = await createProductionServiceDependencies(context, { resourcePaths: paths, resourceReader: { read: async () => snapshot(paths) } });
  const original = deps.eventPorts;
  deps.eventPorts = handle => {
    const eventPorts = original(handle);
    const transaction = handle.sessionRepository.transaction;
    handle.sessionRepository.transaction = operation => transaction(tx => operation({ ...tx, applyEffects: effects => { domainCount += effects.length; tx.applyEffects(effects); } }));
    return { ...eventPorts, transaction: operation => eventPorts.transaction(tx => operation({ ...tx, applyReminderEvent: event => { if (event.kind === 'agent.failed') failureCount++; if (event.kind === 'agent.closed') closureCount++; return tx.applyReminderEvent(event); } })) };
  };
  const host = await (await import('../src/service-host.ts')).createServicePorts(context, deps);
  t.after(() => host.shutdown());
  await host.recover();
  assert.equal(store.sessionRepository.transaction(tx => tx.getSession('qa-run'))?.state, 'running');
  await process.stop();
  await until(() => store.sessionRepository.transaction(tx => tx.getSession('qa-run'))?.state === 'finished', 'default host timer did not observe child death');
  await host.refresh();
  await host.refresh();
  assert.equal(failureCount, succeeded ? 0 : 1);
  assert.equal(closureCount, 1);
  assert.equal(domainCount, 1);
  assert.equal(store.sessionRepository.transaction(tx => tx.listReservations()).length, 0);
  const all = service.list();
  const retained = all.find(item => item.id === own.id)!;
  assert.equal(retained.createdFor, 'qa-worker');
  assert.equal(retained.at, at);
  assert.equal(retained.text, own.text);
  if (succeeded) {
    assert.ok(all.every(item => item.state === 'closed'));
    assert.equal(retained.closeReason, 'сесія закінчилась з success');
  } else {
    assert.equal(retained.assignedTo, 'main');
    assert.equal(all.find(item => item.id === failure.id)?.state, 'active');
    assert.equal(all.find(item => item.id === closed.id)?.state, 'active');
    assert.deepEqual(await deps.deliverReminder({ ...retained, state: 'active' }), { delivered: false, reason: 'Shared reminder delivery transport is unavailable or unverified' });
  }
  const finished = store.sessionRepository.transaction(tx => tx.getSession('qa-run'));
  await host.shutdown();
  const restarted = await createServicePorts(context, { resourcePaths: paths, resourceReader: { read: async () => snapshot(paths) } });
  await restarted.recover();
  await restarted.shutdown();
  assert.deepEqual(store.sessionRepository.transaction(tx => tx.getSession('qa-run')), finished);
  assert.equal(store.sessionRepository.transaction(tx => tx.listSessions()).length, 1);
});

test('qa scheduler: real deadlines activate reminders and cancellation stops callbacks and shutdown timers', async t => {
  const { context, path, paths } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store, record());
  const reminder = reminders(store).add({ to: 'qa-worker', text: 'timer', at: new Date(Date.now() + 100).toISOString() });
  const deps = await createProductionServiceDependencies(context);
  let cancelledWake = 0;
  const cancel = deps.schedule(Date.now() + 30, async () => { cancelledWake++; });
  cancel();
  let watcherWakes = 0;
  const unwatch = deps.resourceWait.watchResources(async () => { watcherWakes++; });
  await until(() => watcherWakes > 0, 'default resource watcher did not tick');
  unwatch();
  const count = watcherWakes;
  let reads = 0;
  let scheduled = 0;
  const active = new Set<object>();
  const host = await createServicePorts(context, { resourcePaths: paths, resourceReader: { read: async () => { reads++; return snapshot(paths); } }, schedule: (at, wake) => {
    scheduled++;
    const token = {};
    active.add(token);
    const cancel = deps.schedule(at, async () => { active.delete(token); await wake(); });
    return () => { active.delete(token); cancel(); };
  } });
  t.after(() => host.shutdown());
  await host.recover();
  await until(() => reminders(store).list().find(item => item.id === reminder.id)?.state === 'active', 'real reminder deadline did not activate');
  await host.shutdown();
  const afterShutdown = reads;
  const scheduledAtShutdown = scheduled;
  assert.equal(active.size, 0);
  await delay(100);
  assert.equal(watcherWakes, count);
  assert.equal(cancelledWake, 0);
  assert.equal(reads, afterShutdown);
  assert.equal(scheduled, scheduledAtShutdown);
});

test('qa process: scan failure leaves live session and future reminder without death effects', async t => {
  const { context, path, paths } = await fixture(t);
  const process = await managed(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store, record(process.identity), true);
  const reminder = reminders(store).add({ to: 'qa-worker', text: 'stay pending', at: new Date(Date.now() + 60000).toISOString() });
  const host = await createServicePorts(context, { resourcePaths: paths, resourceReader: { read: async () => snapshot(paths) }, processScan: { execute: async () => { throw new Error('qa scan unavailable'); } } });
  t.after(() => host.shutdown());
  await host.recover();
  await host.refresh();
  await host.shutdown();
  const session = store.sessionRepository.transaction(tx => tx.getSession('qa-run'));
  assert.equal(session?.state, 'running');
  assert.equal(session?.observation?.state, 'unknown');
  assert.equal(store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  assert.deepEqual(store.sessionRepository.transaction(tx => tx.listPending()), []);
  const retained = reminders(store).list().find(item => item.id === reminder.id);
  assert.equal(retained?.state, 'pending');
  assert.equal(retained?.assignedTo, 'qa-worker');
});

test('qa queue: connection abort consumes no grant and global real scheduler interval survives restart', async t => {
  const interval = 180;
  const { context, path, paths } = await fixture(t, interval);
  let allow = false;
  let reads = 0;
  const options = { resourcePaths: paths, resourceReader: { read: async () => { reads++; const result = snapshot(paths); if (!allow) result.measurement.memoryPressure = 'critical'; return result; } } };
  let host = await createServicePorts(context, options);
  t.after(() => host.shutdown());
  await host.recover();
  const observer = openStateStore(path);
  t.after(() => observer.close());
  const cancelled = new AbortController();
  const waiting = host.handle({ operation: 'resource.wait', payload: { level: 'normal' } }, { clientId: 'cancelled-connection', signal: cancelled.signal }) as Promise<{ exitCode: number; reason: string }>;
  await until(() => reads > 0, 'waiter never sampled');
  cancelled.abort();
  const cancelledResult = await waiting;
  assert.equal(cancelledResult.exitCode, 1);
  assert.equal(cancelledResult.reason, 'cancelled');
  assert.equal(observer.getResourceWaitLastGrant(), null);
  allow = true;
  const request = (clientId: string, level = 'normal') => host.handle({ operation: 'resource.wait', payload: { level } }, { clientId, signal: new AbortController().signal }) as Promise<{ exitCode: number; grantedAt: number; reservation: boolean }>;
  const first = await request('first');
  assert.equal(first.exitCode, 0);
  const normal = request('second');
  const hotfix = request('hotfix', 'hotfix');
  const priority = await hotfix;
  const second = await normal;
  assert.ok(priority.grantedAt - first.grantedAt >= interval);
  assert.ok(second.grantedAt - priority.grantedAt >= interval);
  await host.shutdown();
  host = await createServicePorts(context, options);
  await host.recover();
  const restarted = await request('after-restart');
  assert.ok(restarted.grantedAt - second.grantedAt >= interval);
  assert.equal(restarted.reservation, false);
  assert.equal(observer.getResourceWaitLastGrant(), restarted.grantedAt);
  assert.deepEqual(observer.sessionRepository.transaction(tx => tx.listReservations()), []);
  assert.deepEqual((await readdir(context.stateDirectory)).filter(name => !name.endsWith('-wal') && !name.endsWith('-shm')), ['shared.sqlite']);
  console.log(JSON.stringify({ scenario: t.name, interval, grants: [first.grantedAt, priority.grantedAt, second.grantedAt, restarted.grantedAt] }));
});

test('qa sampler: real default OS result matches owner measurement or honest UNKNOWN reason', async t => {
  const { context, path, paths } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  const measured = await createResourceSnapshotReader({ machineId: hostname(), paths }).read();
  assert.ok(Object.keys(measured.fileSystemByPath).length > 0);
  assert.equal(new Set(Object.values(measured.fileSystemByPath)).size, measured.measurement.fileSystems.length);
  const defaultDeps = await createProductionServiceDependencies(context, { resourcePaths: paths });
  defaultDeps.eventPorts(store);
  const actual = await defaultDeps.resourceWait.readSnapshot();
  assert.ok(['ANY_RUN', 'HOTFIX_ONLY', 'NO_RESOURCES', 'UNKNOWN'].includes(actual.status));
  if (actual.status === 'UNKNOWN') assert.ok(actual.reason.trim().length > 0);
  if (measured.reasons.length) assert.equal(actual.status, 'UNKNOWN');
  const replay = await createProductionServiceDependencies(context, { resourcePaths: paths, resourceReader: { read: async () => measured } });
  replay.eventPorts(store);
  const replayed = await replay.resourceWait.readSnapshot();
  if (measured.reasons.length) {
    assert.equal(replayed.status, 'UNKNOWN');
    for (const reason of measured.reasons) assert.ok(replayed.reason.includes(reason));
  } else {
    const ids = [...new Set(Object.values(measured.fileSystemByPath))];
    assert.equal(replayed.status, evaluateResourceAdmission({ measurement: measured.measurement, requested: { ramBytes: 0, diskBytes: Object.fromEntries(ids.map(id => [id, 0])) }, unusedReservations: [], requiredFileSystemIds: ids }).level);
  }
  console.log(JSON.stringify({ scenario: t.name, defaultResult: actual, measuredReasons: measured.reasons, measurement: measured.measurement, filesystemCount: measured.measurement.fileSystems.length }));
});

test('qa sqlite: two live handles fence stale closure and preserve rollback across competing access', async t => {
  const { path } = await fixture(t);
  const first = openStateStore(path);
  const second = openStateStore(path);
  t.after(() => { second.close(); first.close(); });
  seed(first, record());
  const a = createSessionState({ repository: first.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => false });
  const b = createSessionState({ repository: second.sessionRepository, verifyMainAuthority: () => false, verifyWorkResult: () => false });
  const revision = b.listReconciliationCandidates()[0].revision;
  const observation = { state: 'exited' as const, observedAt: new Date().toISOString(), exitCode: 1, evidence: 'qa' };
  const effects = { pending: [{ id: 'once-failed', runId: 'qa-run', event: 'agent.failed', payload: { kind: 'agent.failed', id: 'qa-worker' } }], domain: [] };
  assert.equal(a.commitObservation('qa-run', revision, observation, effects), true);
  assert.equal(b.commitObservation('qa-run', revision, observation, effects), false);
  assert.equal(second.sessionRepository.transaction(tx => tx.listPending()).length, 1);
  assert.throws(() => first.eventRepository.transaction(tx => {
    tx.savePending({ key: 'locked', event: { kind: 'agent.closed', id: 'qa-worker' } });
    assert.throws(() => second.eventRepository.transaction(other => other.savePending({ key: 'competing', event: { kind: 'agent.failed', id: 'qa-worker' } })), /SQLite/);
    throw new Error('qa abort write');
  }), /qa abort write/);
  assert.deepEqual(second.eventRepository.transaction(tx => tx.listPending()).map(fact => fact.key), ['once-failed']);
  const current = a.listReconciliationCandidates()[0];
  assert.equal(a.finalizeSession('qa-run', current.revision, new Date().toISOString(), { pending: [], domain: [] }), true);
  assert.equal(b.finalizeSession('qa-run', current.revision, new Date().toISOString(), { pending: [], domain: [] }), false);
});
