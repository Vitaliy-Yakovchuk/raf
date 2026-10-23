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

export class ResourceUsageRepository {
  constructor(database: DatabaseSync) {
    throw new Error('NotImplemented');
  }

  insert(record: ResourceUsageRecord): void {
    throw new Error('NotImplemented');
  }

  get(key: UsageKey): ResourceUsageRecord | null {
    throw new Error('NotImplemented');
  }

  merge(identity: UsageIdentity, record: ResourceUsageRecord): boolean {
    throw new Error('NotImplemented');
  }

  listActive(): ResourceUsageRecord[] {
    throw new Error('NotImplemented');
  }

  prune(retention: UsageRetention): UsageKey[] {
    throw new Error('NotImplemented');
  }
}

export class ResourceUsageTracker {
  constructor(options: {
    repository: ResourceUsageRepository;
    measurement: UsageMeasurementPort;
    configuration: UsageConfiguration;
  }) {
    throw new Error('NotImplemented');
  }

  prepare(context: UsageContext, admitted: boolean, at: number): ResourceUsageRecord | null {
    throw new Error('NotImplemented');
  }

  started(identity: UsageIdentity, at: number): boolean {
    throw new Error('NotImplemented');
  }

  observe(observation: UsageObservation): boolean {
    throw new Error('NotImplemented');
  }

  hostTick(at: number): void {
    throw new Error('NotImplemented');
  }

  finish(identity: UsageIdentity, finish: UsageFinish): ResourceUsageRecord | null {
    throw new Error('NotImplemented');
  }

  reconcile(identity: UsageIdentity, reconciliation: UsageReconciliation): ResourceUsageRecord | null {
    throw new Error('NotImplemented');
  }

  currentConsumption(key: UsageKey): { ramBytes: number | null; diskBytes: Record<string, number | null> } | null {
    throw new Error('NotImplemented');
  }

  attachTestRunResult(result: UsageTestRunResult): UsageTestRunResult {
    throw new Error('NotImplemented');
  }
}
