import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../src/state-store.ts';
import { openBugStore } from '../src/bug-store.ts';
import { guardDatabase, observeDatabaseReads, readDatabaseTable, type DatabaseReadExecution } from '../src/database-read-limit.ts';
import { pendingStartupContextRunIds } from '../src/startup-context.ts';
import { ResourceUsageRepository } from '../src/resource-usage.ts';

const directory = mkdtempSync(join(tmpdir(), 'raf-read-measure-'));
const count = 120;
const metrics: Record<string, unknown> = { runtime: process.version, count,
  metric: 'SQLITE_STMTSTATUS_FULLSCAN_STEP_AND_RESULT_ROWS',
  limitations: 'Proxy only. Hidden visits in indexed filters, indexed aggregates and joins are not measured. Zero fullscanStep does not prove zero work.' };
function before(database: DatabaseSync, sql: string) {
  const statement = DatabaseSync.prototype.prepare.call(database, sql);
  try {
    statement.resetStats();
    const rows = statement.all();
    const fullscanSteps = statement.stat('fullscanStep');
    return { fullscanSteps, returnedRows: rows.length, proxy: Math.max(rows.length, fullscanSteps + 1) };
  } finally { statement.close(); }
}
function measured(action: () => unknown) {
  const executions: DatabaseReadExecution[] = [];
  const result = observeDatabaseReads(action, execution => executions.push(execution));
  return { resultCount: Array.isArray(result) ? result.length : null, executions,
    maxProxy: Math.max(0, ...executions.map(execution => execution.rowsRead)) };
}
try {
  const startup: DatabaseReadExecution[] = [];
  const state = observeDatabaseReads(() => openStateStore(join(directory, 'state.sqlite')), execution => startup.push(execution));
  try {
    const db = state.startupContextDatabase;
    const insert = db.prepare('INSERT INTO pending_intents(id,payload) VALUES (?,?)');
    for (let id = 0; id < count; id++) insert.run(`pending-${id}`, JSON.stringify({ id: `pending-${id}`, runId: null, event: 'fixture', payload: {} }));
    metrics.pendingIntents = { before: before(db, 'SELECT payload FROM pending_intents'), after: measured(() => state.sessionRepository.transaction(tx => tx.listPending(), 'read')) };
    pendingStartupContextRunIds(db);
    const completion = db.prepare('INSERT INTO startup_context_completions(run_id) VALUES (?)');
    for (let id = 0; id < count; id++) completion.run(`run-${id}`);
    metrics.startupContext = { before: before(db, 'SELECT run_id FROM startup_context_completions WHERE event_id IS NULL ORDER BY sequence'), after: measured(() => pendingStartupContextRunIds(db)) };
    const usage = new ResourceUsageRepository(db);
    const insertUsage = db.prepare('INSERT INTO resource_usage(kind,run_id,payload) VALUES (?,?,?)');
    for (let id = 0; id < count; id++) insertUsage.run('agent', `agent-${id}`, JSON.stringify({ finishedAt: null }));
    metrics.resourceUsage = { before: before(db, "SELECT payload FROM resource_usage WHERE json_extract(payload, '$.finishedAt') IS NULL"), after: measured(() => usage.listActive()) };
    metrics.schemaMigration = { executionsAboveDefault: startup.filter(execution => execution.rowsRead > 50),
      maxProxy: Math.max(...startup.map(execution => execution.rowsRead)) };
  } finally { state.close(); }
  const bugs = openBugStore(join(directory, 'bugs.sqlite'));
  try {
    for (let id = 0; id < count; id++) bugs.upsertSection({ sectionId: `section-${id}`, project: `project-${id}`, env: 'prod', stand: 'prod', canonicalProject: 'raf', origin: 'https://example.test', actor: 'fixture', claimsFingerprint: 'fixture' });
    metrics.bugSections = { before: before(bugs.database, 'SELECT * FROM sections ORDER BY section_id'), after: measured(() => bugs.sections()) };
  } finally { bugs.close(); }
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, category INTEGER, value TEXT); CREATE INDEX records_category ON records(category)');
    const insert = db.prepare('INSERT INTO records VALUES (?,1,?)');
    for (let id = 1; id <= 1000; id++) insert.run(id, 'fixture');
    metrics.pointLookup = { before: before(db, 'SELECT value FROM records NOT INDEXED WHERE id+0=1000 LIMIT 1'), after: before(db, 'SELECT value FROM records WHERE id=1000 LIMIT 1') };
    metrics.indexedHiddenScanLimitation = before(db, "SELECT id FROM records INDEXED BY records_category WHERE category=1 AND value='absent' LIMIT 1");
    metrics.boundedPages = measured(() => readDatabaseTable(guardDatabase(db), 'records'));
    metrics.compileOptions = DatabaseSync.prototype.prepare.call(db, 'PRAGMA compile_options').all();
  } finally { db.close(); }
  writeFileSync(process.argv[2], JSON.stringify(metrics, null, 2) + '\n');
} finally { rmSync(directory, { recursive: true, force: true }); }
