import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import { ReminderService } from '../src/reminders.ts';
import { createProductionServiceDependencies } from '../src/production-service-ports.ts';
import { createServicePorts } from '../src/service-host.ts';
import { validateEventId } from '../src/event-catalog.ts';
import type { AdmissionSnapshot } from '../src/resource-wait.ts';

const forbiddenDependency = ['reconcileLaunches', 'nextReminderId', 'observeProcesses', 'effectsForObservation', 'eventPorts', 'deliverReminder'] as const;

test('service modules keep only the resource queue and bug sync', async () => {
  const host = await readFile(new URL('../src/service-host.ts', import.meta.url), 'utf8');
  const ports = await readFile(new URL('../src/production-service-ports.ts', import.meta.url), 'utf8');
  const catalog = await readFile(new URL('../src/event-catalog.ts', import.meta.url), 'utf8');
  for (const token of ['reminder.add', 'reminder.list', 'event.emit', 'activateDue', 'pruneClosed', 'deliverReminder', 'reconcileLaunches', 'nextReminderId', 'effectsForObservation', 'eventPorts']) {
    assert.equal(host.includes(token), false, `service-host still contains ${token}`);
  }
  for (const token of ['deliverReminder', 'effectsForObservation', 'eventPorts', 'nextReminderId', 'validateEventObjectId']) {
    assert.equal(ports.includes(token), false, `production-service-ports still contains ${token}`);
  }
  assert.match(ports, /startBugSyncService/);
  assert.match(catalog, /export function validateEventId\(/);
  assert.equal(typeof validateEventId, 'function');
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-service-resource-'));
  const homeDirectory = join(root, 'home');
  const stateDirectory = join(homeDirectory, '.raf');
  await mkdir(join(root, 'conf'), { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  settings.service = { ...settings.service, hostTickIntervalMs: 37_000 };
  const constants = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  await Promise.all([
    writeFile(join(root, 'conf', 'raf.json'), JSON.stringify(settings)),
    writeFile(join(root, 'conf', 'raf-constants.json'), JSON.stringify(constants)),
    writeFile(join(root, 'conf', 'flow.json'), await readFile(new URL('../../conf/flow.json', import.meta.url))),
  ]);
  const context = { orchestratorRoot: root, homeDirectory, stateDirectory, socketPath: join(stateDirectory, 'service.sock') };
  const store = openStateStore(join(stateDirectory, settings.state.fileName));
  let now = Date.parse('2026-10-22T12:00:00.000Z');
  let lastGrant: number | null = null;
  let resourceWake: (() => Promise<void>) | undefined;
  let snapshot: AdmissionSnapshot = { status: 'ANY_RUN', reason: 'Injected admission observation' };
  const scheduled = new Map<number, () => Promise<void>>();
  const deps = {
    now: () => now,
    nextReminderId: () => 'legacy-reminder-id',
    reconcileLaunches: async () => [],
    observeProcesses: async (identities: readonly { pid: number }[]) => identities.map(identity => ({ state: 'alive' as const, observedAt: new Date(now).toISOString(), identity })),
    effectsForObservation: () => ({ pending: [], domain: [] }),
    sessionValidation: { verifyMainAuthority: () => false, verifyWorkResult: () => false },
    eventPorts: () => ({
      validateId: () => true,
      transaction: (operation: (tx: { listPending: () => never[]; savePending: () => void; deletePending: () => void; applyReminderEvent: () => 'delivered' }) => unknown) => operation({
        listPending: () => [], savePending: () => {}, deletePending: () => {}, applyReminderEvent: () => 'delivered' as const,
      }),
    }),
    deliverReminder: async () => ({ delivered: true }),
    resourceWait: {
      readSnapshot: async () => snapshot,
      isClientAlive: () => true,
      watchResources: (wake: () => Promise<void>) => { resourceWake = wake; return () => { resourceWake = undefined; }; },
      schedule: (at: number, wake: () => Promise<void>) => { scheduled.set(at, wake); return () => { scheduled.delete(at); }; },
      loadLastGrant: () => lastGrant,
      saveLastGrant: (at: number) => { lastGrant = at; },
    },
    schedule: (at: number, wake: () => Promise<void>) => { scheduled.set(at, wake); return () => { scheduled.delete(at); }; },
  };
  const reminders = new ReminderService({ repository: store.reminderRepository, now: () => new Date(now).toISOString(), nextId: () => 'seed-reminder', approvedEventKinds: constants.events.map((event: { id: string }) => event.id) });
  store.sessionRepository.transaction(tx => tx.putSession({
    runId: 'existing', addressId: 'worker', revision: 1, state: 'running',
    process: { pid: 42, startedAt: '2026-10-22T00:00:00.000Z', runner: 'fixture', runnerSessionId: 'session-one', tmuxSession: 'owned-fixture', evidence: { source: 'fixture' } },
    activity: { type: 'implement', project: 'projects/raf', features: ['fixture'], phase: 'implement', cwd: root },
  }));
  const beforeSession = store.sessionRepository.transaction(tx => tx.getSession('existing'));
  let ports: Awaited<ReturnType<typeof createServicePorts>> | undefined;
  t.after(async () => {
    await ports?.shutdown().catch(() => {});
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    context, store, reminders, deps, beforeSession, scheduled,
    open: async () => { ports = await createServicePorts(context, deps); return ports; },
    resourceWake: async () => { assert.ok(resourceWake); await resourceWake(); },
  };
}

test('service recovery does not change sessions or reminders and rejects reminder and event operations', async t => {
  const f = await fixture(t);
  const reminder = {
    id: 'seed-overdue', createdFor: 'worker', assignedTo: 'worker', text: 'Must stay untouched by the service',
    at: new Date(Date.parse('2026-10-22T11:00:00.000Z')).toISOString(), binding: null, state: 'pending' as const, closedAt: null, closeReason: null,
  };
  f.store.reminderRepository.transaction(tx => tx.save(reminder));
  const beforeReminder = f.reminders.list().find(item => item.id === reminder.id);
  const ports = await f.open();
  await ports.recover();
  await ports.refresh();
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.getSession('existing')), f.beforeSession);
  assert.deepEqual(f.reminders.list().find(item => item.id === reminder.id), beforeReminder);
  assert.equal(beforeReminder?.state, 'pending');
  const client = { clientId: 'resource-only', signal: new AbortController().signal };
  await assert.rejects(ports.handle({ operation: 'reminder.add', payload: { to: 'worker', at: beforeReminder?.at, text: 'no' } }, client), /Unsupported service operation/);
  await assert.rejects(ports.handle({ operation: 'event.emit', payload: { kind: 'agent.started', id: 'worker' } }, client), /Unsupported service operation/);
  const waiting = ports.handle({ operation: 'resource.wait', payload: { level: 'normal' } }, client);
  await f.resourceWake();
  const result = await waiting as { exitCode: number; reservation: boolean };
  assert.equal(result.exitCode, 0);
  assert.equal(result.reservation, false);
  assert.equal(f.scheduled.size, 1);
});

test('production service dependencies expose the resource queue and not reminder or session operations', async t => {
  const f = await fixture(t);
  const dependencies = await createProductionServiceDependencies(f.context);
  for (const key of forbiddenDependency) assert.equal(Object.hasOwn(dependencies, key), false, key);
  for (const key of ['readSnapshot', 'isClientAlive', 'watchResources', 'schedule', 'loadLastGrant', 'saveLastGrant'] as const) assert.equal(typeof dependencies.resourceWait[key], 'function', key);
  assert.equal(typeof dependencies.now, 'function');
  assert.equal(typeof dependencies.schedule, 'function');
});
