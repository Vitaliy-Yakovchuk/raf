import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from '../test/hotfix-fixture.ts';
import { ensureMainLayoutForStart } from '../src/main-layout.ts';
import { createMainSymlinkRelease, type MainSymlinkStorage, type MainSlot, type MainReleaseIntent } from '../src/main-symlink-release.ts';
import * as shared from '../src/hotfix-activation.ts';
import { inventory, hash, durable } from '../src/hotfix-host.ts';

const output = resolve(process.argv[2] ?? 'evidence/switch-raf-main-by-symlink/qa-4.4/stand');
const self = new URL(import.meta.url).pathname;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const cleanups: (() => unknown)[] = [];
const children = new Set<ReturnType<typeof spawn>>();
const evidence: any = { scenarios: [], commands: [], readers: [], crashes: [] };
let config: any;
let checkpoint = process.argv[5] ?? '';
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...config.environment, GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
async function until(check: () => boolean, label: string) {
  const end = Date.now() + config.budget;
  while (!check()) { if (Date.now() > end) throw new Error('Stand readiness: ' + label); await delay(config.poll); }
}
async function boundary(name: string) {
  if (checkpoint === name) {
    writeFileSync(join(config.root, 'checkpoint'), name);
    await new Promise(() => setInterval(() => {}, 1000));
  }
}
function foreign() {
  return git(config.root, 'ls-files', '--stage').split('\n').filter(line => !/\t(?:raf-main(?:-[ab])?|\.gitmodules)$/.test(line));
}
async function slotInfo(slot: MainSlot) {
  const cwd = join(config.root, 'raf-main-' + slot);
  const commit = git(cwd, 'rev-parse', 'HEAD');
  const tree = git(cwd, 'rev-parse', 'HEAD^{tree}');
  const files = await inventory(cwd);
  const configuration = (await inventory(join(config.root, 'conf'), new Set())).map(file => ({ ...file, path: join('conf', file.path) }));
  return { root: cwd, commit, fingerprint: hash(JSON.stringify({ commit, tree, files, configuration })) };
}
function storage(): MainSymlinkStorage {
  const root = config.root;
  const intentPath = join(root, 'publication-intent.json');
  const published = join(root, 'published.json');
  const logicalPath = join(root, 'raf-main');
  const activeSlot = (): MainSlot => realpathSync(logicalPath).endsWith('-a') ? 'a' : 'b';
  return {
    logicalPath,
    async inspect() {
      const active = activeSlot();
      const slots = { a: await slotInfo('a'), b: await slotInfo('b') };
      const gitlinkLine = git(root, 'ls-files', '--stage').split('\n').find(line => line.startsWith('160000 '))!;
      const [entry, path] = gitlinkLine.split('\t');
      const modulePath = git(root, 'config', '-f', '.gitmodules', '--get', 'submodule.raf-main.path');
      return { active, slots, mainRef: git(slots[active].root, 'rev-parse', 'refs/heads/main'), head: slots[active].commit,
        indexTree: git(root, 'write-tree'), gitlink: { path, commit: entry.split(' ')[1], repository: config.common },
        gitmodules: { path: modulePath, repository: config.common }, foreignIndexFingerprint: hash(JSON.stringify(foreign())),
        activationComplete: !existsSync(intentPath), handoverComplete: true, readers: { a: [], b: [] } };
    },
    async withPublicationLock(operation) {
      const lock = join(root, 'publication.lock');
      for (;;) {
        try { mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(process.pid)); break; }
        catch (error: any) {
          if (error.code !== 'EEXIST') throw error;
          try { process.kill(Number(readFileSync(join(lock, 'pid'), 'utf8')), 0); }
          catch (failure: any) { if (failure.code === 'ESRCH') { rmSync(lock, { recursive: true }); continue; } }
          await delay(config.poll);
        }
      }
      try { return await operation(); } finally { rmSync(lock, { recursive: true }); }
    },
    async prepareInactive(source, destination) {
      const cwd = join(root, 'raf-main-' + destination);
      git(cwd, 'checkout', '--detach', git(source.workspace.cwd, 'rev-parse', 'HEAD'));
      return { ...source.workspace, cwd, gitDirectory: realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir')) };
    },
    async assertSnapshot(candidate) {
      const match = await slotInfo(candidate.workspace.cwd.endsWith('-a') ? 'a' : 'b');
      if (candidate.commit !== match.commit || candidate.fingerprint !== match.fingerprint) throw new Error('Candidate fingerprint changed');
    },
    async readIntent() { return existsSync(intentPath) ? read(intentPath) : undefined; },
    async writeIntent(intent) { await durable(intentPath, intent); },
    async probeRename() { return { supported: true, sameDevice: true }; },
    async createTemporarySymlink(target) { const temporary = logicalPath + '.' + randomUUID(); await fs.symlink(target, temporary); return temporary; },
    async renameSymlink(temporary, logical) { await fs.rename(temporary, logical); },
    async removeTemporarySymlink(temporary) { await fs.rm(temporary, { force: true }); },
    async reconcileGit(intent, active) {
      const preserved = foreign();
      const cwd = join(root, 'raf-main-' + active);
      const other = join(root, 'raf-main-' + (active === 'a' ? 'b' : 'a'));
      const commit = git(cwd, 'rev-parse', 'HEAD');
      if (git(other, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main') git(other, 'checkout', '--detach');
      git(cwd, 'update-ref', 'refs/heads/main', commit);
      git(cwd, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      await boundary('git-refs');
      for (const path of ['raf-main-a', 'raf-main-b']) git(root, 'update-index', '--force-remove', path);
      git(root, 'update-index', '--add', '--cacheinfo', '160000', commit, 'raf-main-' + active);
      git(root, 'config', '-f', '.gitmodules', 'submodule.raf-main.path', 'raf-main-' + active);
      git(root, 'add', '.gitmodules');
      assert.deepEqual(foreign(), preserved);
      await boundary('git-index');
      const values = existsSync(published) ? read(published) : {};
      values[active] = active === intent.destination ? intent.candidate : values[active];
      await durable(published, values);
    },
    async clearIntent(id) { if (read(intentPath).id !== id) throw new Error('Intent ID changed'); await fs.rm(intentPath); },
    async resolvePublished(cwd, fingerprint) {
      const slot = cwd.endsWith('-a') ? 'a' : 'b';
      return existsSync(published) && read(published)[slot]?.fingerprint === fingerprint;
    },
    async loadPublished(slot) { return read(published)[slot]; }
  };
}
function release() {
  return createMainSymlinkRelease({ host: config.host, storage: storage(), shared: {
    verify: shared.verifyHotfixCandidate, activate: shared.activateHotfix, recover: shared.recoverHotfixActivation },
    compatibility: async () => ({ compatible: true }), confirmHandover: async () => true,
    checkpoint: async phase => boundary(phase) });
}
async function snapshot() {
  const state = await storage().inspect();
  return { ...state, readlink: await fs.readlink(join(config.root, 'raf-main')), gitmodulesHash: sha(join(config.root, '.gitmodules')),
    staged: git(config.root, 'ls-files', '--stage'), foreign: foreign(), mainStatus: git(join(config.root, 'raf-main'), 'status', '--porcelain') };
}
function child(mode: string, payload = '', at = '') {
  const p = spawn(process.execPath, [self, output, mode, payload, at], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p);
  let stdout = '', stderr = '';
  p.stdout!.on('data', b => stdout += b);
  p.stderr!.on('data', b => stderr += b);
  const done = new Promise<any>(resolveDone => p.on('close', (code, signal) => {
    children.delete(p); const result = { mode, payload, at, code, signal, stdout, stderr }; evidence.commands.push(result); resolveDone(result);
  }));
  return { p, done };
}
async function request(kind: 'develop' | 'hotfix', marker: string) {
  const cwd = join(config.root, 'raf-' + kind);
  git(cwd, 'merge', '--no-edit', 'main');
  for (const name of ['a.mjs', 'b.mjs']) writeFileSync(join(cwd, 'hotfix-fixture', name), `export const marker = ${JSON.stringify(marker)};\n`);
  git(cwd, 'add', 'hotfix-fixture'); git(cwd, 'commit', '--allow-empty', '-m', marker);
  const runId = randomUUID();
  const workspace = { runId, orchestratorRoot: config.root, project: 'raf', targetBranch: 'main', cwd,
    baseCommit: git(join(config.root, 'raf-main'), 'rev-parse', 'HEAD'), repositoryIdentity: config.common,
    gitDirectory: realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir')), commonDirectory: config.common,
    ownershipPath: join(config.root, '.raf-hotfix', 'runs', runId, 'ownership.json') };
  const prepared = await release().prepare({ source: { kind, workspace } as any,
    regression: { executable: process.execPath, args: ['--test', '--test-isolation=none', '--test-name-pattern', '^\\[hotfix-pure\\]', 'test/hotfix-worktree.test.ts'] },
    mainAddress: 'main', message: 'symlink-qa-' + marker });
  const path = join(config.root, 'prepared-' + marker + '.json'); await durable(path, prepared); return path;
}
async function main() {
  mkdirSync(output, { recursive: true });
  const f = await fixture({ after(fn: () => unknown) { cleanups.push(fn); } } as any);
  const projectsPath = join(f.root, 'conf/projects.json');
  const projects = read(projectsPath); projects.projects.raf.mainCopies = ['raf-main-a', 'raf-main-b'];
  writeFileSync(projectsPath, JSON.stringify(projects));
  const initialGit = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: f.environment, encoding: 'utf8' }).trim();
  execFileSync('npm', ['run', 'build'], { cwd: f.main, env: f.environment, stdio: ['ignore', 'pipe', 'pipe'] });
  initialGit(f.main, 'add', '-f', 'dist/catalog.json');
  initialGit(f.main, 'commit', '--allow-empty', '-m', 'build catalog for isolated stand configuration');
  initialGit(f.root, 'add', 'raf-main');
  await ensureMainLayoutForStart({ root: f.root, projects: projects.projects });
  config = { root: f.root, host: f.host, environment: f.environment, budget: f.budget, poll: f.poll,
    common: realpathSync(execFileSync('git', ['-C', f.main, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()) };
  await durable(join(output, 'stand.json'), config);
  evidence.environment = { os: process.platform, node: process.version, source: git(resolve('.'), 'rev-parse', 'HEAD'), dirty: git(resolve('.'), 'status', '--porcelain'), root: f.root };
  await f.startMain();
  writeFileSync(join(f.root, 'foreign.txt'), 'staged foreign bytes\n'); git(f.root, 'add', 'foreign.txt');
  const foreignBefore = foreign();
  evidence.before = await snapshot();
  if (process.env.RAF_SYMLINK_QA_SKIP_REFUSALS === '1') evidence.reusedRefusals = '../stand-6/result.json';
  for (const fault of process.env.RAF_SYMLINK_QA_SKIP_REFUSALS === '1' ? [] : ['build', 'smoke']) {
    const cwd = join(f.root, 'raf-develop');
    const path = join(cwd, fault === 'build' ? 'scripts/build.ts' : 'bin/raf.ts');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, "process.stderr.write('qa " + fault + " refusal');process.exit(37);\n");
    git(cwd, 'add', path); git(cwd, 'commit', '-m', 'inject ' + fault);
    const before = await snapshot();
    let reason = '';
    try { await request('develop', 'refused-' + fault); } catch (error) { reason = String(error); }
    assert.match(reason, fault === 'build' ? /build.*failed/i : /help.*failed|smoke.*failed/i);
    const after = await snapshot();
    assert.deepEqual(after.slots[after.active], before.slots[before.active]);
    for (const key of ['active', 'readlink', 'mainRef', 'head', 'indexTree', 'foreignIndexFingerprint', 'gitmodulesHash']) assert.deepEqual(after[key], before[key]);
    evidence.scenarios.push({ marker: fault + '-refusal', reason, before, after });
    console.log('completed ' + fault + '-refusal');
    writeFileSync(path, original); git(cwd, 'add', path); git(cwd, 'commit', '-m', 'restore ' + fault);
  }
  let latest = '';
  for (let cycle = 1; cycle <= 2; cycle++) {
    for (const direction of ['B', 'A']) {
      const marker = `cycle-${cycle}-${direction}`;
      const path = await request(cycle === 2 ? 'hotfix' : 'develop', marker);
      latest = path;
      const before = await snapshot();
      await saveGates(dirname(read(path).candidate.evidencePath), join(output, marker + '-gates'));
      const readers = Array.from({ length: 3 }, () => child('reader', marker));
      await until(() => readers.every(r => existsSync(join(f.root, 'reader-' + r.p.pid))), 'readers pinned');
      const result = await child('publish', path).done;
      writeFileSync(join(f.root, 'release-readers-' + marker), 'published');
      assert.equal(result.code, 0, result.stderr);
      for (const r of readers) { const result = await r.done; assert.equal(result.code, 0, result.stderr); evidence.readers.push(JSON.parse(result.stdout)); }
      const after = await snapshot(); assert.notEqual(before.active, after.active); assert.deepEqual(foreign(), foreignBefore);
      evidence.scenarios.push({ marker, before, after, result }); console.log('completed ' + marker);
    }
  }
  const dbPath = join(f.home, '.raf/state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE qa_release_records (version TEXT); INSERT INTO qa_release_records VALUES ('B-write')");
  db.close();
  const rollbackBefore = await snapshot();
  const rollbackResult = await child('rollback', latest).done;
  assert.equal(rollbackResult.code, 0, rollbackResult.stderr);
  const rollbackAfter = await snapshot(); assert.notEqual(rollbackBefore.active, rollbackAfter.active);
  const reopened = new DatabaseSync(dbPath); const rows = reopened.prepare('SELECT * FROM qa_release_records').all(); reopened.close();
  assert.deepEqual(rows.map(row => row.version), ['B-write']);
  evidence.scenarios.push({ marker: 'rollback-keeps-SQLite-write', before: rollbackBefore, after: rollbackAfter, rows, result: rollbackResult });
  const path = await request('develop', 'crash-candidate');
  await saveGates(dirname(read(path).candidate.evidencePath), join(output, 'crash-candidate-gates'));
  const stable = await snapshot();
  for (const at of ['before-intent', 'after-intent', 'before-switch', 'after-switch', 'git-refs', 'git-index', 'after-index']) {
    rmSync(join(f.root, 'checkpoint'), { force: true });
    const victim = child('publish', path, at);
    await until(() => existsSync(join(f.root, 'checkpoint')), 'crash ' + at);
    victim.p.kill('SIGKILL'); const killed = await victim.done; assert.equal(killed.signal, 'SIGKILL');
    const beforeRecovery = await snapshot();
    const recovery = await child('recover').done; assert.equal(recovery.code, 0, recovery.stderr);
    const afterRecovery = await snapshot(); assert.deepEqual(foreign(), foreignBefore);
    const again = await child('recover').done; assert.equal(again.code, 0, again.stderr);
    if (afterRecovery.active !== stable.active) {
      const result = await child('rollback', path).done; assert.equal(result.code, 0, result.stderr);
    }
    console.log('recovered ' + at);
    evidence.crashes.push({ at, killed, beforeRecovery, recovery, afterRecovery, again, restored: await snapshot() });
  }
  const competing = await Promise.all([child('publish', path).done, child('publish', path).done]);
  assert.deepEqual(competing.map(result => result.code).sort(), [0, 1]);
  assert.match(competing.find(result => result.code === 1).stderr, /stale|changed/i);
  evidence.scenarios.push({ marker: 'two-publishers-one-stale-loser', results: competing, after: await snapshot() });
  assert.deepEqual(foreign(), foreignBefore);
  evidence.after = await snapshot();
  const verification = join(config.common, 'raf-hotfix/verification');
  if (existsSync(verification)) {
    for (const runId of await fs.readdir(verification)) for (const attempt of await fs.readdir(join(verification, runId))) {
      const directory = join(verification, runId, attempt);
      await saveGates(directory, join(output, 'all-gates', runId, attempt));
    }
  }
}
async function saveGates(directory: string, target: string) {
  await fs.mkdir(target, { recursive: true });
  for (const name of await fs.readdir(directory)) if (name.endsWith('.json')) await fs.copyFile(join(directory, name), join(target, name));
}
try {
  if (process.argv[3]) {
    config = read(join(output, 'stand.json'));
    const mode = process.argv[3];
    if (mode === 'reader') {
      const pinned = realpathSync(join(config.root, 'raf-main'));
      writeFileSync(join(config.root, 'reader-' + process.pid), pinned);
      const a = await import(pathToFileURL(join(pinned, 'hotfix-fixture/a.mjs')).href);
      const helpBefore = execFileSync(process.execPath, [join(pinned, 'bin/raf.ts'), 'help'], { env: config.environment, encoding: 'utf8' });
      await until(() => existsSync(join(config.root, 'release-readers-' + process.argv[4])), 'reader release');
      const b = await import(pathToFileURL(join(pinned, 'hotfix-fixture/b.mjs')).href);
      const helpAfter = execFileSync(process.execPath, [join(pinned, 'bin/raf.ts'), 'help'], { env: config.environment, encoding: 'utf8' });
      assert.equal(a.marker, b.marker); assert.equal(helpBefore, helpAfter);
      console.log(JSON.stringify({ pinned, marker: a.marker, pid: process.pid, helpBefore, helpAfter, helpExitCodes: [0, 0] }));
    } else if (mode === 'publish') console.log(JSON.stringify(await release().publish(read(process.argv[4]))));
    else if (mode === 'recover') console.log(JSON.stringify(await release().recover()));
    else if (mode === 'rollback') console.log(JSON.stringify(await release().rollback(read(process.argv[4]))));
    else throw new Error('Unknown stand mode');
  } else await main();
} catch (error: any) {
  console.error(error.stack ?? error); evidence.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  if (!process.argv[3]) {
    await Promise.all([...children].map(child => new Promise<void>(done => {
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      child.once('close', () => done()); child.kill('SIGKILL');
    })));
    if (config) {
      const verification = join(config.common, 'raf-hotfix/verification');
      if (existsSync(verification)) for (const runId of await fs.readdir(verification)) for (const attempt of await fs.readdir(join(verification, runId))) {
        await saveGates(join(verification, runId, attempt), join(output, 'all-gates', runId, attempt));
      }
    }
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { evidence.cleanupError = String(error); process.exitCode = 1; } }
    evidence.cleanup = { children: children.size, fixtureRemoved: config ? !existsSync(config.root) : false };
    await durable(join(output, 'result.json'), evidence);
  }
}
