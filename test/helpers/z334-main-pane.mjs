import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [stand] = process.argv.slice(2);
const root = path.join(stand, 'root');
const cli = path.join(root, 'raf-main/bin/raf.ts');
const atomic = (file, data) => {
  fs.writeFileSync(file + '.part', JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.part', file);
};
const run = (label, args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const record = { command: [process.execPath, cli, ...args], cwd: root, cliExitCode: result.status, signal: result.signal, error: result.error?.message ?? null };
  fs.writeFileSync(path.join(stand, 'pane', label + '.stdout'), result.stdout ?? '');
  fs.writeFileSync(path.join(stand, 'pane', label + '.stderr'), result.stderr ?? '');
  atomic(path.join(stand, 'pane', label + '.json'), record);
};
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', bytes => fs.appendFileSync(path.join(stand, 'pane/inbox.bin'), bytes));
run('attach', ['main', 'attach']);
setInterval(() => {
  for (const name of fs.readdirSync(path.join(stand, 'commands')).filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(stand, 'commands', name);
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.renameSync(file, file + '.running');
    run(request.label, request.args);
    fs.renameSync(file + '.running', file + '.done');
  }
}, 100);
