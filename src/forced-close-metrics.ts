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

function timestamp(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Invalid forced close metric timestamp');
  return time;
}

function requireTransaction(database: ForcedCloseMetricsDatabase): void {
  if (!database.isTransaction) throw new Error('Forced close metrics require an active transaction');
}

export function initializeForcedCloseMetricsInTransaction(database: ForcedCloseMetricsDatabase, since: string): void {
  requireTransaction(database);
  timestamp(since);
  database.exec(`CREATE TABLE IF NOT EXISTS raf_forced_close_metrics (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    since TEXT NOT NULL,
    completed INTEGER NOT NULL CHECK(completed >= 0),
    refusals_json TEXT NOT NULL
  ) STRICT`);
  database.prepare('INSERT INTO raf_forced_close_metrics(singleton, since, completed, refusals_json) VALUES (1, ?, 0, ?) ON CONFLICT(singleton) DO NOTHING').run(since, '{}');
}

export function recordForcedCloseFinalizationInTransaction(
  database: ForcedCloseMetricsDatabase,
  finalization: ForcedCloseFinalization,
): void {
  requireTransaction(database);
  if (!finalization.runId.trim()) throw new Error('Forced close finalization requires a runId');
  timestamp(finalization.finishedAt);
  if (!finalization.forced || finalization.previousState !== 'exited') return;
  const current = readForcedCloseMetrics(database, finalization.finishedAt);
  if (current.unavailableReason) throw new Error(current.unavailableReason);
  database.prepare('UPDATE raf_forced_close_metrics SET completed = completed + 1 WHERE singleton = 1').run();
}

export function recordForcedCloseRefusalInTransaction(
  database: ForcedCloseMetricsDatabase,
  code: string,
  observedAt: string,
): void {
  requireTransaction(database);
  if (!code.trim()) throw new Error('Forced close refusal requires a code');
  const current = readForcedCloseMetrics(database, observedAt);
  if (current.unavailableReason) throw new Error(current.unavailableReason);
  const refusals = { ...current.refusalsByCode };
  refusals[code] = (Object.hasOwn(refusals, code) ? refusals[code] : 0) + 1;
  database.prepare('UPDATE raf_forced_close_metrics SET refusals_json = ? WHERE singleton = 1').run(JSON.stringify(refusals));
}

export function readForcedCloseMetrics(
  database: ForcedCloseMetricsDatabase,
  readAt: string,
): ForcedCloseMetricsSnapshot {
  timestamp(readAt);
  try {
    const row = database.prepare('SELECT since, completed, refusals_json FROM raf_forced_close_metrics WHERE singleton = 1').get();
    if (!row) throw new Error('Forced close accounting has not started; historical totals are unavailable');
    const since = String(row.since);
    timestamp(since);
    if (!Number.isSafeInteger(row.completed) || Number(row.completed) < 0) throw new Error('Invalid forced close completed aggregate');
    const refusals: unknown = JSON.parse(String(row.refusals_json));
    if (!refusals || typeof refusals !== 'object' || Array.isArray(refusals) || Object.values(refusals).some(value => !Number.isSafeInteger(value) || Number(value) < 0)) throw new Error('Invalid forced close refusal aggregate');
    return { readAt, since, completed: Number(row.completed), refusalsByCode: refusals as Record<string, number>, unavailableReason: null };
  } catch (error) {
    return { readAt, since: null, completed: null, refusalsByCode: {}, unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}

export function forcedCloseMetricsPeriod(
  previous: ForcedCloseMetricsSnapshot | null,
  current: ForcedCloseMetricsSnapshot,
): ForcedCloseMetricsPeriod {
  const completedAt = timestamp(current.readAt);
  let unavailableReason = current.unavailableReason;
  if (!unavailableReason && (current.completed === null || !current.since || previous && (previous.unavailableReason || previous.completed === null || previous.since !== current.since))) unavailableReason = 'A matching forced close accounting baseline is unavailable; historical totals are unknown';
  if (!unavailableReason && previous && (timestamp(previous.readAt) > completedAt || current.completed! < previous.completed!)) unavailableReason = 'Forced close accounting interval or cumulative total regressed';
  return { startedAt: previous?.readAt ?? current.since, completedAt: current.readAt, since: current.since, completed: unavailableReason ? null : current.completed! - (previous?.completed ?? 0), unavailableReason };
}
