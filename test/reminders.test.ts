import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ReminderService } from '../src/reminders.ts';
import type { AddReminder, Reminder, ReminderEvent, ReminderRepository, ReminderTransaction } from '../src/reminders.ts';

const approvedEventKinds: string[] = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8')).events.map((event: { id: string }) => event.id);
const initialTime = '2026-10-21T10:00:00.000Z';
const future = '2026-10-22T10:00:00.000Z';

class MemoryRepository implements ReminderRepository {
  records = new Map<string, Reminder>();
  sessions = new Map([['A', { active: true }], ['B', { active: true }], ['main', { active: true }], ['inactive', { active: false }]]);
  events: ReminderEvent[] = [];
  failAfterWrites = Infinity;
  transaction<T>(operation: (tx: ReminderTransaction) => T): T {
    const records = structuredClone(this.records);
    const events = structuredClone(this.events);
    let writes = 0;
    const result = operation({
      get: id => structuredClone(records.get(id)),
      list: () => structuredClone([...records.values()]),
      save: reminder => {
        if (++writes > this.failAfterWrites) throw new Error('storage failure');
        records.set(reminder.id, structuredClone(reminder));
      },
      remove: id => {
        if (++writes > this.failAfterWrites) throw new Error('storage failure');
        records.delete(id);
      },
      session: address => structuredClone(this.sessions.get(address)),
      emit: event => { events.push(structuredClone(event)); },
    });
    this.records = records;
    this.events = events;
    return result;
  }
}

function fixture() {
  const repository = new MemoryRepository();
  let now = initialTime;
  let sequence = 0;
  const service = new ReminderService({ repository, now: () => now, nextId: () => `r${++sequence}`, approvedEventKinds });
  const add = (to = 'A', at = future) => service.add({ to, at, text: 'Review completion' });
  return { repository, service, add, time: (value: string) => { now = value; } };
}

test('mandatory time and registered address also apply to event-bound reminders', () => {
  const { service, repository } = fixture();
  const input = { to: 'A', at: future, text: 'Work', binding: { kind: 'agent.closed', id: 'B', action: 'activate' as const } };
  for (const invalid of [{ ...input, at: undefined }, { ...input, at: '' }, { ...input, at: 'yesterday' }, { ...input, to: '' }, { ...input, to: 'unknown' }]) {
    assert.throws(() => service.add(invalid as AddReminder));
  }
  assert.equal(repository.records.size, 0);
  const reminder = service.add(input);
  assert.equal(reminder.createdFor, 'A');
  assert.equal(reminder.assignedTo, 'A');
  assert.equal(reminder.state, 'pending');
});

test('due boundary and early manual activation yield one activation per reminder', () => {
  const { service, repository, add, time } = fixture();
  const due = add();
  const manual = add();
  assert.deepEqual(service.activateDue(), []);
  assert.equal(service.activate(manual.id).state, 'active');
  service.activate(manual.id);
  time(future);
  assert.deepEqual(service.activateDue().map(row => row.id), [due.id]);
  assert.deepEqual(service.activateDue(), []);
  assert.equal(service.list().length, 2);
  for (const row of [due, manual]) assert.equal(repository.events.filter(event => event.kind === 'reminder.activated' && event.id === row.id).length, 1);
});

for (const kind of approvedEventKinds) {
  for (const action of ['activate', 'close'] as const) {
    test(`${kind} supports ${action} using exact event kind and object ID`, () => {
      const { service, repository, time } = fixture();
      const row = service.add({ to: 'A', at: future, text: 'Bound', binding: { kind, id: 'object-1', action } });
      assert.deepEqual(service.applyEvent({ kind, id: 'object-2' }), []);
      const otherKind = approvedEventKinds.find(value => value !== kind)!;
      assert.deepEqual(service.applyEvent({ kind: otherKind, id: 'object-1' }), []);
      assert.deepEqual(service.applyEvent({ kind, id: 'object-1' }).map(value => value.id), [row.id]);
      const changed = repository.records.get(row.id)!;
      assert.equal(changed.state, action === 'activate' ? 'active' : 'closed');
      assert.equal(changed.closedAt, action === 'close' ? initialTime : null);
      time(future);
      service.applyEvent({ kind, id: 'object-1' });
      service.activateDue();
      assert.deepEqual(repository.records.get(row.id), changed);
    });
  }
}

test('unknown event kinds and empty event IDs are rejected without writes', () => {
  const { service, repository } = fixture();
  for (const binding of [{ kind: 'invented.event', id: 'A', action: 'activate' as const }, { kind: 'agent.closed', id: '', action: 'close' as const }]) {
    assert.throws(() => service.add({ to: 'A', at: future, text: 'Work', binding }));
  }
  assert.equal(repository.records.size, 0);
});

test('updates change text, due time and binding without changing original recipient', () => {
  const { service, add, repository } = fixture();
  const row = add();
  service.reassign(row.id, 'B');
  const binding = { kind: 'deployment.completed', id: 'deploy-1', action: 'close' as const };
  const updated = service.update(row.id, { at: '2026-10-23T10:00:00.000Z', text: 'New work', binding });
  assert.equal(updated.createdFor, 'A');
  assert.equal(updated.assignedTo, 'B');
  assert.equal(updated.text, 'New work');
  assert.equal(updated.at, '2026-10-23T10:00:00.000Z');
  assert.deepEqual(updated.binding, binding);
  assert.throws(() => service.update(row.id, { at: '' }));
  assert.deepEqual(repository.records.get(row.id), updated);
  assert.deepEqual(service.applyEvent({ kind: binding.kind, id: binding.id }).map(value => value.id), [row.id]);
});

test('reassignment checks target activity only and exposes immutable original address', () => {
  const { service, add, repository } = fixture();
  const row = add();
  service.activate(row.id);
  const before = repository.records.get(row.id)!;
  service.reassign(row.id, 'B');
  assert.equal(service.list('B')[0].createdFor, 'A');
  const moved = service.reassign(row.id, 'main');
  assert.deepEqual(moved, { ...before, assignedTo: 'main' });
  assert.deepEqual(service.list('A'), []);
  assert.deepEqual(service.list('main'), [moved]);
  for (const target of ['inactive', 'unknown']) assert.throws(() => service.reassign(row.id, target));
  assert.deepEqual(repository.records.get(row.id), moved);
});

test('ordinary session close is blocked by future reminders until closed or reassigned', () => {
  const { service, add } = fixture();
  const row = add();
  assert.deepEqual(service.checkSessionClose('A'), { allowed: false, unfinished: [row] });
  assert.equal(service.sessionEnded({ address: 'A', confirmedSucceeded: false, crashed: false }).allowed, false);
  service.reassign(row.id, 'B');
  assert.deepEqual(service.checkSessionClose('A'), { allowed: true, unfinished: [] });
  service.close(row.id, 'handled');
  assert.equal(service.checkSessionClose('B').allowed, true);
});

test('bulk close selects original address including future and reassigned rows and is idempotent', () => {
  const { service, repository, add, time } = fixture();
  const first = add();
  const second = add();
  service.reassign(second.id, 'main');
  const foreign = add('B');
  service.reassign(foreign.id, 'A');
  assert.deepEqual(new Set(service.closeAll('A', 'finished').map(row => row.id)), new Set([first.id, second.id]));
  for (const row of [first, second]) {
    assert.equal(repository.records.get(row.id)!.closedAt, initialTime);
    assert.equal(repository.records.get(row.id)!.closeReason, 'finished');
  }
  time(future);
  assert.deepEqual(service.closeAll('A', 'retry'), []);
  service.close(first.id, 'retry');
  assert.equal(repository.records.get(first.id)!.closedAt, initialTime);
  assert.equal(repository.records.get(first.id)!.closeReason, 'finished');
  assert.equal(repository.records.get(foreign.id)!.state, 'pending');
});

test('bulk close rolls back all rows and emitted events on storage failure', () => {
  const { service, repository, add } = fixture();
  add();
  add();
  const before = structuredClone(repository.records);
  const events = structuredClone(repository.events);
  repository.failAfterWrites = 1;
  assert.throws(() => service.closeAll('A', 'finished'), /storage failure/);
  assert.deepEqual(repository.records, before);
  assert.deepEqual(repository.events, events);
});

test('confirmed success closes by original address even after process crash', () => {
  const { service, repository, add, time } = fixture();
  const row = add();
  service.reassign(row.id, 'B');
  assert.equal(service.sessionEnded({ address: 'A', confirmedSucceeded: true, crashed: true }).allowed, true);
  assert.equal(repository.records.get(row.id)!.closeReason, 'сесія закінчилась з success');
  assert.equal(repository.records.get(row.id)!.assignedTo, 'B');
  assert.equal(repository.records.get(row.id)!.state, 'closed');
  time(future);
  service.sessionEnded({ address: 'A', confirmedSucceeded: true, crashed: true });
  assert.equal(repository.records.get(row.id)!.closedAt, initialTime);
});

test('crash hands current unfinished reminders to inactive main, preserving original identity and state', () => {
  const { service, repository, add } = fixture();
  const original = add();
  const inherited = add('B');
  service.reassign(inherited.id, 'A');
  const closed = add();
  service.close(closed.id, 'done');
  repository.sessions.set('main', { active: false });
  assert.equal(service.sessionEnded({ address: 'A', confirmedSucceeded: false, crashed: true }).allowed, true);
  for (const row of [original, inherited]) assert.deepEqual(repository.records.get(row.id), { ...row, assignedTo: 'main' });
  assert.equal(repository.records.get(closed.id)!.assignedTo, 'A');
  const before = structuredClone(repository.records);
  service.sessionEnded({ address: 'main', confirmedSucceeded: false, crashed: true });
  assert.deepEqual(repository.records, before);
});

test('retention removes closed rows exactly 48 hours after closure and retains old open rows', () => {
  const { service, repository, add, time } = fixture();
  const closed = add();
  const open = add('B', '2020-01-01T00:00:00.000Z');
  service.close(closed.id, 'done');
  time('2026-10-23T09:59:59.999Z');
  assert.deepEqual(service.pruneClosed(), []);
  time('2026-10-23T10:00:00.000Z');
  assert.deepEqual(service.pruneClosed(), [closed.id]);
  assert.equal(repository.records.has(closed.id), false);
  assert.equal(repository.records.has(open.id), true);
  assert.deepEqual(service.pruneClosed(), []);
});
