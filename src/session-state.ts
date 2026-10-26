import { sameProcessOwnership } from './process-identity.ts';
import type { NativeIdentity } from './agy-session-start.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import { loadFlowPolicy } from './flow-policy.ts';
import type { ResourceReservation } from './resource-admission.ts';
import type { SessionNotify } from './launcher-notice.ts';

export type ProcessIdentity = {
  pid: number;
  startedAt: string;
  runner: string;
  runnerSessionId: string | null;
  nativeIdentity?: NativeIdentity;
  tmuxSession: string;
  evidence: Readonly<Record<string, string>>;
};

export type SessionActivity = {
  type: string;
  project: string;
  features: readonly string[];
  phase: string;
  cwd: string;
};

export type AdmissionReservation = {
  runId: string;
  resource: string;
  amount: number;
  resourceBundle?: { machineId: string; resources: ResourceReservation };
  testRun?: { claim: import('./test-run-reservations.ts').TestRunResourceClaim; committed: boolean; spawning?: boolean; ownerIdentity: string };
};

export type ProcessObservation =
  | { state: 'alive'; observedAt: string; identity: ProcessIdentity }
  | { state: 'exited'; observedAt: string; exitCode: number | null; evidence: string; finishReason?: import('./resource-usage.ts').UsageFinishReason }
  | { state: 'unknown'; observedAt: string; error: string };

export type WorkResult = { status: string; response: string; proof: unknown; forcedClose?: { reason: string } };
export type PendingIntent = { id: string; runId: string | null; event: string; payload: unknown };
export type DomainEffect = { id: string; domain: string; payload: unknown };
export type TransitionEffects = { pending: readonly PendingIntent[]; domain: readonly DomainEffect[]; reportAccepted?: boolean };

export type SessionLaunchContext = {
  modelRouting?: { parameters: import('./app-runtime.ts').RuntimeRunParameters; cause?: import('./model-routing-handoff.ts').ModelHandoffObservation };
  resourceUsageContext?: import('./resource-usage.ts').UsageContext;
  agentQueue?: import('./agent-run-queue.ts').AgentQueueRecord;
  workspaceTrustDenied?: true;
  reportedCommits?: import('./reported-commits-contract.ts').ReportedCommitLaunchContext;
  reportSchema?: Readonly<Record<string, unknown>>;
  testAssignment?: import('./sandbox-test-run.ts').SandboxTestAssignment;
  contextReview?: { contextReviewId: string; runIds: readonly string[]; brief: string };
  wrapper?: ProcessIdentity;
  sessionStart?: { workspace: string; writerGeneration: string };
  assignment: AssignmentSnapshot;
  selection: { runner: string; model: string; effort: string; reason: string };
  briefPath: string;
  reportPath: string;
  writeBoundaries?: readonly string[];
};

export type SessionRecord = SessionNotify & {
  ownerAction?: 'paused' | 'stopped';
  successorRunId?: string;
  modelHandoff?: { activity: SessionActivity; launchContext: SessionLaunchContext; reason?: string };
  runId: string;
  addressId: string;
  revision: number;
  state: 'reserved' | 'running' | 'exited' | 'finished';
  activity?: SessionActivity;
  launchContext?: SessionLaunchContext;
  process?: ProcessIdentity;
  observation?: ProcessObservation;
  result?: WorkResult;
  reportAcceptance?: { runId: string; status: string; event: string };
  finishedAt?: string;
  abortReason?: string;
  delegatedBy?: { addressId: string; runId: string; fence: string };
  launchedBy?: { addressId: string; runId: string };
};

export interface SessionTransaction {
  getSession(runId: string): SessionRecord | undefined;
  listSessions(): SessionRecord[];
  putSession(session: SessionRecord): void;
  deleteSession(runId: string): void;
  listReservations(): AdmissionReservation[];
  putReservation(reservation: AdmissionReservation): void;
  deleteReservation(runId: string): void;
  putPending(intent: PendingIntent): void;
  deletePending(id: string): void;
  listPending(): PendingIntent[];
  applyEffects(effects: readonly DomainEffect[]): void;
}

export interface SessionRepository {
  transaction<T>(operation: (transaction: SessionTransaction) => T, mode?: 'read'): T;
}

export type SessionStateDependencies = {
  repository: SessionRepository;
  verifyMainAuthority: (authority: unknown, identity: ProcessIdentity) => boolean;
  verifyWorkResult: (runId: string, result: WorkResult) => boolean;
};

export interface SessionState {
  reserveLaunch(addressId: string, runId: string, activity: SessionActivity, admission: Omit<AdmissionReservation, 'runId'>): SessionRecord;
  commitStarted(runId: string, processIdentity: ProcessIdentity): boolean;
  abortLaunch(runId: string, reason: string, finishedAt: string): boolean;
  registerExistingMain(runId: string, identity: ProcessIdentity, verifiedAuthority: unknown, activity: SessionActivity): SessionRecord;
  listReconciliationCandidates(): SessionRecord[];
  commitObservation(runId: string, expectedRevision: number, observation: ProcessObservation, effects: TransitionEffects): boolean;
  acceptWorkResult(runId: string, result: WorkResult, effects: TransitionEffects): boolean;
  finalizeSession(runId: string, expectedRevision: number, finishedAt: string, effects: TransitionEffects): boolean;
  cleanupCompleted(now: string): number;
  listPending(): PendingIntent[];
  completePending(id: string): void;
}

export function permitsModelHandoff(session: SessionRecord): boolean {
  const cause = session.launchContext?.modelRouting?.cause;
  return cause?.status === 'limited' || !session.abortReason && session.state !== 'reserved';
}

export function closeSessionInTransaction(tx: SessionTransaction, session: SessionRecord, finishedAt: string): void {
  if (!Number.isFinite(Date.parse(finishedAt))) throw new Error('Invalid timestamp');
  const copy = <T>(value: T): T => structuredClone(value);
  const finished: SessionRecord = {
    runId: session.runId,
    addressId: session.addressId,
    revision: session.revision + 1,
    state: 'finished',
    ...(session.ownerAction ? { ownerAction: session.ownerAction } : {}),
    ...(session.successorRunId ? { successorRunId: session.successorRunId } : {}),
    ...(session.launchedBy ? { launchedBy: copy(session.launchedBy) } : {}),
    ...(session.notify ? { notify: copy(session.notify) } : {}),
    ...(session.delegatedBy ? { delegatedBy: copy(session.delegatedBy) } : {}),
    ...(session.activity && session.launchContext?.modelRouting && session.result?.status !== 'succeeded' && !session.result?.forcedClose && !session.ownerAction && permitsModelHandoff(session) ? {
      modelHandoff: { activity: copy(session.activity), launchContext: { ...copy(session.launchContext), modelRouting: {
        ...copy(session.launchContext.modelRouting), cause: session.launchContext.modelRouting.cause ?? (session.observation?.state === 'exited'
          ? { status: 'exited', exitCode: session.observation.exitCode }
          : { status: 'failed', reason: session.abortReason ?? session.result?.response ?? 'Launch closed before readiness' }),
      } } },
    } : {}),
    ...(session.process ? { process: copy(session.process) } : {}),
    ...(session.result ? { result: { status: session.result.status, response: '', proof: null, ...(session.result.forcedClose ? { forcedClose: copy(session.result.forcedClose) } : {}) } } : {}),
    ...(session.abortReason ? { abortReason: session.abortReason } : {}),
    finishedAt,
  };
  tx.putSession(finished);
  tx.deleteReservation(session.runId);
}

export function forceCloseInTransaction(tx: SessionTransaction, session: SessionRecord, reason: string, event: string): SessionRecord {
  if (!reason.trim() || !event) throw new Error('Forced closure requires a reason and result event');
  if (session.result?.forcedClose) return session;
  const result: WorkResult = session.result ? { ...session.result, forcedClose: { reason } } : { status: 'failed', response: `Forced close: ${reason}`, proof: { runId: session.runId, at: new Date().toISOString() }, forcedClose: { reason } };
  const next = { ...session, revision: session.revision + 1, result };
  tx.putSession(next);
  if (!session.result) tx.putPending({ id: `${session.runId}:${event}`, runId: session.runId, event, payload: { kind: event, id: session.addressId } });
  return next;
}

export function createSessionState(dependencies: SessionStateDependencies): SessionState {
  const { repository, verifyMainAuthority, verifyWorkResult } = dependencies;
  const copy = <T>(value: T): T => structuredClone(value);
  const requireAvailable = (tx: SessionTransaction, addressId: string, runId: string) => {
    if (!addressId || !runId) throw new Error('Address and run identity are required');
    if (tx.getSession(runId)) throw new Error('Run identity already exists');
    if (tx.listSessions().some(session => session.addressId === addressId && session.state !== 'finished')) {
      throw new Error('Address already has an active session');
    }
  };
  const apply = (tx: SessionTransaction, effects: TransitionEffects) => {
    tx.applyEffects(copy(effects.domain));
    for (const intent of effects.pending) tx.putPending(copy(intent));
  };
  const validTime = (value: string): number => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error('Invalid timestamp');
    return timestamp;
  };
  return {
    reserveLaunch(addressId, runId, activity, admission) {
      if (addressId === 'main' || activity.type === 'main') throw new Error('Main must register an existing process');
      return repository.transaction(tx => {
        requireAvailable(tx, addressId, runId);
        const session: SessionRecord = { runId, addressId, revision: 0, state: 'reserved', activity: copy(activity) };
        tx.putSession(session);
        tx.putReservation({ ...copy(admission), runId });
        return copy(session);
      });
    },
    commitStarted(runId, processIdentity) {
      return repository.transaction(tx => {
        const session = tx.getSession(runId);
        if (!session || session.state !== 'reserved') return false;
        tx.putSession({ ...session, revision: session.revision + 1, state: 'running', process: copy(processIdentity) });
        return true;
      });
    },
    abortLaunch(runId, reason, finishedAt) {
      validTime(finishedAt);
      return repository.transaction(tx => {
        const session = tx.getSession(runId);
        if (!session || session.state !== 'reserved') return false;
        closeSessionInTransaction(tx, { ...session, abortReason: reason }, finishedAt);
        return true;
      });
    },
    registerExistingMain(runId, identity, verifiedAuthority, activity) {
      if (!verifyMainAuthority(verifiedAuthority, identity)) throw new Error('Verified main authority is required');
      return repository.transaction(tx => {
        requireAvailable(tx, 'main', runId);
        const session: SessionRecord = { runId, addressId: 'main', revision: 0, state: 'running', activity: copy(activity), process: copy(identity) };
        tx.putSession(session);
        return copy(session);
      });
    },
    listReconciliationCandidates() {
      return repository.transaction(tx => copy(tx.listSessions().filter(session => session.state !== 'finished')), 'read');
    },
    commitObservation(runId, expectedRevision, observation, effects) {
      return repository.transaction(tx => {
        const session = tx.getSession(runId);
        if (!session || session.revision !== expectedRevision || session.state !== 'running') return false;
        if (!Number.isFinite(Date.parse(observation.observedAt)) || session.process && Date.parse(observation.observedAt) < Date.parse(session.process.startedAt) ||
            session.observation && Date.parse(observation.observedAt) < Date.parse(session.observation.observedAt)) return false;
        if (observation.state === 'alive') {
          const identity = session.process;
          if (!identity || !sameProcessOwnership(identity, observation.identity)) return false;
        }
        tx.putSession({ ...session, revision: session.revision + 1, state: observation.state === 'exited' ? 'exited' : 'running', observation: copy(observation.state === 'alive' ? { ...observation, identity: session.process! } : observation) });
        if (observation.state !== 'unknown') apply(tx, effects);
        return true;
      });
    },
    acceptWorkResult(runId, result, effects) {
      if (!verifyWorkResult(runId, result)) return false;
      return repository.transaction(tx => {
        const session = tx.getSession(runId);
        if (!session || (session.state !== 'running' && session.state !== 'exited') || session.result) return false;
        let event = effects.pending.find(intent => intent.runId === runId && intent.event.length > 0);
        if (effects.reportAccepted && !event) {
          if (result.status !== 'succeeded' && result.status !== 'failed') throw new Error('Accepted report requires a valid result status');
          const name = `agent.${result.status}`;
          event = { id: `${runId}:${name}`, runId, event: name, payload: { kind: name, id: session.addressId } };
          effects = { ...effects, pending: [...effects.pending, event] };
        }
        tx.putSession({ ...session, revision: session.revision + 1, result: copy(result), ...(effects.reportAccepted ? { reportAcceptance: { runId, status: result.status, event: event!.event } } : {}) });
        apply(tx, effects);
        return true;
      });
    },
    finalizeSession(runId, expectedRevision, finishedAt, effects) {
      validTime(finishedAt);
      return repository.transaction(tx => {
        const session = tx.getSession(runId);
        if (!session || session.revision !== expectedRevision || session.state !== 'exited') return false;
        closeSessionInTransaction(tx, session, finishedAt);
        apply(tx, effects);
        return true;
      });
    },
    cleanupCompleted(now) {
      const cutoff = validTime(now) - loadFlowPolicy().retention.finishedSessionsMs;
      return repository.transaction(tx => {
        let removed = 0;
        for (const session of tx.listSessions()) {
          if (session.state === 'finished' && !session.modelHandoff && session.finishedAt && Date.parse(session.finishedAt) <= cutoff) {
            tx.deleteSession(session.runId);
            removed++;
          }
        }
        return removed;
      });
    },
    listPending() {
      return repository.transaction(tx => copy(tx.listPending()), 'read');
    },
    completePending(id) {
      repository.transaction(tx => tx.deletePending(id));
    },
  };
}
