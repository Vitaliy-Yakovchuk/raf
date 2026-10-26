import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredWorkspaceRoute, resolveDevelopmentBranch, resolveWorkspaceRoute } from '../src/workspace-routing.ts';
import type { WorkspaceProjectsConfig, WorkspaceRouteResult, WorkspaceRoutingDependencies, WorkspaceRoutingErrorCode } from '../src/workspace-routing.ts';
import { bindWorkspaceBoundaries, deriveTaskContext } from '../src/task-context.ts';
import type { TaskContextConfiguration, TaskContextRequest } from '../src/task-context.ts';
import { createAppRuntime } from '../src/app-runtime.ts';
import type { AppRuntimeDependencies, RuntimeConfiguration, RuntimeContext, RuntimeLaunch, RuntimeRunParameters, RuntimeServices, RuntimeTaskContext } from '../src/app-runtime.ts';
import { failureContext } from '../src/cli-contract.ts';
import type { StateStore } from '../src/state-store.ts';
import type { AssignmentBriefContext, AssignmentSnapshot } from '../src/assignment.ts';
import type { AdapterStartRequest } from '../src/agent-adapters.ts';

const root = '/virtual/orchestrator';
const change = 'complete-raf-flow-contracts';
const documents = [`${root}/openspec/changes/${change}`, `${root}/questions/projects/raf/questions.md`];
const assignment: AssignmentSnapshot = { root, changes: [{ id: change, items: [{ id: '9.2', description: 'Workspace routing contract' }] }], baselineArchives: [] };

function fixture() {
  const config: WorkspaceProjectsConfig = {
    profiles: { product: { development: 'release' }, raf: { development: 'develop' }, orchestrator: { development: 'main' } },
    projects: {
      app: { path: 'app-main', profile: 'product', branchPaths: { main: 'app-main', release: 'app-release', develop: 'app-develop' } },
      raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } },
      orchestrator: { path: '.', profile: 'orchestrator' },
    },
  };
  const calls: { operation: string; path: string }[] = [];
  const kinds = new Map<string, Awaited<ReturnType<WorkspaceRoutingDependencies['pathKind']>>>([[root, 'directory']]);
  for (const entry of Object.values(config.projects)) for (const path of Object.values(entry.branchPaths ?? {})) {
    kinds.set(`${root}/${path}`, 'directory');
  }
  const canonical = new Map<string, string>();
  const dependencies: WorkspaceRoutingDependencies = {
    async pathKind(path) { calls.push({ operation: 'pathKind', path }); return kinds.get(path) ?? 'missing'; },
    async readLink(path) { throw new Error(`Unexpected library lookup: ${path}`); },
    async realPath(path) { calls.push({ operation: 'realPath', path }); return canonical.get(path) ?? path; },
  };
  const route = (project = 'orchestrator', branch = 'main', hotfixRunId?: string) => resolveWorkspaceRoute({ root, project, branch, ...(hotfixRunId ? { hotfixRunId } : {}) }, config, dependencies);
  return { config, dependencies, calls, kinds, canonical, route };
}

function refused(result: { ok: true } | Extract<WorkspaceRouteResult, { ok: false }>, code: WorkspaceRoutingErrorCode, fragments: readonly string[] = []) {
  assert.equal(result.ok, false, `Expected ${code}; received ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.equal(result.error.code, code);
  assert.ok(result.error.message.trim());
  for (const fragment of fragments) assert.ok(result.error.message.includes(fragment), `Missing ${fragment} in ${result.error.message}`);
}

function parameters(type: string, project = 'raf'): RuntimeRunParameters {
  return { id: 'workspace-contract', type, project, features: [change], phase: type, complexity: 'normal', tasks: [`${change}:9.2`] };
}

function taskRequest(config: WorkspaceProjectsConfig, type: string, project: string): TaskContextRequest {
  const configuration: TaskContextConfiguration = { projects: config, reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }], resources: {} };
  return { root, parameters: parameters(type, project), assignment, configuration };
}

const documentPorts = {
  async deriveSources(_root: string, _selected: readonly { change: string; item: { id: string; description: string } }[]): Promise<string[]> { return ['explicit workspace-routing contract']; },
  async archiveWriteBoundaries(_root: string, _selected: readonly { change: string; item: { id: string; description: string } }[]): Promise<string[]> { return []; },
};

for (const type of ['spec', 'design']) {
  for (const branch of ['develop', 'release']) {
    test(`[U2 ${type} ${branch}] profile selects development independently of path and route key order`, async () => {
      const f = fixture();
      f.config.profiles!.product.development = branch;
      f.config.projects.app.branchPaths = { release: 'app-release', main: 'app-main', develop: 'app-develop' };
      assert.deepEqual(resolveDevelopmentBranch('app', f.config), { ok: true, branch });
      const context = await deriveTaskContext(taskRequest(f.config, type, 'app'), documentPorts);
      assert.equal(context.branch, branch);
      assert.equal(context.workspaceWritable, false);
      assert.deepEqual(await f.route('app', context.branch), { ok: true, project: 'app', branch, cwd: `${root}/app-${branch}` });
      assert.ok(!f.calls.some(call => call.path === `${root}/app-main`));
    });
  }
  test(`[U3 ${type}] root Orchestrator uses main without branchPaths`, async () => {
    const f = fixture();
    const context = await deriveTaskContext(taskRequest(f.config, type, 'orchestrator'), documentPorts);
    assert.equal(context.branch, 'main');
    assert.equal(context.workspaceWritable, false);
    assert.deepEqual(await f.route('orchestrator', context.branch), { ok: true, project: 'orchestrator', branch: 'main', cwd: root });
    assert.deepEqual(bindWorkspaceBoundaries(context, root), [...(type === 'spec' ? [`${root}/openspec`, `${root}/conf/briefs`] : [`${root}/openspec/changes/${change}`, `${root}/mockups`]), `${root}/questions/projects/orchestrator/questions.md`]);
    assert.equal(f.config.projects.orchestrator.branchPaths, undefined);
  });
}

for (const [label, invalid] of [['missing', undefined], ['null', null], ['empty', ''], ['whitespace', ' '], ['padded', ' develop'], ['number', 7], ['object', {}]] as const) {
  test(`[U2 invalid development ${label}] configuration refuses without a branch fallback`, () => {
    const f = fixture();
    (f.config.profiles!.product as { development: unknown }).development = invalid;
    refused(resolveDevelopmentBranch('app', f.config), 'CONFIGURATION_INVALID', ['conf/projects.json', 'product', 'app', 'development']);
    assert.deepEqual(f.calls, []);
  });
}

for (const label of ['missing profiles', 'missing profile', 'null profile', 'empty profile', 'unknown profile']) {
  test(`[U2 ${label}] profile cannot fall back to the first registered route`, () => {
    const f = fixture();
    if (label === 'missing profiles') delete f.config.profiles;
    if (label === 'missing profile') delete f.config.profiles!.product;
    if (label === 'null profile') (f.config.profiles as Record<string, unknown>).product = null;
    if (label === 'empty profile') f.config.projects.app.profile = '';
    if (label === 'unknown profile') f.config.projects.app.profile = 'unknown';
    refused(resolveDevelopmentBranch('app', f.config), 'CONFIGURATION_INVALID');
  });
}

test('[U2 unmapped development] diagnostic names project profile requested branch and available routes', async () => {
  const f = fixture();
  f.config.profiles!.product.development = 'candidate';
  const development = resolveDevelopmentBranch('app', f.config);
  assert.deepEqual(development, { ok: true, branch: 'candidate' });
  refused(await f.route('app', 'candidate'), 'UNKNOWN_BRANCH', ['app', 'product', 'candidate', 'main', 'develop', 'release']);
  assert.deepEqual(f.calls, []);
});

test('[U3 canonical root] resolves the canonical Orchestrator root', async () => {
  const f = fixture();
  const physical = '/physical/orchestrator';
  f.canonical.set(root, physical);
  f.kinds.set(physical, 'directory');
  assert.deepEqual(await f.route(), { ok: true, project: 'orchestrator', branch: 'main', cwd: physical });
});

test('[U3 unknown root branch] develop is refused before inspection without synthesizing a directory', async () => {
  const f = fixture();
  refused(await f.route('orchestrator', 'develop'), 'UNKNOWN_BRANCH', ['orchestrator', 'develop', 'main']);
  assert.deepEqual(f.calls, []);
});

test('[U3 root exception scope] path dot in another project cannot replace branchPaths', async () => {
  const f = fixture();
  f.config.projects.app.path = '.';
  delete f.config.projects.app.branchPaths;
  refused(await f.route('app', 'release'), 'UNKNOWN_BRANCH', ['app', 'release']);
  assert.deepEqual(f.calls, []);
});

for (const operation of ['pathKind', 'realPath'] as const) {
  test(`[U3 inspection failure ${operation}] unavailable root does not escape as an unstructured exception`, async () => {
    const f = fixture();
    f.dependencies[operation] = async () => { throw new Error(`unreadable ${operation}`); };
    refused(await f.route(), 'WORKSPACE_UNAVAILABLE', [root, operation]);
  });
}

for (const operation of ['realPath'] as const) {
  test(`[U3 absent proof ${operation}] root cannot launch without canonical Git evidence`, async () => {
    const f = fixture();
    delete f.dependencies[operation];
    refused(await f.route(), 'WORKSPACE_UNAVAILABLE');
  });
}

test('[U4 document boundaries] selecting a product or root cwd grants no code or Git write access', () => {
  const boundaries = Object.freeze([...documents]);
  for (const cwd of [root, `${root}/app-release`, `${root}/raf-develop`]) {
    const context = Object.freeze({ workspaceWritable: false, writeBoundaries: boundaries });
    assert.deepEqual(bindWorkspaceBoundaries(context, cwd), documents);
    assert.deepEqual(boundaries, documents);
    assert.ok(!bindWorkspaceBoundaries(context, cwd).includes(cwd));
  }
});

test('[U5 persistent hotfix] separate run IDs share only the registered cwd and leave config unchanged', async () => {
  const f = fixture();
  const before = structuredClone(f.config);
  for (const runId of ['first-run', 'second-run']) {
    assert.deepEqual(await f.route('raf', 'hotfix', runId), { ok: true, project: 'raf', branch: 'hotfix', cwd: `${root}/raf-hotfix` });
  }
  assert.deepEqual(f.config, before);
  assert.ok(f.calls.every(call => call.path === `${root}/raf-hotfix`));
});

test('[U5 missing registration] hotfix cannot fall back to main develop or per-run trees', async () => {
  const f = fixture();
  delete f.config.projects.raf.branchPaths!.hotfix;
  refused(await f.route('raf', 'hotfix', 'run-id'), 'UNKNOWN_BRANCH', ['raf', 'hotfix']);
  assert.deepEqual(f.calls, []);
});

for (const kind of ['missing', 'file', 'symlink'] as const) {
  test(`[U5 hotfix ${kind}] registered name does not make an unusable workspace trusted`, async () => {
    const f = fixture();
    f.kinds.set(`${root}/raf-hotfix`, kind);
    refused(await f.route('raf', 'hotfix', 'run-id'), 'WORKSPACE_UNAVAILABLE');
    assert.ok(f.calls.every(call => call.path === `${root}/raf-hotfix`));
  });
}

for (const substitution of ['canonical alias']) {
  test(`[U5 ${substitution}] branch hotfix alone cannot prove registered workspace identity`, async () => {
    const f = fixture();
    f.canonical.set(`${root}/raf-hotfix`, '/foreign/raf-hotfix');
    refused(await f.route('raf', 'hotfix', 'run-id'), 'WORKSPACE_UNAVAILABLE');
  });
}

for (const operation of ['realPath'] as const) {
  test(`[U5 absent proof ${operation}] hotfix requires positive canonical Git evidence`, async () => {
    const f = fixture();
    delete f.dependencies[operation];
    refused(await f.route('raf', 'hotfix', 'run-id'), 'WORKSPACE_UNAVAILABLE');
  });
  test(`[U5 inspection failure ${operation}] hotfix inspection errors become unavailable workspace`, async () => {
    const f = fixture();
    f.dependencies[operation] = async () => { throw new Error(`unreadable ${operation}`); };
    refused(await f.route('raf', 'hotfix', 'run-id'), 'WORKSPACE_UNAVAILABLE', [operation]);
  });
}

function runtimeFixture(type: string, project = 'raf') {
  const f = fixture();
  const params = parameters(type, project);
  const branch = type === 'hotfix' ? 'hotfix' : project === 'orchestrator' ? 'main' : 'release';
  const cwd = configuredWorkspaceRoute({ root, project, branch }, f.config);
  assert.ok(cwd.ok);
  const events: string[] = [];
  const launches: RuntimeLaunch[] = [];
  const briefs: AssignmentBriefContext[] = [];
  const starts: AdapterStartRequest[] = [];
  const gitRequests: unknown[][] = [];
  const task: RuntimeTaskContext = { branch, workspaceWritable: type !== 'spec' && type !== 'design', outcome: 'Workspace routing contract', sources: ['explicit spec'], writeBoundaries: [...documents], reportSchema: {} as RuntimeTaskContext['reportSchema'], requested: { ramBytes: 1, diskBytes: { fixture: 1 } }, requiredFileSystemIds: ['fixture'] };
  const note = (event: string) => { events.push(event); };
  const identity = { pid: 1, startedAt: 'fixture', runner: 'codex', runnerSessionId: 'native', tmuxSession: 'fixture', evidence: { source: 'verified-agent', runId: 'run-id' } };
  const services = {
    assignment: { async validate() { return { ok: true, snapshot: assignment }; }, async compose(_snapshot: AssignmentSnapshot, context: AssignmentBriefContext) { note('brief'); briefs.push(context); return JSON.stringify(context); } },
    async resolveTask() { return task; },
    async route(request: Parameters<RuntimeServices['route']>[0]) { note('route'); return resolveWorkspaceRoute(request, f.config, f.dependencies); },
    async routingSnapshot() { return { runnerEnabled: {}, cliAvailable: {}, quotas: [] }; },
    selectModel() { return { status: 'selected', runner: 'codex', model: 'fixture', effort: 'fixture', reason: 'fixture', quota: 'unknown' }; },
    async prepareReport(launch: RuntimeLaunch) { note('worker'); launches.push(launch); return { reportPath: '/virtual/tmp/run-id/report.json', reportWrapper: { wrap: (command: unknown) => command }, async cleanupUnstarted() { note('cleanup'); } }; },
    async reserve() { note('reserve'); return { admitted: true }; },
    adapter: { async start(request: AdapterStartRequest) { note('sandbox-trust-adapter'); starts.push(request); return { tmuxSession: request.tmuxSession, selection: request.selection }; } },
    async verifyStarted() { return identity; }, async commitStarted() { return true; },
    async compensate() { return { stopped: true }; }, async abortLaunch() {},
  } as unknown as RuntimeServices;
  const config = { catalog: { commands: [{ path: ['agent', 'run'], handlerName: 'agent run', parameters: [], metadata: {} }] }, models: { runners: [] }, commandTiming: { emaAlpha: 1, sqliteOnlyMeanBudgetMs: 1 } } as unknown as RuntimeConfiguration;
  const store = { initializeRunners() {}, getRunnerEnabled() { return true; }, recordCommandDuration() {}, close() {} } as unknown as StateStore;
  const dependencies: AppRuntimeDependencies = {
    async loadConfiguration() { return config; }, async openStore() { return store; }, async createServices() { return services; },
    nextRunIdentity() { return { runId: 'run-id', tmuxSession: 'fixture' }; }, now() { return 1; },
    async resolveGitWriteBoundaries(...args) { gitRequests.push(args); return [`${root}/.git`]; },
  };
  const context: RuntimeContext = { orchestratorRoot: root, confRoot: `${root}/conf`, artifactPath: `${root}/catalog.json`, statePath: '/virtual/state.sqlite', tmpRoot: '/virtual/tmp', mode: 'test', commandStartedAtMs: 0, async resolveCaller() { return {}; } };
  return { ...f, params, task, events, launches, briefs, starts, gitRequests, dependencies, runtime: () => createAppRuntime(context, dependencies), expectedCwd: cwd.cwd };
}

for (const type of ['spec', 'design']) for (const project of ['app', 'orchestrator']) {
  test(`[U4 ${type} ${project}] worker brief and adapter preserve route with narrow document and Orchestrator Git rights`, async t => {
    const f = runtimeFixture(type, project);
    const app = f.runtime();
    t.after(() => app.close());
    await app.handlers['agent run'](f.params as unknown as Record<string, unknown>);
    assert.equal(f.launches.length, 1);
    assert.equal(f.starts.length, 1);
    assert.equal(f.briefs.length, 1);
    assert.equal(f.launches[0].activity.cwd, f.expectedCwd);
    assert.equal(f.launches[0].taskContext!.context.branch, f.task.branch);
    assert.equal(f.starts[0].cwd, f.expectedCwd);
    assert.equal(f.briefs[0].cwd, f.expectedCwd);
    assert.equal(f.briefs[0].workspaceWritable, false);
    assert.equal(f.launches[0].taskContext!.context.workspaceWritable, false);
    assert.deepEqual(f.gitRequests, [[f.expectedCwd, root, documents]]);
    assert.deepEqual(f.launches[0].writeBoundaries, [...documents, `${root}/.git`]);
    assert.deepEqual(f.briefs[0].writeBoundaries, [...documents, `${root}/.git`]);
    assert.deepEqual(f.launches[0].commitRepositories, [root]);
    assert.deepEqual(f.briefs[0].commitRepositories, [root]);
    assert.equal(f.starts[0].brief, JSON.stringify(f.briefs[0]));
  });
}

