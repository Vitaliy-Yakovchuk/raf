import type { AdmissionSnapshot, AdmissionTier } from './admission-snapshot.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import type { CommandFailureContext } from './cli.ts';
import type { ResourceReservation } from './resource-admission.ts';
import type { ResourceWaitIdentity, ResourceWaitPermit } from './resource-wait-protocol.ts';
import type { waitForResources } from './resource-wait-command.ts';
import type { LaunchQueueHandle, LaunchQueueFailure } from './launch-queue-events.ts';

export interface AgentQueueOwner {
  runId: string;
  fence: string;
}

export interface AgentQueueRequest {
  orchestratorRoot: string;
  homeDirectory: string;
  developmentDirectory: string;
  project: string;
  agentId: string;
  agentType: string;
  owner: AgentQueueOwner;
  clientIdentity: ResourceWaitIdentity;
  selections: readonly { change: string; items: readonly string[] }[];
  coordinator: AgentQueueOwner | null;
  signal?: AbortSignal;
}

export interface AgentQueueValidation {
  assignment: AssignmentSnapshot;
  fingerprint: string;
  requested: ResourceReservation;
  requiredFileSystemIds: readonly string[];
}

export interface AgentQueueRecord {
  queueId: string;
  requestId: string;
  agentId: string;
  owner: AgentQueueOwner;
  clientIdentity: ResourceWaitIdentity;
  coordinator: AgentQueueOwner | null;
  eventHandle: LaunchQueueHandle | null;
}

export type AgentQueueCheck =
  | { ok: true; validation: AgentQueueValidation }
  | { ok: false; failure: CommandFailureContext };

export type AgentQueueAdmission =
  | { kind: 'waiting' | 'reserved'; record: AgentQueueRecord; admission: AdmissionSnapshot }
  | { kind: 'refused'; failure: CommandFailureContext; admission: AdmissionSnapshot | null };

export interface AgentQueueProcess {
  pid: number;
  startedAt: string;
  machineId: string;
  bootId: string;
  runnerSessionId: string;
}

export interface AgentQueueCleanup {
  state: 'released' | 'retained' | 'unknown';
  reason: string;
  completed: readonly string[];
  pending: readonly string[];
}

export interface AgentQueueObservation {
  owner: 'client' | 'agent' | 'other';
  client: 'alive' | 'dead' | 'unknown';
  agent: 'alive' | 'dead' | 'unknown';
  reason: string;
}

export interface AgentRunQueuePorts {
  validate(request: AgentQueueRequest, previous: AgentQueueValidation | null): Promise<AgentQueueCheck>;
  claimAndAdmit(input: {
    request: AgentQueueRequest;
    validation: AgentQueueValidation;
    tier: AdmissionTier;
  }): Promise<AgentQueueAdmission>;
  waitForResources: typeof waitForResources;
  transition(record: AgentQueueRecord, phase: 'waiting' | 'rechecking' | 'starting'): Promise<boolean>;
  recheckAndReserve(input: {
    record: AgentQueueRecord;
    validation: AgentQueueValidation;
    permit: ResourceWaitPermit;
    tier: AdmissionTier;
  }): Promise<AgentQueueAdmission>;
  start(record: AgentQueueRecord, validation: AgentQueueValidation): Promise<AgentQueueProcess>;
  verifyReady(record: AgentQueueRecord, process: AgentQueueProcess): Promise<AgentQueueProcess>;
  commitReady(record: AgentQueueRecord, process: AgentQueueProcess): Promise<boolean>;
  cleanup(record: AgentQueueRecord, reason: LaunchQueueFailure, detail: string): Promise<AgentQueueCleanup>;
  observe(record: AgentQueueRecord): Promise<AgentQueueObservation>;
  writeStderr(line: string): void;
}

export interface AgentRunQueueResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runAgentWithQueue(
  request: AgentQueueRequest,
  ports: AgentRunQueuePorts,
): Promise<AgentRunQueueResult> {
  throw new Error('NotImplemented');
}

export async function reconcileAgentQueue(
  record: AgentQueueRecord,
  ports: AgentRunQueuePorts,
): Promise<AgentQueueCleanup> {
  throw new Error('NotImplemented');
}
