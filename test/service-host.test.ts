import { pathToFileURL } from 'node:url';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import { ReminderService } from '../src/reminders.ts';
import { listStartupContextReviewEvents } from '../src/startup-context.ts';
import { CatalogGenerator } from '../src/catalog-generator.ts';
import { productionBindings } from '../src/production-bindings.ts';
import type { ServiceHostDependencies } from '../src/service-host.ts';
import type { AdmissionSnapshot } from '../src/resource-wait.ts';
import type { ProcessIdentity } from '../src/session-state.ts';

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
  await writeFile(join(root, 'conf', 'models.json'), await readFile(new URL('../../conf/models.json', import.meta.url)));
  await prepareProductionQaFixture(t, { root, home: homeDirectory }, async codeRoot => {
    new CatalogGenerator().build({ confDirectory: join(root, 'conf'), outputPath: join(codeRoot, 'dist', 'catalog.json'), bindings: productionBindings() });
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
  const deps: ServiceHostDependencies = {
    now: () => now,
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
    root, context, store, reminders, deps, settings, scheduled,
    now: () => now,
    time: (value: number) => { now = value; },
    snapshot: (value: AdmissionSnapshot) => { snapshot = value; },
    resourceWake: async () => { assert.ok(resourceWake); await resourceWake(); },
    open: async () => { ports = await createServicePorts(context, deps); return ports; },
    stop: async () => { await ports?.shutdown(); stopped = true; },
  };
}

test('recovery leaves the persisted session running and an overdue reminder pending', async t => {
  const f = await fixture(t);
  const reminder = {
    id: 'overdue-pending', createdFor: 'worker', assignedTo: 'worker', text: 'Finish existing work',
    at: new Date(f.now() - 1000).toISOString(), binding: null, state: 'pending' as const, closedAt: null, closeReason: null,
  };
  f.store.reminderRepository.transaction(tx => tx.save(reminder));
  const before = f.store.sessionRepository.transaction(tx => tx.getSession('existing'));
  const ports = await f.open();
  await ports.recover();
  const sessions = f.store.sessionRepository.transaction(tx => tx.listSessions());
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], before);
  assert.equal(sessions[0].process?.runnerSessionId, identity.runnerSessionId);
  assert.equal(sessions[0].state, 'running');
  assert.equal(f.reminders.list()[0].id, reminder.id);
  assert.equal(f.reminders.list()[0].state, 'pending');
  assert.equal(f.scheduled.size, 1);
  assert.ok(f.scheduled.has(f.now() + 37_000));
});

test('configured wake pumps the resource queue without activating reminders or pruning closed ones', async t => {
  const f = await fixture(t);
  const future = f.reminders.add({ to: 'worker', at: new Date(f.now() + 37_000).toISOString(), text: 'Due on next cycle' });
  const closed = {
    id: 'old-closed', createdFor: 'worker', assignedTo: 'worker', text: 'old', at: new Date(0).toISOString(),
    binding: null, state: 'closed' as const, closedAt: new Date(f.now() - flow.retention.closedRemindersMs - 1).toISOString(), closeReason: 'done',
  };
  f.store.reminderRepository.transaction(tx => tx.save(closed));
  const ports = await f.open();
  await ports.recover();
  assert.deepEqual(f.reminders.list().find(item => item.id === 'old-closed'), closed);
  assert.equal(f.reminders.list().find(item => item.id === future.id)?.state, 'pending');
  const next = f.now() + 37_000;
  const wake = f.scheduled.get(next);
  assert.ok(wake);
  f.scheduled.delete(next);
  f.time(next);
  await wake();
  assert.deepEqual(f.reminders.list().find(item => item.id === 'old-closed'), closed);
  assert.equal(f.reminders.list().find(item => item.id === future.id)?.state, 'pending');
  assert.equal(f.scheduled.size, 1);
});

test('recovery does not record a process observation on the persisted session', async t => {
  const f = await fixture(t);
  const ports = await f.open();
  await ports.recover();
  const session = f.store.sessionRepository.transaction(tx => tx.getSession('existing'));
  assert.equal(session?.result, undefined);
  assert.equal(session?.observation, undefined);
  assert.equal(session?.state, 'running');
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

test('reminder and event operations are rejected and a seeded pending event stays pending', async t => {
  const f = await fixture(t);
  const pending = { id: 'event-one', runId: 'existing', event: 'agent.started', payload: { kind: 'agent.started', id: 'worker' } };
  f.store.sessionRepository.transaction(tx => tx.putPending(pending));
  const ports = await f.open();
  await ports.recover();
  const client = { clientId: 'host-fixture', signal: new AbortController().signal };
  await assert.rejects(ports.handle({ operation: 'event.emit', payload: { kind: 'agent.started', id: 'worker' } }, client), /Unsupported service operation/);
  await assert.rejects(ports.handle({ operation: 'reminder.add', payload: { to: 'worker', at: new Date(f.now()).toISOString(), text: 'no' } }, client), /Unsupported service operation/);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listPending()), [pending]);
});

test('refresh leaves an overdue reminder pending instead of delivering or closing it', async t => {
  const f = await fixture(t);
  const reminder = {
    id: 'overdue-retry', createdFor: 'worker', assignedTo: 'worker', text: 'Must remain pending',
    at: new Date(f.now() - 1).toISOString(), binding: null, state: 'pending' as const, closedAt: null, closeReason: null,
  };
  f.store.reminderRepository.transaction(tx => tx.save(reminder));
  const before = f.reminders.list().find(item => item.id === reminder.id);
  const ports = await f.open();
  await ports.recover();
  await ports.refresh();
  assert.deepEqual(f.reminders.list().find(item => item.id === reminder.id), before);
  assert.equal(before?.state, 'pending');
  assert.equal(before?.closedAt, null);
});

test('repeated recovery does not install duplicate monitors or fabricate agent starts', async t => {
  const f = await fixture(t);
  const ports = await f.open();
  await ports.recover();
  await ports.recover();
  assert.equal(f.scheduled.size, 1);
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
    await ports.recover({ serviceEpoch: 'service-host-fixture-epoch' });
    await assert.rejects(ports.handle({ operation: 'reminder.list', payload: {} }, { clientId: 'default-host', signal: new AbortController().signal }), /Unsupported service operation/);
  } finally { await ports.shutdown(); }
  await assert.rejects(f.createServicePorts(f.context, {} as ServiceHostDependencies), /dependenc|port|delivery|оброб|порт/i);
});

test('missing configured host cadence is rejected instead of introducing a hidden default', async t => {
  const f = await fixture(t);
  delete f.settings.service.hostTickIntervalMs;
  await writeFile(join(f.root, 'conf', 'raf.json'), JSON.stringify(f.settings));
  await assert.rejects(f.createServicePorts(f.context, f.deps), /hostTickIntervalMs/);
});

function contextReviewDelivery(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.sessionRepository.transaction(tx => tx.putSession({ runId: 'main', addressId: 'main', revision: 1, state: 'running' }));
  const event = { id: '4aa902c5-ec60-44d2-8dd5-fb9e80146c1a', event: 'context-review.due', to: 'main',
    runIds: Array.from({ length: 20 }, (_, index) => `source-${index}`), createdAt: new Date(f.now()).toISOString() };
  listStartupContextReviewEvents(f.store.startupContextDatabase);
  f.store.startupContextDatabase.prepare('INSERT INTO startup_context_reviews(id, payload) VALUES (?, ?)').run(event.id, JSON.stringify(event));
  const pending = { id: event.id, runId: 'source-19', event: event.event, payload: { to: event.to, runIds: event.runIds } };
  const enqueue = () => f.store.sessionRepository.transaction(tx => { tx.deletePending(event.id); tx.putPending(pending); });
  enqueue();
  return { event, enqueue, delivery: () => (listStartupContextReviewEvents(f.store.startupContextDatabase)[0] as any).mainDelivery };
}

test('Z.433 service recovery leaves a pending context review undelivered across refresh and restart', async t => {
  const f = await fixture(t);
  const batch = contextReviewDelivery(f);
  const unrelated = { id: 'unrelated', runId: null, event: 'agent.started', payload: { kind: 'agent.started', id: 'worker' } };
  f.store.sessionRepository.transaction(tx => tx.putPending(unrelated));
  const beforeReview = JSON.stringify(listStartupContextReviewEvents(f.store.startupContextDatabase));
  const beforePending = f.store.sessionRepository.transaction(tx => tx.listPending());
  const host = await f.open();
  await host.recover();
  await host.refresh();
  batch.enqueue();
  await host.refresh();
  await host.shutdown();
  const restarted = await f.open();
  batch.enqueue();
  await restarted.recover();
  await restarted.refresh();
  assert.equal(JSON.stringify(listStartupContextReviewEvents(f.store.startupContextDatabase)), beforeReview);
  assert.equal(batch.delivery(), undefined);
  const pending = f.store.sessionRepository.transaction(tx => tx.listPending());
  assert.equal(pending.length, beforePending.length);
  assert.deepEqual(pending.find(row => row.id === batch.event.id), beforePending.find(row => row.id === batch.event.id));
  assert.deepEqual(pending.find(row => row.id === unrelated.id), unrelated);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession('main'))?.state, 'running');
});

test('Z.433 service recovery leaves a reviewer-bound context review without a delivery receipt', async t => {
  const f = await fixture(t);
  const batch = contextReviewDelivery(f);
  f.store.startupContextDatabase.prepare('UPDATE startup_context_reviews SET review_run_id=? WHERE id=?').run('raf-context-review-4aa9', batch.event.id);
  const beforeReview = JSON.stringify(listStartupContextReviewEvents(f.store.startupContextDatabase));
  const beforePending = f.store.sessionRepository.transaction(tx => tx.listPending());
  const host = await f.open();
  await host.recover();
  await host.refresh();
  assert.equal(JSON.stringify(listStartupContextReviewEvents(f.store.startupContextDatabase)), beforeReview);
  assert.equal(batch.delivery(), undefined);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listPending()), beforePending);
});
