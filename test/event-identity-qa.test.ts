import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import type { PendingIntent } from '../src/session-state.ts';

const schema2ClientCommit = 'c2a14864fe5062905c998f2f7d13ced3a3e151bd';
const schema3MigrationCommit = '952eefcd96f9a1bcc3840de0dcc7209ed6f694ce';

async function seedVersion3(directory: string, path: string): Promise<void> {
  const clientTree = join(directory, 'schema-2-client');
  const archivePath = join(directory, 'schema-2-client.tar');
  await mkdir(clientTree);
  const archived = spawnSync('git', ['-C', fileURLToPath(new URL('../', import.meta.url)), 'archive', '--format=tar', '--output', archivePath, schema2ClientCommit, 'src', 'package.json'], { encoding: 'utf8' });
  assert.ifError(archived.error);
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync('tar', ['-xf', archivePath, '-C', clientTree], { encoding: 'utf8' });
  assert.ifError(extracted.error);
  assert.equal(extracted.status, 0, extracted.stderr);
  await rm(archivePath);
  const program = `import { openStateStore } from ${JSON.stringify(pathToFileURL(join(clientTree, 'src', 'state-store.ts')).href)}; const store = openStateStore(process.argv[1]); store.close();`;
  const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', program, path], { encoding: 'utf8' });
  assert.ifError(seeded.error);
  assert.equal(seeded.status, 0, seeded.stderr);
  const old = new DatabaseSync(path);
  try {
    assert.equal(old.prepare('PRAGMA user_version').get()!.user_version, 2, schema2ClientCommit);
    old.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE reminders (
        id TEXT PRIMARY KEY NOT NULL,
        created_for TEXT NOT NULL,
        assigned_to TEXT NOT NULL,
        at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'closed')),
        closed_at TEXT,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX reminders_due ON reminders(state, at);
      CREATE INDEX reminders_retention ON reminders(state, closed_at);
      PRAGMA user_version = 3;
      COMMIT;
    `);
    assert.equal(old.prepare('PRAGMA user_version').get()!.user_version, 3, schema3MigrationCommit);
    assert.deepEqual(old.prepare('PRAGMA table_info(pending_intents)').all().map(row => row.name), ['id', 'payload']);
    assert.deepEqual(old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['admission_reservations', 'command_timings', 'pending_intents', 'quotas', 'reminders', 'runners', 'sessions']);
  } finally { old.close(); }
}

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
    await seedVersion3(directory, path);
    const old = new DatabaseSync(path);
    try {
      old.prepare('INSERT INTO pending_intents(id, payload) VALUES (?, ?)').run(legacy.id, JSON.stringify(legacy));
    } finally { old.close(); }
    const upgraded = openStateStore(path, { transfer: { statePath: path, fromVersion: 3, toVersion: STATE_SCHEMA_VERSION } });
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
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, STATE_SCHEMA_VERSION);
      const row = db.prepare('SELECT run_id, payload FROM pending_intents WHERE id = ?').get(legacy.id)!;
      assert.equal(row.run_id, legacy.runId);
      assert.equal(row.payload, JSON.stringify(legacy));
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
