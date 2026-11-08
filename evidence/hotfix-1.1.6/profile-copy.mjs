import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { Session } from 'node:inspector/promises';
const source = process.cwd();
const [label = 'baseline'] = process.argv.slice(2);
const root = '/tmp/frcll-1-1-6/root';
const home = `/tmp/frcll-1-1-6/${label}`;
fs.mkdirSync(join(home,'.raf'), {recursive:true});
process.env.HOME = process.env.RAF_QA_HOME = home;
process.env.RAF_ORCHESTRATOR_ROOT=root;
process.env.PROFILE_TIMELINE=join(source,'evidence/hotfix-1.1.6',`${label}.worker-timeline.jsonl`);
delete process.env.TMUX; delete process.env.TMUX_PANE;
const statePath = join(home,'.raf/state.sqlite');
if (!fs.existsSync('/tmp/frcll-1-1-6/state.sqlite')) {
 const live = new DatabaseSync('/home/dev/.raf/state.sqlite',{readOnly:true});
 await backup(live,'/tmp/frcll-1-1-6/state.sqlite'); live.close();
}
const snapshot = new DatabaseSync('/tmp/frcll-1-1-6/state.sqlite',{readOnly:true});
await backup(snapshot,statePath);snapshot.close();
const copy=new DatabaseSync(statePath);
for(const row of copy.prepare('SELECT run_id,payload FROM sessions').all()){const session=JSON.parse(row.payload);if(session.launchContext){session.launchContext.reportPath=join(home,'.raf/tmp',session.runId,`${session.addressId}.json`);session.launchContext.briefPath=join(home,'.raf/tmp',session.runId,'brief.txt');}copy.prepare('UPDATE sessions SET payload=? WHERE run_id=?').run(JSON.stringify(session),row.run_id);}
copy.close();
const {openStateStore} = await import(join(source,'src/state-store.ts'));
const {createProductionServices} = await import(process.env.PROFILE_FULL ? '/tmp/frcll-1-1-6/src/production-runtime.ts' : join(source,'src/production-runtime.ts'));
const {executeCommand} = await import(join(source,'src/os-runtime.ts'));
const {loadCompiledCatalog} = await import(join(source,'src/compiled-catalog.ts'));
const catalog = loadCompiledCatalog(join(source,'dist/catalog.json'));
const store = openStateStore(statePath);
const calls = [], stages = [], costs = {};
const transaction = store.sessionRepository.transaction;
store.sessionRepository.transaction = (operation,mode) => transaction(tx=>operation(new Proxy(tx,{get(target,key){
 const value=target[key];if(typeof value!=='function')return value;
 return (...args)=>{const start=performance.now();try{return value(...args);}finally{const row=costs[key]??={calls:0,ms:0};row.calls++;row.ms+=performance.now()-start;}};
}})),mode);
const execute = async request => {
 const allowed = request.args?.includes('--version') || request.executable === 'openspec' && ['instructions','list'].includes(request.args[0]) || request.executable === 'ps' || request.executable === 'tmux' && request.args.some(arg=>['list-panes','display-message','capture-pane','has-session'].includes(arg)) || request.executable === 'df' || request.executable === 'git' && ['rev-parse','status','show','diff','ls-files'].includes(request.args[0]);
 const start = performance.now();
 try { return allowed ? await executeCommand(request.executable==='tmux'&&process.env.PROFILE_FULL?{...request,args:['-S',join(home,'.raf/tmp/tmux/server.sock'),...request.args]}:request) : {exitCode:127,stdout:'',stderr:'copy profile refuses side effects'}; }
 finally {calls.push({executable:request.executable,operation:request.args.slice(0,4),allowed,ms:performance.now()-start});}
};
const settings=JSON.parse(fs.readFileSync(join(root,'conf/raf.json'),'utf8')).runnerProtocols;
const api = await createProductionServices(store,{catalog,models:catalog.models,commandTiming:{emaAlpha:0.1}}, {
 orchestratorRoot:root,confRoot:join(root,'conf'),artifactPath:join(source,'dist/catalog.json'),statePath,tmpRoot:join(home,'.raf/tmp'),mode:'test',commandStartedAtMs:0,resolveCaller:async()=>undefined
},{execute,...(process.env.PROFILE_FULL ? {workerModulePath:'/tmp/frcll-1-1-6/src/production-runtime.ts',protocolSettings:settings.map(p=>p.runner==='codex'?{...p,executable:'/tmp/frcll-1-1-6/profile-codex',baseArgs:[]}:p)}:{})});
async function stage(name,operation){const start=performance.now();try{return await operation();}finally{stages.push({name,ms:performance.now()-start});}}
const profiler=new Session();profiler.connect();await profiler.post('Profiler.enable');await profiler.post('Profiler.start');
let error;
try {
 const checked=await stage('assignment',()=>api.assignment.validate({root,selections:[{change:'fix-raf-cli-live-latency',items:[{id:'1.1.6'}]}]}));
 if(!checked.ok)throw new Error(JSON.stringify(checked));
 const parameters={id:'copy-run',type:'hotfix',project:'raf',features:['fix-raf-cli-live-latency'],phase:'implement',complexity:'medium',tasks:['fix-raf-cli-live-latency:1.1.6']};
 const task=await stage('task-context',()=>api.resolveTask(parameters,checked.snapshot));
 const routing=await stage('runner-selection-snapshot',()=>api.routingSnapshot());
 fs.writeFileSync(join(source,'evidence/hotfix-1.1.6',`${label}.routing.json`),JSON.stringify(routing,null,2));
 const selection={status:'selected',runner:'codex',model:'gpt-6.1',effort:'high'};
 const launch={runId:`copy-${label}`,addressId:'copy-run',tmuxSession:`copy-${label}`,activity:{type:'hotfix',project:'raf',features:parameters.features,phase:'implement',cwd:source},assignment:checked.snapshot,selection,statePath,tmpRoot:join(home,'.raf/tmp'),writeBoundaries:[source],commitRepositories:[],taskContext:{parameters,context:task}};
 const prepared=await stage('prepare-report',()=>api.prepareReport(launch));
 const brief=await stage('brief',()=>api.assignment.compose(checked.snapshot,{briefsRoot:join(root,'conf/briefs'),runner:'codex',cwd:source,stage:'implement',agentType:'hotfix',project:'raf',agentId:'copy-run',sessionName:launch.tmuxSession,features:parameters.features,phase:'implement',outcome:task.outcome,writeBoundaries:[source],sources:task.sources,reportPath:prepared.reportPath,reportSchema:task.reportSchema,rafCommand:'node /srv/dev/work/orchestrator/raf-main/bin/raf.ts'}));
 if(process.env.PROFILE_FULL){
  const admission=await stage('admission',()=>api.reserve({...launch,reportPath:prepared.reportPath,requested:task.requested,requiredFileSystemIds:[...task.requiredFileSystemIds]}));
  if(!admission.admitted)throw new Error(JSON.stringify(admission));
  const started=await stage('runner-tmux-start',()=>api.adapter.start({selection,tmuxSession:launch.tmuxSession,cwd:source,brief,reportWrapper:prepared.reportWrapper}));
  const identity=await stage('verify',()=>api.verifyStarted(launch,started));
  await stage('commit-started',()=>api.commitStarted(launch.runId,identity));
 } else await prepared.cleanupUnstarted();
} catch(e){error={message:e.message,code:e.code};}
const {profile}=await profiler.post('Profiler.stop');profiler.disconnect();
fs.writeFileSync(join(source,'evidence/hotfix-1.1.6',`${label}.cpuprofile`),JSON.stringify(profile));
const counts=Object.fromEntries(['sessions','result_notices','pending_intents'].map(table=>[table,store.startupContextDatabase.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const result={label,counts,stages,costs,calls,error,scope:'Production services and synthetic worker on private SQLite backup, copied conf/OpenSpec Markdown and private tmux socket; no model service call or live state mutation'};
fs.writeFileSync(join(source,'evidence/hotfix-1.1.6',`${label}.json`),JSON.stringify(result,null,2));store.close();
if (process.env.PROFILE_FULL) await executeCommand({executable:'tmux',args:['-S',join(home,'.raf/tmp/tmux/server.sock'),'kill-server']});
console.log(JSON.stringify(result));
