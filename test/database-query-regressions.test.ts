import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { initializeQaStartupContext } from './startup-context-qa-fixture.ts';
import { DatabaseSync } from 'node:sqlite';
import { openBugStore } from '../src/bug-store.ts';
import { observeDatabaseReads, type DatabaseReadExecution } from './database-read-observer.ts';
import { recordHealthEvent, readHealthSources } from '../src/health-summary-storage.ts';
import { fixture, seedMain10 } from './state-migration-fixture.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { sqliteTestRunState } from '../src/test-run-runtime.ts';
import { createV1BugDatabase } from './bug-store-v1-fixture.ts';

test('QA fixture initializes the lazy startup-context schema before seeding completions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raf-qa-startup-schema-'));
  const state = openStateStore(join(directory, 'state.sqlite'));
  try {
    const db = initializeQaStartupContext(state.startupContextDatabase);
    const columns = db.prepare('PRAGMA table_info(startup_context_completions)').all();
    assert.ok(columns.some(column => column.name === 'run_id'), 'Fresh state store needs startup-context initialization before fixture inserts');
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bug v1 migration preserves 120 bugs with indexed paged reads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raf-qa-bug-migration-'));
  const path = join(directory, 'bugs.sqlite');
  try {
    createV1BugDatabase(path, { sectionId: 'fixture', project: 'raf', env: 'prod', canonicalProject: 'raf', rawId: '1', claimToken: 'fixture', at: '2026-11-05T00:00:00Z' });
    const seed = new DatabaseSync(path);
    try {
      const insert = seed.prepare(`INSERT INTO bugs(section_id,project,env,source,owner,raw_id,problem_id,canonical_project,revision,status,state,presence)
        VALUES ('fixture','raf','prod','qa','owner-1',?,?,'raf',1,'new','new','present')`);
      for (let id = 2; id <= 120; id++) insert.run(String(id), `problem-${id}`);
    } finally { seed.close(); }
    const reads: DatabaseReadExecution[] = [];
    let bugs: ReturnType<typeof openBugStore> | undefined;
    assert.doesNotThrow(() => { bugs = observeDatabaseReads(() => openBugStore(path), read => reads.push(read)); }, 'Migration must work on a representative database while preserving all rows');
    try {
      assert.equal(bugs!.schemaVersion(), 2);
      assert.equal(bugs!.presentBugKeys('fixture').length, 120);
      assert.ok(reads.length > 0);
      assert.ok(reads.every(read => read.rowsRead <= 50));
    } finally { bugs?.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('result notice listing removes only delivered orphans using paged reads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raf-qa-result-notices-'));
  const store = openStateStore(join(directory,'state.sqlite'));
  try {
    const db = store.startupContextDatabase;
    db.prepare("INSERT INTO sessions(run_id,address_id,state,payload) VALUES ('retained','retained','finished','{}')").run();
    const insert=db.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES (?,?,?)');
    const expected:string[]=[];
    for(let i=0;i<120;i++) {
      const id=`notice-${i}`, state=i%3===0?'pending':'delivered', runId=i%3===1?'retained':'orphan';
      insert.run(id,runId,JSON.stringify({id,state}));
      if(state==='pending'||runId==='retained') expected.push(id);
    }
    const reads:DatabaseReadExecution[]=[];
    let notices:any[]=[];
    assert.doesNotThrow(()=>{notices=observeDatabaseReads(()=>store.resultNotices.list(),r=>reads.push(r));});
    assert.deepEqual(notices.map(n=>n.id),expected);
    assert.ok(reads.every(r=>r.rowsRead<=50));
    assert.deepEqual(store.resultNotices.list().map(n=>n.id),expected);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});


test('test-run group lists preserve project and workspace selection at representative volume', async () => {
  const directory=mkdtempSync(join(tmpdir(),'raf-qa-test-groups-'));
  const store=openStateStore(join(directory,'state.sqlite'));
  try {
    const insert=store.startupContextDatabase.prepare('INSERT INTO test_run_groups(project,workspace,group_id,payload) VALUES (?,?,?,?)');
    for(let i=0;i<180;i++) insert.run(i%2?'raf':'other',i<120?'target':'unrelated',String(i),JSON.stringify({id:i}));
    const reads:DatabaseReadExecution[]=[];
    const results=await observeDatabaseReads(()=>sqliteTestRunState(store).transaction(tx=>[tx.list('raf','target'),tx.list('','target'),tx.list('missing','target')]),r=>reads.push(r));
    assert.equal(results[0].length,60);assert.equal(results[1].length,120);assert.equal(results[2].length,0);
    assert.ok(reads.every(r=>r.rowsRead<=50));
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});


test('health event accounting reads a large schema catalog using an indexed schema lookup', () => {
  const directory=mkdtempSync(join(tmpdir(),'raf-qa-health-schema-'));
  const path=join(directory,'state.sqlite');
  const store=openStateStore(path);
  try {
    const seed=new DatabaseSync(path);
    try {for(let i=0;i<60;i++)seed.exec(`CREATE TABLE unrelated_${i}(value TEXT)`);} finally {seed.close();}
    const reads:DatabaseReadExecution[]=[];
    assert.doesNotThrow(()=>observeDatabaseReads(()=>recordHealthEvent(store.startupContextDatabase,'qa.health'),r=>reads.push(r)));
    const now=new Date().toISOString();
    const sources=readHealthSources(store.startupContextDatabase,now,now,store.healthCpu.readProfile(),{health:{cpuThresholdCores:1}});
    assert.equal(sources.eventsByType.value?.['qa.health'],1);
    assert.ok(reads.every(r=>r.rowsRead<=50));
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

for (const count of [0,120]) test(`schema 10 migration preserves ${count} reservations with paged reads`, t => {
  const f=fixture(t);
  seedMain10(f,f.qaStatePath);
  const seed=new DatabaseSync(f.qaStatePath);
  try {
    seed.exec("INSERT INTO sessions(run_id,address_id,state,payload) VALUES ('fixture','fixture','running','{}')");
    seed.exec("INSERT INTO task_reservation_runs VALUES ('fixture','fixture','fixture',0,'fixture','fixture','running','{}',NULL,NULL)");
    const insert=seed.prepare('INSERT INTO task_reservations VALUES (?,?,?,?,?,?)');
    for(let i=0;i<count;i++) insert.run('raf','fixture',String(i),'change','fingerprint','fixture');
  } finally {seed.close();}
  const reads:DatabaseReadExecution[]=[];
  let store:ReturnType<typeof openStateStore>|undefined;
  assert.doesNotThrow(()=>observeDatabaseReads(()=>{store=openStateStore(f.qaStatePath,{context:resolveStateContext(f.request()),transfer:{statePath:f.qaStatePath,fromVersion:10,toVersion:STATE_SCHEMA_VERSION}});},r=>reads.push(r)));
  try {
    const rows=new DatabaseSync(f.qaStatePath,{readOnly:true});
    try {assert.equal(rows.prepare('SELECT count(*) AS count FROM task_reservations').get()!.count,count);assert.equal(rows.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');} finally {rows.close();}
    assert.ok(reads.length>0);
    assert.ok(reads.every(r=>r.rowsRead<=50));
  } finally {store?.close();}
});
