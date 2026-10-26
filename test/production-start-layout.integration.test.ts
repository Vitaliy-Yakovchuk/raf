import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { prepareMainLayoutForProductionStart } from '../src/production-start-layout.ts';
import { agentChannelReadOnlyPaths } from '../src/main-switch-agent-launcher.ts';
import { productionStorePaths, resolveProductionStore } from '../src/main-production-store.ts';
import { processStart } from '../src/hotfix-host.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';

const bootstrapUrl = new URL('../src/production-start-layout.ts', import.meta.url).href;
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Start regression', GIT_AUTHOR_EMAIL: 'start@example.invalid',
  GIT_COMMITTER_NAME: 'Start regression', GIT_COMMITTER_EMAIL: 'start@example.invalid',
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
function write(path: string, bytes: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
}
function digest(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function tree(path: string): unknown {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return { kind: 'symlink', target: realpathSync(path) };
  if (info.isDirectory()) return Object.fromEntries(readdirSync(path).sort().map(name => [name, tree(join(path, name))]));
  return { hash: digest(path), mode: info.mode & 0o777 };
}
function gitPath(cwd: string, name: string) { return resolve(cwd, git(cwd, 'rev-parse', '--git-path', name)); }
function workingState(cwd: string) {
  const index = gitPath(cwd, 'index');
  return { head: git(cwd, 'rev-parse', 'HEAD'), branch: git(cwd, 'symbolic-ref', 'HEAD'),
    index: digest(index), indexMode: lstatSync(index).mode & 0o777,
    sharedIndexes: Object.fromEntries(readdirSync(dirname(index)).filter(name => name.startsWith('sharedindex.')).sort().map(name => [name, tree(join(dirname(index), name))])),
    staged: git(cwd, 'diff', '--cached', '--binary'), unstaged: git(cwd, 'diff', '--binary'),
    status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
    files: Object.fromEntries(readdirSync(cwd).filter(name => name !== '.git').sort().map(name => [name, tree(join(cwd, name))])) };
}
function sourceState(root: string) {
  return Object.fromEntries(['raf-develop', 'raf-hotfix'].map(name => {
    const cwd = join(root, name);
    const directory = git(cwd, 'rev-parse', '--absolute-git-dir');
    return [name, { cwd: realpathSync(cwd), directory,
      common: git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      pointer: readFileSync(join(cwd, '.git'), 'utf8'), registration: tree(directory), working: workingState(cwd) }];
  }));
}
function fixture(t: TestContext, copies = false, splitIndex = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'raf-start-layout-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const seed = join(base, 'seed'); const root = join(base, 'orchestrator');
  mkdirSync(seed); git(seed, 'init', '-q', '-b', 'main');
  for (const file of ['staged.txt', 'unstaged.txt', 'run.sh']) write(join(seed, file), `committed ${file}\n`);
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'Start fixture');
  mkdirSync(root); git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'raf', seed, 'raf-main');
  const main = join(root, 'raf-main');
  git(main, 'worktree', 'add', '-b', 'develop', join(root, 'raf-develop'));
  git(main, 'worktree', 'add', '-b', 'hotfix', join(root, 'raf-hotfix'));
  const projects = { raf: { path: 'raf-main', profile: 'raf',
    branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' },
    ...(copies ? { mainCopies: ['raf-main-a', 'raf-main-b'] } : {}) } };
  write(join(root, 'conf/projects.json'), JSON.stringify({ projects }));
  git(root, 'add', '.gitmodules', 'raf-main', 'conf/projects.json'); git(root, 'commit', '-qm', 'Register legacy main');
  write(join(main, 'staged.txt'), 'staged only blob\n');
  write(join(main, 'binary.bin'), new Uint8Array([0, 255, 128, 10]));
  git(main, 'add', 'staged.txt', 'binary.bin');
  const stagedBlob = git(main, 'rev-parse', ':binary.bin');
  write(join(main, 'staged.txt'), 'unstaged bytes above staged\n');
  write(join(main, 'unstaged.txt'), 'unstaged only\n');
  write(join(main, 'private/untracked.txt'), 'private untracked\n'); chmodSync(join(main, 'run.sh'), 0o755);
  if (splitIndex) git(main, 'update-index', '--split-index');
  chmodSync(gitPath(main, 'index'), 0o640);
  for (const branch of ['develop', 'hotfix']) write(join(root, `raf-${branch}/private.txt`), `${branch} dirty\n`);
  const source = git(main, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const control = join(source, 'raf-hotfix');
  write(join(control, 'generations/pinned/raf-main/fixture.txt'), 'same generation\n');
  write(join(control, 'prefixes/pinned.json'), '{"generation":"pinned"}\n');
  write(join(control, 'leases/fixture.json'), '{"runId":"unchanged-run"}\n');
  return { root, main, source, control, stagedBlob, head: git(main, 'rev-parse', 'HEAD') };
}
function pinnedState(control: string) {
  return Object.fromEntries(['generations', 'prefixes', 'leases'].map(name => [name, tree(join(control, name))]));
}
async function ready(f: ReturnType<typeof fixture>, before: ReturnType<typeof workingState>, sources: unknown, pins: unknown) {
  const active = realpathSync(f.main);
  const store = await resolveProductionStore(f.root, active);
  assert.equal(store.split, true);
  assert.equal(store.source, f.source); assert.notEqual(store.production, store.source);
  assert.deepEqual(workingState(active), before, 'main HEAD, index bytes/mode and dirty files survive start');
  assert.deepEqual(sourceState(f.root), sources, 'source worktree paths, registrations, refs and indexes survive start');
  assert.deepEqual(pinnedState(f.control), pins, 'pinned generation, prefixes and live run identity remain intact');
  assert.equal(git(active, 'cat-file', '-t', f.stagedBlob), 'blob');
  assert.deepEqual(Buffer.from(execFileSync('git', ['-C', active, 'cat-file', 'blob', f.stagedBlob], { env: gitEnvironment })), Buffer.from([0, 255, 128, 10]));
  assert.equal(git(active, 'rev-parse', 'HEAD'), f.head, 'start does not publish another code commit');
  const guards = await agentChannelReadOnlyPaths(f.root, join(f.root, 'qa-home'));
  assert.ok(guards.includes(store.control)); assert.ok(guards.includes(f.main));
  assert.equal(existsSync(join(store.production, 'objects/info/alternates')), false);
  assert.equal(existsSync(join(store.control, 'main-store-intent.json')), false);
  return store;
}

for (const copies of [false, true]) {
  test(`production bootstrap: ordinary dirty main, mainCopies=${copies}, split then channel admission and repeat no-op`, async t => {
    const f = fixture(t, copies, true);
    const before = workingState(f.main); const sources = sourceState(f.root); const pins = pinnedState(f.control);
    const storePhases: string[] = [];
    await prepareMainLayoutForProductionStart({ orchestratorRoot: f.root, onStoreCheckpoint: phase => {
      storePhases.push(phase);
      const owner = JSON.parse(readFileSync(join(f.control, 'activation.lock/owner.json'), 'utf8'));
      assert.equal(owner.pid, process.pid, 'split checkpoints execute under the activation writer barrier');
      assert.ok(existsSync(join(f.control, 'main-store-intent.json')), 'the split intent is durable before pointer publication');
    } });
    assert.deepEqual(storePhases, ['store-prepared', 'store-pointer', 'store-registered']);
    const store = await ready(f, before, sources, pins);
    if (copies) {
      assert.equal(lstatSync(f.main).isSymbolicLink(), true);
      assert.equal(git(f.root, 'config', '-f', '.gitmodules', '--get', 'submodule.raf.path'), 'raf-main-a');
      assert.match(git(f.root, 'ls-files', '--stage', '--', 'raf-main'), /^120000 /);
      assert.equal(git(f.root, 'ls-files', '--stage', '--', 'raf-main-a'), `160000 ${f.head} 0\traf-main-a`);
    }
    const unchanged = { main: workingState(f.main), pointer: readFileSync(join(f.main, '.git'), 'utf8'),
      production: tree(store.production), control: pinnedState(f.control), parentIndex: tree(gitPath(f.root, 'index')), modules: tree(join(f.root, '.gitmodules')) };
    await prepareMainLayoutForProductionStart({ orchestratorRoot: f.root });
    assert.deepEqual({ main: workingState(f.main), pointer: readFileSync(join(f.main, '.git'), 'utf8'),
      production: tree(store.production), control: pinnedState(f.control), parentIndex: tree(gitPath(f.root, 'index')), modules: tree(join(f.root, '.gitmodules')) }, unchanged);
  });
}

for (const checkpoint of ['store-prepared', 'store-pointer', 'store-registered']) {
  test(`production bootstrap: SIGKILL at ${checkpoint} recovers own intent and preserves a concurrent source commit`, async t => {
    const f = fixture(t, false, true);
    const before = workingState(f.main); const pins = pinnedState(f.control);
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { prepareMainLayoutForProductionStart } from ${JSON.stringify(bootstrapUrl)};
       await prepareMainLayoutForProductionStart({orchestratorRoot:process.argv[1],onStoreCheckpoint:phase=>{
         if(phase===process.argv[2]) process.kill(process.pid,'SIGKILL');
       }});`, f.root, checkpoint], { env: gitEnvironment, encoding: 'utf8', timeout: 30000 });
    assert.equal(killed.error, undefined);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.ok(existsSync(join(f.control, 'main-store-intent.json')), 'crash must leave its durable store intent');
    const develop = join(f.root, 'raf-develop');
    write(join(develop, 'parallel.txt'), 'host-visible parallel commit\n');
    git(develop, 'add', 'parallel.txt'); git(develop, 'commit', '-qm', 'Concurrent source work');
    const parallel = git(develop, 'rev-parse', 'HEAD');
    const foreignLock = gitPath(develop, 'index.lock'); write(foreignLock, 'foreign source writer lock\n');
    const sources = sourceState(f.root);
    await prepareMainLayoutForProductionStart({ orchestratorRoot: f.root });
    await ready(f, before, sources, pins);
    assert.equal(git(develop, 'rev-parse', 'HEAD'), parallel);
    assert.equal(readFileSync(foreignLock, 'utf8'), 'foreign source writer lock\n');
    assert.equal(git(develop, 'cat-file', '-t', parallel), 'commit');
  });
}

for (const checkpoint of ['intent-durable', 'git-relocated', 'link-published']) {
  test(`production bootstrap: SIGKILL at layout ${checkpoint} recovers Git registration without losing dirty bytes`, async t => {
    const f = fixture(t, true);
    const before = workingState(f.main); const sources = sourceState(f.root); const pins = pinnedState(f.control);
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { prepareMainLayoutForProductionStart } from ${JSON.stringify(bootstrapUrl)};
       await prepareMainLayoutForProductionStart({orchestratorRoot:process.argv[1],onLayoutCheckpoint:phase=>{
         if(phase===process.argv[2]) process.kill(process.pid,'SIGKILL');
       }});`, f.root, checkpoint], { env: gitEnvironment, encoding: 'utf8', timeout: 30000 });
    assert.equal(killed.error, undefined);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const intent = join(git(f.root, 'rev-parse', '--absolute-git-dir'), 'raf-main-layout/intent.json');
    assert.ok(existsSync(intent));
    await prepareMainLayoutForProductionStart({ orchestratorRoot: f.root });
    await ready(f, before, sources, pins);
    assert.equal(existsSync(intent), false);
    assert.equal(lstatSync(f.main).isSymbolicLink(), true);
    assert.equal(git(f.root, 'config', '-f', '.gitmodules', '--get', 'submodule.raf.path'), 'raf-main-a');
    assert.equal(git(f.root, 'ls-files', '--stage', '--', 'raf-main-a'), `160000 ${f.head} 0\traf-main-a`);
  });
}

test('production bootstrap: a live activation writer blocks split without overwriting its lock or dirty state', async t => {
  const f = fixture(t);
  const paths = await productionStorePaths(f.root);
  const lock = join(paths.control, 'activation.lock');
  write(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, start: await processStart(process.pid) }));
  const before = { main: workingState(f.main), sources: sourceState(f.root), lock: tree(lock), pins: pinnedState(f.control) };
  await assert.rejects(prepareMainLayoutForProductionStart({ orchestratorRoot: f.root }), /writer barrier busy/);
  assert.deepEqual({ main: workingState(f.main), sources: sourceState(f.root), lock: tree(lock), pins: pinnedState(f.control) }, before);
  assert.equal(existsSync(paths.production), false);
});

test('production bootstrap: the starting process own reader lease does not block its split', async t => {
  const f = fixture(t);
  const before = workingState(f.main); const sources = sourceState(f.root); const pins = pinnedState(f.control);
  const lease = join(f.control, 'readers/own-cli.json');
  write(lease, JSON.stringify({ root: join(f.control, 'generations/pinned/raf-main'), pid: process.pid, start: await processStart(process.pid) }));
  await prepareMainLayoutForProductionStart({ orchestratorRoot: f.root });
  await ready(f, before, sources, pins);
  assert.ok(existsSync(lease), 'own reader lease stays owned by its process');
});

test('production bootstrap: a foreign live reader without protection still blocks split', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  const paths = await productionStorePaths(f.root);
  write(join(f.control, 'readers/foreign.json'), JSON.stringify({ root: join(f.control, 'generations/pinned/raf-main'), pid: child.pid, start: await processStart(child.pid!) }));
  const before = { main: workingState(f.main), sources: sourceState(f.root), pins: pinnedState(f.control) };
  await assert.rejects(prepareMainLayoutForProductionStart({ orchestratorRoot: f.root }), /live reader has unknown protection/);
  assert.deepEqual({ main: workingState(f.main), sources: sourceState(f.root), pins: pinnedState(f.control) }, before);
  assert.equal(existsSync(paths.production), false);
  assert.equal(existsSync(join(paths.control, 'main-store-intent.json')), false);
});

test('production bootstrap: converted copies keep the registered submodule name and the active copy is a valid CLI origin', async t => {
  const f = fixture(t, true);
  await prepareMainLayoutForProductionStart({ orchestratorRoot: f.root });
  assert.equal(git(f.root, 'config', '-f', '.gitmodules', '--get', 'submodule.raf.path'), 'raf-main-a');
  const projects = JSON.parse(readFileSync(join(f.root, 'conf/projects.json'), 'utf8'));
  write(join(f.root, 'conf/projects.json'), JSON.stringify({ version: 1, profiles: { raf: { production: 'main', environments: { runtime: 'main' } } }, ...projects }));
  write(join(f.root, 'conf/raf.json'), JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
  const entry = join(f.root, 'raf-main-a/bin/raf.ts');
  write(entry, 'export {};\n');
  const home = join(f.root, 'home');
  mkdirSync(home);
  const context = resolveStateContext({ orchestratorRoot: f.root, modulePath: entry, homeDirectory: home, operatingSystemHome: home, environment: {}, entryPoint: 'cli' });
  assert.equal(context.codeRoot, join(f.root, 'raf-main-a'));
});
