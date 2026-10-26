import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { runSandboxTestCommand } from '../src/sandbox-test-run.ts';
import { fixtureConfig } from './helpers/test-run-fixture.ts';

const group = 'etchly-screenshot-consent-2335/bugs-ui';
const file = 'test/fixture.test.ts';
const entrypoint = ['node', '/trusted/raf.ts'];
const caller = { pid: 300, startedAt: '2026-10-26T10:00:00Z' };

for (const branch of ['main', 'develop']) test(`broker routes shared-libs ${branch} to etchly ${branch}`, async () => {
  const source = `/fixture/shared-libs-${branch}`;
  const target = `/fixture/etchly-${branch}`;
  const assignment = { runId: 'worker-run', agentId: 'sl-esc901-impl', type: 'agent', phase: 'implement', project: 'shared-libs', workspace: source, branch, changes: ['another-change'] };
  const keys: unknown[] = [];
  const reply = await runSandboxTestCommand({ command: `${entrypoint.join(' ')} test run --project etchly --phase red --group ${group}`, cwd: source }, {
    caller, entrypoint,
    control: async () => ({ ancestors: [caller], sessions: [{ process: caller, state: 'running', assignment }], activeChanges: [], groups: [],
      workspaces: [{ project: 'etchly', workspace: target, branch }, { project: 'etchly', workspace: '/fixture/etchly-release', branch: 'release' }] }),
    unitContext: async (key, actor) => {
      keys.push(key);
      assert.deepEqual(actor, assignment);
      return { context: { cwd: key.workspace, workspace: key.workspace, projectWorkspaces: { etchly: [target] } } } as any;
    },
    wrapper: async (request, unit) => {
      assert.equal(request.project, 'etchly');
      assert.equal(request.group, group);
      assert.equal(unit.context.workspace, target);
      return { code: 0, stdout: '{"fixture":"passed"}', stderr: '' };
    },
    communicate: async () => { throw new Error('Unexpected communication'); },
  });
  assert.equal(reply.code, 0, reply.stderr);
  assert.deepEqual(keys, [{ project: 'etchly', workspace: target, group }]);
  assert.deepEqual(assignment.changes, ['another-change']);
});

for (const scenario of ['main', 'develop', 'hotfix', 'direct', 'nested']) test(`configured cross-project execution uses target tree: ${scenario}`, async t => {
  const root = mkdtempSync('/tmp/raf-z446-');
  const conf = join(root, 'conf');
  const targetBranch = scenario === 'hotfix' ? 'develop' : ['direct', 'nested'].includes(scenario) ? 'release' : scenario;
  const target = join(root, `etchly-${targetBranch}`);
  const source = ['direct', 'nested'].includes(scenario) ? target : join(root, `shared-libs-${scenario}`);
  const cwd = scenario === 'nested' ? join(source, 'src') : source;
  mkdirSync(conf);
  mkdirSync(cwd, { recursive: true });
  for (const branch of ['main', 'develop', 'release']) mkdirSync(join(root, `etchly-${branch}`), { recursive: true });
  const config = fixtureConfig();
  const project = structuredClone(config.projects.raf);
  project.profiles.node.unitFiles = [file];
  project.profiles.node.checks = [];
  project.groups = { [group]: { profileId: 'node', files: [file] } };
  config.projects = { etchly: project };
  const projects = { profiles: { product: { development: 'develop' } }, projects: {
    etchly: { path: 'etchly-main', profile: 'product', branchPaths: { main: 'etchly-main', develop: 'etchly-develop', release: 'etchly-release' } },
    'shared-libs': { path: source, profile: 'product', branchPaths: { [scenario]: source } },
  } };
  for (const [name, value] of Object.entries({ 'test-runs.json': config, 'projects.json': projects, 'raf.json': {} })) writeFileSync(join(conf, name), JSON.stringify(value));
  for (const name of ['raf-constants.json', 'flow.json']) writeFileSync(join(conf, name), readFileSync(new URL(`../../conf/${name}`, import.meta.url)));
  const assignment = { runId: 'fixture', agentId: 'fixture', type: 'agent', phase: 'implement', project: 'shared-libs', workspace: source, branch: scenario, changes: ['another-change'] };
  const captures = { homes: [] as string[], keys: [] as unknown[], sha: [] as string[], resources: [] as string[], queue: [] as string[], contexts: [] as any[] };
  const globalKey = `z446.${scenario}`;
  const globals = globalThis as Record<string, unknown>;
  globals[globalKey] = {
    snapshot: async () => ({ ancestors: [{ ...caller, pid: process.pid }], sessions: [{ process: { ...caller, pid: process.pid }, state: 'running', assignment }],
      workspaces: Object.entries(projects.projects.etchly.branchPaths).map(([branch, path]) => ({ project: 'etchly', workspace: join(root, path), branch })), activeChanges: [], groups: [] }),
    stateContext: (_root: string, _module: string, home: string) => {
      if (home !== root) captures.homes.push(home);
      return { mode: 'qa', homeDirectory: home, statePath: join(home, '.raf/state.sqlite'), tmpRoot: join(home, '.raf/tmp') };
    },
    prepare: async (_state: unknown, key: unknown) => { captures.keys.push(key); },
    git: (path: string) => { captures.sha.push(path); return { commit: 'a'.repeat(40) }; },
    resources: (_store: unknown, options: any) => { captures.resources.push(options.workspace); return {}; },
    queue: (_store: unknown, options: any) => { captures.queue.push(options.workspace); return {}; },
    cli: async (_argv: unknown, ports: any) => {
      captures.contexts.push(ports.context);
      ports.stdout(JSON.stringify({ groupSnapshot: 'unavailable', outcome: 'passed' }));
      return 0;
    },
  };
  const url = new URL(`../src/test-run-runtime.ts?z446=${scenario}`, import.meta.url).href;
  const bridge = `const f = globalThis[${JSON.stringify(globalKey)}];`;
  const doubles: Record<string, string> = {
    './production-runtime.ts': `${bridge} export const sandboxTestControlSnapshot = f.snapshot;`,
    './state-migration-guard.ts': `${bridge} export const productionStateContext = f.stateContext; export const stateContextEnvironment = (_context, env) => env; export const canonicalStatePath = path => path;`,
    './state-store.ts': 'export const openStateStore = () => ({ close() {}, sessionRepository: { transaction: () => null } });',
    './test-run-unit-state.ts': `${bridge} export const prepareUnitTestState = f.prepare;`,
    './test-run-resource-runtime.ts': `${bridge} export const createTestRunResourcePort = f.resources;`,
    './test-run-queue-runtime.ts': `${bridge} export const createTestRunQueuePort = f.queue;`,
    './test-run-reservations.ts': 'export const reconcileTestRunResources = async () => {};',
    './git.ts': `${bridge} export const readGitHead = f.git;`,
  };
  const brokerUrl = new URL(`../src/sandbox-test-run.ts?z446=${scenario}`, import.meta.url).href;
  const names = Object.keys(doubles);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === url && specifier === './sandbox-test-run.ts') return { url: brokerUrl, shortCircuit: true };
      if (context.parentURL === brokerUrl && specifier === './test-run-cli.ts') return { url: `data:text/javascript,${encodeURIComponent(`${bridge} export const runTestRunCli = f.cli;`)}`, shortCircuit: true };
      if (context.parentURL === url && Object.hasOwn(doubles, specifier)) return { url: `z446:${scenario}:${names.indexOf(specifier)}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(specifier, context, next) {
      const prefix = `z446:${scenario}:`;
      if (specifier.startsWith(prefix)) return { format: 'module', source: doubles[names[Number(specifier.slice(prefix.length))]], shortCircuit: true };
      return next(specifier, context);
    },
  });
  t.mock.method(process, 'cwd', () => cwd);
  t.after(() => {
    t.mock.restoreAll(); hooks.deregister(); delete globals[globalKey]; rmSync(root, { recursive: true, force: true });
    for (const home of captures.homes) rmSync(home, { recursive: true, force: true });
  });
  const { runConfiguredTestRun } = await import(url);
  const result = await runConfiguredTestRun(['--project', 'etchly', '--phase', 'red', '--group', group], { orchestratorRoot: root, homeDirectory: root, commandTimingOwner: 'production' });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.deepEqual(captures.keys, [{ project: 'etchly', workspace: target, group }]);
  assert.deepEqual(captures.sha, [target]);
  assert.deepEqual(captures.resources, [target]);
  assert.deepEqual(captures.queue, [target]);
  assert.equal(captures.contexts.length, 1);
  assert.equal(captures.contexts[0].workspace, target);
  assert.equal(captures.contexts[0].cwd, target);
  const expectedHome = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`, createHash('sha256').update(JSON.stringify([root, 'etchly', target])).digest('hex'));
  assert.deepEqual(captures.homes, [expectedHome]);
});
