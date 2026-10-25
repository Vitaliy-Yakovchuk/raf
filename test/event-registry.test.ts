import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createArchiveObserver, createEventRegistry, type ArchiveSnapshot, type EventCatalog, type EventRegistryPorts, type PendingEvent } from '../src/event-registry.ts';
import { validateEventObjectId } from '../src/event-catalog.ts';
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
  let failure: 'save' | 'apply' | 'commit' | null = null;
  let transactions = 0;
  const validations: [string, string][] = [];
  const ports: EventRegistryPorts = {
    validateId(kind, id) {
      validations.push([kind, id]);
      return validateEventObjectId(kind, id);
    },
    transaction(operation) {
      transactions++;
      const beforePending = structuredClone([...pending]);
      const beforeReminders = structuredClone(reminders);
      try {
        const result = operation({
          listPending: () => [...pending.values()],
          savePending: fact => {
            if (failure === 'save') throw new Error('Pending save failed');
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
            if (failure === 'apply') throw new Error('Reminder apply failed');
            return 'delivered';
          },
        });
        if (failure === 'commit') throw new Error('Transaction commit failed');
        return result;
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
    fail: (value: typeof failure) => { failure = value; },
  };
}

const fact: PendingEvent = { key: 'run-1:closed', event: { kind: 'agent.closed', id: 'worker' } };

test('every approved event delegates its ID kind to the canonical validator', () => {
  const f = registryFixture();
  assert.equal(constants.events.find(entry => entry.id === 'agent.report-rejected')?.idKind, 'agentAddress');
  f.registry.validate({ kind: 'agent.report-rejected', id: 'worker' });
  assert.deepEqual(f.validations.at(-1), ['agentAddress', 'worker']);
  const examples: Record<string, string> = { agentAddress: 'worker', reminderId: 'reminder-1', changeId: 'add-reminders', deploymentId: 'deployment-1', contextReviewId: '79ad8c20-4d8c-4f4c-bbb0-1f3cddc16b7a', resourceQueueId: '90ad8c20-4d8c-4f4c-bbb0-1f3cddc16b7a', rafInstanceId: '91ad8c20-4d8c-4f4c-bbb0-1f3cddc16b7a' };
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
    { kind: 'openspec.archived', id: 'archive/add-reminders' },
    { kind: 'agent.closed', id: '' },
    { kind: 'agent.closed', id: '%12' },
    { kind: 'agent.closed', id: ' worker' },
    { kind: 'agent.closed', id: 'worker\0other' },
    { kind: 'launch-queue.drained', id: 'worker' },
    { kind: 'raf.health-summary', id: 'worker' },
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

test('U2 archive date prefix is rejected by the registry using the canonical ID validator', () => {
  const f = registryFixture();
  assert.throws(() => f.registry.enqueue({
    key: 'invalid-archive-id',
    event: { kind: 'openspec.archived', id: '2026-10-22-add-reminders' },
  }), /Invalid .*event ID/);
  assert.equal(f.pending.size, 0);
  assert.equal(f.transactions(), 0);
});

test('U1 a stale stored event absent from the approved catalog cannot apply reminders', () => {
  const f = registryFixture();
  f.pending.set('legacy', { key: 'legacy', event: { kind: 'conductor.finished', id: 'worker' } });
  const before = structuredClone(f.reminders());
  assert.throws(() => f.registry.dispatch(), /Unknown event kind/);
  assert.deepEqual(f.reminders(), before);
  assert.equal(f.pending.size, 1);
});

test('U3 exact kind and object ID leave unrelated and already closed bindings unchanged', () => {
  const f = registryFixture();
  f.reminders().push(
    { ...f.reminders()[0], id: 'different-agent', objectId: 'worker-other' },
    { ...f.reminders()[1], id: 'different-kind', kind: 'agent.succeeded' },
    { ...f.reminders()[1], id: 'already-closed', state: 'closed', closedAt: '2026-10-20T10:00:00Z' },
  );
  const unrelated = structuredClone(f.reminders().slice(2));
  f.registry.enqueue(fact);
  assert.deepEqual(f.registry.dispatch(), { delivered: [fact.key], unresolved: [] });
  assert.deepEqual(f.reminders().slice(2), unrelated);
  assert.equal(f.reminders()[0].state, 'active');
  assert.equal(f.reminders()[1].state, 'closed');
});

test('U4 a pending key cannot be reassigned to a different kind or object ID', () => {
  const f = registryFixture();
  f.registry.enqueue(fact);
  for (const event of [
    { kind: 'agent.closed', id: 'other-worker' },
    { kind: 'agent.failed', id: 'worker' },
  ]) {
    assert.throws(() => f.registry.enqueue({ key: fact.key, event }), /Conflicting pending event key/);
    assert.deepEqual([...f.pending.values()], [fact]);
  }
  assert.deepEqual(f.reminders().map(row => row.state), ['pending', 'active']);
});

for (const stage of ['save', 'commit'] as const) {
  test(`U4 enqueue ${stage} failure does not acknowledge a fact and allows retry`, () => {
    const f = registryFixture();
    f.fail(stage);
    assert.throws(() => f.registry.enqueue(fact), /failed/);
    assert.equal(f.pending.size, 0);
    f.fail(null);
    f.registry.enqueue(fact);
    assert.deepEqual([...f.pending.values()], [fact]);
  });
}

for (const stage of ['apply', 'commit'] as const) {
  test(`U4 dispatch ${stage} failure restores reminders and pending until successful retry`, () => {
    const f = registryFixture();
    f.registry.enqueue(fact);
    const before = structuredClone(f.reminders());
    f.fail(stage);
    assert.throws(() => f.registry.dispatch(), /failed/);
    assert.deepEqual([...f.pending.values()], [fact]);
    assert.deepEqual(f.reminders(), before);
    f.fail(null);
    assert.deepEqual(f.registry.dispatch(), { delivered: [fact.key], unresolved: [] });
    assert.equal(f.pending.size, 0);
    assert.deepEqual(f.registry.dispatch(), { delivered: [], unresolved: [] });
  });
}

test('U5 report rejection uses explicit bindings without producing agent.closed', () => {
  const f = registryFixture();
  f.reminders().push(
    { ...f.reminders()[0], id: 'rejection-activate', kind: 'agent.report-rejected' },
    { ...f.reminders()[1], id: 'rejection-close', kind: 'agent.report-rejected' },
  );
  f.registry.enqueue({ key: 'rejected-report-snapshot', event: { kind: 'agent.report-rejected', id: 'worker' } });
  f.registry.dispatch();
  assert.deepEqual(f.reminders().map(row => row.state), ['pending', 'active', 'active', 'closed']);
  assert.equal(f.pending.size, 0);
});

test('U6 an initially unsuccessful archive needs confirmed success before emitting', async () => {
  const f = archiveFixture({ active: ['add-reminders'], archives: [] });
  assert.deepEqual(await f.observer.observe({ active: [], archives: [{ ...newArchive, successful: false }] }), []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(await f.observer.observe({ active: [], archives: [newArchive] }), [archivedEvent]);
});

test('U7 stripping the archive date preserves date components inside the exact change ID', async () => {
  const id = 'release-2025-01-02';
  const f = archiveFixture({ active: [id], archives: [] });
  assert.deepEqual(await f.observer.observe({ active: [], archives: [
    { name: `2026-10-25-${id}`, successful: true },
  ] }), [{ kind: 'openspec.archived', id }]);
});

test('U8 a partial emit failure retries only the remaining completion in a multi-change snapshot', async () => {
  const events: ReminderEvent[] = [];
  let fail = true;
  const observer = createArchiveObserver({ active: ['change-a', 'change-b'], archives: [] }, {
    emit: async event => {
      if (event.id === 'change-b' && fail) throw new Error('Pending storage unavailable');
      events.push(structuredClone(event));
    },
  });
  const completed = { active: [], archives: [
    { name: '2026-10-25-change-a', successful: true },
    { name: '2026-10-25-change-b', successful: true },
  ] };
  await assert.rejects(observer.observe(completed), /Pending storage unavailable/);
  assert.deepEqual(events, [{ kind: 'openspec.archived', id: 'change-a' }]);
  fail = false;
  assert.deepEqual(await observer.observe(completed), [{ kind: 'openspec.archived', id: 'change-b' }]);
  assert.deepEqual(await observer.observe(completed), []);
  assert.deepEqual(events, [
    { kind: 'openspec.archived', id: 'change-a' },
    { kind: 'openspec.archived', id: 'change-b' },
  ]);
});

test('U8 observers already queued during failed emission recover without duplicate success', async () => {
  const events: ReminderEvent[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  const observer = createArchiveObserver({ active: ['add-reminders'], archives: [] }, {
    emit: async event => {
      attempts++;
      if (attempts === 1) {
        entered.resolve();
        await release.promise;
        throw new Error('Pending storage unavailable');
      }
      events.push(structuredClone(event));
    },
  });
  const completed = { active: [], archives: [newArchive] };
  const first = observer.observe(completed);
  await entered.promise;
  const second = observer.observe(completed);
  const third = observer.observe(completed);
  const rejected = assert.rejects(first, /Pending storage unavailable/);
  release.resolve();
  await rejected;
  assert.deepEqual((await Promise.all([second, third])).flat(), [archivedEvent]);
  assert.equal(attempts, 2);
  assert.deepEqual(events, [archivedEvent]);
});
