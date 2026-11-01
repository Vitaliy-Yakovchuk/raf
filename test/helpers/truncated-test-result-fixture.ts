import { rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { SandboxCommandReply } from '../../src/sandbox-test-run.ts';
import { fixtureConfig } from './test-run-fixture.ts';

export async function configuredResultFixture(t: TestContext, f: { root: string; home: string; cwd: string }) {
  await writeFile(join(f.root, 'conf/test-runs.json'), JSON.stringify(fixtureConfig()));
  const callerRun = 'own-run';
  const assignment = { runId: callerRun, agentId: 'caller', phase: 'hotfix' };
  const key = `truncated-result-${crypto.randomUUID()}`;
  const globals = globalThis as Record<string, any>;
  const homes = new Set<string>();
  globals[key] = {
    reply: null,
    snapshot: async () => ({ ancestors: [{ pid: process.pid }], activeChanges: ['add-raf-test-run'] }),
    state: (_root: string, _module: string, home: string) => {
      if (home !== f.home) homes.add(home);
      return { homeDirectory: home, tmpRoot: join(home, '.raf/tmp'), statePath: join(home, '.raf/state.sqlite') };
    },
    broker: async (_request: unknown, ports: any) => {
      await ports.unitContext({ project: 'raf', workspace: f.cwd, group: 'add-raf-test-run/unit' }, assignment);
      if (globals[key].reply instanceof Error) throw globals[key].reply;
      return globals[key].reply;
    },
  };
  const url = new URL(`../../src/test-run-runtime.ts?${key}`, import.meta.url).href;
  const bridge = `const f = globalThis[${JSON.stringify(key)}];`;
  const doubles: Record<string, string> = {
    './production-runtime.ts': `${bridge} export const sandboxTestControlSnapshot = f.snapshot;`,
    './state-migration-guard.ts': `${bridge} export const productionStateContext = f.state; export const stateContextEnvironment = (_context, env) => env; export const canonicalStatePath = path => path;`,
    './state-store.ts': 'export const openStateStore = () => ({ close() {}, sessionRepository: { transaction: () => null } });',
    './test-run-unit-state.ts': 'export const prepareUnitTestState = async () => {};',
    './test-run-resource-runtime.ts': 'export const createTestRunResourcePort = () => ({});',
    './test-run-queue-runtime.ts': 'export const createTestRunQueuePort = () => ({});',
    './test-run-reservations.ts': 'export const reconcileTestRunResources = async () => {};',
    './sandbox-test-run.ts': `${bridge} export const runSandboxTestCommand = f.broker;`,
  };
  const names = Object.keys(doubles);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === url && Object.hasOwn(doubles, specifier)) return { url: `${key}:${names.indexOf(specifier)}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(specifier, context, next) {
      if (specifier.startsWith(`${key}:`)) return { format: 'module', source: doubles[names[Number(specifier.slice(key.length + 1))]], shortCircuit: true };
      return next(specifier, context);
    },
  });
  t.after(async () => { hooks.deregister(); delete globals[key]; for (const home of homes) await rm(home, { recursive: true, force: true }); });
  const { runConfiguredTestRun } = await import(url);
  return {
    run: async (reply: SandboxCommandReply | Error) => {
      globals[key].reply = reply;
      return runConfiguredTestRun(['--project', 'raf', '--phase', 'hotfix', '--group', 'add-raf-test-run/unit'], {
        orchestratorRoot: f.root, homeDirectory: f.home, commandTimingOwner: 'production',
      });
    },
  };
}
