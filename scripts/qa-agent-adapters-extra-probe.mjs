import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { denied } from './qa-agent-adapters-probe-denial.mjs';
const [report, manifestPath, selection = 'full'] = process.argv.slice(2);
assert.ok(['full', 'regression'].includes(selection));
assert.ok(path.isAbsolute(report) && path.isAbsolute(manifestPath));
const own = path.dirname(report);
assert.equal(path.basename(path.dirname(own)), 'tmp');
assert.equal(path.basename(path.dirname(path.dirname(own))), '.raf');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schema, 'cfc24-private-sandbox-controls-v1');
assert.ok(path.isAbsolute(manifest.tmuxExecutable), 'Host-resolved real tmux executable required');
const checks = [];
const omitted = [];
const regressionResources = ['neighbor-questions', 'bus', 'ssh-agent', 'host-unregistered'];
const regressionIds = regressionResources.flatMap(id => ['direct', 'symlink', 'child'].map(kind => 'L3-deny-' + kind + '-' + id));
const check = async (id, fn) => {
  if (selection === 'regression' && !regressionIds.includes(id)) { omitted.push(id); return; }
  try { checks.push({ id, status: 'passed', evidence: await fn() }); } catch(error) { checks.push({ id, status: 'failed', error: error.message }); }
};
const run = (file, args) => {
  const value = spawnSync(file, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const result = { command: [file, ...args], cliCode: value.status, signal: value.signal, stdout: value.stdout, stderr: value.stderr, error: value.error?.message };
  assert.equal(value.status, 0, JSON.stringify(result));
  assert.equal(value.signal, null, JSON.stringify(result));
  return result;
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
    commands.push(run(manifest.tmuxExecutable, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'cfc24-owned', 'sleep 90']));
    commands.push(run(manifest.tmuxExecutable, ['-S', socket, 'display-message', '-p', '-t', 'cfc24-owned', '#{session_name}']));
    assert.equal(commands.at(-1).stdout.trim(), 'cfc24-owned');
  } catch (error) { primary = error; }
  const cleanup = spawnSync(manifest.tmuxExecutable, ['-S', socket, 'kill-server'], { encoding: 'utf8', timeout: 15000 });
  commands.push({ command: [manifest.tmuxExecutable, '-S', socket, 'kill-server'], cliCode: cleanup.status,
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
    const code = 'const {denied}=await import(process.argv[1]);const r=JSON.parse(process.argv[2]);console.log(JSON.stringify(await denied(r,r.path)));';
    const result = run(process.execPath, ['--input-type=module', '-e', code, new URL('./qa-agent-adapters-probe-denial.mjs', import.meta.url).href, JSON.stringify(resource)]);
    const value = JSON.parse(result.stdout);
    assert.equal(value.hostVerificationRequired, true);
    return { ...result, hostControl: resource.before };
  });
}
if (selection === 'regression') assert.deepEqual(checks.map(value => value.id).sort(), [...regressionIds].sort(), 'Every targeted regression must execute');
const result = { mode: selection === 'regression' ? 'L3-regression' : 'L3-full', checks, pid: process.pid, cwd: process.cwd(), report, manifestPath,
  hostReviewRequired: true, unexecuted: [...omitted, 'L2 intentional native UI/auth/unknown', 'L4 spec/design and native transport matrix'],
  boundary: selection === 'regression' ? 'Only H5 failed questions/bus/ssh/protected unregistered socket assertions. Prior passed native checks are addressed separately; this is not a full L3 acceptance result.' : 'Full native L3 probe; independent host controls remain mandatory.' };
const atomic = (target, value) => { fs.writeFileSync(target + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(target + '.part', target); };
atomic(path.join(own, 'native-probes.json'), result);
const status = checks.every(value => value.status === 'passed') ? 'succeeded' : 'failed';
atomic(report, { status, answer: 'Private native sandbox probes; mandatory independent host controls in evidence', commits: [],
  changes: [{ id: 'launch-failure-fixture', items: [{ id: '1.1', status, ...(status === 'failed' ? { reason: 'Private native sandbox probe failed' } : {}) }] }] });
console.log(JSON.stringify(result)); process.exitCode = status === 'succeeded' ? 0 : 1;
