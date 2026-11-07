import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync, backup } from 'node:sqlite';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openStateStore } from '../src/state-store.ts';
import { openBugStore } from '../src/bug-store.ts';
import { observeDatabaseReads, readDatabaseTable, type DatabaseReadExecution } from '../src/database-read-limit.ts';
import { pendingStartupContextRunIds, listStartupContextReviewEvents, readStartupContextTrace } from '../src/startup-context.ts';
import { readHealthSummary, readHealthSources } from '../src/health-summary-storage.ts';
import { ResourceUsageRepository } from '../src/resource-usage.ts';
import { sqliteTestRunState } from '../src/test-run-runtime.ts';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(workspace, 'evidence/limit-db-rows-read-per-query/qa-2.40-hotfix-real-copy');
test('private real database copies exercise production repository reading paths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'raf-real-copy-'));
  assert.notEqual(home, userInfo().homedir);
  const scenarios: any[] = [];
  const facts: any = { sha: execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8', cwd:workspace}).trim(), node:process.version,
    source:'/srv/dev/raf-guard-copy-20261105', home, scenarios,
    boundary:'Production repository reads only. No live process reconciliation, message delivery, network sync or status writes; working main first-execution remains separate.',
    metric:'max(returnedRows, FULLSCAN_STEP+1); indexed visits beyond returned rows are not measured' };
  async function check(name: string, action: () => unknown) {
    const executions: DatabaseReadExecution[] = [];
    const entry: any = {name, executions, status:'failed'}; scenarios.push(entry);
    try { await observeDatabaseReads(action, read => executions.push(read)); entry.status='passed'; }
    catch(error) {
      const e = error as any;
      entry.error = {code:e.code ?? e.name, ...(e.code === 'DB_ROWS_READ_LIMIT_EXCEEDED' ? {queryId:e.queryId,callsite:e.callsite,rowsRead:e.rowsRead,limit:e.limit} : {})};
    }
  }
  try {
    mkdirSync(join(home,'.raf'));
    const statePath=join(home,'.raf/state.sqlite'), bugPath=join(home,'.raf/bugs.sqlite');
    copyFileSync(join(facts.source,'state.sqlite'),statePath); copyFileSync(join(facts.source,'bugs.sqlite'),bugPath);
    for (const [name,path] of [['state',statePath],['bug',bugPath]]) {
      const db=new DatabaseSync(path);
      try {
        facts[`${name}SchemaBefore`]=db.prepare('PRAGMA user_version').get()?.user_version;
        await backup(db,join(home,`${name}-backup.sqlite`));
        assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
      } finally {db.close();}
      const saved=new DatabaseSync(join(home,`${name}-backup.sqlite`),{readOnly:true});
      try {assert.equal(saved.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');} finally{saved.close();}
    }
    let state: ReturnType<typeof openStateStore> | undefined;
    await check('state startup and supported migration admission',()=>{state=openStateStore(statePath);});
    if(state) {
      try {
        const store=state, db=store.startupContextDatabase;
        facts.stateSchemaAfter=db.prepare('PRAGMA user_version').get()?.user_version;
        await check('agent ps/list session candidates',()=>store.sessionRepository.transaction(tx=>{facts.sessions=tx.listSessions().length; tx.listActiveSessions?.(); tx.listReservations(); tx.listPending();},'read'));
        await check('agent task reservation reconciliation reads',()=>store.taskReservationRepository.transaction(tx=>tx.listTaskReservations()));
        await check('agent result delivery pending reads',()=>store.resultNotices.list());
        await check('reminder list',()=>store.reminderRepository.transaction(tx=>{facts.reminders=tx.list().length;}));
        await check('health',()=>{const now=new Date().toISOString(); readHealthSummary(db); readHealthSources(db,now,now,store.healthCpu.readProfile(),{health:{cpuThresholdCores:1}}); store.readCostProfile(); store.readForcedCloseMetrics(); store.readResourceWaitGrant(); store.getResourceWaitLastGrant(); new ResourceUsageRepository(db).listActive();});
        await check('startup-context pending and review',()=>{pendingStartupContextRunIds(db);listStartupContextReviewEvents(db);});
        await check('startup-context traces',()=>{for(const row of readDatabaseTable(db,'startup_context_traces')) readStartupContextTrace(db,String(row.run_id));});
        const pairs=new Map<string,{project:string,workspace:string}>();
        await check('test-run group inventory',()=>{for(const row of readDatabaseTable(db,'test_run_groups')){const project=String(row.project), workspace=String(row.workspace);pairs.set(JSON.stringify([project,workspace]),{project,workspace});}facts.testRunScopes=pairs.size;});
        let scope=0;
        for(const pair of pairs.values()) await check(`test-run history scope ${++scope}`,()=>sqliteTestRunState(store).transaction(tx=>{tx.list(pair.project,pair.workspace);tx.list('',pair.workspace);}));
      } finally {state.close();}
    }
    let bugs: ReturnType<typeof openBugStore> | undefined;
    await check('bug startup and supported migration admission',()=>{bugs=openBugStore(bugPath);});
    if(bugs) {
      try {
        const store=bugs;
        facts.bugSchemaAfter=store.schemaVersion();
        await check('bug sections and sync status',()=>{const sections=store.sections();facts.sections=sections.length;for(const s of sections){store.syncState(s.sectionId);store.presentBugKeys(s.sectionId);}});
        const keys:string[]=[];
        await check('bug list',()=>{let cursor:string|null=null; do {const page=store.listBugs({limit:50,cursor});keys.push(...page.bugs.map(b=>b.key));cursor=page.nextCursor;}while(cursor);facts.bugs=keys.length;});
        let i=0;
        for(const key of keys) await check(`bug detail/status ${++i}`,()=>store.findBug(key));
        await check('bug pending notices',()=>store.pendingNotices());
      } finally {bugs.close();}
    }
    facts.failed=scenarios.filter(s=>s.status==='failed').length;
    assert.equal(facts.failed,0,`Failed repository scenarios: ${facts.failed}; sanitized evidence: ${evidence}`);
  } finally {
    rmSync(home,{recursive:true,force:true});facts.cleanup=true;
    mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'scenarios.json'),JSON.stringify(facts,null,2)+'\n');
  }
});
