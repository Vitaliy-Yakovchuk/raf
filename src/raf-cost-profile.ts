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
  validateSample(sample);
  if (previous && (previous.scope !== sample.scope || previous.command !== sample.command || previous.stage !== sample.stage || previous.executor !== sample.executor)) throw new Error('Cost profile aggregate key mismatch');
  const measured = sample.cpu.userMs !== null;
  const samples = (previous?.samples ?? 0) + 1;
  const cpuSamples = (previous?.cpuSamples ?? 0) + Number(measured);
  const cpuUnavailableSamples = samples - cpuSamples;
  const user = (previous?.cpuUserTotalMs ?? 0) + (sample.cpu.userMs ?? 0);
  const system = (previous?.cpuSystemTotalMs ?? 0) + (sample.cpu.systemMs ?? 0);
  const sources = [...new Set([...(Array.isArray(previous?.cpuSource) ? previous.cpuSource : previous?.cpuSource ? [previous.cpuSource] : []), ...(sample.cpu.source ? [sample.cpu.source] : [])])].sort();
  const reasons = [...new Set([...(previous?.unavailableReason ? previous.unavailableReason.split('; ') : []), ...(sample.cpu.unavailableReason ? [sample.cpu.unavailableReason] : [])])].sort();
  const wallTotalMs = (previous?.wallTotalMs ?? 0) + sample.wallMs;
  return {
    scope: sample.scope, command: sample.command, stage: sample.stage, executor: sample.executor,
    samples, firstSampleStartedAt: previous && previous.firstSampleStartedAt < sample.startedAt ? previous.firstSampleStartedAt : sample.startedAt,
    updatedAt: previous && previous.updatedAt > sample.completedAt ? previous.updatedAt : sample.completedAt,
    wallTotalMs, wallMeanMs: wallTotalMs / samples, cpuSamples, cpuUnavailableSamples,
    cpuUserTotalMs: cpuSamples ? user : null, cpuSystemTotalMs: cpuSamples ? system : null,
    cpuUserMeanMs: cpuSamples ? user / cpuSamples : null, cpuSystemMeanMs: cpuSamples ? system / cpuSamples : null,
    cpuSource: sources.length > 1 ? sources : sources[0] ?? null,
    cpuAvailability: cpuSamples === 0 ? 'unavailable' : cpuUnavailableSamples ? 'partial' : 'complete',
    unavailableReason: reasons.length ? reasons.join('; ') : null,
  };
}

export function createRafCostProfiler(identity: Pick<RafCostKey, 'scope' | 'command'>, ports: RafCostProfilePorts): RafCostProfiler {
  if (!['service', 'worker', 'command'].includes(identity.scope) ||
      (identity.scope === 'command' ? !ports.policy.commands.includes(identity.command ?? '') : identity.command !== null)) throw new Error('Invalid cost profile scope or canonical command');
  const checkStage = (stage: string) => { if (!ports.policy.stages.includes(stage)) throw new Error('Unknown cost profile stage'); };
  const cpu = () => {
    try {
      const value = ports.cpuUsage();
      if (![value.userMicros, value.systemMicros].every(value => Number.isFinite(value) && value >= 0)) return null;
      return value;
    } catch { return null; }
  };
  type Boundary = { stage: string; at: number; utc: string; cpu: ReturnType<typeof cpu> };
  let active: Boundary | undefined;
  const boundary = (stage: string): Boundary => ({ stage, at: ports.monotonicMs(), utc: ports.utcNow(), cpu: cpu() });
  const record = (sample: RafCostSample) => {
    validateSample(sample);
    ports.repository.update({ scope: sample.scope, command: sample.command, stage: sample.stage, executor: sample.executor }, previous => aggregateRafCostSample(previous, sample));
  };
  const complete = (end: Boundary) => {
    const start = active!;
    active = undefined;
    const available = start.cpu && end.cpu && end.cpu.userMicros >= start.cpu.userMicros && end.cpu.systemMicros >= start.cpu.systemMicros;
    record({ ...identity, stage: start.stage, executor: 'self', startedAt: start.utc, completedAt: end.utc,
      wallMs: Math.max(0, end.at - start.at), cpu: available
        ? { userMs: (end.cpu!.userMicros - start.cpu!.userMicros) / 1000, systemMs: (end.cpu!.systemMicros - start.cpu!.systemMicros) / 1000, source: 'process.cpuUsage', unavailableReason: null }
        : { userMs: null, systemMs: null, source: null, unavailableReason: 'Process CPU counters unavailable' } });
  };
  return {
    start(stage) {
      checkStage(stage);
      if (active) throw new Error('Cost profile interval already started');
      active = boundary(stage);
    },
    transition(stage) {
      checkStage(stage);
      if (!active) throw new Error('Cost profile interval not started');
      const next = boundary(stage);
      complete(next);
      active = next;
    },
    recordChild(sample, ownership) {
      if (ownership !== 'helper') return;
      checkStage(sample.stage);
      record({ ...sample, ...identity, executor: 'child' });
    },
    finish() { if (active) complete(boundary(active.stage)); },
    snapshot() { return { schemaVersion: ports.policy.schemaVersion, readAt: ports.utcNow(), rows: ports.repository.readRows() }; },
  };
}

export async function withRafCostProfile<T>(
  profiler: RafCostProfiler,
  stage: string,
  action: () => Promise<T>,
  reportStorageError: (error: unknown, runtimeError: unknown | undefined) => void,
): Promise<T> {
  let runtimeError: unknown;
  let failed = false;
  profiler.start(stage);
  try { return await action(); }
  catch (error) { failed = true; runtimeError = error; throw error; }
  finally {
    try { profiler.finish(); }
    catch (error) {
      try { reportStorageError(error, runtimeError); }
      catch (reportError) { if (!failed) throw reportError; }
      if (!failed) throw error;
    }
  }
}

function validateSample(sample: RafCostSample): void {
  if (!['service', 'worker', 'command'].includes(sample.scope) || !['self', 'child'].includes(sample.executor) ||
      typeof sample.stage !== 'string' || !sample.stage || (sample.scope === 'command' ? typeof sample.command !== 'string' || !sample.command : sample.command !== null) ||
      !Number.isFinite(sample.wallMs) || sample.wallMs < 0 || !Number.isFinite(Date.parse(sample.startedAt)) || !Number.isFinite(Date.parse(sample.completedAt))) throw new Error('Invalid cost profile sample');
  if (sample.cpu.userMs === null) {
    if (sample.cpu.systemMs !== null || !sample.cpu.unavailableReason) throw new Error('Unavailable CPU requires a reason');
  } else if (![sample.cpu.userMs, sample.cpu.systemMs].every(value => value !== null && Number.isFinite(value) && value >= 0) || !sample.cpu.source || sample.cpu.unavailableReason !== null) throw new Error('Invalid CPU measurement');
}

export function mergeRafCostRows(previous: RafCostRow | undefined, contribution: RafCostRow): RafCostRow {
  if (!previous) return contribution;
  const samples = previous.samples + contribution.samples;
  const cpuSamples = previous.cpuSamples + contribution.cpuSamples;
  const cpuUnavailableSamples = previous.cpuUnavailableSamples + contribution.cpuUnavailableSamples;
  const sources = [...new Set([previous.cpuSource, contribution.cpuSource].flatMap(source => source === null ? [] : Array.isArray(source) ? source : [source]))].sort();
  const reasons = [...new Set([previous.unavailableReason, contribution.unavailableReason].flatMap(reason => reason ? reason.split('; ') : []))].sort();
  const wallTotalMs = previous.wallTotalMs + contribution.wallTotalMs;
  const cpuUserTotalMs = cpuSamples ? (previous.cpuUserTotalMs ?? 0) + (contribution.cpuUserTotalMs ?? 0) : null;
  const cpuSystemTotalMs = cpuSamples ? (previous.cpuSystemTotalMs ?? 0) + (contribution.cpuSystemTotalMs ?? 0) : null;
  return { ...contribution, samples, cpuSamples, cpuUnavailableSamples,
    firstSampleStartedAt: previous.firstSampleStartedAt < contribution.firstSampleStartedAt ? previous.firstSampleStartedAt : contribution.firstSampleStartedAt,
    updatedAt: previous.updatedAt > contribution.updatedAt ? previous.updatedAt : contribution.updatedAt,
    wallTotalMs, wallMeanMs: wallTotalMs / samples, cpuUserTotalMs, cpuSystemTotalMs,
    cpuUserMeanMs: cpuSamples ? cpuUserTotalMs! / cpuSamples : null, cpuSystemMeanMs: cpuSamples ? cpuSystemTotalMs! / cpuSamples : null,
    cpuSource: sources.length > 1 ? sources : sources[0] ?? null,
    cpuAvailability: cpuSamples === 0 ? 'unavailable' : cpuUnavailableSamples ? 'partial' : 'complete',
    unavailableReason: reasons.length ? reasons.join('; ') : null };
}
