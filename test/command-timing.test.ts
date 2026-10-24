import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAppRuntime, type AppRuntimeDependencies, type RuntimeConfiguration, type RuntimeContext, type RuntimeServices } from '../src/app-runtime.ts';
import { compileCatalog } from '../src/catalog.ts';
import { execute, type ExecutionResult } from '../src/cli.ts';
import { commandFailure } from '../src/cli-contract.ts';
import type { StateStore, CommandTiming } from '../src/state-store.ts';

const conf = (name: string) => JSON.parse(readFileSync(new URL(`../../conf/${name}.json`, import.meta.url), 'utf8'));
const constants = conf('raf-constants');
const models = conf('models');
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), conf('projects'));
const completedAt = '2026-10-24T10:20:30.000Z';
type Contribution = [command: string, durationMs: number, alpha: number];
type TimingRow = { command: string; averageMs: number | null; updatedAt: string | null; budgetMs: number | null };

function fixture() {
  let monotonicMs = 10;
  const events: string[] = [];
  const contributions: Contribution[] = [];
  const opened: string[] = [];
  const timings = new Map<string, CommandTiming>();
  const config: RuntimeConfiguration = { catalog, models, commandTiming: { emaAlpha: 0.25, sqliteOnlyMeanBudgetMs: 100 } };
  const context: RuntimeContext = {
    orchestratorRoot: '/unit/orchestrator', confRoot: '/unit/orchestrator/conf', artifactPath: '/unit/catalog.json',
    statePath: '/unit/explicit-state.sqlite', tmpRoot: '/unit/tmp', mode: 'test', commandStartedAtMs: monotonicMs,
    resolveCaller: async () => ({ verified: 'unit-caller' }),
  };
  const store = {
    initializeRunners: () => { events.push('initialize'); },
    close: () => { events.push('close'); },
    recordCommandDuration: (...args: Contribution) => { events.push('write'); contributions.push(args); },
    getCommandTiming: (command: string) => { events.push(`read:${command}`); const row = timings.get(command); return row && { ...row }; },
    readCostProfile: () => ({ schemaVersion: 1, readAt: completedAt, rows: [] }),
  } as unknown as StateStore;
  const services = {
    control: {
      ps: async () => { events.push('ps'); monotonicMs += 7; return []; },
      message: async () => { events.push('message'); monotonicMs += 7; return { accepted: true, receiptId: 'unit-receipt' }; },
    },
  } as unknown as RuntimeServices;
  const deps: AppRuntimeDependencies = {
    loadConfiguration: async () => { events.push('config'); monotonicMs += 11; return config; },
    openStore: async path => { events.push('open'); opened.push(path); monotonicMs += 13; return store; },
    createServices: async () => { events.push('services'); return services; },
    nextRunIdentity: () => { throw new Error('Unexpected agent launch in timing unit test'); },
    now: () => monotonicMs,
    additionalHandlers: { 'resource wait': async () => { monotonicMs += 1000; return { granted: true }; } },
  };
  return { context, config, deps, store, services, events, contributions, opened, timings,
    advance(ms: number) { monotonicMs += ms; },
    runtime: () => createAppRuntime(context, deps),
  };
}

async function invoke(f: ReturnType<typeof fixture>, argv: readonly string[]): Promise<ExecutionResult> {
  const app = f.runtime();
  try { return await execute(argv, catalog, app.handlers); }
  finally { await app.close(); }
}

function rows(result: ExecutionResult): TimingRow[] {
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(Array.isArray(output.commands), 'Use the existing commands/profile envelope');
  return output.commands;
}

function row(result: ExecutionResult, name: string): TimingRow {
  const selected = rows(result).find(value => value.command === name);
  assert.ok(selected, `Missing canonical timing row ${name}`);
  return selected;
}

function operationFailure() {
  return commandFailure({ code: 'UNIT_OPERATION_FAILED', message: 'operation denied', stage: 'unit-operation', source: 'unit-port',
    sourceCode: 'EACCES', reason: 'operation denied', received: null, expected: null, found: null,
    completed: ['validated'], pending: ['delivery'], retrySafe: false, remediation: ['Repair unit operation'] });
}

test('U1 success records one canonical contribution including startup configuration opening and handler', async () => {
  const f = fixture();
  f.advance(5);
  const result = await invoke(f, ['agent', 'ps']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(f.contributions, [['agent ps', 36, 0.25]]);
  assert.deepEqual(f.opened, [f.context.statePath]);
  assert.deepEqual(f.events.filter(event => ['config', 'open', 'ps', 'write', 'close'].includes(event)), ['config', 'open', 'ps', 'write', 'close']);
});

test('U1 runtime failure records its actual duration and retains the operation code and context', async () => {
  const f = fixture();
  f.services.control.ps = async () => { f.advance(19); throw operationFailure(); };
  const result = await invoke(f, ['agent', 'ps']);
  assert.notEqual(result.exitCode, 0);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'UNIT_OPERATION_FAILED');
  assert.equal(error.details.sourceCode, 'EACCES');
  assert.equal(error.details.stage, 'unit-operation');
  assert.deepEqual(f.contributions, [['agent ps', 43, 0.25]]);
});

test('U2 different recipients and literal arguments share the canonical catalog key', async () => {
  const f = fixture();
  for (const [id, text] of [['worker-a', 'literal $(never-execute)'], ['worker-b', 'another payload']]) {
    const result = await invoke(f, ['agent', 'message', '--to', id, '--text', text]);
    assert.equal(result.exitCode, 0, result.stderr);
  }
  assert.equal(f.contributions.length, 2);
  assert.deepEqual(f.contributions.map(([command]) => command), ['agent message', 'agent message']);
  assert.ok(f.contributions.every(([, ms, alpha]) => Number.isFinite(ms) && ms >= 0 && alpha === 0.25));
});

test('U2 calendar correction cannot change a monotonic duration', async t => {
  const f = fixture();
  let wall = Date.parse(completedAt);
  t.mock.method(Date, 'now', () => wall);
  f.services.control.ps = async () => { wall -= 86_400_000; f.advance(9); return []; };
  const result = await invoke(f, ['agent', 'ps']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(f.contributions, [['agent ps', 33, 0.25]]);
});

test('U2 no contribution exists before finalization and close does not fabricate another', async () => {
  const f = fixture();
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.services.control.ps = async () => { entered(); await gate; return []; };
  const app = f.runtime();
  const pending = app.handlers['agent ps']({});
  try {
    await ready;
    assert.deepEqual(f.contributions, [], 'An unfinished invocation has no completed sample');
  } finally { release(); await pending; await app.close(); await app.close(); }
  assert.equal(f.contributions.length, 1);
});

test('U3 stats distinguish missing measurements from zero and preserve stored EMA and timestamp', async () => {
  const f = fixture();
  f.timings.set('agent message', { averageMs: 0, updatedAt: completedAt });
  f.timings.set('agent ps', { averageMs: 37.125, updatedAt: completedAt });
  const result = await invoke(f, ['command', 'stats']);
  assert.deepEqual(row(result, 'agent run'), { command: 'agent run', averageMs: null, updatedAt: null, budgetMs: null });
  assert.deepEqual(row(result, 'agent message'), { command: 'agent message', averageMs: 0, updatedAt: completedAt, budgetMs: null });
  assert.deepEqual(row(result, 'agent ps'), { command: 'agent ps', averageMs: 37.125, updatedAt: completedAt, budgetMs: null });
  assert.deepEqual(row(result, 'command stats'), { command: 'command stats', averageMs: null, updatedAt: null, budgetMs: 100 });
  assert.deepEqual(new Set(rows(result).map(value => value.command)), new Set(catalog.commands.filter(command => command.handlerName !== 'help').map(command => command.path.join(' '))));
  assert.equal(rows(result).length, new Set(rows(result).map(value => value.command)).size);
  assert.ok(!f.events.includes('services'), 'Reading stats must not start external services or probes');
});

test('U3 a genuinely zero monotonic duration reaches the store as zero exactly once', async () => {
  const f = fixture();
  f.deps.loadConfiguration = async () => f.config;
  f.deps.openStore = async () => f.store;
  f.services.control.ps = async () => [];
  const result = await invoke(f, ['agent', 'ps']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(f.contributions, [['agent ps', 0, 0.25]]);
});

test('U3 stats return the preceding snapshot and expose their own contribution only on the next read', async () => {
  const f = fixture();
  const original = { averageMs: 8, updatedAt: '2026-10-24T09:00:00.000Z' };
  const committed = { averageMs: 12, updatedAt: completedAt };
  f.timings.set('command stats', original);
  const record = f.store.recordCommandDuration;
  f.store.recordCommandDuration = (...args) => {
    record(...args);
    f.timings.set('command stats', { ...committed });
  };
  const first = await invoke(f, ['command', 'stats']);
  assert.deepEqual(row(first, 'command stats'), { command: 'command stats', ...original, budgetMs: 100 });
  const second = await invoke(f, ['command', 'stats']);
  assert.deepEqual(row(second, 'command stats'), { command: 'command stats', ...committed, budgetMs: 100 });
  assert.equal(f.contributions.length, 2);
  assert.ok(f.events.indexOf('read:command stats') < f.events.indexOf('write'));
});

for (const alpha of [Number.MIN_VALUE, 0.4, 1]) {
  test(`U4 valid alpha ${alpha} reaches the existing store port unchanged`, async () => {
    const f = fixture();
    f.config.commandTiming.emaAlpha = alpha;
    const result = await invoke(f, ['agent', 'ps']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(f.contributions, [['agent ps', 31, alpha]]);
  });
}

for (const [label, value] of [['missing', undefined], ['null', null], ['string', '0.25'], ['zero', 0], ['negative', -0.1], ['above-one', 1.1], ['nan', NaN], ['positive-infinity', Infinity], ['negative-infinity', -Infinity]] as const) {
  test(`U4 invalid alpha ${label} is a configuration error without a fallback contribution`, async () => {
    const f = fixture();
    (f.config.commandTiming as unknown as Record<string, unknown>).emaAlpha = value;
    const result = await invoke(f, ['agent', 'ps']);
    assert.notEqual(result.exitCode, 0, 'Invalid alpha must not be accepted by the runtime');
    assert.equal(JSON.parse(result.stderr).code, 'CONFIGURATION_INVALID');
    assert.deepEqual(f.contributions, []);
    assert.ok(!f.events.includes('ps'), 'Invalid configuration must not execute the operation');
  });
}

for (const [label, value] of [['missing', undefined], ['null', null], ['string', '100'], ['zero', 0], ['negative', -1], ['nan', NaN], ['positive-infinity', Infinity], ['negative-infinity', -Infinity]] as const) {
  test(`U4 invalid SQLite budget ${label} is explicit and has no default`, async () => {
    const f = fixture();
    (f.config.commandTiming as unknown as Record<string, unknown>).sqliteOnlyMeanBudgetMs = value;
    const result = await invoke(f, ['command', 'stats']);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stderr).code, 'CONFIGURATION_INVALID');
    assert.deepEqual(f.contributions, [], 'Invalid timing policy cannot produce a successful sample');
  });
}

for (const budget of [Number.MIN_VALUE, 0.5, 250]) {
  test(`U4 finite positive budget ${budget} is returned without rounding or a policy default`, async () => {
    const f = fixture();
    f.config.commandTiming.sqliteOnlyMeanBudgetMs = budget;
    assert.equal(row(await invoke(f, ['command', 'stats']), 'command stats').budgetMs, budget);
  });
}

test('U4 changed configuration affects the next invocation without recomputing historical EMA', async () => {
  const f = fixture();
  f.timings.set('agent ps', { averageMs: 71.5, updatedAt: completedAt });
  assert.equal((await invoke(f, ['agent', 'ps'])).exitCode, 0);
  f.config.commandTiming.emaAlpha = 0.8;
  f.config.commandTiming.sqliteOnlyMeanBudgetMs = 240;
  const result = await invoke(f, ['command', 'stats']);
  assert.deepEqual(f.contributions.map(([, , alpha]) => alpha), [0.25, 0.8]);
  assert.equal(row(result, 'command stats').budgetMs, 240);
  assert.equal(row(result, 'agent ps').averageMs, 71.5);
});

for (const [averageMs, withinBudget] of [[99, true], [100, false], [101, false]] as const) {
  test(`U5 SQLite budget boundary ${averageMs} exposes the stored mean for strict comparison`, async () => {
    const f = fixture();
    f.timings.set('command stats', { averageMs, updatedAt: completedAt });
    const actual = row(await invoke(f, ['command', 'stats']), 'command stats');
    assert.equal(actual.averageMs, averageMs, 'A fast current read must not hide the historical mean');
    assert.equal(actual.budgetMs, 100);
    assert.equal(actual.averageMs! < actual.budgetMs!, withinBudget);
  });
}

test('U5 external contracts never acquire a SQLite budget even with zero means or an early refusal', async () => {
  const f = fixture();
  for (const name of ['agent ps', 'agent message', 'agent run', 'runner limits']) f.timings.set(name, { averageMs: 0, updatedAt: completedAt });
  const refused = await invoke(f, ['agent', 'run', '--id', 'main', '--type', 'implement', '--project', 'raf', '--features', 'complete-raf-flow-contracts', '--phase', 'implement', '--complexity', models.routing.complexityOrder[0], '--tasks', 'complete-raf-flow-contracts:4.3']);
  assert.notEqual(refused.exitCode, 0);
  assert.equal(JSON.parse(refused.stderr).code, 'MAIN_NOT_LAUNCHABLE');
  const result = await invoke(f, ['command', 'stats']);
  for (const name of ['agent ps', 'agent message', 'agent run', 'runner limits']) assert.equal(row(result, name).budgetMs, null, name);
  assert.equal(f.contributions[0][0], 'agent run');
});

for (const argv of [['--help'], ['agent', 'ps', '--help'], ['not-a-command'], ['agent', 'ps', '--unknown'], ['agent', 'message']]) {
  test(`U6 parser/help ${JSON.stringify(argv)} never loads configuration opens state or writes in cleanup`, async () => {
    const f = fixture();
    f.deps.loadConfiguration = async () => { f.events.push('forbidden-config'); throw new Error('Runtime configuration unavailable'); };
    f.deps.openStore = async () => { f.events.push('forbidden-open'); throw new Error('State unavailable'); };
    const result = await invoke(f, argv);
    assert.equal(result.exitCode === 0, argv.includes('--help'));
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.contributions, []);
  });
}

test('U6 the duration exception is confined to resource wait in the approved catalog', () => {
  assert.deepEqual(catalog.commands.filter(command => command.metadata.recordDuration === false).map(command => command.path.join(' ')), ['resource wait']);
});

for (const outcome of ['success', 'error', 'cancel'] as const) {
  test(`U6 resource wait ${outcome} contributes nothing and the next agent run is measured separately`, async () => {
    const f = fixture();
    const level = catalog.commands.find(command => command.handlerName === 'resource wait')!.parameters.find(parameter => parameter.name === 'level')!.values![0].id;
    const waitCommand = catalog.commands.find(command => command.handlerName === 'resource wait')!;
    assert.equal(waitCommand.metadata.recordDuration, false, 'The catalog owns the exception');
    f.deps.additionalHandlers!['resource wait'] = async () => {
      f.advance(10_000);
      if (outcome === 'error') throw operationFailure();
      if (outcome === 'cancel') throw Object.assign(new Error('Unit wait cancelled'), { name: 'AbortError' });
      return { granted: true };
    };
    const result = await invoke(f, ['resource', 'wait', '--level', level]);
    assert.equal(result.exitCode === 0, outcome === 'success');
    assert.deepEqual(f.contributions, []);
    f.context.commandStartedAtMs = f.deps.now();
    const app = f.runtime();
    try { await assert.rejects(async () => app.handlers['agent run']({ id: 'main' })); }
    finally { await app.close(); }
    assert.deepEqual(f.contributions, [['agent run', 24, 0.25]], 'Waiting time must not leak into the subsequent run');
  });
}

test('U7 an unavailable explicit store yields failure without fallback or a fabricated sample', async () => {
  const f = fixture();
  f.deps.openStore = async path => { f.opened.push(path); throw new Error('unit state unavailable'); };
  const result = await invoke(f, ['agent', 'ps']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /unit state unavailable/);
  assert.deepEqual(f.opened, [f.context.statePath]);
  assert.deepEqual(f.contributions, []);
  assert.ok(!f.events.includes('ps'));
});

test('U7 failed timing write after success is nonzero explicit sanitized and attempted only once', async () => {
  const f = fixture();
  let attempts = 0;
  f.store.recordCommandDuration = () => { attempts++; throw new Error('timing unavailable token=unit-sensitive-token'); };
  const result = await invoke(f, ['agent', 'ps']);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /timing unavailable/);
  assert.ok(!result.stderr.includes('unit-sensitive-token'));
  assert.equal(attempts, 1);
  assert.deepEqual(f.contributions, []);
  assert.deepEqual(f.opened, [f.context.statePath]);
});

test('U7 simultaneous operation and timing failures retain the primary code and expose sanitized timing diagnostics', async () => {
  const f = fixture();
  let attempts = 0;
  f.services.control.ps = async () => { throw operationFailure(); };
  f.store.recordCommandDuration = () => { attempts++; throw new Error('timing unavailable token=unit-sensitive-token'); };
  const result = await invoke(f, ['agent', 'ps']);
  assert.notEqual(result.exitCode, 0);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'UNIT_OPERATION_FAILED');
  assert.equal(error.details.stage, 'unit-operation');
  assert.equal(error.details.sourceCode, 'EACCES');
  assert.deepEqual(error.details.completed, ['validated']);
  assert.deepEqual(error.details.pending, ['delivery']);
  assert.match(result.stderr, /timing unavailable/, 'The secondary failure must not disappear');
  assert.ok(!result.stderr.includes('unit-sensitive-token'));
  assert.equal(attempts, 1);
  assert.deepEqual(f.contributions, []);
});
