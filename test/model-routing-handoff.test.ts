import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffModelRun, type ModelHandoffPorts, type ModelHandoffRequest, type ModelHandoffLaunch, type ModelHandoffReportCheck } from '../src/model-routing-handoff.ts';
import { listModelAvailability, type ModelCatalog, type RoutingSnapshot } from '../src/model-routing.ts';
import { createAppRuntime, type RuntimeConfiguration, type RuntimeServices } from '../src/app-runtime.ts';
import { execute } from '../src/cli.ts';
import type { CompiledCatalog } from '../src/catalog.ts';
import type { StateStore } from '../src/state-store.ts';
import type { ProcessObservation, SessionRecord } from '../src/session-state.ts';
import type { AssignmentSnapshot } from '../src/assignment.ts';

const at = '2031-01-01T00:00:00.000Z';
const assignment: AssignmentSnapshot = {
  root: '/fixture/orchestrator', baselineArchives: [],
  changes: [{ id: 'work', items: [{ id: '1', description: 'Already done' }, { id: '2', description: 'Remaining task' }] }],
};

function routing(): { catalog: ModelCatalog; snapshot: RoutingSnapshot } {
  return {
    catalog: {
      version: 1, runners: [{ id: 'alpha', initialEnabled: true }, { id: 'beta', initialEnabled: false }],
      models: [
        { id: 'old-model', version: '1', runner: 'alpha', effort: 'high', complexity: 'reasoning', enabled: true, quotaPool: 'old-pool' },
        { id: 'new-model', version: '2', runner: 'beta', effort: 'custom', complexity: 'reasoning', enabled: true, quotaPool: 'new-pool' },
      ],
      routing: { complexityOrder: ['reasoning'], taskClassification: {}, runnerPreferences: [], modelTransitions: [{ from: 'old-model', to: ['new-model'] }], roleModelBindings: {} },
    },
    snapshot: { runnerEnabled: { alpha: true, beta: true }, cliAvailable: { alpha: true, beta: true }, quotas: [{ runner: 'alpha', pool: 'old-pool', status: 'exhausted' }, { runner: 'beta', pool: 'new-pool', status: 'unknown' }] },
  };
}

function handoffFixture() {
  const session: SessionRecord = {
    runId: 'old-run', addressId: 'worker', revision: 2, state: 'running',
    activity: { type: 'implement', project: 'raf', features: ['work'], phase: 'implement', cwd: '/fixture/raf-develop' },
    process: { pid: 10, startedAt: at, runner: 'alpha', runnerSessionId: 'old-native', tmuxSession: 'old-pane', evidence: { runId: 'old-run' } },
    launchContext: { assignment, selection: { runner: 'alpha', model: 'old-model', effort: 'high', reason: 'configured' }, briefPath: '/fixture/old/brief.md', reportPath: '/fixture/old/worker.json' },
  };
  const request: ModelHandoffRequest = { session, signal: { runId: session.runId, observation: { status: 'limited', reason: 'Confirmed provider limit' } }, ownerAction: 'continue' };
  const state = {
    current: structuredClone(session),
    observation: { state: 'exited', observedAt: at, exitCode: 7, evidence: 'confirmed process identity exit' } as ProcessObservation,
    report: { runId: session.runId, status: 'failed', reason: 'unfinished' } as ModelHandoffReportCheck,
    finalization: { finalized: true, claimsReleased: true, reason: 'existing transaction committed' },
    currentWork: { status: 'ready', assignment: { ...assignment, changes: [{ id: 'work', items: [{ id: '2', description: 'Remaining task' }] }] }, request: { complexity: 'reasoning', role: 'implement', previousModel: 'old-model' }, evidence: ['/fixture/old/proof.json'] } as Awaited<ReturnType<ModelHandoffPorts['readCurrentWork']>>,
    routing: routing(), finalized: false, launched: false,
    blockAtReservation: null as string | null,
  };
  const events: string[] = [];
  const launches: ModelHandoffLaunch[] = [];
  const started: SessionRecord[] = [];
  const ports: ModelHandoffPorts = {
    currentSession: async () => { events.push('current'); return structuredClone(state.current); },
    inspect: async () => { events.push('inspect'); return state.observation; },
    checkFinalReport: async () => { events.push('report'); return state.report; },
    finalize: async () => {
      events.push('finalize');
      if (state.finalization.finalized && state.finalization.claimsReleased) state.finalized = true;
      return state.finalization;
    },
    readCurrentWork: async () => { events.push('work'); return structuredClone(state.currentWork); },
    readRouting: async () => { events.push('routing'); return structuredClone(state.routing); },
    launchNew: async input => {
      events.push('launch');
      assert.equal(state.finalized, true, 'existing lifecycle must finalize and release claims before new agent-run');
      launches.push(structuredClone(input));
      if (state.launched || state.blockAtReservation) return { status: 'blocked', reason: state.blockAtReservation ?? 'predecessor already handed off' };
      state.launched = true;
      const next: SessionRecord = {
        ...structuredClone(session), runId: 'new-run', revision: 1,
        process: { pid: 20, startedAt: '2031-01-01T00:01:00.000Z', runner: input.selection.runner, runnerSessionId: 'new-native', tmuxSession: 'new-pane', evidence: { runId: 'new-run' } },
        launchContext: { ...session.launchContext!, assignment: input.assignment, selection: input.selection, briefPath: '/fixture/new/brief.md', reportPath: '/fixture/new/worker.json' },
      };
      started.push(next);
      state.current = next;
      return { status: 'started', session: next };
    },
  };
  return { request, state, ports, events, launches, started };
}

test('U5 handoff waits for final report, confirmed exit and existing finalization before new agent-run', async () => {
  const f = handoffFixture();
  const before = structuredClone(f.request);
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'started');
  assert.ok(f.events.indexOf('report') < f.events.indexOf('finalize'));
  assert.ok(f.events.indexOf('inspect') < f.events.indexOf('finalize'));
  assert.ok(f.events.indexOf('finalize') < f.events.indexOf('launch'));
  assert.equal(f.started.length, 1);
  assert.deepEqual(f.request, before);
});

for (const observation of [
  { state: 'alive', observedAt: at, identity: handoffFixture().request.session.process! },
  { state: 'unknown', observedAt: at, error: 'process scan unavailable' },
] as const) {
  test(`U5 limited with ${observation.state} process keeps claims and never starts another executor`, async () => {
    const f = handoffFixture();
    f.state.observation = observation;
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, 'waiting');
    assert.ok(result.reason.trim());
    assert.equal(f.events.includes('finalize'), false);
    assert.equal(f.events.includes('launch'), false);
  });
}

test('U4 a failed scanner cannot turn a missing pane into a confirmed exit', async () => {
  const f = handoffFixture();
  f.ports.inspect = async () => { throw new Error('capture/display/process scan failed'); };
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'waiting');
  assert.match(result.reason, /scan|capture|display/i);
  assert.equal(f.state.finalized, false);
  assert.deepEqual(f.started, []);
});

for (const status of ['pending', 'wrong-run'] as const) {
  test(`U5 ${status} final report cannot authorize finalization or a successor`, async () => {
    const f = handoffFixture();
    if (status === 'pending') f.state.report.status = 'pending';
    else f.state.report.runId = 'unrelated-run';
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, 'waiting');
    assert.equal(f.state.finalized, false);
    assert.deepEqual(f.started, []);
  });
}

for (const pending of ['finalization', 'claims'] as const) {
  test(`U5 incomplete ${pending} blocks transfer without retrying launch`, async () => {
    const f = handoffFixture();
    f.state.finalization = { finalized: pending !== 'finalization', claimsReleased: false, reason: 'existing transaction unfinished' };
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, 'waiting');
    assert.match(result.reason, /unfinished/);
    assert.deepEqual(f.started, []);
  });
}

test('U5 a finalization exception preserves the failure and prevents partial handoff', async () => {
  const f = handoffFixture();
  f.ports.finalize = async () => { throw new Error('SQLite transaction busy'); };
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'waiting');
  assert.match(result.reason, /busy/i);
  assert.equal(f.events.includes('launch'), false);
});

test('U5 concurrent observers through the same atomic agent-run port create one successor', async () => {
  const f = handoffFixture();
  let inspected = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.ports.inspect = async () => { if (++inspected === 2) release(); await barrier; return f.state.observation; };
  const results = await Promise.all([handoffModelRun(f.request, f.ports), handoffModelRun(f.request, f.ports)]);
  assert.equal(f.started.length, 1);
  assert.equal(results.filter(result => result.status === 'started').length, 1);
});

for (const ownerAction of ['paused', 'stopped'] as const) {
  test(`U6 owner ${ownerAction} cannot be bypassed by automatic handoff`, async () => {
    const f = handoffFixture();
    f.request.ownerAction = ownerAction;
    const result = await handoffModelRun(f.request, f.ports);
    assert.notEqual(result.status, 'started');
    assert.ok(result.reason.trim());
    assert.deepEqual(f.started, []);
    assert.equal(f.events.includes('launch'), false);
  });
}

test('U6 accepted succeeded survives nonzero exit and does not repeat completed tasks', async () => {
  const f = handoffFixture();
  f.state.report.status = 'succeeded';
  f.request.session.result = { status: 'succeeded', response: 'done', proof: { accepted: true } };
  const before = structuredClone(f.request.session.result);
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'complete');
  assert.equal(f.events.includes('report'), true);
  assert.deepEqual(f.started, []);
  assert.deepEqual(f.request.session.result, before);
});

for (const reportStatus of ['failed', 'missing', 'rejected'] as const) {
  test(`U6 ${reportStatus} hands off only current unfinished items and evidence with fresh identities`, async () => {
    const f = handoffFixture();
    f.state.report.status = reportStatus;
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, 'started');
    assert.equal(f.launches.length, 1);
    const launch = f.launches[0];
    assert.deepEqual(launch.assignment, f.state.currentWork.status === 'ready' ? f.state.currentWork.assignment : null);
    assert.deepEqual(launch.evidence, ['/fixture/old/proof.json']);
    assert.equal(launch.predecessorRunId, 'old-run');
    assert.deepEqual(launch.selection, { status: 'selected', runner: 'beta', model: 'new-model', effort: 'custom', quota: 'unknown', reason: launch.selection.reason });
    assert.ok(launch.selection.reason.trim());
    assert.equal('resume' in launch, false);
    assert.equal('history' in launch, false);
    if (result.status !== 'started') return;
    assert.notEqual(result.session.runId, f.request.session.runId);
    assert.notEqual(result.session.process?.runnerSessionId, f.request.session.process?.runnerSessionId);
    assert.notEqual(result.session.launchContext?.reportPath, f.request.session.launchContext?.reportPath);
    assert.deepEqual(f.request.session.launchContext?.assignment, assignment);
    assert.equal(f.request.session.result?.status === 'succeeded', false);
  });
}

test('U6 no remaining work after OpenSpec recheck starts no executor', async () => {
  const f = handoffFixture();
  if (f.state.currentWork.status === 'ready') f.state.currentWork.assignment = { ...assignment, changes: [] };
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'complete');
  assert.deepEqual(f.started, []);
});

test('U5 changed OpenSpec source is waiting, never a partial assignment launch', async () => {
  const f = handoffFixture();
  f.state.currentWork = { status: 'changed', reason: 'OpenSpec description mismatch' };
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'waiting');
  assert.match(result.reason, /mismatch/);
  assert.deepEqual(f.started, []);
});

for (const reason of ['task claimed by another executor', 'runner disabled before reservation', 'OpenSpec changed before reservation']) {
  test(`U5 atomic agent-run refusal: ${reason}`, async () => {
    const f = handoffFixture();
    f.state.blockAtReservation = reason;
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, 'waiting');
    assert.match(result.reason, new RegExp(reason));
    assert.deepEqual(f.started, []);
  });
}

test('U2 handoff rereads changed policy and runner switches after finalization', async () => {
  const f = handoffFixture();
  const finalize = f.ports.finalize;
  f.ports.finalize = async session => {
    const result = await finalize(session);
    f.state.routing.snapshot.runnerEnabled.beta = false;
    return result;
  };
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'waiting');
  assert.ok(result.reason.trim());
  assert.deepEqual(f.started, []);
  assert.ok(f.events.indexOf('routing') > f.events.indexOf('finalize'));
});

for (const observation of [
  { status: 'limited', reason: 'pool limit confirmed' },
  { status: 'limited', reason: 'known pool limit', quotaPool: 'old-pool', retryAt: '2031-01-02T00:00:00.000Z' },
  { status: 'failed', reason: 'authorization failed; unknown screen' },
  { status: 'exited', exitCode: null },
] as const) {
  test(`U4 ${observation.status} ${'quotaPool' in observation ? 'known pool' : 'unknown pool'} preserves known facts and does not manufacture quota, reset or success`, async () => {
    const f = handoffFixture();
    f.request.signal.observation = observation;
    const before = structuredClone(f.state.routing);
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, 'started');
    assert.deepEqual(f.launches[0].cause, observation);
    assert.deepEqual(f.state.routing, before);
    assert.equal(f.state.report.status, 'failed');
    assert.equal('retryAt' in f.launches[0].cause, 'retryAt' in observation);
  });
}

for (const observation of [{ status: 'limited', reason: 'old limit' }, { status: 'exited', exitCode: 2 }] as const) {
  test(`U4 delayed ${observation.status} from a reused address cannot affect the new run`, async () => {
    const f = handoffFixture();
    f.request.signal = { runId: 'stale-run', observation };
    const before = structuredClone(f.state);
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, 'ignored');
    assert.deepEqual(f.state, before);
    assert.equal(f.events.includes('finalize'), false);
    assert.deepEqual(f.started, []);
  });
}

test('U4 a stale session snapshot cannot hand off the current owner at the same address', async () => {
  const f = handoffFixture();
  f.state.current.runId = 'replacement-run';
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'ignored');
  assert.equal(f.events.includes('inspect'), false);
  assert.deepEqual(f.started, []);
});

for (const observation of [
  { status: 'starting' },
  { status: 'ready', cliSessionId: null, nativeIdentity: { state: 'pending', id: null, reason: 'awaiting own SessionStart' } },
] as const) {
  test(`U4 ${observation.status} including agy identity pending does not authorize transfer or invent identity`, async () => {
    const f = handoffFixture();
    f.request.signal.observation = observation;
    f.request.session.process!.runner = 'agy';
    f.request.session.process!.runnerSessionId = null;
    const before = structuredClone(f.request);
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, 'ignored');
    assert.deepEqual(f.request, before);
    assert.deepEqual(f.started, []);
    assert.equal(f.events.includes('finalize'), false);
  });
}

for (const retrySafe of [false, true]) {
  test(`U5 pre-session limit with cleanup retrySafe=${retrySafe} obeys confirmed cleanup`, async () => {
    const f = handoffFixture();
    delete f.request.session.process;
    f.request.session.state = 'reserved';
    f.state.current = structuredClone(f.request.session);
    f.request.startupCleanup = { retrySafe, pending: retrySafe ? [] : ['process exit unverified'] };
    f.ports.inspect = async () => { assert.fail('no CLI process exists after confirmed startup cleanup'); };
    const result = await handoffModelRun(f.request, f.ports);
    assert.equal(result.status, retrySafe ? 'started' : 'waiting');
    assert.equal(f.started.length, retrySafe ? 1 : 0);
  });
}

test('U5 retrySafe alone cannot bypass pending cleanup effects', async () => {
  const f = handoffFixture();
  delete f.request.session.process;
  f.request.session.state = 'reserved';
  f.state.current = structuredClone(f.request.session);
  f.request.startupCleanup = { retrySafe: true, pending: ['claim not released'] };
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'waiting');
  assert.deepEqual(f.started, []);
});

test('U5 absent process without startup cleanup proof cannot authorize another launch', async () => {
  const f = handoffFixture();
  delete f.request.session.process;
  f.request.session.state = 'reserved';
  f.state.current = structuredClone(f.request.session);
  const result = await handoffModelRun(f.request, f.ports);
  assert.equal(result.status, 'waiting');
  assert.deepEqual(f.started, []);
});

function switchFixture() {
  const r = routing();
  const saved = new Map<string, boolean>();
  const writes: { runner: string; enabled: boolean }[] = [];
  let caller: unknown = { verifiedRunId: 'main-run' };
  let authorized = true;
  let probes = 0;
  let stops = 0;
  const commands: CompiledCatalog = {
    reportStatuses: [],
    commands: ['enable', 'disable', 'list'].map(action => ({
      path: ['runner', action], handlerName: `runner ${action}`, metadata: {}, valueSources: {},
      parameters: action === 'list' ? [] : [{ name: 'runner', option: '--runner', type: 'string', required: true, multiple: false, values: r.catalog.runners.map(row => ({ id: row.id })) }],
    })),
  };
  const store = {
    initializeRunners: (entries: ModelCatalog['runners']) => { for (const row of entries) if (!saved.has(row.id)) saved.set(row.id, row.initialEnabled); },
    setRunnerEnabled: (runner: string, enabled: boolean) => { writes.push({ runner, enabled }); saved.set(runner, enabled); },
    getRunnerEnabled: (runner: string) => saved.get(runner),
    close: () => {},
  } as unknown as StateStore;
  const services = {
    authorizeMain: async (received: unknown) => { assert.equal(received, caller); if (!authorized) throw new Error('main authority required'); },
    routingSnapshot: async () => ({ ...r.snapshot, runnerEnabled: Object.fromEntries(saved) }),
    listModels: listModelAvailability,
    collectQuotas: async () => { probes++; assert.fail('list/selection must read cached quota only'); },
    control: { close: async () => { stops++; assert.fail('runner switch cannot stop live agents'); }, interrupt: async () => { stops++; assert.fail('runner switch cannot interrupt live agents'); } },
  } as unknown as RuntimeServices;
  const config: RuntimeConfiguration = { catalog: commands, models: r.catalog, commandTiming: { emaAlpha: 0.1, sqliteOnlyMeanBudgetMs: 1000 } };
  const open = () => createAppRuntime({
    orchestratorRoot: '/fixture/orchestrator', confRoot: '/fixture/conf', artifactPath: '/fixture/catalog', statePath: '/fixture/state', tmpRoot: '/fixture/tmp', mode: 'test', commandStartedAtMs: 0, commandTimingOwner: 'production', resolveCaller: async () => caller,
  }, {
    loadConfiguration: async () => structuredClone(config), openStore: async () => store, createServices: async () => services,
    nextRunIdentity: () => { assert.fail('switch/list cannot start a new session'); }, now: () => 0,
  });
  return { r, saved, writes, commands, open, counters: () => ({ probes, stops }), rejectCaller: () => { authorized = false; caller = { verifiedRunId: 'worker-run', claimedId: 'main' }; } };
}

test('U3 saved runner switches survive new runtime and changed initialEnabled without stopping live sessions', async () => {
  const f = switchFixture();
  let runtime = f.open();
  const command = async (action: string) => execute(['runner', action, '--runner', 'beta'], f.commands, runtime.handlers);
  assert.equal((await command('enable')).exitCode, 0);
  assert.equal((await command('enable')).exitCode, 0);
  assert.equal(f.saved.get('beta'), true);
  f.r.catalog.runners.find(row => row.id === 'beta')!.initialEnabled = false;
  await runtime.close();
  runtime = f.open();
  const list = await execute(['runner', 'list'], f.commands, runtime.handlers);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.equal(f.saved.get('beta'), true);
  assert.equal(JSON.parse(list.stdout).find((row: { model: string }) => row.model === 'new-model').enabled, true);
  assert.equal((await command('disable')).exitCode, 0);
  await runtime.close();
  f.r.catalog.runners.find(row => row.id === 'beta')!.initialEnabled = true;
  runtime = f.open();
  await execute(['runner', 'list'], f.commands, runtime.handlers);
  assert.equal(f.saved.get('beta'), false);
  assert.equal(f.saved.size, 2);
  assert.deepEqual(f.counters(), { probes: 0, stops: 0 });
  await runtime.close();
});

test('U3 one runner enable preserves catalog-disabled models and initializes only missing switches', async () => {
  const f = switchFixture();
  f.r.catalog.models.push({ ...f.r.catalog.models[1], id: 'catalog-disabled', enabled: false });
  f.saved.set('alpha', false);
  const runtime = f.open();
  const enable = await execute(['runner', 'enable', '--runner', 'beta'], f.commands, runtime.handlers);
  assert.equal(enable.exitCode, 0, enable.stderr);
  assert.deepEqual(JSON.parse(enable.stdout), { runner: 'beta', enabled: true });
  const result = await execute(['runner', 'list'], f.commands, runtime.handlers);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.find((row: { model: string }) => row.model === 'new-model').available, true);
  assert.equal(rows.find((row: { model: string }) => row.model === 'catalog-disabled').available, false);
  assert.equal(f.saved.get('alpha'), false);
  assert.deepEqual(f.counters(), { probes: 0, stops: 0 });
  await runtime.close();
});

for (const action of ['enable', 'disable']) {
  test(`U3 unauthorized ${action} cannot write runner state even when caller claims main`, async () => {
    const f = switchFixture();
    f.saved.set('alpha', true);
    f.saved.set('beta', false);
    f.rejectCaller();
    const before = [...f.saved];
    const runtime = f.open();
    const result = await execute(['runner', action, '--runner', 'beta'], f.commands, runtime.handlers);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /main authority/);
    assert.deepEqual(f.writes, []);
    assert.deepEqual([...f.saved], before);
    assert.deepEqual(f.counters(), { probes: 0, stops: 0 });
    await runtime.close();
  });
  for (const args of [[], ['--runner', 'missing'], ['--runner', 'beta', '--runner', 'beta']]) {
    test(`U3 invalid ${action} arguments ${JSON.stringify(args)} do not write state`, async () => {
      const f = switchFixture();
      const runtime = f.open();
      const result = await execute(['runner', action, ...args], f.commands, runtime.handlers);
      assert.notEqual(result.exitCode, 0);
      assert.ok(JSON.parse(result.stderr).code);
      assert.deepEqual(f.writes, []);
      assert.equal(f.saved.size, 0);
      assert.deepEqual(f.counters(), { probes: 0, stops: 0 });
      await runtime.close();
    });
  }
}
