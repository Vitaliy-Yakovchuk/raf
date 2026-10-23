import type { DatabaseSync } from 'node:sqlite';

export type UsageKey = { kind: 'agent' | 'test'; id: string };
export type UsageProcessIdentity = { pid: number; startTicks: string; bootId: string };
export type UsageIdentity = UsageKey & {
  machineId: string;
  bootId: string;
  fence: string;
  root: UsageProcessIdentity | null;
};
export type UsageCompleteness = 'complete' | 'partial' | 'unknown';
export type UsageMethod = {
  name: string;
  scope: string;
  sharedPages?: string;
};
export type UsageEstimate = {
  ramBytes: number;
  diskBytes: Record<string, number>;
  sources: string[];
  confHash: string;
};
export type UsageContext = {
  identity: UsageIdentity;
  project: string;
  agentType: string | null;
  testProfile: string | null;
  items: { project: string; change: string; item: string }[];
  requestedEstimate: UsageEstimate;
  requiredFileSystems: { id: string; paths: string[] }[];
  attributedPaths?: string[];
  resultStatePath?: string;
};
export type UsageFile = {
  fileSystemId: string;
  deviceId: string;
  inode: string;
  path: string;
  allocatedBytes: number;
  logicalBytes: number;
  attribution: { kind: 'run'; key: UsageKey } | { kind: 'shared' | 'foreign' };
};
export type UsageDiskReading = {
  fileSystemId: string;
  files: UsageFile[];
  complete: boolean;
  reasons: string[];
};
export type UsageBaseline = { at: number; disk: UsageDiskReading[] };
export type UsageRamReading = {
  method: 'rss-sampled';
  processes: {
    identity: UsageProcessIdentity;
    parent: UsageProcessIdentity | null;
    rssBytes: number;
  }[];
  complete: boolean;
  reasons: string[];
} | {
  method: 'cgroup-high-water';
  scope: { id: string; identity: UsageIdentity };
  peakBytes: number;
  currentBytes: number;
  complete: boolean;
  reasons: string[];
};
export type UsageObservation = {
  identity: UsageIdentity;
  at: number;
  ram: UsageRamReading | null;
  disk: UsageDiskReading[];
  reasons: string[];
};
export type UsageMetric = {
  peakBytes: number | null;
  currentBytes: number | null;
  method: UsageMethod | null;
  completeness: UsageCompleteness;
  reasons: string[];
};
export type UsageFinishReason = 'exit' | 'signal' | 'timeout' | 'spawn-failure' | 'death';
export type ResourceUsageRecord = {
  context: UsageContext;
  preparedAt: number;
  baseline: UsageBaseline;
  startedAt: number | null;
  lastObservedAt: number | null;
  finishedAt: number | null;
  finishReason: UsageFinishReason | null;
  peakRamBytes: number | null;
  peakDiskBytes: Record<string, number | null>;
  ram: UsageMetric;
  disk: Record<string, UsageMetric>;
  completeness: UsageCompleteness;
  reasons: string[];
};
export type UsageFinish = {
  at: number;
  reason: UsageFinishReason;
  finalObservation?: UsageObservation;
  verifiedComplete: boolean;
  reasons: string[];
};
export type UsageReconciliation = {
  at: number;
  state: 'alive' | 'dead' | 'unknown';
  observation?: UsageObservation;
  reasons: string[];
};
export type UsageRetention = {
  now: number;
  finishedSessionsMs: number;
  retainedTestRunIds: string[];
};
export type UsageConfiguration = {
  flow: {
    retention: { finishedSessionsMs: number };
    unitTests: { timeoutMs: number };
    resourceEstimates: Record<string, unknown>;
    resources: Record<string, unknown>;
  };
  raf: { service: { hostTickIntervalMs: number } };
};
export interface UsageMeasurementPort {
  baseline(context: UsageContext): UsageBaseline;
  sample(identity: UsageIdentity, at: number): UsageObservation;
}
export type UsageTestRunResult = {
  runId: string;
  outcome: string;
  timeoutCount: number;
  knownRed: string[];
  admission: unknown;
  cleanup: unknown;
  resourceUsage?: ResourceUsageRecord | null;
};

const clone = <T>(value: T): T => structuredClone(value);
const processKey = (identity: UsageProcessIdentity) => JSON.stringify([identity.pid, identity.startTicks, identity.bootId]);
const sameProcess = (a: UsageProcessIdentity | null, b: UsageProcessIdentity | null) => a === null ? b === null : b !== null && processKey(a) === processKey(b);
const valid = (value: number) => Number.isSafeInteger(value) && value >= 0;
const unique = (values: string[]) => [...new Set(values)];
const maximum = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
const matches = (a: UsageIdentity, b: UsageIdentity, bind = false) => a.kind === b.kind && a.id === b.id && a.machineId === b.machineId && a.bootId === b.bootId && a.fence === b.fence && (sameProcess(a.root, b.root) || bind && a.root === null);
const empty = (reason: string): UsageMetric => ({ peakBytes: null, currentBytes: null, method: null, completeness: 'unknown', reasons: [reason] });
const summarize = (record: ResourceUsageRecord) => {
  record.peakRamBytes = record.ram.peakBytes;
  record.peakDiskBytes = Object.fromEntries(Object.entries(record.disk).map(([id, metric]) => [id, metric.peakBytes]));
  const metrics = [record.ram, ...Object.values(record.disk)];
  record.reasons = unique([...record.reasons, ...metrics.flatMap(metric => metric.reasons).filter(reason => !reason.endsWith('has not been observed'))]);
  record.completeness = metrics.every(metric => metric.completeness === 'unknown') && record.finishedAt === null ? 'unknown'
    : metrics.every(metric => metric.completeness === 'complete') && !record.reasons.length ? 'complete' : 'partial';
  return record;
};

export function initializeResourceUsage(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS resource_usage (
    kind TEXT NOT NULL CHECK(kind IN ('agent', 'test')),
    run_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(kind, run_id)
  ) STRICT`);
}

export class ResourceUsageRepository {
  private database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
    initializeResourceUsage(database);
  }

  insert(record: ResourceUsageRecord): void {
    this.database.prepare('INSERT INTO resource_usage(kind, run_id, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .run(record.context.identity.kind, record.context.identity.id, JSON.stringify(record));
  }

  get(key: UsageKey): ResourceUsageRecord | null {
    const row = this.database.prepare('SELECT payload FROM resource_usage WHERE kind = ? AND run_id = ?').get(key.kind, key.id);
    return row ? JSON.parse(String(row.payload)) : null;
  }

  merge(identity: UsageIdentity, record: ResourceUsageRecord): boolean {
    for (;;) {
      const old = this.get(identity);
      if (!old || !matches(old.context.identity, identity, true) || !matches(identity, record.context.identity)) return false;
      const next = clone(record);
      if (old.finishedAt !== null) return false;
      if (old.lastObservedAt !== null && (next.lastObservedAt === null || next.lastObservedAt < old.lastObservedAt)) {
        next.ram = { ...clone(old.ram), peakBytes: maximum(old.ram.peakBytes, next.ram.peakBytes) };
        for (const [id, metric] of Object.entries(old.disk)) next.disk[id] = { ...clone(metric), peakBytes: maximum(metric.peakBytes, next.disk[id]?.peakBytes ?? null) };
      }
      next.ram.peakBytes = maximum(old.ram.peakBytes, next.ram.peakBytes);
      for (const [id, metric] of Object.entries(old.disk)) {
        next.disk[id] ??= clone(metric);
        next.disk[id].peakBytes = maximum(metric.peakBytes, next.disk[id].peakBytes);
      }
      next.startedAt = old.startedAt ?? next.startedAt;
      next.lastObservedAt = maximum(old.lastObservedAt, next.lastObservedAt);
      next.reasons = unique([...old.reasons, ...next.reasons]);
      summarize(next);
      const changed = this.database.prepare('UPDATE resource_usage SET payload = ? WHERE kind = ? AND run_id = ? AND payload = ?')
        .run(JSON.stringify(next), identity.kind, identity.id, JSON.stringify(old));
      if (changed.changes) return true;
    }
  }

  listActive(): ResourceUsageRecord[] {
    return this.database.prepare("SELECT payload FROM resource_usage WHERE json_extract(payload, '$.finishedAt') IS NULL").all().map(row => JSON.parse(String(row.payload)));
  }

  prune(retention: UsageRetention): UsageKey[] {
    const removed: UsageKey[] = [];
    for (const row of this.database.prepare('SELECT payload FROM resource_usage').all()) {
      const record: ResourceUsageRecord = JSON.parse(String(row.payload));
      const key = record.context.identity;
      if (record.finishedAt === null || (key.kind === 'agent' ? record.finishedAt > retention.now - retention.finishedSessionsMs : retention.retainedTestRunIds.includes(key.id))) continue;
      if (this.database.prepare('DELETE FROM resource_usage WHERE kind = ? AND run_id = ? AND payload = ?').run(key.kind, key.id, String(row.payload)).changes) removed.push({ kind: key.kind, id: key.id });
    }
    return removed;
  }
}

export class ResourceUsageTracker {
  private repository: ResourceUsageRepository;
  private measurement: UsageMeasurementPort;
  private configuration: UsageConfiguration;
  constructor(options: { repository: ResourceUsageRepository; measurement: UsageMeasurementPort; configuration: UsageConfiguration }) {
    this.repository = options.repository;
    this.measurement = options.measurement;
    this.configuration = options.configuration;
    const cadence = this.configuration.raf.service.hostTickIntervalMs;
    if (!Number.isFinite(cadence) || cadence <= 0) throw new Error('Invalid service.hostTickIntervalMs');
  }

  prepare(context: UsageContext, admitted: boolean, at: number): ResourceUsageRecord | null {
    if (!admitted) return null;
    const existing = this.repository.get(context.identity);
    if (existing) return matches(existing.context.identity, context.identity) ? existing : null;
    let baseline: UsageBaseline;
    try { baseline = this.measurement.baseline(clone(context)); }
    catch { baseline = { at, disk: [] }; }
    const record: ResourceUsageRecord = { context: clone(context), preparedAt: at, baseline: clone(baseline),
      startedAt: null, lastObservedAt: null, finishedAt: null, finishReason: null, peakRamBytes: null, peakDiskBytes: {},
      ram: empty('RAM has not been observed'), disk: Object.fromEntries([...new Set(context.requiredFileSystems.map(fs => fs.id))].map(id => [id, empty('Disk has not been observed')])), completeness: 'unknown', reasons: [] };
    record.context.requiredFileSystems = [...new Map(context.requiredFileSystems.map(fs => [fs.id, { id: fs.id, paths: [...new Set(context.requiredFileSystems.filter(other => other.id === fs.id).flatMap(other => other.paths))] }])).values()];
    record.context.requestedEstimate.sources = unique(record.context.requestedEstimate.sources);
    record.context.items = [...new Map(context.items.map(item => [JSON.stringify(item), item])).values()];
    this.repository.insert(record);
    return this.repository.get(context.identity);
  }

  started(identity: UsageIdentity, at: number): boolean {
    const record = this.repository.get(identity);
    if (!record || record.finishedAt !== null || !matches(record.context.identity, identity, true)) return false;
    record.context.identity = clone(identity);
    record.startedAt ??= at;
    return this.repository.merge(identity, record);
  }

  observe(observation: UsageObservation): boolean {
    const record = this.repository.get(observation.identity);
    if (!record || record.startedAt === null || record.finishedAt !== null || !matches(record.context.identity, observation.identity) || observation.at < record.startedAt || record.lastObservedAt !== null && observation.at < record.lastObservedAt) return false;
    const update = (old: UsageMetric, value: number | null, method: UsageMethod | null, complete: boolean, reasons: string[], peak = value): UsageMetric => ({
      peakBytes: maximum(old.peakBytes, peak), currentBytes: value, method: method ?? old.method,
      completeness: value === null ? old.peakBytes === null ? 'unknown' : 'partial' : complete && !reasons.length ? 'complete' : 'partial',
      reasons: unique(reasons),
    });
    const ram = observation.ram;
    if (!ram) record.ram = update(record.ram, null, null, false, ['RAM measurement unavailable']);
    else if (ram.method === 'cgroup-high-water') {
      const verified = matches(ram.scope.identity, observation.identity) && valid(ram.currentBytes) && valid(ram.peakBytes) && ram.peakBytes >= ram.currentBytes;
      record.ram = update(record.ram, verified ? ram.currentBytes : null, { name: ram.method, scope: ram.scope.id }, verified && ram.complete, [...ram.reasons, ...(!verified ? ['Unverified cgroup identity or counter'] : [])], verified ? ram.peakBytes : null);
    } else {
      const root = observation.identity.root;
      const processes = new Map(ram.processes.map(row => [processKey(row.identity), row]));
      const owned = new Set<string>();
      if (root && processes.has(processKey(root)) && root.bootId === observation.identity.bootId) owned.add(processKey(root));
      for (let size = -1; size !== owned.size;) {
        size = owned.size;
        for (const [key, row] of processes) if (row.parent && owned.has(processKey(row.parent)) && row.identity.bootId === observation.identity.bootId) owned.add(key);
      }
      const values = [...owned].map(key => processes.get(key)!.rssBytes);
      const total = values.reduce((a, b) => a + b, 0);
      const verified = owned.size > 0 && values.every(valid) && valid(total);
      record.ram = update(record.ram, verified ? total : null, { name: ram.method, scope: 'verified process tree; simultaneous RSS sum', sharedPages: 'Shared pages counted once per process RSS; may be counted in multiple processes' }, verified && ram.complete, [...ram.reasons, ...(!verified ? ['Root process identity or RSS unavailable'] : [])]);
    }
    for (const [id, metric] of Object.entries(record.disk)) {
      const readings = observation.disk.filter(row => row.fileSystemId === id);
      const baseline = record.baseline.disk.filter(row => row.fileSystemId === id);
      const reasons = [...readings.flatMap(row => row.reasons), ...baseline.flatMap(row => row.reasons)];
      let invalid = false;
      const index = (readings: UsageDiskReading[]) => {
        const files = new Map<string, number>();
        for (const file of readings.flatMap(row => row.files)) {
          if (file.fileSystemId !== id) continue;
          if (file.attribution.kind === 'foreign') continue;
          if (file.attribution.kind === 'shared') { reasons.push('Shared file attribution is incomplete'); continue; }
          if (file.attribution.kind !== 'run' || file.attribution.key.kind !== observation.identity.kind || file.attribution.key.id !== observation.identity.id) continue;
          if (!valid(file.allocatedBytes)) { invalid = true; reasons.push('Invalid allocated disk bytes'); continue; }
          const key = JSON.stringify([file.deviceId, file.inode]);
          files.set(key, Math.max(files.get(key) ?? 0, file.allocatedBytes));
        }
        return files;
      };
      const before = index(baseline), current = index(readings);
      const bytes = [...current].reduce((sum, [key, value]) => sum + Math.max(0, value - (before.get(key) ?? 0)), 0);
      const available = readings.length > 0 && baseline.length > 0 && baseline.every(row => row.complete) && !invalid && valid(bytes);
      if (!available) reasons.push('Disk observation or pre-spawn baseline unavailable');
      if (readings.some(row => !row.complete) || baseline.some(row => !row.complete)) reasons.push('Disk attribution is partial');
      record.disk[id] = update(metric, available ? bytes : null, { name: 'allocated-files-sampled', scope: 'Run-attributed allocated blocks above pre-spawn baseline, deduplicated by device/inode' }, available && !reasons.length, reasons);
    }
    record.lastObservedAt = observation.at;
    record.reasons = unique([...record.reasons, ...observation.reasons]);
    return this.repository.merge(observation.identity, summarize(record));
  }

  hostTick(at: number): void {
    const cadence = this.configuration.raf.service.hostTickIntervalMs;
    if (!Number.isFinite(cadence) || cadence <= 0) return;
    for (const record of this.repository.listActive()) {
      if (record.startedAt === null || at - (record.lastObservedAt ?? record.startedAt) < cadence) continue;
      try { this.observe(this.measurement.sample(record.context.identity, at)); }
      catch { this.observe({ identity: record.context.identity, at, ram: null, disk: [], reasons: ['Measurement failed during host tick'] }); }
    }
  }

  finish(identity: UsageIdentity, finish: UsageFinish): ResourceUsageRecord | null {
    let record = this.repository.get(identity);
    if (!record || !matches(record.context.identity, identity)) return null;
    if (record.finishedAt !== null) return record;
    if (finish.finalObservation) this.observe(finish.finalObservation);
    record = this.repository.get(identity)!;
    record.finishedAt = finish.at;
    record.finishReason = finish.reason;
    record.reasons = unique([...record.reasons, ...finish.reasons, ...(!finish.verifiedComplete ? ['Final measurement completeness is unverified'] : [])]);
    if (!finish.verifiedComplete) for (const metric of [record.ram, ...Object.values(record.disk)]) if (metric.peakBytes !== null) metric.completeness = 'partial';
    this.repository.merge(identity, summarize(record));
    return this.repository.get(identity);
  }

  reconcile(identity: UsageIdentity, reconciliation: UsageReconciliation): ResourceUsageRecord | null {
    const record = this.repository.get(identity);
    if (!record || !matches(record.context.identity, identity)) return null;
    if (record.finishedAt !== null) return record;
    if (reconciliation.observation) this.observe(reconciliation.observation);
    if (reconciliation.state === 'dead') return this.finish(identity, { at: reconciliation.at, reason: 'death', verifiedComplete: false, reasons: reconciliation.reasons });
    if (reconciliation.state === 'alive' && reconciliation.reasons.length) {
      const updated = this.repository.get(identity)!;
      updated.reasons = unique([...updated.reasons, ...reconciliation.reasons]);
      this.repository.merge(identity, summarize(updated));
    }
    if (reconciliation.state === 'unknown') this.observe({ identity, at: reconciliation.at, ram: null, disk: [], reasons: [...reconciliation.reasons, 'Process liveness unknown during reconciliation'] });
    return this.repository.get(identity);
  }

  currentConsumption(key: UsageKey): { ramBytes: number | null; diskBytes: Record<string, number | null> } | null {
    const record = this.repository.get(key);
    return record ? { ramBytes: record.ram.currentBytes, diskBytes: Object.fromEntries(Object.entries(record.disk).map(([id, metric]) => [id, metric.currentBytes])) } : null;
  }

  attachTestRunResult<T extends { runId: string }>(result: T): T & { resourceUsage: ResourceUsageRecord | null } {
    return { ...result, resourceUsage: this.repository.get({ kind: 'test', id: result.runId }) };
  }
}
