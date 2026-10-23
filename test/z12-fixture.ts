import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { createAppRuntime, type RuntimeConfiguration, type RuntimeContext, type RuntimeLaunch, type RuntimeRunParameters, type RuntimeServices } from '../src/app-runtime.ts';
import type { AssignmentSnapshot } from '../src/assignment.ts';
import { compileCatalog } from '../src/catalog.ts';
import { failureContext } from '../src/cli-contract.ts';
import { createProductionServices } from '../src/production-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import { deriveTaskContext, type TaskContextConfiguration } from '../src/task-context.ts';
import { resolveWorkspaceRoute, type WorkspaceProjectsConfig, type WorkspaceRoutingDependencies } from '../src/workspace-routing.ts';

const conf = new URL('../../conf/', import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, conf), 'utf8'));
const constants = json('raf-constants.json');
const models = json('models.json');
const flow = json('flow.json');
export const timeout = flow.unitTests.timeoutMs;
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Z12 Fixture', GIT_AUTHOR_EMAIL: 'z12@example.invalid', GIT_COMMITTER_NAME: 'Z12 Fixture', GIT_COMMITTER_EMAIL: 'z12@example.invalid' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete gitEnvironment[key];
export const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const failureText = (error: unknown) => `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(failureContext(error) ?? {})}`;
export type ProfileConfiguration = WorkspaceProjectsConfig & { version: number; profiles: Record<string, { development?: unknown; integration?: string; production?: string }> };

export async function z12Fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'raf-z12-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'orchestrator');
  const confRoot = join(root, 'conf');
  const home = join(base, 'home');
  const tmpRoot = join(home, '.raf', 'tmp');
  await Promise.all([mkdir(confRoot, { recursive: true }), mkdir(tmpRoot, { recursive: true })]);
  async function repository(path: string, branch: string) {
    await mkdir(path, { recursive: true });
    git(path, 'init', '-q', '-b', branch);
    await writeFile(join(path, 'sentinel.txt'), `${branch}: unchanged\n`);
    git(path, 'add', '--', 'sentinel.txt');
    git(path, 'commit', '-q', '-m', 'Fixture baseline');
  }
  await repository(root, 'main');
  for (const project of ['app', 'shared-libs', 'raf']) {
    for (const branch of ['main', 'develop', 'integration']) await repository(join(root, `${project}-${branch}`), branch);
  }
  for (const branch of ['main', 'develop', 'integration']) await symlink(`../shared-libs-${branch}`, join(root, `app-${branch}`, 'shared-libs'));
  const projects: ProfileConfiguration = {
    version: 1,
    profiles: {
      ...json('projects.json').profiles,
      orchestrator: { development: 'main', integration: 'main', production: 'main' },
      fixture: { development: 'integration', integration: 'main', production: 'main' },
    },
    projects: {
      orchestrator: { path: '.', profile: 'orchestrator' },
      app: { path: 'app-main', profile: 'fixture', branchPaths: { main: 'app-main', develop: 'app-develop', integration: 'app-integration' }, usesSharedLibs: true },
      raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' }, usesSharedLibs: false },
      'shared-libs': { path: 'shared-libs-main', profile: 'fixture', branchPaths: { main: 'shared-libs-main', develop: 'shared-libs-develop', integration: 'shared-libs-integration' } },
    },
  };
  const change = join(root, 'openspec', 'changes', 'z12-contract');
  await mkdir(change, { recursive: true });
  await Promise.all([
    writeFile(join(change, 'proposal.md'), '# Z12 fixture\n'),
    writeFile(join(change, 'design.md'), '# Z12 fixture design\n'),
    writeFile(join(change, 'tasks.md'), '- [ ] 1.1 Prepare assigned documents\n'),
    writeFile(join(confRoot, 'raf-constants.json'), JSON.stringify(constants)),
    writeFile(join(confRoot, 'flow.json'), JSON.stringify(flow)),
    writeFile(join(confRoot, 'models.json'), JSON.stringify(models)),
    writeFile(join(confRoot, 'raf.json'), JSON.stringify(json('raf.json'))),
  ]);
  for (const project of ['orchestrator', 'app', 'raf']) {
    const path = join(root, 'questions', 'projects', project, 'questions.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '# Fixture questions\n');
  }
  const persist = () => writeFile(join(confRoot, 'projects.json'), JSON.stringify(projects));
  await persist();
  const assignment: AssignmentSnapshot = { root, changes: [{ id: 'z12-contract', items: [{ id: '1.1', description: 'Prepare assigned documents' }] }], baselineArchives: [] };
  const parameters = (type = 'spec', project = 'orchestrator'): RuntimeRunParameters => ({ id: `z12-${type}`, type, project, features: ['z12-contract'], phase: type, complexity: models.routing.complexityOrder[0], tasks: ['z12-contract:1.1'] });
  const taskConfiguration: TaskContextConfiguration = { projects, reportStatuses: constants.reportStatuses, resources: flow.resources };
  const derive = (type = 'spec', project = 'orchestrator') => deriveTaskContext({ root, parameters: parameters(type, project), assignment, configuration: taskConfiguration });
  const reads: string[] = [];
  const dependencies: WorkspaceRoutingDependencies = {
    async pathKind(path) {
      reads.push(path);
      const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      return info === null ? 'missing' : info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    },
    async readLink(path) { reads.push(path); return readlink(path); },
    async currentBranch(path) { reads.push(path); return git(path, 'rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD' ? null : git(path, 'branch', '--show-current'); },
  };
  const route = (project = 'orchestrator', branch = 'main', selectedRoot = root) => resolveWorkspaceRoute({ root: selectedRoot, project, branch }, projects, dependencies);
  async function unchanged() {
    return { head: git(root, 'rev-parse', 'HEAD'), branch: git(root, 'symbolic-ref', '-q', 'HEAD'), sentinel: await readFile(join(root, 'sentinel.txt'), 'utf8'), conf: await readFile(join(confRoot, 'projects.json'), 'utf8') };
  }
  return { base, root, confRoot, home, tmpRoot, projects, change, assignment, parameters, taskConfiguration, persist, derive, reads, dependencies, route, unchanged };
}

export async function productionPreparation(t: TestContext, f: Awaited<ReturnType<typeof z12Fixture>>) {
  const statePath = join(f.home, '.raf', 'isolated.sqlite');
  const store = openStateStore(statePath);
  let runtimeOpened = false;
  const context: RuntimeContext = { orchestratorRoot: f.root, confRoot: f.confRoot, artifactPath: join(f.base, 'catalog.json'), statePath, tmpRoot: f.tmpRoot, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined };
  const configuration: RuntimeConfiguration = { catalog: compileCatalog(constants, models, constants.commands.map((row: { path: string[] }) => row.path.join(' ')), f.projects), models, commandTiming: json('raf.json').commandTiming };
  const calls: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error('Runner/tmux/quota forbidden in Z12 preparation fixture'); };
  let production: Promise<RuntimeServices> | undefined;
  const getServices = () => production ??= createProductionServices(store, configuration, context, { execute: async command => {
    calls.push(`${command.executable} ${command.args.join(' ')}`);
    if (command.executable !== 'git') return unexpected();
    try { return { exitCode: 0, stdout: git(command.cwd ?? f.root, ...command.args) + '\n', stderr: '' }; }
    catch (error) { return { exitCode: 1, stdout: '', stderr: String(error) }; }
  } });
  const prepared: RuntimeLaunch[] = [];
  const reserved: Parameters<RuntimeServices['reserve']>[0][] = [];
  const createServices = async (): Promise<RuntimeServices> => ({
    ...await getServices(),
    assignment: { validate: async () => ({ ok: true, snapshot: f.assignment }), compose: async () => 'Z12 fixture brief' },
    routingSnapshot: async () => ({ runnerEnabled: { codex: true }, cliAvailable: { codex: true }, quotas: [] }),
    selectModel: () => ({ status: 'selected', runner: 'codex', model: 'fixture-model', effort: 'fixture-effort', reason: 'fixture', quota: 'unknown' }),
    prepareReport: async launch => { prepared.push(structuredClone(launch)); return { reportPath: join(f.tmpRoot, launch.runId, 'report.json'), reportWrapper: { wrap: command => command }, cleanupUnstarted: async () => {} }; },
    reserve: async launch => { reserved.push(structuredClone(launch)); return { admitted: false, reason: 'Z12_PREPARATION_COMPLETE' }; },
    adapter: { start: unexpected },
  });
  const runtime = createAppRuntime(context, {
    loadConfiguration: async () => configuration, openStore: async () => { runtimeOpened = true; return store; }, createServices,
    nextRunIdentity: () => ({ runId: 'z12-preparation', tmuxSession: 'z12-preparation' }), now: () => Date.now(),
    additionalHandlers: Object.fromEntries(configuration.catalog.commands.filter(row => !['help', 'agent run', 'agent ps', 'agent update', 'agent message', 'agent close', 'agent interrupt', 'main attach', 'runner list', 'runner enable', 'runner disable', 'command stats'].includes(row.handlerName)).map(row => [row.handlerName, unexpected])),
  });
  t.after(async () => { await runtime.close(); if (!runtimeOpened) store.close(); });
  return { services: { route: async (request: Parameters<RuntimeServices['route']>[0]) => (await getServices()).route(request) }, prepared, reserved, calls, run: (type = 'spec', project = 'orchestrator') => Promise.resolve().then(() => runtime.handlers['agent run'](f.parameters(type, project) as unknown as Record<string, unknown>)) };
}
