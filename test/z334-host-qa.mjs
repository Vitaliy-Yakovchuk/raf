import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const [sourceSha, mode = 'core', scope = 'all'] = process.argv.slice(2);
const driver = fileURLToPath(import.meta.url), source = path.resolve(path.dirname(driver), '..');
const home = process.env.RAF_QA_HOME;
assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);
assert.ok(['core', 'live'].includes(mode));
assert.ok(['all', 'remaining'].includes(scope));
assert.ok(scope !== 'remaining' || mode === 'live', 'Remaining scenarios require real workers');
assert.ok(home && home === process.env.HOME && home === process.env.TMPDIR, 'Explicit isolated HOME=RAF_QA_HOME=TMPDIR required');
assert.ok(home.startsWith('/tmp/') && fs.realpathSync(home) === home, 'Canonical own mktemp directory under /tmp required');
assert.equal(fs.statSync(home).mode & 0o077, 0, 'QA HOME must be private');
assert.ok(!fs.existsSync(path.join(home, '.raf')), 'Never reuse working or prior QA state');
const codeHome = mode === 'live' ? process.env.CODEX_HOME : path.join(home, 'empty-codex');
assert.ok(codeHome && path.isAbsolute(codeHome), 'live requires explicit existing CODEX_HOME; no auth copy');
const stand = path.join(home, 'stand'), ev = path.join(home, 'z334-evidence');
assert.ok(!fs.existsSync(stand) && !fs.existsSync(ev), 'Do not replay or overwrite an unknown result');
fs.mkdirSync(stand, { mode: 0o700 }); fs.mkdirSync(ev, { mode: 0o700 });
const root = path.join(stand, 'root'), main = path.join(root, 'raf-main'), hotfix = path.join(root, 'raf-hotfix'), develop = path.join(root, 'raf-develop');
for (const dir of [root, path.join(stand, 'commands'), path.join(stand, 'pane')]) fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, HOME: home, RAF_QA_HOME: home, TMPDIR: home, CODEX_HOME: codeHome, XDG_CONFIG_HOME: path.join(home, '.config'), TMUX_TMPDIR: path.join(home, 'tmux'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Z334 QA fixture', GIT_AUTHOR_EMAIL: 'z334@example.invalid', GIT_COMMITTER_NAME: 'Z334 QA fixture', GIT_COMMITTER_EMAIL: 'z334@example.invalid', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' };
for (const name of Object.keys(env)) if (/^(GIT_CONFIG_(KEY|VALUE)_|RAF_)/.test(name) && !['RAF_QA_HOME'].includes(name) || ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'ALLOW_MIGRATIONS', 'CLAUDE_CONFIG_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(name)) delete env[name];
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);
fs.mkdirSync(env.TMUX_TMPDIR); fs.mkdirSync(env.XDG_CONFIG_HOME);
if (mode === 'core') fs.mkdirSync(codeHome);
const summary = { status: 'failed', kind: 'host-integration', runId: randomUUID(), sourceSha, mode, scope, inheritedEvidence: scope === 'remaining' ? { live: { runId: '88157390-93ab-4007-a49c-3ca2ddc55946', sourceSha: '1968689352e27541408d5efedf01ba9704bc008a', path: 'openspec/changes/complete-raf-flow-contracts/z334-qa/host2-1968689/live/summary.json', accepted: ['setup', 'negative-gates', 'snapshot-gates', 'writer-barrier'] }, supplement: { runId: '097d7a09-2ff3-4bf8-ab5d-479b3f76131c', sourceSha: '1968689352e27541408d5efedf01ba9704bc008a', path: 'openspec/changes/complete-raf-flow-contracts/z334-qa/host2-1968689/supplement/summary.json', accepted: '5/5; retained, not rerun' } } : null, startedAt: new Date().toISOString(), driverSha256: null, modelPromptMayBeSent: mode === 'live', steps: [], assertions: [], unexecuted: [], cleanup: {}, limitations: ['No unit tests run here. The z392 ledger remains unchanged.', 'No working ~/.raf or owner state is read, copied or migrated.', 'Host interruption or incomplete cleanup cannot produce succeeded.'] };
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(file + '.part', file); };
const hash = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const codeConfigBefore = hash(path.join(codeHome, 'config.toml'));
let sequence = 0, api, work, host, code, control, mainStarted = false, interrupted, cleaning = false;
const children = new Set(), leases = new Set(), workspaces = [];
const checkpoints = ['before-intent', 'after-intent', 'before-switch', 'after-switch', 'after-refs', 'after-index', 'after-smoke', 'before-cleanup', 'after-cleanup'];
const required = ['setup', ...(scope === 'all' ? ['negative-gates', 'snapshot-gates', 'writer-barrier'] : []), 'two-cycles', 'reader-kinds', 'publishers', 'crash-recovery', 'foreign-work-cleanup', 'live-reports-and-boundaries'];
const record = (name, data = {}) => { summary.assertions.push({ name, status: 'passed', ...data }); atomic(path.join(ev, 'progress.json'), summary); };
const command = (label, exe, args, cwd = root) => {
  assert.ok(!interrupted || cleaning, 'Interrupted: ' + interrupted);
  const out = fs.openSync(path.join(ev, label + '.stdout'), 'wx', 0o600), err = fs.openSync(path.join(ev, label + '.stderr'), 'wx', 0o600);
  let result;
  try { result = spawnSync(exe, args, { cwd, env, stdio: ['ignore', out, err] }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const r = { command: [exe, ...args], cwd, cliExitCode: result.status, signal: result.signal, error: result.error?.message ?? null };
  atomic(path.join(ev, label + '.json'), r); summary.steps.push({ label, ...r });
  return { ...r, stdout: fs.readFileSync(path.join(ev, label + '.stdout'), 'utf8'), stderr: fs.readFileSync(path.join(ev, label + '.stderr'), 'utf8') };
};
const must = result => { assert.equal(result.error, null); assert.equal(result.signal, null); assert.equal(result.cliExitCode, 0, result.stderr); return result.stdout.trim(); };
const git = (cwd, ...args) => must(command('git-' + (++sequence), 'git', ['-C', cwd, ...args], cwd));
const wait = async (label, read, budget) => {
  const end = budget === undefined ? Infinity : Date.now() + budget;
  while (Date.now() < end) { assert.ok(!interrupted || cleaning, 'Interrupted: ' + interrupted); const result = read(); if (result) return result; await delay(100); }
  throw Error('Incomplete host scenario: ' + label);
};
let readiness;
const request = async (label, args) => {
  const resultPath = path.join(stand, 'pane', label + '.json');
  assert.ok(!fs.existsSync(resultPath));
  atomic(path.join(stand, 'commands', String(++sequence).padStart(6, '0') + '.json'), { label, args });
  await wait('CLI ' + label, () => fs.existsSync(resultPath), args[0] === 'agent' && args[1] === 'run' ? undefined : readiness);
  const r = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  summary.steps.push({ label, ...r });
  return { ...r, stdout: fs.readFileSync(path.join(stand, 'pane', label + '.stdout'), 'utf8'), stderr: fs.readFileSync(path.join(stand, 'pane', label + '.stderr'), 'utf8') };
};
const socket = path.join(home, 'z334-main.sock');
assert.ok(Buffer.byteLength(socket) <= 107, 'Own tmux control socket must fit platform pathname limit');
const state = () => {
  const file = path.join(home, '.raf/state.sqlite');
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload)); }
  finally { db.close(); }
};
const session = actor => state().find(row => row.addressId === 'z334-' + actor && row.state !== 'finished');
const saveRun = row => {
  const own = path.join(home, '.raf/tmp', row.runId), to = path.join(ev, 'runs', row.runId);
  fs.mkdirSync(to, { recursive: true });
  for (const name of ['probe.json', 'commit.json', 'ready.json', row.addressId + '.json', 'runtime.json', 'trust.json']) if (fs.existsSync(path.join(own, name))) fs.copyFileSync(path.join(own, name), path.join(to, name));
  atomic(path.join(to, 'session.json'), row);
};
const receive = (child, predicate) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(Error('Child scenario deadline')), readiness);
  const message = value => { if (predicate(value)) finish(null, value); else if (value.error) finish(Error(value.error)); };
  const exit = (status, signal) => finish(Error('Child exited before result: ' + status + '/' + signal));
  function finish(error, value) { clearTimeout(timer); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(value); }
  child.on('message', message); child.once('exit', exit);
});
const fork = payload => {
  const id = 'child-' + (++sequence), file = path.join(stand, id + '.json'); atomic(file, { ...payload, code, host });
  const out = fs.openSync(path.join(ev, id + '.stdout'), 'wx'), err = fs.openSync(path.join(ev, id + '.stderr'), 'wx');
  const child = spawn(process.execPath, [path.join(code, 'test/helpers/z334-process.mjs'), file], { cwd: stand, env, stdio: ['ignore', out, err, 'ipc'] });
  fs.closeSync(out); fs.closeSync(err); children.add(child);
  child.on('message', data => fs.appendFileSync(path.join(ev, id + '.events.jsonl'), JSON.stringify(data) + '\n'));
  return child;
};
const identity = cwd => {
  const directory = git(cwd, 'rev-parse', '--absolute-git-dir');
  return { head: git(cwd, 'rev-parse', 'HEAD'), tree: git(cwd, 'rev-parse', 'HEAD^{tree}'), index: hash(path.join(directory, 'index')), status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'), inode: fs.statSync(cwd).ino, markers: ['a.mjs', 'b.mjs'].map(name => hash(path.join(cwd, 'qa-z334', name))) };
};
const liveIdentity = () => ({ ...identity(main), gitlink: git(root, 'ls-files', '--stage', '--', 'raf-main'), config: hash(path.join(control, '../config')) });
const assertMain = (commit, marker) => {
  assert.equal(git(main, 'rev-parse', 'HEAD'), commit); assert.equal(git(main, 'rev-parse', 'refs/heads/main'), commit);
  assert.equal(git(main, 'diff', '--cached', commit, '--name-only'), ''); assert.equal(git(main, 'status', '--porcelain=v1'), '');
  assert.match(git(root, 'ls-files', '--stage', '--', 'raf-main'), new RegExp('^160000 ' + commit + ' 0\\t'));
  for (const name of ['a.mjs', 'b.mjs']) assert.equal(fs.readFileSync(path.join(main, 'qa-z334', name), 'utf8'), `export const marker = ${JSON.stringify(marker)};\n`);
};
const candidate = async marker => {
  const workspace = await work.prepareHotfixWorktree(host, randomUUID()); workspaces.push(workspace);
  for (const name of ['a.mjs', 'b.mjs']) fs.writeFileSync(path.join(hotfix, 'qa-z334', name), `export const marker = ${JSON.stringify(marker)};\n`);
  await work.commitHotfix(host, { workspace, paths: ['qa-z334/a.mjs', 'qa-z334/b.mjs'], message: 'qa: ' + marker });
  return workspace;
};
const verify = async (workspace, extra = {}) => {
  const message = 'z334-gate-' + randomUUID();
  const verified = await api.verifyHotfixCandidate(host, { workspace, regression: { executable: process.execPath, args: ['qa-z334/smoke.mjs'] }, mainAddress: 'main', message, ...extra });
  assert.equal(verified.commit, git(hotfix, 'rev-parse', 'HEAD'));
  assert.match(verified.fingerprint, /^[0-9a-f]{64}$/);
  const names = ['build', 'regression', 'runtime-import', 'help', 'agent-ps', 'agent-message', 'service-start', 'service-ready', 'service-status', 'service-stop'];
  assert.deepEqual(verified.gates.map(row => row.name).sort(), names.sort());
  for (const gate of verified.gates) { assert.equal(gate.status, 'passed'); assert.equal(gate.code, 0); assert.equal(gate.commit, verified.commit); assert.equal(gate.fingerprint, verified.fingerprint); }
  for (const file of verified.files) { assert.equal(hash(path.join(verified.snapshot.root, file.path)), file.sha256); assert.notEqual(fs.statSync(path.join(verified.snapshot.root, file.path)).ino, fs.statSync(path.join(hotfix, file.path)).ino); }
  await wait('one delivery', () => fs.existsSync(path.join(stand, 'pane/inbox.bin')) && fs.readFileSync(path.join(stand, 'pane/inbox.bin'), 'utf8').includes(message), readiness);
  assert.equal(fs.readFileSync(path.join(stand, 'pane/inbox.bin'), 'utf8').split(message).length - 1, 1);
  return verified;
};
const refused = async (label, action, pattern) => {
  const before = liveIdentity(); let message;
  try { await action(); } catch (error) { message = error.message; }
  assert.ok(message, label + ' must refuse'); assert.match(message, pattern);
  assert.deepEqual(liveIdentity(), before, label + ': live bytes/ref/index/gitlink unchanged');
  atomic(path.join(ev, 'refusal-' + label + '.json'), { label, message, before, after: liveIdentity() });
};
const completeReport = async actor => {
  const row = session(actor); assert.ok(row); const own = path.join(home, '.raf/tmp', row.runId);
  fs.writeFileSync(path.join(own, 'report-go'), 'go');
  must(await request('start-report-service-' + actor, ['service', 'start']));
  const accepted = await wait('accepted real report ' + actor, () => { const current = session(actor); return current?.result && current.reportAcceptance ? current : undefined; }, readiness);
  saveRun(accepted); assert.equal(accepted.result.status, 'succeeded'); assert.equal(accepted.reportAcceptance.status, 'succeeded');
  must(await request('close-' + actor, ['agent', 'close', '--id', row.addressId]));
  return accepted;
};
const launch = async actor => {
  must(await request('launch-' + actor, ['agent', 'run', '--id', 'z334-' + actor, '--type', 'hotfix', '--project', 'raf', '--features', 'z334-live', '--phase', 'hotfix', '--complexity', 'mechanical', '--tasks', 'z334-live:' + (actor === 'one' ? '1' : actor === 'two' ? '2' : '3')]));
  const row = await wait('real session ' + actor, () => session(actor), readiness);
  await wait('real tool probes/commit ' + actor, () => fs.existsSync(path.join(home, '.raf/tmp', row.runId, 'ready.json')), readiness);
  saveRun(row);
  const ready = JSON.parse(fs.readFileSync(path.join(home, '.raf/tmp', row.runId, 'ready.json'), 'utf8'));
  assert.equal(ready.probe.cwd, hotfix); if (actor !== 'neighbor') assert.equal(ready.sha, git(hotfix, 'rev-parse', 'HEAD'));
  return row;
};
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { interrupted = signal; });
try {
  summary.driverSha256 = hash(driver);
  summary.sourceWorkspace = { head: git(source, 'rev-parse', 'HEAD'), status: git(source, 'status', '--porcelain=v1', '--untracked-files=all') };
  for (const file of ['test/z334-host-qa.mjs', ...['main-pane', 'process', 'worker', 'smoke'].map(name => 'test/helpers/z334-' + name + '.mjs')]) {
    const expected = must(command('reviewed-' + (++sequence), 'git', ['show', sourceSha + ':' + file], source));
    assert.equal(fs.readFileSync(path.join(source, file), 'utf8').trim(), expected, 'Run exactly the reviewed driver/helpers');
  }
  for (const [exe, args] of [['node', ['--version']], ['git', ['--version']], ['tmux', ['-V']], ['python3', ['--version']], ['uname', ['-a']]]) must(command('version-' + exe, exe, args));
  must(command('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, main]));
  const importedBranch = git(main, 'symbolic-ref', '--short', 'HEAD');
  git(main, 'branch', '-m', importedBranch, 'z334-imported');
  git(main, 'checkout', '--detach', sourceSha); git(main, 'switch', '-c', 'main');
  fs.cpSync(path.join(path.dirname(source), 'conf'), path.join(root, 'conf'), { recursive: true });
  const projectsFile = path.join(root, 'conf/projects.json'), projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  projects.projects = { raf: projects.projects.raf, orchestrator: projects.projects.orchestrator };
  projects.projects.raf.path = 'raf-main'; projects.projects.raf.branchPaths = { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' };
  fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2) + '\n');
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'conf/raf.json'), 'utf8'));
  readiness = settings.runnerProtocols.find(row => row.runner === 'codex').timeouts.transitionMs;
  summary.configuration = Object.fromEntries(['raf.json', 'models.json', 'flow.json', 'test-runs.json'].map(name => [name, hash(path.join(root, 'conf', name))]));
  assert.ok(fs.existsSync(path.join(source, 'node_modules/typescript')), 'Prepared local dependencies required; no installation');
  fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
  must(command('baseline-build', 'npm', ['run', 'build'], main));
  fs.mkdirSync(path.join(main, 'qa-z334'));
  for (const name of ['a.mjs', 'b.mjs']) fs.writeFileSync(path.join(main, 'qa-z334', name), 'export const marker = "old";\n');
  for (const name of ['worker', 'smoke']) fs.copyFileSync(path.join(main, 'test/helpers/z334-' + name + '.mjs'), path.join(main, 'qa-z334', name + '.mjs'));
  git(main, 'add', '--', 'qa-z334'); git(main, 'add', '-f', '--', 'dist'); git(main, 'commit', '-m', 'qa: isolated Z334 markers and real CLI smoke');
  git(root, 'init', '-b', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main'); git(root, 'submodule', 'absorbgitdirs');
  const base = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', '-b', 'develop', develop, base);
  git(main, 'worktree', 'add', '-b', 'hotfix', hotfix, base);
  git(root, 'clone', '--bare', '--no-hardlinks', main, path.join(stand, 'origin.git'));
  code = path.join(stand, 'controller'); fs.cpSync(main, code, { recursive: true, filter: file => path.basename(file) !== '.git' });
  const change = path.join(root, 'openspec/changes/z334-live'); fs.mkdirSync(change, { recursive: true });
  fs.writeFileSync(path.join(change, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
  fs.writeFileSync(path.join(change, 'proposal.md'), '## Why\nIsolated Z334 host QA.\n\n## What Changes\nTwo marker commits.\n\n## Non-goals\nNo owner changes.\n');
  const description = actor => 'Controlled Z334 fixture. Only execute node qa-z334/worker.mjs ' + actor + ' <exact report_path from brief> using the tool in assigned cwd. The reviewed helper performs boundary probes, commits own marker files via the trusted commit port, waits host gate, and writes the exact report. Do not run tests, change helper/tasks, write report yourself, archive, use git config/push, change model/effort or retry a failed command. If helper fails, report the exact error and wait for host. This fixture explicitly authorizes its own commit.';
  fs.writeFileSync(path.join(change, 'tasks.md'), ['one', 'two', 'neighbor'].map((actor, index) => '- [ ] ' + (index + 1) + ' ' + description(actor)).join('\n') + '\n- [ ] 4 Host owns cleanup; keep change active.\n');
  fs.writeFileSync(path.join(root, 'foreign-parent.txt'), 'parent baseline\n');
  git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf', 'openspec', 'foreign-parent.txt'); git(root, 'commit', '-m', 'qa: isolated Z334 parent');
  fs.writeFileSync(path.join(root, 'foreign-parent.txt'), 'foreign staged parent work\n'); git(root, 'add', '--', 'foreign-parent.txt');
  const foreignParentDiff = git(root, 'diff', '--cached', '--', 'foreign-parent.txt');
  env.RAF_ORCHESTRATOR_ROOT = root; process.env.RAF_ORCHESTRATOR_ROOT = root;
  host = { orchestratorRoot: root, qaHome: home, environment: env, sandboxExecutable: 'codex' };
  api = await import(pathToFileURL(path.join(code, 'src/hotfix-activation.ts'))); work = await import(pathToFileURL(path.join(code, 'src/hotfix-worktree.ts')));
  control = path.join(git(main, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'raf-hotfix');
  must(command('tmux-start', 'tmux', ['-S', socket, 'new-session', '-d', '-s', 'z334-main', '-x', '200', '-y', '60', process.execPath, path.join(code, 'test/helpers/z334-main-pane.mjs'), stand])); mainStarted = true;
  await wait('main attach', () => fs.existsSync(path.join(stand, 'pane/attach.json')), readiness);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stand, 'pane/attach.json'), 'utf8')).cliExitCode, 0);
  const initial = await api.recoverHotfixActivation(host); summary.initial = { base, initial, identity: liveIdentity() };
  record('setup', { base, registry: path.join(control, 'registry.json') });

  const workspace = await candidate('negative');
  if (scope === 'all') {
  for (const fault of ['syntax', 'build', 'message', 'regression', 'service-ready']) {
    const file = fault === 'syntax' ? 'src/production-runtime.ts' : fault === 'build' ? 'scripts/build.ts' : fault === 'service-ready' ? 'bin/service.ts' : null;
    const original = file && fs.readFileSync(path.join(hotfix, file));
    if (file) {
      fs.writeFileSync(path.join(hotfix, file), fault === 'syntax' ? 'export const broken = (;\n' : fault === 'build' ? 'process.stderr.write("Z334_BUILD_REFUSED"); process.exit(23);\n' : 'process.exit(0);\n');
      await work.commitHotfix(host, { workspace, paths: [file], message: 'qa: inject ' + fault });
    }
    if (fault === 'syntax') {
      const r = command('syntax-error', process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', path.join(hotfix, file)], hotfix);
      assert.equal(r.cliExitCode, 1); assert.match(r.stderr, /SyntaxError/);
      must(await request('syntax-live-ps', ['agent', 'ps']));
      must(await request('syntax-live-message', ['agent', 'message', '--to', 'main', '--text', 'z334-syntax-live-' + summary.runId]));
    }
    await refused(fault, () => verify(workspace, fault === 'message' ? { mainAddress: 'unregistered-z334' } : fault === 'regression' ? { regression: { executable: process.execPath, args: ['-e', 'process.stderr.write("Z334_REGRESSION_REFUSED");process.exit(29)'] } } : {}), /gate|build|runtime|import|message|service|regression|ready/i);
    if (file) { fs.writeFileSync(path.join(hotfix, file), original); await work.commitHotfix(host, { workspace, paths: [file], message: 'qa: restore ' + fault }); }
  }
  record('negative-gates');
  }

  const good = await verify(workspace);
  if (scope === 'all') {
  for (const [label, file] of [['source', path.join(hotfix, 'qa-z334/a.mjs')], ['artifact', path.join(hotfix, 'dist/catalog.json')], ['conf', path.join(root, 'conf/raf.json')], ['sealed-source', path.join(good.snapshot.root, 'qa-z334/a.mjs')], ['sealed-artifact', path.join(good.snapshot.root, 'dist/catalog.json')], ['sealed-conf', path.join(good.snapshot.configurationRoot, 'conf/raf.json')]]) {
    const original = fs.readFileSync(file); fs.appendFileSync(file, '\n ');
    try { await refused(label, () => api.activateHotfix(host, good), /dirty|snapshot|fingerprint|config|changed|evidence/i); }
    finally { fs.writeFileSync(file, original); }
  }
  for (const status of ['failed', 'skipped', 'timeout', 'absent']) {
    const forged = { ...good, gates: status === 'absent' ? good.gates.slice(1) : good.gates.map((row, index) => index ? row : { ...row, status, code: null }) };
    await refused('gate-' + status, () => api.activateHotfix(host, forged), /evidence|gate|snapshot|verif/i);
  }
  const log = good.gates[0].logPath, logBytes = fs.readFileSync(log);
  atomic(log, { code: 23, executed: true });
  try { await refused('gate-log', () => api.activateHotfix(host, good), /log|gate|changed/); } finally { fs.writeFileSync(log, logBytes); }
  for (const kind of ['untracked', 'staged', 'unstaged']) {
    const file = path.join(main, kind === 'untracked' ? 'qa-z334/foreign.txt' : 'qa-z334/a.mjs'), original = fs.existsSync(file) ? fs.readFileSync(file) : null;
    fs.appendFileSync(file, 'foreign writer\n'); if (kind === 'staged') git(main, 'add', '--', 'qa-z334/a.mjs');
    const before = fs.readFileSync(file);
    await refused('main-' + kind, () => api.activateHotfix(host, good), /dirty|index|local|clean/i); assert.deepEqual(fs.readFileSync(file), before);
    if (original) fs.writeFileSync(file, original); else fs.unlinkSync(file);
    if (kind === 'staged') git(main, 'add', '--', 'qa-z334/a.mjs');
  }
  for (const support of [{ supported: false, sameDevice: true }, { supported: true, sameDevice: false }]) await refused('provider-' + (++sequence), () => api.activateHotfix(host, good, { switchProvider: { probe: async () => support, exchange: async () => { throw Error('Forbidden fallback'); } } }), /unsupported|EXDEV/);
  git(hotfix, 'commit', '--allow-empty', '-m', 'qa: foreign same-tree HEAD');
  await refused('new-head', () => api.activateHotfix(host, good), /snapshot|fingerprint|changed|evidence/);
  record('snapshot-gates');

  const hostApi = await import(pathToFileURL(path.join(code, 'src/hotfix-host.ts')));
  let releaseWriter, entered; const ready = new Promise(resolve => { entered = resolve; });
  const held = hostApi.withHotfixWriter(host, async () => { entered(); await new Promise(resolve => { releaseWriter = resolve; }); });
  await ready; let copied = false;
  const sealing = api.sealHotfixSnapshot(host, workspace, { checkpoint: async phase => { if (phase === 'before-copy') copied = true; } });
  try { await delay(settings.runnerProtocols.find(row => row.runner === 'codex').timeouts.pollMs); assert.equal(copied, false); }
  finally { releaseWriter(); }
  await held; const sealed = await sealing; assert.equal(copied, true);
  assert.equal(sealed.commit, git(hotfix, 'rev-parse', 'HEAD')); record('writer-barrier', { fingerprint: sealed.fingerprint });
  for (const phase of ['before-copy', 'after-copy']) {
    const file = path.join(hotfix, 'qa-z334/a.mjs'), original = fs.readFileSync(file);
    try { await refused('mixed-seal-' + phase, () => api.sealHotfixSnapshot(host, workspace, { checkpoint: async value => { if (value === phase) fs.appendFileSync(file, 'uncoordinated writer\n'); } }), /changed|dirty|snapshot|source/i); }
    finally { fs.writeFileSync(file, original); }
  }

  }

  const inode = fs.statSync(hotfix).ino, developerFile = path.join(develop, 'developer-untracked.txt'); fs.writeFileSync(developerFile, 'developer work\n');
  let neighbor;
  if (mode === 'live') {
    must(command('version-codex', 'codex', ['--version']));
    must(await request('runner-list', ['runner', 'list']));
    must(await request('runner-limits', ['runner', 'limits', '--runners', 'codex']));
    neighbor = await launch('neighbor');
  }
  const cycles = [];
  for (const marker of ['one', 'two']) {
    let ws;
    if (mode === 'live') { await launch(marker); ws = JSON.parse(fs.readFileSync(path.join(home, '.raf/tmp', session(marker).runId, 'runtime.json'), 'utf8')).workspaceRoute.hotfix; workspaces.push(ws); await completeReport(marker); }
    else ws = await candidate(marker);
    const verified = await verify(ws); const before = identity(hotfix); const readers = [];
    for (const kind of ['cli', 'service', 'worker', 'hook', 'notice']) {
      const child = fork({ mode: 'reader', kind }); const first = await receive(child, row => row.ready); readers.push({ child, first, kind });
      assert.equal(first.commit, ws.baseCommit);
    }
    const observer = fork({ mode: 'observer', main, pollMs: settings.runnerProtocols.find(row => row.runner === 'codex').timeouts.pollMs });
    await receive(observer, row => row.ready);
    const exchangeLog = path.join(ev, 'exchanges-' + marker + '.jsonl');
    const publishers = [0, 1].map(() => fork({ mode: 'race', candidate: verified, exchangeLog }));
    await Promise.all(publishers.map(child => receive(child, row => row.ready)));
    const outcomes = publishers.map(child => receive(child, row => row.result || row.error)); publishers.forEach(child => child.send('go'));
    const results = await Promise.all(outcomes);
    assert.equal(results.filter(row => row.result?.status === 'activated').length, 1);
    for (const result of results) if (result.error) assert.match(result.error, /stale|base|conflict|changed|busy|lock/i);
    assert.equal(fs.readFileSync(exchangeLog, 'utf8').trim().split('\n').length, 1);
    assertMain(verified.commit, marker); assert.deepEqual(identity(hotfix), before);
    const observations = receive(observer, row => row.observations); observer.send('stop'); const observed = await observations;
    assert.equal(observed.observations.length, 2, 'Observe complete old and new multi-file generations');
    atomic(path.join(ev, 'atomic-observer-' + marker + '.json'), observed);
    assert.equal(git(root, 'diff', '--cached', '--', 'foreign-parent.txt'), foreignParentDiff);
    if (marker === 'one') await refused('stale-base', () => api.activateHotfix(host, good), /stale|base|changed|snapshot|fingerprint/i);
    await api.cleanupHotfixActivation(host);
    for (const { child, first, kind } of readers) {
      assert.ok(fs.existsSync(first.root)); const result = receive(child, row => row.pair); child.send('go'); const pair = await result; assert.equal(pair.pair[0], pair.pair[1]);
      cycles.push({ marker, kind, oldCommit: first.commit, pair: pair.pair, newCommit: verified.commit, fingerprint: verified.fingerprint });
    }
    git(develop, 'merge', '--ff-only', verified.commit); assert.equal(git(develop, 'rev-parse', 'HEAD'), verified.commit);
    assert.equal(fs.readFileSync(developerFile, 'utf8'), 'developer work\n'); assert.equal(fs.statSync(hotfix).ino, inode);
    if (neighbor) { assert.equal(session('neighbor').runId, neighbor.runId); assert.equal(session('neighbor').state, 'running'); }
    assert.equal((await api.activateHotfix(host, verified)).status, 'already-active');
  }
  record('two-cycles', { cycles }); record('reader-kinds'); record('publishers');
  if (neighbor) { await completeReport('neighbor'); record('live-reports-and-boundaries', { accepted: ['one', 'two', 'neighbor'] }); }

  for (const phase of checkpoints) {
    const marker = 'crash-' + phase, ws = await candidate(marker), verified = await verify(ws), hotfixBefore = identity(hotfix);
    const exchangeLog = path.join(ev, 'exchanges-' + phase + '.jsonl'), publisher = fork({ mode: 'crash', phase, candidate: verified, exchangeLog });
    await receive(publisher, row => row.phase === phase);
    if (['after-switch', 'after-refs', 'after-index'].includes(phase)) {
      const entering = fork({ mode: 'enter' }); const observation = await receive(entering, row => row.pair || row.refused);
      if (observation.refused) assert.match(observation.refused, /activation|lock|busy|wait|transition|deadline/i);
    }
    const exited = once(publisher, 'exit'); publisher.kill('SIGKILL'); const killed = await exited; assert.equal(killed[1], 'SIGKILL');
    const restarted = fork({ mode: 'recover' }); const recovery = await receive(restarted, row => row.result); assert.equal(recovery.result.pending, false);
    const converged = git(main, 'rev-parse', 'HEAD'); assert.ok([ws.baseCommit, verified.commit].includes(converged));
    assert.equal(git(main, 'diff', '--cached', converged, '--name-only'), ''); assert.match(git(root, 'ls-files', '--stage', '--', 'raf-main'), new RegExp(converged));
    assert.equal((await api.recoverHotfixActivation(host)).pending, false);
    assert.ok(['activated', 'already-active'].includes((await api.activateHotfix(host, verified)).status));
    assertMain(verified.commit, marker); assert.deepEqual(identity(hotfix), hotfixBefore);
    record('crash-' + phase, { killed, recovery: recovery.result, base: ws.baseCommit, target: verified.commit, fingerprint: verified.fingerprint });
  }
  record('crash-recovery');
  const later = await candidate('future-writer');
  fs.writeFileSync(path.join(hotfix, 'qa-z334/a.mjs'), 'foreign staged\n'); git(hotfix, 'add', '--', 'qa-z334/a.mjs');
  fs.writeFileSync(path.join(hotfix, 'qa-z334/b.mjs'), 'foreign unstaged\n'); fs.writeFileSync(path.join(hotfix, 'qa-z334/foreign.txt'), 'foreign untracked\n');
  const foreign = identity(hotfix);
  for (let i = 0; i < 2; i++) { await api.cleanupHotfixActivation(host); assert.deepEqual(identity(hotfix), foreign); }
  for (const ws of workspaces) await work.cleanupHotfixWorktree(host, ws);
  assert.deepEqual(identity(hotfix), foreign); assert.equal(fs.statSync(hotfix).ino, inode);
  record('foreign-work-cleanup', { later: later.runId, foreign });
  summary.final = { main: liveIdentity(), hotfix: identity(hotfix), develop: identity(develop), registry: JSON.parse(fs.readFileSync(path.join(control, 'registry.json'), 'utf8')) };
  summary.status = mode === 'live' ? 'succeeded' : 'failed';
} catch (error) { summary.error = { message: error.message, stack: error.stack }; }
finally {
  cleaning = true;
  const cleanupErrors = [];
  for (const lease of leases) {
    try { await lease.release(); } catch (error) { cleanupErrors.push('lease: ' + error.message); }
  }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    try { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    catch (error) { cleanupErrors.push('child: ' + error.message); }
  }
  if (mainStarted) {
    let active = [];
    try { active = state().filter(row => row.addressId !== 'main' && row.state !== 'finished'); }
    catch (error) { cleanupErrors.push('sessions: ' + error.message); }
    for (const row of active) {
      try {
        saveRun(row);
        const result = await request('cleanup-close-' + row.addressId, ['agent', 'close', '--id', row.addressId, '--force', '--reason', 'Z334 owns this isolated fixture; evidence preserved']);
        if (result.cliExitCode !== 0) cleanupErrors.push('close ' + row.addressId);
      } catch (error) { cleanupErrors.push('close ' + row.addressId + ': ' + error.message); }
    }
    try {
      const stop = await request('cleanup-service-stop', ['service', 'stop']); if (stop.cliExitCode !== 0) cleanupErrors.push('service-stop');
    } catch (error) { cleanupErrors.push('service-stop: ' + error.message); }
    for (const [label, endpoint] of [['agents', path.join(home, '.raf/tmp/tmux/server.sock')], ['main', socket]]) {
      try {
        const result = command('cleanup-tmux-' + label, 'tmux', ['-S', endpoint, 'kill-server']);
        if (result.cliExitCode !== 0 && !/no server|No such file/i.test(result.stderr)) cleanupErrors.push('tmux ' + label);
      } catch (error) { cleanupErrors.push('tmux ' + label + ': ' + error.message); }
    }
  }
  if (fs.existsSync(path.join(stand, 'pane'))) fs.cpSync(path.join(stand, 'pane'), path.join(ev, 'pane'), { recursive: true });
  if (control && fs.existsSync(control)) {
    const verifications = path.join(control, 'verification');
    if (fs.existsSync(verifications)) for (const run of fs.readdirSync(verifications)) for (const id of fs.readdirSync(path.join(verifications, run))) {
      const from = path.join(verifications, run, id), to = path.join(ev, 'verification', run, id); fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from).filter(name => name.endsWith('.json'))) fs.copyFileSync(path.join(from, name), path.join(to, name));
    }
    for (const name of ['registry.json', 'intent.json']) if (fs.existsSync(path.join(control, name))) fs.copyFileSync(path.join(control, name), path.join(ev, name));
  }
  const remaining = [];
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name) && Number(name) !== process.pid)) {
    try {
      const cwd = fs.readlinkSync('/proc/' + pid + '/cwd'), args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
      if (cwd === stand || cwd.startsWith(stand + path.sep) || args.some(arg => arg.startsWith(stand + path.sep) || arg === socket || arg === path.join(home, '.raf/tmp/tmux/server.sock'))) remaining.push({ pid: Number(pid), cwd, start: fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ')[19] });
    } catch {}
  }
  summary.cleanup = { complete: cleanupErrors.length === 0 && remaining.length === 0, errors: cleanupErrors, remaining, standRemoved: false };
  if (summary.cleanup.complete) { fs.rmSync(stand, { recursive: true }); summary.cleanup.standRemoved = !fs.existsSync(stand); }
  summary.codexConfig = { before: codeConfigBefore, after: hash(path.join(codeHome, 'config.toml')), restored: false };
  if (summary.codexConfig.before !== summary.codexConfig.after) summary.limitations.push('Codex changed its selected config; not restored or hidden.');
  const passed = new Set(summary.assertions.map(row => row.name)); summary.unexecuted = required.filter(name => !passed.has(name));
  if (summary.unexecuted.length || !summary.cleanup.complete || interrupted) summary.status = 'failed';
  summary.interrupted = interrupted ?? null; summary.finishedAt = new Date().toISOString();
  atomic(path.join(ev, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, runId: summary.runId, sourceSha, mode, evidence: path.join(ev, 'summary.json'), assertions: summary.assertions.map(row => row.name), unexecuted: summary.unexecuted, cleanup: summary.cleanup, error: summary.error?.message ?? null }));
  process.exitCode = summary.status === 'succeeded' ? 0 : 1;
}
