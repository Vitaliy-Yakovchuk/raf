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
  const result: RafHealthCpuAssessment = {
    availability: 'unavailable', reason: null, startedAt: baseline?.profile.readAt ?? null,
    completedAt: current.profile.readAt, wallMs: baseline ? current.monotonicMs - baseline.monotonicMs : null,
    cpuUserMs: null, cpuSystemMs: null, cores: null, thresholdCores: policy.cpuThresholdCores,
    exceeded: false, sources: [], scopes: null, error: null,
  };
  const unavailable = (reason: string, availability: 'partial' | 'unavailable' = 'unavailable') => ({ ...result, availability, reason });
  if (!baseline) return unavailable('Missing initial profile baseline');
  if (!baseline.accumulationId || !current.accumulationId) return unavailable('Unknown profile accumulation start');
  if (baseline.accumulationId !== current.accumulationId || baseline.profile.schemaVersion !== current.profile.schemaVersion) return unavailable('Profile accumulation changed or reset');
  if (!Number.isFinite(result.wallMs) || result.wallMs! <= 0 || !Number.isFinite(Date.parse(result.startedAt!)) || !Number.isFinite(Date.parse(result.completedAt)) || Date.parse(result.completedAt) <= Date.parse(result.startedAt!)) return unavailable('Invalid profile window boundaries');
  if (result.wallMs! < policy.cpuWindowMs) return unavailable('CPU window not yet complete', 'partial');
  const coverage = current.coverage;
  if (!coverage) return unavailable('Profile interval coverage unavailable');
  if (!coverage.attributionComplete) return unavailable('Profile attribution incomplete', 'partial');
  if (coverage.openOwnIntervals !== 0) return unavailable('Unfinished own CPU intervals', 'partial');
  if (coverage.outOfWindowOwnIntervals !== 0) return unavailable('Own CPU intervals outside window', 'partial');
  if (coverage.overlappingSelfIntervals !== 0) return unavailable('Overlapping self CPU intervals', 'partial');
  if (Date.parse(coverage.startedAt) !== Date.parse(result.startedAt!) || Date.parse(coverage.completedAt) !== Date.parse(result.completedAt)) return unavailable('Profile coverage does not match window boundaries', 'partial');
  const key = (value: RafCostKey) => JSON.stringify([value.scope, value.command, value.stage, value.executor]);
  const before = new Map(baseline.profile.rows.map(row => [key(row), row]));
  const after = new Map(current.profile.rows.map(row => [key(row), row]));
  const attributions = new Map(current.attributions.map(value => [key(value.key), value]));
  if (after.size !== current.profile.rows.length || attributions.size !== current.attributions.length) return unavailable('Duplicate profile attribution or aggregate key');
  const scopes: RafHealthCpuScopeTotals = { service: { cpuUserMs: 0, cpuSystemMs: 0 }, worker: { cpuUserMs: 0, cpuSystemMs: 0 }, command: { cpuUserMs: 0, cpuSystemMs: 0 } };
  const sources = new Set<string>();
  let measuredSamples = 0;
  for (const [id, previous] of before) {
    const attribution = attributions.get(id) ?? baseline.attributions.find(value => key(value.key) === id);
    if (!after.has(id) && attribution && (attribution.ownership === 'self' || attribution.ownership === 'helper') && !attribution.duplicateOf) return unavailable('Profile own aggregate disappeared or reset');
  }
  for (const [id, row] of after) {
    const attribution = attributions.get(id);
    if (!attribution) return unavailable('Missing profile ownership attribution', 'partial');
    if (attribution.ownership === 'payload' || attribution.ownership === 'raf' || attribution.duplicateOf) continue;
    if ((attribution.ownership === 'self') !== (row.executor === 'self')) return unavailable('Invalid profile ownership attribution');
    const previous = before.get(id);
    if (previous && (previous.firstSampleStartedAt !== row.firstSampleStartedAt || row.samples < previous.samples)) return unavailable('Profile aggregate reset');
    const deltaSamples = row.samples - (previous?.samples ?? 0);
    if (!Number.isSafeInteger(deltaSamples) || deltaSamples < 0) return unavailable('Invalid profile sample count');
    const unavailableSamples = row.cpuUnavailableSamples - (previous?.cpuUnavailableSamples ?? 0);
    if (unavailableSamples < 0) return unavailable('Profile CPU aggregate reset');
    if (unavailableSamples > 0 || (deltaSamples > 0 && row.cpuSamples - (previous?.cpuSamples ?? 0) !== deltaSamples)) return unavailable(row.unavailableReason ?? 'Profile CPU incomplete or unavailable', row.cpuAvailability === 'partial' ? 'partial' : 'unavailable');
    if (!deltaSamples) {
      if (previous && (row.cpuUserTotalMs !== previous.cpuUserTotalMs || row.cpuSystemTotalMs !== previous.cpuSystemTotalMs)) return unavailable('Profile counters changed without completed samples');
      continue;
    }
    measuredSamples += deltaSamples;
    if (!previous && Date.parse(row.firstSampleStartedAt) < Date.parse(result.startedAt!)) return unavailable('New profile row includes out-of-window intervals', 'partial');
    if (!Number.isFinite(Date.parse(row.updatedAt)) || Date.parse(row.updatedAt) > Date.parse(result.completedAt) || Date.parse(row.updatedAt) < Date.parse(result.startedAt!)) return unavailable('Profile sample lies outside window', 'partial');
    const user = row.cpuUserTotalMs === null ? NaN : row.cpuUserTotalMs - (previous?.cpuUserTotalMs ?? 0);
    const system = row.cpuSystemTotalMs === null ? NaN : row.cpuSystemTotalMs - (previous?.cpuSystemTotalMs ?? 0);
    if (![user, system].every(value => Number.isFinite(value) && value >= 0)) return unavailable('Invalid or reset profile CPU counters');
    if (!scopes[row.scope]) return unavailable('Unknown profile CPU scope');
    scopes[row.scope].cpuUserMs += user;
    scopes[row.scope].cpuSystemMs += system;
    for (const source of Array.isArray(row.cpuSource) ? row.cpuSource : row.cpuSource ? [row.cpuSource] : []) sources.add(source);
  }
  if (!measuredSamples) return unavailable('No completed measured own CPU samples');
  const cpuUserMs = Object.values(scopes).reduce((sum, scope) => sum + scope.cpuUserMs, 0);
  const cpuSystemMs = Object.values(scopes).reduce((sum, scope) => sum + scope.cpuSystemMs, 0);
  const cores = (cpuUserMs + cpuSystemMs) / result.wallMs!;
  if (!Number.isFinite(cores)) return unavailable('Invalid profile CPU total');
  return { ...result, availability: 'complete', reason: null, cpuUserMs, cpuSystemMs, cores, scopes, sources: [...sources].sort(), exceeded: cores > policy.cpuThresholdCores };
}

export async function observeRafHealthCpu(
  context: RafHealthCpuContext,
  ports: RafHealthCpuPorts,
): Promise<RafHealthCpuAssessment | null> {
  if (!context.enabled || context.entry !== 'runtime') return null;
  const health = (context.configuration as { health?: Partial<RafHealthCpuPolicy> } | null)?.health;
  const invalid = !Number.isFinite(health?.cpuWindowMs) || health!.cpuWindowMs! <= 0 ? 'cpuWindowMs'
    : !Number.isFinite(health?.cpuThresholdCores) || health!.cpuThresholdCores! < 0 ? 'cpuThresholdCores' : null;
  const report = (reason: string) => { try { ports.reportUnavailable(reason); } catch {} };
  if (invalid) {
    const pointer = `conf/raf.json#/health/${invalid}`;
    const reason = `Invalid ${pointer}`;
    report(reason);
    return { availability: 'unavailable', reason, startedAt: null, completedAt: new Date().toISOString(), wallMs: null, cpuUserMs: null, cpuSystemMs: null, cores: null, thresholdCores: null, exceeded: false, sources: [], scopes: null, error: { code: 'CONFIGURATION_INVALID', pointer } };
  }
  try {
    const current = await ports.readProfile();
    return await ports.transaction(transaction => {
      const baseline = transaction.state.baseline;
      if (baseline && baseline.accumulationId === current.accumulationId && baseline.monotonicMs >= current.monotonicMs && Date.parse(current.profile.readAt) <= Date.parse(baseline.profile.readAt) && transaction.state.lastAssessment) return transaction.state.lastAssessment;
      const assessment = evaluateRafHealthCpuWindow(baseline, current, health as RafHealthCpuPolicy);
      if (assessment.exceeded) transaction.recordEvent({ type: 'raf.cpu-exceeded', rafInstanceId: context.rafInstanceId,
        startedAt: assessment.startedAt!, completedAt: assessment.completedAt, wallMs: assessment.wallMs!,
        cpuUserMs: assessment.cpuUserMs!, cpuSystemMs: assessment.cpuSystemMs!, cores: assessment.cores!,
        thresholdCores: assessment.thresholdCores!, sources: assessment.sources, scopes: assessment.scopes! });
      if (!baseline || baseline.accumulationId !== current.accumulationId || current.monotonicMs < baseline.monotonicMs || current.monotonicMs - baseline.monotonicMs >= health!.cpuWindowMs!) transaction.state.baseline = current;
      transaction.state.lastAssessment = assessment;
      return assessment;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    report(reason);
    return { availability: 'unavailable', reason, startedAt: null, completedAt: new Date().toISOString(), wallMs: null, cpuUserMs: null, cpuSystemMs: null, cores: null, thresholdCores: health!.cpuThresholdCores!, exceeded: false, sources: [], scopes: null, error: null };
  }
}

export async function withRafHealthCpu<T>(
  context: RafHealthCpuContext,
  ports: RafHealthCpuPorts,
  operation: () => Promise<T>,
): Promise<T> {
  try { return await operation(); }
  finally { try { await observeRafHealthCpu(context, ports); } catch {} }
}
