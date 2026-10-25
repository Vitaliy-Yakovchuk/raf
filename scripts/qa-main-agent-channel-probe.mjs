import fs from 'node:fs';
import { assertNativeDenial, nativeProbeReceipt } from './qa-main-agent-denial.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const [stageText, report] = process.argv.slice(2), stage = Number(stageText);
assert.ok([0, 1, 2, 3].includes(stage) && path.isAbsolute(report));
const cwd = fs.realpathSync(process.cwd()), root = path.dirname(cwd), own = path.dirname(report);
assert.match(root, /^\/srv\/dev\/s64-[^/]+\/root$/);
assert.ok(own.startsWith(path.dirname(root) + '/.raf/tmp/'));
const results = [];
const command = (label, executable, args, expected) => {
  const r = spawnSync(executable, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  results.push({ label, command: [executable, ...args], cliExitCode: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.message });
  assert.equal(r.signal, null, label + ' must complete');
  assert.ok(r.status !== null && (expected === 'deny' ? r.status !== 0 : r.status === 0), label + ': ' + r.stderr);
  if (label.includes('foreign connection')) { assert.equal(r.status, 19, 'Socket timeout is not a denial'); assert.match(r.stderr, /EACCES|EPERM|ENOENT/); }
  return r.stdout.trim();
};
const probe = (label, code, args, expected, hiddenRead) => {
  for (const childShell of [false, true]) {
    const argv = ['--input-type=module', '-e', code, ...args];
    command(label + (childShell ? ' child-shell' : ' direct'), childShell ? '/bin/sh' : process.execPath,
      childShell ? ['-c', 'exec "$@"', 'probe', process.execPath, ...argv] : argv, expected);
    if (expected === 'deny' && !label.includes('connection')) assertNativeDenial(results.at(-1), hiddenRead);
  }
};
const atomic = (name, value) => { const p = path.join(own, name + '.json'); fs.writeFileSync(p + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(p + '.part', p); };
const wait = async name => {
  const deadline = Date.now() + 900000;
  while (!fs.existsSync(path.join(own, name))) { if (Date.now() > deadline) throw Error('Host gate timeout: ' + name); await delay(300); }
};
const ownCommits = () => {
  for (const [repository, directory] of [[cwd, path.join(cwd, 'qa')], [root, path.join(root, 'openspec/changes/sym64-fixture')]]) {
    const file = path.join(directory, `own-${path.basename(own)}-${stage}.txt`);
    fs.writeFileSync(file, 'Own isolated native commit\n');
    command('own add ' + repository, 'git', ['-C', repository, 'add', '--', file], 'allow');
    command('own commit ' + repository, 'git', ['-C', repository, '-c', 'user.name=Isolated native QA', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--only', '-m', `qa: own ${path.basename(own)} stage ${stage}`, '--', file], 'allow');
    command('own commit visible ' + repository, 'git', ['-C', repository, 'log', '-1', '--format=%H', '--', file], 'allow');
  }
};
let error;
try {
  if (!stage) {
    atomic('sym64-stage-0', { stage, runId: path.basename(own), cwd, status: 'ready' });
    await wait('sym64-commit-0');
    ownCommits();
    atomic('sym64-source-0', { status: 'passed', results });
  } else {
    const alias = path.join(own, 'sym64-aliases-' + stage); fs.mkdirSync(alias);
    const source = command('source common', 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'allow');
    const control = path.join(source, 'raf-hotfix'), production = path.join(control, 'main.git');
    fs.symlinkSync(root, path.join(alias, 'root')); fs.symlinkSync(production, path.join(alias, 'production'));
    fs.symlinkSync(control, path.join(alias, 'activation')); fs.symlinkSync(path.join(path.dirname(root), '.raf'), path.join(alias, 'state'));
    const operations = {
      write: "import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],'sym64-tampered');",
      create: "import{openSync,closeSync}from'node:fs';closeSync(openSync(process.argv[1],'wx'));",
      rename: "import{renameSync}from'node:fs';renameSync(process.argv[1],process.argv[1]+'.native-renamed');",
      unlink: "import{unlinkSync}from'node:fs';unlinkSync(process.argv[1]);",
    };
    for (const prefix of [root, path.join(alias, 'root')]) {
      for (const target of ['raf-main-a/bin/raf.ts', 'raf-main-b/bin/raf.ts', 'raf-main/bin/raf.ts', '.gitmodules', 'raf-main-a/.git', 'raf-main-b/.git']) {
        for (const op of ['write', 'rename', 'unlink']) probe('deny ' + op + ' ' + target, operations[op], [path.join(prefix, target)], 'deny');
      }
      probe('deny symlink replacement', operations.unlink, [path.join(prefix, 'raf-main')], 'deny');
      for (const slot of ['raf-main-a', 'raf-main-b', 'raf-main']) probe('deny slot create', operations.create, [path.join(prefix, slot, 'native-absent-' + stage)], 'deny');
    }
    for (const prefix of [production, path.join(alias, 'production')]) {
      for (const target of ['HEAD', 'index', 'config', 'refs/heads/main', 'packed-refs', 'logs/refs/heads/main']) {
        for (const op of ['write', 'rename', 'unlink']) {
          if (op !== 'write' && !fs.existsSync(path.join(prefix, target))) continue;
          probe('deny production ' + op + ' ' + target, operations[op], [path.join(prefix, target)], 'deny');
        }
      }
      for (const target of ['index.lock', 'HEAD.lock', 'config.worktree', 'config.worktree.lock', 'packed-refs.lock', 'refs/heads/main.lock', 'logs/refs/heads/main.lock']) probe('deny production create ' + target, operations.create, [path.join(prefix, target)], 'deny');
      probe('deny production directory create', "import{mkdirSync}from'node:fs';mkdirSync(process.argv[1]);", [path.join(prefix, 'native-directory-' + stage)], 'deny');
      probe('deny production directory rename', operations.rename, [path.join(prefix, 'refs/heads')], 'deny');
      probe('deny Git environment common redirect', "import{spawnSync}from'node:child_process';const r=spawnSync('git',['update-ref','refs/heads/native-env-denied','HEAD'],{env:{...process.env,GIT_DIR:process.argv[1],GIT_COMMON_DIR:process.argv[1]},stdio:'inherit'});process.exit(r.status??1);", [prefix], 'deny');
    }
    for (const slot of ['raf-main-a', 'raf-main-b']) {
      const directory = command('slot directory ' + slot, 'git', ['-C', path.join(root, slot), 'rev-parse', '--absolute-git-dir'], 'allow');
      for (const target of ['HEAD', 'index']) for (const op of ['write', 'rename', 'unlink']) probe('deny slot metadata ' + op, operations[op], [path.join(directory, target)], 'deny');
      for (const target of ['HEAD.lock', 'index.lock', 'config.worktree', 'config.worktree.lock']) probe('deny slot metadata create', operations.create, [path.join(directory, target)], 'deny');
      probe('deny Git env index redirect', "import{spawnSync}from'node:child_process';const r=spawnSync('git',['-C',process.argv[1],'read-tree','HEAD'],{env:{...process.env,GIT_INDEX_FILE:process.argv[2]},stdio:'inherit'});process.exit(r.status??1);", [cwd, path.join(directory, 'native-index-' + stage)], 'deny');
    }
    for (const prefix of [control, path.join(alias, 'activation')]) {
      for (const op of ['write', 'rename', 'unlink']) probe('deny activation ' + op, operations[op], [path.join(prefix, 'registry.json')], 'deny');
      probe('deny activation create', operations.create, [path.join(prefix, 'native-activation-' + stage)], 'deny');
    }
    const readControls = JSON.parse(fs.readFileSync(path.join(own, 'sym64-read-controls-' + stage + '.json')));
    assert.equal(readControls.stage, stage); assert.equal(readControls.runId, path.basename(own));
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'secrets.json']) {
      const target = path.join(path.dirname(root), '.raf', name), control = readControls.files.find(file => file.path === target);
      assert.ok(control, 'Host must confirm the actual hidden read target exists');
      for (const prefix of [path.join(alias, 'state'), path.dirname(target)]) probe('deny state ' + name, "import{readFileSync}from'node:fs';readFileSync(process.argv[1]);", [path.join(prefix, name)], 'deny', { target, control });
    }
    assert.ok(Array.isArray(readControls.sockets) && readControls.sockets.length >= 2, 'Host must confirm registered live foreign endpoints');
    for (const control of readControls.sockets) {
      const { name, path: socket, runId, dev, ino } = control;
      assert.ok(path.isAbsolute(socket) && runId && control.socket === true && Number.isInteger(dev) && Number.isInteger(ino) && ino > 0, 'Foreign endpoint needs exact registered host controls');
      fs.symlinkSync(socket, path.join(alias, name + '.sock'));
      for (const p of [socket, path.join(alias, name + '.sock')]) probe('deny foreign connection ' + name, "import{connect}from'node:net';const s=connect(process.argv[1]);s.on('error',e=>{console.error(e.code);process.exitCode=19});s.on('connect',()=>s.end());s.setTimeout(2000,()=>{s.destroy();process.exitCode=20});", [p], 'deny');
    }
    probe('allow own IPC', "import{createServer,connect}from'node:net';const s=createServer(c=>c.end('own'));s.listen(process.argv[1],()=>{const c=connect(process.argv[1]);c.on('data',b=>process.stdout.write(b));c.on('end',()=>s.close());});", [path.join(own, 'sym64-own-' + stage + '.sock')], 'allow');
    ownCommits();
  }
} catch (e) { error = e.message; }
const value = { stage, runId: path.basename(own), cwd, status: error ? 'failed' : 'passed', error, results };
atomic(stage ? 'sym64-stage-' + stage : 'sym64-source-0', value);
console.log(JSON.stringify(nativeProbeReceipt(value, path.join(own, (stage ? 'sym64-stage-' + stage : 'sym64-source-0') + '.json'))));
if (error) process.exit(1);
await wait('sym64-go-' + stage);
