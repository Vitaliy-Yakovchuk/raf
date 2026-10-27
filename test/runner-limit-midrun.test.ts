import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import { compileCatalog } from '../src/catalog.ts';
import { createAppRuntime } from '../src/app-runtime.ts';
import { selectModel } from '../src/model-routing.ts';
import { parseRunnerLimitScreen, poolQuotaStatus } from '../src/quota-screens.ts';
import type { RuntimeConfiguration, RuntimeContext, RuntimeServices } from '../src/app-runtime.ts';
import type { AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { ProcessIdentity, SessionRecord } from '../src/session-state.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const raf = JSON.parse(await readFile(join(root, 'conf/raf.json'), 'utf8'));
const constants = JSON.parse(await readFile(join(root, 'conf/raf-constants.json'), 'utf8'));
const models = JSON.parse(await readFile(join(root, 'conf/models.json'), 'utf8'));
const projects = JSON.parse(await readFile(join(root, 'conf/projects.json'), 'utf8'));
const runtimeUrl = new URL('../src/production-runtime.ts?runner-limit-unit', import.meta.url).href;
const osUrl = new URL('../src/os-runtime.ts', import.meta.url).href;
const availabilityUrl = new URL('../src/runner-availability.ts', import.meta.url).href;
const key = Symbol.for('raf.runner-limit.unit');
const boot = { machineId: 'limit-unit-machine', bootId: 'limit-unit-boot' };
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && specifier === './os-runtime.ts') return { url: 'limit-unit:os', shortCircuit: true };
    if (context.parentURL === runtimeUrl && specifier === './runner-availability.ts') return { url: 'limit-unit:availability', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'limit-unit:os') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(osUrl)};
      export const readMachineBootIdentity = async () => (${JSON.stringify(boot)});
      export const observeKnownProcesses = async identities => identities.map(identity => globalThis[Symbol.for('raf.runner-limit.unit')].observe(identity));
      export const observeProcessSnapshot = async () => identities => identities.map(identity => globalThis[Symbol.for('raf.runner-limit.unit')].observe(identity));
    ` };
    if (url === 'limit-unit:availability') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(availabilityUrl)};
      export const probeRunnerAvailability = async settings => ({ available: true, path: '/unit/bin/' + settings.runner, version: settings.version, warnings: [] });
    ` };
    return next(url, context);
  },
});
const { createProductionServices } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
hooks.deregister();

async function fixture(t: TestContext, screen: string, owned = true, runner: 'grok' | 'agy' = 'grok') {
  const directory = await mkdtemp(join(tmpdir(), 'raf-runner-limit-unit-'));
  const tmpRoot = join(directory, 'tmp');
  await mkdir(tmpRoot);
  const store = openStateStore(':memory:');
  t.after(async () => { store.close(); delete (globalThis as any)[key]; await rm(directory, { recursive: true, force: true }); });
  let clock = Date.parse('2026-10-27T04:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: clock });
  let alive = true;
  const identity: ProcessIdentity = { pid: 42000, startedAt: '2026-10-27T03:00:00Z', runner, runnerSessionId: '11111111-1111-4111-8111-111111111111', tmuxSession: `unit-${runner}`, evidence: { ...boot, command: `/unit/bin/${runner}`, tmuxSocket: join(directory, 'tmux.sock'), tmuxPane: '%1' } };
  (globalThis as any)[key] = { observe: (process: ProcessIdentity) => alive
    ? { state: 'alive', identity: process, observedAt: new Date().toISOString() }
    : { state: 'exited', exitCode: null, evidence: 'Unit process exited', observedAt: new Date().toISOString() } };
  const calls: string[][] = [];
  const execute: AdapterCommandExecutor = async command => {
    assert.equal(command.executable, 'tmux', 'OS and CLI discovery are injected; only the owned tmux transport is exercised');
    const args = [...command.args];
    calls.push(args);
    assert.deepEqual(args.slice(0, 3), ['-u', '-S', identity.evidence.tmuxSocket]);
    let stdout = '';
    if (args.includes('capture-pane')) stdout = screen;
    else if (args.includes('kill-session')) alive = false;
    else if (args.at(-1) === '#{pane_pid}') stdout = String(identity.pid);
    else if (args.at(-1) === '#{pane_id}') stdout = owned ? '%1' : '%2';
    else assert.fail(`Unexpected transport command: ${JSON.stringify(args)}`);
    return { exitCode: 0, stdout, stderr: '' };
  };
  const configuration: RuntimeConfiguration = {
    catalog: compileCatalog(constants, models, constants.commands.map((row: { path: string[] }) => row.path.join(' ')), projects),
    models: { ...models, routing: { ...models.routing, runnerPreferences: [{ complexity: 'ordinary', runners: [runner, ...['grok', 'codex', 'claude', 'agy'].filter(value => value !== runner)] }] } },
    commandTiming: raf.commandTiming,
  };
  const context: RuntimeContext = { orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(directory, 'catalog.json'), statePath: join(directory, 'state.sqlite'), tmpRoot, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined };
  const services = await createProductionServices(store, configuration, context, { execute, protocolSettings: raf.runnerProtocols });
  const original: SessionRecord = { runId: 'unit-run', addressId: 'unit-agent', state: 'running', revision: 1, process: identity,
    activity: { type: 'hotfix', project: 'raf', phase: 'hotfix', features: ['fix-raf-detect-runner-limit-midrun'], cwd: directory } };
  store.sessionRepository.transaction(tx => { tx.putSession(original); tx.putReservation({ runId: original.runId, resource: 'ram', amount: 1 }); });
  const current = () => store.sessionRepository.transaction(tx => tx.getSession(original.runId))!;
  const agentRunSelection = async () => {
    let selected: ReturnType<typeof selectModel> | undefined;
    const sentinel = new Error('unit selection reached');
    const appServices = { ...services,
      assignment: { validate: async () => ({ ok: true, snapshot: { root, baselineArchives: [], changes: [] } }) },
      resolveTask: async () => ({ branch: 'develop', writeBoundaries: [], sources: [], workspaceWritable: false }),
      route: async () => ({ ok: true, cwd: directory, project: 'raf', branch: 'develop' }),
      selectModel: (catalog: typeof models, snapshot: any, request: any) => { selected = selectModel(catalog, snapshot, request); throw sentinel; },
    } as unknown as RuntimeServices;
    const app = createAppRuntime(context, { loadConfiguration: async () => configuration, openStore: async () => store, createServices: async () => appServices,
      nextRunIdentity: () => ({ runId: 'next-unit-run', tmuxSession: 'next-unit-pane' }), resolveGitWriteBoundaries: async () => [], now: () => clock });
    await assert.rejects(app.handlers['agent run']({ id: 'next-agent', type: 'hotfix', project: 'raf', phase: 'hotfix', complexity: 'ordinary', features: ['fix-raf-detect-runner-limit-midrun'], tasks: ['fix-raf-detect-runner-limit-midrun:1.1'] }), error => error instanceof Error && error.message.includes(sentinel.message));
    assert.ok(selected);
    return selected;
  };
  return { store, services, current, calls, original, agentRunSelection, advance: (milliseconds = 86400000) => { clock += milliseconds; t.mock.timers.tick(milliseconds); } };
}

test('running grok weekly limit closes the agent, persists exhausted quota and excludes grok from subsequent agent run until recovery', async t => {
  const f = await fixture(t, 'You hit your weekly limit\nShift+Tab:mode');
  const before = await f.agentRunSelection();
  assert.equal(before.status === 'selected' && before.runner, 'grok');
  assert.deepEqual(await f.services.control.ps(), []);
  const closed = f.current();
  assert.equal(closed.state, 'finished');
  assert.equal(closed.result?.status, 'failed');
  assert.match(closed.abortReason ?? '', /quota exhausted/i);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 0);
  assert.ok(f.calls.some(args => args.includes('kill-session')));
  assert.equal(f.store.getRunnerEnabled('grok'), true);
  const quotas = (await f.services.routingSnapshot()).quotas.filter(row => row.runner === 'grok');
  assert.ok(quotas.length > 0);
  assert.ok(quotas.every(row => row.status === 'exhausted'), JSON.stringify(quotas));
  const next = await f.agentRunSelection();
  assert.equal(next.status, 'selected');
  assert.notEqual(next.status === 'selected' && next.runner, 'grok');
  f.advance();
  assert.ok((await f.services.routingSnapshot()).quotas.filter(row => row.runner === 'grok').every(row => row.status === 'unknown'));
  const snapshot = structuredClone(f.store.getQuota('grok')!.snapshot) as any;
  snapshot.observedAt = new Date().toISOString();
  for (const pool of snapshot.pools) for (const window of pool.windows) Object.assign(window, { used: 0.1, remaining: 0.9 });
  f.store.setQuotaSnapshot('grok', snapshot, snapshot.observedAt);
  const recovered = await f.agentRunSelection();
  assert.equal(recovered.status === 'selected' && recovered.runner, 'grok');
  assert.deepEqual(await f.services.control.ps(), []);
  assert.equal(f.calls.filter(args => args.includes('kill-session')).length, 1);
});

for (const scenario of [
  { name: 'ordinary working screen', screen: 'Working on the requested task\nShift+Tab:mode', owned: true },
  { name: 'quoted brief text', screen: '❯ Investigate «You hit your weekly limit»\nShift+Tab:mode', owned: true },
  { name: 'another pane identity', screen: 'You hit your weekly limit', owned: false },
]) {
  test(`running grok preserves the session and quota for ${scenario.name}`, async t => {
    const f = await fixture(t, scenario.screen, scenario.owned);
    const rows = await f.services.control.ps();
    assert.equal(rows.length, 1);
    assert.equal(f.current().state, 'running');
    assert.equal(f.store.getQuota('grok'), undefined);
    assert.equal(f.calls.some(args => args.includes('kill-session')), false);
  });
}

const agyLimit = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h26m57s.';
const agyFrames = [
  { name: 'experience survey', screen: `${agyLimit}\nError ID: 5c1798ad-3c7b-45d9-8740-8cf31f1aef40\nHow's the CLI experience so far?\n1: Bad  2: Fine  3: Good  0: Dismiss` },
  { name: 'empty composer', screen: `${agyLimit}\nError ID: 5c1798ad-3c7b-45d9-8740-8cf31f1aef40\n╭────────────────────╮\n│ >                  │\n╰────────────────────╯\n? for shortcuts` },
];
const agy = raf.runnerProtocols.find((row: { runner: string }) => row.runner === 'agy');
const observedAt = '2026-10-27T04:00:00.000Z';
const resetAt = '2026-10-27T07:26:57.000Z';

for (const frame of agyFrames) {
  test(`agy 1.4.7 quota frame with ${frame.name} records exhausted pools and exact reset`, () => {
    const snapshot = parseRunnerLimitScreen(agy, frame.screen, observedAt);
    assert.ok(snapshot, 'Literal agy quota warning must be recognized');
    assert.equal(snapshot.runner, 'agy');
    assert.equal(snapshot.version, '1.4.7');
    assert.equal(snapshot.reliable, true);
    assert.equal(snapshot.completeness, 'complete');
    assert.deepEqual(snapshot.pools.map(pool => pool.id).sort(), ['claude_gpt', 'gemini']);
    for (const pool of snapshot.pools) {
      assert.equal(pool.windows[0].remaining, 0);
      assert.equal(pool.windows[0].resetAt, resetAt);
      assert.equal(poolQuotaStatus(pool, { current: true, reason: 'fresh' }, '2026-10-27T07:26:56.000Z'), 'exhausted');
      assert.equal(poolQuotaStatus(pool, { current: true, reason: 'fresh' }, resetAt), 'unknown');
    }
  });

  test(`running agy quota frame with ${frame.name} closes the agent and excludes agy from subsequent agent run`, async t => {
    const f = await fixture(t, frame.screen, true, 'agy');
    const before = await f.agentRunSelection();
    assert.equal(before.status === 'selected' && before.runner, 'agy');
    assert.deepEqual(await f.services.control.ps(), []);
    assert.equal(f.current().state, 'finished');
    assert.equal(f.current().result?.status, 'failed');
    assert.match(f.current().abortReason ?? '', /quota exhausted: agy/);
    assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 0);
    assert.ok(f.calls.some(args => args.includes('kill-session')));
    const quotas = (await f.services.routingSnapshot()).quotas.filter(row => row.runner === 'agy');
    assert.ok(quotas.length > 0);
    assert.ok(quotas.every(row => row.status === 'exhausted'), JSON.stringify(quotas));
    const next = await f.agentRunSelection();
    assert.equal(next.status, 'selected');
    assert.notEqual(next.status === 'selected' && next.runner, 'agy');
    f.advance(Date.parse(resetAt) - Date.parse(observedAt));
    assert.ok((await f.services.routingSnapshot()).quotas.filter(row => row.runner === 'agy').every(row => row.status === 'unknown'));
    assert.deepEqual(await f.services.control.ps(), []);
    assert.equal(f.calls.filter(args => args.includes('kill-session')).length, 1);
  });
}

for (const scenario of [
  { name: 'ordinary working screen', screen: 'Working on the requested task\n? for shortcuts', owned: true },
  { name: 'quoted brief text', screen: `> Investigate «${agyLimit}»\n? for shortcuts`, owned: true },
  { name: 'another pane identity', screen: agyFrames[0].screen, owned: false },
]) {
  test(`running agy preserves the session and quota for ${scenario.name}`, async t => {
    const f = await fixture(t, scenario.screen, scenario.owned, 'agy');
    assert.equal((await f.services.control.ps()).length, 1);
    assert.equal(f.current().state, 'running');
    assert.equal(f.store.getQuota('agy'), undefined);
    assert.equal(f.calls.some(args => args.includes('kill-session')), false);
  });
}
