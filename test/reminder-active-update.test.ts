import assert from 'node:assert/strict';
import test from 'node:test';
import { cliFixture, commandFixture, type CommandFixture } from './reminder-fixture.ts';
import { reminderProcess } from './reminder-active-update-process.ts';

const time = (f: CommandFixture, offset: number) => new Date(f.now() + offset).toISOString();
const marks = (f: CommandFixture, id: string) => f.query('SELECT * FROM reminder_deliveries WHERE reminder_id = ?', id);
const events = (f: CommandFixture) => f.query('SELECT * FROM pending_intents ORDER BY id');
const binding = { kind: 'openspec.archived', id: 'add-raf-reminders', action: 'activate' as const };
const newBindingParams = { event: 'deployment.completed', 'event-id': 'deploy-1', 'event-action': 'close' };

test('7.2 delivered active rejects a future at and later command processes preserve its receipt without redelivery', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: time(f, -1000), text: 'Уже доставлено' });
  const first = await reminderProcess(f, 'reminder list', {});
  assert.equal(first.error, undefined);
  assert.equal(first.attempts.length, 1);
  assert.match(first.attempts[0].text, new RegExp(reminder.id));
  assert.deepEqual(first.attempts[0].sender, { kind: 'system' });
  const before = f.get(reminder.id);
  const receipt = marks(f, reminder.id);
  assert.equal(before?.state, 'active');
  assert.equal(receipt.length, 1);
  const future = time(f, 1_200_000);
  const rejected = await reminderProcess(f, 'reminder update', { id: reminder.id, at: future });
  assert.equal(rejected.error?.code, 'REMINDER_ACTIVE');
  assert.deepEqual(f.get(reminder.id), before);
  assert.deepEqual(marks(f, reminder.id), receipt);
  assert.deepEqual(rejected.attempts, []);
  const next = await reminderProcess(f, 'reminder list', {});
  f.time(Date.parse(future));
  const later = await reminderProcess(f, 'reminder list', {});
  assert.equal(new Set([first.pid, rejected.pid, next.pid, later.pid]).size, 4);
  for (const result of [next, later]) {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.attempts, []);
    assert.deepEqual(result.result, [before]);
  }
  assert.deepEqual(marks(f, reminder.id), receipt);
});

test('7.2 mixed active update rejects at text and complete binding atomically without changing addressees events or receipt', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  f.session('reviewer');
  const reminder = f.reminders.add({ to: 'worker', at: time(f, -1000), text: 'Старий текст', binding });
  f.reminders.reassign(reminder.id, 'reviewer');
  const delivered = await reminderProcess(f, 'reminder list', {});
  assert.equal(delivered.error, undefined);
  assert.equal(delivered.attempts.length, 1);
  assert.equal(delivered.attempts[0].to, 'reviewer');
  const before = f.get(reminder.id);
  assert.equal(before?.createdFor, 'worker');
  assert.equal(before?.assignedTo, 'reviewer');
  const receipt = marks(f, reminder.id);
  const pending = events(f);
  assert.equal(receipt.length, 1);
  const rejected = await reminderProcess(f, 'reminder update', {
    id: reminder.id, at: time(f, 1_200_000), text: 'Новий текст', ...newBindingParams,
  }, { settle: false });
  assert.equal(rejected.error?.code, 'REMINDER_ACTIVE');
  assert.deepEqual(f.get(reminder.id), before);
  assert.deepEqual(events(f), pending);
  assert.deepEqual(marks(f, reminder.id), receipt);
  const next = await reminderProcess(f, 'reminder list', {});
  assert.equal(next.error, undefined);
  assert.deepEqual(next.attempts, []);
  assert.deepEqual(marks(f, reminder.id), receipt);
});

for (const sameAt of [false, true]) {
  test(`7.2 event-activated before due rejects ${sameAt ? 'the same' : 'a later'} at and preserves the accepted receipt`, async t => {
    const f = await commandFixture(t);
    f.session('worker');
    const reminder = f.reminders.add({ to: 'worker', at: time(f, 60_000), text: 'Подія раніше строку', binding });
    assert.equal(reminder.state, 'pending');
    f.recordEvent('early-activation', { kind: binding.kind, id: binding.id });
    await f.settle(f.separateProcess());
    const before = f.get(reminder.id);
    const receipt = marks(f, reminder.id);
    assert.equal(before?.state, 'active');
    assert.ok(f.now() < Date.parse(reminder.at));
    assert.equal(f.deliveredTo('worker', reminder.id).length, 1);
    assert.equal(receipt.length, 1);
    const rejected = await reminderProcess(f, 'reminder update', { id: reminder.id, at: sameAt ? reminder.at : time(f, 120_000) });
    assert.equal(rejected.error?.code, 'REMINDER_ACTIVE');
    assert.deepEqual(f.get(reminder.id), before);
    assert.deepEqual(marks(f, reminder.id), receipt);
    assert.deepEqual(rejected.attempts, []);
    const next = await reminderProcess(f, 'reminder list', {});
    assert.equal(next.error, undefined);
    assert.deepEqual(next.attempts, []);
  });
}

test('7.2 active without a receipt rejects at without marking delivered and retries old data until accepted', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: time(f, 60_000), text: 'Ще не прийнято', binding });
  f.accept(() => false);
  f.recordEvent('unaccepted-activation', { kind: binding.kind, id: binding.id });
  await f.settle(f.separateProcess());
  const before = f.get(reminder.id);
  assert.equal(before?.state, 'active');
  assert.deepEqual(marks(f, reminder.id), []);
  const rejected = await reminderProcess(f, 'reminder update', { id: reminder.id, at: time(f, 120_000) }, { accepted: false });
  assert.equal(rejected.error?.code, 'REMINDER_ACTIVE');
  assert.deepEqual(f.get(reminder.id), before);
  assert.deepEqual(marks(f, reminder.id), []);
  assert.equal(rejected.attempts.length, 1);
  assert.match(rejected.attempts[0].text, /Ще не прийнято/);
  const retry = await reminderProcess(f, 'reminder list', {});
  assert.equal(retry.error, undefined);
  assert.equal(retry.attempts.length, 1);
  assert.deepEqual(retry.attempts[0], rejected.attempts[0]);
  assert.equal(marks(f, reminder.id).length, 1);
  const afterReceipt = await reminderProcess(f, 'reminder list', {});
  assert.equal(afterReceipt.error, undefined);
  assert.deepEqual(afterReceipt.attempts, []);
});

test('7.2 explicit activation also rejects an unchanged at', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: time(f, 60_000), text: 'Активовано вручну' });
  const activated = await reminderProcess(f, 'reminder activate', { id: reminder.id });
  assert.equal(activated.error, undefined);
  const before = f.get(reminder.id);
  const receipt = marks(f, reminder.id);
  assert.equal(before?.state, 'active');
  assert.equal(receipt.length, 1);
  const rejected = await reminderProcess(f, 'reminder update', { id: reminder.id, at: reminder.at });
  assert.equal(rejected.error?.code, 'REMINDER_ACTIVE');
  assert.deepEqual(f.get(reminder.id), before);
  assert.deepEqual(marks(f, reminder.id), receipt);
  assert.deepEqual(rejected.attempts, []);
});

test('7.2 pending moved into the future is not delivered at its old time and is delivered once at its new time', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  f.session('reviewer');
  const reminder = f.reminders.add({ to: 'worker', at: time(f, 60_000), text: 'Перенесено', binding });
  f.reminders.reassign(reminder.id, 'reviewer');
  const before = f.get(reminder.id);
  const at = time(f, 180_000);
  const updated = await reminderProcess(f, 'reminder update', { id: reminder.id, at });
  assert.equal(updated.error, undefined);
  assert.deepEqual(f.get(reminder.id), { ...before, at });
  assert.deepEqual(updated.attempts, []);
  f.advance(60_000);
  const oldDue = await reminderProcess(f, 'reminder list', {});
  assert.equal(oldDue.error, undefined);
  assert.equal(f.get(reminder.id)?.state, 'pending');
  assert.deepEqual(oldDue.attempts, []);
  f.time(Date.parse(at) - 1);
  const stillEarly = await reminderProcess(f, 'reminder list', {});
  assert.equal(stillEarly.error, undefined);
  assert.deepEqual(stillEarly.attempts, []);
  assert.equal(f.get(reminder.id)?.state, 'pending');
  assert.deepEqual(marks(f, reminder.id), []);
  f.advance(1);
  const due = await reminderProcess(f, 'reminder list', {});
  assert.equal(due.error, undefined);
  assert.deepEqual(f.get(reminder.id), { ...before, at, state: 'active' });
  assert.equal(due.attempts.length, 1);
  assert.equal(due.attempts[0].to, 'reviewer');
  const again = await reminderProcess(f, 'reminder list', {});
  assert.equal(again.error, undefined);
  assert.deepEqual(again.attempts, []);
});

for (const activation of ['event', 'explicit'] as const) {
  test(`7.2 pending rescheduled later still permits early ${activation} activation and one delivery`, async t => {
    const f = await commandFixture(t);
    f.session('worker');
    const reminder = f.reminders.add({ to: 'worker', at: time(f, 60_000), text: 'Дозволена рання активація', binding });
    const at = time(f, 180_000);
    const updated = await reminderProcess(f, 'reminder update', { id: reminder.id, at });
    assert.equal(updated.error, undefined);
    assert.equal(f.get(reminder.id)?.state, 'pending');
    assert.deepEqual(updated.attempts, []);
    if (activation === 'event') f.recordEvent('rescheduled-activation', { kind: binding.kind, id: binding.id });
    const activated = await reminderProcess(f, activation === 'event' ? 'reminder list' : 'reminder activate', activation === 'event' ? {} : { id: reminder.id });
    assert.equal(activated.error, undefined);
    assert.deepEqual(f.get(reminder.id), { ...reminder, at, state: 'active' });
    assert.ok(f.now() < Date.parse(at));
    assert.equal(activated.attempts.length, 1);
    f.time(Date.parse(at));
    const later = await reminderProcess(f, 'reminder list', {});
    assert.equal(later.error, undefined);
    assert.deepEqual(later.attempts, []);
  });
}

for (const offset of [0, -1000]) {
  test(`7.2 pending updated to ${offset === 0 ? 'now' : 'a past time'} activates and delivers in that command`, async t => {
    const f = await commandFixture(t);
    f.session('worker');
    const reminder = f.reminders.add({ to: 'worker', at: time(f, 60_000), text: 'Новий строк настав' });
    assert.equal(reminder.state, 'pending');
    const at = time(f, offset);
    const updated = await reminderProcess(f, 'reminder update', { id: reminder.id, at });
    assert.equal(updated.error, undefined);
    assert.deepEqual(f.get(reminder.id), { ...reminder, at, state: 'active' });
    assert.equal(updated.attempts.length, 1);
    assert.equal(marks(f, reminder.id).length, 1);
    const next = await reminderProcess(f, 'reminder list', {});
    assert.equal(next.error, undefined);
    assert.deepEqual(next.attempts, []);
  });
}

test('7.2 active update without at allows text and binding changes while preserving time state and addressees', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: time(f, -1000), text: 'Старе', binding });
  await f.settle(f.separateProcess());
  const before = f.get(reminder.id);
  const receipt = marks(f, reminder.id);
  const rebound = await reminderProcess(f, 'reminder update', { id: reminder.id, ...newBindingParams });
  assert.equal(rebound.error, undefined);
  assert.deepEqual(rebound.attempts, []);
  assert.deepEqual(marks(f, reminder.id), receipt);
  const expected = { ...before, binding: { kind: 'deployment.completed', id: 'deploy-1', action: 'close' } };
  assert.deepEqual(f.get(reminder.id), expected);
  const changed = await reminderProcess(f, 'reminder update', { id: reminder.id, text: 'Нове' });
  assert.equal(changed.error, undefined);
  assert.deepEqual(f.get(reminder.id), { ...expected, text: 'Нове' });
  assert.equal(changed.attempts.length, 1);
  assert.match(changed.attempts[0].text, /Нове/);
  const next = await reminderProcess(f, 'reminder list', {});
  assert.equal(next.error, undefined);
  assert.deepEqual(next.attempts, []);
});

test('7.2 closed update at keeps REMINDER_CLOSED and does not mutate fields events or receipt', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: time(f, -1000), text: 'Закрите', binding });
  await f.settle(f.separateProcess());
  f.reminders.close(reminder.id, 'Виконано');
  const before = f.get(reminder.id);
  const receipt = marks(f, reminder.id);
  const pending = events(f);
  const rejected = await reminderProcess(f, 'reminder update', {
    id: reminder.id, at: time(f, 60_000), text: 'Не змінювати', ...newBindingParams,
  }, { settle: false });
  assert.equal(rejected.error?.code, 'REMINDER_CLOSED');
  assert.deepEqual(f.get(reminder.id), before);
  assert.deepEqual(events(f), pending);
  assert.deepEqual(marks(f, reminder.id), receipt);
});

test('7.2 CLI rejects active at with nonzero code explanation details and close add remediation and keeps closed error', async t => {
  const f = await cliFixture(t);
  const added = await f.run(['reminder', 'add', '--to', 'worker', '--at', '2020-01-01T00:00:00Z', '--text', 'Спрацьоване',
    '--event', binding.kind, '--event-id', binding.id, '--event-action', binding.action]);
  assert.equal(added.exitCode, 0, added.stderr);
  const reminder = JSON.parse(added.stdout);
  assert.equal(reminder.state, 'active');
  const before = f.rows();
  for (const extra of [[], ['--text', 'Змінено', '--event', 'deployment.completed', '--event-id', 'deploy-1', '--event-action', 'close']]) {
    const result = await f.run(['reminder', 'update', '--id', reminder.id, '--at', '2030-01-01T00:00:00Z', ...extra]);
    assert.notEqual(result.exitCode, 0, result.stdout);
    const error = JSON.parse(result.stderr);
    assert.equal(error.code, 'REMINDER_ACTIVE', result.stderr);
    const explanation = [error.reason, error.message].filter(value => typeof value === 'string').join(' ');
    assert.match(explanation, /спрац|актив|activ|trigger|fir/iu, result.stderr);
    const diagnostic = JSON.stringify(error);
    assert.ok(diagnostic.includes(reminder.id), result.stderr);
    assert.match(diagnostic, /active/iu);
    assert.ok(diagnostic.includes(`reminder close --id ${reminder.id}`), result.stderr);
    assert.match(diagnostic, /--reason/);
    assert.ok(diagnostic.includes('reminder add --to worker'), result.stderr);
    assert.match(diagnostic, /--at/);
    assert.match(diagnostic, /--text/);
    assert.deepEqual(f.rows(), before);
    const listed = await f.run(['reminder', 'list']);
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), before);
  }
  const closed = await f.run(['reminder', 'close', '--id', reminder.id, '--reason', 'Перевірено']);
  assert.equal(closed.exitCode, 0, closed.stderr);
  const beforeClosedUpdate = f.rows();
  const rejected = await f.run(['reminder', 'update', '--id', reminder.id, '--at', '2030-01-01T00:00:00Z']);
  assert.notEqual(rejected.exitCode, 0, rejected.stdout);
  assert.equal(JSON.parse(rejected.stderr).code, 'REMINDER_CLOSED');
  assert.deepEqual(f.rows(), beforeClosedUpdate);
  assert.equal(f.serviceTouched(), false);
});
