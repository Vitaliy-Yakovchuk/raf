import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createBackgroundRuntime } from '../src/background-runtime.ts';
import { acquireHotfixReader, activateHotfix, recoverHotfixActivation, verifyHotfixCandidate } from '../src/hotfix-activation.ts';
import { alive, inventory, json, mainRoute } from '../src/hotfix-host.ts';
import { ensureMainLayoutForStart } from '../src/main-layout.ts';
import { ensureProductionMainStore } from '../src/main-production-store.ts';
import { assertMainReleaseLayout, createMainSymlinkRelease } from '../src/main-symlink-release.ts';
import { createProductionMainSymlinkStorage } from '../src/main-symlink-storage.ts';
import { MainVersionCompatibility } from '../src/main-version-compatibility.ts';
import { observeWaitIdentity } from '../src/resource-wait-identity.ts';
import { childMessage, command, fixture, git, timeoutMs } from './hotfix-fixture.ts';

const darwinOnly = { skip: process.platform !== 'darwin', timeout: timeoutMs };
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Independent Mac QA', GIT_AUTHOR_EMAIL: 'mac-qa@example.invalid',
  GIT_COMMITTER_NAME: 'Independent Mac QA', GIT_COMMITTER_EMAIL: 'mac-qa@example.invalid',
};
function g(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
async function write(path: string, bytes: string | Uint8Array) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, bytes);
}
async function tree(path: string): Promise<unknown> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) return { link: await fs.readlink(path) };
  if (stat.isDirectory()) return Object.fromEntries(await Promise.all((await fs.readdir(path)).sort().map(async name => [name, await tree(join(path, name))])));
  return { sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex'), mode: stat.mode & 0o777 };
}
async function working(cwd: string) {
  return {
    head: g(cwd, 'rev-parse', 'HEAD'),
    index: await tree(resolve(cwd, g(cwd, 'rev-parse', '--git-path', 'index'))),
    staged: g(cwd, 'diff', '--cached', '--binary'),
    unstaged: g(cwd, 'diff', '--binary'),
    files: Object.fromEntries(await Promise.all((await fs.readdir(cwd)).filter(name => name !== '.git').sort().map(async name => [name, await tree(join(cwd, name))]))),
  };
}

test('[mac-native] real staging prune during metadata copy preserves both slots, source registrations and dirty state', darwinOnly, async t => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'raf-mac-staging-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const seed = join(base, 'seed');
  const root = join(base, 'orchestrator');
  await fs.mkdir(seed);
  g(seed, 'init', '-q', '-b', 'main');
  await write(join(seed, 'payload'), 'committed bytes\n');
  g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'baseline');
  await fs.mkdir(root); g(root, 'init', '-q', '-b', 'main');
  g(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'raf', seed, 'raf-main');
  const logical = join(root, 'raf-main');
  const active = join(root, 'raf-main-b');
  const inactive = join(root, 'raf-main-a');
  const source = g(logical, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const sourceHead = g(logical, 'rev-parse', 'HEAD');
  await fs.rename(logical, active);
  await fs.symlink('raf-main-b', logical);
  g(root, '--git-dir=' + source, 'config', 'core.worktree', active);
  g(active, 'worktree', 'add', '--detach', inactive, sourceHead);
  g(inactive, 'reset', '--mixed', 'HEAD');
  for (const branch of ['develop', 'hotfix', 'mac']) {
    const cwd = join(root, 'raf-' + branch);
    g(active, 'worktree', 'add', '-b', branch, cwd, sourceHead);
    await write(join(cwd, 'private'), branch + ' untracked bytes\n');
  }
  const projects = { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix', mac: 'raf-mac' }, mainCopies: ['raf-main-a', 'raf-main-b'] } };
  await write(join(root, 'conf/projects.json'), JSON.stringify({ projects }));
  g(root, 'config', '-f', '.gitmodules', 'submodule.raf.path', 'raf-main-b');
  g(root, 'update-index', '--force-remove', 'raf-main');
  g(root, 'add', '.gitmodules', 'raf-main', 'raf-main-b', 'conf/projects.json');
  g(root, 'commit', '-qm', 'physical layout');
  for (const cwd of [active, inactive]) {
    await write(join(cwd, 'payload'), 'staged bytes\n');
    await write(join(cwd, 'binary'), new Uint8Array([0, 255, 17, 10]));
    g(cwd, 'add', 'payload', 'binary');
    await write(join(cwd, 'payload'), 'unstaged bytes above index\n');
    await write(join(cwd, 'private/untracked'), 'private bytes\n');
    await fs.chmod(resolve(cwd, g(cwd, 'rev-parse', '--git-path', 'index')), 0o640);
  }
  await write(join(root, 'foreign'), 'foreign staged bytes\n'); g(root, 'add', 'foreign');
  await write(join(root, 'foreign'), 'foreign unstaged bytes\n');
  const control = join(source, 'raf-hotfix');
  await write(join(control, 'generations/pinned/marker'), 'immutable pinned generation');
  await write(join(control, 'prefixes/pinned.json'), '{"generation":"pinned"}');
  const before = { active: await working(active), inactive: await working(inactive), parent: g(root, 'ls-files', '--stage'), modules: await tree(join(root, '.gitmodules')), pins: await tree(join(control, 'generations')), prefixes: await tree(join(control, 'prefixes')) };
  const sourceStates = async () => Object.fromEntries(await Promise.all(['develop', 'hotfix', 'mac'].map(async branch => {
    const cwd = join(root, 'raf-' + branch);
    return [branch, { working: await working(cwd), pointer: await fs.readFile(join(cwd, '.git'), 'utf8'), registration: await tree(g(cwd, 'rev-parse', '--absolute-git-dir')) }];
  })));
  const sourcesBefore = await sourceStates();
  const copyFile = fs.copyFile;
  let pruned = 0;
  fs.copyFile = async (from, to, ...options) => {
    await copyFile(from, to, ...options);
    if (String(to).includes('/worktrees/main-inactive/') && String(to).endsWith('/ORIG_HEAD')) {
      const staging = String(to).split('/worktrees/')[0];
      g(root, '--git-dir=' + staging, 'worktree', 'prune', '--expire', 'now');
      pruned += 1;
      assert.equal((await fs.lstat(dirname(String(to)))).isDirectory(), true);
    }
  };
  let result;
  try { result = await ensureProductionMainStore({ root }); }
  finally { fs.copyFile = copyFile; }
  assert.equal(pruned, 1);
  assert.equal(result.split, true);
  assert.notEqual(result.production, source);
  assert.deepEqual(await working(active), before.active);
  assert.deepEqual(await working(inactive), before.inactive);
  assert.deepEqual(await sourceStates(), sourcesBefore);
  assert.equal(g(root, 'ls-files', '--stage'), before.parent);
  assert.deepEqual(await tree(join(root, '.gitmodules')), before.modules);
  assert.deepEqual(await tree(join(control, 'generations')), before.pins);
  assert.deepEqual(await tree(join(control, 'prefixes')), before.prefixes);
  assert.equal(await fs.readlink(logical), 'raf-main-b');
  assert.equal(g(join(root, 'raf-develop'), 'rev-parse', 'refs/heads/main'), sourceHead);
  assert.deepEqual(Buffer.from(execFileSync('git', ['-C', active, 'show', ':binary'], { env: environment })), Buffer.from([0, 255, 17, 10]));
  const production = await tree(result.production);
  async function independent(path: string) {
    const stat = await fs.lstat(path);
    assert.equal(stat.isSymbolicLink(), false, path);
    if (stat.isDirectory()) for (const name of await fs.readdir(path)) await independent(join(path, name));
    else assert.equal(stat.nlink, 1, path);
  }
  await independent(result.production);
  assert.equal(await fs.access(join(result.production, 'objects/info/alternates')).then(() => true, () => false), false);
  await ensureProductionMainStore({ root });
  assert.deepEqual(await tree(result.production), production);
  assert.deepEqual(await sourceStates(), sourcesBefore);
});

test('[mac-native] sealed mac gates and native crash recovery preserve composer delivery, pinned generation and foreign index', darwinOnly, async t => {
  const originalTmp = process.env.TMPDIR;
  let f;
  try {
    process.env.TMPDIR = await fs.realpath(tmpdir());
    f = await fixture(t);
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
  }
  f.environment.TMPDIR = await fs.realpath(tmpdir());
  f.host.environment.TMPDIR = f.environment.TMPDIR;
  if (process.env.TZ === undefined) {
    delete f.environment.TZ;
    delete f.host.environment.TZ;
  } else {
    f.environment.TZ = process.env.TZ;
    f.host.environment.TZ = process.env.TZ;
  }
  const source = join(f.root, 'raf-mac');
  git(f.main, f.environment, 'worktree', 'add', '-b', 'mac', source, f.baseCommit);
  const configuration = await json(join(f.root, 'conf/projects.json'));
  configuration.projects.raf.branchPaths.mac = 'raf-mac';
  configuration.projects.raf.mainCopies = ['raf-main-a', 'raf-main-b'];
  await fs.writeFile(join(f.root, 'conf/projects.json'), JSON.stringify(configuration));
  await ensureMainLayoutForStart({ root: f.root, projects: configuration.projects });
  await f.startMain();
  const sharedMarker = join(f.home, '.raf/independent-shared-marker');
  await write(sharedMarker, 'shared state stays outside slots');
  for (const name of ['a.mjs', 'b.mjs']) await fs.writeFile(join(source, 'hotfix-fixture', name), 'export const marker = "mac-native";\n');
  await fs.cp(join(f.main, 'node_modules'), join(source, 'node_modules'), { recursive: true, dereference: true });
  const built = command(process.execPath, ['scripts/build.ts'], source, f.environment);
  assert.equal(built.code, 0, built.stderr);
  git(source, f.environment, 'add', 'hotfix-fixture');
  git(source, f.environment, 'add', '-f', 'dist');
  git(source, f.environment, 'commit', '-m', 'independent mac candidate');
  const workspace = {
    runId: randomUUID(), orchestratorRoot: f.root, project: 'raf' as const, targetBranch: 'main' as const,
    cwd: source, baseCommit: f.baseCommit,
    repositoryIdentity: await fs.realpath(git(source, f.environment, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
    gitDirectory: await fs.realpath(git(source, f.environment, 'rev-parse', '--absolute-git-dir')),
    commonDirectory: await fs.realpath(git(source, f.environment, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
    ownershipPath: join(f.root, '.raf-hotfix/mac-qa-ownership.json'),
  };
  const message = 'independent-mac-sealed-' + randomUUID();
  const candidate = await verifyHotfixCandidate(f.host, { source: 'mac', workspace, regression: { executable: process.execPath, args: ['--test', '--test-isolation=none', '--test-name-pattern', '^\\[hotfix-pure\\]', 'test/hotfix-worktree.test.ts'] }, mainAddress: 'main', message }).catch(async error => {
    const evidence = join((await mainRoute(f.host)).control, 'verification', workspace.runId);
    for (const run of await fs.readdir(evidence)) for (const name of ['build', 'regression', 'runtime-import', 'agent-message', 'service-start', 'service-ready']) {
      const log = await json(join(evidence, run, name + '.json')).catch(() => undefined);
      if (log && (log.code !== 0 || log.verificationError)) t.diagnostic(JSON.stringify({ name, ...log }));
    }
    for (const path of [join(f.home, '.raf/service.log'), join(f.home, '.raf/service.json'), join(f.root, 'fixture-services.jsonl')]) {
      t.diagnostic(JSON.stringify({ path, contents: await fs.readFile(path, 'utf8').catch(() => null) }));
    }
    throw error;
  });
  assert.equal(candidate.snapshot?.source, 'mac');
  const required = ['build', 'regression', 'runtime-import', 'help', 'agent-ps', 'agent-message', 'service-start', 'service-ready', 'service-status', 'service-stop'];
  assert.deepEqual(candidate.gates.map(gate => gate.name).sort(), required.sort());
  for (const gate of candidate.gates) {
    assert.equal(gate.code, 0, gate.name);
    assert.equal(gate.status, 'passed', gate.name);
    assert.equal(gate.fingerprint, candidate.fingerprint, gate.name);
    assert.equal(gate.commit, candidate.commit, gate.name);
  }
  assert.equal((await fs.readFile(f.inbox, 'utf8')).split(message).length - 1, 1);
  const storage = createProductionMainSymlinkStorage(f.host);
  const initial = await storage.inspect();
  assertMainReleaseLayout(initial, storage.logicalPath);
  await assert.rejects(activateHotfix(f.host, { ...candidate, gates: candidate.gates.filter(gate => gate.name !== 'agent-message') }));
  assert.deepEqual(await storage.inspect(), initial);
  const indexLock = join(git(f.root, f.environment, 'rev-parse', '--absolute-git-dir'), 'index.lock');
  await fs.writeFile(indexLock, 'foreign writer retained', { flag: 'wx' });
  try {
    await assert.rejects(activateHotfix(f.host, candidate), /Git operation pending/);
    assert.equal(await fs.readFile(indexLock, 'utf8'), 'foreign writer retained');
  } finally { await fs.unlink(indexLock); }
  assert.deepEqual(await storage.inspect(), initial);
  const reader = await acquireHotfixReader(f.host, 'cli');
  t.after(() => reader.release());
  const pinned = await inventory(reader.generationRoot);
  await write(join(f.root, 'foreign'), 'staged independent bytes'); git(f.root, f.environment, 'add', 'foreign');
  await write(join(f.root, 'foreign'), 'unstaged independent bytes');
  const staged = git(f.root, f.environment, 'ls-files', '--stage', 'foreign');
  await assert.rejects(activateHotfix(f.host, candidate, { checkpoint: async phase => { if (phase === 'after-intent') throw new Error('independent-before-switch'); } }), /independent-before-switch/);
  assert.equal((await recoverHotfixActivation(f.host)).status, 'recovered');
  assert.equal((await storage.inspect()).active, initial.active);
  const child = f.forkModule(`
    const {activateHotfix} = await import(${JSON.stringify(new URL('../src/hotfix-activation.ts', import.meta.url).href)});
    await activateHotfix(hotfixFixturePayload.host, hotfixFixturePayload.candidate, {checkpoint: async phase => {
      if(phase === 'after-switch') {process.send({checkpoint:phase}); await new Promise(() => {});}
    }});
  `, { host: f.host, candidate });
  await childMessage(child, value => value.checkpoint === 'after-switch', f.budget);
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  child.kill('SIGKILL');
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
  await write(join(f.root, 'after-crash'), 'unrelated writer after crash'); git(f.root, f.environment, 'add', 'after-crash');
  const afterCrash = git(f.root, f.environment, 'ls-files', '--stage', 'after-crash');
  assert.equal((await recoverHotfixActivation(f.host)).status, 'recovered');
  const final = await storage.inspect();
  assertMainReleaseLayout(final, storage.logicalPath);
  assert.notEqual(final.active, initial.active);
  assert.equal(final.head, candidate.commit);
  assert.equal(final.mainRef, candidate.commit);
  assert.equal((await activateHotfix(f.host, candidate)).status, 'already-active');
  assert.equal(await storage.readIntent(), undefined);
  assert.equal(git(f.root, f.environment, 'ls-files', '--stage', 'foreign'), staged);
  assert.equal(git(f.root, f.environment, 'ls-files', '--stage', 'after-crash'), afterCrash);
  assert.equal(await fs.readFile(join(f.root, 'foreign'), 'utf8'), 'unstaged independent bytes');
  assert.deepEqual(await inventory(reader.generationRoot), pinned);
  assert.equal(await fs.readFile(sharedMarker, 'utf8'), 'shared state stays outside slots');
  for (const slot of ['raf-main-a', 'raf-main-b']) assert.equal(await fs.access(join(f.root, slot, '.raf/state.sqlite')).then(() => true, () => false), false);
  const delivered = await f.mainCommand(['agent', 'message', '--to', 'main', '--text', 'after-forward-' + message]);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal((await fs.readFile(f.inbox, 'utf8')).split('after-forward-' + message).length - 1, 1);
  const route = await mainRoute(f.host);
  assert.equal(route.cwd, final.slots[final.active].root);
  await reader.release();
  const statePath = join(f.home, '.raf/state.sqlite');
  const serviceSettings = (await json(join(f.root, 'conf/raf.json'))).service;
  const runtime = createBackgroundRuntime({ stateDirectory: join(f.home, '.raf'), socketPath: join(f.home, '.raf/service.sock'), entryRelativePath: serviceSettings.entryRelativePath, readinessTimeoutMs: serviceSettings.readinessTimeoutMs }, { resolveMainPath: () => fs.realpath(f.main) });
  async function quietRuntime() {
    const service = await runtime.status();
    const database = new DatabaseSync(statePath, { readOnly: true });
    let sessions;
    try { sessions = database.prepare("SELECT address_id,payload FROM sessions WHERE state != 'finished'").all(); }
    finally { database.close(); }
    const main = sessions.filter(row => row.address_id === 'main').map(row => JSON.parse(String(row.payload)));
    const server = command('tmux', ['-S', f.socket, 'display-message', '-p', '#{pid}'], f.root, f.environment);
    const allowed = new Set([Number(server.stdout.trim()), ...main.map(session => session.process?.pid)]);
    const ownedProcesses = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(f.root)).map(line => Number(line.trim().split(/\s+/)[0]));
    const readers = join(route.control, 'readers');
    const liveReaders = [];
    for (const name of await fs.readdir(readers).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const lease = await json(join(readers, name));
      if (await alive(lease.pid, lease.start)) liveReaders.push(name);
    }
    const services = (await fs.readFile(join(f.root, 'fixture-services.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const serviceObservations = await Promise.all(services.map(owner => observeWaitIdentity(owner.identity)));
    const quiet = service.exitCode === 0 && service.state === 'stopped' && service.pid === null && main.length === 1 && sessions.length === 1 && server.code === 0 && ownedProcesses.includes(main[0].process.pid) && ownedProcesses.every(pid => allowed.has(pid)) && liveReaders.length === 0 && serviceObservations.every(observation => observation.state === 'dead');
    return { quiet, service, sessionAddresses: sessions.map(row => row.address_id), ownedProcesses, liveReaders, serviceObservations: serviceObservations.map(observation => observation.state) };
  }
  const compatibility = new MainVersionCompatibility();
  let compatibilityChecks = 0;
  let handoverChecks = 0;
  const release = createMainSymlinkRelease({
    host: f.host, storage,
    shared: { verify: verifyHotfixCandidate, activate: activateHotfix, recover: recoverHotfixActivation },
    async compatibility(previous, next) {
      compatibilityChecks += 1;
      const runtimeFiles = files => files.filter(file => /^(src|bin|scripts|dist)\//.test(file.path) || ['package.json', 'package-lock.json'].includes(file.path));
      const before = runtimeFiles(await inventory(previous.slots[previous.active].root));
      const after = runtimeFiles(await inventory(next.snapshot!.root));
      const manifestEqual = JSON.stringify(before) === JSON.stringify(after);
      const oldClient = await import(pathToFileURL(join(previous.slots[previous.active].root, 'src/state-store.ts')).href);
      const nextClient = await import(pathToFileURL(join(next.snapshot!.root, 'src/state-store.ts')).href);
      const client = (id, module) => ({
        contract: { id, schemaVersions: module.STATE_SCHEMA_SUPPORTED_VERSIONS, readableFormats: [1], requiredColumns: ['sessions.run_id', 'sessions.payload', 'reminders.id', 'reminders.payload'] },
        probe(database) {
          for (const row of database.prepare('SELECT run_id,payload FROM sessions').all()) {
            JSON.parse(String(row.payload));
            database.prepare('UPDATE sessions SET payload=? WHERE run_id=?').run(row.payload, row.run_id);
          }
          for (const row of database.prepare('SELECT payload FROM reminders').all()) JSON.parse(String(row.payload));
        },
      });
      const decision = compatibility.checkRelease({ path: statePath, context: { kind: 'isolated-qa', home: f.home, codeRoot: resolve(import.meta.dirname, '..') }, current: client('active-native-main', oldClient), candidate: client('sealed-next-main', nextClient) });
      const observation = await quietRuntime();
      t.diagnostic(JSON.stringify({ guardedCompatibility: { manifestEqual, runtimeManifestSha256: createHash('sha256').update(JSON.stringify(after)).digest('hex'), schemaDecision: decision, runtime: observation } }));
      return { compatible: manifestEqual && decision.compatible && observation.quiet, reason: !observation.quiet ? 'MAC_QA_RUNTIME_NOT_DRAINED' : 'MAC_QA_PROTOCOL_OR_STATE_INCOMPATIBLE' };
    },
    async confirmHandover(active) {
      handoverChecks += 1;
      const current = await storage.inspect();
      const observation = await quietRuntime();
      t.diagnostic(JSON.stringify({ guardedHandover: observation }));
      return current.active === active && current.activationComplete && current.handoverComplete && observation.quiet;
    },
  });
  for (const name of ['a.mjs', 'b.mjs']) await fs.writeFile(join(source, 'hotfix-fixture', name), 'export const marker = "guarded-mac-native";\n');
  git(source, f.environment, 'add', 'hotfix-fixture');
  git(source, f.environment, 'commit', '-m', 'guarded independent mac candidate');
  const guardedMessage = 'guarded-' + message;
  const prepared = await release.prepare({ source: { kind: 'mac', workspace: { ...workspace, runId: randomUUID(), baseCommit: candidate.commit } }, regression: { executable: process.execPath, args: ['--test', '--test-isolation=none', '--test-name-pattern', '^\\[hotfix-pure\\]', 'test/hotfix-worktree.test.ts'] }, mainAddress: 'main', message: guardedMessage });
  const held = await acquireHotfixReader(f.host, 'worker');
  try { await assert.rejects(release.publish(prepared), /MAC_QA_RUNTIME_NOT_DRAINED/); }
  finally { await held.release(); }
  assert.equal((await storage.inspect()).active, final.active);
  assert.equal(await storage.readIntent(), undefined);
  const published = await release.publish(prepared);
  assert.equal(published.status, 'activated');
  assert.equal(published.handoverComplete, true);
  assert.equal(published.active, initial.active);
  assert.ok(compatibilityChecks >= 3);
  assert.equal(handoverChecks, 1);
  assert.equal((await fs.readFile(f.inbox, 'utf8')).split(guardedMessage).length - 1, 1);
  assert.equal((await release.recover()).status, 'idle');
  assert.equal(git(f.root, f.environment, 'ls-files', '--stage', 'foreign'), staged);
  assert.equal(git(f.root, f.environment, 'ls-files', '--stage', 'after-crash'), afterCrash);
  assert.deepEqual(await inventory(reader.generationRoot), pinned);
  assert.equal(await fs.readFile(sharedMarker, 'utf8'), 'shared state stays outside slots');
});
