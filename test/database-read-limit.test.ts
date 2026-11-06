import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { assertRowsRead, guardDatabase, observeDatabaseReads, withDatabaseReadQuery,
  type DatabaseReadExecution, type DatabaseReadLimitError, type DatabaseReadQuery } from '../src/database-read-limit.ts';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { openBugStore } from '../src/bug-store.ts';
import { readHealthSummary } from '../src/health-summary-storage.ts';
import { pendingStartupContextRunIds } from '../src/startup-context.ts';
import { createV1BugDatabase } from './bug-store-v1-fixture.ts';
import { fixture as migrationFixture } from './state-migration-fixture.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { migrateState } from '../src/state-migration.ts';

const query: DatabaseReadQuery = { queryId: 'raf.read-limit.fixture', callsite: 'test/database-read-limit.test.ts' };

function exceeds(action: () => unknown, description?: DatabaseReadQuery, limit = 50): DatabaseReadLimitError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error, 'A read above the query budget must fail before returning a result');
  const error = caught as DatabaseReadLimitError;
  assert.equal(error.code, 'DB_ROWS_READ_LIMIT_EXCEEDED');
  assert.ok(error.queryId.length > 0);
  assert.ok(error.callsite.length > 0);
  assert.ok(error.rowsRead > limit);
  assert.equal(error.limit, limit);
  if (description) {
    assert.equal(error.queryId, description.queryId);
    assert.equal(error.callsite, description.callsite);
  }
  return error;
}

function database(t: TestContext, count = 80): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, category INTEGER, secret TEXT); CREATE INDEX records_category ON records(category)');
  const insert = db.prepare('INSERT INTO records VALUES (?, ?, ?)');
  for (let id = 1; id <= count; id++) insert.run(id, 1, 'private-value');
  return db;
}

function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'raf-read-limit-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function tracked<T>(action: () => T): { result: T; reads: DatabaseReadExecution[] } {
  const reads: DatabaseReadExecution[] = [];
  const result = observeDatabaseReads(action, execution => reads.push(execution));
  assert.ok(reads.length > 0, 'The real SQL path must publish execution metrics');
  for (const read of reads) {
    assert.equal(read.metric, 'SQLITE_STMTSTATUS_FULLSCAN_STEP_AND_RESULT_ROWS');
    assert.equal(read.rowsRead, Math.max(read.returnedRows, read.fullscanSteps + 1));
    assert.ok(Number.isSafeInteger(read.rowsRead) && read.rowsRead >= 0);
    assert.ok(read.rowsRead <= read.limit);
    assert.ok(read.queryId.length > 0 && read.callsite.length > 0);
  }
  return { result, reads };
}

for (const rows of [0, 49, 50]) {
  test(`shared matrix accepts ${rows} actual rows`, () => assert.doesNotThrow(() => assertRowsRead(query, rows)));
}
test('shared matrix rejects 51 actual rows with stable diagnostic fields', () => {
  const error = exceeds(() => assertRowsRead(query, 51), query);
  assert.equal(error.rowsRead, 51);
});
for (const limit of [7, 75]) {
  const description = { ...query, rowsReadLimit: limit, justification: 'The caller needs this bounded fixture page.' };
  test(`shared matrix permits justified equality at ${limit}`, () => assert.doesNotThrow(() => assertRowsRead(description, limit)));
  test(`shared matrix rejects justified limit ${limit} plus one`, () => {
    assert.equal(exceeds(() => assertRowsRead(description, limit + 1), description, limit).rowsRead, limit + 1);
  });
}
for (const environment of ['test', 'development', 'production']) {
  test(`guard is enforced in ${environment}`, t => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = environment;
    t.after(() => {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    });
    exceeds(() => assertRowsRead(query, 51), query);
  });
}
for (const method of ['all', 'get', 'iterate', 'run', 'exec'] as const) {
  test(`direct ${method} detects unindexed full scan before successful return`, t => {
    const db = guardDatabase(database(t));
    const sql = 'SELECT count(secret) AS n FROM records NOT INDEXED WHERE category=1';
    exceeds(() => withDatabaseReadQuery(db, query, () => {
      if (method === 'exec') return db.exec(sql);
      const statement = db.prepare(sql);
      if (method === 'iterate') return [...statement.iterate()];
      return statement[method]();
    }), query);
  });
}
for (const sql of [
  'SELECT id FROM records NOT INDEXED WHERE secret = \'absent\' LIMIT 1',
  'SELECT sum(id) AS n FROM records',
  'UPDATE records SET secret=secret WHERE secret=\'absent\'',
]) {
  test(`fullscan proxy detects ${sql}`, t => {
    const db = guardDatabase(database(t));
    exceeds(() => withDatabaseReadQuery(db, query, () => db.prepare(sql).all()), query);
  });
}
test('indexed aggregate exposes proxy components without claiming hidden visits', t => {
  const db = guardDatabase(database(t));
  const { result, reads } = tracked(() => withDatabaseReadQuery(db, query,
    () => db.prepare('SELECT count(*) AS n FROM records INDEXED BY records_category WHERE category=1').get()));
  assert.equal(result?.n, 80);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].returnedRows, 1);
  assert.equal(reads[0].fullscanSteps, 0);
  assert.equal(reads[0].rowsRead, 1);
});
for (const count of [49, 50, 51]) {
  test(`unindexed aggregate applies FULLSCAN_STEP plus one at ${count} rows`, t => {
    const db = guardDatabase(database(t, count));
    const action = () => withDatabaseReadQuery(db, query,
      () => db.prepare('SELECT count(secret) AS n FROM records NOT INDEXED').get());
    if (count > 50) assert.equal(exceeds(action, query).rowsRead, count);
    else {
      const { result, reads } = tracked(action);
      assert.equal(result?.n, count);
      assert.equal(reads[0].returnedRows, 1);
      assert.equal(reads[0].fullscanSteps, count - 1);
      assert.equal(reads[0].rowsRead, count);
    }
  });
}
test('diagnostics do not disclose bound values or row contents', t => {
  const db = guardDatabase(database(t));
  const error = exceeds(() => withDatabaseReadQuery(db, query, () => db.prepare('SELECT id FROM records WHERE secret=?').all('private-value')), query);
  assert.ok(!JSON.stringify(error).includes('private-value'));
  assert.ok(!error.message.includes('private-value'));
});
test('indexed point read in a large table stays within the proxy budget', t => {
  const db = guardDatabase(database(t, 120));
  const { result, reads } = tracked(() => withDatabaseReadQuery(db, query, () => db.prepare('SELECT secret FROM records WHERE id=?').get(119)));
  assert.equal(result?.secret, 'private-value');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].rowsRead, 1);
});
test('empty point lookup records the conservative FULLSCAN_STEP plus one proxy', t => {
  const db = guardDatabase(database(t));
  const { result, reads } = tracked(() => withDatabaseReadQuery(db, query, () => db.prepare('SELECT id FROM records WHERE id=?').get(999)));
  assert.equal(result, undefined);
  assert.equal(reads[0].returnedRows, 0);
  assert.equal(reads[0].fullscanSteps, 0);
  assert.equal(reads[0].rowsRead, 1);
});
test('cached bound statement resets metrics for every execution', t => {
  const db = guardDatabase(database(t));
  const statement = db.prepare('SELECT id FROM records WHERE id<=?');
  const { reads } = tracked(() => {
    for (const count of [49, 50, 49]) assert.equal(statement.all(count).length, count);
  });
  assert.deepEqual(reads.map(read => read.rowsRead), [49, 50, 49]);
  exceeds(() => statement.all(51));
  assert.equal(statement.all(1).length, 1);
});
test('multi-statement exec does not average away one excess', t => {
  const db = guardDatabase(database(t));
  exceeds(() => db.exec('SELECT id FROM records WHERE id=1; SELECT sum(id) FROM records; SELECT 1;'));
});
test('multi-statement exec permits two individually bounded reads', t => {
  const db = guardDatabase(database(t));
  const { reads } = tracked(() => db.exec('SELECT id FROM records WHERE id<=49; SELECT id FROM records WHERE id<=50;'));
  assert.deepEqual(reads.map(read => read.rowsRead), [49, 50]);
});
test('double installation preserves one execution and native result shape', t => {
  const native = database(t);
  const db = guardDatabase(guardDatabase(native));
  let calls = 0;
  db.function('count_call', () => ++calls);
  const { result, reads } = tracked(() => db.prepare('SELECT count_call() AS n').get());
  assert.equal(result?.n, 1);
  assert.equal(calls, 1);
  assert.equal(reads.length, 1);
});
for (const limit of [7, 75]) {
  test(`native execution respects justified per-query limit ${limit}`, t => {
    const db = guardDatabase(database(t));
    const description = { ...query, rowsReadLimit: limit, justification: 'Bounded export page required by this caller.' };
    assert.equal(withDatabaseReadQuery(db, description, () => db.prepare('SELECT id FROM records WHERE id<=?').all(limit)).length, limit);
    exceeds(() => withDatabaseReadQuery(db, description, () => db.prepare('SELECT id FROM records WHERE id<=?').all(limit + 1)), description, limit);
    exceeds(() => db.prepare('SELECT id FROM records WHERE id<=51').all());
  });
}
for (const kind of ['state', 'bugs'] as const) {
  test(`${kind} factory guards exported DatabaseSync without caller installation`, t => {
    const path = join(directory(t), `${kind}.sqlite`);
    const store = kind === 'state' ? openStateStore(path) : openBugStore(path);
    t.after(() => store.close());
    const db = 'startupContextDatabase' in store ? store.startupContextDatabase : store.database;
    db.exec('CREATE TABLE read_probe(id INTEGER PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO read_probe VALUES (?, ?)');
    for (let id = 1; id <= 80; id++) insert.run(id, 'value');
    exceeds(() => db.prepare('SELECT count(value) FROM read_probe').get());
    exceeds(() => db.exec('SELECT sum(id) FROM read_probe'));
  });
}
test('state lists preserve all records beyond one query budget', t => {
  const store = openStateStore(join(directory(t), 'state.sqlite'));
  t.after(() => store.close());
  const insert = store.startupContextDatabase.prepare('INSERT INTO pending_intents(id,payload) VALUES (?,?)');
  const expected = Array.from({ length: 120 }, (_, id) => ({ id: `pending-${id}`, runId: null, event: 'fixture', payload: {} }));
  for (const value of expected) insert.run(value.id, JSON.stringify(value));
  const { result } = tracked(() => store.sessionRepository.transaction(tx => tx.listPending()));
  assert.deepEqual([...result].sort((a,b) => a.id.localeCompare(b.id)), expected.sort((a,b) => a.id.localeCompare(b.id)));
});
test('bug section list preserves all records beyond one query budget', t => {
  const store = openBugStore(join(directory(t), 'bugs.sqlite'));
  t.after(() => store.close());
  for (let id = 0; id < 120; id++) store.upsertSection({ sectionId: `section-${id}`, project: `project-${id}`, env: 'prod', stand: 'prod', canonicalProject: `project-${id}`, origin: 'https://example.test', actor: 'fixture', claimsFingerprint: 'fixture' });
  const { result } = tracked(() => store.sections());
  assert.equal(result.length, 120);
  assert.equal(new Set(result.map(section => section.sectionId)).size, 120);
});
test('startup-context accepts a supplied DatabaseSync and preserves all pending IDs', t => {
  const db = database(t);
  assert.deepEqual(pendingStartupContextRunIds(db), []);
  const insert = db.prepare('INSERT INTO startup_context_completions(run_id) VALUES (?)');
  const expected = Array.from({ length: 120 }, (_, id) => `run-${id}`);
  for (const id of expected) insert.run(id);
  const { result } = tracked(() => pendingStartupContextRunIds(db));
  assert.deepEqual(result, expected);
});
test('health storage guards hidden scan on a supplied DatabaseSync', t => {
  const db = database(t);
  db.exec(`CREATE VIEW raf_health_summary AS SELECT 1 AS singleton, '{}' AS payload FROM records NOT INDEXED WHERE id+0=80`);
  exceeds(() => readHealthSummary(db));
});
test('new state migrations emit guarded SQL proxy metrics before handle delivery', t => {
  const { result: store } = tracked(() => openStateStore(join(directory(t), 'state.sqlite')));
  t.after(() => store.close());
  assert.equal(store.startupContextDatabase.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
});
test('bug v1 migration and reopened connection remain guarded', t => {
  const path = join(directory(t), 'bugs.sqlite');
  createV1BugDatabase(path, { sectionId: 'fixture', project: 'raf', env: 'prod', canonicalProject: 'raf', rawId: '1', claimToken: 'fixture', at: '2026-11-05T00:00:00Z' });
  const { result: store } = tracked(() => openBugStore(path));
  t.after(() => store.close());
  assert.equal(store.schemaVersion(), 2);
  const db = store.database;
  db.exec('CREATE TABLE read_probe(id INTEGER PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO read_probe VALUES (?)');
  for (let id = 1; id <= 80; id++) insert.run(id);
  exceeds(() => db.prepare('SELECT sum(id) FROM read_probe').get());
});

test('maintenance backup source and copy connections expose SQL proxy metrics', async t => {
  const fixture = migrationFixture(t);
  const context = resolveStateContext(fixture.request());
  const source = openStateStore(context.statePath);
  withDatabaseReadQuery(source.startupContextDatabase, {
    queryId: 'raf.read-limit.fixture.drop-old-schema', callsite: 'test/database-read-limit.test.ts',
    rowsReadLimit: 100,
    justification: 'This maintenance fixture drops one known table; SQLite scans the bounded migration schema catalog (51 proxy reads).',
  }, () => source.startupContextDatabase.exec('DROP TABLE raf_forced_close_metrics'));
  source.startupContextDatabase.exec('PRAGMA user_version=17');
  source.close();
  const reads: DatabaseReadExecution[] = [];
  const backupPath = join(fixture.root, 'read-limit-backup.sqlite');
  const result = await observeDatabaseReads(() => migrateState({ context, statePath: context.statePath,
    fromVersion: 17, toVersion: STATE_SCHEMA_VERSION, backupPath }, { async inspectClients() { return 'quiescent'; } }),
    execution => reads.push(execution));
  assert.equal(result.applied, true);
  assert.ok(reads.filter(read => read.callsite.includes('state-migration.ts')).length >= 3,
    'Source, backup copy, and final integrity connections must all use the guard');
  for (const read of reads) {
    assert.equal(read.metric, 'SQLITE_STMTSTATUS_FULLSCAN_STEP_AND_RESULT_ROWS');
    assert.equal(read.rowsRead, Math.max(read.returnedRows, read.fullscanSteps + 1));
    assert.ok(read.rowsRead >= 0 && read.rowsRead <= read.limit);
  }
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try { assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 17); }
  finally { copy.close(); }
});
