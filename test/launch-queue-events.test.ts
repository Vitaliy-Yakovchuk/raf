import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { loadEventCatalog, validateEventId, validateEventObjectId } from '../src/event-catalog.ts';
import { createEventRegistry } from '../src/event-registry.ts';
import type { EventCatalog, PendingEvent } from '../src/event-registry.ts';
import { ReminderService } from '../src/reminders.ts';
import type { Reminder, ReminderBinding, ReminderEvent, ReminderTransaction } from '../src/reminders.ts';
import { LaunchQueueEvents } from '../src/launch-queue-events.ts';
import type {
  LaunchQueueDrainedFact,
  LaunchQueueFailure,
  LaunchQueueHandle,
  LaunchQueueIdentity,
  LaunchQueueState,
  LaunchQueueTransaction,
} from '../src/launch-queue-events.ts';

const queueA = 'a0000000-0000-4000-8000-000000000001';
const queueB = 'b0000000-0000-4000-8000-000000000002';
const eventKind = 'launch-queue.drained';
const eventDescription = 'Покоління черги запусків машини спорожніло незалежно від результатів запусків';
const idDescription = 'Стабільний ID черги запусків машини в оперативному state-домені raf';
const identity: LaunchQueueIdentity = { stateDomain: '/isolated/control', machineId: 'machine-a' };
const prospectiveCatalog: EventCatalog = {
  events: [
    { id: eventKind, idKind: 'resourceQueueId', description: eventDescription },
    { id: 'reminder.activated', idKind: 'reminderId', description: 'Нагадування активоване' },
    { id: 'reminder.closed', idKind: 'reminderId', description: 'Нагадування закрите' },
  ],
  eventIdKinds: { resourceQueueId: idDescription, reminderId: 'ID нагадування raf' },
};

function memoryDatabase() {
  const database = {
    queues: new Map<string, LaunchQueueState>(),
    pending: new Map<string, PendingEvent>(),
    reminders: new Map<string, Reminder>(),
    applications: [] as ReminderEvent[],
    at: '2030-01-01T00:00:00.000Z',
    writes: [] as { queues: Map<string, LaunchQueueState>; pending: Map<string, PendingEvent> }[],
    failSavePending: false,
    failSaveQueue: false,
    failApply: false,
    sequence: 0,
  };
  const key = (id: LaunchQueueIdentity) => JSON.stringify([id.stateDomain, id.machineId]);
  let reminders: ReminderService | undefined;
  const transaction = <T>(operation: (tx: LaunchQueueTransaction) => T): T => {
    const queues = structuredClone(database.queues);
    const pending = structuredClone(database.pending);
    const reminderRows = structuredClone(database.reminders);
    const applicationCount = database.applications.length;
    try {
      const result = operation({
        loadQueue: id => structuredClone(database.queues.get(key(id))),
        saveQueue: (id, state) => {
          if (database.failSaveQueue) throw new Error('mock queue write failure');
          database.queues.set(key(id), structuredClone(state));
        },
        listPending: () => structuredClone([...database.pending.values()]),
        savePending: fact => {
          if (database.failSavePending) throw new Error('mock pending write failure');
          database.pending.set(fact.key, structuredClone(fact));
        },
        deletePending: factKey => { database.pending.delete(factKey); },
        applyReminderEvent: event => {
          if (database.failApply) return 'unresolved';
          if (!reminders) throw new Error('mock reminder repository is not attached');
          database.applications.push(structuredClone(event));
          reminders.applyEvent(event);
          return 'delivered';
        },
      });
      database.writes.push({ queues: structuredClone(database.queues), pending: structuredClone(database.pending) });
      return result;
    } catch (error) {
      database.queues = queues;
      database.pending = pending;
      database.reminders = reminderRows;
      database.applications.length = applicationCount;
      throw error;
    }
  };
  const connect = (id = identity) => new LaunchQueueEvents({
    identity: id,
    nextQueueId: () => ++database.sequence === 1 ? queueA : queueB,
    transaction,
  });
  const attachReminders = () => {
    let sequence = 0;
    reminders = new ReminderService({
      now: () => database.at,
      nextId: () => `reminder-${++sequence}`,
      approvedEventKinds: prospectiveCatalog.events.map(event => event.id),
      repository: {
        transaction: <T>(operation: (tx: ReminderTransaction) => T): T => operation({
          get: id => structuredClone(database.reminders.get(id)),
          list: () => structuredClone([...database.reminders.values()]),
          save: reminder => { database.reminders.set(reminder.id, structuredClone(reminder)); },
          remove: id => { database.reminders.delete(id); },
          session: () => ({ active: true }),
          emit: () => {},
        }),
      },
    });
    return reminders;
  };
  const registry = (queue: LaunchQueueEvents) => createEventRegistry(prospectiveCatalog, {
    transaction,
    validateId: (kind, id) => kind === 'resourceQueueId'
      ? queue.validateQueueId(id)
      : validateEventObjectId(kind, id),
  });
  return {
    database, connect, attachReminders, registry,
    state: (id = identity) => database.queues.get(key(id)),
    facts: () => [...database.pending.values()].filter(fact => fact.event.kind === eventKind) as LaunchQueueDrainedFact[],
  };
}

function enqueue(queue: LaunchQueueEvents, requestId = 'request-a', fence = 'fence-a'): LaunchQueueHandle {
  const handle = queue.record({ kind: 'agent-run', waited: true, requestId, fence });
  if (!handle) throw new Error('a queued agent must have a fenced generation handle');
  return handle;
}

function starting(queue: LaunchQueueEvents, handle: LaunchQueueHandle): void {
  queue.transition(handle, 'rechecking');
  queue.transition(handle, 'starting');
}

function ready(queue: LaunchQueueEvents, handle: LaunchQueueHandle): void {
  starting(queue, handle);
  queue.confirmReady(handle);
}

type Totals = { started: number; cancelled: number; failed: number };
type Outcome = 'ready' | LaunchQueueFailure;
const outcomes = ['ready', 'cancelled', 'client-died', 'launch-failed'] as const;

function totalsFor(outcome: Outcome): Totals {
  return {
    started: outcome === 'ready' ? 1 : 0,
    cancelled: outcome === 'cancelled' ? 1 : 0,
    failed: outcome === 'client-died' || outcome === 'launch-failed' ? 1 : 0,
  };
}

function finish(queue: LaunchQueueEvents, handle: LaunchQueueHandle, outcome: Outcome): void {
  if (outcome === 'ready') ready(queue, handle);
  else queue.fail(handle, outcome);
}

function assertCounters(state: LaunchQueueState | undefined, totals: Totals): void {
  assert.ok(state);
  assert.deepEqual(state, { ...state, ...totals });
}

function assertFact(fact: LaunchQueueDrainedFact, handle: LaunchQueueHandle, totals: Totals = { started: 1, cancelled: 0, failed: 0 }): void {
  assert.ok(fact);
  assert.deepEqual(fact.event, { kind: eventKind, id: handle.queueId });
  assert.deepEqual(fact.data, { queueId: handle.queueId, generation: handle.generation, ...totals });
  for (const value of Object.values(totals)) {
    assert.ok(Number.isSafeInteger(value));
    assert.ok(value >= 0);
  }
  assert.ok(totals.started + totals.cancelled + totals.failed > 0);
  assert.equal(typeof fact.key, 'string');
  assert.notEqual(fact.key, '');
}

test('queue-event: conf catalog contains the exact outcome-independent event and unchanged ID description', () => {
  const catalog = loadEventCatalog(resolve(import.meta.dirname, '../..'));
  assert.deepEqual(catalog.events.filter(event => event.id === eventKind), [
    { id: eventKind, idKind: 'resourceQueueId', description: eventDescription },
  ]);
  assert.equal(catalog.eventIdKinds.resourceQueueId, idDescription);
  assert.equal(validateEventId(catalog, eventKind, queueA), true);
});

test('queue-event: resourceQueueId accepts UUID syntax and rejects agent, run labels and malformed IDs', () => {
  assert.equal(validateEventObjectId('resourceQueueId', queueA), true);
  for (const invalid of ['', 'main', '%42', 'queue-generation-1', 'request-a', 'not-a-uuid', `${queueA}x`]) {
    assert.equal(validateEventObjectId('resourceQueueId', invalid), false, invalid);
  }
});

test('queue-event: queue identity is persisted once and survives command and service restart', () => {
  const fixture = memoryDatabase();
  const first = fixture.connect().queueId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(fixture.connect().queueId(), first);
  assert.equal(fixture.database.sequence, 1);
  assert.equal(fixture.state()?.queueId, first);
});

for (const other of [
  { stateDomain: '/isolated/other-control', machineId: identity.machineId },
  { stateDomain: identity.stateDomain, machineId: 'machine-b' },
]) {
  test(`queue-event: queue ID belongs to the current domain and machine ${JSON.stringify(other)}`, () => {
    const fixture = memoryDatabase();
    const local = fixture.connect();
    const localId = local.queueId();
    const foreignId = fixture.connect(other).queueId();
    assert.notEqual(localId, foreignId);
    assert.equal(local.validateQueueId(localId), true);
    assert.equal(local.validateQueueId(foreignId), false);
    assert.equal(local.validateQueueId('c0000000-0000-4000-8000-000000000003'), false);
    assert.equal(local.validateQueueId('main'), false);
  });
}

test('queue-event: initially empty state and command reconciliation never emit drained', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  queue.queueId();
  assert.deepEqual(fixture.facts(), []);
  fixture.connect().queueId();
  assert.deepEqual(fixture.facts(), []);
  assert.deepEqual(fixture.state()?.entries, []);
});

for (const input of [
  { kind: 'agent-run', waited: false },
  { kind: 'resource-wait', waited: true },
  { kind: 'test-run', waited: false },
] as const) {
  test(`queue-event: ${input.kind} waited=${input.waited} cannot start a generation`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const id = queue.queueId();
    assert.equal(queue.record({ ...input, requestId: 'outside', fence: 'outside-fence' }), null);
    assert.deepEqual(fixture.facts(), []);
    assert.deepEqual(fixture.state()?.entries, []);
    assert.equal(queue.queueId(), id);
  });
}

test('queue-event: waiting, permit/rechecking, reservation/starting retain the full unfinished set', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const handle = enqueue(queue);
  for (const stage of ['waiting', 'rechecking', 'starting'] as const) {
    queue.transition(handle, stage);
    assert.deepEqual(fixture.state()?.entries, [{ ...handle, stage }]);
    assertCounters(fixture.state(), { started: 0, cancelled: 0, failed: 0 });
    assert.deepEqual(fixture.facts(), []);
  }
  queue.confirmReady(handle);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], handle);
  assert.deepEqual(fixture.state()?.entries, []);
});

test('queue-event: a resource refusal after permit requeues the same request in the same generation', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const handle = enqueue(queue);
  queue.transition(handle, 'rechecking');
  queue.transition(handle, 'waiting');
  assert.deepEqual(enqueue(queue), handle);
  assert.equal(fixture.state()?.entries.length, 1);
  assertCounters(fixture.state(), { started: 0, cancelled: 0, failed: 0 });
  assert.deepEqual(fixture.facts(), []);
  ready(queue, handle);
  assert.equal(fixture.facts().length, 1);
});

test('queue-event: all queued starts must be confirmed, without waiting for their work to finish', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const a = enqueue(queue);
  const b = enqueue(queue, 'request-b', 'fence-b');
  assert.equal(a.generation, b.generation);
  ready(queue, a);
  assert.deepEqual(fixture.facts(), []);
  assert.deepEqual(fixture.state()?.entries.map(entry => entry.requestId), ['request-b']);
  ready(queue, b);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], b, { started: 2, cancelled: 0, failed: 0 });
});

test('queue-event: duplicate readiness and restarted reconciliation produce one pending fact', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const handle = enqueue(queue);
  ready(queue, handle);
  const first = structuredClone(fixture.facts());
  queue.confirmReady(handle);
  fixture.connect().confirmReady(handle);
  assert.deepEqual(fixture.facts(), first);
});

for (const reason of ['cancelled', 'client-died', 'launch-failed'] as const satisfies readonly LaunchQueueFailure[]) {
  test(`queue-event: nonlast ${reason} counts once and does not suppress the last readiness`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const failed = enqueue(queue);
    const survivor = enqueue(queue, 'request-b', 'fence-b');
    queue.fail(failed, reason);
    assertCounters(fixture.state(), totalsFor(reason));
    assert.deepEqual(fixture.facts(), []);
    assert.deepEqual(fixture.state()?.entries.map(entry => entry.requestId), ['request-b']);
    ready(queue, survivor);
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], survivor, { ...totalsFor(reason), started: 1 });
  });

  test(`queue-event: last ${reason} drains after an earlier confirmed start`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const started = enqueue(queue);
    const last = enqueue(queue, 'last', 'last-fence');
    ready(queue, started);
    assert.deepEqual(fixture.facts(), []);
    queue.fail(last, reason);
    assert.deepEqual(fixture.state()?.entries, []);
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], last, { ...totalsFor(reason), started: 1 });
  });
}

test('queue-event: mixed generation drains with started=1 cancelled=1 failed=2', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const cancelled = enqueue(queue, 'cancelled', 'cancelled-fence');
  const died = enqueue(queue, 'died', 'died-fence');
  const failed = enqueue(queue, 'failed', 'failed-fence');
  const started = enqueue(queue, 'started', 'started-fence');
  queue.fail(cancelled, 'cancelled');
  queue.fail(died, 'client-died');
  queue.fail(failed, 'launch-failed');
  assert.deepEqual(fixture.facts(), []);
  assertCounters(fixture.state(), { started: 0, cancelled: 1, failed: 2 });
  starting(queue, started);
  assert.deepEqual(fixture.facts(), []);
  queue.confirmReady(started);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], started, { started: 1, cancelled: 1, failed: 2 });
});

test('queue-event: counters survive restart after cancellation and failure while the survivor is starting', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const a = enqueue(queue);
  const b = enqueue(queue, 'request-b', 'fence-b');
  const c = enqueue(queue, 'request-c', 'fence-c');
  queue.fail(a, 'cancelled');
  queue.fail(b, 'client-died');
  starting(queue, c);
  const restarted = fixture.connect();
  assert.equal(restarted.queueId(), a.queueId);
  assertCounters(fixture.state(), { started: 0, cancelled: 1, failed: 1 });
  assert.deepEqual(fixture.facts(), []);
  restarted.confirmReady(c);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], c, { started: 1, cancelled: 1, failed: 1 });
});

test('queue-event: late client death of a ready record never reclassifies started before or after drain', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const a = enqueue(queue);
  const b = enqueue(queue, 'request-b', 'fence-b');
  ready(queue, a);
  fixture.connect().fail(a, 'client-died');
  assertCounters(fixture.state(), { started: 1, cancelled: 0, failed: 0 });
  assert.deepEqual(fixture.facts(), []);
  ready(queue, b);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], b, { started: 2, cancelled: 0, failed: 0 });
  const before = structuredClone(fixture.facts());
  fixture.connect().fail(a, 'client-died');
  fixture.connect().fail(b, 'client-died');
  assert.deepEqual(fixture.facts(), before);
  assertCounters(fixture.state(), { started: 2, cancelled: 0, failed: 0 });
});

for (const outcome of outcomes) {
  test(`queue-event: repeated ${outcome} and conflicting terminal outcomes count a fenced record once`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const first = enqueue(queue);
    const survivor = enqueue(queue, 'survivor', 'survivor-fence');
    finish(queue, first, outcome);
    finish(fixture.connect(), first, outcome);
    fixture.connect().confirmReady(first);
    for (const reason of ['cancelled', 'client-died', 'launch-failed'] as const) queue.fail(first, reason);
    assertCounters(fixture.state(), totalsFor(outcome));
    assert.deepEqual(fixture.facts(), []);
    ready(queue, survivor);
    const totals = { ...totalsFor(outcome), started: totalsFor(outcome).started + 1 };
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], survivor, totals);
    const before = structuredClone(fixture.facts());
    finish(fixture.connect(), first, outcome);
    assert.deepEqual(fixture.facts(), before);
    assertCounters(fixture.state(), totals);
  });
}

for (const operation of ['confirmReady', 'fail', 'transition'] as const) {
  test(`queue-event: stale fence cannot ${operation} a current launch record`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const handle = enqueue(queue);
    starting(queue, handle);
    const before = structuredClone(fixture.state());
    const stale = { ...handle, fence: 'stale-fence' };
    if (operation === 'confirmReady') queue.confirmReady(stale);
    if (operation === 'fail') {
      for (const reason of ['cancelled', 'client-died', 'launch-failed'] as const) queue.fail(stale, reason);
    }
    if (operation === 'transition') queue.transition(stale, 'waiting');
    assert.deepEqual(fixture.state(), before);
    assert.deepEqual(fixture.facts(), []);
    queue.confirmReady(handle);
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], handle);
  });
}

test('queue-event: old generation, foreign queue and unknown request readiness cannot drain new work', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const old = enqueue(queue);
  ready(queue, old);
  const current = enqueue(queue, old.requestId, 'new-fence');
  starting(queue, current);
  const before = structuredClone(fixture.state());
  const facts = structuredClone(fixture.facts());
  for (const stale of [old, { ...current, queueId: queueB }, { ...current, requestId: 'unknown' }]) {
    queue.confirmReady(stale);
    for (const reason of ['cancelled', 'client-died', 'launch-failed'] as const) queue.fail(stale, reason);
  }
  assert.deepEqual(fixture.state(), before);
  assert.deepEqual(fixture.facts(), facts);
  queue.confirmReady(current);
  assert.equal(fixture.facts().length, 2);
  assertFact(fixture.facts()[1], current);
});

for (const outcome of outcomes) {
  test(`queue-event: enqueue before last ${outcome} extends the same generation and its totals`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const a = enqueue(queue);
    starting(queue, a);
    const b = enqueue(fixture.connect(), 'request-b', 'fence-b');
    assert.equal(b.generation, a.generation);
    finish(queue, a, outcome);
    assertCounters(fixture.state(), totalsFor(outcome));
    assert.deepEqual(fixture.facts(), []);
    ready(queue, b);
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], b, { ...totalsFor(outcome), started: totalsFor(outcome).started + 1 });
  });

  test(`queue-event: enqueue after last ${outcome} resets counters without losing the prior pending fact`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const a = enqueue(queue);
    finish(queue, a, outcome);
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], a, totalsFor(outcome));
    const first = structuredClone(fixture.facts()[0]);
    const b = enqueue(fixture.connect(), 'request-b', 'fence-b');
    assert.ok(b.generation > a.generation);
    assert.equal(b.queueId, a.queueId);
    assertCounters(fixture.state(), { started: 0, cancelled: 0, failed: 0 });
    assert.deepEqual(fixture.facts(), [first]);
    ready(queue, b);
    const facts = fixture.facts();
    assert.equal(facts.length, 2);
    assert.deepEqual(facts[0], first);
    assert.notEqual(facts[0].key, facts[1].key);
    assertFact(facts[1], b);
  });
}

for (const reason of ['cancelled', 'client-died', 'launch-failed'] as const) {
  test(`queue-event: first terminal result wins the readiness versus ${reason} race`, () => {
    for (const failureFirst of [true, false]) {
      const fixture = memoryDatabase();
      const queue = fixture.connect();
      const handle = enqueue(queue);
      starting(queue, handle);
      if (failureFirst) queue.fail(handle, reason);
      queue.confirmReady(handle);
      if (!failureFirst) queue.fail(handle, reason);
      assert.equal(fixture.facts().length, 1);
      assertFact(fixture.facts()[0], handle, totalsFor(failureFirst ? reason : 'ready'));
    }
  });
}

for (const failure of ['failSavePending', 'failSaveQueue'] as const) {
  for (const outcome of outcomes) {
    test(`queue-event: ${failure} rolls back last ${outcome}, counters and pending together after restart`, () => {
      const fixture = memoryDatabase();
      const queue = fixture.connect();
      const cancelled = enqueue(queue, 'cancelled', 'cancel-fence');
      const failed = enqueue(queue, 'failed', 'failed-fence');
      const started = enqueue(queue, 'started', 'started-fence');
      const last = enqueue(queue, 'last', 'last-fence');
      queue.fail(cancelled, 'cancelled');
      queue.fail(failed, 'client-died');
      ready(queue, started);
      starting(queue, last);
      const before = structuredClone(fixture.state());
      assertCounters(before, { started: 1, cancelled: 1, failed: 1 });
      const restarted = fixture.connect();
      fixture.database[failure] = true;
      assert.throws(() => finish(restarted, last, outcome), /mock .* write failure/);
      assert.deepEqual(fixture.state(), before);
      assert.deepEqual(fixture.facts(), []);
      fixture.database[failure] = false;
      finish(fixture.connect(), last, outcome);
      const delta = totalsFor(outcome);
      const totals = { started: 1 + delta.started, cancelled: 1 + delta.cancelled, failed: 1 + delta.failed };
      assert.equal(fixture.facts().length, 1);
      assertFact(fixture.facts()[0], last, totals);
      assertCounters(fixture.state(), totals);
      const write = fixture.database.writes.at(-1)!;
      assert.equal([...write.queues.values()][0].entries.length, 0);
      assert.deepEqual([...write.pending.values()], fixture.facts());
    });
  }
}

test('queue-event: standalone resource wait and unqueued test never delay a queued agent drained fact', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const handle = enqueue(queue);
  for (const kind of ['resource-wait', 'test-run'] as const) {
    assert.equal(queue.record({ kind, waited: kind === 'resource-wait', requestId: kind, fence: kind }), null);
  }
  ready(queue, handle);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], handle);
  assert.deepEqual(fixture.state()?.entries, []);
});

test('queue-event: queued test retains the generation through permit and reservation until confirmed tree spawn', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const handle = queue.record({ kind: 'test-run', waited: true, requestId: 'test-request', fence: 'test-fence' });
  assert.ok(handle, 'a queued test must join the launch generation');
  for (const stage of ['waiting', 'rechecking', 'starting'] as const) {
    queue.transition(handle, stage);
    assert.deepEqual(fixture.state()?.entries, [{ ...handle, stage }]);
    assertCounters(fixture.state(), { started: 0, cancelled: 0, failed: 0 });
    assert.deepEqual(fixture.facts(), []);
  }
  queue.confirmReady(handle);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], handle);
  assert.deepEqual(fixture.state()?.entries, []);
});

test('queue-event: queued agent and test share counters and drain after the last confirmed spawn without completion', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const agent = enqueue(queue);
  const queuedTest = queue.record({ kind: 'test-run', waited: true, requestId: 'test-request', fence: 'test-fence' });
  assert.ok(queuedTest, 'the queued test must delay the shared drained fact');
  assert.equal(queuedTest.queueId, agent.queueId);
  assert.equal(queuedTest.generation, agent.generation);
  ready(queue, agent);
  assertCounters(fixture.state(), { started: 1, cancelled: 0, failed: 0 });
  assert.deepEqual(fixture.facts(), []);
  assert.deepEqual(fixture.state()?.entries.map(entry => entry.requestId), ['test-request']);
  ready(fixture.connect(), queuedTest);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], queuedTest, { started: 2, cancelled: 0, failed: 0 });
});

for (const reason of ['cancelled', 'client-died', 'launch-failed'] as const) {
  test(`queue-event: queued test ${reason} drains once with the corresponding terminal counter`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const agent = enqueue(queue);
    const queuedTest = queue.record({ kind: 'test-run', waited: true, requestId: 'test-request', fence: 'test-fence' });
    assert.ok(queuedTest, 'the queued test must be a tracked terminal obligation');
    ready(queue, agent);
    assert.deepEqual(fixture.facts(), []);
    const restarted = fixture.connect();
    restarted.fail(queuedTest, reason);
    restarted.fail(queuedTest, reason);
    restarted.confirmReady(queuedTest);
    const delta = totalsFor(reason);
    const totals = { started: 1, cancelled: delta.cancelled, failed: delta.failed };
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], queuedTest, totals);
    assertCounters(fixture.state(), totals);
    assert.deepEqual(fixture.state()?.entries, []);
  });
}

test('queue-event: queued test resource loss retains its identity and generation without counting a spawn', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const input = { kind: 'test-run', waited: true, requestId: 'test-request', fence: 'test-fence' } as const;
  const handle = queue.record(input);
  assert.ok(handle, 'a queued test must retain its fenced launch obligation');
  queue.transition(handle, 'rechecking');
  queue.transition(handle, 'waiting');
  assert.deepEqual(fixture.connect().record(input), handle);
  assert.equal(fixture.state()?.entries.length, 1);
  assertCounters(fixture.state(), { started: 0, cancelled: 0, failed: 0 });
  assert.deepEqual(fixture.facts(), []);
  ready(fixture.connect(), handle);
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], handle);
});

for (const action of ['activate', 'close'] as const) {
  for (const outcome of [...outcomes, 'mixed'] as const) {
    test(`queue-event: reminder add/update ${action} applies ${outcome} totals without a service`, () => {
      const fixture = memoryDatabase();
      const queue = fixture.connect();
      const service = fixture.attachReminders();
      const registry = fixture.registry(queue);
      const binding: ReminderBinding = { kind: eventKind, id: queue.queueId(), action };
      registry.validate(binding);
      const reminder = service.add({ to: 'main', at: '2030-02-01T00:00:00.000Z', text: 'Поставити нові задачі', binding });
      service.update(reminder.id, { binding });
      const handle = enqueue(queue);
      if (outcome === 'mixed') {
        const cancelled = enqueue(queue, 'cancelled', 'cancel-fence');
        const died = enqueue(queue, 'died', 'died-fence');
        const failed = enqueue(queue, 'failed', 'failed-fence');
        queue.fail(cancelled, 'cancelled');
        queue.fail(died, 'client-died');
        queue.fail(failed, 'launch-failed');
        ready(queue, handle);
      } else finish(queue, handle, outcome);
      assert.equal(service.list()[0].state, 'pending');
      assert.equal(fixture.facts().length, 1);
      assertFact(fixture.facts()[0], handle, outcome === 'mixed' ? { started: 1, cancelled: 1, failed: 2 } : totalsFor(outcome));
      const result = registry.dispatch();
      assert.deepEqual(result.unresolved, []);
      assert.ok(result.delivered.length >= 1);
      assert.equal(service.list()[0].state, action === 'activate' ? 'active' : 'closed');
      assert.equal(service.list()[0].text, 'Поставити нові задачі');
      assert.deepEqual(fixture.facts(), []);
      const applications = structuredClone(fixture.database.applications);
      registry.dispatch();
      assert.deepEqual(fixture.database.applications, applications);
    });
  }
}

for (const outcome of outcomes) {
  test(`queue-event: unbound ${outcome} fact is processed without creating a reminder or an extra event`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const service = fixture.attachReminders();
    const handle = enqueue(queue);
    finish(queue, handle, outcome);
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], handle, totalsFor(outcome));
    fixture.registry(queue).dispatch();
    assert.deepEqual(fixture.facts(), []);
    assert.deepEqual(service.list(), []);
    assert.deepEqual([...fixture.database.pending.values()], []);
    assert.deepEqual(fixture.database.applications, [{ kind: eventKind, id: handle.queueId }]);
    fixture.registry(fixture.connect()).dispatch();
    assert.equal(fixture.database.applications.length, 1);
  });
}

test('queue-event: unknown or foreign queue ID is rejected before reminder add/update persistence', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const service = fixture.attachReminders();
  const registry = fixture.registry(queue);
  const local = queue.queueId();
  const foreign = fixture.connect({ stateDomain: '/isolated/foreign', machineId: identity.machineId }).queueId();
  assert.notEqual(foreign, local);
  const reminder = service.add({ to: 'main', at: '2030-02-01T00:00:00.000Z', text: 'Existing', binding: { kind: eventKind, id: local, action: 'activate' } });
  const before = structuredClone(fixture.database.reminders);
  for (const id of ['main', 'bad-uuid', foreign, 'c0000000-0000-4000-8000-000000000003']) {
    assert.throws(() => {
      const binding: ReminderBinding = { kind: eventKind, id, action: 'activate' };
      registry.validate(binding);
      service.add({ to: 'main', at: '2030-02-01T00:00:00.000Z', text: 'Invalid', binding });
    });
    assert.throws(() => {
      const binding: ReminderBinding = { kind: eventKind, id, action: 'close' };
      registry.validate(binding);
      service.update(reminder.id, { binding });
    });
  }
  assert.deepEqual(fixture.database.reminders, before);
});

test('queue-event: unresolved pending survives restart and is cleared after normal registry retry', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const service = fixture.attachReminders();
  const handle = enqueue(queue);
  service.add({ to: 'main', at: '2030-02-01T00:00:00.000Z', text: 'Pending', binding: { kind: eventKind, id: handle.queueId, action: 'activate' } });
  ready(queue, handle);
  const fact = structuredClone(fixture.facts()[0]);
  fixture.database.failApply = true;
  const first = fixture.registry(queue).dispatch();
  assert.deepEqual(first.unresolved, [fact.key]);
  assert.deepEqual(fixture.facts(), [fact]);
  fixture.database.failApply = false;
  const restarted = fixture.connect();
  fixture.registry(restarted).dispatch();
  assert.equal(service.list()[0].state, 'active');
  assert.deepEqual(fixture.facts(), []);
  restarted.confirmReady(handle);
  assert.deepEqual(fixture.facts(), []);
});

test('queue-event: a processed fact is not recreated by readiness, and closed reminders stay closed', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const service = fixture.attachReminders();
  const handle = enqueue(queue);
  const reminder = service.add({ to: 'main', at: '2030-02-01T00:00:00.000Z', text: 'Close', binding: { kind: eventKind, id: handle.queueId, action: 'close' } });
  ready(queue, handle);
  fixture.registry(queue).dispatch();
  const closed = structuredClone(service.list()[0]);
  assert.equal(closed.state, 'closed');
  fixture.database.at = '2030-01-02T00:00:00.000Z';
  fixture.connect().confirmReady(handle);
  assert.deepEqual(fixture.facts(), []);
  const next = enqueue(queue, 'request-next', 'fence-next');
  ready(queue, next);
  fixture.registry(queue).dispatch();
  assert.deepEqual(service.list().find(row => row.id === reminder.id), closed);
  assert.deepEqual(fixture.facts(), []);
});

test('queue-event: a new generation with the same event-id activates a newly bound reminder', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const service = fixture.attachReminders();
  const first = enqueue(queue);
  ready(queue, first);
  fixture.registry(queue).dispatch();
  const reminder = service.add({ to: 'main', at: '2030-02-01T00:00:00.000Z', text: 'Next batch', binding: { kind: eventKind, id: first.queueId, action: 'activate' } });
  const next = enqueue(queue, 'next', 'next-fence');
  ready(queue, next);
  fixture.registry(queue).dispatch();
  assert.equal(next.queueId, first.queueId);
  assert.ok(next.generation > first.generation);
  assert.equal(service.list().find(row => row.id === reminder.id)?.state, 'active');
  assert.deepEqual(fixture.facts(), []);
  assert.deepEqual(fixture.state()?.entries, []);
});

for (const reason of ['cancelled', 'client-died', 'launch-failed'] as const) {
  test(`queue-event: sole ${reason} drains with started=0 and the next generation starts at zero`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const first = enqueue(queue);
    queue.fail(first, reason);
    assert.deepEqual(fixture.state()?.entries, []);
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], first, totalsFor(reason));
    const prior = structuredClone(fixture.facts()[0]);
    queue.confirmReady(first);
    queue.fail(first, reason);
    assert.deepEqual(fixture.facts(), [prior]);
    const next = enqueue(fixture.connect(), 'next', 'next-fence');
    assertCounters(fixture.state(), { started: 0, cancelled: 0, failed: 0 });
    ready(queue, next);
    assert.ok(next.generation > first.generation);
    assert.equal(next.queueId, first.queueId);
    assert.equal(fixture.facts().length, 2);
    assert.deepEqual(fixture.facts()[0], prior);
    assertFact(fixture.facts()[1], next);
  });
}

test('queue-event: a generation with only cancellations and failures still drains with started=0', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const a = enqueue(queue);
  const b = enqueue(queue, 'b', 'b-fence');
  const c = enqueue(queue, 'c', 'c-fence');
  queue.fail(a, 'cancelled');
  queue.fail(b, 'client-died');
  assert.deepEqual(fixture.facts(), []);
  fixture.connect().fail(c, 'launch-failed');
  assert.equal(fixture.facts().length, 1);
  assertFact(fixture.facts()[0], c, { started: 0, cancelled: 1, failed: 2 });
});

test('queue-event: two pending generations retain independent totals through restart and registry retry', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const service = fixture.attachReminders();
  const a = enqueue(queue);
  const b = enqueue(queue, 'b', 'b-fence');
  queue.fail(a, 'cancelled');
  queue.fail(b, 'client-died');
  const next = enqueue(queue, 'next', 'next-fence');
  assertCounters(fixture.state(), { started: 0, cancelled: 0, failed: 0 });
  ready(queue, next);
  const facts = structuredClone(fixture.facts());
  assert.equal(facts.length, 2);
  assertFact(facts[0], b, { started: 0, cancelled: 1, failed: 1 });
  assertFact(facts[1], next);
  assert.notEqual(facts[0].key, facts[1].key);
  assert.equal(next.queueId, a.queueId);
  const reminder = service.add({ to: 'main', at: '2030-02-01T00:00:00.000Z', text: 'Two pending', binding: { kind: eventKind, id: next.queueId, action: 'activate' } });
  fixture.database.failApply = true;
  const first = fixture.registry(fixture.connect()).dispatch();
  assert.deepEqual([...first.unresolved].sort(), facts.map(fact => fact.key).sort());
  assert.deepEqual(fixture.facts(), facts);
  fixture.database.failApply = false;
  const result = fixture.registry(fixture.connect()).dispatch();
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(fixture.facts(), []);
  assert.equal(service.list().find(row => row.id === reminder.id)?.state, 'active');
  assert.deepEqual(fixture.state()?.entries, []);
  const applications = structuredClone(fixture.database.applications);
  fixture.connect().fail(b, 'client-died');
  fixture.connect().confirmReady(next);
  fixture.registry(queue).dispatch();
  assert.deepEqual(fixture.facts(), []);
  assert.deepEqual(fixture.database.applications, applications);
});

test('queue-event: processed generations retain only the current scalar fence and no completed records', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  fixture.attachReminders();
  let last: LaunchQueueHandle | undefined;
  for (let index = 0; index < 12; index++) {
    const handle = enqueue(queue, `request-${index}`, `fence-${index}`);
    if (last) {
      assert.ok(handle.generation > last.generation);
      assert.equal(handle.queueId, last.queueId);
    }
    assertCounters(fixture.state(), { started: 0, cancelled: 0, failed: 0 });
    const outcome = outcomes[index % outcomes.length];
    finish(queue, handle, outcome);
    assertFact(fixture.facts()[0], handle, totalsFor(outcome));
    fixture.registry(queue).dispatch();
    assert.deepEqual(fixture.facts(), []);
    assert.deepEqual(fixture.state(), {
      queueId: handle.queueId,
      generation: handle.generation,
      entries: [],
      ...totalsFor(outcome),
    });
    last = handle;
  }
  assert.equal(fixture.database.queues.size, 1);
});
