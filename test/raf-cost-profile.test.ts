import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import {
  aggregateRafCostSample, createRafCostProfiler, withRafCostProfile,
  type RafCostKey, type RafCostRow, type RafCostSample, type RafCostProfilePorts,
  type RafCostProfileState, type RafCostProfileSnapshot,
} from '../src/raf-cost-profile.ts';
import { createAppRuntime, type AppRuntimeDependencies, type RuntimeConfiguration, type RuntimeContext } from '../src/app-runtime.ts';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import { failureContext } from '../src/cli.ts';
import type { StateStore } from '../src/state-store.ts';

const epoch = '2026-10-24T10:00:00.000Z';
const later = '2026-10-24T10:00:01.000Z';
const readAt = '2026-10-24T11:00:00.000Z';
const cpuSource = 'process.cpuUsage';
const helperSource = 'os-child-accounting';
const stages = ['startup/config', 'sqlite-open', 'sqlite-wait', 'reconcile', 'handler', 'child-wait', 'finalize', 'bug-sync', 'resource-queue', 'resource-wait', 'prepare', 'deliver', 'runner-observe', 'runner-wait', 'complete', 'shared-work'];

function sample(patch: Partial<RafCostSample> = {}): RafCostSample {
  return {
    scope: 'command', command: 'agent ps', stage: 'handler', executor: 'self',
    startedAt: epoch, completedAt: later, wallMs: 100,
    cpu: { userMs: 3, systemMs: 2, source: cpuSource, unavailableReason: null }, ...patch,
  };
}

function fixture() {
  const rows = new Map<string, RafCostRow>();
  const writes: RafCostKey[] = [];
  let mono = 0;
  let utc = epoch;
  let userMicros = 0;
  let systemMicros = 0;
  let writeError: Error | undefined;
  let clockReads = 0;
  const ports: RafCostProfilePorts = {
    repository: {
      update(key, change) {
        if (writeError) throw writeError;
        writes.push(structuredClone(key));
        const id = JSON.stringify([key.scope, key.command, key.stage, key.executor]);
        rows.set(id, change(rows.get(id)));
      },
      readRows: () => structuredClone([...rows.values()]),
    },
    monotonicMs: () => { clockReads++; return mono; },
    utcNow: () => { clockReads++; return utc; },
    cpuUsage: () => { clockReads++; return { userMicros, systemMicros }; },
    policy: { schemaVersion: 1, stages, commands: ['agent ps', 'command stats', 'test run', 'agent run'] },
  };
  return {
    ports, rows, writes,
    advance(wall: number, user: number, system: number, at = later) { mono += wall; userMicros += user; systemMicros += system; utc = at; },
    failWrites(error: Error) { writeError = error; },
    clockReads: () => clockReads,
    profiler(scope: RafCostKey['scope'] = 'command', command: string | null = scope === 'command' ? 'agent ps' : null) {
      return createRafCostProfiler({ scope, command }, ports);
    },
  };
}

test('profile: aggregate exposes ms totals, arithmetic means and completed UTC boundaries', () => {
  const first = aggregateRafCostSample(undefined, sample());
  const row = aggregateRafCostSample(first, sample({ startedAt: later, completedAt: readAt, wallMs: 20, cpu: { userMs: 1, systemMs: 0, source: cpuSource, unavailableReason: null } }));
  assert.deepEqual(row, {
    scope: 'command', command: 'agent ps', stage: 'handler', executor: 'self',
    samples: 2, firstSampleStartedAt: epoch, updatedAt: readAt,
    wallTotalMs: 120, wallMeanMs: 60, cpuSamples: 2, cpuUnavailableSamples: 0,
    cpuUserTotalMs: 4, cpuSystemTotalMs: 2, cpuUserMeanMs: 2, cpuSystemMeanMs: 1,
    cpuSource, cpuAvailability: 'complete', unavailableReason: null,
  });
  assert.equal(first.samples, 1, 'a snapshot already returned to a reader must not mutate');
});

test('profile: unavailable CPU is null with a reason, never wall time or invented zero', () => {
  const row = aggregateRafCostSample(undefined, sample({ executor: 'child', wallMs: 9000, cpu: { userMs: null, systemMs: null, source: null, unavailableReason: 'OS child counters unavailable' } }));
  assert.equal(row.samples, 1);
  assert.equal(row.wallTotalMs, 9000);
  assert.equal(row.cpuSamples, 0);
  assert.equal(row.cpuUnavailableSamples, 1);
  for (const field of ['cpuUserTotalMs', 'cpuSystemTotalMs', 'cpuUserMeanMs', 'cpuSystemMeanMs'] as const) assert.equal(row[field], null);
  assert.equal(row.cpuAvailability, 'unavailable');
  assert.equal(row.unavailableReason, 'OS child counters unavailable');
});

for (const unavailableFirst of [true, false]) test(`profile: partial CPU uses cpuSamples as denominator, unavailableFirst=${unavailableFirst}`, () => {
  const missing = sample({ cpu: { userMs: null, systemMs: null, source: null, unavailableReason: 'unsupported' } });
  const measured = sample();
  const ordered = unavailableFirst ? [missing, measured] : [measured, missing];
  const row = ordered.reduce<RafCostRow | undefined>((previous, next) => aggregateRafCostSample(previous, next), undefined)!;
  assert.equal(row.samples, 2);
  assert.equal(row.cpuSamples, 1);
  assert.equal(row.cpuUnavailableSamples, 1);
  assert.equal(row.cpuSamples + row.cpuUnavailableSamples, row.samples);
  assert.equal(row.cpuUserMeanMs, 3);
  assert.equal(row.cpuSystemMeanMs, 2);
  assert.equal(row.cpuAvailability, 'partial');
  assert.equal(row.unavailableReason, 'unsupported');
});

test('profile: measured zero is complete and distinct from unavailable; mixed sources remain visible', () => {
  const first = aggregateRafCostSample(undefined, sample({ cpu: { userMs: 0, systemMs: 0, source: 'source-a', unavailableReason: null } }));
  assert.equal(first.cpuAvailability, 'complete');
  assert.equal(first.cpuUserMeanMs, 0);
  const row = aggregateRafCostSample(first, sample({ cpu: { userMs: 1, systemMs: 2, source: 'source-b', unavailableReason: null } }));
  assert.deepEqual(new Set(row.cpuSource as string[]), new Set(['source-a', 'source-b']));
});

test('profile: contribution order does not lose earliest start or latest completed measurement', () => {
  const newer = aggregateRafCostSample(undefined, sample({ startedAt: later, completedAt: readAt }));
  const row = aggregateRafCostSample(newer, sample());
  assert.equal(row.firstSampleStartedAt, epoch);
  assert.equal(row.updatedAt, readAt);
  assert.equal(row.samples, 2);
});

test('profile: self CPU uses process counter deltas in ms and wall uses the monotonic clock', () => {
  const f = fixture();
  f.advance(0, 100000, 200000);
  const p = f.profiler();
  p.start('startup/config');
  f.advance(125, 2500, 750, '2026-10-24T09:59:00.000Z');
  p.finish();
  const [row] = p.snapshot().rows;
  assert.equal(row.wallTotalMs, 125, 'a UTC clock adjustment must not alter elapsed wall');
  assert.equal(row.cpuUserTotalMs, 2.5);
  assert.equal(row.cpuSystemTotalMs, 0.75);
  assert.equal(row.cpuSource, cpuSource);
  assert.equal(row.cpuAvailability, 'complete');
});

test('profile: exclusive transitions partition self CPU including shared async work', () => {
  const f = fixture();
  const p = f.profiler();
  p.start('handler');
  f.advance(10, 1000, 2000);
  p.transition('shared-work');
  f.advance(40, 3000, 4000);
  p.transition('finalize');
  f.advance(5, 500, 100);
  p.finish();
  const rows = p.snapshot().rows;
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((sum, row) => sum + row.wallTotalMs, 0), 55);
  assert.equal(rows.reduce((sum, row) => sum + row.cpuUserTotalMs!, 0), 4.5);
  assert.equal(rows.reduce((sum, row) => sum + row.cpuSystemTotalMs!, 0), 6.1);
  assert.equal(rows.find(row => row.stage === 'shared-work')?.samples, 1);
});

test('profile: nested helper is separate child CPU and does not inflate the self wall or CPU', () => {
  const f = fixture();
  const p = f.profiler();
  p.start('child-wait');
  f.advance(100, 1000, 500);
  p.recordChild({ stage: 'child-wait', startedAt: epoch, completedAt: later, wallMs: 80, cpu: { userMs: 30, systemMs: 10, source: helperSource, unavailableReason: null } }, 'helper');
  p.finish();
  const rows = p.snapshot().rows;
  assert.equal(rows.length, 2);
  const self = rows.find(row => row.executor === 'self')!;
  const child = rows.find(row => row.executor === 'child')!;
  assert.equal(self.wallTotalMs, 100);
  assert.equal(self.cpuUserTotalMs, 1);
  assert.equal(self.cpuSystemTotalMs, 0.5);
  assert.equal(child.wallTotalMs, 80);
  assert.equal(child.cpuUserTotalMs, 30);
  assert.equal(child.cpuSystemTotalMs, 10);
  assert.equal(child.cpuSource, helperSource);
});

for (const ownership of ['raf', 'payload'] as const) test(`profile: ${ownership} child CPU is not attributed to the parent`, () => {
  const f = fixture();
  const p = f.profiler('worker');
  p.start('runner-wait');
  f.advance(60000, 1000, 0);
  p.recordChild({ stage: 'runner-wait', startedAt: epoch, completedAt: later, wallMs: 60000, cpu: { userMs: 50000, systemMs: 5000, source: helperSource, unavailableReason: null } }, ownership);
  p.finish();
  const rows = p.snapshot().rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].executor, 'self');
  assert.equal(rows[0].wallTotalMs, 60000);
  assert.equal(rows[0].cpuUserTotalMs, 1);
});

test('profile: unavailable helper CPU remains an unavailable child row', () => {
  const f = fixture();
  const p = f.profiler();
  p.recordChild({ stage: 'child-wait', startedAt: epoch, completedAt: later, wallMs: 40, cpu: { userMs: null, systemMs: null, source: null, unavailableReason: 'unsupported OS' } }, 'helper');
  const [row] = p.snapshot().rows;
  assert.equal(row.executor, 'child');
  assert.equal(row.wallTotalMs, 40);
  assert.equal(row.cpuUserTotalMs, null);
  assert.equal(row.cpuAvailability, 'unavailable');
});

for (const [scope, applicable] of [
  ['command', ['startup/config', 'sqlite-open', 'sqlite-wait', 'reconcile', 'handler', 'child-wait', 'finalize']],
  ['service', ['bug-sync', 'resource-queue', 'resource-wait']],
  ['worker', ['prepare', 'deliver', 'runner-observe', 'runner-wait', 'complete']],
] as const) test(`profile: ${scope} exposes completed applicable stages independently`, () => {
  const f = fixture();
  const p = f.profiler(scope);
  p.start(applicable[0]);
  for (let index = 0; index < applicable.length; index++) {
    f.advance(100, 1000, 500);
    if (index + 1 < applicable.length) p.transition(applicable[index + 1]);
    else p.finish();
  }
  const rows = p.snapshot().rows;
  assert.deepEqual(new Set(rows.map(row => row.stage)), new Set(applicable));
  assert.ok(rows.every(row => row.scope === scope && row.command === (scope === 'command' ? 'agent ps' : null)));
});

test('profile: interleaved processes update the shared aggregate atomically, with process wall rather than calendar duration', async () => {
  const storage = fixture();
  const processA = fixture();
  const processB = fixture();
  processA.ports.repository = storage.ports.repository;
  processB.ports.repository = storage.ports.repository;
  const a = processA.profiler('worker');
  const b = processB.profiler('worker');
  a.start('runner-observe');
  b.start('runner-observe');
  processA.advance(100, 2000, 1000);
  processB.advance(100, 3000, 500);
  await Promise.all([Promise.resolve().then(() => a.finish()), Promise.resolve().then(() => b.finish())]);
  assert.equal(storage.rows.size, 1);
  assert.equal(storage.writes.length, 2, 'each sample is one atomic repository update');
  const [row] = a.snapshot().rows;
  assert.equal(row.samples, 2);
  assert.equal(row.wallTotalMs, 200, 'two overlapping 100ms process intervals sum to 200ms');
  assert.equal(row.wallMeanMs, 100);
  assert.equal(row.cpuUserTotalMs, 5);
  assert.equal(row.cpuSystemTotalMs, 1.5);
});

test('profile: long-lived worker flushes at existing transition and never invents unfinished wait', () => {
  const f = fixture();
  const p = f.profiler('worker');
  p.start('runner-observe');
  f.advance(10, 1000, 0);
  p.transition('runner-wait');
  assert.equal(f.writes.length, 1);
  f.advance(3600000, 0, 0, readAt);
  const snapshot = p.snapshot();
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].stage, 'runner-observe');
  assert.equal(snapshot.rows[0].updatedAt, later);
  assert.equal(snapshot.readAt, readAt);
  assert.equal(snapshot.rows[0].wallTotalMs, 10);
  assert.equal(f.writes.length, 1, 'reading must not finalize an active interval');
});

test('profile: crash and restart preserve completed aggregates without a fabricated final sample', () => {
  const f = fixture();
  const crashed = f.profiler('worker');
  crashed.start('prepare');
  f.advance(10, 1000, 500);
  crashed.transition('runner-wait');
  f.advance(999999, 0, 0, readAt);
  const restarted = f.profiler('worker');
  const before = restarted.snapshot();
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].samples, 1);
  assert.equal(before.rows[0].updatedAt, later);
  restarted.start('prepare');
  f.advance(20, 2000, 500, readAt);
  restarted.finish();
  restarted.finish();
  const [row] = restarted.snapshot().rows;
  assert.equal(row.samples, 2, 'finish is idempotent');
  assert.equal(row.wallTotalMs, 30);
  assert.equal(row.firstSampleStartedAt, epoch);
  assert.equal(row.updatedAt, readAt);
});

test('profile: aggregation discards args, PID, addresses, run IDs, pane text and secrets', () => {
  const dirty = { ...sample(), args: ['--token', 'SECRET_SENTINEL'], pid: 777, addressId: 'worker-address', runId: 'unique-run', brief: 'SECRET_SENTINEL', pane: 'SECRET_SENTINEL' };
  const row = aggregateRafCostSample(undefined, dirty);
  for (const field of ['args', 'pid', 'addressId', 'runId', 'brief', 'pane']) assert.equal(Object.hasOwn(row, field), false);
  assert.equal(JSON.stringify(row).includes('SECRET_SENTINEL'), false);
  const f = fixture();
  for (let index = 0; index < 12; index++) {
    const p = createRafCostProfiler({ scope: 'worker', command: null, runId: `run-${index}` } as Pick<RafCostKey, 'scope' | 'command'>, f.ports);
    p.start('prepare');
    f.advance(1, 1000, 0);
    p.finish();
  }
  assert.equal(f.rows.size, 1);
  assert.deepEqual(f.writes[0], { scope: 'worker', command: null, stage: 'prepare', executor: 'self' });
  assert.equal([...f.rows.values()][0].samples, 12);
});

test('profile: unknown stages and noncanonical commands cannot create unbounded keys', () => {
  const f = fixture();
  assert.throws(() => createRafCostProfiler({ scope: 'command', command: 'agent ps --id secret' }, f.ports), /command/i);
  assert.throws(() => createRafCostProfiler({ scope: 'worker', command: 'agent ps' }, f.ports), /command/i);
  const p = f.profiler();
  assert.throws(() => p.start('pane:SECRET_SENTINEL'), /stage/i);
  assert.equal(f.rows.size, 0);
});

test('profile: invalid metrics cannot corrupt totals or mix aggregate keys', () => {
  for (const wallMs of [-1, NaN, Infinity]) assert.throws(() => aggregateRafCostSample(undefined, sample({ wallMs })));
  assert.throws(() => aggregateRafCostSample(undefined, sample({ cpu: { userMs: -1, systemMs: 0, source: cpuSource, unavailableReason: null } })));
  const previous = aggregateRafCostSample(undefined, sample());
  assert.throws(() => aggregateRafCostSample(previous, sample({ scope: 'worker', command: null })));
});

test('profile: measurement does not install timers or spawn profilers and only samples on explicit work boundaries', async t => {
  const timers: string[] = [];
  t.mock.method(globalThis, 'setInterval', () => { timers.push('interval'); throw new Error('profile polling forbidden'); });
  t.mock.method(globalThis, 'setTimeout', () => { timers.push('timeout'); throw new Error('profile timer forbidden'); });
  const childProcess = await import('node:child_process');
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    t.mock.method(childProcess.default, method, () => { timers.push(method); throw new Error('per-measurement profiler spawn forbidden'); });
  }
  const nodeTimers = await import('node:timers');
  for (const method of ['setInterval', 'setTimeout'] as const) {
    t.mock.method(nodeTimers.default, method, () => { timers.push(method); throw new Error('profile polling forbidden'); });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const f = fixture();
  const p = f.profiler('worker');
  assert.equal(f.writes.length, 0);
  p.start('runner-wait');
  const reads = f.clockReads();
  await Promise.resolve();
  assert.equal(f.clockReads(), reads, 'idle microtasks do not trigger measurement');
  f.advance(1000, 1000, 0);
  p.transition('runner-observe');
  p.finish();
  p.snapshot();
  assert.deepEqual(timers, []);
});

test('profile: storage failure is explicit and cannot produce fabricated success', async () => {
  const storageError = new Error('SQLite write failed');
  const reported: unknown[][] = [];
  const f = fixture();
  const p = f.profiler();
  f.failWrites(storageError);
  await assert.rejects(withRafCostProfile(p, 'handler', async () => { f.advance(10, 1000, 0); return 'result'; }, (...args) => reported.push(args)), error => error === storageError);
  assert.equal(f.rows.size, 0);
});

test('profile: storage finalization reports its failure while preserving the original runtime error', async () => {
  const runtimeError = new Error('original delivery failure');
  const storageError = new Error('SQLite busy/write failure');
  const reported: unknown[][] = [];
  const f = fixture();
  const p = f.profiler();
  f.failWrites(storageError);
  await assert.rejects(withRafCostProfile(p, 'handler', async () => { f.advance(10, 1000, 0); throw runtimeError; }, (...args) => reported.push(args)), error => error === runtimeError);
  assert.deepEqual(reported, [[storageError, runtimeError]]);
  assert.equal(f.rows.size, 0);
});

test('profile: successful and failed handlers preserve result/error while publishing completed measurements', async () => {
  const f = fixture();
  const p = f.profiler();
  const value = { accepted: true, addressId: 'stable-address' };
  const reports: unknown[] = [];
  assert.equal(await withRafCostProfile(p, 'handler', async () => { f.advance(10, 1000, 0); return value; }, error => reports.push(error)), value);
  const error = new Error('runtime denied');
  await assert.rejects(withRafCostProfile(f.profiler(), 'handler', async () => { f.advance(20, 2000, 0); throw error; }, error => reports.push(error)), actual => actual === error);
  assert.equal(p.snapshot().rows[0].samples, 2);
  assert.deepEqual(reports, []);
});

function statsFixture(rows: RafCostRow[] = []) {
  const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
  const projects = JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
  const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects);
  const calls: string[] = [];
  const timings = new Map([['agent ps', { averageMs: 23.25, updatedAt: epoch }]]);
  const timingPolicy = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8')).commandTiming;
  const config: RuntimeConfiguration = { catalog, models, commandTiming: timingPolicy };
  const profile: RafCostProfileSnapshot = { schemaVersion: 1, readAt, rows };
  const state = {
    initializeRunners: () => calls.push('initialize'),
    getCommandTiming: (command: string) => timings.get(command),
    recordCommandDuration: (command: string, duration: number) => { calls.push(`timing:${command}`); timings.set(command, { averageMs: duration, updatedAt: readAt }); },
    readCostProfile: () => { calls.push('read-profile'); return structuredClone(profile); },
    close: () => calls.push('close'),
  } as unknown as StateStore & RafCostProfileState;
  const context: RuntimeContext = { orchestratorRoot: '/unit/orchestrator', confRoot: '/unit/orchestrator/conf', artifactPath: '/unit/catalog.json', statePath: '/unit/state.sqlite', tmpRoot: '/unit/tmp', mode: 'test', commandStartedAtMs: 100, resolveCaller: async () => { calls.push('caller'); return null; } };
  const deps: AppRuntimeDependencies = {
    loadConfiguration: async () => { calls.push('configuration'); return config; },
    openStore: async path => { calls.push(`open:${path}`); return state; },
    createServices: async () => { calls.push('service-start'); throw new Error('command stats must not start service/worker/profiler'); },
    nextRunIdentity: () => { throw new Error('stats must not launch'); }, now: () => 150,
  };
  return { catalog, calls, deps, context, profile, timingPolicy, app: createAppRuntime(context, deps) };
}

test('profile: existing command stats without flags returns commands/profile, preserving EMA independently', async () => {
  const f = statsFixture();
  const startedAt = Date.now();
  const result = await execute(['command', 'stats'], f.catalog, f.app.handlers);
  const finishedAt = Date.now();
  await f.app.close();
  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(Array.isArray(body), false, 'stats changes from array to commands/profile object');
  assert.ok(Array.isArray(body.commands));
  assert.deepEqual(Object.keys(body).sort(), ['commands', 'health', 'profile']);
  assert.ok(Date.parse(body.health.readAt) >= startedAt && Date.parse(body.health.readAt) <= finishedAt);
  assert.deepEqual(body.health, { readAt: body.health.readAt, since: null,
    error: { code: 'CONFIGURATION_INVALID', pointer: 'conf/raf.json#/health/summaryIntervalMs' },
    unavailableReason: 'Invalid conf/raf.json#/health/summaryIntervalMs',
    cpu: { availability: 'unavailable', reason: 'Health CPU is unavailable', startedAt: null, completedAt: body.health.readAt,
      wallMs: null, cpuUserMs: null, cpuSystemMs: null, cores: null, thresholdCores: null, exceeded: false, sources: [], scopes: null, error: null },
    forcedClose: { value: null, availability: 'unavailable', reason: 'Forced close accounting is unavailable' },
    summary: { startedAt: null, completedAt: null, dueAt: null, delivery: null, delayed: false } });
  const ps = body.commands.find((row: { command: string }) => row.command === 'agent ps');
  assert.equal(ps.command, 'agent ps');
  assert.equal(ps.averageMs, 23.25);
  assert.equal(ps.updatedAt, epoch);
  assert.equal(ps.budgetMs, null, 'external process reconciliation has no invented fixed budget');
  assert.equal(body.commands.find((row: { command: string }) => row.command === 'command stats').budgetMs, f.timingPolicy.sqliteOnlyMeanBudgetMs);
  assert.deepEqual(body.profile, { schemaVersion: 1, readAt, rows: [] });
  assert.deepEqual(body.commands.map((row: { command: string }) => row.command).sort(), f.catalog.commands.filter(command => command.handlerName !== 'help').map(command => command.path.join(' ')).sort());
  const absent = body.commands.find((row: { command: string }) => row.command === 'agent run');
  assert.equal(absent.averageMs, null);
  assert.equal(absent.updatedAt, null);
  assert.equal(f.calls.filter(call => call.startsWith('open:')).length, 1);
  assert.equal(f.calls.includes('service-start'), false);
});

test('profile: stats keeps readAt separate from completed sample time, even with the service off', async () => {
  const stored: RafCostRow = {
    scope: 'worker', command: null, stage: 'runner-observe', executor: 'self', samples: 1,
    firstSampleStartedAt: epoch, updatedAt: later, wallTotalMs: 10, wallMeanMs: 10,
    cpuSamples: 1, cpuUnavailableSamples: 0, cpuUserTotalMs: 1, cpuSystemTotalMs: 0,
    cpuUserMeanMs: 1, cpuSystemMeanMs: 0, cpuSource, cpuAvailability: 'complete', unavailableReason: null,
  };
  const f = statsFixture([stored]);
  const result = await execute(['command', 'stats'], f.catalog, f.app.handlers);
  await f.app.close();
  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.profile?.rows, [stored]);
  assert.equal(body.profile.readAt, readAt);
  assert.equal(body.profile.rows[0].updatedAt, later);
  assert.equal(f.calls.includes('service-start'), false);
});

test('profile: current stats completion is visible to the next read, never to its own snapshot', async () => {
  const f = statsFixture();
  const first = await execute(['command', 'stats'], f.catalog, f.app.handlers);
  const second = await execute(['command', 'stats'], f.catalog, f.app.handlers);
  await f.app.close();
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  const before = JSON.parse(first.stdout);
  const after = JSON.parse(second.stdout);
  assert.ok(Array.isArray(before.commands));
  assert.equal(before.commands.find((row: { command: string }) => row.command === 'command stats').averageMs, null);
  assert.equal(after.commands.find((row: { command: string }) => row.command === 'command stats').averageMs, 50);
  assert.deepEqual(before.profile.rows, []);
});

test('profile: stats adds no public command or parameter; help/parser rejection never opens SQLite', async () => {
  const f = statsFixture();
  const stats = f.catalog.commands.find(command => command.path.join(' ') === 'command stats')!;
  assert.deepEqual(stats.parameters, []);
  assert.equal(f.catalog.commands.some(command => /profile/.test(command.path.join(' '))), false);
  const help = await execute(['command', 'stats', '--help'], f.catalog, f.app.handlers);
  const invalid = await execute(['command', 'stats', '--profile'], f.catalog, f.app.handlers);
  await f.app.close();
  assert.equal(help.exitCode, 0);
  assert.notEqual(invalid.exitCode, 0);
  assert.deepEqual(f.calls, []);
});

test('profile: stats reports unavailable primary SQLite explicitly with no fallback', async () => {
  const f = statsFixture();
  f.deps.openStore = async path => { f.calls.push(`open-failed:${path}`); throw new Error('primary SQLite unavailable'); };
  const app = createAppRuntime(f.context, f.deps);
  const result = await execute(['command', 'stats'], f.catalog, app.handlers);
  await app.close();
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /primary SQLite unavailable/);
  assert.deepEqual(f.calls.filter(call => call.startsWith('open')), ['open-failed:/unit/state.sqlite']);
  assert.equal(f.calls.includes('service-start'), false);
});

test('profile: runtime preserves the handler failure when timing storage also fails', async () => {
  const f = statsFixture();
  f.deps.openStore = async () => ({ initializeRunners() {}, recordCommandDuration() { throw new Error('storage finalization failed'); }, close() {} }) as unknown as StateStore;
  f.deps.additionalHandlers = { 'service status': async () => { throw new Error('original runtime failure'); } };
  const app = createAppRuntime(f.context, f.deps);
  await assert.rejects(app.handlers['service status']({}), error => failureContext(error)?.reason === 'original runtime failure');
  await app.close();
});
