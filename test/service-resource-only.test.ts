import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import { openStateStore } from '../src/state-store.ts';
import { ReminderService } from '../src/reminders.ts';
import { validateEventId } from '../src/event-catalog.ts';
import type { ServiceHostDependencies } from '../src/service-host.ts';

const forbiddenDependencies = [
  'reconcileLaunches', 'observeProcesses', 'effectsForObservation', 'sessionValidation',
  'eventPorts', 'deliverReminder', 'nextReminderId', 'deliverStartupContextEvent', 'preserveSessionState',
];
const at = Date.parse('2026-10-22T12:00:00.000Z');
const identity = { pid: 42, startedAt: new Date(at).toISOString(), runner: 'fixture', runnerSessionId: 'original-native', tmuxSession: 'original-tmux', evidence: { source: 'fixture' } };

async function fixture(t: TestContext, production = false) {
  const root = await mkdtemp(join(tmpdir(), 'raf-s1-resource-only-'));
  const homeDirectory = join(root, 'home');
  const stateDirectory = join(homeDirectory, '.raf');
  await mkdir(join(root, 'conf'), { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  for (const name of ['raf.json', 'raf-constants.json', 'projects.json', 'flow.json']) {
    await writeFile(join(root, 'conf', name), await readFile(new URL(`../../conf/${name}`, import.meta.url)));
  }
  await prepareProductionQaFixture(t, { root, home: homeDirectory }, async codeRoot => {
    await mkdir(join(codeRoot, 'dist'), { recursive: true });
    await writeFile(join(codeRoot, 'dist', 'catalog.json'), await readFile(new URL('../dist/catalog.json', import.meta.url)));
  });
  const context = { orchestratorRoot: root, homeDirectory, stateDirectory, socketPath: join(stateDirectory, 'service.sock') };
  const settings = JSON.parse(await readFile(join(root, 'conf', 'raf.json'), 'utf8'));
  const constants = JSON.parse(await readFile(join(root, 'conf', 'raf-constants.json'), 'utf8'));
  const flow = JSON.parse(await readFile(join(root, 'conf', 'flow.json'), 'utf8'));
  const host: typeof import('../src/service-host.ts') = await import(pathToFileURL(join(root, 'raf-develop/src/service-host.ts')).href);
  const factory: typeof import('../src/production-service-ports.ts') = await import(pathToFileURL(join(root, 'raf-develop/src/production-service-ports.ts')).href);
  const store = openStateStore(join(stateDirectory, settings.state.fileName));
  let now = at;
  let sequence = 0;
  let lastGrant: number | null = null;
  const calls: string[] = [];
  const timers = new Set<{ at: number; wake: () => Promise<void> }>();
  const schedule = (deadline: number, wake: () => Promise<void>) => {
    const timer = { at: deadline, wake };
    timers.add(timer);
    return () => { timers.delete(timer); };
  };
  const legacy = {
    now: () => now, schedule,
    nextReminderId: () => `unexpected-${++sequence}`,
    observeProcesses: async (identities: readonly typeof identity[]) => { calls.push('observeProcesses'); return identities.map(() => ({ state: 'exited' as const, observedAt: new Date(now).toISOString(), exitCode: 1, evidence: 'fixture exit' })); },
    effectsForObservation: () => { calls.push('effectsForObservation'); return { pending: [], domain: [] }; },
    sessionValidation: { verifyMainAuthority: () => false, verifyWorkResult: () => false },
    eventPorts: () => ({ transaction: (operation: any) => store.eventRepository.transaction(operation), validateId: () => true }),
    deliverReminder: async () => { calls.push('deliverReminder'); return { delivered: true }; },
    resourceWait: {
      readSnapshot: async () => ({ status: 'ANY_RUN' as const, reason: 'fixture capacity' }),
      isClientAlive: () => true, watchResources: () => () => {}, schedule,
      loadLastGrant: () => lastGrant, saveLastGrant: (value: number) => { lastGrant = value; },
    },
  };
  const dependencies: ServiceHostDependencies = production
    ? await factory.createProductionServiceDependencies(context, { now: () => now, schedule })
    : legacy;
  const reminders = new ReminderService({ repository: store.reminderRepository, now: () => new Date(now).toISOString(), nextId: () => `seed-${++sequence}`, approvedEventKinds: constants.events.map((event: { id: string }) => event.id) });
  store.sessionRepository.transaction(tx => {
    for (const state of ['running', 'exited'] as const) tx.putSession({
      runId: state, addressId: `worker-${state}`, revision: 1, state, process: identity,
      activity: { type: 'implement', project: 'raf', features: ['fixture'], phase: 'implement', cwd: root },
      ...(state === 'exited' ? { observation: { state: 'exited' as const, observedAt: new Date(at).toISOString(), exitCode: 1, evidence: 'persisted exit' } } : {}),
    });
  });
  reminders.add({ to: 'worker-running', at: new Date(at - 1).toISOString(), text: 'Already due' });
  reminders.add({ to: 'worker-running', at: new Date(at + settings.service.hostTickIntervalMs).toISOString(), text: 'Due after wake' });
  reminders.add({ to: 'worker-running', at: new Date(at + 60000).toISOString(), text: 'Bound to pending event', binding: { kind: 'agent.failed', id: 'worker-running', action: 'activate' } });
  store.reminderRepository.transaction(tx => tx.save({ id: 'retained-closed', createdFor: 'worker-running', assignedTo: 'worker-running', text: 'Retention belongs to commands', at: new Date(0).toISOString(), binding: null, state: 'closed', closedAt: new Date(at - flow.retention.closedRemindersMs - 1).toISOString(), closeReason: 'done' }));
  store.eventRepository.transaction(tx => tx.savePending({ key: 'pending-agent-event', event: { kind: 'agent.failed', id: 'worker-running' } }));
  const snapshot = () => ({
    sessions: store.sessionRepository.transaction(tx => tx.listSessions(), 'read'),
    reservations: store.sessionRepository.transaction(tx => tx.listReservations(), 'read'),
    pending: store.sessionRepository.transaction(tx => tx.listPending(), 'read'),
    reminders: store.reminderRepository.transaction(tx => tx.list()),
    events: store.eventRepository.transaction(tx => tx.listPending()),
  });
  let ports: Awaited<ReturnType<typeof host.createServicePorts>> | undefined;
  t.after(async () => { await ports?.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { context, factory, dependencies, calls, timers, snapshot, settings,
    time: (value: number) => { now = value; },
    open: async () => { ports = await host.createServicePorts(context, dependencies); return ports; },
  };
}

test('S1: host dependency API contains no session, event or reminder operations', async () => {
  const source = ts.createSourceFile('service-host.ts', await readFile(new URL('../src/service-host.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'ServiceHostDependencies');
  assert.ok(declaration && ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type));
  const names = declaration.type.members.map(member => member.name?.getText(source));
  assert.deepEqual(names.filter(name => forbiddenDependencies.includes(name ?? '')), []);
});

test('S1: production dependencies expose only permitted resource and lifecycle seams', async t => {
  const f = await fixture(t, true);
  assert.deepEqual(Object.keys(f.dependencies).filter(name => forbiddenDependencies.includes(name)), []);
  assert.equal(typeof f.dependencies.now, 'function');
  assert.equal(typeof f.dependencies.schedule, 'function');
  assert.equal(typeof f.dependencies.resourceWait.readSnapshot, 'function');
});

for (const production of [false, true]) {
  const label = production ? 'production composition' : 'injected host';
  test(`S1: ${label} preserves sessions, reminders and pending events across recover, refresh, wake and shutdown`, async t => {
    const f = await fixture(t, production);
    const before = f.snapshot();
    const ports = await f.open();
    await ports.recover();
    assert.deepEqual(f.snapshot(), before, 'recover must leave command-owned state untouched');
    await ports.refresh();
    assert.deepEqual(f.snapshot(), before, 'refresh must leave command-owned state untouched');
    f.time(at + f.settings.service.hostTickIntervalMs);
    for (const timer of [...f.timers]) { f.timers.delete(timer); await timer.wake(); }
    assert.deepEqual(f.snapshot(), before, 'wake must not activate/prune/deliver or reconcile');
    await ports.shutdown();
    assert.deepEqual(f.snapshot(), before, 'shutdown must preserve persisted state');
    assert.deepEqual(f.calls, [], 'host must not call legacy process or reminder hooks');
  });
}

const payloads: Record<string, object> = {
  'reminder.add': { to: 'worker-running', at: new Date(at).toISOString(), text: 'Forbidden service write' },
  'reminder.list': {}, 'reminder.update': { id: 'seed-1', patch: { text: 'Changed' } },
  'reminder.activate': { id: 'seed-1' }, 'reminder.close': { id: 'seed-1', reason: 'done' },
  'reminder.reassign': { id: 'seed-1', to: 'worker-exited' },
  'reminder.close-all': { createdFor: 'worker-running', reason: 'done' },
  'event.emit': { key: 'forbidden-service-event', event: { kind: 'agent.failed', id: 'worker-running' } },
};
for (const [operation, payload] of Object.entries(payloads)) {
  test(`S1: host rejects ${operation} without changing persisted command state`, async t => {
    const f = await fixture(t);
    const ports = await f.open();
    await ports.recover();
    const before = f.snapshot();
    await assert.rejects(ports.handle({ operation, payload }, { clientId: 'fixture', signal: new AbortController().signal }), /unsupported.*operation/i);
    assert.deepEqual(f.snapshot(), before);
  });
}

test('S1: resource wait still grants admission without creating session reservations', async t => {
  const f = await fixture(t);
  const ports = await f.open();
  await ports.recover();
  const before = f.snapshot();
  const result = await ports.handle({ operation: 'resource.wait', payload: { level: 'normal' } }, { clientId: 'fixture', signal: new AbortController().signal });
  assert.equal((result as { exitCode: number }).exitCode, 0);
  assert.deepEqual(f.snapshot(), before);
});

test('S1: event ID validation remains available directly from event-catalog', () => {
  const catalog = { events: [{ id: 'agent.failed', idKind: 'agentAddress', description: 'Failed' }], eventIdKinds: { agentAddress: 'Address' } };
  assert.equal(validateEventId(catalog, 'agent.failed', 'worker-running'), true);
  assert.equal(validateEventId(catalog, 'agent.failed', 'bad/address'), false);
  assert.equal(validateEventId(catalog, 'unknown.event', 'worker-running'), false);
});

test('S1: a resource-only host does not require legacy session or reminder dependencies', async t => {
  const f = await fixture(t);
  for (const name of forbiddenDependencies) delete (f.dependencies as Record<string, unknown>)[name];
  const before = f.snapshot();
  const ports = await f.open();
  await ports.recover();
  assert.deepEqual(f.snapshot(), before);
});
