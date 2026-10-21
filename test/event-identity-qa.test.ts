import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStateStore } from '../src/state-store.ts';
import type { PendingIntent } from '../src/session-state.ts';

for (const finishedMain of [false, true]) test(`QA integration: inactive main event survives complete database close/reopen (${finishedMain})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raf-event-identity-qa-'));
  const path = join(directory, 'state.sqlite');
  try {
    const writer = openStateStore(path);
    try {
      if (finishedMain) writer.sessionRepository.transaction(tx => tx.putSession({ runId: 'old-main-run', addressId: 'main', state: 'finished', revision: 1, finishedAt: '2026-10-21T00:00:00.000Z' }));
      writer.reminderRepository.transaction(tx => {
        tx.save({ id: 'reminder-qa', createdFor: 'worker', assignedTo: 'main', text: 'Unfinished work', at: '2026-10-21T00:00:00.000Z', binding: null, state: 'active', closedAt: null, closeReason: null });
        tx.emit({ kind: 'reminder.active', id: 'reminder-qa' });
      });
    } finally { writer.close(); }
    const expected: PendingIntent = { id: 'reminder.active:reminder-qa', runId: null, event: 'reminder.active', payload: { kind: 'reminder.active', id: 'reminder-qa', address: 'main' } };
    const reader = openStateStore(path);
    try {
      assert.deepEqual(reader.sessionRepository.transaction(tx => tx.listPending()), [expected]);
      assert.equal(reader.sessionRepository.transaction(tx => tx.listSessions()).filter(row => row.state !== 'finished').length, 0);
      reader.sessionRepository.transaction(tx => tx.putPending(expected));
      assert.deepEqual(reader.sessionRepository.transaction(tx => tx.listPending()), [expected]);
    } finally { reader.close(); }
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare('SELECT id, run_id, payload FROM pending_intents').get()!;
      assert.equal(row.id, expected.id);
      assert.equal(row.run_id, null);
      assert.deepEqual(JSON.parse(String(row.payload)), expected);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE run_id = 'main'").get()!.n, 0);
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('QA integration: version 3 pending payload survives migration and coexists with nullable address intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raf-event-migration-qa-'));
  const path = join(directory, 'state.sqlite');
  const legacy: PendingIntent = { id: 'legacy-intent', runId: 'completed-run', event: 'session.finished', payload: { address: 'worker', id: 'work-item', nested: { value: 'unchanged' } } };
  const pending: PendingIntent = { id: 'new-intent', runId: null, event: 'reminder.active', payload: { address: 'main', id: 'new-reminder' } };
  try {
    const initial = openStateStore(path);
    initial.close();
    const old = new DatabaseSync(path);
    try {
      old.exec('ALTER TABLE pending_intents DROP COLUMN run_id; PRAGMA user_version = 3');
      old.prepare('INSERT INTO pending_intents(id, payload) VALUES (?, ?)').run(legacy.id, JSON.stringify(legacy));
    } finally { old.close(); }
    const upgraded = openStateStore(path);
    try {
      assert.deepEqual(upgraded.sessionRepository.transaction(tx => tx.listPending()), [legacy]);
      upgraded.sessionRepository.transaction(tx => tx.putPending(pending));
    } finally { upgraded.close(); }
    const reopened = openStateStore(path);
    try {
      assert.deepEqual(reopened.sessionRepository.transaction(tx => tx.listPending()).sort((a, b) => a.id.localeCompare(b.id)), [legacy, pending]);
      assert.deepEqual(reopened.sessionRepository.transaction(tx => tx.listSessions()), []);
      reopened.sessionRepository.transaction(tx => tx.deletePending(pending.id));
      assert.deepEqual(reopened.sessionRepository.transaction(tx => tx.listPending()), [legacy]);
    } finally { reopened.close(); }
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
      const row = db.prepare('SELECT run_id, payload FROM pending_intents WHERE id = ?').get(legacy.id)!;
      assert.equal(row.run_id, legacy.runId);
      assert.equal(row.payload, JSON.stringify(legacy));
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
