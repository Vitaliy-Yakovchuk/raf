import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const [stand] = process.argv.slice(2);
assert.match(stand, /^\/srv\/dev\/cfc97-[^/]+$/);
const cwd = path.join(stand, 'root/raf-develop');
const atomic = (file, value) => {
  fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
};
const run = (label, args, budget = 900000) => {
  assert.match(label, /^[a-z0-9-]+$/);
  const command = [process.execPath, path.join(cwd, 'bin/raf.ts'), ...args];
  const startedAt = new Date().toISOString();
  const r = spawnSync(command[0], command.slice(1), { cwd, env: process.env, encoding: 'utf8', timeout: budget, maxBuffer: 64 * 1024 * 1024 });
  const result = { command, cwd, startedAt, endedAt: new Date().toISOString(), cliExitCode: r.status,
    signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(stand, 'ev', label + '.' + stream), result[stream]);
  atomic(path.join(stand, 'ev', label + '.json'), result);
  return result;
};
atomic(path.join(stand, 'main-ready.json'), run('main-attach', ['main', 'attach']));
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', data => fs.appendFileSync(path.join(stand, 'ev/main-inbox.bin'), data));
setInterval(() => {
  for (const name of fs.readdirSync(path.join(stand, 'commands')).filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(stand, 'commands', name);
    const request = JSON.parse(fs.readFileSync(file));
    fs.renameSync(file, file + '.running');
    run(request.label, request.args, request.budget);
    fs.renameSync(file + '.running', file + '.done');
  }
}, 100);
