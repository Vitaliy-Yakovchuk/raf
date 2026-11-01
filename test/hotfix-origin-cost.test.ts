import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inventory as activationInventory } from '../src/hotfix-host.ts';
import { childMessage, fixture as activationFixture, timeoutMs } from './hotfix-fixture.ts';
import { observeWaitIdentity, readWaitIdentity } from '../src/resource-wait-identity.ts';
import type { ResourceWaitIdentity } from '../src/resource-wait-protocol.ts';

for (const mode of ['cleanup', 'timeout', 'SIGKILL'] as const) {
  test(`[module-origin-cost] fixture ${mode} stops both QA and production services before removing their home`, { timeout: timeoutMs }, async t => {
    const root = fs.mkdtempSync(join(tmpdir(), 'fixture-owner-'));
    const script = join(root, 'owner.mjs');
    let report: { root: string; services: ResourceWaitIdentity[]; budget: number; poll: number } | undefined;
    let stderr = '';
    fs.writeFileSync(script, `import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from ${JSON.stringify(new URL('./hotfix-fixture.ts', import.meta.url).href)};
import { ensureProductionMainStore } from ${JSON.stringify(new URL('../src/main-production-store.ts', import.meta.url).href)};
import { readWaitIdentity } from ${JSON.stringify(new URL('../src/resource-wait-identity.ts', import.meta.url).href)};
const hooks=[];
const f=await fixture({after:hook=>hooks.push(hook)});
const services=[];
const progress=()=>process.send({kind:'progress',root:f.root,services,budget:f.budget,poll:f.poll});
progress();
await ensureProductionMainStore({root:f.root});
for(const production of [false,true]){
 const started=f.cli(f.main,['service','start'],production,production?{NODE_OPTIONS:(f.environment.NODE_OPTIONS??'')+' --import='+f.osHomePreload}:{});
 assert.equal(started.code,0,started.stderr);
 const status=JSON.parse(started.stdout);
 assert.equal(status.state,'ready');
 services.push(await readWaitIdentity(status.pid));
 progress();
}
const remove=fs.rmSync;
fs.rmSync=(path,...args)=>{
 if(path===f.root)for(const identity of services){
  let alive=false;
  try{
   const stat=fs.readFileSync('/proc/'+identity.pid+'/stat','utf8');
   const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
   alive=fields[19]===identity.startedAt&&!['Z','X'].includes(fields[0]);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  assert.equal(alive,false,'fixture home must not be removed before owned service exits');
 }
 return remove(path,...args);
};
syncBuiltinESMExports();
const ready=()=>new Promise((resolve,reject)=>process.send({kind:'ready',root:f.root,services,budget:f.budget,poll:f.poll},error=>error?reject(error):resolve()));
const mode=${JSON.stringify(mode)};
const triggered=new Promise(resolve=>process.once('message',resolve));
await ready();
if(mode==='timeout'){
 await triggered;
 await test('intentional fixture owner timeout',{timeout:f.poll},async t=>{
  const hold=setInterval(()=>{},f.poll);
  t.after(()=>clearInterval(hold));
  for(const hook of hooks)t.after(hook);
  await new Promise(()=>{});
 });
 process.disconnect();
}else{
 if(mode==='cleanup'){
  await triggered;
  for(const hook of hooks)await hook();
  process.disconnect();
 }else setInterval(()=>{},f.poll);
}
`);
    const child = childProcess.spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', value => {
      if (value && typeof value === 'object' && 'kind' in value && value.kind === 'progress') report = value as typeof report;
    });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      for (const identity of report?.services ?? []) {
        if ((await observeWaitIdentity(identity)).state === 'alive') process.kill(identity.pid, 'SIGKILL');
        assert.equal(await serviceStopped(identity, report!.budget, report!.poll), true);
      }
      if (report) fs.rmSync(report.root, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    });
    report = await childMessage(child, value => value.kind === 'ready', timeoutMs).catch(error => {
      throw new Error(`${error.message}\n${stderr}`);
    });
    assert.equal(report!.services.length, 2, 'the regression starts real services in both homes');
    for (const identity of report!.services) assert.equal((await observeWaitIdentity(identity)).state, 'alive');
    if (mode === 'SIGKILL') child.kill('SIGKILL');
    if (mode !== 'SIGKILL') child.send(mode);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      exited,
      new Promise<undefined>(resolveExit => { timer = setTimeout(resolveExit, report!.budget * 4); })
    ]);
    clearTimeout(timer);
    assert.ok(completed, 'fixture owner must finish cleanup within its transition budgets');
    const [code, signal] = completed;
    if (mode === 'SIGKILL') assert.equal(signal, 'SIGKILL');
    else assert.equal(code, mode === 'timeout' ? 1 : 0, stderr);
    for (const identity of report!.services) {
      const stopped = await serviceStopped(identity, report!.budget, report!.poll);
      assert.equal(stopped, true, `${mode} must not orphan service PID ${identity.pid} after fixture cleanup`);
    }
    if (mode !== 'SIGKILL') assert.equal(fs.existsSync(report!.root), false);
  });
}

async function serviceStopped(identity: ResourceWaitIdentity, budget: number, poll: number): Promise<boolean> {
  const deadline = Date.now() + budget;
  do {
    if ((await observeWaitIdentity(identity)).state === 'dead') return true;
    await delay(poll);
  } while (Date.now() < deadline);
  return false;
}

test('[module-origin-cost] forked publisher preserves a full snapshot payload beyond exec environment limits', async t => {
  const f = await activationFixture(t);
  const payload = { marker: 'full-snapshot-payload', proof: 'x'.repeat(256 * 1024) };
  let child: ReturnType<typeof f.forkModule> | undefined;
  assert.doesNotThrow(() => {
    child = f.forkModule('const p=hotfixFixturePayload;await new Promise((resolve,reject)=>process.send(p,error=>error?reject(error):resolve()));process.disconnect();', payload);
  }, 'a growing full snapshot must not prevent the publisher process from starting');
  assert.ok(child);
  const exited = once(child, 'exit');
  assert.deepEqual(await childMessage(child, value => value.marker === payload.marker, f.budget), payload);
  assert.equal((await exited)[0], 0);
});
