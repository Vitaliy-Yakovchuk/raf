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
const eventDescription = 'Усі запуски, що очікували в черзі машини, підтверджено запущені';
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

function assertFact(fact: LaunchQueueDrainedFact, handle: LaunchQueueHandle): void {
  assert.deepEqual(fact.event, { kind: eventKind, id: handle.queueId });
  assert.deepEqual(fact.data, { queueId: handle.queueId, generation: handle.generation });
  assert.equal(typeof fact.key, 'string');
  assert.notEqual(fact.key, '');
}

test('queue-event: future conf catalog contains the exact approved event and ID description', () => {
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
  { kind: 'test-run', waited: true },
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
  assertFact(fixture.facts()[0], b);
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
  test(`queue-event: ${reason} suppresses the whole generation and the next generation may drain`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const failed = enqueue(queue);
    const survivor = enqueue(queue, 'request-b', 'fence-b');
    queue.fail(failed, reason);
    assert.equal(fixture.state()?.hadFailure, true);
    assert.deepEqual(fixture.facts(), []);
    ready(queue, survivor);
    assert.deepEqual(fixture.facts(), []);
    const next = enqueue(queue, 'request-c', 'fence-c');
    assert.ok(next.generation > failed.generation);
    assert.equal(next.queueId, failed.queueId);
    assert.equal(fixture.state()?.hadFailure, false);
    ready(queue, next);
    assert.equal(fixture.facts().length, 1);
    assertFact(fixture.facts()[0], next);
  });
}

test('queue-event: hadFailure survives command restart while survivors are starting', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const a = enqueue(queue);
  const b = enqueue(queue, 'request-b', 'fence-b');
  queue.fail(a, 'client-died');
  ready(fixture.connect(), b);
  assert.deepEqual(fixture.facts(), []);
});

test('queue-event: late failure of an already ready record does not poison the generation', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const a = enqueue(queue);
  const b = enqueue(queue, 'request-b', 'fence-b');
  ready(queue, a);
  queue.fail(a, 'client-died');
  ready(queue, b);
  assert.equal(fixture.facts().length, 1);
});

for (const operation of ['confirmReady', 'fail', 'transition'] as const) {
  test(`queue-event: stale fence cannot ${operation} a current launch record`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const handle = enqueue(queue);
    starting(queue, handle);
    const before = structuredClone(fixture.state());
    const stale = { ...handle, fence: 'stale-fence' };
    if (operation === 'confirmReady') queue.confirmReady(stale);
    if (operation === 'fail') queue.fail(stale, 'cancelled');
    if (operation === 'transition') queue.transition(stale, 'waiting');
    assert.deepEqual(fixture.state(), before);
    assert.deepEqual(fixture.facts(), []);
    queue.confirmReady(handle);
    assert.equal(fixture.facts().length, 1);
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
    queue.fail(stale, 'cancelled');
  }
  assert.deepEqual(fixture.state(), before);
  assert.deepEqual(fixture.facts(), facts);
  queue.confirmReady(current);
  assert.equal(fixture.facts().length, 2);
});

test('queue-event: enqueue before last readiness extends the unfinished generation', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const a = enqueue(queue);
  starting(queue, a);
  const b = enqueue(fixture.connect(), 'request-b', 'fence-b');
  assert.equal(b.generation, a.generation);
  queue.confirmReady(a);
  assert.deepEqual(fixture.facts(), []);
  ready(queue, b);
  assert.equal(fixture.facts().length, 1);
});

test('queue-event: enqueue after last readiness opens a new generation without losing pending', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const a = enqueue(queue);
  ready(queue, a);
  const first = structuredClone(fixture.facts()[0]);
  const b = enqueue(fixture.connect(), 'request-b', 'fence-b');
  assert.ok(b.generation > a.generation);
  assert.equal(b.queueId, a.queueId);
  assert.deepEqual(fixture.facts(), [first]);
  ready(queue, b);
  const facts = fixture.facts();
  assert.equal(facts.length, 2);
  assert.notEqual(facts[0].key, facts[1].key);
  assertFact(facts[1], b);
});

test('queue-event: cancellation before readiness suppresses, readiness before cancellation stays final', () => {
  for (const cancelFirst of [true, false]) {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const handle = enqueue(queue);
    starting(queue, handle);
    if (cancelFirst) queue.fail(handle, 'cancelled');
    queue.confirmReady(handle);
    if (!cancelFirst) queue.fail(handle, 'cancelled');
    assert.equal(fixture.facts().length, cancelFirst ? 0 : 1);
  }
});

for (const failure of ['failSavePending', 'failSaveQueue'] as const) {
  test(`queue-event: ${failure} rolls back last readiness and pending as one transaction`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const handle = enqueue(queue);
    starting(queue, handle);
    const before = structuredClone(fixture.state());
    fixture.database[failure] = true;
    assert.throws(() => queue.confirmReady(handle), /mock .* write failure/);
    assert.deepEqual(fixture.state(), before);
    assert.deepEqual(fixture.facts(), []);
    fixture.database[failure] = false;
    queue.confirmReady(handle);
    assert.equal(fixture.facts().length, 1);
    const last = fixture.database.writes.at(-1)!;
    assert.equal([...last.queues.values()][0].entries.length, 0);
    assert.equal([...last.pending.values()].filter(fact => fact.event.kind === eventKind).length, 1);
  });
}

test('queue-event: active external wait and test-run never delay a queued agent drained fact', () => {
  const fixture = memoryDatabase();
  const queue = fixture.connect();
  const handle = enqueue(queue);
  for (const kind of ['resource-wait', 'test-run'] as const) {
    assert.equal(queue.record({ kind, waited: true, requestId: kind, fence: kind }), null);
  }
  ready(queue, handle);
  assert.equal(fixture.facts().length, 1);
  assert.deepEqual(fixture.state()?.entries, []);
});

for (const action of ['activate', 'close'] as const) {
  test(`queue-event: reminder add/update ${action} applies pending without a service`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const service = fixture.attachReminders();
    const registry = fixture.registry(queue);
    const binding: ReminderBinding = { kind: eventKind, id: queue.queueId(), action };
    registry.validate(binding);
    const reminder = service.add({ to: 'main', at: '2030-02-01T00:00:00.000Z', text: 'Поставити нові задачі', binding });
    service.update(reminder.id, { binding });
    const handle = enqueue(queue);
    ready(queue, handle);
    assert.equal(service.list()[0].state, 'pending');
    assert.equal(fixture.facts().length, 1);
    const result = registry.dispatch();
    assert.deepEqual(result.unresolved, []);
    assert.ok(result.delivered.length >= 1);
    assert.equal(service.list()[0].state, action === 'activate' ? 'active' : 'closed');
    assert.deepEqual(fixture.facts(), []);
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
  test(`queue-event: sole ${reason} record closes without a fact and cannot poison later work`, () => {
    const fixture = memoryDatabase();
    const queue = fixture.connect();
    const first = enqueue(queue);
    queue.fail(first, reason);
    assert.deepEqual(fixture.state()?.entries, []);
    assert.deepEqual(fixture.facts(), []);
    queue.confirmReady(first);
    assert.deepEqual(fixture.facts(), []);
    const next = enqueue(fixture.connect(), 'next', 'next-fence');
    ready(queue, next);
    assert.ok(next.generation > first.generation);
    assert.equal(next.queueId, first.queueId);
    assert.equal(fixture.facts().length, 1);
  });
}

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
    ready(queue, handle);
    fixture.registry(queue).dispatch();
    assert.deepEqual(fixture.facts(), []);
    assert.deepEqual(fixture.state(), {
      queueId: handle.queueId,
      generation: handle.generation,
      entries: [],
      hadFailure: false,
    });
    last = handle;
  }
  assert.equal(fixture.database.queues.size, 1);
});
