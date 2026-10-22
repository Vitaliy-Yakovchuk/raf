import assert from 'node:assert/strict';
import test from 'node:test';
import { commandFixture, errorCode, successReason, type CommandFixture } from './reminder-fixture.ts';
import type { Reminder } from '../src/reminders.ts';

const later = (f: CommandFixture, milliseconds = 3_600_000) => new Date(f.now() + milliseconds).toISOString();
const rejoin = /resum|rejoin|reconnect|restart|відновл|повторн\w* приєдн|знову приєдн/i;
const psQuietly = async (f: CommandFixture) => { try { await f.agentPs(); } catch { } };
const unchangedExceptOwner = (before: Reminder, after: Reminder | undefined, owner: string) =>
  assert.deepEqual(after, { ...before, assignedTo: owner });

function seedWorkerReminders(f: CommandFixture) {
  const pending = f.reminders.add({ to: 'worker', at: later(f), text: 'Відкладене', binding: { kind: 'openspec.archived', id: 'add-raf-reminders', action: 'close' } });
  const active = f.reminders.add({ to: 'worker', at: new Date(f.now() - 1000).toISOString(), text: 'Активне' });
  const foreign = f.reminders.add({ to: 'reviewer', at: later(f), text: 'Чуже, передане worker' });
  const movedForeign = f.reminders.reassign(foreign.id, 'worker');
  const finished = f.reminders.add({ to: 'worker', at: later(f), text: 'Закрите' });
  const closed = f.reminders.close(finished.id, 'готово');
  return { pending, active: f.get(active.id)!, foreign: movedForeign, closed };
}

test('crash is finalized without resume and hands unfinished reminders to inactive main by the raf registry', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  const seeded = seedWorkerReminders(f);
  f.kill(worker.process);
  await f.agentPs();
  assert.equal(f.getSession(worker.runId)?.state, 'finished');
  assert.equal(f.sessions().filter(session => session.addressId === 'worker').length, 1);
  assert.equal(f.sessions().filter(session => session.state !== 'finished').length, 1);
  unchangedExceptOwner(seeded.pending, f.get(seeded.pending.id), 'main');
  unchangedExceptOwner(seeded.active, f.get(seeded.active.id), 'main');
  unchangedExceptOwner(seeded.foreign, f.get(seeded.foreign.id), 'main');
  assert.deepEqual(f.get(seeded.closed.id), seeded.closed);
  assert.equal(f.deliveredTo('main').length, 0);
  assert.ok(f.commands.every(command => command.executable === 'ps'), JSON.stringify(f.commands));
});

test('a later check by another command after crash finalization neither resumes the session nor repeats the handoff', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  const seeded = seedWorkerReminders(f);
  f.kill(worker.process);
  await f.agentPs();
  const closed = f.sessions().filter(session => session.addressId === 'worker');
  const runs = f.sessions().map(session => session.runId).sort();
  const reminders = f.list();
  f.advance(60_000);
  await f.agentPs();
  assert.deepEqual(f.sessions().filter(session => session.addressId === 'worker'), closed);
  assert.deepEqual(f.sessions().map(session => session.runId).sort(), runs);
  assert.deepEqual(f.list(), reminders);
  assert.equal(f.get(seeded.active.id)?.assignedTo, 'main');
  assert.ok(f.commands.every(command => command.executable === 'ps'));
});

test('one closure notice reaches the other project participants only after final closure and never announces a rejoin', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  f.session('stranger', { project: 'etchly' });
  f.reminders.add({ to: 'worker', at: later(f), text: 'Блокує передачу' });
  f.sql(`CREATE TRIGGER block_handoff BEFORE UPDATE ON reminders WHEN NEW.assigned_to = 'main' BEGIN SELECT RAISE(ABORT, 'injected handoff failure'); END;`);
  f.kill(worker.process);
  await psQuietly(f);
  assert.notEqual(f.getSession(worker.runId)?.state, 'finished');
  assert.equal(f.deliveredTo('reviewer').length, 0);
  f.sql('DROP TRIGGER block_handoff;');
  await psQuietly(f);
  assert.equal(f.getSession(worker.runId)?.state, 'finished');
  const notices = f.deliveredTo('reviewer');
  assert.equal(notices.length, 1, JSON.stringify(f.deliveries));
  assert.deepEqual(notices[0].sender, { kind: 'system' });
  assert.match(notices[0].text, /\bworker\b/);
  assert.equal(f.deliveredTo('stranger').length, 0);
  await f.agentPs();
  await f.agentPs();
  assert.equal(f.deliveredTo('reviewer').length, 1);
  assert.equal(f.deliveries.filter(item => rejoin.test(item.text)).length, 0);
});

test('failed finalization write rolls back session closure, reservation release, handoff and agent.closed; the next check repeats it', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  f.store.sessionRepository.transaction(tx => tx.putReservation({ runId: worker.runId, resource: 'fixture', amount: 1 }));
  const owned = f.reminders.add({ to: 'worker', at: later(f), text: 'Передати main' });
  const observer = f.reminders.add({ to: 'reviewer', at: later(f), text: 'Після закриття worker', binding: { kind: 'agent.closed', id: 'worker', action: 'activate' } });
  f.sql(`CREATE TRIGGER block_handoff BEFORE UPDATE ON reminders WHEN NEW.assigned_to = 'main' BEGIN SELECT RAISE(ABORT, 'injected handoff failure'); END;`);
  f.kill(worker.process);
  await psQuietly(f);
  assert.notEqual(f.getSession(worker.runId)?.state, 'finished');
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).some(row => row.runId === worker.runId), true);
  assert.deepEqual(f.get(owned.id), owned);
  assert.equal(f.get(observer.id)?.state, 'pending');
  f.sql('DROP TRIGGER block_handoff;');
  await psQuietly(f);
  assert.equal(f.getSession(worker.runId)?.state, 'finished');
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).some(row => row.runId === worker.runId), false);
  unchangedExceptOwner(owned, f.get(owned.id), 'main');
  assert.equal(f.get(observer.id)?.state, 'active');
  assert.equal(f.deliveredTo('reviewer', observer.id).length, 1);
});

test('two observers of one exit commit a single transition, handoff and closure event', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  const owned = f.reminders.add({ to: 'worker', at: later(f), text: 'Один перехід' });
  const observer = f.reminders.add({ to: 'reviewer', at: later(f), text: 'Подія закриття', binding: { kind: 'agent.closed', id: 'worker', action: 'activate' } });
  await f.agentPs();
  f.kill(worker.process);
  await Promise.all([f.agentPs(), f.agentPs()]);
  const finished = f.getSession(worker.runId);
  assert.equal(finished?.state, 'finished');
  assert.equal(f.sessions().filter(session => session.addressId === 'worker').length, 1);
  unchangedExceptOwner(owned, f.get(owned.id), 'main');
  assert.equal(f.get(observer.id)?.state, 'active');
  assert.equal(f.deliveredTo('reviewer', 'worker').filter(item => !item.text.includes(observer.id)).length, 1);
});

test('crash of main keeps its reminders at the main address and hands nothing elsewhere', async t => {
  const f = await commandFixture(t);
  const main = f.session('main');
  f.session('worker');
  const own = f.reminders.add({ to: 'main', at: later(f), text: 'Власне main' });
  const received = f.reminders.reassign(f.reminders.add({ to: 'worker', at: later(f), text: 'Передане main' }).id, 'main');
  f.kill(main.process);
  await f.agentPs();
  assert.equal(f.getSession(main.runId)?.state, 'finished');
  assert.deepEqual(f.get(own.id), own);
  assert.deepEqual(f.get(received.id), received);
  assert.equal(f.sessions().filter(session => session.addressId === 'main').length, 1);
  assert.equal(f.deliveredTo('worker').filter(item => item.text.includes(own.id) || item.text.includes(received.id)).length, 0);
});

test('accepted succeeded before a crash closes every reminder created for the session and keeps foreign ones', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker', { result: { status: 'succeeded', response: 'OpenSpec підтвердив', proof: { fixture: true } } });
  f.session('reviewer');
  const pending = f.reminders.add({ to: 'worker', at: later(f), text: 'Відкладене' });
  const moved = f.reminders.reassign(f.reminders.add({ to: 'worker', at: later(f), text: 'Передане reviewer' }).id, 'reviewer');
  const foreign = f.reminders.reassign(f.reminders.add({ to: 'reviewer', at: later(f), text: 'Чуже' }).id, 'worker');
  const unrelated = f.reminders.add({ to: 'reviewer', at: later(f), text: 'Не стосується worker' });
  f.kill(worker.process);
  await f.agentPs();
  assert.equal(f.getSession(worker.runId)?.state, 'finished');
  for (const reminder of [pending, moved]) {
    const closed = f.get(reminder.id);
    assert.equal(closed?.state, 'closed');
    assert.equal(closed?.closeReason, successReason);
    assert.equal(closed?.createdFor, 'worker');
    assert.notEqual(closed?.assignedTo, 'main');
  }
  assert.notEqual(f.get(foreign.id)?.state, 'closed');
  assert.equal(f.get(foreign.id)?.createdFor, 'reviewer');
  assert.deepEqual(f.get(unrelated.id), unrelated);
  const closedAt = f.get(pending.id)?.closedAt;
  f.advance(60_000);
  await f.agentPs();
  assert.equal(f.get(pending.id)?.closedAt, closedAt);
  assert.equal(f.get(moved.id)?.closedAt, closedAt);
});

test('failed result with a crash hands reminders to main instead of closing them', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker', { result: { status: 'failed', response: 'Не виконано', proof: { fixture: true } } });
  const owned = f.reminders.add({ to: 'worker', at: later(f), text: 'Лишити відкритим' });
  f.kill(worker.process);
  await f.agentPs();
  assert.equal(f.getSession(worker.runId)?.state, 'finished');
  unchangedExceptOwner(owned, f.get(owned.id), 'main');
});

test('close-all racing a reassignment leaves every reminder of the primary address closed and reports REMINDER_CLOSED', async t => {
  const f = await commandFixture(t);
  f.session('worker');
  f.session('reviewer');
  const first = f.reminders.add({ to: 'worker', at: later(f), text: 'Перше' });
  const second = f.reminders.add({ to: 'worker', at: later(f), text: 'Друге' });
  const left = f.handlers(f.separateProcess());
  const right = f.handlers(f.separateProcess());
  const [closeAll, reassign] = await Promise.allSettled([
    Promise.resolve().then(() => left['reminder close-all']({ 'created-for': 'worker', reason: 'Масове закриття' })),
    Promise.resolve().then(() => right['reminder reassign']({ id: second.id, to: 'reviewer' })),
  ]);
  assert.equal(closeAll.status, 'fulfilled');
  if (reassign.status === 'rejected') assert.match(errorCode(reassign.reason), /REMINDER_CLOSED/);
  for (const reminder of [first, second]) {
    const row = f.get(reminder.id);
    assert.equal(row?.state, 'closed');
    assert.equal(row?.createdFor, 'worker');
    assert.equal(row?.closeReason, 'Масове закриття');
  }
  await assert.rejects(Promise.resolve().then(() => right['reminder reassign']({ id: first.id, to: 'reviewer' })), error => /REMINDER_CLOSED/.test(errorCode(error)));
});

test('process scan error is not a death: no closure, handoff or notice', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  const owned = f.reminders.add({ to: 'worker', at: later(f), text: 'Лишається worker' });
  f.kill(worker.process);
  f.failScan(true);
  await psQuietly(f);
  await psQuietly(f);
  assert.equal(f.getSession(worker.runId)?.state, 'running');
  assert.deepEqual(f.get(owned.id), owned);
  assert.equal(f.deliveredTo('reviewer').length, 0);
});

test('agent death while its tmux shell lives on is still detected by PID evidence in one check', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  const owned = f.reminders.add({ to: 'worker', at: later(f), text: 'Оболонка жива' });
  await f.agentPs();
  f.replaceProcess({ ...worker.process!, pid: worker.process!.pid + 500 }, { start: 'Thu Oct 22 11:00:00 2026', command: `bash -l ${worker.process!.tmuxSession}` });
  f.kill(worker.process);
  await f.agentPs();
  assert.equal(f.getSession(worker.runId)?.state, 'finished');
  assert.equal(f.get(owned.id)?.assignedTo, 'main');
});

test('a reused PID with another start time or command is not the old agent', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  const owned = f.reminders.add({ to: 'worker', at: later(f), text: 'PID повторно' });
  await f.agentPs();
  f.replaceProcess(worker.process!, { start: 'Thu Oct 22 11:59:59 2026', command: 'unrelated-process --foreign' });
  await f.agentPs();
  assert.equal(f.getSession(worker.runId)?.state, 'finished');
  assert.equal(f.get(owned.id)?.assignedTo, 'main');
  assert.equal(f.deliveredTo('worker').length, 0);
});

test('event and reminder action bound to the failure fact run once across repeated checks by separate commands', async t => {
  const f = await commandFixture(t);
  const worker = f.session('worker');
  f.session('reviewer');
  const watcher = f.reminders.add({ to: 'reviewer', at: later(f), text: 'Закрити при падінні', binding: { kind: 'agent.failed', id: 'worker', action: 'close' } });
  f.kill(worker.process);
  await f.agentPs();
  const closed = f.get(watcher.id);
  assert.equal(closed?.state, 'closed');
  f.advance(60_000);
  await f.agentPs();
  await f.agentPs();
  assert.deepEqual(f.get(watcher.id), closed);
});
