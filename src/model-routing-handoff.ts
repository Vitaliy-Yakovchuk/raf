import type { AdapterObservation } from './agent-adapters.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import type { ModelCatalog, ModelRequest, ModelSelection, RoutingSnapshot } from './model-routing.ts';
import type { ProcessObservation, SessionRecord } from './session-state.ts';

export type ModelHandoffObservation = AdapterObservation & { quotaPool?: string };

export interface ModelHandoffRequest {
  session: SessionRecord;
  signal: { runId: string; observation: ModelHandoffObservation };
  ownerAction: 'continue' | 'paused' | 'stopped';
  startupCleanup?: { retrySafe: boolean; pending: readonly string[] };
}

export interface ModelHandoffReportCheck {
  runId: string;
  status: 'succeeded' | 'failed' | 'missing' | 'rejected' | 'pending';
  reason: string;
}

export interface ModelHandoffLaunch {
  predecessorRunId: string;
  assignment: AssignmentSnapshot;
  selection: Extract<ModelSelection, { status: 'selected' }>;
  evidence: readonly string[];
  cause: ModelHandoffObservation;
}

export interface ModelHandoffPorts {
  currentSession(addressId: string): Promise<SessionRecord | null>;
  inspect(session: SessionRecord): Promise<ProcessObservation>;
  checkFinalReport(session: SessionRecord): Promise<ModelHandoffReportCheck>;
  finalize(session: SessionRecord): Promise<{ finalized: boolean; claimsReleased: boolean; reason: string }>;
  readCurrentWork(session: SessionRecord): Promise<
    | { status: 'ready'; assignment: AssignmentSnapshot; request: ModelRequest; evidence: readonly string[] }
    | { status: 'changed'; reason: string }
  >;
  readRouting(): Promise<{ catalog: ModelCatalog; snapshot: RoutingSnapshot }>;
  launchNew(input: ModelHandoffLaunch): Promise<
    | { status: 'started'; session: SessionRecord }
    | { status: 'blocked'; reason: string }
  >;
}

export type ModelHandoffResult =
  | { status: 'ignored' | 'waiting' | 'complete'; predecessorRunId: string; reason: string }
  | { status: 'started'; predecessorRunId: string; session: SessionRecord; reason: string };

export async function handoffModelRun(request: ModelHandoffRequest, ports: ModelHandoffPorts): Promise<ModelHandoffResult> {
  throw new Error('NotImplemented');
}
