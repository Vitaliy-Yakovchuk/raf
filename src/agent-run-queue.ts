import type { NativeIdentity } from './agy-session-start.ts';
import { hasValidNativeIdentity } from './process-identity.ts';
import { failureContext, redactDiagnostic } from './cli-contract.ts';
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
  launcher?: { addressId: string; runId: string } | null;
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
  runnerSessionId: string | null;
  runner?: string;
  nativeIdentity?: NativeIdentity;
}

export function sameQueueNativeIdentity(left: AgentQueueProcess, right: AgentQueueProcess): boolean {
  if (left.runner !== right.runner) return false;
  if (left.runner === 'agy' && left.nativeIdentity && right.nativeIdentity) {
    const valid = (value: AgentQueueProcess) => hasValidNativeIdentity({ ...value, runner: value.runner ?? '' });
    return valid(left) && valid(right) && (left.nativeIdentity.state === 'pending' || right.nativeIdentity.state === 'pending' || left.runnerSessionId === right.runnerSessionId);
  }
  return typeof left.runnerSessionId === 'string' && !!left.runnerSessionId.trim() && left.runnerSessionId === right.runnerSessionId;
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
  const tier: AdmissionTier = request.agentType === 'hotfix' ? 'hotfix' : 'normal';
  let record: AgentQueueRecord | null = null;
  let admission: AdmissionSnapshot | null = null;
  let waited = false;
  let stage = 'validation';
  const failure = (code: string, reason: string, facts: Partial<CommandFailureContext> = {}): CommandFailureContext => ({
    code, message: reason, reason, stage, source: 'agent-run-queue', sourceCode: null,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: false,
    remediation: ['Перевірте стан запуску перед повторним викликом.'], ...facts,
  });
  const reject = (context: CommandFailureContext): never => { throw { queueFailure: context }; };
  const checkSignal = () => {
    if (request.signal?.aborted) reject(failure('LAUNCH_CANCELLED', 'Launch client interrupted'));
  };
  const accept = (result: AgentQueueAdmission) => {
    admission = result.admission ?? admission;
    if (result.kind === 'refused') reject(result.failure);
    if (result.kind === 'refused') throw new Error('Unreachable refusal');
    if (result.record.owner.runId !== request.owner.runId || result.record.owner.fence !== request.owner.fence || result.record.agentId !== request.agentId) reject(failure('LAUNCH_FENCE_LOST', 'Admission does not belong to this launch client'));
    if (record && (record.requestId !== result.record.requestId || record.owner.runId !== result.record.owner.runId || record.owner.fence !== result.record.owner.fence)) {
      reject(failure('LAUNCH_FENCE_LOST', 'Admission returned another launch owner'));
    }
    record = result.record;
    if (!admission || admission.level === 'UNKNOWN') reject(failure('RESOURCE_UNAVAILABLE', 'Resource admission is unknown'));
    if (result.kind === 'reserved' && !admission!.allowed) reject(failure('RESOURCE_UNAVAILABLE', 'Resource reservation was not admitted'));
    return result.kind;
  };
  const transition = async (phase: 'waiting' | 'rechecking' | 'starting') => {
    if (!await ports.transition(record!, phase)) reject(failure('LAUNCH_FENCE_LOST', `Launch fence lost during ${phase}`));
  };
  try {
    checkSignal();
    const checked = await ports.validate(request, null);
    if (!checked.ok) reject(checked.failure);
    if (!checked.ok) throw new Error('Unreachable validation');
    let validation = checked.validation;
    checkSignal();
    stage = 'admission';
    let state = accept(await ports.claimAndAdmit({ request, validation, tier }));
    while (state === 'waiting') {
      checkSignal();
      waited = true;
      stage = 'waiting';
      ports.writeStderr(JSON.stringify({ kind: 'launch-queue.waiting', queueId: record!.queueId,
        requestId: record!.requestId, agentId: request.agentId, admission }) + '\n');
      const result = await ports.waitForResources({ orchestratorRoot: request.orchestratorRoot,
        homeDirectory: request.homeDirectory, developmentDirectory: request.developmentDirectory,
        level: tier, signal: request.signal });
      if (result.kind === 'error') reject(failure('RESOURCE_WAIT_FAILED', result.diagnostic.reason, {
        message: result.diagnostic.details, received: result.diagnostic.received, expected: result.diagnostic.expected,
        completed: result.diagnostic.completed, pending: result.diagnostic.pending, remediation: [result.diagnostic.remediation],
      }));
      if (result.kind !== 'permit') throw new Error('Resource wait did not confirm a permit');
      checkSignal();
      stage = 'rechecking';
      await transition('rechecking');
      const rechecked = await ports.validate(request, validation);
      if (!rechecked.ok) reject(rechecked.failure);
      if (!rechecked.ok) throw new Error('Unreachable revalidation');
      if (rechecked.validation.fingerprint !== validation.fingerprint) reject(failure('INVALID_ASSIGNMENT', 'Assignment changed while waiting'));
      validation = rechecked.validation;
      checkSignal();
      state = accept(await ports.recheckAndReserve({ record: record!, validation, permit: result.permit, tier }));
      if (state === 'waiting') await transition('waiting');
    }
    checkSignal();
    stage = 'starting';
    await transition('starting');
    checkSignal();
    const process = await ports.start(record!, validation);
    stage = 'readiness';
    checkSignal();
    const ready = await ports.verifyReady(record!, process);
    if (process.pid !== ready.pid || process.startedAt !== ready.startedAt || process.machineId !== ready.machineId || process.bootId !== ready.bootId || !sameQueueNativeIdentity(process, ready)) reject(failure('PROCESS_IDENTITY_UNAVAILABLE', 'Runner identity changed before readiness'));
    checkSignal();
    stage = 'handoff';
    if (!await ports.commitReady(record!, ready)) reject(failure('START_COMMIT_CONFLICT', 'Ready agent ownership could not be committed'));
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ status: 'running', runId: request.owner.runId,
      agentId: request.agentId, process: ready, admission, queue: { queueId: record!.queueId, waited } }) };
  } catch (error) {
    const supplied = (error as { queueFailure?: CommandFailureContext })?.queueFailure ?? failureContext(error);
    const context = supplied ?? failure('LAUNCH_FAILED', error instanceof Error ? error.message : String(error));
    let cleanup: AgentQueueCleanup = { state: 'released', reason: 'No launch claim was created', completed: [], pending: [] };
    if (record) {
      try { cleanup = await ports.cleanup(record, request.signal?.aborted ? 'cancelled' : 'launch-failed', context.reason ?? context.message); }
      catch (cause) { cleanup = { state: 'unknown', reason: cause instanceof Error ? cause.message : String(cause), completed: [], pending: ['launch cleanup'] }; }
    }
    const pending = [...new Set([...context.pending, ...cleanup.pending])];
    const retrySafe = cleanup.state === 'released' && pending.length === 0 &&
      (supplied ? context.retrySafe === true : record !== null);
    return { exitCode: 1, stdout: '', stderr: JSON.stringify(redactDiagnostic({ code: context.code, message: context.message,
      details: { ...context, admission, cleanup, completed: [...new Set([...context.completed, ...cleanup.completed])],
        pending, retrySafe },
      remediation: context.remediation }, context.secrets)) };
  }
}

export async function reconcileAgentQueue(
  record: AgentQueueRecord,
  ports: AgentRunQueuePorts,
): Promise<AgentQueueCleanup> {
  const observation = await ports.observe(record);
  if (observation.owner !== 'client') return { state: 'retained', reason: observation.reason,
    completed: [], pending: [] };
  if (observation.client === 'unknown' || observation.agent === 'unknown') return {
    state: 'unknown', reason: observation.reason, completed: [], pending: ['launch reconciliation'],
  };
  if (observation.client === 'alive' || observation.agent === 'alive') return {
    state: 'retained', reason: observation.reason, completed: [], pending: [],
  };
  return ports.cleanup(record, 'client-died', observation.reason);
}
