// Runs only from a native tool in the isolated host stand. No working-account state.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const [stageText, report] = process.argv.slice(2), stage = Number(stageText);
assert.ok([0, 1, 2].includes(stage) && path.isAbsolute(report));
const cwd = fs.realpathSync(process.cwd()), root = path.dirname(cwd), own = path.dirname(report);
assert.match(root, /^\/tmp\/s64-[^/]+\/root$/);
assert.ok(own.startsWith(path.dirname(root) + '/.raf/tmp/'));
const results = [];
const probe = (label, code, args, expected) => {
  for (const childShell of [false, true]) {
    const argv = ['--input-type=module', '-e', code, ...args];
    const r = spawnSync(childShell ? '/bin/sh' : process.execPath,
      childShell ? ['-c', 'exec "$@"', 'probe', process.execPath, ...argv] : argv,
      { encoding: 'utf8', timeout: 8000 });
    results.push({ label, childShell, command: childShell ? ['/bin/sh', '-c', 'exec "$@"', 'probe', process.execPath, ...argv] : [process.execPath, ...argv], cliExitCode: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.message });
    assert.equal(r.signal, null, label + ' must complete');
    assert.ok(r.status !== null && (expected === 'deny' ? r.status !== 0 : r.status === 0), label);
    if (expected === 'deny' && !label.includes('connection')) assert.match(r.stderr, /EACCES|EPERM|EROFS|Permission denied|Read-only file system/, label + ' must be a permission denial');
  }
};
let error;
try {
  if (stage) {
    const alias = path.join(own, 'sym64-aliases-' + stage); fs.mkdirSync(alias);
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }); assert.equal(common.status, 0);
    fs.symlinkSync(root, path.join(alias, 'root')); fs.symlinkSync(common.stdout.trim(), path.join(alias, 'raf-git'));
    fs.symlinkSync(path.join(path.dirname(root), '.raf'), path.join(alias, 'state'));
    const write = "import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],'sym64-tampered');";
    const targets = ['raf-main-a/bin/raf.ts', 'raf-main-b/bin/raf.ts', 'raf-main/bin/raf.ts', '.gitmodules'];
    for (const target of targets) for (const prefix of [root, path.join(alias, 'root')]) probe('deny write ' + target, write, [path.join(prefix, target)], 'deny');
    for (const target of ['HEAD', 'index', 'refs/heads/main', 'config', 'raf-hotfix/registry.json']) {
      for (const prefix of [common.stdout.trim(), path.join(alias, 'raf-git')]) probe('deny activation ' + target, write, [path.join(prefix, target)], 'deny');
    }
    for (const slot of ['raf-main-a', 'raf-main-b']) {
      const directory = spawnSync('git', ['-C', path.join(root, slot), 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }); assert.equal(directory.status, 0);
      for (const target of ['HEAD', 'index']) probe('deny slot metadata ' + slot + '/' + target, write, [path.join(directory.stdout.trim(), target)], 'deny');
    }
    // Owner contract: shared Orchestrator index is writable; opening it must not change main.
    probe('allow shared index', "import{openSync,closeSync}from'node:fs';closeSync(openSync(process.argv[1],'r+'));", [path.join(root, '.git/index')], 'allow');
    const marker = path.join(root, 'openspec/changes/sym64-fixture', `index-probe-${path.basename(own)}-${stage}.txt`);
    fs.writeFileSync(marker, 'Own isolated index probe\n');
    const add = spawnSync('git', ['-C', root, 'add', '--', marker], { encoding: 'utf8', timeout: 8000 });
    results.push({ label: 'actual shared index write', command: ['git', '-C', root, 'add', '--', marker], cliExitCode: add.status, signal: add.signal, stdout: add.stdout, stderr: add.stderr });
    assert.equal(add.status, 0, 'Own Orchestrator index write must succeed');
    for (const prefix of [root, path.join(alias, 'root')]) probe('deny symlink replacement', "import{unlinkSync}from'node:fs';unlinkSync(process.argv[1]);", [path.join(prefix, 'raf-main')], 'deny');
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'secrets.json']) {
      probe('deny state ' + name, "import{readFileSync}from'node:fs';readFileSync(process.argv[1]);", [path.join(alias, 'state', name)], 'deny');
    }
    for (const [name, socket] of [['peer', path.join(cwd, 'qa/peer.sock')], ['host-main', path.join(path.dirname(root), 'main.sock')]]) {
      fs.symlinkSync(socket, path.join(alias, name + '.sock'));
      for (const p of [socket, path.join(alias, name + '.sock')]) probe('deny foreign connection ' + name, "import{connect}from'node:net';const s=connect(process.argv[1]);s.on('error',()=>{process.exitCode=19});s.on('connect',()=>s.end());s.setTimeout(2000,()=>{s.destroy();process.exitCode=20});", [p], 'deny');
    }
    probe('allow own IPC', "import{createServer,connect}from'node:net';const s=createServer(c=>c.end('own'));s.listen(process.argv[1],()=>{const c=connect(process.argv[1]);c.on('data',b=>process.stdout.write(b));c.on('end',()=>s.close());});", [path.join(own, 'sym64-own-' + stage + '.sock')], 'allow');
  }
} catch (e) { error = e.message; }
const value = { stage, runId: path.basename(own), cwd, status: error ? 'failed' : 'passed', error, results };
const file = path.join(own, 'sym64-stage-' + stage + '.json'); fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file);
console.log(JSON.stringify(value));
if (error) process.exit(1);
const deadline = Date.now() + 900000;
while (!fs.existsSync(path.join(own, 'sym64-go-' + stage))) { if (Date.now() > deadline) throw Error('Host gate timeout'); await delay(300); }
