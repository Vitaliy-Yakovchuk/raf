import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

const [stand, mode] = process.argv.slice(2);
assert.match(stand, /^\/srv\/dev\/ar41-[^/]+$/);
assert.ok(['raw', 'native'].includes(mode));
const cli = path.join(stand, 'root/raf-main/bin/raf.ts');
const atomic = (file, value) => {
  fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
};
const run = (label, args, budget = 900000) => {
  assert.match(label, /^[a-z0-9-]+$/);
  const startedAt = new Date().toISOString();
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: path.dirname(path.dirname(cli)), env: process.env,
    encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024 });
  const result = { command: [process.execPath, cli, ...args], startedAt, endedAt: new Date().toISOString(), cliExitCode: r.status,
    signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(stand, 'ev', label + '.' + stream), result[stream]);
  atomic(path.join(stand, 'ev', label + '.json'), result);
  return result;
};
atomic(path.join(stand, 'main-ready-' + mode + '.json'), run('main-attach-' + mode, ['main', 'attach']));
if (mode === 'native') {
  const invocation = JSON.parse(fs.readFileSync(path.join(stand, 'main-invocation.json')));
  const child = spawn(invocation.executable, invocation.args, { cwd: path.dirname(path.dirname(cli)), env: process.env, stdio: 'inherit' });
  child.on('error', error => atomic(path.join(stand, 'main-native-error.json'), { message: error.message }));
  child.on('exit', (code, signal) => atomic(path.join(stand, 'main-native-exit.json'), { code, signal }));
} else {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', data => fs.appendFileSync(path.join(stand, 'ev/main-raw-inbox.bin'), data));
  process.stdout.write('HOST RAW INBOX; NO AGENT COMPOSER\n');
}
setInterval(() => {
  for (const name of fs.readdirSync(path.join(stand, 'commands')).filter(x => x.endsWith('.json')).sort()) {
    const file = path.join(stand, 'commands', name);
    const request = JSON.parse(fs.readFileSync(file));
    fs.renameSync(file, file + '.running');
    run(request.label, request.args, request.budget);
    fs.renameSync(file + '.running', file + '.done');
  }
}, 100);
