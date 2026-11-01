import { pathToFileURL } from 'node:url';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { connectResourceWait } from '../src/resource-wait-transport.ts';
import { readWaitIdentity } from '../src/resource-wait-identity.ts';
import { openStateStore } from '../src/state-store.ts';
import { ReminderService } from '../src/reminders.ts';
import { evaluateResourceAdmission } from '../src/resource-admission.ts';
import type { ServiceEntryContext } from '../src/service-entry.ts';
import type { SessionRecord } from '../src/session-state.ts';
import type { ResourceSnapshot } from '../src/os-runtime.ts';
import type { StateStore } from '../src/state-store.ts';

const at = Date.parse('2026-10-22T00:00:00.000Z');
const identity = { pid: 123456789, startedAt: new Date(at).toISOString(), runner: 'codex', runnerSessionId: 'fixture-cli', tmuxSession: 'fixture-tmux', evidence: { runId: 'fixture-run' } };
const session: SessionRecord = {
  runId: 'fixture-run', addressId: 'worker', revision: 1, state: 'running', process: identity,
  activity: { type: 'implement', project: 'raf', features: ['background-runtime'], phase: 'implement', cwd: '/fixture/raf-main' },
};
const catalog = {
  commands: [],
  events: [
    { id: 'agent.failed', idKind: 'agentAddress', description: 'Failed' },
    { id: 'agent.closed', idKind: 'agentAddress', description: 'Closed' },
    { id: 'reminder.activated', idKind: 'reminderId', description: 'Activated' },
    { id: 'reminder.closed', idKind: 'reminderId', description: 'Closed' },
  ],
  eventIdKinds: { agentAddress: 'Address', reminderId: 'Reminder' },
  resourceWaitLevels: [{ id: 'hotfix', priority: 0 }, { id: 'normal', priority: 1 }],
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-service-ports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context: ServiceEntryContext = { orchestratorRoot: join(root, 'orchestrator'), homeDirectory: join(root, 'home'), stateDirectory: join(root, 'home', '.raf'), socketPath: join(root, 'home', '.raf', 'service.sock') };
  await mkdir(join(context.orchestratorRoot, 'conf'), { recursive: true });
  await mkdir(context.stateDirectory, { recursive: true });
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  settings.state = { ...settings.state, fileName: 'shared.sqlite' };
  settings.service = { ...settings.service, hostTickIntervalMs: 15000, readinessTimeoutMs: 30000 };
  settings.resourceWait = { ...settings.resourceWait, grantIntervalMs: 15000, deliveryTimeoutMs: 30000 };
  await writeFile(join(context.orchestratorRoot, 'conf', 'raf.json'), JSON.stringify(settings));
  await writeFile(join(context.orchestratorRoot, 'conf', 'raf-constants.json'), JSON.stringify(catalog));
  await writeFile(join(context.orchestratorRoot, 'conf', 'projects.json'), await readFile(new URL('../../conf/projects.json', import.meta.url)));
  await prepareProductionQaFixture(t, { root: context.orchestratorRoot, home: context.homeDirectory });
  const { createProductionServiceDependencies, createServicePorts }: typeof import('../src/production-service-ports.ts') = await import(pathToFileURL(join(context.orchestratorRoot, 'raf-develop', 'src', 'production-service-ports.ts')).href);
  const { createServicePorts: createHostPorts }: typeof import('../src/service-host.ts') = await import(pathToFileURL(join(context.orchestratorRoot, 'raf-develop', 'src', 'service-host.ts')).href);
  return { createProductionServiceDependencies, createServicePorts, createHostPorts, context, path: join(context.stateDirectory, 'shared.sqlite') };
}

function seed(store: StateStore, record = session) {
  store.sessionRepository.transaction(tx => tx.putSession(structuredClone(record)));
}

function reminders(store: StateStore) {
  let sequence = 0;
  return new ReminderService({ repository: store.reminderRepository, now: () => new Date(at).toISOString(), nextId: () => `fixture-reminder-${++sequence}`, approvedEventKinds: catalog.events.map(event => event.id) });
}

function snapshot(paths: readonly string[]): ResourceSnapshot {
  return {
    measurement: { machineId: 'fixture-machine', loadAverage1m: 0, availableCores: 8, totalRamBytes: 64 * 2 ** 30, availableRamBytes: 48 * 2 ** 30, memoryPressure: 'normal', fileSystems: [{ id: 'fixture-volume', totalBytes: 1024 * 2 ** 30, availableBytes: 512 * 2 ** 30 }] },
    reasons: [], fileSystemByPath: Object.fromEntries([...paths, homedir()].map(path => [path, 'fixture-volume'])),
  };
}

const absentDependency = ['reconcileLaunches', 'nextReminderId', 'observeProcesses', 'effectsForObservation', 'eventPorts', 'deliverReminder'] as const;

test('composition: default dependencies expose the resource queue and not reminder or session operations', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const dependencies = await createProductionServiceDependencies(context);
  for (const key of absentDependency) assert.equal(Object.hasOwn(dependencies, key), false, key);
  for (const key of ['readSnapshot', 'isClientAlive', 'watchResources', 'schedule', 'loadLastGrant', 'saveLastGrant'] as const) assert.equal(typeof dependencies.resourceWait[key], 'function', key);
  assert.equal(typeof dependencies.now, 'function');
  assert.equal(typeof dependencies.schedule, 'function');
  assert.equal(typeof dependencies.bindStore, 'function');
  assert.ok(Number.isFinite(dependencies.now()));
  assert.equal(dependencies.resourceWait.isClientAlive('unregistered-client'), false);
});

test('composition: process scan failure stays unknown for resource admission', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store);
  let scans = 0;
  const dependencies = await createProductionServiceDependencies(context, { processScan: { execute: async () => { scans++; throw new Error('fixture scan unavailable'); }, now: () => new Date(at).toISOString() } });
  dependencies.bindStore(store);
  const actual = await dependencies.resourceWait.readSnapshot();
  assert.ok(scans > 0);
  assert.equal(actual.status, 'UNKNOWN');
  assert.match(actual.reason, /scan/i);
  assert.equal(store.sessionRepository.transaction(tx => tx.getSession(session.runId))?.state, 'running');
});

test('composition: injected absolute scheduler and clock are shared by host and resource wait', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const scheduled: number[] = [];
  let cancelled = 0;
  const schedule = (deadline: number, _wake: () => Promise<void>) => { scheduled.push(deadline); return () => { cancelled++; }; };
  const dependencies = await createProductionServiceDependencies(context, { now: () => at, schedule, isClientAlive: id => id === 'connected' });
  assert.equal(dependencies.now(), at);
  for (const key of absentDependency) assert.equal(Object.hasOwn(dependencies, key), false, key);
  const cancelHost = dependencies.schedule(at + 10, async () => {});
  const cancelQueue = dependencies.resourceWait.schedule(at + 20, async () => {});
  assert.deepEqual(scheduled, [at + 10, at + 20]);
  cancelHost();
  cancelQueue();
  assert.equal(cancelled, 2);
  assert.equal(dependencies.resourceWait.isClientAlive('connected'), true);
  assert.equal(dependencies.resourceWait.isClientAlive('disconnected'), false);
});

test('sqlite: service recovery does not apply a pending event or activate a bound reminder', async t => {
  const { createServicePorts, context, path } = await fixture(t);
  const store = openStateStore(path);
  seed(store);
  const reminder = reminders(store).add({ to: 'worker', text: 'event-bound', at: new Date(at + 60000).toISOString(), binding: { kind: 'agent.failed', id: 'worker', action: 'activate' } });
  const fact = { key: 'fixture-run:failed', event: { kind: 'agent.failed', id: 'worker' } };
  store.eventRepository.transaction(tx => tx.savePending(fact));
  const before = store.sessionRepository.transaction(tx => tx.getSession(session.runId));
  store.close();
  const ports = await createServicePorts(context, { now: () => at });
  t.after(() => ports.shutdown());
  await ports.recover({ serviceEpoch: 'pending-event-fixture-epoch' });
  await ports.refresh();
  await ports.shutdown();
  const reopened = openStateStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.sessionRepository.transaction(tx => tx.getSession(session.runId)), before);
  assert.equal(reminders(reopened).list().find(item => item.id === reminder.id)?.state, 'pending');
  assert.ok(reopened.eventRepository.transaction(tx => tx.listPending()).some(item => item.key === fact.key));
});

test('sqlite: resource snapshot delegates admission including unused reservations and path IDs', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  const paths = [context.orchestratorRoot, context.stateDirectory, join(context.homeDirectory, 'tmp')];
  const measured = snapshot(paths);
  const resources = { ramBytes: 47 * 2 ** 30, diskBytes: { 'fixture-volume': 2 ** 30 } };
  store.sessionRepository.transaction(tx => { tx.putSession({ ...session, state: 'reserved' }); tx.putReservation({ runId: session.runId, resource: 'bundle', amount: 1, resourceBundle: { machineId: 'fixture-machine', resources } }); });
  let reads = 0;
  const dependencies = await createProductionServiceDependencies(context, { resourcePaths: paths, resourceReader: { read: async () => { reads++; return measured; } } });
  dependencies.bindStore(store);
  const actual = await dependencies.resourceWait.readSnapshot();
  const expected = evaluateResourceAdmission({ measurement: measured.measurement, requested: { ramBytes: 0, diskBytes: { 'fixture-volume': 0 } }, unusedReservations: [resources], requiredFileSystemIds: ['fixture-volume'] });
  assert.equal(actual.status, expected.level);
  assert.equal(reads, 1);
  assert.ok(actual.reason.length > 0);
});

test('sqlite: resource wait checks disk only on the development tree volume', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  const measured = (devAvailable: number): ResourceSnapshot => ({
    measurement: { ...snapshot([]).measurement, fileSystems: [{ id: 'dev-volume', totalBytes: 1024 * 2 ** 30, availableBytes: devAvailable }, { id: 'home-volume', totalBytes: 11 * 2 ** 30, availableBytes: 2 ** 20 }] },
    reasons: [], fileSystemByPath: { [context.orchestratorRoot]: 'dev-volume', [context.stateDirectory]: 'home-volume', [homedir()]: 'dev-volume' },
  });
  const wait = async (devAvailable: number) => {
    const dependencies = await createProductionServiceDependencies(context, { resourceReader: { read: async () => measured(devAvailable) } });
    dependencies.bindStore(store);
    return dependencies.resourceWait.readSnapshot();
  };
  const ample = await wait(512 * 2 ** 30);
  assert.equal(ample.status, 'ANY_RUN', ample.reason);
  const full = await wait(2 ** 20);
  assert.equal(full.status, 'NO_RESOURCES');
  assert.match(full.reason, /insufficient disk on dev-volume/);
  assert.doesNotMatch(full.reason, /home-volume/);
});

test('sqlite: failed resource probe and missing filesystem never become admission', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  const dependencies = await createProductionServiceDependencies(context, { resourceReader: { read: async () => { throw new Error('fixture sampler unavailable'); } } });
  dependencies.bindStore(store);
  const failed = await dependencies.resourceWait.readSnapshot();
  assert.equal(failed.status, 'UNKNOWN');
  assert.match(failed.reason, /fixture sampler unavailable/);
  const missing = await createProductionServiceDependencies(context, { resourcePaths: [context.stateDirectory], resourceReader: { read: async () => snapshot([]) } });
  missing.bindStore(store);
  const unavailable = await missing.resourceWait.readSnapshot();
  assert.equal(unavailable.status, 'UNKNOWN');
  assert.ok(unavailable.reason.length > 0);
});

test('sqlite: resource grant timestamp persists across factory and store restart', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  let store = openStateStore(path);
  t.after(() => store.close());
  let dependencies = await createProductionServiceDependencies(context);
  dependencies.bindStore(store);
  assert.equal(dependencies.resourceWait.loadLastGrant(), null);
  dependencies.resourceWait.saveLastGrant(at);
  store.close();
  store = openStateStore(path);
  dependencies = await createProductionServiceDependencies(context);
  dependencies.bindStore(store);
  assert.equal(dependencies.resourceWait.loadLastGrant(), at);
  assert.throws(() => dependencies.resourceWait.saveLastGrant(Number.NaN), /grant|finite|invalid|час/i);
  assert.equal(dependencies.resourceWait.loadLastGrant(), at);
});

test('composition: resource monitor uses configured cadence and releases its scheduled wake', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const timers: { at: number; wake: () => Promise<void>; cancelled: boolean }[] = [];
  let wakes = 0;
  const dependencies = await createProductionServiceDependencies(context, { now: () => at, schedule: (deadline, wake) => { const timer = { at: deadline, wake, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } });
  const unwatch = dependencies.resourceWait.watchResources(async () => { wakes++; });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, at + 15000);
  await timers[0].wake();
  assert.equal(wakes, 1);
  assert.equal(timers.length, 2);
  unwatch();
  assert.equal(timers[1].cancelled, true);
});

test('sqlite: default host entry recovers and shuts down without injected production ports', async t => {
  const { createServicePorts, context, path } = await fixture(t);
  const ports = await createServicePorts(context);
  t.after(() => ports.shutdown());
  await ports.recover({ serviceEpoch: 'default-host-fixture-epoch' });
  await assert.rejects(ports.handle({ operation: 'reminder.list', payload: {} }, { clientId: 'fixture-client', signal: new AbortController().signal }), /Unsupported service operation/);
  await ports.shutdown();
  const store = openStateStore(path);
  t.after(() => store.close());
  assert.deepEqual(store.sessionRepository.transaction(tx => tx.listSessions()), []);
});

test('sqlite: default host leaves a confirmed exit and its reminders unchanged', async t => {
  const { createServicePorts, context, path } = await fixture(t);
  const store = openStateStore(path);
  seed(store);
  const reminder = reminders(store).add({ to: 'worker', text: 'unfinished', at: new Date(at + 60000).toISOString() });
  seed(store, { ...session, state: 'exited', observation: { state: 'exited', observedAt: new Date(at).toISOString(), exitCode: 1, evidence: 'already confirmed' } });
  const original = store.sessionRepository.transaction(tx => tx.getSession(session.runId));
  store.close();
  const ports = await createServicePorts(context, { now: () => at });
  t.after(() => ports.shutdown());
  await ports.recover({ serviceEpoch: 'confirmed-exit-fixture-epoch' });
  await ports.refresh();
  await ports.shutdown();
  const reopened = openStateStore(path);
  t.after(() => reopened.close());
  const final = reopened.sessionRepository.transaction(tx => tx.getSession(session.runId));
  assert.deepEqual(final, original);
  const transferred = reminders(reopened).list().find(item => item.id === reminder.id);
  assert.deepEqual(transferred, reminder);
  assert.equal(reopened.sessionRepository.transaction(tx => tx.listSessions()).length, 1);
});

test('sqlite: default host leaves a verified succeeded session and its reminders unchanged', async t => {
  const { createServicePorts, context, path } = await fixture(t);
  const store = openStateStore(path);
  seed(store);
  const reminder = reminders(store).add({ to: 'worker', text: 'completed', at: new Date(at + 60000).toISOString() });
  seed(store, { ...session, state: 'exited', result: { status: 'succeeded', response: 'already verified', proof: null }, observation: { state: 'exited', observedAt: new Date(at).toISOString(), exitCode: 7, evidence: 'already confirmed' } });
  const original = store.sessionRepository.transaction(tx => tx.getSession(session.runId));
  store.close();
  const ports = await createServicePorts(context, { now: () => at });
  t.after(() => ports.shutdown());
  await ports.recover({ serviceEpoch: 'succeeded-exit-fixture-epoch' });
  await ports.shutdown();
  const reopened = openStateStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.sessionRepository.transaction(tx => tx.getSession(session.runId)), original);
  const closed = reminders(reopened).list().find(item => item.id === reminder.id);
  assert.deepEqual(closed, reminder);
});

test('sqlite: default host tracks connected resource client and persists its actual permit', async t => {
  const { createServicePorts, context, path } = await fixture(t);
  const paths = [context.orchestratorRoot, context.stateDirectory];
  const ports = await createServicePorts(context, { now: () => at, resourcePaths: paths, resourceReader: { read: async () => snapshot(paths) } });
  const serviceEpoch = 'connected-resource-fixture-epoch';
  const controller = new AbortController();
  const sockets = new Set<Socket>();
  let hostTask: Promise<void> | undefined;
  let hostError: unknown;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => { hostError = error; });
    let input = '';
    const receiveEnqueue = (chunk: Buffer) => {
      input += chunk.toString('utf8');
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      socket.off('data', receiveEnqueue);
      try {
        const message = JSON.parse(input.slice(0, newline));
        assert.equal(message.kind, 'resource-wait');
        assert.equal(message.epoch, serviceEpoch);
        assert.equal(input.slice(newline + 1), '', 'client waits for its offer before sending ready');
        hostTask = ports.resourceWait(socket, message, controller.signal).catch(error => {
          hostError = error;
          socket.destroy();
        });
      } catch (error) {
        hostError = error;
        socket.destroy();
      }
    };
    socket.on('data', receiveEnqueue);
  });
  t.after(async () => {
    controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await ports.shutdown();
  });
  await ports.recover({ serviceEpoch });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(context.socketPath, resolve);
  });
  const client = await connectResourceWait({ endpoint: context.socketPath, serviceEpoch });
  t.after(() => client.close());
  const ticket = await client.enqueue({
    level: 'normal', clientIdentity: await readWaitIdentity(),
    connectionId: 'connected-resource-fixture', developmentDirectory: context.orchestratorRoot,
  });
  assert.equal(ticket.serviceEpoch, serviceEpoch);
  assert.ok(ticket.requestId.length > 0);
  const offered = await client.receive();
  assert.equal(offered.kind, 'offer');
  if (offered.kind !== 'offer') throw new Error('Expected resource offer');
  assert.equal(offered.offer.requestId, ticket.requestId);
  assert.equal(offered.offer.serviceEpoch, ticket.serviceEpoch);
  assert.ok(offered.offer.offerId.length > 0);
  const beforeReady = openStateStore(path);
  try {
    assert.equal(beforeReady.readResourceWaitGrant(), null);
    assert.deepEqual(beforeReady.sessionRepository.transaction(tx => tx.listReservations()), []);
  } finally { beforeReady.close(); }
  await client.sendReady(offered.offer);
  const received = await client.receive();
  assert.equal(received.kind, 'result');
  if (received.kind !== 'result') throw new Error('Expected committed resource result');
  const result = received.result;
  assert.equal(result.kind, 'permit');
  if (result.kind !== 'permit') throw new Error('Expected resource permit');
  assert.equal(result.requestId, ticket.requestId);
  assert.equal(result.serviceEpoch, serviceEpoch);
  assert.equal(result.offerId, offered.offer.offerId);
  assert.deepEqual(result.permit, { requestId: ticket.requestId, serviceEpoch, grantedAt: at });
  await client.close();
  await hostTask;
  assert.equal(hostError, undefined);
  await ports.shutdown();
  const reopened = openStateStore(path);
  t.after(() => reopened.close());
  const durable = reopened.readResourceWaitGrant();
  assert.ok(durable);
  assert.equal(durable.requestId, result.permit.requestId);
  assert.equal(durable.serviceEpoch, result.permit.serviceEpoch);
  assert.equal(durable.grantedAt, result.permit.grantedAt);
  assert.ok(durable.bootIdentity.length > 0);
  assert.ok(Number.isFinite(durable.monotonicAt));
  assert.deepEqual(reopened.sessionRepository.transaction(tx => tx.listReservations()), []);
});
