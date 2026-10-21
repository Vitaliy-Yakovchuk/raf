import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppRuntime, type RuntimeContext, type RuntimeConfiguration, type RuntimeServices, type AppRuntimeDependencies } from '../src/app-runtime.ts';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import { runCli } from '../src/bootstrap.ts';
import { commandFailure } from '../src/cli-contract.ts';
import type { StateStore } from '../src/state-store.ts';
import type { ModelCatalog, ModelSelection } from '../src/model-routing.ts';
import type { SessionRecord, ProcessIdentity } from '../src/session-state.ts';

const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models: ModelCatalog = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const owned = ['agent run', 'agent ps', 'agent update', 'agent message', 'agent close', 'agent interrupt', 'runner list', 'runner enable', 'runner disable', 'command stats'];
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')));
const params = { id: 'worker', type: 'implement', project: 'raf', features: ['runtime'], phase: 'implement', complexity: models.routing.complexityOrder[0], tasks: ['change-a:1.1', 'change-b:2.1', 'change-a:1.2'] };
const identity: ProcessIdentity = { pid: 301, startedAt: '2026-10-22T12:00:00Z', runner: 'codex', runnerSessionId: 'cli-1', tmuxSession: 'raf-safe-1', evidence: { runId: 'run-1', source: 'verified-agent' } };
const selected: ModelSelection = { status: 'selected', runner: 'codex', model: 'chosen-model', effort: 'chosen-effort', reason: 'owner selection', quota: 'unknown' };
const assignment = { root: '/sandbox/orchestrator', changes: [{ id: 'change-a', items: [{ id: '1.1', description: 'First' }, { id: '1.2', description: 'Second' }] }, { id: 'change-b', items: [{ id: '2.1', description: 'Third' }] }], baselineArchives: [] };
const session: SessionRecord = { runId: 'run-1', addressId: 'worker', revision: 2, state: 'running', process: identity, activity: { type: 'implement', project: 'raf', features: ['runtime'], phase: 'implement', cwd: '/sandbox/raf-develop' }, observation: { state: 'alive', observedAt: identity.startedAt, identity } };

function fixture() {
  const events: string[] = [];
  const calls = new Map<string, unknown[][]>();
  const note = (name: string, ...args: unknown[]) => { events.push(name); calls.set(name, [...(calls.get(name) ?? []), args]); };
  let clock = 100;
  const switches = new Map<string, boolean>();
  const context: RuntimeContext = { orchestratorRoot: '/sandbox/orchestrator', confRoot: '/sandbox/orchestrator/conf', artifactPath: '/sandbox/catalog.json', statePath: '/sandbox/state.sqlite', tmpRoot: '/sandbox/tmp', mode: 'test', commandStartedAtMs: 10, resolveCaller: async () => { note('caller'); return { verifiedRun: 'main-1' }; } };
  const config: RuntimeConfiguration = { catalog, models, commandTiming: { emaAlpha: 0.37 } };
  const store: StateStore = {
    sessionRepository: { transaction: () => { throw new Error('Runtime must use owner ports'); } },
    reminderRepository: { transaction: () => { throw new Error('Runtime must use owner ports'); } },
    close: () => note('store.close'),
    getRunnerEnabled: id => { note('getRunnerEnabled', id); return switches.get(id); },
    initializeRunners: entries => { note('initialize', entries); for (const entry of entries) if (!switches.has(entry.id)) switches.set(entry.id, entry.initialEnabled); },
    setRunnerEnabled: (id, enabled) => { note('setRunnerEnabled', id, enabled); switches.set(id, enabled); },
    getQuota: id => { note('getQuota', id); return undefined; },
    setQuotaSnapshot: (...args) => note('unexpected.quotaProbe', ...args),
    recordQuotaError: (...args) => note('unexpected.quotaProbe', ...args),
    recordCommandDuration: (...args) => note('duration', ...args),
    getCommandTiming: name => { note('timing', name); return name === 'agent ps' ? { averageMs: 23, updatedAt: identity.startedAt } : undefined; },
  };
  const reportWrapper = { wrap: (command: import('../src/agent-adapters.ts').AdapterCommand) => command };
  const services: RuntimeServices = {
    assignment: {
      validate: async request => { note('validate', request); return { ok: true, snapshot: assignment }; },
      compose: async (snapshot, briefContext) => { note('compose', snapshot, briefContext); return 'literal brief $(touch NEVER) `echo NEVER`\nsecond line'; },
    },
    resolveTask: async (...args) => { note('task', ...args); return { branch: 'develop', outcome: 'Wire runtime', sources: ['exact/spec.md'], writeBoundaries: ['src/runtime.ts'], requested: { ramBytes: 1024, diskBytes: { volume: 1024 } }, requiredFileSystemIds: ['volume'], reportSchema: { type: 'object' } }; },
    route: async request => { note('route', request); return { ok: true, project: 'raf', branch: 'develop', cwd: '/sandbox/raf-develop' }; },
    routingSnapshot: async () => { note('snapshot'); return { runnerEnabled: Object.fromEntries(switches), cliAvailable: { codex: true }, quotas: [{ runner: 'codex', pool: 'default', status: 'unknown' }] }; },
    selectModel: (...args) => { note('select', ...args); return selected; },
    listModels: (...args) => { note('listModels', ...args); return [{ runner: 'codex', model: 'chosen-model', effort: 'chosen-effort', configuredComplexity: params.complexity, supportedComplexities: [params.complexity], enabled: true, available: true, quota: 'unknown', reasons: ['quota unknown'] }]; },
    prepareReport: async launch => { note('prepare', launch); return { reportPath: '/sandbox/tmp/run-1/raf-safe-1.json', reportWrapper, cleanupUnstarted: async () => { note('cleanup'); } }; },
    reserve: async input => { note('reserve', input); return { admitted: true }; },
    adapter: { start: async request => { note('start', request); return { tmuxSession: request.tmuxSession, selection: request.selection }; } },
    verifyStarted: async (...args) => { note('verify', ...args); return identity; },
    commitStarted: async (...args) => { note('commit', ...args); return true; },
    compensate: async (...args) => { note('compensate', ...args); return { stopped: true }; },
    abortLaunch: async (...args) => { note('abort', ...args); },
    authorizeMain: async caller => { note('authorize', caller); },
    control: {
      ps: async () => { note('ps'); return [session]; },
      update: async (...args) => { note('update', ...args); return session; },
      message: async (...args) => { note('message', ...args); return { accepted: true, receiptId: 'receipt-1' }; },
      close: async (...args) => { note('close', ...args); return { closed: false, unfinished: [] }; },
      interrupt: async (...args) => { note('interrupt', ...args); },
    },
  };
  let next = 0;
  const additionalHandlers = Object.fromEntries(catalog.commands.filter(command => command.handlerName !== 'help' && !owned.includes(command.handlerName)).map(command => [command.handlerName, async (input: Record<string, unknown>) => { note('extra', command.handlerName, input); return { status: 'delegated' }; }]));
  additionalHandlers['secrets import-conductor'] = async input => {
    note('secrets.import', input);
    throw commandFailure({ code: 'COMMAND_UNAVAILABLE', message: 'Secrets import service is unavailable in this fixture', stage: 'dispatch', source: 'secrets', sourceCode: null, reason: 'Service implementation was not supplied', received: null, expected: 'Configured secrets import service', found: null, completed: [], pending: ['import'], retrySafe: true, remediation: ['Configure the secrets import service'] });
  };
  const deps: AppRuntimeDependencies = {
    loadConfiguration: async input => { note('load', input); return config; },
    openStore: async path => { note('open', path); return store; },
    createServices: async (...args) => { note('services', ...args); return services; },
    nextRunIdentity: () => { note('identity'); next++; return { runId: `run-${next}`, tmuxSession: `raf-safe-${next}` }; },
    now: () => clock,
    additionalHandlers,
  };
  return { context, config, store, services, deps, switches, events, calls, note, reportWrapper, setClock: (value: number) => { clock = value; }, runtime: () => createAppRuntime(context, deps) };
}

const count = (f: ReturnType<typeof fixture>, name: string) => f.calls.get(name)?.length ?? 0;
const call = (f: ReturnType<typeof fixture>, name: string) => f.calls.get(name)?.[0];
const noLaunch = (f: ReturnType<typeof fixture>) => { assert.equal(count(f, 'reserve'), 0); assert.equal(count(f, 'start'), 0); };

async function run(f: ReturnType<typeof fixture>, patch: Record<string, unknown> = {}) {
  return f.runtime().handlers['agent run']({ ...params, ...patch });
}

test('registry is lazy and binds catalog handler names including delegated commands', async () => {
  const f = fixture();
  const app = f.runtime();
  assert.deepEqual(Object.keys(app.handlers).sort(), catalog.commands.map(command => command.handlerName).filter(name => name !== 'help').sort());
  assert.deepEqual(f.events, []);
  await app.close();
  assert.deepEqual(f.events, []);
});

test('bootstrap help and invalid arguments never initialize runtime dependencies', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'raf-runtime-'));
  const path = join(dir, 'catalog.json');
  writeFileSync(path, JSON.stringify(catalog));
  try {
    const app = f.runtime();
    assert.equal((await runCli(['agent', 'run', '--help'], path, app.handlers)).exitCode, 0);
    assert.notEqual((await runCli(['agent', 'run', '--unknown'], path, app.handlers)).exitCode, 0);
    assert.deepEqual(f.events, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run groups normalized task pairs once and resolves branch from task context', async () => {
  const f = fixture();
  await run(f);
  assert.deepEqual(call(f, 'validate'), [{ root: f.context.orchestratorRoot, selections: [{ change: 'change-a', items: [{ id: '1.1' }, { id: '1.2' }] }, { change: 'change-b', items: [{ id: '2.1' }] }] }]);
  assert.deepEqual(call(f, 'route'), [{ root: f.context.orchestratorRoot, project: 'raf', branch: 'develop' }]);
  assert.deepEqual(f.events.filter(name => ['validate', 'task', 'route', 'select', 'prepare', 'compose', 'reserve', 'start', 'verify', 'commit'].includes(name)), ['validate', 'task', 'route', 'select', 'prepare', 'compose', 'reserve', 'start', 'verify', 'commit']);
});

for (const tasks of [['change-a:1.1', 'missing-colon'], ['change-a:'], [':1.1'], ['change-a:1.1:extra']]) {
  test(`malformed assignment rejects whole launch: ${tasks.join(' ')}`, async () => {
    const f = fixture();
    await assert.rejects(() => run(f, { tasks }));
    noLaunch(f);
  });
}

test('invalid item in any change prevents all launch effects', async () => {
  const f = fixture();
  f.services.assignment.validate = async () => ({ ok: false, kind: 'invalid-assignment', root: assignment.root, issues: [{ change: 'change-b', requestedItems: ['2.1'], reason: 'missing item', foundItems: [], archives: [], remedy: 'choose actual item' }] });
  await assert.rejects(() => run(f), /change-b|missing item/);
  noLaunch(f);
  assert.equal(count(f, 'prepare'), 0);
});

for (const stage of ['task', 'route', 'select', 'compose'] as const) {
  test(`${stage} failure stops before reservation and spawn`, async () => {
    const f = fixture();
    const fail = () => { throw new Error(`${stage} unavailable`); };
    if (stage === 'task') f.services.resolveTask = fail;
    if (stage === 'route') f.services.route = async () => ({ ok: false, error: { code: 'BRANCH_MISMATCH', message: 'route unavailable' } });
    if (stage === 'select') f.services.selectModel = fail;
    if (stage === 'compose') f.services.assignment.compose = fail;
    await assert.rejects(() => run(f), new RegExp(`${stage} unavailable`));
    noLaunch(f);
    if (stage === 'compose') assert.equal(count(f, 'cleanup'), 1);
  });
}

test('waiting model is a failed launch with owner reason, never running', async () => {
  const f = fixture();
  f.services.selectModel = () => ({ status: 'waiting', code: 'NO_SUITABLE_CAPACITY', reason: 'quota exhausted' });
  await assert.rejects(() => run(f), /quota exhausted/);
  noLaunch(f);
});

test('selected model, literal brief, child paths and immutable assignment reach owners unchanged', async () => {
  const f = fixture();
  const result = await run(f);
  const launch = call(f, 'prepare')?.[0] as Record<string, unknown>;
  assert.equal(launch.statePath, f.context.statePath);
  assert.equal(launch.tmpRoot, f.context.tmpRoot);
  assert.deepEqual(launch.assignment, assignment);
  assert.deepEqual(launch.selection, selected);
  const brief = call(f, 'compose')?.[1] as Record<string, unknown>;
  assert.equal(brief.briefsRoot, '/sandbox/orchestrator/conf/briefs');
  assert.equal(brief.runner, 'codex');
  assert.equal(brief.stage, 'implement');
  assert.deepEqual(brief.sources, ['exact/spec.md']);
  assert.deepEqual(brief.writeBoundaries, ['src/runtime.ts']);
  assert.deepEqual(brief.reportSchema, { type: 'object' });
  assert.equal(brief.reportPath, '/sandbox/tmp/run-1/raf-safe-1.json');
  assert.deepEqual(call(f, 'start'), [{ selection: { runner: 'codex', model: 'chosen-model', effort: 'chosen-effort' }, tmuxSession: 'raf-safe-1', cwd: '/sandbox/raf-develop', brief: 'literal brief $(touch NEVER) `echo NEVER`\nsecond line', reportWrapper: f.reportWrapper }]);
  assert.deepEqual(call(f, 'commit'), ['run-1', identity]);
  assert.ok(JSON.stringify(result).includes('unknown'));
  assert.equal(count(f, 'cleanup'), 0);
});

test('admission denial does not spawn and disposes only unstarted report context', async () => {
  const f = fixture();
  f.services.reserve = async input => { f.note('reserve', input); return { admitted: false, reason: 'address reserved' }; };
  await assert.rejects(() => run(f), /address reserved/);
  assert.equal(count(f, 'start'), 0);
  assert.equal(count(f, 'abort'), 0);
  assert.equal(count(f, 'cleanup'), 1);
});

test('concurrent launches submit address and resources to the same atomic reservation owner', async () => {
  const f = fixture();
  let reserved = false;
  f.services.reserve = async input => { f.note('reserve', input); if (reserved) return { admitted: false, reason: 'address reserved' }; reserved = true; return { admitted: true }; };
  const results = await Promise.allSettled([run(f), run(f)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(count(f, 'reserve'), 2);
  assert.equal(count(f, 'start'), 1);
  for (const [input] of f.calls.get('reserve')!) {
    assert.equal((input as Record<string, unknown>).addressId, params.id);
    assert.deepEqual((input as Record<string, unknown>).requested, { ramBytes: 1024, diskBytes: { volume: 1024 } });
  }
});

for (const stage of ['start', 'verify', 'commit'] as const) {
  test(`${stage} failure confirms own process stopped before abort and cleanup`, async () => {
    const f = fixture();
    if (stage === 'start') f.services.adapter.start = async () => { f.note('start'); throw new Error('launch failed'); };
    if (stage === 'verify') f.services.verifyStarted = async () => { f.note('verify'); throw new Error('launch failed: shell PID'); };
    if (stage === 'commit') f.services.commitStarted = async () => { f.note('commit'); return false; };
    await assert.rejects(() => run(f));
    const effects = f.events.filter(event => ['compensate', 'abort', 'cleanup'].includes(event));
    assert.deepEqual(effects, ['compensate', 'abort', 'cleanup']);
    if (stage !== 'commit') assert.equal(count(f, 'commit'), 0);
  });
}

test('unconfirmed process cleanup retains reservation and report context for recovery', async () => {
  const f = fixture();
  f.services.commitStarted = async () => false;
  f.services.compensate = async () => ({ stopped: false, reason: 'scan unavailable' });
  await assert.rejects(() => run(f), /run-1/);
  assert.equal(count(f, 'abort'), 0);
  assert.equal(count(f, 'cleanup'), 0);
});

test('compensation error cannot replace primary startup failure or release reservation', async () => {
  const f = fixture();
  f.services.adapter.start = async () => { throw new Error('primary launch failure'); };
  f.services.compensate = async () => { throw new Error('secondary scan failure'); };
  await assert.rejects(() => run(f), /primary launch failure/);
  assert.equal(count(f, 'abort'), 0);
  assert.equal(count(f, 'cleanup'), 0);
});

test('ps delegates reconciliation instead of reading stale repository records', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime().handlers['agent ps']({}), [session]);
  assert.equal(count(f, 'ps'), 1);
});

test('update passes only provided activity fields and trusted caller to atomic owner', async () => {
  const f = fixture();
  await f.runtime().handlers['agent update']({ id: 'worker', phase: 'qa' });
  assert.deepEqual(call(f, 'update'), ['worker', { phase: 'qa' }, { verifiedRun: 'main-1' }]);
  assert.equal(count(f, 'start'), 0);
});

test('message preserves literal text and uses trusted caller rather than supplied identity', async () => {
  const f = fixture();
  const text = '$(touch NEVER) `echo NEVER`\nsecond line';
  assert.deepEqual(await f.runtime().handlers['agent message']({ to: 'worker', text, caller: 'main' }), { accepted: true, receiptId: 'receipt-1' });
  assert.deepEqual(call(f, 'message'), [{ to: 'worker', text }, { verifiedRun: 'main-1' }]);
});

test('negative delivery receipt is not a successful command', async () => {
  const f = fixture();
  f.services.control.message = async () => ({ accepted: false, reason: 'desktop main transport unverified' });
  const result = await execute(['agent', 'message', '--to', 'main', '--text', 'hello'], catalog, f.runtime().handlers);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /desktop main transport unverified/);
});

test('close denial and interrupt are separate owner operations with caller verification', async () => {
  const f = fixture();
  const app = f.runtime();
  const reminder = { id: 'reminder-open', createdFor: 'worker', assignedTo: 'worker', text: 'Complete assigned work', at: identity.startedAt, binding: null, state: 'active' as const, closedAt: null, closeReason: null };
  f.services.control.close = async (...args) => { f.note('close', ...args); return { closed: false, unfinished: [reminder] }; };
  const denied = await execute(['agent', 'close', '--id', 'worker'], catalog, app.handlers);
  assert.notEqual(denied.exitCode, 0);
  const diagnostic = JSON.parse(denied.stderr);
  assert.equal(typeof diagnostic.code, 'string');
  assert.match(JSON.stringify(diagnostic), /reminder-open/);
  assert.match(JSON.stringify(diagnostic), /Complete assigned work/);
  assert.deepEqual(await app.handlers['agent ps']({}), [session]);
  assert.equal(session.state, 'running');
  assert.equal(reminder.state, 'active');
  await app.handlers['agent interrupt']({ id: 'worker' });
  assert.deepEqual(call(f, 'close'), ['worker', { verifiedRun: 'main-1' }]);
  assert.deepEqual(call(f, 'interrupt'), ['worker', { verifiedRun: 'main-1' }]);
  assert.equal(count(f, 'compensate'), 0);
  assert.equal(count(f, 'abort'), 0);
});

for (const command of ['runner enable', 'runner disable']) {
  test(`${command} rejects unverified main before mutating switches`, async () => {
    const f = fixture();
    f.services.authorizeMain = async () => { throw new Error('main authority unverified'); };
    await assert.rejects(async () => f.runtime().handlers[command]({ runner: models.runners[0].id, caller: 'main' }), /authority unverified/);
    assert.equal(count(f, 'setRunnerEnabled'), 0);
  });
  test(`${command} mutates persisted switch without controlling active agents`, async () => {
    const f = fixture();
    await f.runtime().handlers[command]({ runner: models.runners[0].id });
    assert.deepEqual(call(f, 'setRunnerEnabled'), [models.runners[0].id, command === 'runner enable']);
    assert.ok(f.events.indexOf('authorize') < f.events.indexOf('setRunnerEnabled'));
    for (const action of ['start', 'interrupt', 'close', 'compensate']) assert.equal(count(f, action), 0);
  });
}

test('runner list preserves saved switches and unknown quota without probing', async () => {
  const f = fixture();
  f.switches.set(models.runners[0].id, false);
  const result = await f.runtime().handlers['runner list']({});
  assert.equal(f.switches.get(models.runners[0].id), false);
  assert.equal(count(f, 'listModels'), 1);
  assert.equal(count(f, 'unexpected.quotaProbe'), 0);
  assert.equal(count(f, 'start'), 0);
  assert.match(JSON.stringify(result), /unknown/);
});

test('command stats reads canonical command paths and does not invent zero measurements', async () => {
  const f = fixture();
  const result = await f.runtime().handlers['command stats']({});
  const names = f.calls.get('timing')!.map(args => args[0]);
  assert.deepEqual(new Set(names), new Set(catalog.commands.map(command => command.path.join(' ')).filter(name => name !== 'help')));
  assert.ok(!JSON.stringify(result).includes('"averageMs":0'));
  assert.match(JSON.stringify(result), /23/);
});

test('duration includes configuration and open from entry timestamp with configured alpha', async () => {
  const f = fixture();
  f.services.control.ps = async () => { f.setClock(260); return []; };
  const app = f.runtime();
  await app.handlers['agent ps']({});
  assert.deepEqual(call(f, 'duration'), ['agent ps', 250, 0.37]);
  assert.equal(count(f, 'duration'), 1);
  assert.deepEqual(call(f, 'open'), [f.context.statePath]);
  assert.equal(call(f, 'services')?.[0], f.store);
  await app.close();
  await app.close();
  assert.equal(count(f, 'store.close'), 1);
});

test('resource wait delegated handler never contributes duration statistics', async () => {
  const f = fixture();
  await f.runtime().handlers['resource wait']({ level: 'normal' });
  assert.deepEqual(call(f, 'extra'), ['resource wait', { level: 'normal' }]);
  assert.equal(count(f, 'duration'), 0);
});

test('timing write failure preserves structured operation error and redacts secrets', async () => {
  const f = fixture();
  f.store.recordCommandDuration = () => { throw new Error('timing unavailable'); };
  f.services.control.ps = async () => { throw commandFailure({ code: 'SCAN_UNAVAILABLE', message: 'scan token=private', stage: 'reconcile', source: 'identity', sourceCode: 'EACCES', reason: 'denied', received: null, expected: 'verified process', found: null, completed: ['loaded'], pending: ['scan'], retrySafe: true, remediation: ['fix scanner'], secrets: ['private'] }); };
  const result = await execute(['agent', 'ps'], catalog, f.runtime().handlers);
  assert.notEqual(result.exitCode, 0);
  for (const value of ['SCAN_UNAVAILABLE', 'reconcile', 'identity', 'EACCES', 'loaded', 'scan']) assert.ok(result.stderr.includes(value));
  assert.ok(!result.stderr.includes('private'));
  assert.ok(!result.stderr.includes('timing unavailable'));
});

test('unavailable explicit state path is never replaced by working home database', async () => {
  const f = fixture();
  f.deps.openStore = async path => { f.note('open', path); throw new Error('state permission denied'); };
  await assert.rejects(async () => f.runtime().handlers['agent ps']({}), /state permission denied/);
  assert.deepEqual(f.calls.get('open'), [[f.context.statePath]]);
  assert.equal(count(f, 'duration'), 0);
});

test('run type main is rejected by existing CLI before any runtime side effects', async () => {
  const f = fixture();
  const args = Object.entries({ ...params, type: 'main' }).flatMap(([key, value]) => [`--${key}`, Array.isArray(value) ? value.join(',') : value]);
  const result = await execute(['agent', 'run', ...args], catalog, f.runtime().handlers);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(f.events, []);
});

test('closing invocation releases shared handle while successful wrapper survives', async () => {
  const f = fixture();
  const app = f.runtime();
  await app.handlers['agent run'](params);
  await app.handlers['agent ps']({});
  await app.close();
  assert.equal(count(f, 'open'), 1);
  assert.equal(count(f, 'services'), 1);
  assert.equal(count(f, 'store.close'), 1);
  assert.equal(count(f, 'cleanup'), 0);
  assert.equal(count(f, 'compensate'), 0);
});

test('unresolved trusted caller prevents control mutation even with forged caller parameter', async () => {
  const f = fixture();
  f.context.resolveCaller = async () => { throw new Error('caller identity unavailable'); };
  const app = f.runtime();
  for (const command of ['agent update', 'agent close', 'agent interrupt', 'agent message']) {
    await assert.rejects(async () => app.handlers[command]({ id: 'worker', to: 'worker', text: 'hello', phase: 'qa', caller: 'main' }), /caller identity unavailable/);
  }
  for (const effect of ['update', 'close', 'interrupt', 'message']) assert.equal(count(f, effect), 0);
});

test('unknown reconciliation evidence is preserved and not relabeled confirmed alive', async () => {
  const f = fixture();
  const unknown: SessionRecord = { ...session, observation: { state: 'unknown', observedAt: identity.startedAt, error: 'scanner unavailable' } };
  f.services.control.ps = async () => [unknown];
  assert.deepEqual(await f.runtime().handlers['agent ps']({}), [unknown]);
});

test('failed preflight cleanup does not replace original brief failure', async () => {
  const f = fixture();
  f.services.prepareReport = async () => ({ reportPath: '/sandbox/tmp/run-1/raf-safe-1.json', reportWrapper: f.reportWrapper, cleanupUnstarted: async () => { throw new Error('secondary cleanup failure'); } });
  f.services.assignment.compose = async () => { throw new Error('primary template failure'); };
  await assert.rejects(() => run(f), /primary template failure/);
  noLaunch(f);
});


test('approved secrets command delegates to explicit service and preserves unavailable failure', async () => {
  const f = fixture();
  const app = f.runtime();
  assert.equal(typeof app.handlers['secrets import-conductor'], 'function');
  const result = await execute(['secrets', 'import-conductor', '--file', '/sandbox/synthetic-secrets.json'], catalog, app.handlers);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stderr).code, 'COMMAND_UNAVAILABLE');
  assert.match(result.stderr, /Secrets import service is unavailable in this fixture/);
  assert.deepEqual(call(f, 'secrets.import'), [{ file: '/sandbox/synthetic-secrets.json' }]);
  assert.equal(count(f, 'start'), 0);
});
