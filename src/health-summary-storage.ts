import { redactDiagnostic } from './cli-contract.ts';
import { guardDatabase } from './database-read-limit.ts';
import type { DatabaseSync } from 'node:sqlite';
import { evaluateRafHealthCpuWindow, type RafHealthCpuProfileReading } from './health-cpu.ts';
import { readHealthCpu } from './health-cpu-storage.ts';
import { readForcedCloseMetrics } from './forced-close-metrics.ts';
import { unavailableCpu, type HealthSummaryState, type HealthSummarySources, type HealthSource, type HealthForceAggregate, type HealthRefusalDiagnostic } from './health-summary.ts';

export function forceSource(db: DatabaseSync, now: string): HealthSource<HealthForceAggregate> {
  guardDatabase(db);
  const value = readForcedCloseMetrics(db, now);
  return { value: { since: value.since, completed: value.completed, refusalsByCode: value.refusalsByCode },
    availability: value.unavailableReason ? 'unavailable' : 'complete', reason: value.unavailableReason };
}

export function initializeHealthSummary(db: DatabaseSync): void {
  guardDatabase(db);
  db.exec('CREATE TABLE IF NOT EXISTS raf_health_summary (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL, events TEXT NOT NULL, refusals TEXT NOT NULL) STRICT');
  const domain = readHealthCpu(db);
  const since = new Date().toISOString();
  const state: HealthSummaryState = { rafInstanceId: domain.rafInstanceId, since, boundary: since,
    forceBaseline: forceSource(db, since), lastSummary: null };
  db.prepare('INSERT OR IGNORE INTO raf_health_summary VALUES(1, ?, ?, ?)').run(JSON.stringify(state), '{}', '{}');
}

export function readHealthSummary(db: DatabaseSync): HealthSummaryState {
  guardDatabase(db);
  const row = db.prepare('SELECT payload FROM raf_health_summary WHERE singleton=1').get();
  if (!row) throw new Error('Health summary accounting unavailable');
  return JSON.parse(String(row.payload));
}

export function saveHealthSummary(db: DatabaseSync, state: HealthSummaryState, reset: boolean): void {
  guardDatabase(db);
  if (reset) state = { ...state, refusalDiagnostics: [] };
  db.prepare('UPDATE raf_health_summary SET payload=? WHERE singleton=1').run(JSON.stringify(state));
  if (reset) db.prepare("UPDATE raf_health_summary SET events='{}', refusals='{}' WHERE singleton=1").run();
}

export function recordHealthEvent(db: DatabaseSync, kind: string): void {
  guardDatabase(db);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raf_health_summary'").get()) return;
    const row = db.prepare('SELECT events FROM raf_health_summary WHERE singleton=1').get();
    if (!row) return;
    const counts = JSON.parse(String(row.events));
    Object.defineProperty(counts, kind, { value: (Object.hasOwn(counts, kind) ? counts[kind] : 0) + 1, enumerable: true, writable: true, configurable: true });
    db.prepare('UPDATE raf_health_summary SET events=? WHERE singleton=1').run(JSON.stringify(counts));
  } catch (error) { if ((error as { code?: string })?.code === 'DB_ROWS_READ_LIMIT_EXCEEDED') throw error; process.emitWarning(String(error)); }
}

export function recordHealthRefusal(db: DatabaseSync, code: string, stage: string, details: Partial<Pick<HealthRefusalDiagnostic, 'command' | 'source' | 'sourceCode' | 'reason'>> = {}): void {
  guardDatabase(db);
  const row = db.prepare('SELECT refusals FROM raf_health_summary WHERE singleton=1').get();
  if (!row) return;
  const counts = JSON.parse(String(row.refusals));
  if (!Object.hasOwn(counts, code)) Object.defineProperty(counts, code, { value: {}, enumerable: true, writable: true });
  counts[code][stage] = (Object.hasOwn(counts[code], stage) ? counts[code][stage] : 0) + 1;
  const state = readHealthSummary(db);
  const diagnostic = redactDiagnostic({ code, stage, command: details.command ?? null, source: details.source ?? null,
    sourceCode: details.sourceCode ?? null, reason: details.reason ?? null }) as Omit<HealthRefusalDiagnostic, 'count'>;
  const records = state.refusalDiagnostics ??= [];
  const existing = records.find(({ count, ...facts }) => JSON.stringify(facts) === JSON.stringify(diagnostic));
  if (existing) existing.count++;
  else records.push({ ...diagnostic, count: 1 });
  db.prepare('UPDATE raf_health_summary SET refusals=?, payload=? WHERE singleton=1').run(JSON.stringify(counts), JSON.stringify(state));
}

export function readHealthSources(db: DatabaseSync, startedAt: string, completedAt: string, current: RafHealthCpuProfileReading, configuration: unknown): HealthSummarySources {
  guardDatabase(db);
  const row = db.prepare('SELECT events, refusals FROM raf_health_summary WHERE singleton=1').get()!;
  const baseline = readHealthCpu(db).summary?.cpu.baseline ?? null;
  const threshold = (configuration as { health?: { cpuThresholdCores?: number } } | null)?.health?.cpuThresholdCores;
  const cpu = typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0
    ? { ...unavailableCpu(completedAt, 'Invalid conf/raf.json#/health/cpuThresholdCores'),
      error: { code: 'CONFIGURATION_INVALID' as const, pointer: 'conf/raf.json#/health/cpuThresholdCores' } }
    : baseline?.profile.readAt !== startedAt ? unavailableCpu(completedAt, 'Missing initial CPU profile snapshot for the summary period')
      : evaluateRafHealthCpuWindow(baseline, current, { cpuWindowMs: 0, cpuThresholdCores: threshold });
  const diagnostics = readHealthSummary(db).refusalDiagnostics ?? [];
  const total = Object.values(JSON.parse(String(row.refusals))).reduce<number>((sum, stages) => sum + Object.values(stages as Record<string, number>).reduce((a, b) => a + b, 0), 0);
  const complete = diagnostics.reduce((sum, entry) => sum + entry.count, 0) === total && diagnostics.every(entry => entry.command !== null && entry.source !== null);
  return { refusalDiagnostics: { value: diagnostics, availability: complete ? 'complete' : 'partial', reason: complete ? null : 'Some refusals were recorded without command or source diagnostics' },
    eventsByType: { value: JSON.parse(String(row.events)), availability: 'complete', reason: null },
    refusalsByCodeAndStage: { value: JSON.parse(String(row.refusals)), availability: 'complete', reason: null },
    queue: { value: null, availability: 'unavailable', reason: 'Resource-wait pending snapshot is owned by its live coordinator and is unavailable in SQLite' },
    cpu: { ...cpu, startedAt: cpu.startedAt ?? startedAt }, forcedClose: forceSource(db, completedAt) };
}
