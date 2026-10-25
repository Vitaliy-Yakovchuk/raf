import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RuntimeContext } from '../src/app-runtime.ts';
import type { CompiledCatalog } from '../src/catalog.ts';
import type { PendingAgentReportPorts, AgentReportRequest } from '../src/agent-report.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { SessionRecord, SessionTransaction } from '../src/session-state.ts';
import type { StateStore } from '../src/state-store.ts';

const fixtureKey = Symbol.for('raf.production-report-budget.unit');
const runtimeUrl = new URL('../src/production-runtime.ts?report-budget-unit', import.meta.url).href;
const reportUrl = new URL('../src/agent-report.ts', import.meta.url).href;
const bridge = 'const f = () => globalThis[Symbol.for("raf.production-report-budget.unit")];';
const real = (name: string) => JSON.stringify(new URL(`../src/${name}`, import.meta.url).href);
const doubles: Record<string, string> = {
  'node:fs': `${bridge} export * from 'node:fs'; import { promises as actual } from 'node:fs';
    export const promises = { ...actual,
      readFile: (...args) => f().readFile(...args),
      readlink: async () => 'unit-pid-namespace',
      lstat: async () => ({ isFile: () => true, uid: process.getuid?.(), mode: 0o600 }),
      rm: async path => f().removed.push(path),
    };`,
  './agent-report.ts': `${bridge} export * from ${real('agent-report.ts')};
    import { readPendingAgentReport as actual } from ${real('agent-report.ts')};
    export const readPendingAgentReport = (request, ports) => f().readPending(request, ports, actual);`,
  './state-migration-guard.ts': `${bridge}
    export const productionStateContext = () => f().stateContext;
    export const stateContextEnvironment = (_context, env) => env;
    export const stateFailure = (_code, reason) => new Error(reason);
    export const verifyStateModule = () => {};`,
  './hotfix-activation.ts': `${bridge} export * from ${real('hotfix-activation.ts')};
    export const retainHotfixGeneration = async () => ({ release: async () => { f().released++; } });`,
  './launch-wrapper.ts': `${bridge} export * from ${real('launch-wrapper.ts')};
    export const consumeWrapperRequest = async () => ({ request: f().request });`,
  './state-store.ts': `${bridge} export * from ${real('state-store.ts')};
    export const openStateStore = () => f().store;`,
  './runner-availability.ts': `${bridge} export * from ${real('runner-availability.ts')};
    export const resolveRunnerExecutable = async runner => ({ status: 'resolved', path: '/unit/bin/' + runner });
    export const probeRunnerAvailability = async () => ({ available: true, version: 'unit' });`,
  './raf-cost-runtime.ts': `export const rafCostBoundary = () => ({});
    export class RafCostRuntime { install() {} stage() {} finish() {} }`,
  './health-cpu-runtime.ts': 'export const settleRuntimeHealthCpu = async () => {};',
  './event-catalog.ts': 'export const loadEventCatalog = () => ({ events: [] });',
  './flow-runtime.ts': `export * from ${real('flow-runtime.ts')};
    export const flowEvidencePorts = () => ({});`,
  './reminder-cli.ts': `${bridge} export * from ${real('reminder-cli.ts')};
    export const settleCommandState = options => f().settleHealth(options);`,
  './health-summary-runtime.ts': `${bridge}
    export const scheduleWorkerHealthSummary = () => { throw f().stopAfterHealth; };`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && doubles[specifier]) return { url: `report-budget-unit:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('report-budget-unit:')) return { format: 'module', source: doubles[url.slice('report-budget-unit:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { reconcileProductionReports, runProductionWorker } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
const actualReadPending = (await import(reportUrl) as typeof import('../src/agent-report.ts')).readPendingAgentReport;
const configured = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')) as { version: number; runnerProtocols: ProtocolSettings[] };
test.after(() => hooks.deregister());

function fixture(t: TestContext, runner: 'codex' | 'claude', route: 'worker' | 'reconcile') {
  const root = '/unit/report-budget/orchestrator';
  const context: RuntimeContext = {
    orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'),
    statePath: '/unit/report-budget/home/state.sqlite', tmpRoot: '/unit/report-budget/home/tmp',
    mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  };
  const protocols = structuredClone(configured.runnerProtocols).map((protocol, index) => ({
    ...protocol,
    timeouts: {
      ...protocol.timeouts,
      transitionMs: protocol.timeouts.transitionMs * (index + 1),
      pollMs: protocol.timeouts.pollMs + index,
    },
  }));
  const selected = protocols.find(protocol => protocol.runner === runner)!;
  assert.ok(selected, `conf/raf.json must provide the ${runner} fixture protocol`);
  const assignment = { root, changes: [{ id: 'budget-fixture', items: [{ id: '1.1', description: 'unit report budget' }] }] };
  const selection = { runner, model: 'unit-model', effort: 'unit-effort', reason: 'unit only' };
  const makeSession = (runId: string, addressId: string, state: 'reserved' | 'running'): SessionRecord => ({
    runId, addressId, state, revision: 1,
    activity: { type: 'implement', phase: 'implement', project: 'raf', features: ['budget-fixture'], cwd: `${root}/raf-develop` },
    launchContext: { assignment, selection, briefPath: `${context.tmpRoot}/${runId}/brief.txt`, reportPath: `${context.tmpRoot}/${runId}/${addressId}.json` },
    ...(state === 'running' ? { process: { runner, pid: 12345, startedAt: 'unit-start', runnerSessionId: 'unit-native', tmuxSession: 'unit-session', evidence: {} } } : {}),
  });
  const pending = makeSession('pending-report', 'report-agent', 'running');
  const reserved = makeSession('worker-run', 'worker-agent', 'reserved');
  const sessions = new Map([pending, reserved].map(session => [session.runId, session]));
  const transaction = {
    getSession: (runId: string) => structuredClone(sessions.get(runId)),
    listSessions: () => structuredClone([...sessions.values()]),
  } as SessionTransaction;
  const catalog = { commands: [], reportStatuses: [{ id: 'succeeded', event: 'agent.succeeded' }, { id: 'failed', event: 'agent.failed' }] } as unknown as CompiledCatalog;
  const brief = 'unit budget brief';
  const request = {
    runId: reserved.runId, address: reserved.addressId, assignment, cwd: reserved.activity!.cwd,
    statePath: context.statePath, tmpRoot: context.tmpRoot, brief, selection: { runner, model: selection.model, effort: selection.effort },
  };
  const manifest = { version: 1, context, configuration: { catalog }, runnerPath: `/unit/bin/${runner}` };
  const f = {
    context, catalog, protocols, selected, request, pending, sessions,
    stateContext: { ...context, homeDirectory: '/unit/report-budget/home', mode: 'test' },
    store: undefined as unknown as StateStore,
    observations: [] as { runner: string; timeouts: unknown }[],
    confReads: 0, completedReads: 0, closed: 0, released: 0,
    removed: [] as string[], healthFailure: undefined as unknown,
    reportBoundary: new Error('unit cutoff after real report confirmation'),
    stopAfterHealth: new Error('unit cutoff before native launch'),
    async readFile(path: string) {
      if (path === join(context.confRoot, 'raf.json')) { f.confReads++; return JSON.stringify({ version: configured.version, runnerProtocols: f.protocols }); }
      if (path === join(context.tmpRoot, reserved.runId, 'runtime.json')) return JSON.stringify(manifest);
      if (path === reserved.launchContext!.briefPath) return brief;
      if (path === '/proc/self/stat') return 'unit (worker) R 0 0 0';
      throw Object.assign(new Error(`Unit file absent: ${path}`), { code: 'ENOENT' });
    },
    async readPending(reportRequest: AgentReportRequest, ports: PendingAgentReportPorts, actual: typeof actualReadPending) {
      const protocol = await ports.confirmationRetry!.protocol() as { timeouts?: unknown };
      f.observations.push({ runner: ports.confirmationRetry!.runner, timeouts: protocol.timeouts });
      const result = await actual(reportRequest, ports);
      f.completedReads++;
      if (route === 'worker') throw f.reportBoundary;
      return result;
    },
    async settleHealth(options: { deliver: (message: { to: string; text: string }) => Promise<unknown> }) {
      try { await options.deliver({ to: pending.addressId, text: 'unit pending health notification' }); }
      catch (error) { f.healthFailure = error; }
    },
  };
  f.store = { sessionRepository: { transaction: (operation: (tx: SessionTransaction) => unknown) => operation(transaction) }, close: () => { f.closed++; } } as unknown as StateStore;
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[fixtureKey];
  globals[fixtureKey] = f;
  t.after(() => { globals[fixtureKey] = previous; });
  t.mock.method(process.stderr, 'write', () => true);
  return f;
}

for (const runner of ['codex', 'claude'] as const) {
  test(`reconcile: ${runner} report confirmation uses transitionMs and pollMs from its full configured protocol`, async t => {
    const f = fixture(t, runner, 'reconcile');
    const outcome = await reconcileProductionReports(f.store, f.context, f.catalog).then(value => ({ value }), error => ({ error }));
    assert.ok(!('error' in outcome), `Valid ${runner} protocol must permit reconciliation: ${'error' in outcome ? String(outcome.error) : ''}`);
    assert.deepEqual(outcome.value, [], 'absent report stays open without a retained confirmation');
    assert.deepEqual(f.observations, [{ runner, timeouts: f.selected.timeouts }], 'confirmation must receive the selected runner budget without defaults or double extraction');
    assert.equal(f.completedReads, 1, 'real report confirmation must validate the budget and inspect the report');
    assert.ok(f.confReads > 0, 'reconciliation must load the runner protocol from conf');
    assert.equal(f.sessions.get(f.pending.runId)?.result, undefined, 'an absent report cannot produce a result');
  });

  test(`worker: ${runner} pending report confirmation uses transitionMs and pollMs from its full configured protocol`, async t => {
    const f = fixture(t, runner, 'worker');
    const error = await runProductionWorker({ execute: async () => { throw new Error('Unit worker must not invoke external commands'); } }).then(() => undefined, caught => caught);
    assert.equal(error, f.stopAfterHealth, 'worker must reach the controlled cutoff before any native launch');
    assert.equal(f.healthFailure, f.reportBoundary, `Worker report confirmation must accept the configured budget: ${String(f.healthFailure)}`);
    assert.deepEqual(f.observations, [{ runner, timeouts: f.selected.timeouts }], 'worker session tools must preserve both configured report budget fields');
    assert.equal(f.completedReads, 1, 'real report confirmation must validate the budget and inspect the report');
    assert.ok(f.confReads > 0, 'worker must load the runner protocol from conf');
    assert.equal(f.closed, 1, 'unit worker must close its store after the controlled cutoff');
    assert.equal(f.released, 1, 'unit worker must release its generation lease');
  });
}
