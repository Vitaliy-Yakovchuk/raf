import type { DatabaseSync } from 'node:sqlite';
import { evaluateRafHealthCpuWindow, type RafHealthCpuProfileReading } from './health-cpu.ts';
import { readHealthCpu } from './health-cpu-storage.ts';
import { readForcedCloseMetrics } from './forced-close-metrics.ts';
import { unavailableCpu, type HealthSummaryState, type HealthSummarySources, type HealthSource, type HealthForceAggregate } from './health-summary.ts';

export function forceSource(db: DatabaseSync, now: string): HealthSource<HealthForceAggregate> {
  const value = readForcedCloseMetrics(db, now);
  return { value: { since: value.since, completed: value.completed, refusalsByCode: value.refusalsByCode },
    availability: value.unavailableReason ? 'unavailable' : 'complete', reason: value.unavailableReason };
}

export function initializeHealthSummary(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS raf_health_summary (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL, events TEXT NOT NULL, refusals TEXT NOT NULL) STRICT');
  const domain = readHealthCpu(db);
  const since = new Date().toISOString();
  const state: HealthSummaryState = { rafInstanceId: domain.rafInstanceId, since, boundary: since,
    forceBaseline: forceSource(db, since), lastSummary: null };
  db.prepare('INSERT OR IGNORE INTO raf_health_summary VALUES(1, ?, ?, ?)').run(JSON.stringify(state), '{}', '{}');
}

export function readHealthSummary(db: DatabaseSync): HealthSummaryState {
  const row = db.prepare('SELECT payload FROM raf_health_summary WHERE singleton=1').get();
  if (!row) throw new Error('Health summary accounting unavailable');
  return JSON.parse(String(row.payload));
}

export function saveHealthSummary(db: DatabaseSync, state: HealthSummaryState, reset: boolean): void {
  db.prepare('UPDATE raf_health_summary SET payload=? WHERE singleton=1').run(JSON.stringify(state));
  if (reset) db.prepare("UPDATE raf_health_summary SET events='{}', refusals='{}' WHERE singleton=1").run();
}

export function recordHealthEvent(db: DatabaseSync, kind: string): void {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raf_health_summary'").get()) return;
    const row = db.prepare('SELECT events FROM raf_health_summary WHERE singleton=1').get();
    if (!row) return;
    const counts = JSON.parse(String(row.events));
    Object.defineProperty(counts, kind, { value: (Object.hasOwn(counts, kind) ? counts[kind] : 0) + 1, enumerable: true, writable: true, configurable: true });
    db.prepare('UPDATE raf_health_summary SET events=? WHERE singleton=1').run(JSON.stringify(counts));
  } catch (error) { process.emitWarning(String(error)); }
}

export function recordHealthRefusal(db: DatabaseSync, code: string, stage: string): void {
  const row = db.prepare('SELECT refusals FROM raf_health_summary WHERE singleton=1').get();
  if (!row) return;
  const counts = JSON.parse(String(row.refusals));
  if (!Object.hasOwn(counts, code)) Object.defineProperty(counts, code, { value: {}, enumerable: true, writable: true });
  counts[code][stage] = (Object.hasOwn(counts[code], stage) ? counts[code][stage] : 0) + 1;
  db.prepare('UPDATE raf_health_summary SET refusals=? WHERE singleton=1').run(JSON.stringify(counts));
}

export function readHealthSources(db: DatabaseSync, startedAt: string, completedAt: string, current: RafHealthCpuProfileReading, configuration: unknown): HealthSummarySources {
  const row = db.prepare('SELECT events, refusals FROM raf_health_summary WHERE singleton=1').get()!;
  const baseline = readHealthCpu(db).summary?.cpu.baseline ?? null;
  const threshold = (configuration as { health?: { cpuThresholdCores?: number } } | null)?.health?.cpuThresholdCores;
  const cpu = typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0
    ? { ...unavailableCpu(completedAt, 'Invalid conf/raf.json#/health/cpuThresholdCores'),
      error: { code: 'CONFIGURATION_INVALID' as const, pointer: 'conf/raf.json#/health/cpuThresholdCores' } }
    : baseline?.profile.readAt !== startedAt ? unavailableCpu(completedAt, 'Missing initial CPU profile snapshot for the summary period')
      : evaluateRafHealthCpuWindow(baseline, current, { cpuWindowMs: 0, cpuThresholdCores: threshold });
  return { eventsByType: { value: JSON.parse(String(row.events)), availability: 'complete', reason: null },
    refusalsByCodeAndStage: { value: JSON.parse(String(row.refusals)), availability: 'complete', reason: null },
    queue: { value: null, availability: 'unavailable', reason: 'Resource-wait pending snapshot is owned by its live coordinator and is unavailable in SQLite' },
    cpu: { ...cpu, startedAt: cpu.startedAt ?? startedAt }, forcedClose: forceSource(db, completedAt) };
}
