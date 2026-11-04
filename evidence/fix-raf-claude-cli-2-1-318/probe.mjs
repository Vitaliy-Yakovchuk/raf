import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const evidence = new URL('./', import.meta.url).pathname;
const base = '/home/dev/.raf/tmp/322c0206-6049-4a0d-9c6e-660675ca2e45/claude-probe';
const home = join(base,'home');
const socket = join(base,'tmux.sock');
mkdirSync(join(home,'.claude'),{recursive:true});
const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_CACHE_HOME:join(home,'.cache'),TMUX:'',TMUX_TMPDIR:base};
const config=JSON.parse(readFileSync('/home/dev/.claude.json','utf8'));
// Isolated CLI state; credentials never enter evidence or console output.
writeFileSync(join(home,'.claude.json'),JSON.stringify(config),{mode:0o600});
if(existsSync('/home/dev/.claude/.credentials.json'))copyFileSync('/home/dev/.claude/.credentials.json',join(home,'.claude/.credentials.json'));
const protocol=JSON.parse(readFileSync('/srv/dev/work/orchestrator/conf/raf.json')).runnerProtocols.find(p=>p.runner==='claude');
const scrub=s=>s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[email]');
for(const flag of ['--version','--help'])writeFileSync(join(evidence,flag.slice(2)+'.txt'),execFileSync('claude',[flag],{env,encoding:'utf8'}));
const tmux=(...args)=>execFileSync('tmux',['-S',socket,...args],{env,encoding:'utf8'});
writeFileSync(join(base,'tmux.conf'),'set -g remain-on-exit on\nset -g history-limit 5000\n');
const results=[];
try {
 for(const trusted of [true,false]) {
  const work=join(base,trusted?'trusted':'untrusted');mkdirSync(work,{recursive:true});execFileSync('git',['init','-q',work]);
  const c=JSON.parse(readFileSync(join(home,'.claude.json'),'utf8'));c.projects??={};if(trusted)c.projects[work]={hasTrustDialogAccepted:true};else delete c.projects[work];writeFileSync(join(home,'.claude.json'),JSON.stringify(c));
  const session=trusted?'trusted':'untrusted', id=randomUUID();
  const args=[...protocol.baseArgs,'--model','sonnet','--effort','low','--session-id',id];
  const row={session,id,work,args,frames:[],exitCode:null,cleanup:false,modelTaskSent:false};results.push(row);
  let last;const start=Date.now();
  const capture=stage=>{const s=tmux('capture-pane','-p','-t',session).trimEnd();if(s!==last){row.frames.push({stage,ms:Date.now()-start,text:scrub(s)});last=s;writeFileSync(join(evidence,'live-probes.json'),JSON.stringify(results,null,2)+'\n');}return s;};
  const wait=async(stage,accept)=>{for(;;){const s=capture(stage);if(accept(s))return s;if(tmux('display-message','-p','-t',session,'#{pane_dead}').trim()==='1')throw Error('Probe exited at '+stage+': '+s);await delay(50);}};
  const keys=(...args)=>tmux('send-keys','-t',session,...args);
  tmux('-f',join(base,'tmux.conf'),'new-session','-d','-s',session,'-x','130','-y','45','-c',work,'claude',...args);
  row.pid=Number(tmux('display-message','-p','-t',session,'#{pane_pid}').trim());
  if(trusted){
   await wait('startup',s=>s.includes("don't ask on (shift+tab to cycle)"));
   keys('-l','/status');capture('status-composer');keys('Enter');
   await wait('status',s=>s.includes('Session ID: '+id));keys('Escape');
   await wait('status-dismissed',s=>s.includes('Settings dialog dismissed'));
   const paste=Array.from({length:61},(_,i)=>`Probe line ${i+1}; do not submit.`).join('\n');
   execFileSync('tmux',['-S',socket,'load-buffer','-b','owned','-'],{env,input:paste});tmux('paste-buffer','-d','-p','-b','owned','-t',session);
   await wait('pending-paste',s=>s.includes('[Pasted text #1 +60 lines]'));
   keys('C-u');await wait('paste-cleared',s=>!s.includes('[Pasted text #1 +60 lines]'));
   keys('-l','/usage');keys('Enter');await wait('usage',s=>s.includes('Current week (all models)'));await wait('usage-loaded',s=>s.includes('Current week (all models)') && !s.includes('Refreshing…'));capture('usage-loaded');keys('Escape');
   await wait('usage-dismissed',s=>/^\$\s*$/m.test(s));keys('-l','/exit');keys('Enter');
  }else{await wait('workspace-trust',s=>s.includes('y. Yes, I trust this folder'));keys('n');keys('Enter');}
  while(tmux('display-message','-p','-t',session,'#{pane_dead}').trim()!=='1'){capture('exit');await delay(50);}
  capture('exited');row.exitCode=Number(tmux('display-message','-p','-t',session,'#{pane_dead_status}').trim());while(existsSync('/proc/'+row.pid)){await delay(50);}
  row.cleanup=true;
 }
} finally {
 try {tmux('kill-server');} catch {}
 writeFileSync(join(evidence,'live-probes.json'),JSON.stringify(results,null,2)+'\n');
 rmSync(home,{recursive:true,force:true});
}
console.log(JSON.stringify(results.map(({frames,...r})=>({...r,frames:frames.length})),null,2));
