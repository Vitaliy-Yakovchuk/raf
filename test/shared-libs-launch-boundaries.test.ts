import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppRuntime, type AppRuntimeDependencies, type RuntimeConfiguration, type RuntimeContext, type RuntimeLaunch, type RuntimeRunParameters, type RuntimeServices, type RuntimeTaskContext } from '../src/app-runtime.ts';
import { resolveWorkspaceRoute, type WorkspaceProjectsConfig, type WorkspaceRoutingDependencies } from '../src/workspace-routing.ts';
import { failureContext } from '../src/cli-contract.ts';
import type { AssignmentBriefContext, AssignmentSnapshot } from '../src/assignment.ts';
import type { AdapterStartRequest } from '../src/agent-adapters.ts';
import type { ReportedCommitLaunchContext } from '../src/reported-commits-contract.ts';
import type { StateStore } from '../src/state-store.ts';
import { assertSharedLibraryLaunch, assertSharedLibraryAcceptance } from '../scripts/qa-shared-libs-observation.mjs';

test('live shared-libs stand observes the persisted launchContext contract', () => {
  const layout = { product: '/stand/etchly-develop', library: '/stand/shared-libs-develop', libraryGit: '/stand/.git/modules/shared-libs/worktrees/develop', libraryCommon: '/stand/.git/modules/shared-libs' };
  const actor = {
    activity: { cwd: layout.product }, process: { pid: 123, runnerSessionId: 'native-id' },
    launchContext: { reportedCommits: { repositories: [{ repositoryRoot: layout.library }], writeBoundaries: [layout.library, layout.libraryGit, layout.libraryCommon] } },
  };
  assert.doesNotThrow(() => assertSharedLibraryLaunch(actor, layout, true));
});

test('live shared-libs stand observes accepted commits in WorkResult proof', () => {
  const commit = { repository: '/stand/shared-libs-develop', sha: 'a'.repeat(40) };
  const checkboxCommits = [{ repository: '/stand', sha: 'b'.repeat(40) }];
  const accepted = { reportAcceptance: { status: 'succeeded' }, result: { status: 'succeeded', proof: { commits: [commit], checkboxCommits } } };
  assert.deepEqual(assertSharedLibraryAcceptance(accepted, { commit }), checkboxCommits);
});

const change = 'complete-raf-flow-contracts';

function fixture(t: TestContext, branch: string, usesSharedLibs: boolean | undefined, phase = 'implement') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raf-shared-libs-boundaries-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, `etchly-${branch}`);
  const library = join(root, `shared-libs-${branch}`);
  const link = join(cwd, 'shared-libs');
  const documents = [join(root, 'openspec/changes', change), join(root, 'questions/projects/etchly/questions.md')];
  const git = (name: string) => [join(root, '.git/modules', name, 'worktrees', `${name}-${branch}`), join(root, '.git/modules', name)];
  const projectGit = git('etchly');
  const libraryGit = git('shared-libs');
  const rootGit = join(root, '.git');
  for (const path of [cwd, library, join(root, 'shared-libs-main'), rootGit, ...projectGit, ...libraryGit]) mkdirSync(path, { recursive: true });
  symlinkSync(`../shared-libs-${branch}`, link);
  const projects: WorkspaceProjectsConfig = {
    profiles: { product: { development: branch } },
    projects: {
      etchly: { path: 'etchly-main', profile: 'product', branchPaths: { [branch]: `etchly-${branch}` }, ...(usesSharedLibs === undefined ? {} : { usesSharedLibs }) },
      'shared-libs': { path: 'shared-libs-main', profile: 'product', branchPaths: { main: 'shared-libs-main', [branch]: `shared-libs-${branch}` } },
    },
  };
  let libraryBranch: string | null = branch;
  const inspections: string[] = [];
  const routing: WorkspaceRoutingDependencies = {
    async pathKind(path) { inspections.push(path); return path === link ? 'symlink' : [cwd, library].includes(path) ? 'directory' : 'missing'; },
    async readLink(path) { assert.equal(path, link); return `../shared-libs-${branch}`; },
    async currentBranch(path) { return path === library ? libraryBranch : branch; },
    async realPath(path) { return realpathSync(path); },
    async gitRoot(path) { return realpathSync(path); },
  };
  const assignment: AssignmentSnapshot = { root, changes: [{ id: change, items: [{ id: '9.5', description: 'Shared library launch permissions' }] }], baselineArchives: [] };
  const workspaceWritable = !['spec', 'design'].includes(phase);
  const task: RuntimeTaskContext = { branch, workspaceWritable, outcome: 'Shared library launch permissions', writeBoundaries: documents, sources: ['workspace-routing'], reportSchema: {}, requested: { ramBytes: 1, diskBytes: { fixture: 1 } }, requiredFileSystemIds: ['fixture'] };
  const launches: RuntimeLaunch[] = [];
  const contracts: ReportedCommitLaunchContext[] = [];
  const briefs: AssignmentBriefContext[] = [];
  const starts: AdapterStartRequest[] = [];
  const reservations: RuntimeLaunch[] = [];
  const metadata = new Map([[cwd, projectGit], [library, libraryGit], [root, [rootGit, rootGit]]]);
  const services = {
    assignment: {
      async validate() { return { ok: true, snapshot: assignment }; },
      async compose(_snapshot: AssignmentSnapshot, context: AssignmentBriefContext) { briefs.push(context); return JSON.stringify(context); },
    },
    async resolveTask() { return task; },
    async route(request: Parameters<RuntimeServices['route']>[0]) { return resolveWorkspaceRoute(request, projects, routing); },
    async routingSnapshot() { return { runnerEnabled: {}, cliAvailable: {}, quotas: [] }; },
    selectModel() { return { status: 'selected', runner: 'codex', model: 'fixture', effort: 'fixture', reason: 'fixture', quota: 'unknown' }; },
    async prepareReport(launch: RuntimeLaunch) {
      launches.push(launch);
      const reportPath = join(root, 'tmp/run/report.json');
      const reportedCommits: ReportedCommitLaunchContext = {
        contract: 'reported-commits-v1', runId: launch.runId, reportPath,
        repositories: (launch.commitRepositories ?? []).map(repositoryRoot => {
          const directories = metadata.get(repositoryRoot);
          assert.ok(directories, `Repository must be a canonical registered root: ${repositoryRoot}`);
          return { repositoryRoot, gitDirectory: directories[0], commonDirectory: directories[1], objectFormat: 'sha1', launchHead: '1'.repeat(40) };
        }),
        writeBoundaries: [...launch.writeBoundaries ?? []],
      };
      contracts.push(reportedCommits);
      return { reportPath, reportedCommits, reportWrapper: { wrap: (command: unknown) => command }, async cleanupUnstarted() {} };
    },
    async reserve(launch: RuntimeLaunch) { reservations.push(launch); return { admitted: true }; },
    adapter: { async start(request: AdapterStartRequest) { starts.push(request); return { tmuxSession: request.tmuxSession, selection: request.selection }; } },
    async verifyStarted() { return { pid: 1, startedAt: 'fixture', runner: 'codex', runnerSessionId: 'fixture-native', tmuxSession: 'fixture', evidence: { source: 'verified-agent', runId: 'fixture-run' } }; },
    async commitStarted() { return true; },
    async compensate() { return { stopped: true }; },
    async abortLaunch() {},
  } as unknown as RuntimeServices;
  const configuration = { catalog: { commands: [{ path: ['agent', 'run'], handlerName: 'agent run', parameters: [], metadata: {} }] }, models: { runners: [] }, commandTiming: { emaAlpha: 1, sqliteOnlyMeanBudgetMs: 1 } } as unknown as RuntimeConfiguration;
  const store = { initializeRunners() {}, getRunnerEnabled() { return true; }, recordCommandDuration() {}, close() {} } as unknown as StateStore;
  const dependencies: AppRuntimeDependencies = {
    async loadConfiguration() { return configuration; },
    async openStore() { return store; },
    async createServices() { return services; },
    nextRunIdentity() { return { runId: 'fixture-run', tmuxSession: 'fixture' }; },
    now() { return 1; },
    async resolveGitWriteBoundaries(workspace, orchestratorRoot, boundaries) {
      assert.equal(orchestratorRoot, root);
      if (boundaries) return [rootGit];
      const directories = metadata.get(realpathSync(workspace));
      assert.ok(directories, `Unexpected Git workspace: ${workspace}`);
      return [...new Set([...directories, rootGit])];
    },
  };
  const context: RuntimeContext = { orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'), statePath: join(root, 'state.sqlite'), tmpRoot: join(root, 'tmp'), mode: 'test', commandStartedAtMs: 0, async resolveCaller() { return {}; } };
  const app = createAppRuntime(context, dependencies);
  t.after(() => app.close());
  const parameters: RuntimeRunParameters = { id: 'library-boundaries', type: phase, project: 'etchly', features: [change], phase, complexity: 'normal', tasks: [`${change}:9.5`] };
  return { root, cwd, library, link, documents, projectGit, libraryGit, rootGit, launches, contracts, briefs, starts, reservations, inspections,
    run: () => app.handlers['agent run'](parameters as unknown as Record<string, unknown>),
    setLibraryBranch(value: string | null) { libraryBranch = value; },
  };
}

function samePaths(actual: readonly string[] | undefined, expected: readonly string[], label: string) {
  assert.deepEqual(new Set(actual), new Set(expected), label);
  assert.equal(actual?.length, new Set(actual).size, `${label}: duplicate paths`);
}

for (const branch of ['develop', 'release']) {
  test(`[9.5 ${branch}] dependent etchly grants the canonical same-branch library tree to worker and brief`, async t => {
    const f = fixture(t, branch, true);
    await f.run();
    assert.equal(f.launches.length, 1);
    assert.ok(f.launches[0].writeBoundaries?.includes(f.library), 'Worker writable roots must include the canonical shared-libs tree');
    assert.ok(f.briefs[0].writeBoundaries.includes(f.library), 'Brief must authorize the same library tree');
    samePaths(f.briefs[0].commitPaths, [f.cwd, ...f.documents, f.library], 'Own commit paths');
    assert.equal(f.starts[0].cwd, f.cwd);
    assert.equal(f.launches[0].taskContext?.context.branch, branch);
  });

  test(`[9.5 ${branch}] dependent etchly grants library git-dir and git-common-dir without another branch`, async t => {
    const f = fixture(t, branch, true);
    await f.run();
    const expected = [f.cwd, ...f.documents, f.library, ...f.projectGit, ...f.libraryGit, f.rootGit];
    samePaths(f.launches[0].writeBoundaries, expected, 'Worker writable roots');
    samePaths(f.briefs[0].writeBoundaries, expected, 'Brief writable roots');
    samePaths(f.contracts[0].writeBoundaries, expected, 'Reported-commits writable roots');
    samePaths(f.reservations[0].writeBoundaries, expected, 'Reserved writable roots');
  });

  test(`[9.5 ${branch}] dependent etchly registers the canonical library in reported-commits repositories`, async t => {
    const f = fixture(t, branch, true);
    await f.run();
    const expected = [f.cwd, f.root, f.library];
    samePaths(f.launches[0].commitRepositories, expected, 'Report preparation repositories');
    samePaths(f.contracts[0].repositories.map(row => row.repositoryRoot), expected, 'Reported-commits repositories');
    samePaths(f.briefs[0].commitRepositories, expected, 'Brief repositories');
    const repository = f.contracts[0].repositories.find(row => row.repositoryRoot === f.library);
    assert.equal(repository?.gitDirectory, f.libraryGit[0]);
    assert.equal(repository?.commonDirectory, f.libraryGit[1]);
  });

  for (const usesSharedLibs of [false, undefined]) {
    test(`[9.5 ${branch} dependency ${String(usesSharedLibs)}] local library symlink does not grant library rights`, async t => {
      const f = fixture(t, branch, usesSharedLibs);
      await f.run();
      const expected = [f.cwd, ...f.documents, ...f.projectGit, f.rootGit];
      samePaths(f.launches[0].writeBoundaries, expected, 'Worker writable roots');
      samePaths(f.briefs[0].writeBoundaries, expected, 'Brief writable roots');
      samePaths(f.contracts[0].writeBoundaries, expected, 'Reported-commits writable roots');
      samePaths(f.launches[0].commitRepositories, [f.cwd, f.root], 'Report preparation repositories');
      samePaths(f.briefs[0].commitRepositories, [f.cwd, f.root], 'Brief repositories');
      samePaths(f.briefs[0].commitPaths, [f.cwd, ...f.documents], 'Own commit paths');
      assert.ok(!f.inspections.includes(f.link));
      assert.ok(!f.inspections.includes(f.library));
    });
  }
}

for (const phase of ['spec', 'design']) {
  test(`[9.5 ${phase}] a validated library dependency preserves read-only code and narrow document rights`, async t => {
    const f = fixture(t, 'develop', true, phase);
    await f.run();
    const expected = [...f.documents, f.rootGit];
    samePaths(f.launches[0].writeBoundaries, expected, 'Worker writable roots');
    samePaths(f.briefs[0].writeBoundaries, expected, 'Brief writable roots');
    samePaths(f.launches[0].commitRepositories, [f.root], 'Report preparation repositories');
    samePaths(f.briefs[0].commitRepositories, [f.root], 'Brief repositories');
    samePaths(f.briefs[0].commitPaths, f.documents, 'Own document commit paths');
    assert.equal(f.briefs[0].workspaceWritable, false);
  });
}

for (const actualBranch of ['main', null]) {
  test(`[9.5 library ${actualBranch ?? 'detached'}] invalid dependency is refused before permissions report or runner`, async t => {
    const f = fixture(t, 'develop', true);
    f.setLibraryBranch(actualBranch);
    await assert.rejects(f.run(), error => failureContext(error)?.code === 'SHARED_LIBS_BRANCH_MISMATCH');
    assert.deepEqual(f.launches, []);
    assert.deepEqual(f.briefs, []);
    assert.deepEqual(f.reservations, []);
    assert.deepEqual(f.starts, []);
  });
}
