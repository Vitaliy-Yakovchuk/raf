import type { RafCostKey, RafCostProfileSnapshot } from './raf-cost-profile.ts';

export type RafHealthCpuPolicy = {
  cpuWindowMs: number;
  cpuThresholdCores: number;
};

export type RafHealthCpuAttribution = {
  key: RafCostKey;
  ownership: 'self' | 'helper' | 'raf' | 'payload';
  duplicateOf: RafCostKey | null;
};

export type RafHealthCpuProfileReading = {
  profile: RafCostProfileSnapshot;
  accumulationId: string | null;
  monotonicMs: number;
  attributions: RafHealthCpuAttribution[];
  coverage: {
    startedAt: string;
    completedAt: string;
    openOwnIntervals: number;
    outOfWindowOwnIntervals: number;
    overlappingSelfIntervals: number;
    attributionComplete: boolean;
  } | null;
};

export type RafHealthCpuScopeTotals = Record<RafCostKey['scope'], {
  cpuUserMs: number;
  cpuSystemMs: number;
}>;

export type RafHealthCpuAssessment = {
  availability: 'complete' | 'partial' | 'unavailable';
  reason: string | null;
  startedAt: string | null;
  completedAt: string;
  wallMs: number | null;
  cpuUserMs: number | null;
  cpuSystemMs: number | null;
  cores: number | null;
  thresholdCores: number | null;
  exceeded: boolean;
  sources: string[];
  scopes: RafHealthCpuScopeTotals | null;
  error: { code: 'CONFIGURATION_INVALID'; pointer: string } | null;
};

export type RafHealthCpuEvent = {
  type: 'raf.cpu-exceeded';
  rafInstanceId: string;
  startedAt: string;
  completedAt: string;
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cores: number;
  thresholdCores: number;
  sources: string[];
  scopes: RafHealthCpuScopeTotals;
};

export type RafHealthCpuState = {
  baseline: RafHealthCpuProfileReading | null;
  lastAssessment: RafHealthCpuAssessment | null;
};

export interface RafHealthCpuTransaction {
  state: RafHealthCpuState;
  recordEvent(event: RafHealthCpuEvent): void;
}

export interface RafHealthCpuPorts {
  readProfile(): Promise<RafHealthCpuProfileReading>;
  transaction<T>(operation: (transaction: RafHealthCpuTransaction) => T): Promise<T>;
  reportUnavailable(reason: string): void;
}

export type RafHealthCpuContext = {
  rafInstanceId: string;
  enabled: boolean;
  entry: 'runtime' | 'help' | 'parse';
  configuration: unknown;
};

export function evaluateRafHealthCpuWindow(
  baseline: RafHealthCpuProfileReading | null,
  current: RafHealthCpuProfileReading,
  policy: RafHealthCpuPolicy,
): RafHealthCpuAssessment {
  throw new Error('NotImplemented');
}

export async function observeRafHealthCpu(
  context: RafHealthCpuContext,
  ports: RafHealthCpuPorts,
): Promise<RafHealthCpuAssessment | null> {
  throw new Error('NotImplemented');
}

export async function withRafHealthCpu<T>(
  context: RafHealthCpuContext,
  ports: RafHealthCpuPorts,
  operation: () => Promise<T>,
): Promise<T> {
  throw new Error('NotImplemented');
}
