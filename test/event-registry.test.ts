import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createArchiveObserver, createEventRegistry, type ArchiveSnapshot, type EventCatalog, type EventRegistryPorts, type PendingEvent } from '../src/event-registry.ts';
import type { ReminderEvent } from '../src/reminders.ts';

const constants: EventCatalog = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));

function registryFixture() {
  const pending = new Map<string, PendingEvent>();
  let reminders = [
    { id: 'activate', kind: 'agent.closed', objectId: 'worker', action: 'activate', state: 'pending', closedAt: null as string | null },
    { id: 'close', kind: 'agent.closed', objectId: 'worker', action: 'close', state: 'active', closedAt: null as string | null },
  ];
  let now = '2026-10-22T10:00:00Z';
  let available = true;
  let failDelete = false;
  let transactions = 0;
  const validations: [string, string][] = [];
  const ports: EventRegistryPorts = {
    validateId(kind, id) {
      validations.push([kind, id]);
      if (['agentAddress', 'reminderId', 'deploymentId'].includes(kind)) return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
      if (kind === 'changeId') return /^[a-z][a-z0-9-]*$/.test(id);
      return false;
    },
    transaction(operation) {
      transactions++;
      const beforePending = structuredClone([...pending]);
      const beforeReminders = structuredClone(reminders);
      try {
        return operation({
          listPending: () => [...pending.values()],
          savePending: fact => {
            const existing = pending.get(fact.key);
            if (existing && JSON.stringify(existing) !== JSON.stringify(fact)) throw new Error('Conflicting pending fact');
            pending.set(fact.key, structuredClone(fact));
          },
          deletePending: key => {
            if (failDelete) throw new Error('Commit failed');
            pending.delete(key);
          },
          applyReminderEvent: event => {
            if (!available) return 'unresolved';
            for (const row of reminders) {
              if (row.kind !== event.kind || row.objectId !== event.id || row.state === 'closed') continue;
              if (row.action === 'activate') row.state = 'active';
              else { row.state = 'closed'; row.closedAt = now; }
            }
            return 'delivered';
          },
        });
      } catch (error) {
        pending.clear();
        for (const [key, fact] of beforePending) pending.set(key, fact);
        reminders = beforeReminders;
        throw error;
      }
    },
  };
  return {
    registry: createEventRegistry(constants, ports), pending, validations,
    reminders: () => reminders,
    transactions: () => transactions,
    now: (value: string) => { now = value; },
    available: (value: boolean) => { available = value; },
    failDelete: (value: boolean) => { failDelete = value; },
  };
}

const fact: PendingEvent = { key: 'run-1:closed', event: { kind: 'agent.closed', id: 'worker' } };

test('every approved event delegates its ID kind to the canonical validator', () => {
  const f = registryFixture();
  const examples: Record<string, string> = { agentAddress: 'worker', reminderId: 'reminder-1', changeId: 'add-reminders', deploymentId: 'deployment-1' };
  for (const entry of constants.events) {
    const id = examples[entry.idKind];
    assert.ok(id);
    f.registry.validate({ kind: entry.id, id });
    assert.deepEqual(f.validations.at(-1), [entry.idKind, id]);
  }
  assert.equal(f.transactions(), 0);
});

test('unknown event kinds and incompatible IDs are rejected before creating pending state', () => {
  const f = registryFixture();
  for (const event of [
    { kind: 'conductor.finished', id: 'worker' },
    { kind: 'agent.closed', id: 'tmux/session/worker' },
    { kind: 'reminder.closed', id: ' ' },
    { kind: 'deployment.completed', id: '../deployment' },
    { kind: 'openspec.archived', id: '2026-10-22-add-reminders' },
    { kind: 'openspec.archived', id: 'archive/add-reminders' },
    { kind: 'agent.closed', id: '' },
  ]) assert.throws(() => f.registry.enqueue({ key: 'invalid', event }));
  assert.equal(f.pending.size, 0);
  assert.equal(f.transactions(), 0);
});

test('address validation does not depend on a currently running agent or prohibit reused names', () => {
  const f = registryFixture();
  f.registry.validate({ kind: 'agent.closed', id: 'previous-worker' });
  f.registry.validate({ kind: 'agent.started', id: 'previous-worker' });
  assert.equal(f.transactions(), 0);
});

test('duplicate pending delivery is atomic and explicit reminder actions control activation and closing', () => {
  const f = registryFixture();
  f.registry.enqueue(fact);
  f.registry.enqueue(fact);
  assert.equal(f.pending.size, 1);
  assert.deepEqual(f.registry.dispatch(), { delivered: [fact.key], unresolved: [] });
  assert.equal(f.reminders()[0].state, 'active');
  assert.equal(f.reminders()[1].state, 'closed');
  assert.equal(f.reminders()[1].closedAt, '2026-10-22T10:00:00Z');
  assert.equal(f.pending.size, 0);
  f.now('2026-10-23T10:00:00Z');
  f.registry.enqueue(fact);
  f.registry.dispatch();
  assert.equal(f.reminders()[1].closedAt, '2026-10-22T10:00:00Z');
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.registry.dispatch(), { delivered: [], unresolved: [] });
});

test('unresolved delivery stays pending and retries without retaining delivered event history', () => {
  const f = registryFixture();
  f.registry.enqueue(fact);
  f.available(false);
  assert.deepEqual(f.registry.dispatch(), { delivered: [], unresolved: [fact.key] });
  assert.equal(f.pending.size, 1);
  assert.equal(f.reminders()[1].closedAt, null);
  f.available(true);
  assert.deepEqual(f.registry.dispatch(), { delivered: [fact.key], unresolved: [] });
  assert.equal(f.pending.size, 0);
});

test('failure removing pending delivery rolls back reminder transition and allows retry', () => {
  const f = registryFixture();
  f.registry.enqueue(fact);
  f.failDelete(true);
  assert.throws(() => f.registry.dispatch(), /Commit failed/);
  assert.equal(f.pending.size, 1);
  assert.equal(f.reminders()[0].state, 'pending');
  assert.equal(f.reminders()[1].closedAt, null);
  f.failDelete(false);
  assert.deepEqual(f.registry.dispatch(), { delivered: [fact.key], unresolved: [] });
  assert.equal(f.pending.size, 0);
});

test('result or interruption events never implicitly become session closed events', () => {
  const f = registryFixture();
  for (const kind of ['agent.failed', 'agent.succeeded', 'agent.interrupted']) {
    f.registry.enqueue({ key: kind, event: { kind, id: 'worker' } });
    f.registry.dispatch();
  }
  assert.deepEqual(f.reminders().map(row => row.state), ['pending', 'active']);
});

const oldArchive = { name: '2026-10-21-add-reminders', successful: true };
const newArchive = { name: '2026-10-22-add-reminders', successful: true };
const archivedEvent = { kind: 'openspec.archived', id: 'add-reminders' };

function archiveFixture(initial: ArchiveSnapshot) {
  const events: ReminderEvent[] = [];
  let fail = false;
  const observer = createArchiveObserver(initial, { emit: async event => {
    if (fail) throw new Error('Pending storage unavailable');
    events.push(structuredClone(event));
  } });
  return { observer, events, fail: (value: boolean) => { fail = value; } };
}

test('startup archive baseline and unrelated new archives do not manufacture completion events', async () => {
  const f = archiveFixture({ active: [], archives: [oldArchive] });
  assert.deepEqual(f.events, []);
  assert.deepEqual(await f.observer.observe({ active: [], archives: [oldArchive] }), []);
  assert.deepEqual(await f.observer.observe({ active: [], archives: [oldArchive, newArchive] }), []);
  assert.deepEqual(f.events, []);
});

test('observed active change moving successfully to a new archive emits change ID without date once', async () => {
  const f = archiveFixture({ active: ['add-reminders'], archives: [oldArchive] });
  const completed = { active: [], archives: [oldArchive, newArchive] };
  assert.deepEqual(await f.observer.observe(completed), [archivedEvent]);
  assert.deepEqual(await f.observer.observe(completed), []);
  assert.deepEqual(f.events, [archivedEvent]);
});

test('failed or partial archiving and deletion without archive do not count as successful archive', async () => {
  const f = archiveFixture({ active: ['add-reminders'], archives: [oldArchive] });
  await f.observer.observe({ active: ['add-reminders'], archives: [oldArchive, newArchive] });
  await f.observer.observe({ active: [], archives: [oldArchive, { ...newArchive, successful: false }] });
  await f.observer.observe({ active: [], archives: [oldArchive] });
  assert.deepEqual(f.events, []);
});

test('same change name can complete a later observed active cycle without historical suppression', async () => {
  const f = archiveFixture({ active: ['add-reminders'], archives: [] });
  await f.observer.observe({ active: [], archives: [oldArchive] });
  await f.observer.observe({ active: ['add-reminders'], archives: [oldArchive] });
  await f.observer.observe({ active: [], archives: [oldArchive, newArchive] });
  assert.deepEqual(f.events, [archivedEvent, archivedEvent]);
});

test('new active observation with only an existing archive does not reuse the old completion', async () => {
  const f = archiveFixture({ active: [], archives: [oldArchive] });
  await f.observer.observe({ active: ['add-reminders'], archives: [oldArchive] });
  await f.observer.observe({ active: [], archives: [oldArchive] });
  assert.deepEqual(f.events, []);
});

test('archive identity is exact and path or suffix matches cannot close a different change', async () => {
  const f = archiveFixture({ active: ['add-reminders'], archives: [] });
  await f.observer.observe({ active: [], archives: [
    { name: '2026-10-22-prefix-add-reminders', successful: true },
    { name: 'archive/2026-10-22-add-reminders', successful: true },
  ] });
  assert.deepEqual(f.events, []);
});

test('failed emission keeps the archive transition retryable until current pending state is saved', async () => {
  const f = archiveFixture({ active: ['add-reminders'], archives: [] });
  const completed = { active: [], archives: [newArchive] };
  f.fail(true);
  await assert.rejects(f.observer.observe(completed), /Pending storage unavailable/);
  assert.deepEqual(f.events, []);
  f.fail(false);
  assert.deepEqual(await f.observer.observe(completed), [archivedEvent]);
  assert.deepEqual(await f.observer.observe(completed), []);
  assert.deepEqual(f.events, [archivedEvent]);
});

test('concurrent filesystem notifications emit one fact for a single successful archive transition', async () => {
  const f = archiveFixture({ active: ['add-reminders'], archives: [] });
  const completed = { active: [], archives: [newArchive] };
  const results = await Promise.all([
    f.observer.observe(completed),
    f.observer.observe(completed),
    f.observer.observe(completed),
  ]);
  assert.deepEqual(results.flat(), [archivedEvent]);
  assert.deepEqual(f.events, [archivedEvent]);
});
