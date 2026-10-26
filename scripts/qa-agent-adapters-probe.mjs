import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { denied } from './qa-agent-adapters-probe-denial.mjs';
const [report, manifestPath] = process.argv.slice(2);
assert.ok(path.isAbsolute(report) && path.isAbsolute(manifestPath));
const own = path.dirname(report);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schema, 'cfc24-private-sandbox-controls-v1');
assert.equal(path.basename(path.dirname(own)), 'tmp');
assert.equal(path.basename(path.dirname(path.dirname(own))), '.raf');
const checks = [];
const check = async (id, fn) => { try { checks.push({ id, status: 'passed', evidence: await fn() }); } catch(e) { checks.push({ id, status: 'failed', error: e.message }); } };
await check('L3-own-directory-file', () => { const d=path.join(own,'probe-dir');fs.mkdirSync(d);fs.writeFileSync(path.join(d,'literal'),'🧪 $() `text`');assert.equal(fs.readFileSync(path.join(d,'literal'),'utf8'),'🧪 $() `text`');return {directory:d}; });
await check('L3-own-unix-ipc', async () => {const p=path.join(own,'probe.sock');const server=net.createServer(s=>s.end('owned'));try {await new Promise((r,j)=>{server.once('error',j);server.listen(p,r);});const value=await new Promise((r,j)=>{let data='';const c=net.connect(p);c.on('data',b=>data+=b);c.on('error',j);c.on('end',()=>r(data));});assert.equal(value,'owned');return {socket:p};}finally{await new Promise(r=>server.close(r));}});
await check('L3-own-git', () => { const d=path.join(own,'probe-git');fs.mkdirSync(d);const r=spawnSync('git',['init','-q',d],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return {cliCode:r.status,stdout:r.stdout,stderr:r.stderr}; });
const protectedIds = ['state', 'state-wal', 'state-shm', 'private-secret-canary'];
const protectedResources = manifest.resources.filter(value => protectedIds.includes(value.id));
assert.deepEqual(protectedResources.map(value => value.id).sort(), [...protectedIds].sort(), 'Every baseline protected resource must have a host control');
for (const resource of protectedResources) {
  await check('L3-deny-' + resource.id, () => denied(resource, resource.path));
  await check('L3-deny-symlink-' + resource.id, async () => {
    const link = path.join(own, 'canary-link-' + resource.id);
    fs.symlinkSync(resource.path, link);
    return denied(resource, link);
  });
}
const result={checks,pid:process.pid,cwd:process.cwd(),report,unexecuted:['registered tmux sockets, bus/ssh-agent, neighbor questions, native tool compound channel, spec/design commit']};
const atomic=(p,v)=>{fs.writeFileSync(p+'.part',JSON.stringify(v,null,2)+'\n');fs.renameSync(p+'.part',p);};
atomic(path.join(own,'native-probes.json'),result);
const status=checks.every(c=>c.status==='passed')?'succeeded':'failed';
atomic(report,{status,answer:'Native adapter isolated probe; complete raw evidence in native-probes.json',commits:[],changes:[{id:'launch-failure-fixture',items:[{id:'1.1',status,...(status==='failed'?{reason:'Native protective/positive probe failed'}:{})}]}]});
console.log(JSON.stringify(result));process.exitCode=status==='succeeded'?0:1;
