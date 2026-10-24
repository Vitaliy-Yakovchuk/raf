import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [stand] = process.argv.slice(2);
const cli = path.join(stand, 'root/raf-main/bin/raf.ts');
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const run = (label, args, budget = 240000) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: path.dirname(path.dirname(cli)), env: process.env, encoding: 'utf8', timeout: budget, maxBuffer: 32 * 1024 * 1024 });
  const result = { command: [process.execPath, cli, ...args], cliExitCode: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  fs.writeFileSync(path.join(stand, 'ev', label + '.stdout'), result.stdout);
  fs.writeFileSync(path.join(stand, 'ev', label + '.stderr'), result.stderr);
  atomic(path.join(stand, 'ev', label + '.json'), result);
  return result;
};
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', data => fs.appendFileSync(path.join(stand, 'ev/main-inbox.bin'), data));
atomic(path.join(stand, 'main-ready.json'), run('main-attach', ['main', 'attach']));
setInterval(() => {
  for (const name of fs.readdirSync(path.join(stand, 'commands')).filter(x => x.endsWith('.json')).sort()) {
    const file = path.join(stand, 'commands', name);
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.renameSync(file, file + '.running');
    run(request.label, request.args, request.budget);
    fs.renameSync(file + '.running', file + '.done');
  }
}, 100);
