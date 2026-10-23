import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadEventCatalog, validateEventId } from '../src/event-catalog.ts';
import { commandFixture, constants, errorCode } from './reminder-fixture.ts';

const idFixtures: Record<string, string> = {
  agentAddress: 'worker',
  reminderId: 'rem-1',
  changeId: 'add-raf-reminders',
  deploymentId: 'deploy-2026-10-22',
  contextReviewId: '6e606289-2d0a-4a0a-8df8-6999242ead70',
};
const validIds: Record<string, string> = Object.fromEntries(Object.keys(constants.eventIdKinds).map(idKind => {
  const id = idFixtures[idKind];
  assert.ok(id, `No fixture ID for ${idKind}`);
  return [idKind, id];
}));
const invalidIds: Record<string, string> = { agentAddress: 'bad/address', reminderId: 'bad id', changeId: 'Not_A_Change' };

test('event catalog loader returns exactly the events and ID kinds configured in conf', async t => {
  const f = await commandFixture(t);
  const catalog = loadEventCatalog(f.root);
  assert.deepEqual(catalog.events.map(event => [event.id, event.idKind]), constants.events.map((event: { id: string; idKind: string }) => [event.id, event.idKind]));
  assert.deepEqual(Object.keys(catalog.eventIdKinds).sort(), Object.keys(constants.eventIdKinds).sort());
});

test('event IDs are validated by the idKind of their event from the conf catalog', async t => {
  const f = await commandFixture(t);
  for (const event of constants.events as { id: string; idKind: string }[]) {
    const valid = validIds[event.idKind];
    assert.ok(valid, `No fixture ID for ${event.idKind}`);
    assert.equal(validateEventId(f.catalog, event.id, valid), true, `${event.id} rejected ${valid}`);
    const invalid = invalidIds[event.idKind];
    if (invalid !== undefined) assert.equal(validateEventId(f.catalog, event.id, invalid), false, `${event.id} accepted ${invalid}`);
  }
  assert.equal(validateEventId(f.catalog, 'not.in.conf', 'worker'), false);
});

test('every event kind from conf is accepted as a reminder binding by the direct command handlers', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const handlers = f.handlers();
  const target = await handlers['reminder add']({ to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: 'Ціль' }) as { id: string };
  for (const event of constants.events as { id: string; idKind: string }[]) {
    const id = event.idKind === 'reminderId' ? target.id : validIds[event.idKind];
    assert.ok(id, `No fixture ID for ${event.idKind}`);
    const created = await handlers['reminder add']({ to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: `Подія ${event.id}`,
      event: event.id, 'event-id': id, 'event-action': 'close' }) as { binding: unknown };
    assert.deepEqual(created.binding, { kind: event.id, id, action: 'close' });
  }
  assert.equal(f.list().length, constants.events.length + 1);
});

test('binding event ID is validated by the idKind of its event and a mismatch creates nothing', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const handlers = f.handlers();
  for (const event of constants.events as { id: string; idKind: string }[]) {
    const id = invalidIds[event.idKind];
    if (id === undefined) continue;
    await assert.rejects(
      Promise.resolve().then(() => handlers['reminder add']({ to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: 'Хибний ID', event: event.id, 'event-id': id, 'event-action': 'activate' })),
      error => /EVENT_ID_INVALID/.test(errorCode(error)), `${event.id} accepted ${id}`);
  }
  assert.equal(f.list().length, 0);
});

test('production runtime takes reminder event kinds from the conf catalog instead of its own list', async () => {
  const source = await readFile(new URL('../src/production-runtime.ts', import.meta.url), 'utf8');
  assert.equal(/approvedEventKinds:\s*\[/.test(source), false, 'production-runtime.ts declares its own approvedEventKinds list');
});

test('activate of a closed reminder fails with REMINDER_CLOSED and leaves the record unchanged', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = await f.command('reminder add', { to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: 'Закрите' }) as { id: string };
  await f.command('reminder close', { id: reminder.id, reason: 'готово' });
  const closed = f.get(reminder.id);
  await assert.rejects(Promise.resolve().then(() => f.handlers()['reminder activate']({ id: reminder.id })), error => /REMINDER_CLOSED/.test(errorCode(error)));
  assert.throws(() => f.reminders.activate(reminder.id), error => /REMINDER_CLOSED/.test(errorCode(error)));
  assert.deepEqual(f.get(reminder.id), closed);
  assert.equal(f.attempts(reminder.id).length, 0);
});

test('a reminder state change writes its event fact in the same transaction as the change', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = await f.handlers()['reminder add']({ to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: 'Подія закриття' }) as { id: string };
  f.sql(`CREATE TRIGGER block_closed_fact BEFORE INSERT ON pending_intents WHEN NEW.id LIKE 'reminder.closed:%' BEGIN SELECT RAISE(ABORT, 'injected event write failure'); END;`);
  await assert.rejects(Promise.resolve().then(() => f.handlers()['reminder close']({ id: reminder.id, reason: 'готово' })));
  assert.equal(f.get(reminder.id)?.state, 'pending');
  f.sql('DROP TRIGGER block_closed_fact;');
  await f.handlers()['reminder close']({ id: reminder.id, reason: 'готово' });
  assert.equal(f.get(reminder.id)?.state, 'closed');
  assert.equal(f.pendingEvents(`reminder.closed:${reminder.id}`), 1);
});

test('an event fact recorded by a command is applied to its bindings once across later commands', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = await f.command('reminder add', { to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: 'Закрити після викладки',
    event: 'deployment.completed', 'event-id': 'deploy-2026-10-22', 'event-action': 'close' }) as { id: string };
  f.recordEvent('deploy-fact-1', { kind: 'deployment.completed', id: 'deploy-2026-10-22' });
  await f.settle(f.separateProcess());
  const closed = f.get(reminder.id);
  assert.equal(closed?.state, 'closed');
  assert.equal(f.pendingEvents('deploy-fact-1'), 0);
  f.advance(5_000);
  f.recordEvent('deploy-fact-2', { kind: 'deployment.completed', id: 'deploy-2026-10-22' });
  await f.settle(f.separateProcess());
  await f.settle(f.separateProcess());
  assert.deepEqual(f.get(reminder.id), closed);
});
