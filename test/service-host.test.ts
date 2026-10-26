import { pathToFileURL } from 'node:url';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import { ReminderService } from '../src/reminders.ts';
import type { ServiceHostDependencies } from '../src/service-host.ts';
import type { AdmissionSnapshot } from '../src/resource-wait.ts';
import type { ProcessIdentity, ProcessObservation } from '../src/session-state.ts';
import type { PendingEvent } from '../src/event-registry.ts';

const identity: ProcessIdentity = {
  pid: 42, startedAt: '2026-10-22T00:00:00.000Z', runner: 'fixture',
  runnerSessionId: 'session-one', tmuxSession: 'owned-fixture', evidence: { source: 'fixture' },
};
const constants = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const flow = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8'));

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-host-compose-')));
  const homeDirectory = join(root, 'home');
  const stateDirectory = join(homeDirectory, '.raf');
  await Promise.all([mkdir(join(root, 'conf')), mkdir(stateDirectory, { recursive: true })]);
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  settings.service = { ...settings.service, hostTickIntervalMs: 37_000 };
  await Promise.all([
    writeFile(join(root, 'conf', 'raf.json'), JSON.stringify(settings)),
    writeFile(join(root, 'conf', 'raf-constants.json'), JSON.stringify(constants)),
    writeFile(join(root, 'conf', 'flow.json'), JSON.stringify(flow)),
  ]);
  const context = { orchestratorRoot: root, homeDirectory, stateDirectory, socketPath: join(stateDirectory, 'service.sock') };
  const path = join(stateDirectory, settings.state.fileName);
  await writeFile(join(root, 'conf', 'projects.json'), await readFile(new URL('../../conf/projects.json', import.meta.url)));
  await prepareProductionQaFixture(t, { root, home: homeDirectory }, async codeRoot => {
    await mkdir(join(codeRoot, 'dist'), { recursive: true });
    await writeFile(join(codeRoot, 'dist', 'catalog.json'), await readFile(new URL('../dist/catalog.json', import.meta.url)));
  });
  const { createServicePorts }: typeof import('../src/service-host.ts') = await import(pathToFileURL(join(root, 'raf-develop', 'src', 'service-host.ts')).href);
  const store = openStateStore(path);
  let now = Date.parse('2026-10-22T12:00:00.000Z');
  let sequence = 0;
  let stopped = false;
  let lastGrant: number | null = null;
  let resourceWake: (() => Promise<void>) | undefined;
  let snapshot: AdmissionSnapshot = { status: 'ANY_RUN', reason: 'Injected admission observation' };
  const scheduled = new Map<number, () => Promise<void>>();
  const observed: ProcessIdentity[][] = [];
  const delivered: string[] = [];
  const eventPending = new Map<string, PendingEvent>();
  const eventDelivered: string[] = [];
  let scan = async (identities: readonly ProcessIdentity[]): Promise<ProcessObservation[]> => identities.map(item => ({ state: 'alive', observedAt: new Date(now).toISOString(), identity: item }));
  const deps: ServiceHostDependencies = {
    now: () => now,
    nextReminderId: () => `host-${++sequence}`,
    observeProcesses: async identities => { observed.push([...identities]); return scan(identities); },
    effectsForObservation: () => ({ pending: [], domain: [] }),
    sessionValidation: {
      verifyMainAuthority: () => { throw new Error('Host must not invent main registration'); },
      verifyWorkResult: () => { throw new Error('Observation is not a successful work result'); },
    },
    eventPorts: () => ({
      validateId: (_kind, id) => id.length > 0,
      transaction: operation => operation({
        listPending: () => [...eventPending.values()],
        savePending: fact => { eventPending.set(fact.key, fact); },
        deletePending: key => { eventPending.delete(key); },
        applyReminderEvent: event => { eventDelivered.push(event.id); return 'delivered'; },
      }),
    }),
    deliverReminder: async reminder => { delivered.push(reminder.id); return { delivered: true }; },
    resourceWait: {
      readSnapshot: async () => snapshot,
      isClientAlive: () => true,
      watchResources: wake => { resourceWake = wake; return () => { resourceWake = undefined; }; },
      schedule: (at, wake) => { scheduled.set(at, wake); return () => { scheduled.delete(at); }; },
      loadLastGrant: () => lastGrant,
      saveLastGrant: at => { lastGrant = at; },
    },
    schedule: (at, wake) => { scheduled.set(at, wake); return () => { scheduled.delete(at); }; },
  };
  const reminders = new ReminderService({ repository: store.reminderRepository, now: () => new Date(now).toISOString(), nextId: () => `seed-${++sequence}`, approvedEventKinds: constants.events.map((event: { id: string }) => event.id) });
  store.sessionRepository.transaction(tx => tx.putSession({
    runId: 'existing', addressId: 'worker', revision: 1, state: 'running', process: identity,
    activity: { type: 'implement', project: 'projects/raf', features: ['fixture'], phase: 'implement', cwd: root },
  }));
  let ports: Awaited<ReturnType<typeof createServicePorts>> | undefined;
  t.after(async () => {
    if (!stopped) await ports?.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    createServicePorts,
    root, context, store, reminders, deps, settings, observed, delivered, scheduled, eventPending, eventDelivered,
    now: () => now,
    time: (value: number) => { now = value; },
    scan: (value: typeof scan) => { scan = value; },
    snapshot: (value: AdmissionSnapshot) => { snapshot = value; },
    resourceWake: async () => { assert.ok(resourceWake); await resourceWake(); },
    open: async () => { ports = await createServicePorts(context, deps); return ports; },
    stop: async () => { await ports?.shutdown(); stopped = true; },
  };
}

test('recovery leaves existing sessions and overdue reminders untouched', async t => {
  const f = await fixture(t);
  const reminder = f.reminders.add({ to: 'worker', at: new Date(f.now() - 1000).toISOString(), text: 'Finish existing work' });
  const before = f.store.sessionRepository.transaction(tx => tx.listSessions());
  const ports = await f.open();
  await ports.recover();
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), before);
  assert.deepEqual(f.reminders.list(), [reminder]);
  assert.deepEqual(f.delivered, []);
});

test('refresh and resource wake do not activate due reminders or prune closed ones', async t => {
  const f = await fixture(t);
  f.reminders.add({ to: 'worker', at: new Date(f.now() + 37_000).toISOString(), text: 'Due on next cycle' });
  f.store.reminderRepository.transaction(tx => tx.save({
    id: 'old-closed', createdFor: 'worker', assignedTo: 'worker', text: 'old', at: new Date(0).toISOString(),
    binding: null, state: 'closed', closedAt: new Date(f.now() - flow.retention.closedRemindersMs - 1).toISOString(), closeReason: 'done',
  }));
  const before = f.reminders.list();
  const ports = await f.open();
  await ports.recover();
  f.time(f.now() + 37_000);
  await ports.refresh();
  await f.resourceWake();
  assert.deepEqual(f.reminders.list(), before);
  assert.deepEqual(f.delivered, []);
});

test('service does not request process observations or change the persisted session', async t => {
  const f = await fixture(t);
  f.scan(async () => [{ state: 'unknown', observedAt: new Date(f.now()).toISOString(), error: 'tmux observation unavailable' }]);
  const before = f.store.sessionRepository.transaction(tx => tx.getSession('existing'));
  const ports = await f.open();
  await ports.recover();
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.getSession('existing')), before);
});

test('resource wait delegates shared admission queue and caller cancellation through host context', async t => {
  const f = await fixture(t);
  f.snapshot({ status: 'NO_RESOURCES', reason: 'Pressure measured' });
  const ports = await f.open();
  await ports.recover();
  const canceled = new AbortController();
  const waiting = ports.handle({ operation: 'resource.wait', payload: { level: 'normal' } }, { signal: canceled.signal, clientId: 'gone' });
  canceled.abort();
  const failure = await waiting as { exitCode: number };
  assert.notEqual(failure.exitCode, 0);
  f.snapshot({ status: 'ANY_RUN', reason: 'Recovered' });
  const permission = ports.handle({ operation: 'resource.wait', payload: { level: 'normal' } }, { signal: new AbortController().signal, clientId: 'live' });
  await f.resourceWake();
  const result = await permission as { exitCode: number; reservation: boolean };
  assert.equal(result.exitCode, 0);
  assert.equal(result.reservation, false);
});

test('service leaves pending events to the command-owned event registry', async t => {
  const f = await fixture(t);
  const fact = { key: 'event-one', event: { kind: 'agent.started', id: 'worker' } };
  f.eventPending.set(fact.key, fact);
  const ports = await f.open();
  await ports.recover();
  await ports.refresh();
  assert.deepEqual(f.eventDelivered, []);
  assert.deepEqual([...f.eventPending.values()], [fact]);
});

test('service never attempts reminder delivery, even when the transport is available', async t => {
  const f = await fixture(t);
  const reminder = f.reminders.add({ to: 'worker', at: new Date(f.now() - 1).toISOString(), text: 'Command will deliver' });
  let attempts = 0;
  f.deps.deliverReminder = async () => { attempts++; return { delivered: true }; };
  const ports = await f.open();
  await ports.recover();
  await ports.refresh();
  assert.equal(attempts, 0);
  assert.deepEqual(f.reminders.list(), [reminder]);
});

test('repeated recovery does not install duplicate monitors or fabricate agent starts', async t => {
  const f = await fixture(t);
  const ports = await f.open();
  await ports.recover();
  await ports.recover();
  assert.deepEqual(f.observed, []);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listSessions()).length, 1);
});

test('shutdown cancels monitors and waiters without closing agents or unfinished reminders', async t => {
  const f = await fixture(t);
  const reminder = f.reminders.add({ to: 'worker', at: new Date(f.now() + 100_000).toISOString(), text: 'Keep pending' });
  f.snapshot({ status: 'NO_RESOURCES', reason: 'Busy' });
  const ports = await f.open();
  await ports.recover();
  const waiting = ports.handle({ operation: 'resource.wait', payload: { level: 'normal' } }, { signal: new AbortController().signal, clientId: 'pending' });
  await f.stop();
  assert.notEqual((await waiting as { exitCode: number }).exitCode, 0);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.reminders.list().find(item => item.id === reminder.id)?.state, 'pending');
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession('existing'))?.state, 'running');
});

test('default production ports recover and shut down while incomplete explicit dependencies are rejected', async t => {
  const f = await fixture(t);
  const ports = await f.createServicePorts(f.context);
  try {
    await ports.recover({ serviceEpoch: 's1-default-host' });
    await assert.rejects(ports.handle({ operation: 'reminder.list', payload: {} }, { clientId: 'default-host', signal: new AbortController().signal }), /unsupported.*operation/i);
  } finally { await ports.shutdown(); }
  await assert.rejects(f.createServicePorts(f.context, {} as ServiceHostDependencies), /dependenc|port|delivery|оброб|порт/i);
});

test('missing configured host cadence is rejected instead of introducing a hidden default', async t => {
  const f = await fixture(t);
  delete f.settings.service.hostTickIntervalMs;
  await writeFile(join(f.root, 'conf', 'raf.json'), JSON.stringify(f.settings));
  await assert.rejects(f.createServicePorts(f.context, f.deps), /hostTickIntervalMs/);
});
