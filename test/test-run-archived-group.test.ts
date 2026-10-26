import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fixtureConfig } from './helpers/test-run-fixture.ts';

for (const change of ['archived', 'removed-during-wait']) test(`production preflight runs configured ${change} regression group`, async t => {
  const root = mkdtempSync('/tmp/raf-archived-group-');
  const conf = join(root, 'conf');
  mkdirSync(conf);
  const config = fixtureConfig();
  config.projects.raf.profiles.node.executable = process.execPath;
  config.projects.raf.profiles.node.checks = [];
  config.projects.raf.profiles.node.unitFiles = ['test/worker-idle-cost.test.ts'];
  const group = 'fix-raf-load-admission/worker-idle';
  config.projects.raf.groups[group] = { profileId: 'node', files: ['test/worker-idle-cost.test.ts'] };
  for (const [name, value] of Object.entries({
    'test-runs.json': config,
    'projects.json': { projects: { raf: { branchPaths: { hotfix: process.cwd() } } } },
    'raf.json': {},
  })) writeFileSync(join(conf, name), JSON.stringify(value));
  for (const name of ['raf-constants.json', 'flow.json']) writeFileSync(join(conf, name), readFileSync(new URL(`../../conf/${name}`, import.meta.url)));
  const caller = { pid: process.pid, startedAt: 'fixture' };
  const assignment = { runId: 'fixture', agentId: 'fixture', type: 'hotfix', phase: 'hotfix', project: 'raf', workspace: process.cwd(), branch: 'hotfix', changes: ['profile-raf-performance'] };
  let snapshots = 0;
  let preflights = 0;
  let unitHome: string | undefined;
  const key = `archivedGroup.${change}`;
  const globals = globalThis as Record<string, unknown>;
  globals[key] = {
    snapshot: async () => ({ ancestors: [caller], callerEvidence: {}, activeChanges: change === 'removed-during-wait' && snapshots++ === 0 ? ['fix-raf-load-admission'] : [] }),
    assignment,
    stateContext: (_root: string, _module: string, home: string) => {
      if (home !== root) unitHome = home;
      return { mode: 'qa', homeDirectory: home, statePath: join(home, '.raf/state.sqlite'), tmpRoot: join(home, '.raf/tmp') };
    },
    run: async (_request: unknown, ports: any) => {
      const unit = await ports.unitContext({ project: 'raf', workspace: process.cwd(), group }, assignment);
      for (let index = 0; index < 2; index++) {
        const environment = await unit.runtime.preflight(unit.context);
        assert.equal(environment.runtimeAvailable, true);
        assert.equal(environment.isolatedHome, true);
        preflights++;
      }
      return { code: 0, stdout: JSON.stringify({ groupSnapshot: 'unavailable', outcome: 'passed' }), stderr: '' };
    },
  };
  const url = new URL(`../src/test-run-runtime.ts?archived-group=${change}`, import.meta.url).href;
  const bridge = `const f = globalThis[${JSON.stringify(key)}];`;
  const doubles: Record<string, string> = {
    './production-runtime.ts': `${bridge} export const sandboxTestControlSnapshot = f.snapshot;`,
    './sandbox-test-caller.ts': `${bridge} export const resolveSandboxTestCaller = () => f.assignment;`,
    './sandbox-test-run.ts': `${bridge} export const runSandboxTestCommand = f.run;`,
    './state-migration-guard.ts': `${bridge} export const productionStateContext = f.stateContext; export const stateContextEnvironment = (_context, env) => env; export const canonicalStatePath = path => path;`,
    './state-store.ts': 'export const openStateStore = () => ({ close() {}, sessionRepository: { transaction: () => null } });',
    './test-run-unit-state.ts': 'export const prepareUnitTestState = async () => {};',
    './test-run-resource-runtime.ts': 'export const createTestRunResourcePort = () => ({});',
    './test-run-queue-runtime.ts': 'export const createTestRunQueuePort = () => ({});',
    './test-run-reservations.ts': 'export const reconcileTestRunResources = async () => {};',
  };
  const names = Object.keys(doubles);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === url && Object.hasOwn(doubles, specifier)) return { url: `archived-group:${key}:${names.indexOf(specifier)}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(specifier, context, next) {
      const prefix = `archived-group:${key}:`;
      if (specifier.startsWith(prefix)) return { format: 'module', source: doubles[names[Number(specifier.slice(prefix.length))]], shortCircuit: true };
      return next(specifier, context);
    },
  });
  t.after(() => { hooks.deregister(); delete globals[key]; rmSync(root, { recursive: true, force: true }); if (unitHome) rmSync(unitHome, { recursive: true, force: true }); });
  const { runConfiguredTestRun } = await import(url);
  const result = await runConfiguredTestRun(['--project', 'raf', '--phase', 'hotfix', '--group', group], { orchestratorRoot: root, homeDirectory: root, commandTimingOwner: 'production' });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(preflights, 2, 'both initial and post-wait preflight must inspect the execution environment');
});
