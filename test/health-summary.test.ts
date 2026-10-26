import { summaryCpuFixture } from './helpers/health-summary-cpu-fixture.ts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeHealthSummary } from '../src/health-summary-runtime.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';
import { loadEventCatalog } from '../src/event-catalog.ts';
import { settleCommandState } from '../src/reminder-cli.ts';
import {
  extendRafCommandStats, readRafHealthSummary, settleRafHealthSummary, withRafHealthSummary,
  type HealthForceAggregate, type HealthSource, type HealthSummaryContext,
  type HealthSummaryEvent, type HealthSummaryPorts, type HealthSummarySources,
  type HealthSummaryState,
} from '../src/health-summary.ts';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 24, 10) + ms).toISOString();
const complete = <T>(value: T): HealthSource<T> => ({ value, availability: 'complete', reason: null });
const force = (completed: number, since = at(-10000)): HealthSource<HealthForceAggregate> => complete({
  since, completed, refusalsByCode: { REPORT_PENDING: 2 },
});

function fixture() {
  let state: HealthSummaryState = {
    rafInstanceId: 'sqlite-health-domain-a', since: at(0), boundary: at(0),
    forceBaseline: force(7), lastSummary: null,
  };
  let sources: HealthSummarySources = {
    eventsByType: complete({ 'agent.finished': 3, 'raf.cpu-exceeded': 1 }),
    refusalsByCodeAndStage: complete({ CALLER_UNAUTHORIZED: { authorization: 2 }, CONFIGURATION_INVALID: { preflight: 1 } }),
    queue: complete({ states: { queued: 2, admitted: 1 }, count: 3, oldestAt: at(-500), oldestAgeMs: 1500 }),
    cpu: {
      availability: 'complete', reason: null, startedAt: at(0), completedAt: at(1000),
      wallMs: 1000, cpuUserMs: 900, cpuSystemMs: 200, cores: 1.1, thresholdCores: 1,
      exceeded: true, sources: ['process.cpuUsage'], error: null,
      scopes: {
        service: { cpuUserMs: 100, cpuSystemMs: 20 },
        worker: { cpuUserMs: 500, cpuSystemMs: 130 },
        command: { cpuUserMs: 300, cpuSystemMs: 50 },
      },
    },
    forcedClose: force(10),
  };
  let tail = Promise.resolve();
  let main: string | null = null;
  let acceptReceipt = true;
  let failRecord = false;
  let failTransaction = false;
  let failDelivery = false;
  let transactionCount = 0;
  let deliveryCalls = 0;
  let sourceCalls = 0;
  const outbox = new Map<string, { event: HealthSummaryEvent; delivered: boolean }>();
  const receipts: { factKey: string; main: string }[] = [];
  const notices: string[] = [];
  const ranges: [string, string][] = [];
  const ports: HealthSummaryPorts = {
    async transaction(operation) {
      transactionCount++;
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        if (failTransaction) throw new Error('STATE_UNAVAILABLE');
        const working = structuredClone(state);
        const records: HealthSummaryEvent[] = [];
        const result = operation({
          state: working,
          readSources(startedAt, completedAt) {
            sourceCalls++;
            ranges.push([startedAt, completedAt]);
            const result = structuredClone(sources);
            const previousSummaries = [...outbox.values()].filter(({ event }) => event.completedAt >= startedAt && event.completedAt < completedAt).length;
            if (previousSummaries && result.eventsByType.value) result.eventsByType.value['raf.health-summary'] = previousSummaries;
            return result;
          },
          recordEvent(event) {
            if (failRecord) throw new Error('OUTBOX_WRITE_FAILED');
            assert.ok(!outbox.has(event.factKey), 'duplicate immutable event fact');
            records.push(structuredClone(event));
          },
        });
        state = working;
        for (const event of records) outbox.set(event.factKey, { event, delivered: false });
        return result;
      } finally {
        release();
      }
    },
    async deliverPendingToCurrentMain() {
      deliveryCalls++;
      if (failDelivery) throw new Error('TRANSPORT_UNAVAILABLE');
      if (!main || !acceptReceipt) return;
      for (const [factKey, record] of outbox) {
        if (record.delivered) continue;
        record.delivered = true;
        receipts.push({ factKey, main });
        if (state.lastSummary?.event.factKey === factKey) state.lastSummary.delivery = 'delivered';
      }
    },
    reportUnavailable(reason) { notices.push(reason); },
  };
  const context: HealthSummaryContext = {
    enabled: true, entry: 'worker', now: at(1000), configuration: { health: { summaryIntervalMs: 1000 } },
  };
  return {
    ports, context, outbox, receipts, notices, ranges,
    state: () => structuredClone(state),
    sources: () => structuredClone(sources),
    setSources(next: HealthSummarySources) { sources = structuredClone(next); },
    setState(next: HealthSummaryState) { state = structuredClone(next); },
    setMain(value: string | null) { main = value; },
    acceptReceipt(value: boolean) { acceptReceipt = value; },
    failRecord(value: boolean) { failRecord = value; },
    failTransaction(value: boolean) { failTransaction = value; },
    failDelivery(value: boolean) { failDelivery = value; },
    calls: () => ({ transactionCount, deliveryCalls, sourceCalls }),
    events: () => [...outbox.values()].map(record => structuredClone(record.event)),
  };
}

for (const entry of ['worker', 'runtime'] as const) {
  test(`summary: ${entry} records exactly one due fact with domain identity and actual bounds`, async () => {
    const f = fixture();
    const result = await settleRafHealthSummary({ ...f.context, entry }, f.ports);
    assert.equal(result.status, 'recorded');
    assert.equal(result.error, null);
    assert.equal(f.events().length, 1);
    const event = f.events()[0];
    assert.equal(event.type, 'raf.health-summary');
    assert.equal(event.rafInstanceId, 'sqlite-health-domain-a');
    assert.equal(event.startedAt, at(0));
    assert.equal(event.completedAt, at(1000));
    assert.equal(event.scheduledAt, at(1000));
    assert.equal(event.delayed, false);
    assert.ok(event.factKey.includes(event.startedAt) && event.factKey.includes(event.completedAt));
    assert.ok(event.factKey.includes(event.rafInstanceId));
    assert.equal(f.state().boundary, at(1000));
    assert.deepEqual(f.ranges, [[at(0), at(1000)]]);
    assert.equal(f.state().lastSummary?.delivery, 'pending');
  });
}

test('summary: not due never reads aggregate sources or advances the boundary', async () => {
  const f = fixture();
  const before = f.state();
  assert.equal((await settleRafHealthSummary({ ...f.context, now: at(999) }, f.ports)).status, 'idle');
  assert.equal(f.calls().sourceCalls, 0);
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.events(), []);
});

test('summary: interval is read from supplied policy without a copied hourly default', async () => {
  const f = fixture();
  const context = { ...f.context, configuration: { health: { summaryIntervalMs: 2500 } } };
  assert.equal((await settleRafHealthSummary(context, f.ports)).status, 'idle');
  await settleRafHealthSummary({ ...context, now: at(2500) }, f.ports);
  assert.equal(f.events()[0].scheduledAt, at(2500));
});

test('summary: concurrent worker and commands retry one atomic fact and one accepted delivery', async () => {
  const f = fixture();
  f.setMain('main-current');
  await Promise.all(Array.from({ length: 8 }, (_, i) => settleRafHealthSummary({ ...f.context, entry: i % 2 ? 'runtime' : 'worker' }, f.ports)));
  await settleRafHealthSummary(f.context, f.ports);
  assert.equal(f.events().length, 1);
  assert.equal(f.receipts.length, 1);
  assert.deepEqual(f.receipts[0], { factKey: f.events()[0].factKey, main: 'main-current' });
  assert.equal(f.calls().sourceCalls, 1);
  assert.equal(f.state().boundary, at(1000));
});

test('summary: skipped intervals become one delayed real period without fabricated snapshots', async () => {
  const f = fixture();
  await settleRafHealthSummary({ ...f.context, now: at(5500) }, f.ports);
  assert.equal(f.events().length, 1);
  assert.deepEqual(f.ranges, [[at(0), at(5500)]]);
  assert.equal(f.events()[0].scheduledAt, at(1000));
  assert.equal(f.events()[0].delayed, true);
  assert.equal(f.events()[0].completedAt, at(5500));
  assert.equal(f.state().boundary, at(5500));
  const health = await readRafHealthSummary({ ...f.context, now: at(5500) }, f.ports);
  assert.equal(health.summary.dueAt, at(6500));
});

test('summary: successive facts have adjacent nonoverlapping periods and exclude themselves', async () => {
  const f = fixture();
  await settleRafHealthSummary(f.context, f.ports);
  await settleRafHealthSummary({ ...f.context, now: at(2000) }, f.ports);
  const [first, second] = f.events();
  assert.equal(first.eventsByType.value?.['raf.health-summary'], undefined);
  assert.equal(second.eventsByType.value?.['raf.health-summary'], 1);
  assert.equal(second.startedAt, first.completedAt);
  assert.equal(second.completedAt, at(2000));
  assert.notEqual(first.factKey, second.factKey);
  assert.deepEqual(f.ranges, [[at(0), at(1000)], [at(1000), at(2000)]]);
});

test('summary: outbox insertion failure rolls back boundary baseline and fact together', async () => {
  const f = fixture();
  const before = f.state();
  f.failRecord(true);
  const failed = await settleRafHealthSummary(f.context, f.ports);
  assert.equal(failed.status, 'unavailable');
  assert.ok(failed.reason);
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.events(), []);
  f.failRecord(false);
  await settleRafHealthSummary(f.context, f.ports);
  assert.equal(f.events().length, 1);
  assert.equal(f.events()[0].forcedClose.value?.completed, 3);
});

test('summary: main absence and missing receipt stay pending until the current main accepts', async () => {
  const f = fixture();
  await settleRafHealthSummary(f.context, f.ports);
  assert.equal(f.state().lastSummary?.delivery, 'pending');
  assert.deepEqual(f.receipts, []);
  f.setMain('main-old');
  f.acceptReceipt(false);
  await settleRafHealthSummary({ ...f.context, now: at(1100) }, f.ports);
  assert.equal(f.state().lastSummary?.delivery, 'pending');
  assert.deepEqual(f.receipts, []);
  f.setMain('main-replacement');
  f.acceptReceipt(true);
  await settleRafHealthSummary({ ...f.context, now: at(1200) }, f.ports);
  assert.equal(f.state().lastSummary?.delivery, 'delivered');
  assert.deepEqual(f.receipts, [{ factKey: f.events()[0].factKey, main: 'main-replacement' }]);
  assert.equal(f.events().length, 1);
});

test('summary: restart before delivery reuses persisted domain boundary and pending fact', async () => {
  const f = fixture();
  await settleRafHealthSummary(f.context, f.ports);
  const persisted = f.state();
  const restartedPorts = { ...f.ports };
  f.setState(structuredClone(persisted));
  f.setMain('main-after-restart');
  await settleRafHealthSummary({ ...f.context, entry: 'runtime', now: at(1500) }, restartedPorts);
  await settleRafHealthSummary({ ...f.context, now: at(1500) }, restartedPorts);
  assert.equal(f.state().rafInstanceId, persisted.rafInstanceId);
  assert.equal(f.state().boundary, persisted.boundary);
  assert.equal(f.events().length, 1);
  assert.equal(f.receipts.length, 1);
});

test('summary: transport failure preserves committed fact for retry rather than rolling back or duplicating it', async () => {
  const f = fixture();
  f.setMain('main-current');
  f.failDelivery(true);
  await settleRafHealthSummary(f.context, f.ports);
  assert.equal(f.state().boundary, at(1000));
  assert.equal(f.state().lastSummary?.delivery, 'pending');
  assert.equal(f.events().length, 1);
  assert.ok(f.notices.length > 0);
  f.failDelivery(false);
  await settleRafHealthSummary({ ...f.context, now: at(1100) }, f.ports);
  assert.equal(f.events().length, 1);
  assert.equal(f.receipts.length, 1);
});

test('summary: several real periods while main is offline retain separate pending facts for the existing outbox', async () => {
  const f = fixture();
  await settleRafHealthSummary(f.context, f.ports);
  await settleRafHealthSummary({ ...f.context, now: at(2000) }, f.ports);
  assert.equal(f.events().length, 2);
  assert.equal(f.receipts.length, 0);
  assert.ok([...f.outbox.values()].every(record => !record.delivered));
  f.setMain('main-current');
  await settleRafHealthSummary({ ...f.context, now: at(2100) }, f.ports);
  await settleRafHealthSummary({ ...f.context, now: at(2200) }, f.ports);
  assert.equal(f.events().length, 2);
  assert.equal(f.receipts.length, 2);
  assert.equal(new Set(f.receipts.map(receipt => receipt.factKey)).size, 2);
  assert.ok(f.receipts.every(receipt => receipt.main === 'main-current'));
});

test('summary: domain and period are both included in immutable dedup identity', async () => {
  const a = fixture();
  const b = fixture();
  b.setState({ ...b.state(), rafInstanceId: 'sqlite-health-domain-b' });
  await settleRafHealthSummary(a.context, a.ports);
  await settleRafHealthSummary(b.context, b.ports);
  assert.notEqual(a.events()[0].factKey, b.events()[0].factKey);
});

test('summary: event includes event counts queue age refusal stages CPU completeness and period force delta', async () => {
  const f = fixture();
  const before = f.sources();
  await settleRafHealthSummary(f.context, f.ports);
  const event = f.events()[0];
  assert.deepEqual(event.eventsByType, before.eventsByType);
  assert.deepEqual(event.queue, before.queue);
  assert.deepEqual(event.refusalsByCodeAndStage, before.refusalsByCodeAndStage);
  assert.deepEqual(event.cpu, before.cpu);
  assert.equal(event.forcedClose.value?.completed, 3);
  assert.equal(event.forcedClose.value?.since, at(-10000));
  assert.deepEqual(f.sources(), before, 'summary must not mutate profile queue or force source aggregates');
});

test('summary: force delta uses the previous committed boundary while stats retains cumulative counts', async () => {
  const f = fixture();
  await settleRafHealthSummary(f.context, f.ports);
  const next = f.sources();
  next.forcedClose = force(12);
  f.setSources(next);
  await settleRafHealthSummary({ ...f.context, now: at(2000) }, f.ports);
  assert.deepEqual(f.events().map(event => event.forcedClose.value?.completed), [3, 2]);
  const health = await readRafHealthSummary({ ...f.context, now: at(2100) }, f.ports);
  assert.equal(health.forcedClose.value?.completed, 12);
  assert.equal(health.forcedClose.value?.since, at(-10000));
});

for (const variant of ['same-total', 'no-baseline', 'new-accounting', 'counter-reset'] as const) {
  test(`summary: force ${variant} distinguishes measured zero from unavailable period contribution`, async () => {
    const f = fixture();
    const state = f.state();
    if (variant === 'same-total') state.forceBaseline = force(10);
    if (variant === 'no-baseline') state.forceBaseline = { value: null, availability: 'unavailable', reason: 'No baseline' };
    if (variant === 'new-accounting') state.forceBaseline = force(7, at(-20000));
    if (variant === 'counter-reset') state.forceBaseline = force(20);
    f.setState(state);
    await settleRafHealthSummary(f.context, f.ports);
    const contribution = f.events()[0].forcedClose;
    if (variant === 'same-total') {
      assert.equal(contribution.availability, 'complete');
      assert.equal(contribution.value?.completed, 0);
    } else {
      assert.notEqual(contribution.availability, 'complete');
      assert.equal(contribution.value?.completed ?? null, null);
      assert.ok(contribution.reason);
    }
  });
}

for (const part of ['eventsByType', 'refusalsByCodeAndStage', 'queue', 'forcedClose'] as const) {
  for (const availability of ['partial', 'unavailable'] as const) {
    test(`summary: ${part} ${availability} preserves incompleteness and reason without invented zeros`, async () => {
      const f = fixture();
      const sources = f.sources();
      sources[part].availability = availability;
      sources[part].reason = `${part} source not fully readable`;
      if (availability === 'unavailable') sources[part].value = null;
      f.setSources(sources);
      await settleRafHealthSummary(f.context, f.ports);
      const aggregate = f.events()[0][part];
      assert.equal(aggregate.availability, availability);
      assert.ok(aggregate.reason);
      if (availability === 'unavailable') assert.equal(aggregate.value, null);
      assert.equal(f.state().boundary, at(1000));
      assert.equal(f.events()[0].cpu.cores, 1.1);
    });
  }
}

for (const availability of ['partial', 'unavailable'] as const) {
  test(`summary: ${availability} CPU retains bounds and reason rather than claiming zero load`, async () => {
    const f = fixture();
    const sources = f.sources();
    sources.cpu = { ...sources.cpu, availability, cores: null, cpuUserMs: null, cpuSystemMs: null, exceeded: false, reason: 'Incomplete profile coverage' };
    f.setSources(sources);
    await settleRafHealthSummary(f.context, f.ports);
    assert.deepEqual(f.events()[0].cpu, sources.cpu);
    assert.equal(f.events()[0].eventsByType.availability, 'complete');
  });
}

test('summary: known empty sources and measured zero CPU remain complete', async () => {
  const f = fixture();
  const sources = f.sources();
  sources.eventsByType = complete({});
  sources.refusalsByCodeAndStage = complete({});
  sources.queue = complete({ states: {}, count: 0, oldestAt: null, oldestAgeMs: null });
  sources.cpu = { ...sources.cpu, cores: 0, cpuUserMs: 0, cpuSystemMs: 0, exceeded: false };
  f.setSources(sources);
  await settleRafHealthSummary(f.context, f.ports);
  assert.deepEqual(f.events()[0].queue, sources.queue);
  assert.equal(f.events()[0].cpu.availability, 'complete');
  assert.equal(f.events()[0].cpu.cores, 0);
});

test('summary: event projection excludes frames briefs secrets and arbitrary source fields', async () => {
  const f = fixture();
  const sources = f.sources();
  Object.assign(sources, { frame: 'RAW_FRAME_CANARY', brief: 'PRIVATE_BRIEF_CANARY', secret: 'SECRET_TEXT_CANARY' });
  Object.assign(sources.queue.value!, { frame: 'NESTED_FRAME_CANARY' });
  f.setSources(sources);
  await settleRafHealthSummary(f.context, f.ports);
  const serialized = JSON.stringify(f.events());
  for (const canary of ['RAW_FRAME_CANARY', 'PRIVATE_BRIEF_CANARY', 'SECRET_TEXT_CANARY', 'NESTED_FRAME_CANARY']) assert.ok(!serialized.includes(canary));
  assert.deepEqual(Object.keys(f.events()[0]).sort(), [
    'type', 'rafInstanceId', 'factKey', 'startedAt', 'completedAt', 'scheduledAt', 'delayed',
    'eventsByType', 'refusalsByCodeAndStage', 'queue', 'cpu', 'forcedClose',
  ].sort());
});

test('summary: command stats preserves commands profile and other fields alongside cumulative health', async () => {
  const f = fixture();
  await settleRafHealthSummary(f.context, f.ports);
  const stats = { commands: [{ command: 'agent ps', emaMs: 12 }], profile: { schemaVersion: 1, rows: [{ scope: 'worker', cpuUserTotalMs: 900 }] }, futureField: ['keep'] };
  const before = structuredClone(stats);
  const result = await extendRafCommandStats(stats, { ...f.context, now: at(1200) }, f.ports);
  assert.deepEqual(result.commands, before.commands);
  assert.deepEqual(result.profile, before.profile);
  assert.deepEqual(result.futureField, before.futureField);
  assert.deepEqual(stats, before);
  assert.equal(result.health.readAt, at(1200));
  assert.equal(result.health.since, at(0));
  assert.equal(result.health.error, null);
  assert.equal(result.health.unavailableReason, null);
  assert.equal(result.health.cpu.availability, 'complete');
  assert.equal(result.health.forcedClose.value?.completed, 10);
  assert.deepEqual(result.health.summary, { startedAt: at(0), completedAt: at(1000), dueAt: at(2000), delivery: 'pending', delayed: false });
});

test('summary: stats before the first fact exposes accounting start next due and no invented delivery', async () => {
  const f = fixture();
  const health = await readRafHealthSummary({ ...f.context, now: at(500) }, f.ports);
  assert.equal(health.since, at(0));
  assert.deepEqual(health.summary, { startedAt: null, completedAt: null, dueAt: at(1000), delivery: null, delayed: false });
  assert.equal(f.events().length, 0);
});

test('summary: invalid health policy is visible in stats while commands and profile retain their result', async () => {
  const f = fixture();
  const stats = { commands: [{ command: 'agent ps', averageMs: 12 }], profile: { schemaVersion: 1, readAt: at(1000), rows: [] } };
  const result = await extendRafCommandStats(stats, { ...f.context, configuration: { health: {} } }, f.ports);
  assert.deepEqual(result.commands, stats.commands);
  assert.deepEqual(result.profile, stats.profile);
  assert.deepEqual(result.health.error, { code: 'CONFIGURATION_INVALID', pointer: 'conf/raf.json#/health/summaryIntervalMs' });
  assert.ok(result.health.unavailableReason);
  assert.equal(result.health.summary.dueAt, null);
  assert.deepEqual(f.calls(), { transactionCount: 0, deliveryCalls: 0, sourceCalls: 0 });
});

for (const [label, configuration] of [
  ['missing-health', {}], ['missing-interval', { health: {} }],
  ['null', { health: { summaryIntervalMs: null } }], ['zero', { health: { summaryIntervalMs: 0 } }],
  ['negative', { health: { summaryIntervalMs: -1 } }], ['string', { health: { summaryIntervalMs: '1000' } }],
  ['NaN', { health: { summaryIntervalMs: Number.NaN } }], ['Infinity', { health: { summaryIntervalMs: Number.POSITIVE_INFINITY } }],
] as const) {
  test(`summary: invalid policy ${label} reports exact pointer without fallback`, async () => {
    const f = fixture();
    const result = await settleRafHealthSummary({ ...f.context, configuration }, f.ports);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.error, { code: 'CONFIGURATION_INVALID', pointer: 'conf/raf.json#/health/summaryIntervalMs' });
    assert.ok(result.reason);
    assert.deepEqual(f.calls(), { transactionCount: 0, deliveryCalls: 0, sourceCalls: 0 });
  });
}

for (const entry of ['service', 'help', 'parse'] as const) {
  test(`summary: ${entry} never opens monitoring state or delivers events`, async () => {
    const f = fixture();
    const result = await settleRafHealthSummary({ ...f.context, entry, configuration: null }, f.ports);
    assert.equal(result.status, 'ignored');
    assert.deepEqual(f.calls(), { transactionCount: 0, deliveryCalls: 0, sourceCalls: 0 });
    assert.deepEqual(f.events(), []);
  });
}

test('summary: disabled unapproved feature does not read state configuration or outbox', async () => {
  const f = fixture();
  assert.equal((await settleRafHealthSummary({ ...f.context, enabled: false, configuration: null }, f.ports)).status, 'ignored');
  assert.deepEqual(f.calls(), { transactionCount: 0, deliveryCalls: 0, sourceCalls: 0 });
});

for (const failure of ['configuration', 'state', 'outbox', 'delivery'] as const) {
  test(`summary: ${failure} failure preserves the successful independent operation result`, async () => {
    const f = fixture();
    const context = { ...f.context };
    if (failure === 'configuration') context.configuration = {};
    if (failure === 'state') f.failTransaction(true);
    if (failure === 'outbox') f.failRecord(true);
    if (failure === 'delivery') f.failDelivery(true);
    const expected = { admission: 'unchanged', exitCode: 0 };
    let operations = 0;
    const result = await withRafHealthSummary(context, f.ports, async () => { operations++; return expected; });
    assert.equal(result, expected);
    assert.equal(operations, 1);
    assert.ok(f.notices.length > 0);
  });
}

test('summary: monitoring cannot replace the independent primary error or retry the operation', async () => {
  const f = fixture();
  f.failTransaction(true);
  const primary = new Error('PRIMARY_OPERATION_REFUSED');
  let operations = 0;
  await assert.rejects(withRafHealthSummary(f.context, f.ports, async () => { operations++; throw primary; }), (error: unknown) => error === primary);
  assert.equal(operations, 1);
});

for (const accepted of [true, false]) {
  test(`summary: SQLite acknowledgement contention retries the receipt without resending (accepted=${accepted})`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'raf-summary-ack-'));
    const handles = new Set<StateStore>();
    t.after(() => {
      for (const handle of handles) handle.close();
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, 'conf'));
    const settings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
    writeFileSync(join(root, 'conf/raf.json'), JSON.stringify(settings));
    const path = join(root, 'state.sqlite');
    const open = () => {
      const handle = openStateStore(path);
      handles.add(handle);
      return handle;
    };
    const store = open();
    const model = fixture();
    await settleRafHealthSummary(model.context, model.ports);
    const event = { ...model.events()[0], rafInstanceId: store.healthCpu.domain().rafInstanceId };
    event.factKey = JSON.stringify([event.type, event.rafInstanceId, event.startedAt, event.completedAt]);
    store.healthSummary.transaction(tx => {
      tx.recordEvent(event);
      tx.state.lastSummary = { event, delivery: 'pending' };
    });
    store.sessionRepository.transaction(tx => tx.putSession({ runId: 'main-run', addressId: 'main', revision: 1, state: 'running' }));
    const complete = store.healthSummary.complete;
    let acknowledgements = 0;
    store.healthSummary.complete = (...args) => {
      if (++acknowledgements <= 2) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
      complete(...args);
    };
    const deliveries: string[] = [];
    const settle = (handle: StateStore, accept: boolean) => settleCommandState({
      orchestratorRoot: root, store: handle, now: Date.now, nextReminderId: () => 'unused', catalog: loadEventCatalog(root),
      deliver: async request => {
        deliveries.push(request.text);
        return accept ? { accepted: true, receiptId: 'main-accepted' } : { accepted: false, reason: 'Main offline' };
      },
    });
    await settle(store, accepted);
    assert.equal(acknowledgements, 3, 'retry the acknowledgement instead of abandoning the accepted receipt');
    assert.equal(deliveries.length, 1);
    assert.equal(store.healthSummary.transaction(tx => tx.state.lastSummary?.delivery), accepted ? 'delivered' : 'uncertain');
    store.close();
    handles.delete(store);
    const restarted = open();
    await settle(restarted, true);
    await settle(restarted, true);
    assert.equal(deliveries.length, 1, 'restart preserves success and does not retry an unconfirmed transport result');
    assert.ok(deliveries.every(text => JSON.parse(text).factKey === event.factKey));
    assert.equal(restarted.healthSummary.transaction(tx => tx.state.lastSummary?.delivery), accepted ? 'delivered' : 'uncertain');
    assert.equal(restarted.sessionRepository.transaction(tx => tx.listPending()).length, accepted ? 0 : 1);
  });
}

async function durableSummaryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-summary-outcome-'));
  const path = join(root, 'state.sqlite');
  const handles = new Set<StateStore>();
  t.after(() => {
    for (const handle of handles) handle.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'conf'));
  const settings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  settings.state.contention.timeoutMs = 20;
  settings.state.contention.retryDelayMs = 1;
  writeFileSync(join(root, 'conf/raf.json'), JSON.stringify(settings));
  const open = () => { const handle = openStateStore(path); handles.add(handle); return handle; };
  const close = (handle: StateStore) => { handle.close(); handles.delete(handle); };
  const store = open();
  const model = fixture();
  await settleRafHealthSummary(model.context, model.ports);
  const event = { ...model.events()[0], rafInstanceId: store.healthCpu.domain().rafInstanceId };
  event.factKey = JSON.stringify([event.type, event.rafInstanceId, event.startedAt, event.completedAt]);
  store.healthSummary.transaction(tx => { tx.recordEvent(event); tx.state.lastSummary = { event, delivery: 'pending' }; });
  store.sessionRepository.transaction(tx => tx.putSession({ runId: 'main-run', addressId: 'main', revision: 1, state: 'running' }));
  const settle = (handle: StateStore, deliver: Parameters<typeof settleCommandState>[0]['deliver']) => settleCommandState({
    orchestratorRoot: root, store: handle, now: Date.now, nextReminderId: () => 'unused', catalog: loadEventCatalog(root), deliver,
  });
  const assertUncertain = async (handle: StateStore) => {
    const health = await runtimeHealthSummary(handle, root).read();
    assert.equal(health.summary.delivery, 'uncertain');
    const issues = health.summary.uncertainDeliveries;
    assert.equal(issues?.length, 1, 'command stats exposes one unresolved delivery instead of silently retrying');
    assert.equal(issues![0].factKey, event.factKey);
    assert.equal(issues![0].recipientRunId, 'main-run');
    assert.ok(issues![0].reason);
    assert.ok(Number.isFinite(Date.parse(issues![0].attemptedAt)));
    assert.equal(handle.sessionRepository.transaction(tx => tx.listPending()).length, 1, 'uncertain delivery stays pending without accepted receipt');
  };
  return { root, path, store, event, open, close, settle, assertUncertain };
}

for (const result of ['unconfirmed', 'throw'] as const) {
  test(`summary: transport ${result} after acceptance stays explicit and never resends across restart`, async t => {
    const f = await durableSummaryFixture(t);
    const received: string[] = [];
    await f.settle(f.store, async request => {
      received.push(JSON.parse(request.text).factKey);
      if (result === 'throw') throw new Error('Acceptance could not be verified');
      return { accepted: false, reason: 'Agent acceptance is unconfirmed after bounded delivery verification' };
    });
    await f.settle(f.store, async request => { received.push(JSON.parse(request.text).factKey); return { accepted: true, receiptId: 'duplicate' }; });
    f.close(f.store);
    const restarted = f.open();
    await f.settle(restarted, async request => { received.push(JSON.parse(request.text).factKey); return { accepted: true, receiptId: 'duplicate' }; });
    assert.deepEqual(received, [f.event.factKey]);
    await f.assertUncertain(restarted);
    restarted.healthSummary.transaction(tx => { tx.state.lastSummary = null; });
    const health = await runtimeHealthSummary(restarted, f.root).read();
    assert.equal(health.summary.uncertainDeliveries?.[0].factKey, f.event.factKey, 'an older unresolved fact remains visible after singleton replacement');
  });
}

test('summary: sender SIGKILL after acceptance before receipt persistence does not resend after restart', async t => {
  const f = await durableSummaryFixture(t);
  const transcript = join(f.root, 'received.json');
  f.close(f.store);
  const script = `
    import { writeFileSync } from 'node:fs';
    import { openStateStore } from ${JSON.stringify(new URL('../src/state-store.ts', import.meta.url).href)};
    import { loadEventCatalog } from ${JSON.stringify(new URL('../src/event-catalog.ts', import.meta.url).href)};
    import { settleCommandState } from ${JSON.stringify(new URL('../src/reminder-cli.ts', import.meta.url).href)};
    const root = ${JSON.stringify(f.root)};
    const store = openStateStore(${JSON.stringify(f.path)});
    await settleCommandState({ orchestratorRoot: root, store, now: Date.now, nextReminderId: () => 'unused', catalog: loadEventCatalog(root),
      deliver: async request => { writeFileSync(${JSON.stringify(transcript)}, request.text); process.kill(process.pid, 'SIGKILL'); } });
    process.exit(91);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(JSON.parse(readFileSync(transcript, 'utf8')).factKey, f.event.factKey);
  const restarted = f.open();
  let duplicates = 0;
  const deliver = async () => { duplicates++; return { accepted: true as const, receiptId: 'duplicate' }; };
  await f.settle(restarted, deliver);
  await f.settle(restarted, deliver);
  assert.equal(duplicates, 0, 'dead sender claim must not authorize a second native delivery');
  await f.assertUncertain(restarted);
});

test('summary: exhausted SQLite receipt budget stays explicit without resending in next command or restart', async t => {
  const f = await durableSummaryFixture(t);
  const complete = f.store.healthSummary.complete;
  let attempts = 0;
  let received = 0;
  f.store.healthSummary.complete = () => { attempts++; throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }); };
  const deliver = async () => { received++; return { accepted: true as const, receiptId: 'accepted' }; };
  await f.settle(f.store, deliver);
  assert.ok(attempts > 1, 'receipt persistence used the configured retry budget');
  f.store.healthSummary.complete = complete;
  await f.settle(f.store, deliver);
  f.close(f.store);
  const restarted = f.open();
  await f.settle(restarted, deliver);
  assert.equal(received, 1);
  await f.assertUncertain(restarted);
});

for (const delayed of [false, true]) {
  test(`summary: consecutive periods retain measured CPU across short windows and reopen (delayed=${delayed})`, async t => {
    const f = summaryCpuFixture(t);
    await f.summary();
    await f.cpu();
    f.advance(100);
    f.sample(0, 100);
    await f.cpu();
    f.advance(600);
    f.sample(100, 600, 'worker', 70, 10);
    const first = (await f.summary()).summary!.event;
    assert.equal(first.cpu.availability, 'complete', first.cpu.reason!);
    assert.equal(first.cpu.cpuUserMs, 90);
    assert.equal(first.cpu.cpuSystemMs, 15);
    assert.equal(first.cpu.wallMs, 600);
    f.reopen();
    f.advance(700);
    f.sample(600, 700, 'service', 30, 5);
    await f.cpu();
    const end = delayed ? 1800 : 1200;
    f.advance(end);
    f.sample(700, end, 'command', 10, 2);
    await f.cpu();
    const second = (await f.summary()).summary!.event;
    assert.equal(second.cpu.availability, 'complete', second.cpu.reason!);
    assert.equal(second.startedAt, first.completedAt);
    assert.equal(second.cpu.startedAt, f.at(600));
    assert.equal(second.cpu.completedAt, f.at(end));
    assert.equal(second.cpu.wallMs, end - 600);
    assert.equal(second.cpu.cpuUserMs, 40);
    assert.equal(second.cpu.cpuSystemMs, 7);
    assert.equal(second.delayed, delayed);
  });
}

test('summary: incomplete coverage remains partial across short CPU resets and recovers next period', async t => {
  const f = summaryCpuFixture(t);
  await f.summary();
  await f.cpu();
  f.advance(100);
  f.sample(-10, 100);
  await f.cpu();
  f.advance(600);
  f.sample(100, 600);
  await f.cpu();
  const first = (await f.summary()).summary!.event.cpu;
  assert.equal(first.availability, 'partial');
  assert.equal(first.cpuUserMs, null);
  assert.equal(first.exceeded, false);
  f.advance(1200);
  f.sample(600, 1200);
  const second = (await f.summary()).summary!.event.cpu;
  assert.equal(second.availability, 'complete', second.reason!);
  assert.equal(second.cpuUserMs, 20);
  assert.equal(second.cpuSystemMs, 5);
});
