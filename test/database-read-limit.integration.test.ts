import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, release, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { openBugStore } from '../src/bug-store.ts';
import { observeDatabaseReads, withDatabaseReadQuery, type DatabaseReadExecution } from '../src/database-read-limit.ts';
import { pendingStartupContextRunIds } from '../src/startup-context.ts';
import { readHealthSummary } from '../src/health-summary-storage.ts';
import { ResourceUsageRepository } from '../src/resource-usage.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { migrateState } from '../src/state-migration.ts';
import { createV1BugDatabase } from './bug-store-v1-fixture.ts';
import { initializeQaStartupContext } from './database-read-limit-qa-fixture.ts';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(workspace, 'evidence/limit-db-rows-read-per-query/qa-2.40');
const count = 120;

test('file-backed isolated raf lifecycle preserves state and bugs under measured read budgets', async t => {
  const home = mkdtempSync(join(tmpdir(), 'raf-read-limit-integration-'));
  assert.notEqual(home, userInfo().homedir);
  const facts: Record<string, unknown> = {
    environment: { platform: platform(), release: release(), node: process.version, qaHome: home, runnerHome: process.env.HOME,
      workspace, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }) },
    metric: 'max(returnedRows, FULLSCAN_STEP + 1); hidden indexed visits are not measured', count,
    scenarios: [], cleanup: false,
  };
  const scenarios = facts.scenarios as Record<string, unknown>[];
  function measured<T>(name: string, action: () => T): T {
    const executions: DatabaseReadExecution[] = [];
    const scenario: Record<string, unknown> = { name, executions, status: 'failed' };
    scenarios.push(scenario);
    const result = observeDatabaseReads(action, execution => executions.push(execution));
    assert.ok(executions.length > 0);
    for (const read of executions) {
      assert.equal(read.rowsRead, Math.max(read.returnedRows, read.fullscanSteps + 1));
      assert.ok(read.rowsRead <= read.limit, JSON.stringify(read));
    }
    scenario.status = 'passed';
    return result;
  }
  try {
    const context = resolveStateContext({ orchestratorRoot: dirname(workspace), modulePath: join(workspace, 'bin/raf.ts'),
      homeDirectory: home, operatingSystemHome: userInfo().homedir, environment: { RAF_QA_HOME: home, HOME: home }, entryPoint: 'cli' });
    mkdirSync(dirname(context.statePath), { recursive: true });
    let state = measured('new state schema and health initialization', () => openStateStore(context.statePath, { context }));
    try {
      const db = initializeQaStartupContext(state.startupContextDatabase);
      const pending = db.prepare('INSERT INTO pending_intents(id,payload) VALUES (?,?)');
      const completion = db.prepare('INSERT INTO startup_context_completions(run_id) VALUES (?)');
      const usage = db.prepare('INSERT INTO resource_usage(kind,run_id,payload) VALUES (?,?,?)');
      for (let id = 0; id < count; id++) {
        pending.run(`pending-${id}`, JSON.stringify({ id: `pending-${id}`, runId: null, event: 'fixture', payload: {} }));
        completion.run(`run-${id}`);
        usage.run('agent', `agent-${id}`, JSON.stringify({ finishedAt: null }));
      }
      const payloads = measured('state pending intents across pages', () => state.sessionRepository.transaction(tx => tx.listPending(), 'read'));
      assert.equal(payloads.length, count);
      assert.equal(new Set(payloads.map(row => row.id)).size, count);
      assert.deepEqual(measured('startup-context across pages', () => pendingStartupContextRunIds(db)), Array.from({ length: count }, (_, id) => `run-${id}`));
      assert.equal(measured('active resource usage across pages', () => new ResourceUsageRepository(db).listActive()).length, count);
      assert.ok(measured('health summary singleton', () => readHealthSummary(db)).rafInstanceId);
      const controls: Record<string, unknown>[] = [];
      for (const rows of [49, 50, 51]) {
        const executions: DatabaseReadExecution[] = [];
        let error: any;
        let returned: unknown;
        try {
          returned = observeDatabaseReads(() => db.prepare('SELECT run_id FROM startup_context_completions ORDER BY sequence LIMIT ?').all(rows), read => executions.push(read));
        } catch (caught) { error = caught; }
        assert.equal(executions.length, 1);
        assert.equal(executions[0].rowsRead, rows);
        if (rows <= 50) assert.equal((returned as unknown[]).length, rows);
        else {
          assert.equal(returned, undefined);
          assert.equal(error.code, 'DB_ROWS_READ_LIMIT_EXCEEDED');
          assert.equal(error.limit, 50);
          assert.equal(error.rowsRead, 51);
          assert.match(error.callsite, /database-read-limit.integration.test.ts/);
        }
        controls.push({ requested: rows, executions, error: error ? { code: error.code, queryId: error.queryId, callsite: error.callsite, rowsRead: error.rowsRead, limit: error.limit } : null });
      }
      facts.boundaries = controls;
      const scans: DatabaseReadExecution[] = [];
      assert.throws(() => observeDatabaseReads(() => db.prepare('SELECT count(payload) FROM pending_intents NOT INDEXED').get(), read => scans.push(read)), { code: 'DB_ROWS_READ_LIMIT_EXCEEDED', rowsRead: count, limit: 50 });
      facts.hiddenFullScan = scans;
      withDatabaseReadQuery(db, { queryId: 'qa.fixture.v17', callsite: 'test/database-read-limit.integration.test.ts', rowsReadLimit: 100,
        justification: 'Only the isolated fixture schema catalog is scanned while removing the v18 table to exercise maintenance migration.' },
      () => db.exec('DROP TABLE raf_forced_close_metrics; PRAGMA user_version=17'));
    } finally { state.close(); }
    const backupPath = join(home, 'before-migration.sqlite');
    const migrationReads: DatabaseReadExecution[] = [];
    const migration = await observeDatabaseReads(() => migrateState({ context, statePath: context.statePath, fromVersion: 17,
      toVersion: STATE_SCHEMA_VERSION, backupPath }, { async inspectClients() { return 'quiescent'; } }), read => migrationReads.push(read));
    assert.equal(migration.applied, true);
    assert.ok(migrationReads.filter(read => read.callsite.includes('state-migration.ts')).length >= 3);
    assert.ok(migrationReads.every(read => read.rowsRead <= read.limit));
    scenarios.push({ name: 'isolated v17 maintenance migration with backup', status: 'passed', migration, executions: migrationReads,
      limitation: 'Client quiescence supplied for this private DB; no operating runtime was stopped or migrated.' });
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 17);
      assert.equal(backup.prepare('SELECT count(*) AS n FROM pending_intents').get()?.n, count);
      assert.equal(backup.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally { backup.close(); }
    state = measured('reopen migrated state', () => openStateStore(context.statePath, { context }));
    try {
      assert.equal(measured('migrated state preserves pending intents', () => state.sessionRepository.transaction(tx => tx.listPending(), 'read')).length, count);
      assert.equal(measured('migrated startup-context', () => pendingStartupContextRunIds(state.startupContextDatabase)).length, count);
      assert.ok(measured('migrated health summary', () => readHealthSummary(state.startupContextDatabase)).rafInstanceId);
    } finally { state.close(); }
    const bugPath = join(home, '.raf/bugs.sqlite');
    createV1BugDatabase(bugPath, { sectionId: 'fixture', project: 'raf', env: 'prod', canonicalProject: 'raf', rawId: '1', claimToken: 'fixture', at: '2026-11-05T00:00:00Z' });
    const seed = new DatabaseSync(bugPath);
    try {
      const insert = seed.prepare(`INSERT INTO bugs(section_id,project,env,source,owner,raw_id,problem_id,canonical_project,revision,status,state,presence)
        VALUES ('fixture','raf','prod','qa','owner-1',?,?,'raf',1,'new','new','present')`);
      for (let id = 2; id <= count; id++) insert.run(String(id), `problem-${id}`);
    } finally { seed.close(); }
    let bugs = measured('bug v1 to v2 migration with 120 bugs', () => openBugStore(bugPath));
    try {
      assert.equal(bugs.schemaVersion(), 2);
      assert.equal(measured('bug keys preserved after migration', () => bugs.presentBugKeys('fixture')).length, count);
      for (let id = 0; id < count; id++) bugs.upsertSection({ sectionId: `section-${id}`, project: `project-${id}`, env: 'prod', stand: 'prod', canonicalProject: 'raf', origin: 'https://example.test', actor: 'fixture', claimsFingerprint: 'fixture' });
      assert.equal(measured('section list across pages', () => bugs.sections()).length, count + 1);
      assert.throws(() => bugs.database.prepare('SELECT count(raw_id) FROM bugs NOT INDEXED').get(), { code: 'DB_ROWS_READ_LIMIT_EXCEEDED', rowsRead: count });
    } finally { bugs.close(); }
    bugs = measured('reopen bug DB', () => openBugStore(bugPath));
    try { assert.equal(measured('reopened bug keys', () => bugs.presentBugKeys('fixture')).length, count); }
    finally { bugs.close(); }
    facts.status = 'passed';
  } catch (error) {
    facts.status = 'failed';
    facts.failure = { message: String(error), stack: (error as Error).stack };
    throw error;
  } finally {
    rmSync(home, { recursive: true, force: true });
    facts.cleanup = true;
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'isolated-scenarios.json'), JSON.stringify(facts, null, 2) + '\n');
    t.diagnostic(`Full isolated measurements: ${join(evidence, 'isolated-scenarios.json')}`);
  }
});
