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

export type HealthSummaryRecord = {
  event: HealthSummaryEvent;
  delivery: 'pending' | 'delivered';
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
  readSources(startedAt: string, completedAt: string): HealthSummarySources;
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
    delivery: 'pending' | 'delivered' | null;
    delayed: boolean;
  };
};

export async function settleRafHealthSummary(
  context: HealthSummaryContext,
  ports: HealthSummaryPorts,
): Promise<HealthSummaryResult> {
  throw new Error('NotImplemented');
}

export async function readRafHealthSummary(
  context: HealthSummaryContext,
  ports: HealthSummaryPorts,
): Promise<RafHealthView> {
  throw new Error('NotImplemented');
}

export async function withRafHealthSummary<T>(
  context: HealthSummaryContext,
  ports: HealthSummaryPorts,
  operation: () => Promise<T>,
): Promise<T> {
  throw new Error('NotImplemented');
}

export async function extendRafCommandStats<T extends { commands: unknown; profile: unknown }>(
  stats: T,
  context: HealthSummaryContext,
  ports: HealthSummaryPorts,
): Promise<T & { health: RafHealthView }> {
  throw new Error('NotImplemented');
}
