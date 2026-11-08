import fs from 'node:fs/promises';
import { join } from 'node:path';
import { executeCommand } from '../../src/os-runtime.ts';
import { redactDiagnostic } from '../../src/cli-contract.ts';
import { prepareCodexRafCommandAccess } from '../../src/codex-raf-command-access.ts';
import { observeRunnerScreen, readNativeSessionId, isNativeWorking, isNativeFinished } from '../../src/runner-protocols.ts';
const root = await fs.mkdtemp('/tmp/frcll-1-1-8-native-');
const hostHome = process.env.HOME;
const protocols = JSON.parse(await fs.readFile('/srv/dev/work/orchestrator/conf/raf.json','utf8')).runnerProtocols;
const samples = [];
const codexHome=join(root,'codex-home');
await fs.mkdir(codexHome);
for(const name of ['config.toml','auth.json']) await fs.copyFile(join(hostHome,'.codex',name),join(codexHome,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
const environment = {...process.env, HOME:root, RAF_QA_HOME:root, CODEX_HOME:codexHome, CLAUDE_CONFIG_DIR:hostHome};
delete environment.TMUX; delete environment.TMUX_PANE;
const cwd = process.cwd();
for (const runner of ['codex','claude']) {
 const settings=protocols.find(p=>p.runner===runner);
 const events=[];
 const epoch=performance.now();
 const event=(name,extra={})=>events.push({name,at:new Date().toISOString(),ms:performance.now()-epoch,...extra});
 const socket=join(root,runner+'.sock');
 const run=async args=>executeCommand({executable:'tmux',args:['-S',socket,...args],environment});
 try {
  event('admission-fixture'); event('brief-fixture-no-task');
  if(runner==='codex'){
   event('hook-inspection-start');
   const access=await prepareCodexRafCommandAccess({invocation:{executable:settings.executable,args:settings.baseArgs,liveTaskVerified:false},scope:{excludedCommands:['node /srv/dev/work/orchestrator/raf-main/bin/raf.ts agent message'],readable:[],writable:[],hidden:[],tmuxDirectory:root},cwd,runDirectory:root,environment,timeoutMs:settings.timeouts.transitionMs});
   event('hook-inspection-end',{unavailable:access.unavailable??null}); await access.cleanup();
  }
  event('tmux-spawn-start');
  const result=await run(['new-session','-d','-s','native','-c',cwd,'sh','-c','read -r _',';','set-option','-p','-t','=native:0.0','remain-on-exit','on',';','respawn-pane','-k','-t','=native:0.0',settings.executable,...settings.baseArgs]);
  if(result.exitCode)throw new Error(result.stderr);
  event('tmux-spawn-end');
  await new Promise(resolve=>setTimeout(resolve,settings.timeouts.pollMs));
  let last;
  for(;;){
   const pane=await run(['capture-pane','-p','-t','=native:0.0']);
   const state=observeRunnerScreen(settings,{text:pane.stdout,version:settings.version,requestedCommand:null}).state;
   if(state!==last){event('screen',{state});last=state;}
   if(state==='ready'){event('readiness',{screen:redactDiagnostic(pane.stdout).slice(0,1800)});break;}
   if(!['starting'].includes(state) || performance.now()-epoch>30000){event('observation-ended',{state,screen:redactDiagnostic(pane.stdout).slice(0,1800)});break;}
   await new Promise(resolve=>setTimeout(resolve,settings.timeouts.pollMs));
  }
  if(last==='ready') {
   event('status-request'); await run(['send-keys','-t','=native:0.0','-l',settings.native.identity.command]);
   await new Promise(resolve=>setTimeout(resolve,settings.timeouts.pollMs));
   await run(['send-keys','-t','=native:0.0','Enter']);
   for(;;){const pane=await run(['capture-pane','-p','-t','=native:0.0']);if(readNativeSessionId(settings,pane.stdout)){event('native-id-confirmed');break;}if(performance.now()-epoch>30000){event('native-id-unconfirmed',{screen:redactDiagnostic(pane.stdout).slice(0,1800)});break;}await new Promise(resolve=>setTimeout(resolve,settings.timeouts.pollMs));}
   if(runner==='codex') {
    const brief='Diagnostic only. Do not use tools or change files. Reply OK only. The following padding is inert.\n'+('padding '.repeat(6000));
    event('delivery-start',{bytes:Buffer.byteLength(brief)});
    await executeCommand({executable:'tmux',args:['-S',socket,'load-buffer','-b','diagnostic','-'],stdin:brief,environment});
    await run(['paste-buffer','-p','-b','diagnostic','-t','=native:0.0']);await run(['send-keys','-t','=native:0.0','Enter']);
    event('delivery-submitted');
    for(;;){const pane=await run(['capture-pane','-p','-t','=native:0.0']);if(isNativeWorking(settings,pane.stdout)||isNativeFinished(settings,pane.stdout)){event('delivery-accepted');break;}if(performance.now()-epoch>30000){event('delivery-unconfirmed',{screen:redactDiagnostic(pane.stdout).slice(0,1800)});break;}await new Promise(resolve=>setTimeout(resolve,settings.timeouts.pollMs));}
   }
  }
 } catch(error){event('error',{message:error.message});}
 finally {await run(['kill-server']);}
 samples.push({runner,events});
}
await fs.writeFile(new URL('./native-delivery-writable.json',import.meta.url),JSON.stringify({root,scope:'Private tmux and QA HOME; real installed CLIs; diagnostic OK-only prompt for Codex; no tools; Claude has no prompt; service and CLI response unmeasured',samples},null,2));
console.log(JSON.stringify(samples));
