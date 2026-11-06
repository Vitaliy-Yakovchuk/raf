import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { observeDatabaseReads, type DatabaseReadExecution } from '../src/database-read-limit.ts';
import { openStateStore, STATE_SCHEMA_VERSION, type StateStore } from '../src/state-store.ts';
import type { SessionRecord } from '../src/session-state.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-notice-run-index-'));
  const path = join(root, 'state.sqlite');
  const stores: StateStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { path, open(options?: Parameters<typeof openStateStore>[1]) {
    const store = openStateStore(path, options);
    stores.push(store);
    return store;
  } };
}

function seedNotices(db: DatabaseSync) {
  const insert = db.prepare('INSERT INTO result_notices(id, run_id, payload) VALUES (?, ?, ?)');
  try {
    for (let index = 0; index < 120; index++) {
      const source = { runId: `other-${index}`, state: 'running', revision: 1 };
      insert.run(`other-${index}`, source.runId, JSON.stringify({ source, text: `preserve-${index}` }));
    }
    for (const id of ['target-result', 'target-rejection']) {
      insert.run(id, 'target', JSON.stringify({ source: { runId: 'target', state: 'exited', revision: 2 }, text: id }));
    }
  } finally { insert.close(); }
}

function finishSession(store: StateStore) {
  const session: SessionRecord = { runId: 'target', addressId: 'worker', state: 'finished', revision: 3, finishedAt: '2026-11-06T12:00:00Z' };
  const reads: DatabaseReadExecution[] = [];
  assert.doesNotThrow(() => observeDatabaseReads(() => store.sessionRepository.transaction(tx => tx.putSession(session)), read => reads.push(read)));
  assert.ok(reads.length > 0);
  for (const read of reads) {
    assert.equal(read.limit, 50);
    assert.ok(read.rowsRead <= 50, JSON.stringify(read));
  }
  assert.deepEqual(store.sessionRepository.transaction(tx => tx.getSession('target')), session);
  const db = store.startupContextDatabase;
  for (const id of ['target-result', 'target-rejection']) {
    const notice = JSON.parse(db.prepare('SELECT payload FROM result_notices WHERE id = ?').get(id)!.payload as string);
    assert.deepEqual(notice, { source: { runId: 'target', state: 'finished', revision: 3, finishedAt: session.finishedAt }, text: id });
  }
  for (let index = 0; index < 120; index++) {
    const notice = JSON.parse(db.prepare('SELECT payload FROM result_notices WHERE id = ?').get(`other-${index}`)!.payload as string);
    assert.deepEqual(notice, { source: { runId: `other-${index}`, state: 'running', revision: 1 }, text: `preserve-${index}` });
  }
}

test('new state finishes a session among more than 50 notices without a full scan', t => {
  const f = fixture(t);
  const store = f.open();
  seedNotices(store.startupContextDatabase);
  finishSession(store);
});

for (const existingIndex of [false, true]) {
  test(`schema 18 to current indexes more than 50 notices with existing index=${existingIndex} and reopens idempotently`, t => {
    const f = fixture(t);
    openStateStore(f.path).close();
    const seed = new DatabaseSync(f.path);
    try {
      seed.exec('DROP INDEX IF EXISTS result_notices_run_id; DROP INDEX IF EXISTS sessions_address_state; PRAGMA user_version = 18');
      seedNotices(seed);
      if (existingIndex) seed.exec('CREATE INDEX result_notices_run_id ON result_notices(run_id)');
    } finally { seed.close(); }
    const steps: number[] = [];
    const transfer = { statePath: f.path, fromVersion: 18, toVersion: STATE_SCHEMA_VERSION };
    let store!: StateStore;
    assert.doesNotThrow(() => { store = f.open({ transfer, afterMigrationStep: version => steps.push(version) }); });
    assert.deepEqual(steps, [19, 20]);
    const db = store.startupContextDatabase;
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, STATE_SCHEMA_VERSION);
    const indexes = db.prepare('PRAGMA index_list(result_notices)').all().filter(index => index.name === 'result_notices_run_id');
    assert.equal(indexes.length, 1);
    assert.equal(db.prepare('PRAGMA index_info(result_notices_run_id)').get()!.name, 'run_id');
    finishSession(store);
    const schemaRevision = db.prepare('PRAGMA schema_version').get()!.schema_version;
    for (const options of [{ transfer }, {}]) {
      const reopened = f.open({ ...options, afterMigrationStep: () => assert.fail('migration replayed') });
      assert.equal(reopened.startupContextDatabase.prepare('PRAGMA schema_version').get()!.schema_version, schemaRevision);
      finishSession(reopened);
    }
  });
}
