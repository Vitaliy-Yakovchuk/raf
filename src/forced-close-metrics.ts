export interface ForcedCloseMetricsDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...parameters: (string | number | null)[]): Record<string, unknown> | undefined;
    run(...parameters: (string | number | null)[]): { changes: number | bigint };
  };
}

export type ForcedCloseMetricsSnapshot = {
  readAt: string;
  since: string | null;
  completed: number | null;
  refusalsByCode: Record<string, number>;
  unavailableReason: string | null;
};

export type ForcedCloseMetricsPeriod = {
  startedAt: string | null;
  completedAt: string;
  since: string | null;
  completed: number | null;
  unavailableReason: string | null;
};

export type ForcedCloseFinalization = {
  runId: string;
  previousState: 'reserved' | 'running' | 'exited' | 'finished';
  forced: boolean;
  finishedAt: string;
};

export function recordForcedCloseFinalizationInTransaction(
  database: ForcedCloseMetricsDatabase,
  finalization: ForcedCloseFinalization,
): void {
  throw new Error('NotImplemented');
}

export function recordForcedCloseRefusalInTransaction(
  database: ForcedCloseMetricsDatabase,
  code: string,
  observedAt: string,
): void {
  throw new Error('NotImplemented');
}

export function readForcedCloseMetrics(
  database: ForcedCloseMetricsDatabase,
  readAt: string,
): ForcedCloseMetricsSnapshot {
  throw new Error('NotImplemented');
}

export function forcedCloseMetricsPeriod(
  previous: ForcedCloseMetricsSnapshot | null,
  current: ForcedCloseMetricsSnapshot,
): ForcedCloseMetricsPeriod {
  throw new Error('NotImplemented');
}
