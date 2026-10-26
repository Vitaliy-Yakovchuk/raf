import type { RafHealthCpuAssessment } from './health-cpu.ts';

export type HealthSource<T> = {
  value: T | null;
  availability: 'complete' | 'partial' | 'unavailable';
  reason: string | null;
};

export type HealthQueueAggregate = {
  states: Record<string, number>;
  count: number;
  oldestAt: string | null;
  oldestAgeMs: number | null;
};

export type HealthForceAggregate = {
  since: string | null;
  completed: number | null;
  refusalsByCode: Record<string, number>;
};

export type HealthSummarySources = {
  eventsByType: HealthSource<Record<string, number>>;
  refusalsByCodeAndStage: HealthSource<Record<string, Record<string, number>>>;
  queue: HealthSource<HealthQueueAggregate>;
  cpu: RafHealthCpuAssessment;
  forcedClose: HealthSource<HealthForceAggregate>;
};

export type HealthSummaryEvent = {
  type: 'raf.health-summary';
  rafInstanceId: string;
  factKey: string;
  startedAt: string;
  completedAt: string;
  scheduledAt: string;
  delayed: boolean;
  eventsByType: HealthSource<Record<string, number>>;
  refusalsByCodeAndStage: HealthSource<Record<string, Record<string, number>>>;
  queue: HealthSource<HealthQueueAggregate>;
  cpu: RafHealthCpuAssessment;
  forcedClose: HealthSource<HealthForceAggregate>;
};

export type HealthSummaryDeliveryIssue = {
  factKey: string;
  startedAt: string;
  completedAt: string;
  attemptedAt: string;
  recipientRunId: string;
  reason: string;
};

export type HealthSummaryRecord = {
  event: HealthSummaryEvent;
  delivery: 'pending' | 'delivered' | 'uncertain';
};

export type HealthSummaryState = {
  rafInstanceId: string;
  since: string;
  boundary: string;
  forceBaseline: HealthSource<HealthForceAggregate>;
  lastSummary: HealthSummaryRecord | null;
};

export interface HealthSummaryTransaction {
  state: HealthSummaryState;
  readSources(startedAt: string, completedAt: string, configuration?: unknown): HealthSummarySources;
  recordEvent(event: HealthSummaryEvent): void;
}

export interface HealthSummaryPorts {
  transaction<T>(operation: (transaction: HealthSummaryTransaction) => T): Promise<T>;
  deliverPendingToCurrentMain(): Promise<void>;
  reportUnavailable(reason: string): void;
}

export type HealthSummaryContext = {
  enabled: boolean;
  entry: 'worker' | 'runtime' | 'service' | 'help' | 'parse';
  now: string;
  configuration: unknown;
};

export type HealthSummaryResult = {
  status: 'ignored' | 'idle' | 'recorded' | 'unavailable';
  reason: string | null;
  error: { code: 'CONFIGURATION_INVALID'; pointer: string } | null;
  summary: HealthSummaryRecord | null;
};

export type RafHealthView = {
  readAt: string;
  since: string | null;
  error: { code: 'CONFIGURATION_INVALID'; pointer: string } | null;
  unavailableReason: string | null;
  cpu: RafHealthCpuAssessment;
  forcedClose: HealthSource<HealthForceAggregate>;
  summary: {
    startedAt: string | null;
    completedAt: string | null;
    dueAt: string | null;
    delivery: 'pending' | 'delivered' | 'uncertain' | null;
    uncertainDeliveries?: HealthSummaryDeliveryIssue[];
    delayed: boolean;
  };
};

export async function settleRafHealthSummary(
  context: HealthSummaryContext,
  ports: HealthSummaryPorts,
): Promise<HealthSummaryResult> {
  if (!eligible(context)) return result('ignored');
  const error = configurationError(context);
  if (error) {
    report(ports, `Invalid ${error.pointer}`);
    return { ...result('unavailable', `Invalid ${error.pointer}`), error };
  }
  let summary: HealthSummaryRecord | null = null;
  let status: HealthSummaryResult['status'] = 'idle';
  try {
    await ports.transaction(tx => {
      const state = tx.state;
      const due = Date.parse(state.boundary) + interval(context);
      summary = state.lastSummary;
      if (Date.parse(context.now) < due) return;
      const sources = tx.readSources(state.boundary, context.now, context.configuration);
      const event: HealthSummaryEvent = structuredClone({ type: 'raf.health-summary', rafInstanceId: state.rafInstanceId,
        factKey: JSON.stringify(['raf.health-summary', state.rafInstanceId, state.boundary, context.now]),
        startedAt: state.boundary, completedAt: context.now, scheduledAt: new Date(due).toISOString(),
        delayed: Date.parse(context.now) > due, ...projectSources(sources), forcedClose: forceDelta(state.forceBaseline, projectSources(sources).forcedClose) });
      tx.recordEvent(event);
      state.boundary = context.now;
      state.forceBaseline = structuredClone(sources.forcedClose);
      state.lastSummary = { event, delivery: 'pending' };
      summary = structuredClone(state.lastSummary);
      status = 'recorded';
    });
  } catch (error) {
    const reason = message(error);
    report(ports, reason);
    return result('unavailable', reason);
  }
  try { await ports.deliverPendingToCurrentMain(); }
  catch (error) { report(ports, message(error)); }
  return { ...result(status), summary };

}

export async function readRafHealthSummary(
  context: HealthSummaryContext,
  ports: HealthSummaryPorts,
): Promise<RafHealthView> {
  const error = eligible(context) ? configurationError(context) : null;
  const empty: RafHealthView = { readAt: context.now, since: null, error, unavailableReason: error ? `Invalid ${error.pointer}` : null,
    cpu: unavailableCpu(context.now, 'Health CPU is unavailable'),
    forcedClose: { value: null, availability: 'unavailable', reason: 'Forced close accounting is unavailable' },
    summary: { startedAt: null, completedAt: null, dueAt: null, delivery: null, delayed: false } };
  if (!eligible(context)) return empty;
  if (error) { report(ports, empty.unavailableReason!); return empty; }
  try {
    return await ports.transaction(tx => {
      const sources = tx.readSources(tx.state.boundary, context.now, context.configuration);
      const last = tx.state.lastSummary;
      return { ...empty, since: tx.state.since, cpu: sources.cpu, forcedClose: sources.forcedClose,
        summary: { startedAt: last?.event.startedAt ?? null, completedAt: last?.event.completedAt ?? null,
          dueAt: new Date(Date.parse(tx.state.boundary) + interval(context)).toISOString(),
          delivery: last?.delivery ?? null, delayed: last?.event.delayed ?? false } };
    });
  } catch (error) {
    const reason = message(error);
    report(ports, reason);
    return { ...empty, unavailableReason: reason, cpu: unavailableCpu(context.now, reason) };
  }

}

export async function withRafHealthSummary<T>(
  context: HealthSummaryContext,
  ports: HealthSummaryPorts,
  operation: () => Promise<T>,
): Promise<T> {
  try { return await operation(); }
  finally { try { await settleRafHealthSummary(context, ports); } catch (error) { report(ports, message(error)); } }

}

export async function extendRafCommandStats<T extends { commands: unknown; profile: unknown }>(
  stats: T,
  context: HealthSummaryContext,
  ports: HealthSummaryPorts,
): Promise<T & { health: RafHealthView }> {
  await settleRafHealthSummary(context, ports);
  return { ...stats, health: await readRafHealthSummary(context, ports) };

}

function eligible(context: HealthSummaryContext): boolean {
  return context.enabled && (context.entry === 'runtime' || context.entry === 'worker');
}

function interval(context: HealthSummaryContext): number {
  return (context.configuration as { health: { summaryIntervalMs: number } }).health.summaryIntervalMs;
}

function configurationError(context: HealthSummaryContext): RafHealthView['error'] {
  const value = (context.configuration as { health?: { summaryIntervalMs?: unknown } } | null)?.health?.summaryIntervalMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? null
    : { code: 'CONFIGURATION_INVALID', pointer: 'conf/raf.json#/health/summaryIntervalMs' };
}

function result(status: HealthSummaryResult['status'], reason: string | null = null): HealthSummaryResult {
  return { status, reason, error: null, summary: null };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function report(ports: HealthSummaryPorts, reason: string): void {
  try { ports.reportUnavailable(reason); } catch {}
}

export function unavailableCpu(now: string, reason: string): RafHealthCpuAssessment {
  return { availability: 'unavailable', reason, startedAt: null, completedAt: now, wallMs: null,
    cpuUserMs: null, cpuSystemMs: null, cores: null, thresholdCores: null, exceeded: false, sources: [], scopes: null, error: null };
}

function forceDelta(previous: HealthSource<HealthForceAggregate>, current: HealthSource<HealthForceAggregate>): HealthSource<HealthForceAggregate> {
  if (current.availability !== 'complete') return { ...current, value: current.value ? { since: current.value.since, completed: null, refusalsByCode: counts(current.value.refusalsByCode) } : null };
  const before = previous.value;
  const after = current.value;
  if (previous.availability !== 'complete' || current.availability !== 'complete' || !before || !after ||
      !before.since || before.since !== after.since || before.completed === null || after.completed === null || after.completed < before.completed) {
    return { value: null, availability: 'unavailable', reason: current.reason ?? previous.reason ?? 'Matching forced close baseline is unavailable or reset' };
  }
  const refusalsByCode: Record<string, number> = {};
  for (const [code, count] of Object.entries(after.refusalsByCode)) {
    const delta = count - (before.refusalsByCode[code] ?? 0);
    if (delta < 0) return { value: null, availability: 'unavailable', reason: 'Forced close refusal accounting reset' };
    if (delta) refusalsByCode[code] = delta;
  }
  return { value: { since: after.since, completed: after.completed - before.completed, refusalsByCode }, availability: 'complete', reason: null };
}

function counts(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, count]) => Number.isSafeInteger(count) && count >= 0));
}

function projectSources(sources: HealthSummarySources): HealthSummarySources {
  const { cpu, queue, forcedClose } = sources;
  const project = <T, R>(source: HealthSource<T>, value: (input: T) => R): HealthSource<R> => ({
    availability: source.availability, reason: source.reason, value: source.value === null ? null : value(source.value),
  });
  return { eventsByType: project(sources.eventsByType, counts),
    refusalsByCodeAndStage: project(sources.refusalsByCodeAndStage, value => Object.fromEntries(Object.entries(value).map(([code, stages]) => [code, counts(stages)]))),
    queue: project(queue, value => ({ states: counts(value.states), count: value.count, oldestAt: value.oldestAt, oldestAgeMs: value.oldestAgeMs })),
    cpu: { availability: cpu.availability, reason: cpu.reason, startedAt: cpu.startedAt, completedAt: cpu.completedAt,
      wallMs: cpu.wallMs, cpuUserMs: cpu.cpuUserMs, cpuSystemMs: cpu.cpuSystemMs, cores: cpu.cores,
      thresholdCores: cpu.thresholdCores, exceeded: cpu.exceeded, sources: [...cpu.sources],
      scopes: cpu.scopes ? Object.fromEntries(Object.entries(cpu.scopes).filter(([scope]) => ['service', 'worker', 'command'].includes(scope)).map(([scope, totals]) => [scope, { cpuUserMs: totals.cpuUserMs, cpuSystemMs: totals.cpuSystemMs }])) as RafHealthCpuAssessment['scopes'] : null,
      error: cpu.error ? { code: cpu.error.code, pointer: cpu.error.pointer } : null },
    forcedClose: project(forcedClose, value => ({ since: value.since, completed: value.completed, refusalsByCode: counts(value.refusalsByCode) })) };
}
