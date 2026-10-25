import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';
import { compileCatalog } from '../src/catalog.ts';
import { createProductionServices } from '../src/production-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import type { WorkspaceProjectsConfig, WorkspaceRoutingErrorCode } from '../src/workspace-routing.ts';

const conf = new URL('../../conf/', import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, conf), 'utf8'));
const constants = json('raf-constants.json');
const models = json('models.json');
const timeout = json('flow.json').integrationTests.timeoutMs;
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
const evidenceRoot = fileURLToPath(new URL('../evidence/cfc94-workspace-routing/integration-runs/', import.meta.url));
const gitEnvironment: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Workspace QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'Workspace QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete gitEnvironment[key];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function repository(path: string, branch: string) {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', branch);
  await writeFile(join(path, 'tracked.txt'), 'committed\n');
  git(path, 'add', '--', 'tracked.txt');
  git(path, 'commit', '-q', '-m', 'Workspace integration baseline');
  await writeFile(join(path, 'tracked.txt'), 'foreign dirty edit\n');
  await writeFile(join(path, 'untracked.txt'), 'foreign untracked content\n');
  await writeFile(join(path, 'staged.txt'), 'foreign staged content\n');
  git(path, 'add', '--', 'staged.txt');
}

async function tree(path: string): Promise<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};
  async function visit(directory: string, relative: string) {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const key = relative ? `${relative}/${name}` : name;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) entries[key] = { kind: 'symlink', target: await readlink(absolute), mode: stat.mode };
      else if (stat.isDirectory()) { entries[key] = { kind: 'directory', mode: stat.mode }; await visit(absolute, key); }
      else entries[key] = { kind: 'file', mode: stat.mode, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') };
    }
  }
  await visit(path, '');
  return entries;
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'raf-workspace-integration-')));
  try {
    const root = join(base, 'orchestrator');
    await repository(root, 'main');
    const projects: WorkspaceProjectsConfig = {
      profiles: { fixture: { development: 'release' }, orchestrator: { development: 'main' } },
      projects: {
        orchestrator: { path: '.', profile: 'orchestrator' },
        app: { path: 'app-main', profile: 'fixture', branchPaths: { develop: 'app-develop', release: 'app-release' }, usesSharedLibs: true },
        'shared-libs': { path: 'shared-libs-main', profile: 'fixture', branchPaths: { develop: 'shared-libs-develop', release: 'shared-libs-release' } },
      },
    };
    for (const branch of ['develop', 'release']) {
      await repository(join(root, `app-${branch}`), branch);
      await repository(join(root, `shared-libs-${branch}`), branch);
      await symlink(`../shared-libs-${branch}`, join(root, `app-${branch}`, 'shared-libs'));
    }
    const confRoot = join(root, 'conf');
    const tmpRoot = join(base, 'home', '.raf', 'tmp');
    await mkdir(confRoot, { recursive: true });
    await mkdir(tmpRoot, { recursive: true });
    const persist = () => writeFile(join(confRoot, 'projects.json'), JSON.stringify(projects));
    await persist();
    const statePath = join(base, 'home', '.raf', 'state.sqlite');
    const store = openStateStore(statePath);
    store.setRunnerEnabled('codex', true);
    try {
      const context: RuntimeContext = { orchestratorRoot: root, confRoot, artifactPath: join(base, 'catalog.json'), statePath, tmpRoot, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined };
      const configuration: RuntimeConfiguration = { catalog: compileCatalog(constants, models, constants.commands.map((row: { path: string[] }) => row.path.join(' ')), projects), models, commandTiming: json('raf.json').commandTiming };
      const services = await createProductionServices(store, configuration, context);
      const database = store.startupContextDatabase;
      const state = () => database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => ({ ...row, rows: database.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all().map(value => JSON.stringify(value)).sort() }));
      const snapshot = async () => ({ files: await tree(root), database: state() });
      return { base, root, projects, persist, store, services, statePath, snapshot, databaseIdentity: database.prepare('PRAGMA database_list').all(), sqliteVersion: database.prepare('SELECT sqlite_version() AS version').get() };
    } catch (error) { store.close(); throw error; }
  } catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Scenario = { id: string; project?: string; branch?: string; code?: WorkspaceRoutingErrorCode; prepare?(f: Fixture): Promise<void>; requestRoot?(f: Fixture): string };
const scenarios: Scenario[] = [
  { id: 'product-develop', branch: 'develop' },
  { id: 'product-release', branch: 'release' },
  { id: 'orchestrator-main-without-branchPaths', project: 'orchestrator', branch: 'main' },
  { id: 'product-missing', code: 'WORKSPACE_UNAVAILABLE', prepare: f => rm(join(f.root, 'app-release'), { recursive: true }) },
  { id: 'product-file', code: 'WORKSPACE_UNAVAILABLE', prepare: async f => { await rm(join(f.root, 'app-release'), { recursive: true }); await writeFile(join(f.root, 'app-release'), 'not a workspace'); } },
  { id: 'product-inherits-parent-branch', code: 'WORKSPACE_UNAVAILABLE', prepare: async f => { await rm(join(f.root, 'app-release', '.git'), { recursive: true }); git(f.root, 'branch', '-m', 'release'); } },
  { id: 'product-non-git', code: 'WORKSPACE_UNAVAILABLE', prepare: async f => { await rm(join(f.root, 'app-release', '.git'), { recursive: true }); await rm(join(f.root, '.git'), { recursive: true }); } },
  { id: 'product-wrong-branch', code: 'BRANCH_MISMATCH', prepare: async f => { git(join(f.root, 'app-release'), 'branch', '-m', 'unexpected'); } },
  { id: 'product-detached', code: 'BRANCH_MISMATCH', prepare: async f => { git(join(f.root, 'app-release'), 'checkout', '-q', '--detach', 'HEAD'); } },
  { id: 'product-wrong-git-root', code: 'WORKSPACE_UNAVAILABLE', prepare: async f => { await mkdir(join(f.root, 'app-release', 'subdir')); f.projects.projects.app.branchPaths!.release = 'app-release/subdir'; } },
  { id: 'orchestrator-wrong-root', project: 'orchestrator', branch: 'main', code: 'WORKSPACE_UNAVAILABLE', prepare: async f => { await mkdir(join(f.root, 'subdir')); }, requestRoot: f => join(f.root, 'subdir') },
  { id: 'orchestrator-missing', project: 'orchestrator', branch: 'main', code: 'WORKSPACE_UNAVAILABLE', requestRoot: f => join(f.root, 'missing') },
  { id: 'orchestrator-non-git', project: 'orchestrator', branch: 'main', code: 'WORKSPACE_UNAVAILABLE', prepare: f => rm(join(f.root, '.git'), { recursive: true }) },
  { id: 'orchestrator-wrong-branch', project: 'orchestrator', branch: 'main', code: 'BRANCH_MISMATCH', prepare: async f => { git(f.root, 'branch', '-m', 'unexpected'); } },
  { id: 'orchestrator-detached', project: 'orchestrator', branch: 'main', code: 'BRANCH_MISMATCH', prepare: async f => { git(f.root, 'checkout', '-q', '--detach', 'HEAD'); } },
  { id: 'library-missing-link', code: 'SHARED_LIBS_LINK_INVALID', prepare: f => rm(join(f.root, 'app-release', 'shared-libs')) },
  { id: 'library-wrong-link', code: 'SHARED_LIBS_LINK_INVALID', prepare: async f => { await rm(join(f.root, 'app-release', 'shared-libs')); await symlink('../shared-libs-develop', join(f.root, 'app-release', 'shared-libs')); } },
  { id: 'library-missing-target', code: 'SHARED_LIBS_UNAVAILABLE', prepare: f => rm(join(f.root, 'shared-libs-release'), { recursive: true }) },
  { id: 'library-inherits-parent-branch', code: 'SHARED_LIBS_UNAVAILABLE', prepare: async f => { await rm(join(f.root, 'shared-libs-release', '.git'), { recursive: true }); git(f.root, 'branch', '-m', 'release'); } },
  { id: 'library-non-git', code: 'SHARED_LIBS_UNAVAILABLE', prepare: async f => { await rm(join(f.root, 'shared-libs-release', '.git'), { recursive: true }); await rm(join(f.root, '.git'), { recursive: true }); } },
  { id: 'library-wrong-git-root', code: 'SHARED_LIBS_UNAVAILABLE', prepare: async f => { await mkdir(join(f.root, 'shared-libs-release', 'subdir')); f.projects.projects['shared-libs'].branchPaths!.release = 'shared-libs-release/subdir'; await rm(join(f.root, 'app-release', 'shared-libs')); await symlink('../shared-libs-release/subdir', join(f.root, 'app-release', 'shared-libs')); } },
  { id: 'library-wrong-branch', code: 'SHARED_LIBS_BRANCH_MISMATCH', prepare: async f => { git(join(f.root, 'shared-libs-release'), 'branch', '-m', 'unexpected'); } },
  { id: 'library-detached', code: 'SHARED_LIBS_BRANCH_MISMATCH', prepare: async f => { git(join(f.root, 'shared-libs-release'), 'checkout', '-q', '--detach', 'HEAD'); } },
];

for (const scenario of scenarios) test(`[I1 real Git/fs/SQLite ${scenario.id}] routes without changing repositories or state`, { timeout }, async t => {
  const runId = randomUUID();
  const evidencePath = join(evidenceRoot, `${scenario.id}-${runId}.json`);
  const record: Record<string, unknown> = { scenario: scenario.id, runId, node: process.version, git: git(process.cwd(), '--version'), workspaceSha: git(process.cwd(), 'rev-parse', 'HEAD'), timeoutMs: timeout, testKind: 'integration', injectedPorts: false, scope: 'I1 only; does not establish I2-I6', cleanup: { complete: false } };
  let f: Fixture | undefined;
  try {
    f = await fixture();
    record.fixture = { base: f.base, statePath: f.statePath, databaseIdentity: f.databaseIdentity, sqliteVersion: f.sqliteVersion };
    await scenario.prepare?.(f);
    await f.persist();
    const request = { root: scenario.requestRoot?.(f) ?? f.root, project: scenario.project ?? 'app', branch: scenario.branch ?? 'release' };
    record.request = request;
    const before = await f.snapshot();
    record.before = before;
    const result = await f.services.route(request);
    record.result = result;
    const after = await f.snapshot();
    record.after = after;
    assert.deepEqual(after, before, 'HEAD/index/refs/dirty/untracked/symlinks/SQLite must remain identical');
    if (scenario.code) {
      assert.equal(result.ok, false, `Expected ${scenario.code}: ${JSON.stringify(result)}`);
      if (!result.ok) assert.equal(result.error.code, scenario.code);
    } else {
      const cwd = request.project === 'orchestrator' ? f.root : join(f.root, `app-${request.branch}`);
      assert.deepEqual(result, { ok: true, project: request.project, branch: request.branch, cwd, ...(request.project === 'app' ? { sharedLibrariesPath: join(cwd, 'shared-libs') } : {}) });
    }
    record.outcome = 'passed';
  } catch (error) {
    record.outcome = 'failed';
    record.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    try {
      if (f) { f.store.close(); await rm(f.base, { recursive: true, force: true }); }
      record.cleanup = { complete: true, fixtureRemoved: f ? await lstat(f.base).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT') : true };
    } finally {
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(evidencePath, JSON.stringify(record, null, 2) + '\n');
      t.diagnostic(`I1 evidence: ${evidencePath}`);
    }
  }
});
