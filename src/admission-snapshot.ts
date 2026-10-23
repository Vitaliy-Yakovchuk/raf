import { evaluateResourceAdmission, type ResourceAdmissionInput } from './resource-admission.ts';
import type { FlowPolicy } from './flow-policy.ts';
import type { ResourceAdmissionEstimate, ResourceReservation } from './resource-admission.ts';

export type AdmissionLevel = 'ANY_RUN' | 'HOTFIX_ONLY' | 'NO_RESOURCES' | 'UNKNOWN';
export type AdmissionTier = 'normal' | 'hotfix';

export interface AdmissionMeasurement {
  machineId: string | null;
  loadAverage1m: number | null;
  availableCores: number | null;
  totalRamBytes: number | null;
  availableRamBytes: number | null;
  memoryPressure: 'normal' | 'critical' | 'unknown' | null;
  fileSystems: {
    id: string;
    totalBytes: number | null;
    availableBytes: number | null;
  }[];
}

export interface AdmissionSnapshot {
  level: AdmissionLevel;
  requestedTier: AdmissionTier;
  allowed: boolean;
  reasons: string[];
  measurement: AdmissionMeasurement;
  thresholds: FlowPolicy['resources'] | null;
  reservation: {
    requested: ResourceReservation | null;
    unused: ResourceReservation;
  };
  remaining: {
    ramBytes: number;
    diskBytes: Record<string, number>;
    normalizedLoad: number;
  } | null;
  estimate: ResourceAdmissionEstimate;
  queueId: string;
}

export interface AdmissionSnapshotRequest {
  input: {
    measurement: AdmissionMeasurement;
    requested: ResourceReservation;
    unusedReservations: readonly ResourceReservation[];
    requiredFileSystemIds: readonly string[];
    homeFileSystemId?: string | null;
    estimate: ResourceAdmissionEstimate;
  };
  policy: FlowPolicy;
  requestedTier: AdmissionTier;
  queueId: string;
}

type SnapshotRequest = Omit<AdmissionSnapshotRequest, 'input' | 'policy'> & {
  input: Omit<AdmissionSnapshotRequest['input'], 'requested'> & { requested: ResourceReservation | null };
  policy: FlowPolicy | null;
};

export function buildAdmissionSnapshot(request: SnapshotRequest): AdmissionSnapshot {
  const { input, policy, requestedTier, queueId } = request;
  const copy = <T>(value: T): T => structuredClone(value);
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const number = (value: unknown): number | null => finite(value) ? value : null;
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const reasons: string[] = [];
  for (const tier of ['normal', 'hotfix'] as const) {
    const thresholds = policy?.resources?.[tier];
    for (const key of ['maxNormalizedLoad', 'minRamFraction', 'minRamBytes', 'minDiskFraction', 'minDiskBytes'] as const) {
      const value = thresholds?.[key];
      if (!finite(value) || value <= 0 || (key.endsWith('Fraction') && value > 1)) reasons.push(`Invalid conf/flow.json#/resources/${tier}/${key}`);
    }
  }
  const home = policy?.resources?.home?.minDiskBytes;
  if (!Number.isSafeInteger(home) || home! < 0) reasons.push('Invalid conf/flow.json#/resources/home/minDiskBytes');
  if (policy?.resources?.normal && policy.resources.hotfix && !reasons.length) {
    const { normal, hotfix } = policy.resources;
    if (hotfix.maxNormalizedLoad < normal.maxNormalizedLoad) reasons.push('Invalid conf/flow.json#/resources/hotfix/maxNormalizedLoad: stricter than normal');
    for (const key of ['minRamFraction', 'minRamBytes', 'minDiskFraction', 'minDiskBytes'] as const) {
      if (hotfix[key] > normal[key]) reasons.push(`Invalid conf/flow.json#/resources/hotfix/${key}: stricter than normal`);
    }
  }
  const thresholds = reasons.length ? null : copy(policy!.resources);
  const measured = input.measurement;
  const ids = new Set([...input.requiredFileSystemIds, ...(input.homeFileSystemId ? [input.homeFileSystemId] : [])]);
  const fileSystems = new Map<string, AdmissionMeasurement['fileSystems'][number]>();
  for (const fs of measured?.fileSystems ?? []) {
    if (!fs || !ids.has(fs.id)) continue;
    fileSystems.set(fs.id, { id: fs.id, totalBytes: number(fs.totalBytes), availableBytes: number(fs.availableBytes) });
  }
  for (const id of ids) {
    if (!fileSystems.has(id)) fileSystems.set(id, { id, totalBytes: null, availableBytes: null });
  }
  const measurement: AdmissionMeasurement = {
    machineId: text(measured?.machineId) ? measured.machineId : null,
    loadAverage1m: number(measured?.loadAverage1m), availableCores: number(measured?.availableCores),
    totalRamBytes: number(measured?.totalRamBytes), availableRamBytes: number(measured?.availableRamBytes),
    memoryPressure: ['normal', 'critical', 'unknown'].includes(measured?.memoryPressure as string) ? measured.memoryPressure : null,
    fileSystems: [...fileSystems.values()],
  };
  const validReservation = (value: ResourceReservation | null): value is ResourceReservation => !!value && finite(value.ramBytes)
    && !!value.diskBytes && typeof value.diskBytes === 'object' && !Array.isArray(value.diskBytes)
    && Object.entries(value.diskBytes).every(([id, bytes]) => text(id) && finite(bytes));
  const development = new Set(input.requiredFileSystemIds);
  const reservation = (value: ResourceReservation): ResourceReservation => ({ ramBytes: value.ramBytes,
    diskBytes: Object.fromEntries(Object.entries(value.diskBytes).filter(([id]) => development.has(id))) });
  const requested = input.estimate?.status === 'KNOWN' && validReservation(input.requested) ? reservation(input.requested) : null;
  const unused: ResourceReservation = { ramBytes: 0, diskBytes: {} };
  for (const value of input.unusedReservations) {
    if (!validReservation(value)) { reasons.push('Invalid unused resource reservation'); continue; }
    unused.ramBytes += value.ramBytes;
    for (const [id, bytes] of Object.entries(reservation(value).diskBytes)) unused.diskBytes[id] = (unused.diskBytes[id] ?? 0) + bytes;
  }
  if (!finite(unused.ramBytes) || !Object.values(unused.diskBytes).every(finite)) reasons.push('Invalid unused resource reservation arithmetic');
  if (!requested) reasons.push('Invalid requested resource reservation estimate');
  const estimate: ResourceAdmissionEstimate = input.estimate?.status === 'KNOWN' && Array.isArray(input.estimate.sources) && input.estimate.sources.every(text)
    ? copy(input.estimate) : { status: 'UNKNOWN', sources: copy(input.estimate?.sources ?? []), reason: input.estimate?.reason ?? 'Missing resource estimate' };
  if (estimate.status === 'UNKNOWN') reasons.push(estimate.reason ?? 'Unknown resource estimate');
  const evaluated = thresholds && requested ? evaluateResourceAdmission({ ...input, requested, unusedReservations: input.unusedReservations.map(value => validReservation(value) ? reservation(value) : value) } as ResourceAdmissionInput, policy!) : null;
  const invalid = reasons.length > 0;
  if (evaluated) reasons.push(...evaluated.reasons);
  const unknown = invalid || !evaluated || evaluated.level === 'UNKNOWN';
  return {
    level: unknown ? 'UNKNOWN' : evaluated.level, requestedTier,
    allowed: !unknown && evaluated.allowed[requestedTier], reasons,
    measurement, thresholds, reservation: { requested, unused },
    remaining: unknown ? null : copy(evaluated.remaining), estimate, queueId,
  };
}
