import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [report, manifestPath] = process.argv.slice(2);
assert.ok(path.isAbsolute(report) && path.isAbsolute(manifestPath));
const own = path.dirname(report);
assert.equal(path.basename(path.dirname(own)), 'tmp');
assert.equal(path.basename(path.dirname(path.dirname(own))), '.raf');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schema, 'cfc24-private-sandbox-controls-v1');
const checks = [];
const check = async (id, fn) => { try { checks.push({ id, status: 'passed', evidence: await fn() }); } catch(error) { checks.push({ id, status: 'failed', error: error.message }); } };
const run = (file, args) => {
  const value = spawnSync(file, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const result = { command: [file, ...args], cliCode: value.status, signal: value.signal, stdout: value.stdout, stderr: value.stderr, error: value.error?.message };
  assert.equal(value.status, 0, JSON.stringify(result));
  assert.equal(value.signal, null, JSON.stringify(result));
  return result;
};
const denied = async (resource, target) => {
  assert.equal(resource.before.path, resource.path);
  assert.ok(resource.before.ino > 0 && ['file', 'socket'].includes(resource.before.kind), 'Host existence control required');
  let error;
  if (resource.kind === 'file') {
    try { const fd = fs.openSync(target, 'r'); fs.closeSync(fd); } catch(value) { error = value; }
  } else {
    error = await new Promise(resolve => {
      const socket = net.connect(target);
      socket.setTimeout(3000, () => { socket.destroy(); resolve(Error('Unverified timeout')); });
      socket.on('connect', () => { socket.destroy(); resolve(null); });
      socket.on('error', resolve);
    });
  }
  assert.ok(error, 'Protected existing resource was accessible: ' + target);
  assert.ok(['EACCES', 'EPERM', 'ENOENT'].includes(error.code), 'Unexpected denial: ' + error.message);
  return { path: target, code: error.code, hostControl: resource.before,
    boundary: 'ENOENT is accepted only with the independent host before/after existence and liveness controls; host verification is mandatory.' };
};
await check('L3-own-directory-file', () => {
  const directory = path.join(own, 'extra-file'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'literal'), '🧪 $() `literal`');
  assert.equal(fs.readFileSync(path.join(directory, 'literal'), 'utf8'), '🧪 $() `literal`');
  return { directory };
});
await check('L3-own-unix-ipc', async () => {
  const target = path.join(own, 'extra.sock');
  const server = net.createServer(socket => socket.end('OWN IPC'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(target, resolve); });
    const received = await new Promise((resolve, reject) => {
      const socket = net.connect(target); let text = '';
      socket.on('data', value => text += value); socket.on('error', reject); socket.on('end', () => resolve(text));
    });
    assert.equal(received, 'OWN IPC'); return { path: target, received };
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
});
await check('L3-own-git-commit', () => {
  const directory = path.join(own, 'extra-git'); fs.mkdirSync(directory);
  const commands = [run('git', ['init', '-q', directory])];
  fs.writeFileSync(path.join(directory, 'literal.txt'), 'PRIVATE QA 🧪\n');
  commands.push(run('git', ['-C', directory, 'add', '--', 'literal.txt']));
  commands.push(run('git', ['-C', directory, '-c', 'user.name=Private QA', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Private sandbox positive control']));
  commands.push(run('git', ['-C', directory, 'rev-parse', 'HEAD']));
  assert.match(commands.at(-1).stdout.trim(), /^[a-f0-9]{40,64}$/); return { directory, commands };
});
await check('L3-own-tmux', () => {
  const socket = path.join(own, 'extra-tmux.sock');
  const commands = [];
  let primary;
  try {
    commands.push(run('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'cfc24-owned', 'sleep 90']));
    commands.push(run('tmux', ['-S', socket, 'display-message', '-p', '-t', 'cfc24-owned', '#{session_name}']));
    assert.equal(commands.at(-1).stdout.trim(), 'cfc24-owned');
  } catch (error) { primary = error; }
  const cleanup = spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8', timeout: 15000 });
  commands.push({ command: ['tmux', '-S', socket, 'kill-server'], cliCode: cleanup.status,
    signal: cleanup.signal, stdout: cleanup.stdout, stderr: cleanup.stderr, error: cleanup.error?.message });
  if (primary) throw Error(JSON.stringify({ primary: primary.message, commands }));
  assert.equal(cleanup.status, 0, JSON.stringify(commands));
  return { socket, commands };
});
for (const resource of manifest.resources) {
  await check('L3-deny-direct-' + resource.id, () => denied(resource, resource.path));
  await check('L3-deny-symlink-' + resource.id, async () => {
    const alias = path.join(own, 'extra-alias-' + resource.id); fs.symlinkSync(resource.path, alias);
    return denied(resource, alias);
  });
  await check('L3-deny-child-' + resource.id, () => {
    const code = `import fs from 'node:fs';import net from 'node:net';const r=JSON.parse(process.argv[1]);const done=e=>{console.log(JSON.stringify({path:r.path,code:e?.code??null}));process.exit(['EACCES','EPERM','ENOENT'].includes(e?.code)?0:1);};if(r.kind==='file'){try{const fd=fs.openSync(r.path,'r');fs.closeSync(fd);done(null);}catch(e){done(e);}}else{const s=net.connect(r.path);s.setTimeout(3000,()=>{s.destroy();done(Error('Unverified timeout'));});s.once('connect',()=>{s.destroy();done(null);});s.once('error',done);}`;
    const result = run(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ path: resource.path, kind: resource.kind })]);
    const value = JSON.parse(result.stdout);
    assert.ok(['EACCES', 'EPERM', 'ENOENT'].includes(value.code));
    return { ...result, hostControl: resource.before };
  });
}
const result = { mode: 'L3-full', checks, pid: process.pid, cwd: process.cwd(), report, manifestPath,
  hostReviewRequired: true, unexecuted: ['L2 intentional native UI/auth/unknown', 'L4 spec/design and native transport matrix'] };
const atomic = (target, value) => { fs.writeFileSync(target + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(target + '.part', target); };
atomic(path.join(own, 'native-probes.json'), result);
const status = checks.every(value => value.status === 'passed') ? 'succeeded' : 'failed';
atomic(report, { status, answer: 'Private native sandbox probes; mandatory independent host controls in evidence', commits: [],
  changes: [{ id: 'launch-failure-fixture', items: [{ id: '1.1', status, ...(status === 'failed' ? { reason: 'Private native sandbox probe failed' } : {}) }] }] });
console.log(JSON.stringify(result)); process.exitCode = status === 'succeeded' ? 0 : 1;
