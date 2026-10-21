import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { openReminderRepository } from '../src/reminder-repository.ts';
import type { ReminderSessionEffect } from '../src/reminder-repository.ts';
import { openSessionRepository } from '../src/session-repository.ts';
import { ReminderService } from '../src/reminders.ts';
import type { Reminder } from '../src/reminders.ts';

const now = '2026-10-21T10:00:00.000Z';
const reminder: Reminder = { id: 'reminder-1', createdFor: 'worker', assignedTo: 'worker', text: 'Finish the assigned work', at: '2026-10-22T12:00:00.000Z', binding: null, state: 'pending', closedAt: null, closeReason: null };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'raf-reminder-repository-'));
  const path = join(directory, 'state.sqlite');
  let sessionHandle: ReturnType<typeof openSessionRepository> | undefined;
  let reminderHandle: ReturnType<typeof openReminderRepository> | undefined;
  t.after(async () => {
    reminderHandle?.close();
    sessionHandle?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sessions = sessionHandle = openSessionRepository(path);
  const reminders = reminderHandle = openReminderRepository(path);
  sessions.repository.transaction(tx => {
    tx.putSession({ runId: 'worker-run', addressId: 'worker', state: 'running', revision: 1 });
    tx.putSession({ runId: 'peer-run', addressId: 'peer', state: 'running', revision: 1 });
    tx.putSession({ runId: 'main-run', addressId: 'main', state: 'finished', revision: 3, finishedAt: now });
  });
  let time = now;
  let next = 0;
  const service = new ReminderService({ repository: reminders.repository, now: () => time, nextId: () => `generated-${++next}`, approvedEventKinds: ['fixture.changed'] });
  return { directory, path, sessions, reminders, service, setTime: (value: string) => { time = value; } };
}

function sql<T>(path: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function handoff(): ReminderSessionEffect {
  return { id: 'worker-run:reminders', domain: 'reminders', payload: { operation: 'session-ended', runId: 'worker-run', end: { address: 'worker', confirmedSucceeded: false, crashed: true }, at: now } };
}

test('integration: original and current owners persist independently in the shared database', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => tx.save(reminder));
  f.service.reassign(reminder.id, 'peer');
  const reopened = openReminderRepository(f.path);
  try {
    assert.deepEqual(reopened.repository.transaction(tx => tx.get(reminder.id)), { ...reminder, assignedTo: 'peer' });
  } finally {
    reopened.close();
  }
  const files = await readdir(f.directory);
  assert.deepEqual(files.filter(name => !name.endsWith('-wal') && !name.endsWith('-shm')), ['state.sqlite']);
});

test('integration: unknown addresses differ from registered inactive main and crash handoff persists without delivery', async t => {
  const f = await fixture(t);
  assert.equal(f.reminders.repository.transaction(tx => tx.session('foreign')), undefined);
  assert.deepEqual(f.reminders.repository.transaction(tx => tx.session('main')), { active: false });
  assert.throws(() => f.service.add({ to: 'foreign', text: 'unknown', at: now }));
  f.reminders.repository.transaction(tx => tx.save(reminder));
  assert.throws(() => f.service.reassign(reminder.id, 'main'));
  f.sessions.repository.transaction(tx => tx.applyEffects([handoff()]));
  const reopened = openReminderRepository(f.path);
  try {
    assert.deepEqual(reopened.repository.transaction(tx => tx.get(reminder.id)), { ...reminder, assignedTo: 'main' });
    assert.deepEqual(reopened.repository.transaction(tx => tx.session('main')), { active: false });
  } finally {
    reopened.close();
  }
});

test('integration: reminder update and emitted pending event roll back together', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => tx.save(reminder));
  const before = f.sessions.repository.transaction(tx => tx.listPending());
  const failure = new Error('injected after reminder and event writes');
  assert.throws(() => f.reminders.repository.transaction(tx => {
    tx.save({ ...reminder, state: 'active' });
    tx.emit({ kind: 'fixture.changed', id: reminder.id });
    throw failure;
  }), error => error === failure);
  assert.deepEqual(f.reminders.repository.transaction(tx => tx.get(reminder.id)), reminder);
  assert.deepEqual(f.sessions.repository.transaction(tx => tx.listPending()), before);
  f.reminders.repository.transaction(tx => {
    tx.save({ ...reminder, state: 'active' });
    tx.emit({ kind: 'fixture.changed', id: reminder.id });
  });
  const reopened = openSessionRepository(f.path);
  try {
    assert.equal(reopened.repository.transaction(tx => tx.listPending()).length, before.length + 1);
  } finally {
    reopened.close();
  }
});

test('integration: session finalization, reservation release and reminder handoff share one rollback boundary', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => tx.save(reminder));
  f.sessions.repository.transaction(tx => tx.putReservation({ runId: 'worker-run', resource: 'fixture', amount: 1 }));
  const before = f.sessions.repository.transaction(tx => tx.getSession('worker-run'))!;
  const finalize = (fail: boolean) => f.sessions.repository.transaction(tx => {
    tx.applyEffects([handoff()]);
    tx.putSession({ ...before, state: 'finished', revision: before.revision + 1, finishedAt: now });
    tx.deleteReservation('worker-run');
    if (fail) throw new Error('injected finalization failure');
  });
  assert.throws(() => finalize(true), /injected finalization failure/);
  assert.deepEqual(f.sessions.repository.transaction(tx => tx.getSession('worker-run')), before);
  assert.deepEqual(f.reminders.repository.transaction(tx => tx.get(reminder.id)), reminder);
  assert.equal(sql(f.path, db => db.prepare("SELECT count(*) AS amount FROM admission_reservations WHERE run_id = 'worker-run'").get()!.amount), 1);
  finalize(false);
  assert.equal(f.sessions.repository.transaction(tx => tx.getSession('worker-run'))?.state, 'finished');
  assert.equal(f.reminders.repository.transaction(tx => tx.get(reminder.id))?.assignedTo, 'main');
  assert.equal(sql(f.path, db => db.prepare("SELECT count(*) AS amount FROM admission_reservations WHERE run_id = 'worker-run'").get()!.amount), 0);
});

test('integration: success effect uses original ownership and retains closedAt across repeated dispatch', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => {
    tx.save({ ...reminder, assignedTo: 'peer' });
    tx.save({ ...reminder, id: 'peer-reminder', createdFor: 'peer', assignedTo: 'worker' });
  });
  f.sessions.repository.transaction(tx => {
    const current = tx.getSession('worker-run')!;
    tx.putSession({ ...current, result: { status: 'succeeded', response: 'verified upstream', proof: { verified: true } } });
  });
  const effect = handoff();
  effect.payload.end.confirmedSucceeded = true;
  f.sessions.repository.transaction(tx => tx.applyEffects([effect]));
  const closed = f.reminders.repository.transaction(tx => tx.get(reminder.id))!;
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closedAt, now);
  assert.equal(closed.closeReason, 'сесія закінчилась з success');
  assert.equal(f.reminders.repository.transaction(tx => tx.get('peer-reminder'))?.state, 'pending');
  effect.payload.at = '2026-10-22T10:00:00.000Z';
  f.sessions.repository.transaction(tx => tx.applyEffects([effect]));
  assert.equal(f.reminders.repository.transaction(tx => tx.get(reminder.id))?.closedAt, now);
});

test('integration: primary identity is unique and updates replace current state without an audit table', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => tx.save(reminder));
  assert.throws(() => sql(f.path, db => db.exec('INSERT INTO reminders SELECT * FROM reminders')));
  for (let i = 0; i < 25; i++) f.reminders.repository.transaction(tx => tx.save({ ...reminder, text: `current-${i}` }));
  assert.equal(f.reminders.repository.transaction(tx => tx.list()).length, 1);
  assert.equal(f.reminders.repository.transaction(tx => tx.get(reminder.id))?.text, 'current-24');
  const tables = sql(f.path, db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all());
  assert.equal(tables.some(row => /audit|history|domain_effects/i.test(String(row.name))), false);
});

test('integration: due and closed-retention predicates use indexes over a representative persisted collection', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => {
    for (let i = 0; i < 2000; i++) tx.save({ ...reminder, id: `closed-${i}`, state: 'closed', closedAt: '2026-10-18T10:00:00.000Z', closeReason: 'done' });
    for (let i = 0; i < 1000; i++) tx.save({ ...reminder, id: `future-${i}` });
    tx.save({ ...reminder, id: 'due-now', at: now });
  });
  sql(f.path, db => {
    for (const query of ["SELECT id FROM reminders WHERE state = 'pending' AND at <= ?", "SELECT id FROM reminders WHERE state = 'closed' AND closed_at < ?"]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(now);
      assert.match(plan.map(row => String(row.detail)).join('\n'), /SEARCH .* USING (?:COVERING )?INDEX/i);
    }
    assert.deepEqual(db.prepare("SELECT id FROM reminders WHERE state = 'pending' AND at <= ?").all(now).map(row => row.id), ['due-now']);
  });
});

test('integration: closed reminders persist beyond session retention and prune only after 48 hours', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => {
    tx.save({ ...reminder, state: 'closed', closedAt: now, closeReason: 'done' });
    tx.save({ ...reminder, id: 'old-open', at: '2020-01-01T00:00:00.000Z' });
  });
  f.sessions.repository.transaction(tx => tx.deleteSession('worker-run'));
  f.setTime('2026-10-22T10:00:00.001Z');
  assert.deepEqual(f.service.pruneClosed(), []);
  assert.ok(f.reminders.repository.transaction(tx => tx.get(reminder.id)));
  f.setTime('2026-10-23T09:59:59.999Z');
  assert.deepEqual(f.service.pruneClosed(), []);
  f.setTime('2026-10-23T10:00:00.001Z');
  assert.deepEqual(f.service.pruneClosed(), [reminder.id]);
  const reopened = openReminderRepository(f.path);
  try {
    assert.equal(reopened.repository.transaction(tx => tx.get(reminder.id)), undefined);
    assert.equal(reopened.repository.transaction(tx => tx.get('old-open'))?.state, 'pending');
  } finally {
    reopened.close();
  }
});

test('integration: a supplied success flag cannot close reminders without an accepted session result', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => tx.save(reminder));
  const effect = handoff();
  effect.payload.end.confirmedSucceeded = true;
  assert.throws(() => f.sessions.repository.transaction(tx => tx.applyEffects([effect])));
  assert.deepEqual(f.reminders.repository.transaction(tx => tx.get(reminder.id)), reminder);
});

test('integration: a domain effect cannot apply a session outcome to a different address', async t => {
  const f = await fixture(t);
  f.reminders.repository.transaction(tx => tx.save(reminder));
  const effect = handoff();
  effect.payload.end.address = 'peer';
  assert.throws(() => f.sessions.repository.transaction(tx => tx.applyEffects([effect])));
  assert.deepEqual(f.reminders.repository.transaction(tx => tx.get(reminder.id)), reminder);
});

for (const retainInactiveMain of [true, false]) {
  test(`integration: reminder event for inactive main has no invented run identity (${retainInactiveMain ? 'finished main retained' : 'finished main removed'})`, async t => {
    const f = await fixture(t);
    if (!retainInactiveMain) f.sessions.repository.transaction(tx => tx.deleteSession('main-run'));
    f.reminders.repository.transaction(tx => {
      tx.save({ ...reminder, assignedTo: 'main' });
      tx.emit({ kind: 'fixture.changed', id: reminder.id });
    });
    const reopened = openSessionRepository(f.path);
    try {
      const intents = reopened.repository.transaction(tx => tx.listPending());
      assert.equal(intents.length, 1);
      const intent = intents[0];
      assert.equal(intent.runId, null);
      assert.equal(intent.event, 'fixture.changed');
      const payload = intent.payload as { address: string; id: string };
      assert.equal(payload.address, 'main');
      assert.equal(payload.id, reminder.id);
      assert.equal(sql(f.path, db => db.prepare('SELECT run_id FROM pending_intents WHERE id = ?').get(intent.id)!.run_id), null);
      const sessions = reopened.repository.transaction(tx => tx.listSessions());
      assert.equal(sessions.some(row => row.runId === 'main'), false);
      assert.equal(sessions.filter(row => row.addressId === 'main').length, retainInactiveMain ? 1 : 0);
    } finally {
      reopened.close();
    }
  });
}
