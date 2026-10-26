import { summaryCpuFixture } from './helpers/health-summary-cpu-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RafCostKey, RafCostRow } from '../src/raf-cost-profile.ts';
import {
  evaluateRafHealthCpuWindow, observeRafHealthCpu, withRafHealthCpu,
  type RafHealthCpuAssessment, type RafHealthCpuContext, type RafHealthCpuEvent,
  type RafHealthCpuPolicy, type RafHealthCpuPorts, type RafHealthCpuProfileReading,
  type RafHealthCpuState,
} from '../src/health-cpu.ts';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 24, 10) + ms).toISOString();
const policy: RafHealthCpuPolicy = { cpuWindowMs: 1000, cpuThresholdCores: 1 };
const key = (scope: RafCostKey['scope'], executor: RafCostKey['executor'] = 'self', stage = 'handler'): RafCostKey => ({
  scope, command: scope === 'command' ? 'agent ps' : null, stage, executor,
});

type Contribution = { key: RafCostKey; user: number; system: number };

function row(identity: RafCostKey, user: number, system: number, samples: number, completedAt: string): RafCostRow {
  return {
    ...identity, samples, firstSampleStartedAt: at(-100000), updatedAt: completedAt,
    wallTotalMs: samples * 10000, wallMeanMs: 10000,
    cpuSamples: samples, cpuUnavailableSamples: 0,
    cpuUserTotalMs: user, cpuSystemTotalMs: system,
    cpuUserMeanMs: user / samples, cpuSystemMeanMs: system / samples,
    cpuSource: identity.executor === 'self' ? 'process.cpuUsage' : 'os-child-accounting',
    cpuAvailability: 'complete', unavailableReason: null,
  };
}

function readings(contributions: Contribution[] = [{ key: key('command'), user: 900, system: 200 }], elapsed = 1000) {
  const make = (completed: boolean): RafHealthCpuProfileReading => ({
    profile: {
      schemaVersion: 1, readAt: at(completed ? elapsed : 0),
      rows: contributions.map(item => row(item.key, 10000 + (completed ? item.user : 0), 5000 + (completed ? item.system : 0), completed ? 101 : 100, at(completed ? elapsed : 0))),
    },
    accumulationId: 'profile-epoch-a', monotonicMs: completed ? 50000 + elapsed : 50000,
    attributions: contributions.map(item => ({ key: item.key, ownership: item.key.executor === 'self' ? 'self' : 'helper', duplicateOf: null })),
    coverage: {
      startedAt: at(completed ? 0 : -1000), completedAt: at(completed ? elapsed : 0),
      openOwnIntervals: 0, outOfWindowOwnIntervals: 0, overlappingSelfIntervals: 0,
      attributionComplete: true,
    },
  });
  return { baseline: make(false), current: make(true) };
}

function unavailable(result: RafHealthCpuAssessment, startedAt: string | null = at(0), completedAt = at(1000)) {
  assert.notEqual(result.availability, 'complete');
  assert.equal(result.startedAt, startedAt);
  assert.equal(result.completedAt, completedAt);
  assert.equal(result.cores, null);
  assert.equal(result.cpuUserMs, null);
  assert.equal(result.cpuSystemMs, null);
  assert.equal(result.exceeded, false);
  assert.ok(result.reason && result.reason.length > 0);
}

function fixture() {
  const pair = readings();
  let reading = pair.current;
  let state: RafHealthCpuState = { baseline: pair.baseline, lastAssessment: null };
  const events: RafHealthCpuEvent[] = [];
  const notices: string[] = [];
  let profileError: Error | undefined;
  let eventError: Error | undefined;
  let profileReads = 0;
  let transactions = 0;
  let tail = Promise.resolve();
  const ports: RafHealthCpuPorts = {
    async readProfile() {
      profileReads++;
      if (profileError) throw profileError;
      return structuredClone(reading);
    },
    async transaction(operation) {
      transactions++;
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(done => { release = done; });
      await previous;
      try {
        const working = structuredClone(state);
        const pending: RafHealthCpuEvent[] = [];
        const result = operation({
          state: working,
          recordEvent(event) {
            if (eventError) throw eventError;
            pending.push(structuredClone(event));
          },
        });
        state = working;
        events.push(...pending);
        return result;
      } finally {
        release();
      }
    },
    reportUnavailable(reason) { notices.push(reason); },
  };
  const context: RafHealthCpuContext = {
    rafInstanceId: 'health-domain-a', enabled: true, entry: 'runtime',
    configuration: { health: { ...policy } },
  };
  return {
    pair, ports, context, events, notices,
    state: () => structuredClone(state),
    setState(next: RafHealthCpuState) { state = structuredClone(next); },
    setReading(next: RafHealthCpuProfileReading) { reading = structuredClone(next); },
    failProfile(error?: Error) { profileError = error; },
    failEvent(error?: Error) { eventError = error; },
    reads: () => ({ profileReads, transactions }),
  };
}

for (const [cpu, exceeded] of [[999, false], [1000, false], [1001, true]] as const) {
  test(`cpu: strict threshold uses total CPU delta ${cpu}ms over 1000ms`, () => {
    const { baseline, current } = readings([{ key: key('command'), user: cpu - 100, system: 100 }]);
    const before = structuredClone({ baseline, current });
    const result = evaluateRafHealthCpuWindow(baseline, current, policy);
    assert.equal(result.availability, 'complete');
    assert.equal(result.cpuUserMs, cpu - 100);
    assert.equal(result.cpuSystemMs, 100);
    assert.equal(result.wallMs, 1000);
    assert.equal(result.cores, cpu / 1000);
    assert.equal(result.thresholdCores, 1);
    assert.equal(result.exceeded, exceeded);
    assert.equal(result.reason, null);
    assert.equal(result.error, null);
    assert.deepEqual({ baseline, current }, before, 'health must not mutate profile rows or snapshots');
  });
}

test('cpu: parallel service worker command and helper use one actual wall denominator', () => {
  const { baseline, current } = readings([
    { key: key('service', 'self', 'bug-sync'), user: 500, system: 100 },
    { key: key('worker', 'self', 'prepare'), user: 600, system: 100 },
    { key: key('command'), user: 300, system: 100 },
    { key: key('worker', 'child', 'child-wait'), user: 700, system: 100 },
  ]);
  const result = evaluateRafHealthCpuWindow(baseline, current, policy);
  assert.equal(result.cores, 2.5);
  assert.equal(result.wallMs, 1000);
  assert.deepEqual(result.scopes, {
    service: { cpuUserMs: 500, cpuSystemMs: 100 },
    worker: { cpuUserMs: 1300, cpuSystemMs: 200 },
    command: { cpuUserMs: 300, cpuSystemMs: 100 },
  });
  assert.deepEqual(new Set(result.sources), new Set(['process.cpuUsage', 'os-child-accounting']));
});

test('cpu: raf child already counted as self and duplicate helper attribution contribute once', () => {
  const worker = key('worker', 'self', 'prepare');
  const helper = key('worker', 'child', 'child-wait');
  const { baseline, current } = readings([
    { key: worker, user: 500, system: 100 },
    { key: helper, user: 200, system: 100 },
    { key: key('command', 'child', 'raf-child'), user: 500, system: 100 },
    { key: key('command', 'child', 'shared-helper'), user: 200, system: 100 },
  ]);
  for (const reading of [baseline, current]) {
    reading.attributions[2].ownership = 'raf';
    reading.attributions[2].duplicateOf = worker;
    reading.attributions[3].duplicateOf = helper;
  }
  const result = evaluateRafHealthCpuWindow(baseline, current, policy);
  assert.equal(result.availability, 'complete');
  assert.equal(result.cores, 0.9);
  assert.equal(result.exceeded, false);
});

for (const payload of ['runner/model', 'agent-code', 'test-payload']) {
  test(`cpu: ${payload} never contributes CPU or a wall denominator`, () => {
    const { baseline, current } = readings([
      { key: key('worker', 'self', 'runner-wait'), user: 20, system: 10 },
      { key: key('worker', 'child', payload), user: 1000000, system: 500000 },
    ]);
    for (const reading of [baseline, current]) reading.attributions[1].ownership = 'payload';
    const result = evaluateRafHealthCpuWindow(baseline, current, policy);
    assert.equal(result.availability, 'complete');
    assert.equal(result.cores, 0.03);
    assert.equal(result.wallMs, 1000);
    assert.equal(result.exceeded, false);
    assert.deepEqual(result.sources, ['process.cpuUsage']);
  });
}

test('cpu: exclusive stages sum CPU without treating each self stage as a second process', () => {
  const { baseline, current } = readings([
    { key: key('worker', 'self', 'prepare'), user: 400, system: 100 },
    { key: key('worker', 'self', 'deliver'), user: 300, system: 100 },
  ]);
  const result = evaluateRafHealthCpuWindow(baseline, current, policy);
  assert.equal(result.cores, 0.9);
  assert.deepEqual(result.scopes?.worker, { cpuUserMs: 700, cpuSystemMs: 200 });
});

test('cpu: actual delayed window and monotonic elapsed time replace configured duration and summed wall', () => {
  const { baseline, current } = readings([{ key: key('command'), user: 3000, system: 500 }], 2500);
  const result = evaluateRafHealthCpuWindow(baseline, current, policy);
  assert.equal(result.wallMs, 2500);
  assert.equal(result.cores, 1.4);
  assert.equal(result.startedAt, at(0));
  assert.equal(result.completedAt, at(2500));
});

test('cpu: a not-yet-due interval is unavailable rather than a short proven window', () => {
  const { baseline, current } = readings(undefined, 999);
  unavailable(evaluateRafHealthCpuWindow(baseline, current, policy), at(0), at(999));
});

test('cpu: a measured zero is complete rather than missing CPU', () => {
  const { baseline, current } = readings([{ key: key('command'), user: 0, system: 0 }]);
  const result = evaluateRafHealthCpuWindow(baseline, current, policy);
  assert.equal(result.availability, 'complete');
  assert.equal(result.cores, 0);
  assert.equal(result.cpuUserMs, 0);
  assert.equal(result.cpuSystemMs, 0);
  assert.equal(result.exceeded, false);
});

test('cpu: no initial snapshot cannot prove a zero or an exceedance', () => {
  const { current } = readings();
  unavailable(evaluateRafHealthCpuWindow(null, current, policy), null);
});

for (const availability of ['partial', 'unavailable'] as const) {
  test(`cpu: ${availability} row CPU cannot prove complete window CPU`, () => {
    const { baseline, current } = readings();
    const entry = current.profile.rows[0];
    entry.cpuAvailability = availability;
    entry.cpuUnavailableSamples = 1;
    entry.cpuSamples = 100;
    entry.unavailableReason = 'OS counters unavailable';
    if (availability === 'unavailable') {
      entry.cpuUserTotalMs = null;
      entry.cpuSystemTotalMs = null;
      entry.cpuSource = null;
    }
    unavailable(evaluateRafHealthCpuWindow(baseline, current, policy));
  });
}

for (const variant of ['no-coverage', 'open-own-interval', 'outside-window', 'overlapping-self', 'unknown-attribution', 'starts-before-window', 'ends-after-window', 'stale-coverage'] as const) {
  test(`cpu: ${variant} does not claim a complete interval from lifetime averages`, () => {
    const { baseline, current } = readings();
    if (variant === 'no-coverage') current.coverage = null;
    else {
      const coverage = current.coverage!;
      if (variant === 'open-own-interval') coverage.openOwnIntervals = 1;
      if (variant === 'outside-window') coverage.outOfWindowOwnIntervals = 1;
      if (variant === 'overlapping-self') coverage.overlappingSelfIntervals = 1;
      if (variant === 'unknown-attribution') coverage.attributionComplete = false;
      if (variant === 'starts-before-window') coverage.startedAt = at(-1);
      if (variant === 'ends-after-window') coverage.completedAt = at(1001);
      if (variant === 'stale-coverage') coverage.completedAt = at(999);
    }
    unavailable(evaluateRafHealthCpuWindow(baseline, current, policy));
  });
}

for (const variant of ['new-epoch', 'unknown-epoch', 'counter-reset', 'lost-row', 'clock-reset'] as const) {
  test(`cpu: ${variant} never joins different accumulations`, () => {
    const { baseline, current } = readings();
    if (variant === 'new-epoch') current.accumulationId = 'profile-epoch-b';
    if (variant === 'unknown-epoch') current.accumulationId = null;
    if (variant === 'counter-reset') current.profile.rows[0].cpuUserTotalMs = 1;
    if (variant === 'lost-row') current.profile.rows = [];
    if (variant === 'clock-reset') current.monotonicMs = baseline.monotonicMs - 1;
    unavailable(evaluateRafHealthCpuWindow(baseline, current, policy));
  });
}

test('cpu: empty snapshots are unavailable rather than evidence of idle raf', () => {
  const { baseline, current } = readings([]);
  unavailable(evaluateRafHealthCpuWindow(baseline, current, policy));
});

test('cpu: a new aggregate wholly inside the covered window contributes its measured totals', () => {
  const { baseline, current } = readings([{ key: key('service'), user: 100, system: 50 }]);
  const identity = key('worker', 'self', 'prepare');
  const added = row(identity, 800, 200, 1, at(1000));
  added.firstSampleStartedAt = at(200);
  current.profile.rows.push(added);
  current.attributions.push({ key: identity, ownership: 'self', duplicateOf: null });
  const result = evaluateRafHealthCpuWindow(baseline, current, policy);
  assert.equal(result.availability, 'complete');
  assert.equal(result.cores, 1.15);
});

test('cpu: historical missing samples do not invalidate a fully measured current window', () => {
  const { baseline, current } = readings();
  for (const reading of [baseline, current]) {
    const entry = reading.profile.rows[0];
    entry.cpuAvailability = 'partial';
    entry.cpuUnavailableSamples = 1;
    entry.cpuSamples--;
    entry.unavailableReason = 'historical OS counter failure';
  }
  const result = evaluateRafHealthCpuWindow(baseline, current, policy);
  assert.equal(result.availability, 'complete');
  assert.equal(result.cores, 1.1);
});

for (const value of [Number.NaN, Number.POSITIVE_INFINITY, null]) {
  test(`cpu: invalid measured counter ${String(value)} is unavailable`, () => {
    const { baseline, current } = readings();
    current.profile.rows[0].cpuUserTotalMs = value;
    unavailable(evaluateRafHealthCpuWindow(baseline, current, policy));
  });
}

test('cpu: missing ownership metadata cannot silently drop or double a contribution', () => {
  const { baseline, current } = readings();
  current.attributions = [];
  unavailable(evaluateRafHealthCpuWindow(baseline, current, policy));
});

test('cpu: CPU denominator follows monotonic wall when the UTC clock moves', () => {
  const { baseline, current } = readings();
  current.profile.readAt = at(3601000);
  current.profile.rows[0].updatedAt = at(3601000);
  current.coverage!.completedAt = at(3601000);
  const result = evaluateRafHealthCpuWindow(baseline, current, policy);
  assert.equal(result.wallMs, 1000);
  assert.equal(result.cores, 1.1);
  assert.equal(result.completedAt, at(3601000));
});

test('cpu: threshold and window come from supplied policy without a hidden default', () => {
  const { baseline, current } = readings();
  assert.equal(evaluateRafHealthCpuWindow(baseline, current, { cpuWindowMs: 1000, cpuThresholdCores: 2 }).exceeded, false);
  assert.equal(evaluateRafHealthCpuWindow(baseline, current, { cpuWindowMs: 1000, cpuThresholdCores: 0.5 }).exceeded, true);
  unavailable(evaluateRafHealthCpuWindow(baseline, current, { cpuWindowMs: 2000, cpuThresholdCores: 0.5 }));
});

test('cpu: event carries domain bounds CPU wall threshold source and all scopes', async () => {
  const f = fixture();
  const result = await observeRafHealthCpu(f.context, f.ports);
  assert.equal(result?.cores, 1.1);
  assert.deepEqual(f.events, [{
    type: 'raf.cpu-exceeded', rafInstanceId: 'health-domain-a',
    startedAt: at(0), completedAt: at(1000), wallMs: 1000,
    cpuUserMs: 900, cpuSystemMs: 200, cores: 1.1, thresholdCores: 1,
    sources: ['process.cpuUsage'],
    scopes: {
      service: { cpuUserMs: 0, cpuSystemMs: 0 },
      worker: { cpuUserMs: 0, cpuSystemMs: 0 },
      command: { cpuUserMs: 900, cpuSystemMs: 200 },
    },
  }]);
});

for (const cpu of [999, 1000]) {
  test(`cpu: observed ${cpu}ms window records no exceedance fact`, async () => {
    const f = fixture();
    const pair = readings([{ key: key('command'), user: cpu, system: 0 }]);
    f.setState({ baseline: pair.baseline, lastAssessment: null });
    f.setReading(pair.current);
    assert.equal((await observeRafHealthCpu(f.context, f.ports))?.exceeded, false);
    assert.deepEqual(f.events, []);
  });
}

test('cpu: concurrent observers repeated reads and restart reuse the persisted completed boundary', async () => {
  const f = fixture();
  await Promise.all([observeRafHealthCpu(f.context, f.ports), observeRafHealthCpu(f.context, f.ports)]);
  await observeRafHealthCpu(f.context, { ...f.ports });
  assert.equal(f.events.length, 1);
  assert.equal(f.state().baseline?.profile.readAt, at(1000));
  assert.equal(f.state().lastAssessment?.cores, 1.1);
});

test('cpu: adjacent high windows each have one event and share only a boundary', async () => {
  const f = fixture();
  await observeRafHealthCpu(f.context, f.ports);
  const next = structuredClone(f.pair.current);
  next.monotonicMs += 1000;
  next.profile.readAt = at(2000);
  next.coverage = { ...next.coverage!, startedAt: at(1000), completedAt: at(2000) };
  const entry = next.profile.rows[0];
  entry.updatedAt = at(2000);
  entry.samples++;
  entry.cpuSamples++;
  entry.cpuUserTotalMs! += 900;
  entry.cpuSystemTotalMs! += 200;
  f.setReading(next);
  await observeRafHealthCpu(f.context, f.ports);
  await observeRafHealthCpu(f.context, f.ports);
  assert.deepEqual(f.events.map(event => [event.startedAt, event.completedAt]), [[at(0), at(1000)], [at(1000), at(2000)]]);
});

test('cpu: incomplete short reads retain the baseline until a full window is available', async () => {
  const f = fixture();
  const short = readings(undefined, 500);
  f.setReading(short.current);
  unavailable((await observeRafHealthCpu(f.context, f.ports))!, at(0), at(500));
  assert.deepEqual(f.state().baseline, f.pair.baseline);
  f.setReading(f.pair.current);
  await observeRafHealthCpu(f.context, f.ports);
  assert.equal(f.events.length, 1);
});

test('cpu: profile reset establishes a new baseline and never bridges the old epoch', async () => {
  const f = fixture();
  const reset = structuredClone(f.pair.current);
  reset.accumulationId = 'profile-epoch-b';
  f.setReading(reset);
  unavailable((await observeRafHealthCpu(f.context, f.ports))!);
  assert.deepEqual(f.events, []);
  assert.equal(f.state().baseline?.accumulationId, 'profile-epoch-b');
  const next = structuredClone(reset);
  next.monotonicMs += 1000;
  next.profile.readAt = at(2000);
  next.coverage = { ...next.coverage!, startedAt: at(1000), completedAt: at(2000) };
  next.profile.rows[0].updatedAt = at(2000);
  next.profile.rows[0].samples++;
  next.profile.rows[0].cpuSamples++;
  next.profile.rows[0].cpuUserTotalMs! += 900;
  next.profile.rows[0].cpuSystemTotalMs! += 200;
  f.setReading(next);
  await observeRafHealthCpu(f.context, f.ports);
  assert.deepEqual(f.events.map(event => [event.startedAt, event.completedAt]), [[at(1000), at(2000)]]);
});

test('cpu: event and boundary commit atomically and failed event persistence is retryable', async () => {
  const f = fixture();
  f.failEvent(new Error('outbox write failed'));
  await withRafHealthCpu(f.context, f.ports, async () => 'main-operation-result');
  assert.deepEqual(f.state().baseline, f.pair.baseline);
  assert.deepEqual(f.events, []);
  assert.ok(f.notices.some(reason => reason.includes('outbox write failed')));
  f.failEvent();
  await observeRafHealthCpu(f.context, f.ports);
  assert.equal(f.events.length, 1);
});

for (const pointer of ['cpuWindowMs', 'cpuThresholdCores'] as const) {
  for (const bad of [undefined, null, -1, '1000', Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`cpu: configuration ${pointer}=${String(bad)} reports its exact pointer without a default`, async () => {
      const f = fixture();
      f.context.configuration = { health: { ...policy, [pointer]: bad } };
      const result = await observeRafHealthCpu(f.context, f.ports);
      assert.equal(result?.availability, 'unavailable');
      assert.equal(result?.cores, null);
      assert.equal(result?.exceeded, false);
      assert.deepEqual(result?.error, { code: 'CONFIGURATION_INVALID', pointer: `conf/raf.json#/health/${pointer}` });
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.state().baseline, f.pair.baseline);
    });
  }
}

test('cpu: missing health object and zero duration identify cpuWindowMs', async () => {
  const f = fixture();
  for (const configuration of [{}, { health: { ...policy, cpuWindowMs: 0 } }]) {
    f.context.configuration = configuration;
    const result = await observeRafHealthCpu(f.context, f.ports);
    assert.deepEqual(result?.error, { code: 'CONFIGURATION_INVALID', pointer: 'conf/raf.json#/health/cpuWindowMs' });
  }
});

test('cpu: valid zero threshold is explicit policy and measured positive CPU exceeds it', async () => {
  const f = fixture();
  f.context.configuration = { health: { ...policy, cpuThresholdCores: 0 } };
  assert.equal((await observeRafHealthCpu(f.context, f.ports))?.exceeded, true);
  assert.equal(f.events[0].thresholdCores, 0);
});

for (const failure of ['profile', 'delivery', 'configuration'] as const) {
  test(`cpu: ${failure} failure preserves the primary operation result and admission state`, async () => {
    const f = fixture();
    const primary = { result: 'accepted', admission: { limit: 8, fifo: ['a', 'b'] } };
    const original = structuredClone(primary);
    let calls = 0;
    if (failure === 'profile') f.failProfile(new Error('profile read failed'));
    if (failure === 'delivery') f.failEvent(new Error('event delivery unavailable'));
    if (failure === 'configuration') f.context.configuration = { health: {} };
    const result = await withRafHealthCpu(f.context, f.ports, async () => { calls++; return primary; });
    assert.equal(result, primary);
    assert.equal(calls, 1);
    assert.deepEqual(primary, original);
    assert.ok(f.notices.length > 0 || f.state().lastAssessment?.error);
    assert.ok(f.reads().profileReads <= 1, 'one opportunistic read, without a health polling loop');
  });
}

test('cpu: monitoring failure never replaces the original runtime rejection', async () => {
  const f = fixture();
  const primaryError = new Error('ADMISSION_REFUSED');
  f.failProfile(new Error('profile read failed'));
  await assert.rejects(withRafHealthCpu(f.context, f.ports, async () => { throw primaryError; }), error => error === primaryError);
});

for (const entry of ['help', 'parse'] as const) {
  test(`cpu: ${entry} never reads profile or opens health state`, async () => {
    const f = fixture();
    f.context.entry = entry;
    assert.equal(await withRafHealthCpu(f.context, f.ports, async () => 'unchanged'), 'unchanged');
    assert.deepEqual(f.reads(), { profileReads: 0, transactions: 0 });
    assert.deepEqual(f.events, []);
  });
}

test('cpu: an unapproved disabled capability performs no health I/O or configuration fallback', async () => {
  const f = fixture();
  f.context.enabled = false;
  f.context.configuration = {};
  assert.equal(await observeRafHealthCpu(f.context, f.ports), null);
  assert.deepEqual(f.reads(), { profileReads: 0, transactions: 0 });
});

test('CPU: short window rotations preserve the full summary period and its independent coverage', async t => {
  const f = summaryCpuFixture(t);
  await f.summary();
  await f.cpu();
  f.advance(100);
  f.sample(0, 100, 'command', 120, 30);
  assert.equal((await f.cpu())?.availability, 'complete');
  f.advance(200);
  f.sample(50, 200, 'worker', 40, 10);
  assert.equal((await f.cpu())?.availability, 'partial', 'the interval crosses the short CPU boundary');
  f.advance(600);
  f.sample(200, 600, 'service', 60, 15);
  await f.cpu();
  const result = await f.summary();
  const cpu = result.summary!.event.cpu;
  assert.equal(cpu.availability, 'complete', cpu.reason ?? 'summary CPU must be measured');
  assert.equal(cpu.startedAt, f.at(0));
  assert.equal(cpu.completedAt, f.at(600));
  assert.equal(cpu.wallMs, 600);
  assert.equal(cpu.cpuUserMs, 220);
  assert.equal(cpu.cpuSystemMs, 55);
  assert.equal(cpu.cores, 275 / 600);
  assert.deepEqual(cpu.scopes, { command: { cpuUserMs: 120, cpuSystemMs: 30 },
    worker: { cpuUserMs: 40, cpuSystemMs: 10 }, service: { cpuUserMs: 60, cpuSystemMs: 15 } });
  assert.equal(f.store().healthCpu.transaction(tx => tx.state.baseline?.profile.readAt), f.at(600));
});
