export type RafCostKey = {
  scope: 'service' | 'worker' | 'command';
  command: string | null;
  stage: string;
  executor: 'self' | 'child';
};

export type RafCpuMeasurement =
  | { userMs: number; systemMs: number; source: string; unavailableReason: null }
  | { userMs: null; systemMs: null; source: string | null; unavailableReason: string };

export type RafCostSample = RafCostKey & {
  startedAt: string;
  completedAt: string;
  wallMs: number;
  cpu: RafCpuMeasurement;
};

export type RafCostRow = RafCostKey & {
  samples: number;
  firstSampleStartedAt: string;
  updatedAt: string;
  wallTotalMs: number;
  wallMeanMs: number;
  cpuSamples: number;
  cpuUnavailableSamples: number;
  cpuUserTotalMs: number | null;
  cpuSystemTotalMs: number | null;
  cpuUserMeanMs: number | null;
  cpuSystemMeanMs: number | null;
  cpuSource: string | string[] | null;
  cpuAvailability: 'complete' | 'partial' | 'unavailable';
  unavailableReason: string | null;
};

export type RafCostProfileSnapshot = {
  schemaVersion: number;
  readAt: string;
  rows: RafCostRow[];
};

export type RafCommandTimingRow = {
  command: string;
  averageMs: number | null;
  updatedAt: string | null;
  budgetMs: number | null;
};

export type RafCommandStatsResult = {
  commands: RafCommandTimingRow[];
  profile: RafCostProfileSnapshot;
};

export interface RafCostProfileState {
  readCostProfile(): RafCostProfileSnapshot;
}

export interface RafCostProfileRepository {
  update(key: RafCostKey, change: (previous: RafCostRow | undefined) => RafCostRow): void;
  readRows(): RafCostRow[];
}

export interface RafCostProfilePorts {
  repository: RafCostProfileRepository;
  monotonicMs(): number;
  utcNow(): string;
  cpuUsage(): { userMicros: number; systemMicros: number };
  policy: { schemaVersion: number; stages: readonly string[]; commands: readonly string[] };
}

export interface RafCostProfiler {
  start(stage: string): void;
  transition(stage: string): void;
  recordChild(sample: Omit<RafCostSample, 'scope' | 'command' | 'executor'>, ownership: 'helper' | 'raf' | 'payload'): void;
  finish(): void;
  snapshot(): RafCostProfileSnapshot;
}

export function aggregateRafCostSample(previous: RafCostRow | undefined, sample: RafCostSample): RafCostRow {
  throw new Error('NotImplemented');
}

export function createRafCostProfiler(identity: Pick<RafCostKey, 'scope' | 'command'>, ports: RafCostProfilePorts): RafCostProfiler {
  throw new Error('NotImplemented');
}

export async function withRafCostProfile<T>(
  profiler: RafCostProfiler,
  stage: string,
  action: () => Promise<T>,
  reportStorageError: (error: unknown, runtimeError: unknown | undefined) => void,
): Promise<T> {
  throw new Error('NotImplemented');
}
