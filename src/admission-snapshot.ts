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

export function buildAdmissionSnapshot(request: AdmissionSnapshotRequest): AdmissionSnapshot {
  throw new Error('NotImplemented');
}
