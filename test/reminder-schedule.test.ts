import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { commandFixture } from './reminder-fixture.ts';

test('a due reminder becomes active at the first command after its time, without a service, timer or new ID', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: new Date(f.now() + 10_000).toISOString(), text: 'Вчасно' });
  const early = await f.settle(f.separateProcess());
  assert.deepEqual(early.activated, []);
  assert.equal(f.get(reminder.id)?.state, 'pending');
  f.advance(10_000);
  const report = await f.settle(f.separateProcess());
  assert.deepEqual(report.activated, [reminder.id]);
  const rows = f.list();
  assert.deepEqual(rows.map(row => [row.id, row.state, row.at]), [[reminder.id, 'active', reminder.at]]);
  assert.equal(f.deliveredTo('worker', reminder.id).length, 1);
});

test('an overdue reminder found hours later by any command activates once and is delivered once across later commands', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: new Date(f.now() + 10_000).toISOString(), text: 'Прострочене' });
  f.advance(3_600_000);
  await f.command('reminder list', {});
  await f.settle(f.separateProcess());
  await f.command('reminder close-all', { 'created-for': 'nobody', reason: 'не стосується' });
  const rows = f.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, reminder.id);
  assert.equal(rows[0].state, 'active');
  assert.equal(rows[0].at, reminder.at);
  assert.equal(f.attempts(reminder.id).length, 1);
});

test('event activation before the due time is not repeated when the time arrives', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const at = new Date(f.now() + 60_000).toISOString();
  const reminder = f.reminders.add({ to: 'worker', at, text: 'Після архівації', binding: { kind: 'openspec.archived', id: 'add-raf-reminders', action: 'activate' } });
  f.recordEvent('archive-add-raf-reminders', { kind: 'openspec.archived', id: 'add-raf-reminders' });
  await f.settle(f.separateProcess());
  assert.equal(f.get(reminder.id)?.state, 'active');
  assert.equal(f.deliveredTo('worker', reminder.id).length, 1);
  f.advance(120_000);
  const later = await f.settle(f.separateProcess());
  assert.deepEqual(later.activated, []);
  const rows = f.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'active');
  assert.equal(rows[0].at, at);
  assert.equal(f.attempts(reminder.id).length, 1);
});

test('event-bound reminder still requires its time and an unrelated event leaves it pending', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  await assert.rejects(Promise.resolve().then(() => f.handlers()['reminder add']({ to: 'worker', text: 'Без часу', event: 'openspec.archived', 'event-id': 'add-raf-reminders', 'event-action': 'activate' })));
  const reminder = await f.command('reminder add', { to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: 'Чекає подію',
    event: 'openspec.archived', 'event-id': 'add-raf-reminders', 'event-action': 'activate' }) as { id: string };
  f.recordEvent('archive-other', { kind: 'openspec.archived', id: 'other-change' });
  await f.settle(f.separateProcess());
  assert.equal(f.get(reminder.id)?.state, 'pending');
  assert.equal(f.attempts(reminder.id).length, 0);
});

test('every command prunes closed reminders older than the configured retention and keeps open ones of any age', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const retention = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8')).retention.closedRemindersMs as number;
  const old = f.reminders.add({ to: 'worker', at: new Date(f.now() + 365 * 86_400_000).toISOString(), text: 'Старе відкрите' });
  const closed = f.reminders.add({ to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: 'Закрите' });
  f.reminders.close(closed.id, 'готово');
  f.advance(retention - 1000);
  await f.settle(f.separateProcess());
  assert.ok(f.get(closed.id));
  f.advance(2000);
  const report = await f.settle(f.separateProcess());
  assert.deepEqual(report.pruned, [closed.id]);
  assert.equal(f.get(closed.id), undefined);
  assert.equal(f.get(old.id)?.state, 'pending');
});
