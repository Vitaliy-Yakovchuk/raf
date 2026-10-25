import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { prepareHotfixWorktree, validateHotfixTrust, commitHotfix, cleanupHotfixWorktree } from '../../src/hotfix-worktree.ts';
import { sealHotfixSnapshot, createAtomicHotfixSwitch } from '../../src/hotfix-activation.ts';
import { resolveStateContext } from '../../src/state-migration-guard.ts';

// Live API exercise, not a replacement unit runner or native-agent acceptance.
// All Git repositories, homes, database, mutations and cleanup belong to this stand.
const output = import.meta.dirname;
const sourceRoot = resolve(output, '../..');
const root = await fs.mkdtemp('/tmp/cfc941-hotfix-');
const home = join(root, 'qa-home');
const accountHome = join(root, 'stand-account');
const main = join(root, 'raf-main');
const develop = join(root, 'raf-develop');
const hotfix = join(root, 'raf-hotfix');
const record = { runId: randomUUID(), root, sourceRoot, commands: [], scenarios: [], cleanup: { complete: false }, startedAt: new Date().toISOString() };
const digest = data => createHash('sha256').update(data).digest('hex');
const environment = { HOME: home, RAF_QA_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'CFC941 isolated QA', GIT_AUTHOR_EMAIL: 'cfc941@example.invalid', GIT_COMMITTER_NAME: 'CFC941 isolated QA', GIT_COMMITTER_EMAIL: 'cfc941@example.invalid' };
const env = { ...process.env, ...environment, GIT_OPTIONAL_LOCKS: '0' };
for (const key of Object.keys(env)) if (['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)) delete env[key];
function command(cwd, executable, args, expected = 0) {
  const r = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  record.commands.push({ cwd, executable, args, cliExitCode: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  assert.equal(r.status, expected, JSON.stringify(record.commands.at(-1))); return r.stdout.trim();
}
const git = (cwd, ...args) => command(cwd, 'git', ['--no-optional-locks', ...args]);
const put = async (path, text) => { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, text); };
const exists = path => fs.lstat(path).then(() => true, e => { if(e.code === 'ENOENT') return false; throw e; });
async function tree(path) {
  const rows = [];
  async function walk(dir, prefix = '') {
    for (const name of (await fs.readdir(dir)).sort()) {
      if (!prefix && name === '.git') continue;
      const file = join(dir, name), stat = await fs.lstat(file), relative = prefix + name;
      if (stat.isDirectory()) await walk(file, relative + '/');
      else rows.push({ path: relative, mode: stat.mode & 0o777, sha256: digest(stat.isSymbolicLink() ? await fs.readlink(file) : await fs.readFile(file)) });
    }
  }
  await walk(path); return rows;
}
async function snapshot(cwd) {
  const gd = git(cwd, 'rev-parse', '--absolute-git-dir');
  return { head: git(cwd, 'rev-parse', 'HEAD'), branch: git(cwd, 'symbolic-ref', '--short', 'HEAD'), index: digest(await fs.readFile(join(gd, 'index'))), dirty: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'), files: await tree(cwd) };
}
async function scenario(id, run) {
  const row = { id, startedAt: new Date().toISOString(), outcome: 'running' }; record.scenarios.push(row);
  try { row.evidence = await run(); row.outcome = 'passed'; }
  catch (error) { row.outcome = 'failed'; row.error = { message: error.message, stack: error.stack }; throw error; }
  finally { row.finishedAt = new Date().toISOString(); }
}
async function rejection(run, match) {
  try { await run(); assert.fail('Expected refusal'); }
  catch (e) { assert.match(e.message, match); return { code: e.code ?? null, message: e.message }; }
}
try {
  record.sourceSha = git(sourceRoot, 'rev-parse', 'HEAD');
  record.workspace = git(sourceRoot, 'status', '--porcelain=v1');
  record.sourceHashes = Object.fromEntries(await Promise.all(['src/hotfix-worktree.ts','src/hotfix-host.ts','src/hotfix-activation.ts','src/main-production-store.ts','src/state-migration-guard.ts','src/hotfix-origin.ts'].map(async p => [p, digest(await fs.readFile(join(sourceRoot, p)))])));
  await fs.mkdir(home); await fs.mkdir(accountHome); await fs.mkdir(main);
  git(root, 'init', '-q', '-b', 'main');
  git(main, 'init', '-q', '-b', 'main');
  await put(join(main, 'tracked.txt'), 'base\n');
  await put(join(main, 'foreign.txt'), 'foreign base\n');
  await put(join(main, 'src/production-entry.ts'), await fs.readFile(join(sourceRoot, 'src/production-entry.ts')));
  git(main, 'add', '--', 'tracked.txt', 'foreign.txt', 'src/production-entry.ts');
  git(main, 'commit', '-qm', 'Isolated baseline');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main');
  git(root, 'submodule', 'absorbgitdirs');
  git(main, 'worktree', 'add', '-b', 'develop', develop, 'HEAD');
  git(main, 'worktree', 'add', '-b', 'hotfix', hotfix, 'HEAD');
  const configurationRoot = resolve(sourceRoot, '..');
  for (const file of ['projects.json', 'raf.json', 'flow.json']) {
    const data = await fs.readFile(join(configurationRoot, 'conf', file));
    record.configurationHashes ??= {}; record.configurationHashes[file] = digest(data);
    await put(join(root, 'conf', file), data);
  }
  git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf');
  git(root, 'commit', '-qm', 'Isolated Orchestrator registration');
  const host = { orchestratorRoot: root, qaHome: home, environment, sandboxExecutable: 'codex' };
  const mainBefore = await snapshot(main), developBefore = await snapshot(develop);
  let a, b;
  await scenario('I3-I4-persistent-cwd-two-ownerships-ancestor-noop', async () => {
    await put(join(hotfix, 'foreign.txt'), 'foreign dirty\n');
    await put(join(hotfix, 'staged.txt'), 'foreign staged\n');
    git(hotfix, 'add', '--', 'staged.txt');
    await put(join(hotfix, 'untracked.txt'), 'foreign untracked\n');
    const before = await snapshot(hotfix);
    a = await prepareHotfixWorktree(host, 'manual-a');
    b = await prepareHotfixWorktree(host, 'manual-b');
    const after = await snapshot(hotfix);
    assert.deepEqual(after, before); assert.equal(a.cwd, b.cwd); assert.equal(a.gitDirectory, b.gitDirectory); assert.notEqual(a.ownershipPath, b.ownershipPath);
    return { before, after, a, b, note: 'Sequential preparations model distinct owners; concurrent native agents are unexecuted.' };
  });
  await scenario('I2-hotfix-trust-exact-root-and-negative-paths', async () => {
    const alias = join(root, 'hotfix-alias'); await fs.symlink(hotfix, alias);
    const values = { registered: await validateHotfixTrust(root, hotfix, a), subdirectory: await validateHotfixTrust(root, join(hotfix, 'src'), a), symlinkAlias: await validateHotfixTrust(root, alias, a), foreignRoot: await validateHotfixTrust(root, main, a) };
    assert.deepEqual(values, { registered: true, subdirectory: false, symlinkAlias: false, foreignRoot: false });
    git(hotfix, 'checkout', '--detach'); values.detached = await validateHotfixTrust(root, hotfix, a); assert.equal(values.detached, false);
    git(hotfix, 'checkout', 'hotfix'); await fs.unlink(alias);
    return { values, limitation: 'Current production hotfix trust API only, not native codex/claude registration or full spec/design routing.' };
  });
  await scenario('I3-explicit-commit-preserves-foreign-state', async () => {
    await put(join(hotfix, 'own.txt'), 'owned change\n');
    const before = await snapshot(hotfix);
    const refusal = await rejection(() => commitHotfix(host, { workspace: a, paths: ['own.txt'], message: 'Own change' }), /Foreign staged hotfix paths/);
    const afterRefusal = await snapshot(hotfix); assert.deepEqual(afterRefusal, before);
    // This stand owns the simulated foreign path; owner coordination is explicit.
    git(hotfix, 'restore', '--staged', '--', 'staged.txt');
    const committed = await commitHotfix(host, { workspace: a, paths: ['own.txt'], message: 'Isolated own change' });
    const paths = git(hotfix, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'); assert.equal(paths, 'own.txt');
    assert.equal(await fs.readFile(join(hotfix, 'foreign.txt'), 'utf8'), 'foreign dirty\n');
    assert.equal(await fs.readFile(join(hotfix, 'untracked.txt'), 'utf8'), 'foreign untracked\n');
    assert.deepEqual(await snapshot(main), mainBefore); assert.deepEqual(await snapshot(develop), developBefore);
    const cleanup = await cleanupHotfixWorktree(host, a); assert.equal(await exists(a.ownershipPath), false); assert.equal(await exists(b.ownershipPath), true); assert.equal(await exists(hotfix), true);
    return { before, refusal, afterRefusal, committed, committedPaths: paths, afterCommit: await snapshot(hotfix), cleanup, remainingOwner: b.ownershipPath };
  });
  await scenario('I4-nonancestor-dirty-refusal-clean-coordinated-merge', async () => {
    await put(join(main, 'published.txt'), 'new main\n'); git(main, 'add', '--', 'published.txt'); git(main, 'commit', '-qm', 'Advance isolated main');
    const before = await snapshot(hotfix);
    const refusal = await rejection(() => prepareHotfixWorktree(host, 'dirty-refresh'), /Dirty hotfix workspace\/index/);
    assert.deepEqual(await snapshot(hotfix), before);
    // Clear only simulated dirt owned by this stand, without reset or stash.
    await put(join(hotfix, 'foreign.txt'), 'foreign base\n');
    for (const name of ['staged.txt', 'untracked.txt']) await fs.unlink(join(hotfix, name));
    const refreshed = await prepareHotfixWorktree(host, 'clean-refresh');
    assert.equal(refreshed.cwd, hotfix); assert.equal(refreshed.baseCommit, git(main, 'rev-parse', 'HEAD')); git(hotfix, 'merge-base', '--is-ancestor', refreshed.baseCommit, 'HEAD');
    assert.equal(await fs.readFile(join(hotfix, 'published.txt'), 'utf8'), 'new main\n'); b = refreshed;
    return { before, refusal, refreshed, after: await snapshot(hotfix) };
  });
  await scenario('I4-sealed-snapshot-and-configuration-drift-refusal', async () => {
    const sealed = await sealHotfixSnapshot(host, b);
    assert.equal(await fs.readFile(join(sealed.root, 'own.txt'), 'utf8'), 'owned change\n');
    const configPath = join(root, 'conf', 'raf.json'), original = await fs.readFile(configPath);
    const refusal = await rejection(() => sealHotfixSnapshot(host, b, { checkpoint: async phase => { if (phase === 'after-copy') await fs.appendFile(configPath, '\n'); } }), /Hotfix source\/configuration changed while sealing snapshot/);
    await fs.writeFile(configPath, original);
    assert.equal(digest(await fs.readFile(configPath)), record.configurationHashes['raf.json']);
    return { sealed, refusal, note: 'No build/regression/service gates invoked; seal consistency only.' };
  });
  await scenario('I5-real-linux-atomic-directory-exchange', async () => {
    const left = join(root, 'exchange-a'), right = join(root, 'exchange-b');
    await put(join(left, 'tag'), 'old\n'); await put(join(right, 'tag'), 'new\n');
    const provider = createAtomicHotfixSwitch(), capability = await provider.probe(left, right); assert.equal(capability.supported, true); assert.equal(capability.sameDevice, true);
    const before = { left: await fs.readFile(join(left, 'tag'), 'utf8'), right: await fs.readFile(join(right, 'tag'), 'utf8') };
    await provider.exchange(left, right);
    const after = { left: await fs.readFile(join(left, 'tag'), 'utf8'), right: await fs.readFile(join(right, 'tag'), 'utf8') };
    assert.deepEqual(after, { left: 'new\n', right: 'old\n' });
    return { capability, before, after, note: 'Real provider/syscall only, not the full publication/reader/recovery acceptance.' };
  });
  await scenario('I6-develop-origin-refused-before-stand-production-db-change', async () => {
    const state = join(accountHome, '.raf', 'state.sqlite'); await fs.mkdir(dirname(state));
    const db = new DatabaseSync(state); db.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'unchanged\'); PRAGMA user_version=1;'); db.close();
    const before = digest(await fs.readFile(state));
    const refusals = [];
    for (const entryPoint of ['cli', 'runner-limits', 'worker', 'service-store', 'notice', 'hook']) {
      refusals.push({ entryPoint, ...await rejection(() => resolveStateContext({ orchestratorRoot: root, modulePath: join(develop, 'src/production-entry.ts'), homeDirectory: accountHome, operatingSystemHome: accountHome, environment: { HOME: accountHome }, entryPoint }), /STATE_CONTEXT_REFUSED/) });
    }
    const after = digest(await fs.readFile(state)); assert.equal(before, after);
    const check = new DatabaseSync(state, { readOnly: true }); const rows = check.prepare('SELECT * FROM sentinel').all(); check.close(); assert.equal(rows[0].value, 'unchanged');
    return { state, before, after, rows, refusals, note: 'Actual resolver with stand account HOME; productionStateContext/bootstrap and real account HOME deliberately not accessed.' };
  });
  await scenario('I4-conflict-and-unfinished-operation-preserve-work', async () => {
    await put(join(hotfix, 'tracked.txt'), 'hotfix variant\n'); git(hotfix, 'add', '--', 'tracked.txt'); git(hotfix, 'commit', '-qm', 'Hotfix conflicting variant');
    const ownHead = git(hotfix, 'rev-parse', 'HEAD');
    await put(join(main, 'tracked.txt'), 'main variant\n'); git(main, 'add', '--', 'tracked.txt'); git(main, 'commit', '-qm', 'Main conflicting variant');
    const conflict = await rejection(() => prepareHotfixWorktree(host, 'conflict-refresh'), /CONFLICT|Automatic merge failed|merge --no-edit/);
    assert.equal(git(hotfix, 'rev-parse', 'HEAD'), ownHead); assert.equal(await exists(join(b.gitDirectory, 'MERGE_HEAD')), true);
    const before = await snapshot(hotfix);
    const refusal = await rejection(() => prepareHotfixWorktree(host, 'unfinished-refresh'), /unfinished Git operation: MERGE_HEAD/);
    const after = await snapshot(hotfix); assert.deepEqual(after, before);
    return { ownHead, conflict, before, refusal, after, note: 'Conflict left intact; entire disposable stand is removed only after evidence is captured.' };
  });
  record.outcome = 'passed';
} catch (error) {
  record.outcome = 'failed'; record.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  await fs.rm(root, { recursive: true, force: true });
  record.cleanup = { complete: !await exists(root), fixtureRemoved: !await exists(root), spawnedBackgroundProcesses: false };
  record.finishedAt = new Date().toISOString(); record.scriptSha256 = digest(await fs.readFile(import.meta.filename));
  await fs.writeFile(join(output, 'manual-hotfix.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: record.outcome, scenarios: record.scenarios.map(({id,outcome}) => ({id,outcome})), cleanup: record.cleanup, error: record.error ?? null }));
}
