import { type DeliveryFrame, deliveryDiagnostic, redactDeliveryText } from './delivery-diagnostic.ts';
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
    } | null;
    diagnostic: ReturnType<typeof deliveryDiagnostic> | null;
  };
};

export async function preserveFailedDeliveryEvidence(
  input: FailedDeliveryEvidenceInput,
  ports: DeliveryEvidencePorts,
): Promise<FailedDeliveryEvidenceResult> {
  const publicText = (value: string) => redactDeliveryText(input.settings, {
    screen: value, brief: 'frame' in input.capture ? input.capture.frame.brief : '',
    phase: 'frame' in input.capture ? input.capture.frame.phase : 'before_submission', retried: false,
  });
  const result: FailedDeliveryEvidenceResult = {
    code: 'LAUNCH_FAILED', reason: publicText(input.primaryReason), retrySafe: input.retrySafe,
    evidence: { availability: 'unavailable', reference: null, unavailableReason: null, metadata: null, diagnostic: null },
  };
  let stage = 'capture';
  try {
    if ('unavailable' in input.capture) throw new Error(input.capture.unavailable);
    const firstFailure = Date.parse(input.firstFailureAt);
    if (!Number.isFinite(firstFailure) || !Number.isFinite(Date.parse(input.capture.capturedAt))) throw new Error('Invalid evidence time');
    stage = 'isolation';
    await ports.verifyIsolation(input.runId);
    stage = 'storage';
    let record = await ports.read(input.runId);
    if (!record) record = await ports.putIfAbsent({
      reference: ports.newReference(), runId: input.runId, runner: input.settings.runner,
      version: input.settings.version, generation: input.generation,
      firstFailureAt: input.firstFailureAt, capture: structuredClone(input.capture),
    });
    if (record.runId !== input.runId) throw new Error('Evidence run identity mismatch');
    stage = 'redaction';
    const diagnostic = deliveryDiagnostic(input.settings, record.capture.frame);
    result.evidence = {
      availability: 'available', reference: record.reference, unavailableReason: null,
      metadata: { runId: record.runId, runner: publicText(record.runner), version: publicText(record.version), generation: publicText(record.generation),
        capturedAt: record.capture.capturedAt, phase: record.capture.frame.phase,
        method: publicText(record.capture.method), limitations: record.capture.limitations.map(publicText),
        firstFailureAt: record.firstFailureAt },
      diagnostic,
    };
  } catch (error) {
    result.evidence.unavailableReason = `Delivery evidence unavailable: ${stage}: ${publicText(error instanceof Error ? error.message : String(error))}`;
    result.reason += `; ${result.evidence.unavailableReason}`;
  }
  for (const failure of input.cleanupFailures) result.reason += `; cleanup: ${publicText(failure)}`;
  return result;
}

export async function cleanupFailedDeliveryEvidence(
  runId: string,
  reference: string,
  ports: DeliveryEvidencePorts,
): Promise<{ removed: boolean; reference: string | null }> {
  await ports.verifyIsolation(runId);
  const record = await ports.read(runId);
  if (!record) return { removed: false, reference: null };
  if (record.runId !== runId) throw new Error('Evidence run identity mismatch');
  if (record.reference !== reference) throw new Error('Evidence cleanup reference mismatch');
  await ports.remove(runId, record.reference);
  return { removed: true, reference: record.reference };
}
