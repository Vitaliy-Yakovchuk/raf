import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const [sourceSha] = process.argv.slice(2), source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.RAF_QA_HOME;
assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);
assert.ok(home && home === process.env.HOME && home === process.env.TMPDIR);
assert.ok(home.startsWith('/tmp/') && fs.realpathSync(home) === home);
assert.equal(fs.statSync(home).mode & 0o077, 0);
assert.ok(!fs.existsSync(path.join(home, '.raf')));
const stand = path.join(home, 'stand'), evidence = path.join(home, 'z334-supplement-evidence');
assert.ok(!fs.existsSync(stand) && !fs.existsSync(evidence));
fs.mkdirSync(stand, { mode: 0o700 }); fs.mkdirSync(evidence, { mode: 0o700 });
const root = path.join(stand, 'root'), main = path.join(root, 'raf-main'), hotfix = path.join(root, 'raf-hotfix'), develop = path.join(root, 'raf-develop');
for (const dir of [root, path.join(stand, 'commands'), path.join(stand, 'pane')]) fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, HOME: home, RAF_QA_HOME: home, TMPDIR: home, CODEX_HOME: path.join(home, 'empty-codex'), XDG_CONFIG_HOME: path.join(home, '.config'), TMUX_TMPDIR: path.join(home, 'tmux'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Z334 QA fixture', GIT_AUTHOR_EMAIL: 'z334@example.invalid', GIT_COMMITTER_NAME: 'Z334 QA fixture', GIT_COMMITTER_EMAIL: 'z334@example.invalid' };
for (const name of Object.keys(env)) if (/^(GIT_CONFIG_(KEY|VALUE)_|RAF_)/.test(name) && name !== 'RAF_QA_HOME' || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'ALLOW_MIGRATIONS', 'CLAUDE_CONFIG_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(name)) delete env[name];
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);
for (const dir of [env.CODEX_HOME, env.XDG_CONFIG_HOME, env.TMUX_TMPDIR]) fs.mkdirSync(dir);
const summary = { status: 'failed', kind: 'host-integration', runId: randomUUID(), sourceSha, startedAt: new Date().toISOString(), modelPromptMayBeSent: false, steps: [], assertions: [], unexecuted: [], cleanup: {}, limitations: ['Supplement only; cannot replace the real runner cycle in z334-host-qa.mjs.', 'No unit execution or change to the z392 aggregate.', 'No owner HOME, auth or model configuration is accessed.'] };
const required = ['seal-blocks-writer', 'mutation-during-regression', 'main-refresh', 'develop-conflict', 'interrupted-foreign-work'];
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(file + '.part', file); };
const hash = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
let sequence = 0, readiness, pollMs, api, work, host, code, control, started = false, interrupted, cleaning = false;
const children = new Set(), socket = path.join(home, 'z334-main.sock');
assert.ok(Buffer.byteLength(socket) <= 107);
const record = (name, data = {}) => { summary.assertions.push({ name, status: 'passed', ...data }); atomic(path.join(evidence, 'progress.json'), summary); };
const command = (label, executable, args, cwd = root) => {
  assert.ok(!interrupted || cleaning, 'Interrupted: ' + interrupted);
  const out = fs.openSync(path.join(evidence, label + '.stdout'), 'wx', 0o600), err = fs.openSync(path.join(evidence, label + '.stderr'), 'wx', 0o600);
  let result;
  try { result = spawnSync(executable, args, { cwd, env, stdio: ['ignore', out, err] }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const r = { command: [executable, ...args], cwd, cliExitCode: result.status, signal: result.signal, error: result.error?.message ?? null };
  atomic(path.join(evidence, label + '.json'), r); summary.steps.push({ label, ...r });
  return { ...r, stdout: fs.readFileSync(path.join(evidence, label + '.stdout'), 'utf8'), stderr: fs.readFileSync(path.join(evidence, label + '.stderr'), 'utf8') };
};
const must = r => { assert.equal(r.error, null); assert.equal(r.signal, null); assert.equal(r.cliExitCode, 0, r.stderr); return r.stdout.trim(); };
const git = (cwd, ...args) => must(command('git-' + (++sequence), 'git', ['-C', cwd, ...args], cwd));
const wait = async (label, read) => {
  const end = Date.now() + readiness;
  while (Date.now() < end) { assert.ok(!interrupted || cleaning, 'Interrupted: ' + interrupted); const result = read(); if (result) return result; await delay(100); }
  throw Error('Incomplete host scenario: ' + label);
};
const request = async (label, args) => {
  const result = path.join(stand, 'pane', label + '.json');
  atomic(path.join(stand, 'commands', String(++sequence).padStart(6, '0') + '.json'), { label, args });
  await wait(label, () => fs.existsSync(result));
  const r = JSON.parse(fs.readFileSync(result, 'utf8')); summary.steps.push({ label, ...r });
  return { ...r, stdout: fs.readFileSync(path.join(stand, 'pane', label + '.stdout'), 'utf8'), stderr: fs.readFileSync(path.join(stand, 'pane', label + '.stderr'), 'utf8') };
};
const identity = cwd => ({ head: git(cwd, 'rev-parse', 'HEAD'), tree: git(cwd, 'rev-parse', 'HEAD^{tree}'), index: hash(path.join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'index')), status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'), inode: fs.statSync(cwd).ino, files: ['a.mjs', 'b.mjs', 'foreign.txt', 'main-only.txt'].map(name => hash(path.join(cwd, 'qa-z334', name))) });
const liveIdentity = () => ({ ...identity(main), gitlink: git(root, 'ls-files', '--stage', '--', 'raf-main') });
const refused = async (label, action, pattern) => {
  const before = liveIdentity(); let error;
  try { await action(); } catch (caught) { error = caught.message; }
  assert.ok(error, label + ' must refuse'); assert.match(error, pattern); assert.deepEqual(liveIdentity(), before);
  atomic(path.join(evidence, 'refusal-' + label + '.json'), { label, error, before, after: liveIdentity() });
};
const candidate = async marker => {
  const ws = await work.prepareHotfixWorktree(host, randomUUID());
  for (const name of ['a.mjs', 'b.mjs']) fs.writeFileSync(path.join(hotfix, 'qa-z334', name), `export const marker = ${JSON.stringify(marker)};\n`);
  await work.commitHotfix(host, { workspace: ws, paths: ['qa-z334/a.mjs', 'qa-z334/b.mjs'], message: 'qa: ' + marker });
  return ws;
};
const verify = async ws => {
  const message = 'z334-supplement-' + randomUUID(), result = await api.verifyHotfixCandidate(host, { workspace: ws, regression: { executable: process.execPath, args: ['qa-z334/smoke.mjs'] }, mainAddress: 'main', message });
  assert.equal(result.commit, git(hotfix, 'rev-parse', 'HEAD')); assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.gates.map(row => row.name).sort(), ['build', 'regression', 'runtime-import', 'help', 'agent-ps', 'agent-message', 'service-start', 'service-ready', 'service-status', 'service-stop'].sort());
  for (const gate of result.gates) { assert.equal(gate.status, 'passed'); assert.equal(gate.code, 0); assert.equal(gate.commit, result.commit); assert.equal(gate.fingerprint, result.fingerprint); }
  await wait('once delivery', () => fs.existsSync(path.join(stand, 'pane/inbox.bin')) && fs.readFileSync(path.join(stand, 'pane/inbox.bin'), 'utf8').includes(message));
  assert.equal(fs.readFileSync(path.join(stand, 'pane/inbox.bin'), 'utf8').split(message).length - 1, 1);
  return result;
};
const receive = (child, predicate) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(Error('Child scenario deadline')), readiness);
  const message = row => { if (predicate(row)) finish(null, row); else if (row.error) finish(Error(row.error)); };
  const exit = (status, signal) => finish(Error('Child exited: ' + status + '/' + signal));
  function finish(error, value) { clearTimeout(timer); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(value); }
  child.on('message', message); child.once('exit', exit);
});
const fork = payload => {
  const id = 'child-' + (++sequence), file = path.join(stand, id + '.json'); atomic(file, { ...payload, code, host });
  const out = fs.openSync(path.join(evidence, id + '.stdout'), 'wx'), err = fs.openSync(path.join(evidence, id + '.stderr'), 'wx');
  const child = spawn(process.execPath, [path.join(code, 'test/helpers/z334-process.mjs'), file], { cwd: stand, env, stdio: ['ignore', out, err, 'ipc'] });
  fs.closeSync(out); fs.closeSync(err); children.add(child);
  child.on('message', row => fs.appendFileSync(path.join(evidence, id + '.events.jsonl'), JSON.stringify(row) + '\n'));
  return child;
};
const assertMain = (commit, marker) => {
  assert.equal(git(main, 'rev-parse', 'HEAD'), commit); assert.equal(git(main, 'rev-parse', 'refs/heads/main'), commit);
  assert.equal(git(main, 'diff', '--cached', commit, '--name-only'), ''); assert.equal(git(main, 'status', '--porcelain=v1'), '');
  assert.match(git(root, 'ls-files', '--stage', '--', 'raf-main'), new RegExp('^160000 ' + commit + ' 0\\t'));
  for (const name of ['a.mjs', 'b.mjs']) assert.equal(fs.readFileSync(path.join(main, 'qa-z334', name), 'utf8'), `export const marker = ${JSON.stringify(marker)};\n`);
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = signal; });
try {
  summary.sourceWorkspace = { head: git(source, 'rev-parse', 'HEAD'), status: git(source, 'status', '--porcelain=v1', '--untracked-files=all') };
  for (const file of ['test/z334-supplement-qa.mjs', 'test/helpers/z334-main-pane.mjs', 'test/helpers/z334-process.mjs', 'test/helpers/z334-smoke.mjs']) assert.equal(fs.readFileSync(path.join(source, file), 'utf8').trim(), must(command('reviewed-' + (++sequence), 'git', ['show', sourceSha + ':' + file], source)));
  for (const [exe, args] of [['node', ['--version']], ['git', ['--version']], ['tmux', ['-V']], ['python3', ['--version']], ['uname', ['-a']]]) must(command('version-' + exe, exe, args));
  must(command('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main]));
  git(main, 'branch', '-m', git(main, 'symbolic-ref', '--short', 'HEAD'), 'z334-imported'); git(main, 'checkout', '--detach', sourceSha); git(main, 'switch', '-c', 'main');
  fs.cpSync(path.join(path.dirname(source), 'conf'), path.join(root, 'conf'), { recursive: true });
  const projectsFile = path.join(root, 'conf/projects.json'), projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator }; projects.projects.raf.path = 'raf-main'; projects.projects.raf.branchPaths = { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' };
  fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2) + '\n');
  const protocol = JSON.parse(fs.readFileSync(path.join(root, 'conf/raf.json'), 'utf8')).runnerProtocols.find(row => row.runner === 'codex'); readiness = protocol.timeouts.transitionMs; pollMs = protocol.timeouts.pollMs;
  summary.configuration = Object.fromEntries(['raf.json', 'models.json', 'flow.json', 'test-runs.json'].map(name => [name, hash(path.join(root, 'conf', name))]));
  assert.ok(fs.existsSync(path.join(source, 'node_modules/typescript'))); fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
  must(command('baseline-build', 'npm', ['run', 'build'], main));
  fs.mkdirSync(path.join(main, 'qa-z334')); for (const name of ['a.mjs', 'b.mjs']) fs.writeFileSync(path.join(main, 'qa-z334', name), 'export const marker = "old";\n');
  fs.copyFileSync(path.join(main, 'test/helpers/z334-smoke.mjs'), path.join(main, 'qa-z334/smoke.mjs'));
  git(main, 'add', '--', 'qa-z334'); git(main, 'add', '-f', '--', 'dist'); git(main, 'commit', '-m', 'qa: isolated supplementary Z334 markers');
  git(root, 'init', '-b', 'main'); git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main'); git(root, 'submodule', 'absorbgitdirs');
  const base = git(main, 'rev-parse', 'HEAD'); git(main, 'worktree', 'add', '-b', 'develop', develop, base); git(main, 'worktree', 'add', '-b', 'hotfix', hotfix, base); git(root, 'clone', '--bare', '--no-hardlinks', main, path.join(stand, 'origin.git'));
  code = path.join(stand, 'controller'); fs.cpSync(main, code, { recursive: true, filter: file => path.basename(file) !== '.git' });
  fs.writeFileSync(path.join(root, 'foreign-parent.txt'), 'parent baseline\n'); git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'foreign-parent.txt'); git(root, 'commit', '-m', 'qa: supplementary Z334 parent');
  fs.writeFileSync(path.join(root, 'foreign-parent.txt'), 'foreign staged parent work\n'); git(root, 'add', '--', 'foreign-parent.txt'); const parentDiff = git(root, 'diff', '--cached', '--', 'foreign-parent.txt');
  env.RAF_ORCHESTRATOR_ROOT = root; process.env.RAF_ORCHESTRATOR_ROOT = root; host = { orchestratorRoot: root, qaHome: home, environment: env, sandboxExecutable: 'codex' };
  api = await import(pathToFileURL(path.join(code, 'src/hotfix-activation.ts'))); work = await import(pathToFileURL(path.join(code, 'src/hotfix-worktree.ts')));
  control = path.join(git(main, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'raf-hotfix');
  must(command('tmux-start', 'tmux', ['-S', socket, 'new-session', '-d', '-s', 'z334-main', '-x', '200', '-y', '60', process.execPath, path.join(code, 'test/helpers/z334-main-pane.mjs'), stand])); started = true;
  await wait('main attach', () => fs.existsSync(path.join(stand, 'pane/attach.json'))); assert.equal(JSON.parse(fs.readFileSync(path.join(stand, 'pane/attach.json'), 'utf8')).cliExitCode, 0);
  await api.recoverHotfixActivation(host); summary.initial = liveIdentity();
  const ws = await candidate('refresh'), inode = fs.statSync(hotfix).ino;
  const hostApi = await import(pathToFileURL(path.join(code, 'src/hotfix-host.ts')));
  let entered, releaseSeal, writerEntered = false; const checkpoint = new Promise(resolve => { entered = resolve; });
  const sealing = api.sealHotfixSnapshot(host, ws, { checkpoint: async phase => { if (phase === 'before-copy') { entered(); await new Promise(resolve => { releaseSeal = resolve; }); } } });
  await checkpoint; const writer = hostApi.withHotfixWriter(host, async () => { writerEntered = true; });
  try { await delay(pollMs); assert.equal(writerEntered, false); } finally { releaseSeal(); }
  const sealed = await sealing; await writer; assert.equal(writerEntered, true); record('seal-blocks-writer', { fingerprint: sealed.fingerprint });
  for (const [label, file] of [['source', path.join(hotfix, 'qa-z334/a.mjs')], ['artifact', path.join(hotfix, 'dist/catalog.json')], ['conf', path.join(root, 'conf/raf.json')]]) {
    const original = fs.readFileSync(file);
    try { await refused('during-regression-' + label, () => api.verifyHotfixCandidate(host, { workspace: ws, mainAddress: 'main', message: 'unused', regression: { executable: process.execPath, args: ['-e', 'require("node:fs").appendFileSync(process.argv[1], "\\n ")', file] } }), /changed|dirty|fingerprint|snapshot|gate/i); }
    finally { fs.writeFileSync(file, original); }
  }
  record('mutation-during-regression');
  const old = await verify(ws), beforeAdvance = identity(hotfix);
  fs.writeFileSync(path.join(main, 'qa-z334/main-only.txt'), 'new main input\n'); git(main, 'add', '--', 'qa-z334/main-only.txt'); git(main, 'commit', '-m', 'qa: independent main advance');
  const mainHead = git(main, 'rev-parse', 'HEAD'); git(root, 'add', '--', 'raf-main'); git(root, 'commit', '--only', '-m', 'qa: record advanced main', '--', 'raf-main');
  await refused('advanced-main', () => api.activateHotfix(host, old), /stale|base|conflict|changed/i); assert.deepEqual(identity(hotfix), beforeAdvance);
  for (const kind of ['untracked', 'staged', 'unstaged']) {
    const file = path.join(hotfix, 'qa-z334', kind === 'untracked' ? 'foreign.txt' : 'a.mjs'), original = fs.existsSync(file) ? fs.readFileSync(file) : null;
    fs.appendFileSync(file, 'foreign preparation work\n'); if (kind === 'staged') git(hotfix, 'add', '--', 'qa-z334/a.mjs'); const expected = identity(hotfix);
    try { await refused('refresh-' + kind, () => work.prepareHotfixWorktree(host, randomUUID()), /dirty|index|clean|local|untracked/i); assert.deepEqual(identity(hotfix), expected); }
    finally { if (original) fs.writeFileSync(file, original); else fs.unlinkSync(file); if (kind === 'staged') git(hotfix, 'add', '--', 'qa-z334/a.mjs'); }
  }
  const refreshed = await work.prepareHotfixWorktree(host, randomUUID()); assert.equal(refreshed.cwd, hotfix); assert.equal(refreshed.baseCommit, mainHead);
  git(hotfix, 'merge-base', '--is-ancestor', old.commit, 'HEAD'); git(hotfix, 'merge-base', '--is-ancestor', mainHead, 'HEAD');
  await refused('old-proof-after-refresh', () => api.activateHotfix(host, old), /stale|base|snapshot|fingerprint|commit|changed/i);
  const fresh = await verify(refreshed); assert.notEqual(fresh.commit, old.commit); assert.notEqual(fresh.fingerprint, old.fingerprint);
  for (const gate of fresh.gates) assert.ok(!old.gates.some(previous => previous.logPath === gate.logPath));
  assert.equal((await api.activateHotfix(host, fresh)).status, 'activated'); assertMain(fresh.commit, 'refresh'); assert.equal(fs.readFileSync(path.join(main, 'qa-z334/main-only.txt'), 'utf8'), 'new main input\n');
  assert.equal(fs.statSync(hotfix).ino, inode); assert.equal(git(root, 'diff', '--cached', '--', 'foreign-parent.txt'), parentDiff);
  record('main-refresh', { base, mainHead, old: { commit: old.commit, fingerprint: old.fingerprint }, fresh: { commit: fresh.commit, fingerprint: fresh.fingerprint, gates: fresh.gates } });
  fs.writeFileSync(path.join(develop, 'qa-z334/a.mjs'), 'export const marker = "developer";\n'); git(develop, 'add', '--', 'qa-z334/a.mjs'); git(develop, 'commit', '-m', 'qa: concurrent developer commit');
  const developerHead = git(develop, 'rev-parse', 'HEAD'); fs.writeFileSync(path.join(develop, 'developer-untracked.txt'), 'developer work\n'); const liveBeforeConflict = liveIdentity();
  const conflict = command('develop-conflict', 'git', ['-C', develop, 'merge', '--no-edit', fresh.commit], develop); assert.equal(conflict.cliExitCode, 1); assert.match(conflict.stdout + conflict.stderr, /CONFLICT/);
  assert.equal(git(develop, 'rev-parse', 'HEAD'), developerHead); assert.equal(fs.readFileSync(path.join(develop, 'developer-untracked.txt'), 'utf8'), 'developer work\n'); assert.ok(git(develop, 'ls-files', '--unmerged').includes('qa-z334/a.mjs')); assert.deepEqual(liveIdentity(), liveBeforeConflict);
  record('develop-conflict', { developerHead, target: fresh.commit, transfer: 'open', mergeExitCode: conflict.cliExitCode, workspaceStatus: git(develop, 'status', '--porcelain=v1') });
  const interruptedWs = await candidate('interrupted'), verified = await verify(interruptedWs);
  const publisher = fork({ mode: 'crash', phase: 'after-switch', candidate: verified, exchangeLog: path.join(evidence, 'exchanges.jsonl') }); await receive(publisher, row => row.phase === 'after-switch');
  const exited = once(publisher, 'exit'); publisher.kill('SIGKILL'); const killed = await exited; assert.equal(killed[1], 'SIGKILL');
  fs.writeFileSync(path.join(hotfix, 'qa-z334/a.mjs'), 'export const marker = "not-verified";\n'); await work.commitHotfix(host, { workspace: interruptedWs, paths: ['qa-z334/a.mjs'], message: 'qa: writer after interrupted activation' });
  const laterHead = git(hotfix, 'rev-parse', 'HEAD'); fs.writeFileSync(path.join(hotfix, 'qa-z334/b.mjs'), 'foreign staged\n'); git(hotfix, 'add', '--', 'qa-z334/b.mjs'); fs.appendFileSync(path.join(hotfix, 'qa-z334/a.mjs'), 'foreign unstaged\n'); fs.writeFileSync(path.join(hotfix, 'qa-z334/foreign.txt'), 'foreign untracked\n'); const foreign = identity(hotfix);
  const recovery = fork({ mode: 'recover' }), recovered = await receive(recovery, row => row.result); assert.equal(recovered.result.pending, false); assert.ok([interruptedWs.baseCommit, verified.commit].includes(recovered.result.commit)); assert.notEqual(recovered.result.commit, laterHead);
  assertMain(recovered.result.commit, recovered.result.commit === verified.commit ? 'interrupted' : 'refresh'); assert.deepEqual(identity(hotfix), foreign);
  await api.recoverHotfixActivation(host); await api.cleanupHotfixActivation(host); await work.cleanupHotfixWorktree(host, interruptedWs); assert.deepEqual(identity(hotfix), foreign); assert.equal(fs.statSync(hotfix).ino, inode); assert.equal(git(root, 'diff', '--cached', '--', 'foreign-parent.txt'), parentDiff);
  record('interrupted-foreign-work', { killed, base: interruptedWs.baseCommit, target: verified.commit, fingerprint: verified.fingerprint, laterHead, recovery: recovered.result, foreign });
  summary.final = { main: liveIdentity(), hotfix: identity(hotfix), develop: identity(develop) }; summary.status = 'succeeded';
} catch (error) { summary.error = { message: error.message, stack: error.stack }; }
finally {
  cleaning = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  const errors = [];
  try {
    if (started) {
      const stop = await request('cleanup-service-stop', ['service', 'stop']); if (stop.cliExitCode !== 0) errors.push('service-stop');
      for (const [label, endpoint] of [['agents', path.join(home, '.raf/tmp/tmux/server.sock')], ['main', socket]]) { const r = command('cleanup-tmux-' + label, 'tmux', ['-S', endpoint, 'kill-server']); if (r.cliExitCode !== 0 && !/no server|No such file/i.test(r.stderr)) errors.push('tmux ' + label); }
    }
  } catch (error) { errors.push(error.message); }
  if (fs.existsSync(path.join(stand, 'pane'))) fs.cpSync(path.join(stand, 'pane'), path.join(evidence, 'pane'), { recursive: true });
  if (control && fs.existsSync(control)) {
    const verifications = path.join(control, 'verification');
    if (fs.existsSync(verifications)) for (const run of fs.readdirSync(verifications)) for (const id of fs.readdirSync(path.join(verifications, run))) { const from = path.join(verifications, run, id), to = path.join(evidence, 'verification', run, id); fs.mkdirSync(to, { recursive: true }); for (const file of fs.readdirSync(from).filter(name => name.endsWith('.json'))) fs.copyFileSync(path.join(from, file), path.join(to, file)); }
    for (const file of ['registry.json', 'intent.json']) if (fs.existsSync(path.join(control, file))) fs.copyFileSync(path.join(control, file), path.join(evidence, file));
  }
  const remaining = [];
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name) && Number(name) !== process.pid)) try { const cwd = fs.readlinkSync('/proc/' + pid + '/cwd'), args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0'); if (cwd === stand || cwd.startsWith(stand + path.sep) || args.some(arg => arg.startsWith(stand + path.sep) || arg === socket || arg === path.join(home, '.raf/tmp/tmux/server.sock'))) remaining.push({ pid: Number(pid), cwd, start: fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ')[19] }); } catch {}
  summary.cleanup = { complete: errors.length === 0 && remaining.length === 0, errors, remaining, standRemoved: false };
  if (summary.cleanup.complete) { fs.rmSync(stand, { recursive: true }); summary.cleanup.standRemoved = !fs.existsSync(stand); }
  summary.unexecuted = required.filter(name => !summary.assertions.some(row => row.name === name)); if (summary.unexecuted.length || !summary.cleanup.complete || interrupted) summary.status = 'failed';
  summary.interrupted = interrupted ?? null; summary.finishedAt = new Date().toISOString(); atomic(path.join(evidence, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, runId: summary.runId, sourceSha, evidence: path.join(evidence, 'summary.json'), assertions: summary.assertions.map(row => row.name), unexecuted: summary.unexecuted, cleanup: summary.cleanup, error: summary.error?.message ?? null })); process.exitCode = summary.status === 'succeeded' ? 0 : 1;
}
