import fs from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {Session} from 'node:inspector/promises';
const [snapshot, label] = process.argv.slice(2);
const source = process.cwd();
const home = join(snapshot, label);
fs.mkdirSync(join(home, '.raf'), {recursive:true});
process.env.HOME = process.env.RAF_QA_HOME = home;
delete process.env.TMUX; delete process.env.TMUX_PANE;
const statePath = join(home,'.raf/state.sqlite');
const original = new DatabaseSync(join(snapshot,'state.sqlite'),{readOnly:true});
await backup(original,statePath); original.close();
const copy = new DatabaseSync(statePath);
for (const row of copy.prepare('SELECT run_id,payload FROM sessions').all()) {
 const session=JSON.parse(row.payload);
 if(session.launchContext){session.launchContext.reportPath=join(home,'.raf/tmp',session.runId,`${session.addressId}.json`);session.launchContext.briefPath=join(home,'.raf/tmp',session.runId,'brief.txt');}
 copy.prepare('UPDATE sessions SET payload=? WHERE run_id=?').run(JSON.stringify(session),row.run_id);
}
copy.close();
const {openStateStore} = await import(join(source,'src/state-store.ts'));
const {createProductionServices} = await import(join(source,'src/production-runtime.ts'));
const {executeCommand} = await import(join(source,'src/os-runtime.ts'));
const {loadCompiledCatalog} = await import(join(source,'src/compiled-catalog.ts'));
const root = '/srv/dev/work/orchestrator';
const store = openStateStore(statePath);
const cardinalities = Object.fromEntries(['sessions','result_notices','pending_intents'].map(table=>[table,store.startupContextDatabase.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const costs = new Map();
const transaction = store.sessionRepository.transaction;
store.sessionRepository.transaction = (operation,mode) => transaction(tx=>operation(new Proxy(tx,{get(target,key){
 const value=target[key]; if(typeof value!=='function')return value;
 return (...args)=>{const start=performance.now();try{return value(...args);}finally{const row=costs.get(key)??{calls:0,ms:0};row.calls++;row.ms+=performance.now()-start;costs.set(key,row);}};
}})),mode);
const calls=[];
const execute=async request=>{
 const allowed=request.executable==='ps'||request.executable==='tmux'&&request.args.some(arg=>['list-panes','display-message','capture-pane','has-session'].includes(arg));
 calls.push({executable:request.executable,operation:request.args.filter(arg=>!arg.startsWith('/')).slice(0,4),allowed});
 return allowed?executeCommand(request):{exitCode:127,stdout:'',stderr:'copy profile refuses side effects'};
};
const catalog=loadCompiledCatalog(join(source,'dist/catalog.json'));
const services=await createProductionServices(store,{catalog,models:catalog.models,commandTiming:{emaAlpha:0.1}}, {
 orchestratorRoot:root,confRoot:join(root,'conf'),artifactPath:join(source,'dist/catalog.json'),statePath,tmpRoot:join(home,'.raf/tmp'),mode:'test',commandStartedAtMs:0,resolveCaller:async()=>undefined
},{execute});
const profiler=new Session();profiler.connect();await profiler.post('Profiler.enable');await profiler.post('Profiler.start');
const start=performance.now();let rows,error;
try{rows=await services.control.ps();}catch(e){error={message:e.message,code:e.code};}
const wallMs=performance.now()-start;
const {profile}=await profiler.post('Profiler.stop');profiler.disconnect();
fs.writeFileSync(join(source,'evidence/hotfix-1.1.5',`${label}.cpuprofile`),JSON.stringify(profile));
const result={label,cardinalities,wallMs,rows:rows?.length,error,costs:Object.fromEntries(costs),calls,scope:'production service control.ps; private SQLite backup and QA HOME; read-only process commands permitted; all other child commands refused; no live budget claim'};
fs.writeFileSync(join(source,'evidence/hotfix-1.1.5',`${label}.json`),JSON.stringify(result,null,2));
store.close();console.log(JSON.stringify({...result,calls:undefined}));
