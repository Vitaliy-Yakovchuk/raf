import assert from 'node:assert/strict';
import test from 'node:test';
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

for (const configuration of [{}, { health: {} }, { health: { summaryIntervalMs: null } }, { health: { summaryIntervalMs: 0 } }, { health: { summaryIntervalMs: -1 } }, { health: { summaryIntervalMs: '1000' } }, { health: { summaryIntervalMs: Number.NaN } }, { health: { summaryIntervalMs: Number.POSITIVE_INFINITY } }]) {
  test(`summary: invalid policy ${JSON.stringify(configuration)} reports exact pointer without fallback`, async () => {
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
