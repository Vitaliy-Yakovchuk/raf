import type { DeliveryFrame, deliveryDiagnostic } from './delivery-diagnostic.ts';
import type { ProtocolSettings } from './runner-protocols.ts';

export type DeliveryEvidenceCapture = {
  frame: DeliveryFrame;
  capturedAt: string;
  method: string;
  limitations: string[];
};

export type PrivateDeliveryEvidence = {
  reference: string;
  runId: string;
  runner: string;
  version: string;
  generation: string;
  firstFailureAt: string;
  expiresAt: string;
  capture: DeliveryEvidenceCapture;
};

export type DeliveryEvidencePorts = {
  verifyIsolation(runId: string): Promise<void>;
  read(runId: string): Promise<PrivateDeliveryEvidence | null>;
  putIfAbsent(record: PrivateDeliveryEvidence): Promise<PrivateDeliveryEvidence>;
  remove(runId: string, reference: string): Promise<void>;
  newReference(): string;
};

export type FailedDeliveryEvidenceInput = {
  runId: string;
  generation: string;
  settings: ProtocolSettings;
  firstFailureAt: string;
  configuration: unknown;
  primaryReason: string;
  retrySafe: boolean;
  capture: DeliveryEvidenceCapture | { unavailable: string };
  cleanupFailures: string[];
};

export type FailedDeliveryEvidenceResult = {
  code: 'LAUNCH_FAILED';
  reason: string;
  retrySafe: boolean;
  evidence: {
    availability: 'available' | 'unavailable';
    reference: string | null;
    unavailableReason: string | null;
    metadata: {
      runId: string;
      runner: string;
      version: string;
      generation: string;
      capturedAt: string;
      phase: DeliveryFrame['phase'];
      method: string;
      limitations: string[];
      firstFailureAt: string;
      expiresAt: string;
    } | null;
    diagnostic: ReturnType<typeof deliveryDiagnostic> | null;
  };
};

export function readFailedDeliveryEvidenceRetention(configuration: unknown): number {
  throw new Error('NotImplemented');
}

export async function preserveFailedDeliveryEvidence(
  input: FailedDeliveryEvidenceInput,
  ports: DeliveryEvidencePorts,
): Promise<FailedDeliveryEvidenceResult> {
  throw new Error('NotImplemented');
}

export async function cleanupFailedDeliveryEvidence(
  runId: string,
  now: string,
  ports: DeliveryEvidencePorts,
): Promise<{ removed: boolean; reference: string | null }> {
  throw new Error('NotImplemented');
}
