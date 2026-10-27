import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { failureContext } from '../src/cli-contract.ts';
import { cliFixture, commandFixture, constants, errorCode, reminderFields } from './reminder-fixture.ts';
import type { ExecutionResult } from '../src/cli.ts';
import type { ReminderCommand } from '../src/reminder-cli.ts';
import type { Reminder } from '../src/reminders.ts';

const reminderCommands: ReminderCommand[] = constants.commands.filter((command: { path: string[] }) => command.path[0] === 'reminder').map((command: { path: string[] }) => command.path.join(' '));
const future = '2030-01-01T00:00:00Z';
const past = '2020-01-01T00:00:00Z';

function success(result: ExecutionResult): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function failure(result: ExecutionResult, code: string): Record<string, unknown> {
  assert.notEqual(result.exitCode, 0, result.stdout);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, code, result.stderr);
  return error;
}

test('conf catalog marks no reminder command as needing the raf service', () => {
  const commands = constants.commands.filter((command: { path: string[] }) => command.path[0] === 'reminder');
  assert.equal(commands.length, 7);
  for (const command of commands) {
    assert.equal(command.requiresService, undefined, command.path.join(' '));
    assert.doesNotMatch(`${command.prerequisites} ${command.sideEffects}`, /Готова служба|виконує служба|служба перед відповіддю/, command.path.join(' '));
  }
  assert.deepEqual(constants.commands.filter((command: { requiresService?: boolean }) => command.requiresService).map((command: { path: string[] }) => command.path.join(' ')), ['resource wait']);
});

test('all seven reminder commands run through the production CLI by direct SQLite while the raf service stays stopped', { timeout: 120_000 }, async t => {
  const f = await cliFixture(t);
  const added = success(await f.run(['reminder', 'add', '--to', 'worker', '--at', future, '--text', 'Перевірити викладку']));
  assert.deepEqual(Object.keys(added).sort(), [...reminderFields].sort());
  assert.equal(added.createdFor, 'worker');
  assert.equal(added.assignedTo, 'worker');
  assert.equal(added.state, 'pending');
  assert.equal(added.binding, null);
  const listed = success(await f.run(['reminder', 'list']));
  assert.ok(listed.some((row: Reminder) => row.id === added.id));
  assert.deepEqual(success(await f.run(['reminder', 'list', '--to', 'reviewer'])), []);
  const updated = success(await f.run(['reminder', 'update', '--id', added.id, '--text', 'Нова версія']));
  assert.equal(updated.text, 'Нова версія');
  assert.equal(updated.createdFor, 'worker');
  assert.equal(success(await f.run(['reminder', 'activate', '--id', added.id])).state, 'active');
  const reassigned = success(await f.run(['reminder', 'reassign', '--id', added.id, '--to', 'reviewer']));
  assert.equal(reassigned.assignedTo, 'reviewer');
  assert.equal(reassigned.createdFor, 'worker');
  const closed = success(await f.run(['reminder', 'close', '--id', added.id, '--reason', 'Виконано']));
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closeReason, 'Виконано');
  const other = success(await f.run(['reminder', 'add', '--to', 'worker', '--at', future, '--text', 'Друге']));
  const closedAll = success(await f.run(['reminder', 'close-all', '--created-for', 'worker', '--reason', 'Сесія завершена']));
  assert.deepEqual(closedAll.map((row: Reminder) => row.id), [other.id]);
  const persisted = f.rows();
  assert.equal(persisted.length, 2);
  assert.ok(persisted.every(row => row.state === 'closed'));
  assert.equal(f.serviceTouched(), false, 'a reminder command checked or started the raf service');
});

test('required parameters and unknown options are rejected by the CLI before any SQLite write', { timeout: 60_000 }, async t => {
  const f = await cliFixture(t);
  const cases: [string[], string][] = [
    [['reminder', 'add', '--at', future, '--text', 'x'], 'MISSING_REQUIRED'],
    [['reminder', 'add', '--to', 'worker', '--text', 'x'], 'MISSING_REQUIRED'],
    [['reminder', 'add', '--to', 'worker', '--at', future], 'MISSING_REQUIRED'],
    [['reminder', 'update', '--text', 'x'], 'MISSING_REQUIRED'],
    [['reminder', 'activate'], 'MISSING_REQUIRED'],
    [['reminder', 'close', '--id', 'r1'], 'MISSING_REQUIRED'],
    [['reminder', 'reassign', '--id', 'r1'], 'MISSING_REQUIRED'],
    [['reminder', 'close-all', '--reason', 'x'], 'MISSING_REQUIRED'],
    [['reminder', 'list', '--owner', 'worker'], 'UNKNOWN_ARGUMENT'],
  ];
  for (const [argv, code] of cases) failure(await f.run(argv), code);
  assert.deepEqual(f.rows(), []);
  assert.equal(f.serviceTouched(), false);
});

test('event binding is a complete triple whose values come from conf catalogs and whose ID matches the event idKind', { timeout: 120_000 }, async t => {
  const f = await cliFixture(t);
  const base = ['reminder', 'add', '--to', 'worker', '--at', future, '--text', 'Подія'];
  failure(await f.run([...base, '--event', 'openspec.archived', '--event-id', 'add-raf-reminders']), 'INVALID_VALUE');
  failure(await f.run([...base, '--event-action', 'close']), 'INVALID_VALUE');
  failure(await f.run([...base, '--event', 'openspec.archived', '--event-action', 'close']), 'INVALID_VALUE');
  failure(await f.run([...base, '--event', 'not.in.conf', '--event-id', 'x', '--event-action', 'close']), 'INVALID_VALUE');
  failure(await f.run([...base, '--event', 'openspec.archived', '--event-id', 'add-raf-reminders', '--event-action', 'open']), 'INVALID_VALUE');
  failure(await f.run([...base, '--event', 'openspec.archived', '--event-id', 'Not_A_Change', '--event-action', 'close']), 'EVENT_ID_INVALID');
  failure(await f.run([...base, '--event', 'agent.closed', '--event-id', 'bad/address', '--event-action', 'activate']), 'EVENT_ID_INVALID');
  assert.deepEqual(f.rows(), []);
  const bound = success(await f.run([...base, '--event', 'openspec.archived', '--event-id', 'add-raf-reminders', '--event-action', 'close']));
  assert.deepEqual(bound.binding, { kind: 'openspec.archived', id: 'add-raf-reminders', action: 'close' });
  failure(await f.run(['reminder', 'update', '--id', bound.id, '--event', 'deployment.completed']), 'INVALID_VALUE');
  const rebound = success(await f.run(['reminder', 'update', '--id', bound.id, '--event', 'deployment.completed', '--event-id', 'deploy-1', '--event-action', 'activate']));
  assert.deepEqual(rebound.binding, { kind: 'deployment.completed', id: 'deploy-1', action: 'activate' });
  assert.equal(f.rows().length, 1);
});

test('domain failures return documented codes and repeated close keeps closedAt and reason', { timeout: 120_000 }, async t => {
  const f = await cliFixture(t);
  failure(await f.run(['reminder', 'add', '--to', 'worker', '--at', '2030-01-01T00:00:00', '--text', 'Без зсуву']), 'REMINDER_INVALID_TIME');
  failure(await f.run(['reminder', 'add', '--to', 'worker', '--at', 'tomorrow', '--text', 'Не час']), 'REMINDER_INVALID_TIME');
  failure(await f.run(['reminder', 'add', '--to', 'gone', '--at', future, '--text', 'Неактивний']), 'SESSION_NOT_ACTIVE');
  failure(await f.run(['reminder', 'add', '--to', 'nobody', '--at', future, '--text', 'Невідомий']), 'SESSION_NOT_ACTIVE');
  failure(await f.run(['reminder', 'activate', '--id', 'missing-reminder']), 'REMINDER_NOT_FOUND');
  assert.deepEqual(f.rows(), []);
  const reminder = success(await f.run(['reminder', 'add', '--to', 'worker', '--at', past, '--text', 'Одразу активне']));
  assert.equal(reminder.state, 'active');
  failure(await f.run(['reminder', 'update', '--id', reminder.id]), 'REMINDER_UPDATE_EMPTY');
  failure(await f.run(['reminder', 'reassign', '--id', reminder.id, '--to', 'gone']), 'SESSION_NOT_ACTIVE');
  const closed = success(await f.run(['reminder', 'close', '--id', reminder.id, '--reason', 'Перше закриття']));
  for (const argv of [['reminder', 'activate', '--id', reminder.id], ['reminder', 'update', '--id', reminder.id, '--text', 'Пізно'], ['reminder', 'reassign', '--id', reminder.id, '--to', 'reviewer']]) {
    failure(await f.run(argv), 'REMINDER_CLOSED');
  }
  const again = success(await f.run(['reminder', 'close', '--id', reminder.id, '--reason', 'Друге закриття']));
  assert.equal(again.closedAt, closed.closedAt);
  assert.equal(again.closeReason, 'Перше закриття');
  assert.deepEqual(success(await f.run(['reminder', 'close-all', '--created-for', 'worker', '--reason', 'Ще раз'])), []);
  assert.deepEqual(f.rows(), [closed]);
});

test('reminder list through the CLI shows a reminder active once its time passed, with no service and no other command', { timeout: 60_000 }, async t => {
  const f = await cliFixture(t);
  const at = new Date(Date.now() + 1500).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const added = success(await f.run(['reminder', 'add', '--to', 'worker', '--at', at, '--text', 'Скоро']));
  assert.equal(added.state, 'pending');
  while (Date.now() <= Date.parse(at) + 200) await delay(100);
  const listed = success(await f.run(['reminder', 'list']));
  assert.deepEqual(listed.map((row: Reminder) => [row.id, row.state, row.at]), [[added.id, 'active', at]]);
  assert.equal(f.serviceTouched(), false);
});

test('any raf command with the main database settles due reminders after its own operation', { timeout: 60_000 }, async t => {
  const f = await cliFixture(t);
  const at = new Date(Date.now() + 1500).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const added = success(await f.run(['reminder', 'add', '--to', 'worker', '--at', at, '--text', 'Через іншу команду']));
  while (Date.now() <= Date.parse(at) + 200) await delay(100);
  success(await f.run(['command', 'stats']));
  assert.deepEqual(f.rows().map(row => [row.id, row.state]), [[added.id, 'active']]);
  assert.equal(f.serviceTouched(), false);
});

test('reminder handlers write SQLite directly and validate locally before any write', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  f.session('reviewer');
  const handlers = f.handlers();
  assert.deepEqual(Object.keys(handlers).sort(), [...reminderCommands].sort());
  const added = await handlers['reminder add']({ to: 'worker', at: future, text: 'x', event: 'openspec.archived', 'event-id': 'add-raf-reminders', 'event-action': 'close' }) as Reminder;
  assert.deepEqual(f.get(added.id), added);
  assert.deepEqual(added.binding, { kind: 'openspec.archived', id: 'add-raf-reminders', action: 'close' });
  assert.deepEqual(await handlers['reminder list']({ to: 'worker' }), [added]);
  assert.equal((await handlers['reminder update']({ id: added.id, text: 'y' }) as Reminder).text, 'y');
  assert.equal((await handlers['reminder activate']({ id: added.id }) as Reminder).state, 'active');
  assert.equal((await handlers['reminder reassign']({ id: added.id, to: 'reviewer' }) as Reminder).assignedTo, 'reviewer');
  assert.equal((await handlers['reminder close']({ id: added.id, reason: 'done' }) as Reminder).closeReason, 'done');
  assert.deepEqual(await handlers['reminder close-all']({ 'created-for': 'worker', reason: 'done' }), []);
  const before = f.list();
  const rejectsWith = (operation: () => unknown, code: string) => assert.rejects(Promise.resolve().then(operation), error => failureContext(error)?.code === code || errorCode(error).startsWith(`${code} `), code);
  await rejectsWith(() => handlers['reminder add']({ to: 'worker', at: future, text: 'x', event: 'openspec.archived' }), 'REMINDER_BINDING_INCOMPLETE');
  await rejectsWith(() => handlers['reminder update']({ id: added.id }), 'REMINDER_UPDATE_EMPTY');
  await rejectsWith(() => handlers['reminder add']({ to: 'worker', at: '2030-01-01T00:00:00', text: 'x' }), 'REMINDER_INVALID_TIME');
  assert.deepEqual(f.list(), before);
});

test('reminder list activates a due reminder in its own transaction with exactly one reminder.activated fact', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  const reminder = f.reminders.add({ to: 'worker', at: new Date(f.now() + 60_000).toISOString(), text: 'Через хвилину' });
  assert.equal(reminder.state, 'pending');
  f.advance(120_000);
  const listed = await f.handlers(f.separateProcess())['reminder list']({}) as Reminder[];
  assert.deepEqual(listed.map(row => [row.id, row.state, row.at]), [[reminder.id, 'active', reminder.at]]);
  assert.equal(f.get(reminder.id)?.state, 'active');
  assert.equal(f.pendingEvents(`reminder.activated:${reminder.id}`), 1);
  await f.handlers(f.separateProcess())['reminder list']({});
  assert.equal(f.list().length, 1);
});
