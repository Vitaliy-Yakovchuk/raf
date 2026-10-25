import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RafCostKey, RafCostRow } from './raf-cost-profile.ts';
import type { RafHealthCpuProfileReading, RafHealthCpuState } from './health-cpu.ts';

export type StoredHealthCpu = {
  rafInstanceId: string;
  since: string;
  accumulationId: string;
  cpu: RafHealthCpuState;
  open: Record<string, string>;
  outside: number;
  attributionComplete: boolean;
  samples: Record<string, number>;
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
  if (startedAt === null) state.attributionComplete = false;
  else if (state.cpu.baseline && Date.parse(startedAt) < Date.parse(state.cpu.baseline.profile.readAt)) state.outside++;
  if (row) {
    const key = healthCpuKey(row);
    if ((state.samples[key] ?? 0) + addedSamples !== row.samples) state.attributionComplete = false;
    state.samples[key] = row.samples;
  }
  saveHealthCpu(db, state);
}

export function healthCpuReading(state: StoredHealthCpu, profile: RafHealthCpuProfileReading['profile'], monotonicMs: number): RafHealthCpuProfileReading {
  const key = (row: RafCostKey) => ({ scope: row.scope, command: row.command, stage: row.stage, executor: row.executor });
  return { profile, accumulationId: state.accumulationId, monotonicMs,
    attributions: profile.rows.map(row => ({ key: key(row), ownership: row.executor === 'self' ? 'self' : 'helper', duplicateOf: null })),
    coverage: { startedAt: state.cpu.baseline?.profile.readAt ?? state.since, completedAt: profile.readAt,
      openOwnIntervals: Object.keys(state.open).length, outOfWindowOwnIntervals: state.outside,
      overlappingSelfIntervals: 0, attributionComplete: state.attributionComplete && profile.rows.every(row => state.samples[healthCpuKey(row)] === row.samples) && Object.keys(state.samples).length === profile.rows.length } };
}
