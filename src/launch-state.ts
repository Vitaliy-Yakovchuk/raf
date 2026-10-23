import { observeReservedTestTree } from './test-run-resource-process.ts';
import type { ResourceAdmission, ResourceAdmissionEstimate, ResourceAdmissionInput, ResourceMeasurement, ResourceReservation } from './resource-admission.ts';
import type { PendingIntent, ProcessIdentity, SessionActivity, SessionLaunchContext, SessionRecord, SessionRepository, SessionTransaction } from './session-state.ts';

export type LaunchMeasurement = {
  measurement: ResourceMeasurement;
  observedProcesses: readonly { runId: string; identity: ProcessIdentity }[];
};

export type ReserveLaunchRequest = {
  runId: string;
  addressId: string;
  activity: SessionActivity;
  launchContext: SessionLaunchContext;
  resource: string;
  amount: number;
  requested: ResourceReservation;
  estimate?: ResourceAdmissionEstimate;
  requiredFileSystemIds: string[];
  homeFileSystemId?: string | null;
  mode: 'normal' | 'hotfix';
};

export type LaunchReservationResult =
  | { reserved: true; admission: ResourceAdmission; session: SessionRecord }
  | { reserved: false; admission: ResourceAdmission };

export type ActivityPatch = Partial<Pick<SessionActivity, 'project' | 'features' | 'phase'>>;

export type LaunchStateDependencies = {
  repository: SessionRepository;
  measure: (request: ReserveLaunchRequest) => Promise<LaunchMeasurement>;
  evaluateAdmission: (input: ResourceAdmissionInput) => ResourceAdmission;
};

export interface LaunchState {
  reserveLaunch(request: ReserveLaunchRequest): Promise<LaunchReservationResult>;
  updateActivity(runId: string, expectedRevision: number, patch: ActivityPatch, intents: readonly PendingIntent[]): boolean;
}

export function evaluateLaunchAdmissionInTransaction(
  tx: Pick<SessionTransaction, 'listReservations' | 'getSession'>,
  request: Pick<ReserveLaunchRequest, 'requested' | 'requiredFileSystemIds' | 'homeFileSystemId' | 'estimate'>,
  measured: LaunchMeasurement,
  evaluateAdmission: LaunchStateDependencies['evaluateAdmission'],
): ResourceAdmission {
  const copy = <T>(value: T): T => structuredClone(value);
  const sameIdentity = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
    Number.isInteger(left.pid) && left.pid > 0 && Number.isFinite(Date.parse(left.startedAt)) &&
    !!left.runner && !!left.runnerSessionId && !!left.tmuxSession &&
    left.pid === right.pid && left.startedAt === right.startedAt && left.runner === right.runner &&
    left.runnerSessionId === right.runnerSessionId && left.tmuxSession === right.tmuxSession &&
    !!left.evidence && !!right.evidence && Object.keys(left.evidence).length > 0 &&
    Object.keys(left.evidence).length === Object.keys(right.evidence).length &&
    Object.entries(left.evidence).every(([key, value]) => typeof value === 'string' && right.evidence[key] === value);
  const unusedReservations: ResourceReservation[] = [];
  for (const reservation of tx.listReservations()) {
    if (!reservation.resourceBundle || !reservation.resourceBundle.machineId) {
      return {
        ...(request.estimate ? { estimate: copy(request.estimate) } : {}),
        level: 'UNKNOWN', allowed: { normal: false, hotfix: false },
        reasons: ['Existing reservation has no resource bundle or machine identity'],
        measurement: measured.measurement, remaining: null,
      };
    }
    if (reservation.resourceBundle.machineId !== measured.measurement.machineId) continue;
    if (reservation.testRun) {
      const observed = observeReservedTestTree(reservation.testRun.claim.processIdentity);
      const requested = reservation.resourceBundle.resources;
      unusedReservations.push({ ramBytes: Math.max(0, requested.ramBytes - (observed.consumed?.ramBytes ?? 0)),
        diskBytes: Object.fromEntries(Object.entries(requested.diskBytes).map(([id, bytes]) => [id, Math.max(0, bytes - (observed.consumed?.diskBytes[id] ?? 0))])) });
      continue;
    }
    const session = tx.getSession(reservation.runId);
    const consumed = session?.state === 'running' && session.process && measured.observedProcesses.some(
      observed => observed.runId === reservation.runId && sameIdentity(session.process!, observed.identity));
    if (!consumed) unusedReservations.push(copy(reservation.resourceBundle.resources));
  }
  return evaluateAdmission({
    measurement: measured.measurement,
    requested: copy(request.requested), unusedReservations,
    ...(request.estimate ? { estimate: copy(request.estimate) } : {}),
    requiredFileSystemIds: copy(request.requiredFileSystemIds),
    ...(request.homeFileSystemId !== undefined ? { homeFileSystemId: request.homeFileSystemId } : {}),
  });
}

export function reserveLaunchInTransaction(
  tx: SessionTransaction,
  request: ReserveLaunchRequest,
  measured: LaunchMeasurement,
  evaluateAdmission: LaunchStateDependencies['evaluateAdmission'],
): LaunchReservationResult {
  if (!request.runId || !request.addressId) throw new Error('Address and run identity are required');
  if (request.addressId === 'main' || request.activity.type === 'main') throw new Error('Main must register an existing process');
  const copy = <T>(value: T): T => structuredClone(value);
  if (tx.getSession(request.runId)) throw new Error('Run identity already exists');
  if (tx.listSessions().some(session => session.addressId === request.addressId && session.state !== 'finished')) {
    throw new Error('Address already has an active session');
  }
  const admission = evaluateLaunchAdmissionInTransaction(tx, request, measured, evaluateAdmission);
  if (!admission.allowed[request.mode]) return { reserved: false, admission: copy(admission) };
  const session: SessionRecord = {
    runId: request.runId, addressId: request.addressId, revision: 0, state: 'reserved',
    activity: copy(request.activity), launchContext: copy(request.launchContext),
  };
  tx.putSession(copy(session));
  tx.putReservation({
    runId: request.runId, resource: request.resource, amount: request.amount,
    resourceBundle: { machineId: measured.measurement.machineId, resources: copy(request.requested) },
  });
  return { reserved: true, admission: copy(admission), session: copy(session) };
}

export function createLaunchState(dependencies: LaunchStateDependencies): LaunchState {
  const { repository, measure, evaluateAdmission } = dependencies;
  const copy = <T>(value: T): T => structuredClone(value);
  return {
    async reserveLaunch(input) {
      const request = copy(input);
      if (!request.runId || !request.addressId) throw new Error('Address and run identity are required');
      if (request.addressId === 'main' || request.activity.type === 'main') throw new Error('Main must register an existing process');
      const measured = copy(await measure(copy(request)));
      return repository.transaction(tx => reserveLaunchInTransaction(tx, request, measured, evaluateAdmission));
    },
    updateActivity(runId, expectedRevision, patch, intents) {
      return repository.transaction(tx => {
        const session = tx.getSession(runId);
        if (!session || session.revision !== expectedRevision || !session.activity ||
          (session.state !== 'reserved' && session.state !== 'running')) return false;
        const activity = copy(session.activity);
        if (patch.project !== undefined) activity.project = patch.project;
        if (patch.features !== undefined) {
          if (patch.features.length === 0) throw new Error('Activity features cannot be empty');
          activity.features = copy(patch.features);
        }
        if (patch.phase !== undefined) activity.phase = patch.phase;
        tx.putSession({ ...session, revision: session.revision + 1, activity });
        for (const intent of intents) tx.putPending(copy(intent));
        return true;
      });
    },
  };
}
