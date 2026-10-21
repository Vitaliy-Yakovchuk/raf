import type { ResourceAdmission, ResourceAdmissionInput, ResourceMeasurement, ResourceReservation } from './resource-admission.ts';
import type { PendingIntent, ProcessIdentity, SessionActivity, SessionLaunchContext, SessionRecord, SessionRepository } from './session-state.ts';

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
  requiredFileSystemIds: string[];
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

export function createLaunchState(dependencies: LaunchStateDependencies): LaunchState {
  const { repository, measure, evaluateAdmission } = dependencies;
  const copy = <T>(value: T): T => structuredClone(value);
  const sameIdentity = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
    Number.isInteger(left.pid) && left.pid > 0 && Number.isFinite(Date.parse(left.startedAt)) &&
    !!left.runner && !!left.runnerSessionId && !!left.tmuxSession &&
    left.pid === right.pid && left.startedAt === right.startedAt && left.runner === right.runner &&
    left.runnerSessionId === right.runnerSessionId && left.tmuxSession === right.tmuxSession &&
    !!left.evidence && !!right.evidence && Object.keys(left.evidence).length > 0 &&
    Object.keys(left.evidence).length === Object.keys(right.evidence).length &&
    Object.entries(left.evidence).every(([key, value]) => typeof value === 'string' && right.evidence[key] === value);
  return {
    async reserveLaunch(input) {
      const request = copy(input);
      if (!request.runId || !request.addressId) throw new Error('Address and run identity are required');
      if (request.addressId === 'main' || request.activity.type === 'main') throw new Error('Main must register an existing process');
      const measured = copy(await measure(copy(request)));
      return repository.transaction<LaunchReservationResult>(tx => {
        if (tx.getSession(request.runId)) throw new Error('Run identity already exists');
        if (tx.listSessions().some(session => session.addressId === request.addressId && session.state !== 'finished')) {
          throw new Error('Address already has an active session');
        }
        const unusedReservations: ResourceReservation[] = [];
        for (const reservation of tx.listReservations()) {
          if (!reservation.resourceBundle || !reservation.resourceBundle.machineId) {
            return { reserved: false, admission: {
              level: 'UNKNOWN', allowed: { normal: false, hotfix: false },
              reasons: ['Existing reservation has no resource bundle or machine identity'],
              measurement: measured.measurement, remaining: null,
            } };
          }
          if (reservation.resourceBundle.machineId !== measured.measurement.machineId) continue;
          const session = tx.getSession(reservation.runId);
          const consumed = session?.state === 'running' && session.process && measured.observedProcesses.some(
            observed => observed.runId === reservation.runId && sameIdentity(session.process!, observed.identity));
          if (!consumed) unusedReservations.push(copy(reservation.resourceBundle.resources));
        }
        const admission = evaluateAdmission({
          measurement: measured.measurement,
          requested: copy(request.requested), unusedReservations,
          requiredFileSystemIds: copy(request.requiredFileSystemIds),
        });
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
      });
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
