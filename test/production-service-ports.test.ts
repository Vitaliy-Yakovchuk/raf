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
import { createEventRegistry } from '../src/event-registry.ts';
import { evaluateResourceAdmission } from '../src/resource-admission.ts';
import type { ServiceEntryContext } from '../src/service-entry.ts';
import type { SessionRecord, ProcessObservation } from '../src/session-state.ts';
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
  const { costProfile } = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  await writeFile(join(context.orchestratorRoot, 'conf', 'raf.json'), JSON.stringify({ version: 1, costProfile, state: { fileName: 'shared.sqlite' }, service: { hostTickIntervalMs: 15000, readinessTimeoutMs: 30000 }, resourceWait: { grantIntervalMs: 15000, deliveryTimeoutMs: 30000 } }));
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

test('composition: default dependencies exist without required injected production ports', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const dependencies = await createProductionServiceDependencies(context);
  for (const key of ['now', 'nextReminderId', 'observeProcesses', 'effectsForObservation', 'eventPorts', 'deliverReminder', 'schedule'] as const) assert.equal(typeof dependencies[key], 'function', key);
  for (const key of ['readSnapshot', 'isClientAlive', 'watchResources', 'schedule', 'loadLastGrant', 'saveLastGrant'] as const) assert.equal(typeof dependencies.resourceWait[key], 'function', key);
  const first = dependencies.nextReminderId();
  assert.ok(first.length > 0);
  assert.notEqual(dependencies.nextReminderId(), first);
  assert.ok(Number.isFinite(dependencies.now()));
  assert.deepEqual(await dependencies.observeProcesses([]), []);
  assert.equal(dependencies.resourceWait.isClientAlive('unregistered-client'), false);
});

test('composition: process scan failure stays unknown with supplied OS seam', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  let scans = 0;
  const dependencies = await createProductionServiceDependencies(context, { processScan: { execute: async () => { scans++; throw new Error('fixture scan unavailable'); }, now: () => new Date(at).toISOString() } });
  const observations = await dependencies.observeProcesses([identity]);
  assert.ok(scans > 0);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].state, 'unknown');
  assert.equal(observations[0].observedAt, new Date(at).toISOString());
  assert.ok('error' in observations[0] && observations[0].error.length > 0);
});

test('composition: alive and unknown observations have no failure or reminder effects', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const dependencies = await createProductionServiceDependencies(context);
  const observations: ProcessObservation[] = [{ state: 'alive', identity, observedAt: new Date(at).toISOString() }, { state: 'unknown', error: 'scan unavailable', observedAt: new Date(at).toISOString() }];
  for (const observation of observations) assert.deepEqual(dependencies.effectsForObservation(session, observation), { pending: [], domain: [] });
});

test('composition: exit emits run-scoped failure, not final agent.closed or a resume intent', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const dependencies = await createProductionServiceDependencies(context);
  const observation: ProcessObservation = { state: 'exited', observedAt: new Date(at).toISOString(), exitCode: 1, evidence: 'fixture process absent' };
  const effects = dependencies.effectsForObservation(session, observation);
  const failures = effects.pending.filter(intent => intent.event === 'agent.failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].runId, session.runId);
  assert.deepEqual(failures[0].payload, { kind: 'agent.failed', id: session.addressId });
  assert.ok(failures[0].id.length > 0);
  assert.deepEqual(dependencies.effectsForObservation(session, observation), effects);
  assert.equal(effects.pending.some(intent => intent.event === 'agent.closed' || /resume|restart|spawn/.test(intent.event)), false);
  assert.equal(effects.domain.length, 0);
});

test('composition: accepted succeeded survives nonzero process exit', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const dependencies = await createProductionServiceDependencies(context);
  const successful = { ...session, result: { status: 'succeeded', response: 'verified earlier', proof: { fixture: true } } };
  const effects = dependencies.effectsForObservation(successful, { state: 'exited', observedAt: new Date(at).toISOString(), exitCode: 7, evidence: 'fixture exit' });
  assert.equal(effects.pending.some(intent => intent.event === 'agent.failed'), false);
  assert.equal(effects.pending.some(intent => intent.event === 'agent.closed'), false);
  assert.deepEqual(successful.result, { status: 'succeeded', response: 'verified earlier', proof: { fixture: true } });
});

test('composition: default validation rejects self-claimed main and work-result proofs', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const dependencies = await createProductionServiceDependencies(context);
  assert.equal(dependencies.sessionValidation.verifyMainAuthority({ kind: 'main', verified: true }, identity), false);
  assert.equal(dependencies.sessionValidation.verifyWorkResult(session.runId, { status: 'succeeded', response: 'claim', proof: true }), false);
});

test('composition: unverified main transport returns honest unavailable', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const dependencies = await createProductionServiceDependencies(context);
  const receipt = await dependencies.deliverReminder({ id: 'r1', createdFor: 'worker', assignedTo: 'main', text: 'deliver', at: new Date(at).toISOString(), binding: null, state: 'active', closedAt: null, closeReason: null });
  assert.equal(receipt.delivered, false);
  assert.match(receipt.reason ?? '', /unavailable|unverified|недоступ|непідтвердж/i);
  assert.equal('receiptId' in receipt, false);
});

test('composition: shared delivery receives system sender, literal text and both addresses', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const calls: unknown[] = [];
  const dependencies = await createProductionServiceDependencies(context, { sharedDelivery: async (request, sender) => { calls.push({ request, sender }); return { accepted: true, receiptId: 'verified-fixture-receipt' }; } });
  const text = 'literal $(do-not-run) `do-not-run`\nnext line';
  const receipt = await dependencies.deliverReminder({ id: 'r1', createdFor: 'worker', assignedTo: 'main', text, at: new Date(at).toISOString(), binding: null, state: 'active', closedAt: null, closeReason: null });
  assert.equal(receipt.delivered, true);
  assert.equal(calls.length, 1);
  const call = calls[0] as { request: { to: string; text: string }; sender: unknown };
  assert.equal(call.request.to, 'main');
  assert.deepEqual(call.sender, { kind: 'system' });
  assert.ok(call.request.text.includes(text));
  assert.ok(call.request.text.includes('worker'));
  assert.ok(call.request.text.includes('main'));
  assert.ok(call.request.text.includes('r1'));
  assert.equal(call.request.text.startsWith('[raf]'), false);
});

test('composition: rejected or throwing shared delivery never yields delivered true', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const reminder = { id: 'r1', createdFor: 'worker', assignedTo: 'main', text: 'hello', at: new Date(at).toISOString(), binding: null, state: 'active' as const, closedAt: null, closeReason: null };
  const rejected = await createProductionServiceDependencies(context, { sharedDelivery: async () => ({ accepted: false, reason: 'fixture target unavailable' }) });
  assert.deepEqual(await rejected.deliverReminder(reminder), { delivered: false, reason: 'fixture target unavailable' });
  const throwing = await createProductionServiceDependencies(context, { sharedDelivery: async () => { throw new Error('fixture transport down'); } });
  await assert.rejects(throwing.deliverReminder(reminder), /fixture transport down/);
});

test('composition: injected absolute scheduler and clock are shared by host and resource wait', async t => {
  const { createProductionServiceDependencies, context } = await fixture(t);
  const scheduled: number[] = [];
  let cancelled = 0;
  const schedule = (deadline: number, _wake: () => Promise<void>) => { scheduled.push(deadline); return () => { cancelled++; }; };
  const dependencies = await createProductionServiceDependencies(context, { now: () => at, nextReminderId: () => 'fixture-id', schedule, isClientAlive: id => id === 'connected' });
  assert.equal(dependencies.now(), at);
  assert.equal(dependencies.nextReminderId(), 'fixture-id');
  const cancelHost = dependencies.schedule(at + 10, async () => {});
  const cancelQueue = dependencies.resourceWait.schedule(at + 20, async () => {});
  assert.deepEqual(scheduled, [at + 10, at + 20]);
  cancelHost();
  cancelQueue();
  assert.equal(cancelled, 2);
  assert.equal(dependencies.resourceWait.isClientAlive('connected'), true);
  assert.equal(dependencies.resourceWait.isClientAlive('disconnected'), false);
});

test('sqlite: event pending facts survive reopen and apply through the shared reminder store', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  let store = openStateStore(path);
  t.after(() => store.close());
  seed(store);
  const reminder = reminders(store).add({ to: 'worker', text: 'event-bound', at: new Date(at + 60000).toISOString(), binding: { kind: 'agent.failed', id: 'worker', action: 'activate' } });
  let dependencies = await createProductionServiceDependencies(context, { now: () => at });
  const fact = { key: 'fixture-run:failed', event: { kind: 'agent.failed', id: 'worker' } };
  createEventRegistry(catalog, dependencies.eventPorts(store)).enqueue(fact);
  store.close();
  store = openStateStore(path);
  dependencies = await createProductionServiceDependencies(context, { now: () => at });
  const registry = createEventRegistry(catalog, dependencies.eventPorts(store));
  assert.ok(registry.dispatch().delivered.includes(fact.key));
  assert.equal(reminders(store).list().find(item => item.id === reminder.id)?.state, 'active');
  assert.equal(registry.dispatch().delivered.includes(fact.key), false);
});

test('sqlite: event application and acknowledgement roll back together', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store);
  const reminder = reminders(store).add({ to: 'worker', text: 'atomic', at: new Date(at + 60000).toISOString(), binding: { kind: 'agent.failed', id: 'worker', action: 'activate' } });
  const dependencies = await createProductionServiceDependencies(context, { now: () => at });
  const ports = dependencies.eventPorts(store);
  const registry = createEventRegistry(catalog, ports);
  const fact = { key: 'rollback:failed', event: { kind: 'agent.failed', id: 'worker' } };
  registry.enqueue(fact);
  assert.throws(() => ports.transaction(tx => { assert.equal(tx.applyReminderEvent(fact.event), 'delivered'); tx.deletePending(fact.key); throw new Error('fixture rollback'); }), /fixture rollback/);
  assert.equal(reminders(store).list().find(item => item.id === reminder.id)?.state, 'pending');
  assert.ok(ports.transaction(tx => tx.listPending()).some(item => item.key === fact.key));
  assert.ok(registry.dispatch().delivered.includes(fact.key));
});

test('sqlite: reminder emissions enter the same pending event transaction', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  const store = openStateStore(path);
  t.after(() => store.close());
  seed(store);
  const dependencies = await createProductionServiceDependencies(context, { now: () => at });
  const ports = dependencies.eventPorts(store);
  const service = reminders(store);
  const reminder = service.add({ to: 'worker', text: 'emit', at: new Date(at + 60000).toISOString() });
  service.activate(reminder.id);
  assert.ok(ports.transaction(tx => tx.listPending()).some(fact => fact.event.kind === 'reminder.activated' && fact.event.id === reminder.id));
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
  dependencies.eventPorts(store);
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
    dependencies.eventPorts(store);
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
  dependencies.eventPorts(store);
  const failed = await dependencies.resourceWait.readSnapshot();
  assert.equal(failed.status, 'UNKNOWN');
  assert.match(failed.reason, /fixture sampler unavailable/);
  const missing = await createProductionServiceDependencies(context, { resourcePaths: [context.stateDirectory], resourceReader: { read: async () => snapshot([]) } });
  missing.eventPorts(store);
  const unavailable = await missing.resourceWait.readSnapshot();
  assert.equal(unavailable.status, 'UNKNOWN');
  assert.ok(unavailable.reason.length > 0);
});

test('sqlite: resource grant timestamp persists across factory and store restart', async t => {
  const { createProductionServiceDependencies, context, path } = await fixture(t);
  let store = openStateStore(path);
  t.after(() => store.close());
  let dependencies = await createProductionServiceDependencies(context);
  dependencies.eventPorts(store);
  assert.equal(dependencies.resourceWait.loadLastGrant(), null);
  dependencies.resourceWait.saveLastGrant(at);
  store.close();
  store = openStateStore(path);
  dependencies = await createProductionServiceDependencies(context);
  dependencies.eventPorts(store);
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
  await ports.recover();
  assert.deepEqual(await ports.handle({ operation: 'reminder.list', payload: {} }, { clientId: 'fixture-client', signal: new AbortController().signal }), []);
  await ports.shutdown();
  const store = openStateStore(path);
  t.after(() => store.close());
  assert.deepEqual(store.sessionRepository.transaction(tx => tx.listSessions()), []);
});

test('sqlite: default host finalizes prior confirmed exit and transfers reminders without fake delivery', async t => {
  const { createServicePorts, context, path } = await fixture(t);
  const store = openStateStore(path);
  seed(store);
  const reminder = reminders(store).add({ to: 'worker', text: 'unfinished', at: new Date(at + 60000).toISOString() });
  seed(store, { ...session, state: 'exited', observation: { state: 'exited', observedAt: new Date(at).toISOString(), exitCode: 1, evidence: 'already confirmed' } });
  const original = store.sessionRepository.transaction(tx => tx.getSession(session.runId));
  store.close();
  const ports = await createServicePorts(context, { now: () => at });
  t.after(() => ports.shutdown());
  await ports.recover();
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

test('sqlite: default host closes reminders for persisted verified succeeded despite nonzero exit', async t => {
  const { createServicePorts, context, path } = await fixture(t);
  const store = openStateStore(path);
  seed(store);
  const reminder = reminders(store).add({ to: 'worker', text: 'completed', at: new Date(at + 60000).toISOString() });
  seed(store, { ...session, state: 'exited', result: { status: 'succeeded', response: 'already verified', proof: null }, observation: { state: 'exited', observedAt: new Date(at).toISOString(), exitCode: 7, evidence: 'already confirmed' } });
  const original = store.sessionRepository.transaction(tx => tx.getSession(session.runId));
  store.close();
  const ports = await createServicePorts(context, { now: () => at });
  t.after(() => ports.shutdown());
  await ports.recover();
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
