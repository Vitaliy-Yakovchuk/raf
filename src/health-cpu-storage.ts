import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RafCostKey, RafCostRow } from './raf-cost-profile.ts';
import type { RafHealthCpuProfileReading, RafHealthCpuState } from './health-cpu.ts';

export type HealthCpuWindow = {
  cpu: RafHealthCpuState;
  outside: number;
  attributionComplete: boolean;
  samples: Record<string, number>;
};

export type StoredHealthCpu = HealthCpuWindow & {
  rafInstanceId: string;
  since: string;
  accumulationId: string;
  open: Record<string, string>;
  summary?: HealthCpuWindow;
};

export function initializeHealthCpu(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS raf_health_cpu (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL) STRICT');
  const since = new Date().toISOString();
  const state: StoredHealthCpu = { rafInstanceId: randomUUID(), since, accumulationId: randomUUID(), cpu: { baseline: null, lastAssessment: null }, open: {}, outside: 0, attributionComplete: true, samples: {} };
  db.prepare('INSERT OR IGNORE INTO raf_health_cpu(singleton, payload) VALUES(1, ?)').run(JSON.stringify(state));
}

export function readHealthCpu(db: DatabaseSync): StoredHealthCpu {
  const row = db.prepare('SELECT payload FROM raf_health_cpu WHERE singleton=1').get();
  if (!row) throw new Error('Health CPU domain unavailable');
  return JSON.parse(String(row.payload));
}

export function saveHealthCpu(db: DatabaseSync, state: StoredHealthCpu): void {
  db.prepare('UPDATE raf_health_cpu SET payload=? WHERE singleton=1').run(JSON.stringify(state));
}

export const healthCpuKey = (row: RafCostKey) => JSON.stringify([row.scope, row.command, row.stage, row.executor]);

export function recordHealthCpuCoverage(db: DatabaseSync, startedAt: string | null, row?: RafCostRow, addedSamples = 0): void {
  const state = readHealthCpu(db);
  for (const window of state.summary ? [state, state.summary] : [state]) {
    if (startedAt === null) window.attributionComplete = false;
    else if (window.cpu.baseline && Date.parse(startedAt) < Date.parse(window.cpu.baseline.profile.readAt)) window.outside++;
    if (row) {
      const key = healthCpuKey(row);
      if ((window.samples[key] ?? 0) + addedSamples !== row.samples) window.attributionComplete = false;
      window.samples[key] = row.samples;
    }
  }
  saveHealthCpu(db, state);
}

export function healthCpuReading(state: StoredHealthCpu, profile: RafHealthCpuProfileReading['profile'], monotonicMs: number, window: HealthCpuWindow = state): RafHealthCpuProfileReading {
  const key = (row: RafCostKey) => ({ scope: row.scope, command: row.command, stage: row.stage, executor: row.executor });
  return { profile, accumulationId: state.accumulationId, monotonicMs,
    attributions: profile.rows.map(row => ({ key: key(row), ownership: row.executor === 'self' ? 'self' : 'helper', duplicateOf: null })),
    coverage: { startedAt: window.cpu.baseline?.profile.readAt ?? state.since, completedAt: profile.readAt,
      openOwnIntervals: Object.keys(state.open).length, outOfWindowOwnIntervals: window.outside,
      overlappingSelfIntervals: 0, attributionComplete: window.attributionComplete && profile.rows.every(row => window.samples[healthCpuKey(row)] === row.samples) && Object.keys(window.samples).length === profile.rows.length } };
}

export function resetHealthCpuWindow(window: HealthCpuWindow, baseline: RafHealthCpuProfileReading): void {
  window.cpu.baseline = baseline;
  window.outside = 0;
  window.attributionComplete = true;
  window.samples = Object.fromEntries(baseline.profile.rows.map(row => [healthCpuKey(row), row.samples]));
}
