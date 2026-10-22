import type { ProcessIdentity, ProcessObservation, SessionRecord, SessionTransaction } from './session-state.ts';
import type { StateStore } from './state-store.ts';
import { closeSessionInTransaction } from './session-state.ts';

export type TaskKey = {
  readonly project: string;
  readonly changeId: string;
  readonly taskId: string;
};

export type ReservedTaskSnapshot = {
  readonly key: TaskKey;
  readonly changeInstance: string;
  readonly fingerprint: string;
};

export type TaskReservationOwner = {
  readonly addressId: string;
  readonly runId: string;
  readonly fence: string;
};

export type TaskReservationLease = {
  readonly owner: TaskReservationOwner;
  readonly revision: number;
};

export type MachineBootIdentity = {
  readonly machineId: string;
  readonly bootId: string;
};

export type ReservationProcessIdentity = ProcessIdentity & {
  readonly evidence: ProcessIdentity['evidence'] & MachineBootIdentity & { readonly runId: string };
};

export type TaskReservationSet = {
  readonly lease: TaskReservationLease;
  readonly tasks: readonly ReservedTaskSnapshot[];
  readonly boot: MachineBootIdentity;
  readonly stage: 'starting' | 'handoff' | 'running';
  readonly starter: ReservationProcessIdentity;
  readonly wrapper?: ReservationProcessIdentity;
  readonly agent?: ReservationProcessIdentity;
};

export type ReservedTaskResolution =
  | { readonly state: 'open' | 'completed'; readonly task: ReservedTaskSnapshot; readonly location: 'active' | 'archive' }
  | { readonly state: 'mismatch' | 'unknown'; readonly requested: ReservedTaskSnapshot; readonly reason: string };

export type TaskReservationError = Error & {
  readonly code: 'TASK_LIVENESS_UNKNOWN' | 'TASK_IDENTITY_MISMATCH' | 'TASK_SOURCE_UNKNOWN' | 'TASK_NOT_COMPLETED' | 'TASK_IDENTITY_INVALID';
};

export type TaskReservationDependencies = {
  readonly deferAbandonedFinalization?: boolean;
  readonly store: StateStore;
  readonly currentBoot: () => Promise<MachineBootIdentity>;
  readonly observe: (identity: ProcessIdentity) => Promise<ProcessObservation>;
  readonly resolveTasks: (tasks: readonly ReservedTaskSnapshot[]) => Promise<readonly ReservedTaskResolution[]>;
  readonly newFence: () => string;
};

export type ClaimTasksRequest = {
  readonly addressId: string;
  readonly runId: string;
  readonly tasks: readonly ReservedTaskSnapshot[];
  readonly starter: ReservationProcessIdentity;
  readonly reserveLaunch: (transaction: SessionTransaction) => SessionRecord;
  readonly resolveDelegator?: () => Promise<string | undefined>;
};

export type ClaimTasksResult =
  | { readonly reserved: true; readonly lease: TaskReservationLease }
  | { readonly reserved: false; readonly conflicts: readonly { readonly task: ReservedTaskSnapshot; readonly owner: TaskReservationOwner }[] };

export type HandoffTasksRequest = {
  readonly lease: TaskReservationLease;
  readonly wrapper: ReservationProcessIdentity;
};

export type StartReservedTasksRequest = {
  readonly lease: TaskReservationLease;
  readonly agent: ReservationProcessIdentity;
};

export type ReconcileTasksResult = {
  readonly retained: readonly TaskReservationLease[];
  readonly released: readonly TaskReservationOwner[];
};

export type CompleteReservedTasksRequest = {
  readonly lease: TaskReservationLease;
  readonly tasks: readonly ReservedTaskSnapshot[];
};

export type CompleteReservedTasksResult =
  | { readonly applied: true; readonly lease: TaskReservationLease | null }
  | { readonly applied: false };

export type ReleaseTasksRequest = {
  readonly lease: TaskReservationLease;
  readonly reason: 'cancelled' | 'succeeded' | 'failed';
  readonly closeLaunch: (transaction: SessionTransaction) => void;
};

type ReservationTransaction = Parameters<Parameters<StateStore['taskReservationRepository']['transaction']>[0]>[0];

const copy = <T>(value: T): T => structuredClone(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const taskKey = (task: ReservedTaskSnapshot): string => JSON.stringify([task.key.project, task.changeInstance, task.key.taskId]);
const sourceOf = (task: ReservedTaskSnapshot): string => JSON.stringify([task.key.project, task.key.changeId]);
const sameTask = (left: ReservedTaskSnapshot, right: ReservedTaskSnapshot): boolean =>
  taskKey(left) === taskKey(right) && left.key.changeId === right.key.changeId && left.fingerprint === right.fingerprint;
const sameLease = (left: TaskReservationLease, right: TaskReservationLease): boolean =>
  left.owner.addressId === right.owner.addressId && left.owner.runId === right.owner.runId &&
  left.owner.fence === right.owner.fence && left.revision === right.revision;

function failure(code: TaskReservationError['code'], message: string, context?: unknown, cause?: unknown): TaskReservationError {
  return Object.assign(new Error(`${message}${context === undefined ? '' : `: ${JSON.stringify(context)}`}${cause === undefined ? '' : `; cause: ${cause instanceof Error ? cause.message : String(cause)}`}`, cause === undefined ? undefined : { cause }), { code });
}

function validateTasks(tasks: readonly ReservedTaskSnapshot[]): void {
  if (!Array.isArray(tasks) || !tasks.length) throw failure('TASK_IDENTITY_INVALID', 'A nonempty task snapshot set is required');
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task || !task.key || ![task.key.project, task.key.changeId, task.key.taskId, task.changeInstance, task.fingerprint].every(text)) {
      throw failure('TASK_IDENTITY_INVALID', 'Incomplete task identity', task);
    }
    const key = taskKey(task);
    if (seen.has(key)) throw failure('TASK_IDENTITY_INVALID', 'Duplicate task identity', task);
    seen.add(key);
  }
}

function validProcess(identity: ProcessIdentity | undefined): identity is ReservationProcessIdentity {
  return !!identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && text(identity.startedAt) &&
    Number.isFinite(Date.parse(identity.startedAt)) && text(identity.runner) && text(identity.runnerSessionId) && text(identity.tmuxSession) &&
    !!identity.evidence && [identity.evidence.machineId, identity.evidence.bootId, identity.evidence.runId].every(text) &&
    Object.values(identity.evidence).every(text);
}

function validateProcess(identity: ReservationProcessIdentity, runId: string, boot: MachineBootIdentity): void {
  if (!validProcess(identity) || identity.evidence.runId !== runId || identity.evidence.machineId !== boot.machineId || identity.evidence.bootId !== boot.bootId) {
    throw failure('TASK_IDENTITY_INVALID', 'Process identity does not belong to this run and boot', { runId, identity, boot });
  }
}

function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt && left.runner === right.runner &&
    left.runnerSessionId === right.runnerSessionId && left.tmuxSession === right.tmuxSession &&
    Object.keys(left.evidence).length === Object.keys(right.evidence).length &&
    Object.entries(left.evidence).every(([key, value]) => right.evidence[key] === value);
}

async function currentBoot(dependencies: TaskReservationDependencies): Promise<MachineBootIdentity> {
  try {
    const boot = copy(await dependencies.currentBoot());
    if (!boot || !text(boot.machineId) || !text(boot.bootId)) throw new Error('Missing machine or boot identity');
    return boot;
  } catch (cause) {
    throw failure('TASK_LIVENESS_UNKNOWN', 'Cannot verify current machine boot', undefined, cause);
  }
}

async function observeProcess(dependencies: TaskReservationDependencies, identity: ReservationProcessIdentity | undefined,
  runId: string, boot: MachineBootIdentity, recordedBoot: MachineBootIdentity): Promise<{ alive: boolean; at: string }> {
  const unknown = (message: string, cause?: unknown): never => { throw failure('TASK_LIVENESS_UNKNOWN', message, { runId, identity, boot: recordedBoot }, cause); };
  if (!validProcess(identity) || identity.evidence.runId !== runId || !recordedBoot ||
      identity.evidence.machineId !== recordedBoot.machineId || identity.evidence.bootId !== recordedBoot.bootId) {
    return unknown('Incomplete reservation guard identity');
  }
  if (recordedBoot.machineId !== boot.machineId) return unknown('Reservation belongs to another machine');
  if (recordedBoot.bootId !== boot.bootId) return { alive: false, at: new Date().toISOString() };
  let observation: ProcessObservation;
  try { observation = copy(await dependencies.observe(copy(identity))); }
  catch (cause) { return unknown('Process probe failed', cause); }
  if (!observation || !Number.isFinite(Date.parse(observation.observedAt))) return unknown('Invalid process observation');
  if (observation.state === 'unknown') return unknown(`Process probe returned unknown: ${observation.error}`);
  if (observation.state === 'exited') {
    if (!text(observation.evidence)) return unknown('Process exit has no evidence');
    return { alive: false, at: observation.observedAt };
  }
  if (observation.state !== 'alive' || !validProcess(observation.identity)) return unknown('Process probe has incomplete identity');
  if (observation.identity.evidence.machineId !== boot.machineId || observation.identity.evidence.bootId !== boot.bootId) {
    return unknown('Process probe belongs to another machine or boot');
  }
  return { alive: sameProcess(identity, observation.identity), at: observation.observedAt };
}

const guard = (set: TaskReservationSet): ReservationProcessIdentity | undefined =>
  set.stage === 'starting' ? set.starter : set.stage === 'handoff' ? set.wrapper : set.stage === 'running' ? set.agent : undefined;

async function checkReservations(dependencies: TaskReservationDependencies, boot: MachineBootIdentity) {
  const sets = listTaskReservations(dependencies.store);
  const observations = [];
  for (const set of sets) {
    let observation = await observeProcess(dependencies, guard(set), set.lease.owner.runId, boot, set.boot);
    if (!observation.alive && set.stage === 'running') {
      observation = await observeProcess(dependencies, set.wrapper, set.lease.owner.runId, boot, set.boot);
    }
    observations.push({ set, ...observation });
  }
  return observations;
}

function observationsCurrent(tx: ReservationTransaction, observations: Awaited<ReturnType<typeof checkReservations>>): boolean {
  const current = tx.listTaskReservations();
  return current.length === observations.length && observations.every(({ set }) =>
    current.some(candidate => sameLease(candidate.lease, set.lease)));
}

function closeAbandoned(tx: ReservationTransaction, observations: Awaited<ReturnType<typeof checkReservations>>, deferFinalization = false): void {
  for (const { set, alive, at } of observations) {
    if (alive) continue;
    const session = tx.getSession(set.lease.owner.runId);
    if (!session || session.addressId !== set.lease.owner.addressId) {
      throw failure('TASK_IDENTITY_INVALID', 'Reservation session identity mismatch', set.lease);
    }
    const ended = session.state === 'running' || session.state === 'exited';
    if (ended && deferFinalization) {
      tx.putSession({ ...session, revision: session.revision + 1, state: 'exited', observation: { state: 'exited', observedAt: at, exitCode: null, evidence: 'Task reservation runner and wrapper exit confirmed' } });
      tx.deleteTaskReservation(set.lease.owner.runId);
      returnDelegated(tx, session, set.tasks);
      continue;
    }
    const result = session.result ?? (ended ? { status: 'failed', response: '', proof: null } : undefined);
    closeSessionInTransaction(tx, { ...session, ...(result ? { result } : {}) }, at);
    if (ended) {
      tx.applyEffects([{ id: `${session.runId}:reminders:session-ended`, domain: 'reminders',
        payload: { operation: 'session-ended', runId: session.runId, at,
          end: { address: session.addressId, confirmedSucceeded: result?.status === 'succeeded', crashed: true } } }]);
      if (result?.status !== 'succeeded') tx.putPending({ id: `${session.runId}:agent.failed`, runId: session.runId,
        event: 'agent.failed', payload: { kind: 'agent.failed', id: session.addressId } });
      tx.putPending({ id: `${session.runId}:agent.closed`, runId: session.runId,
        event: 'agent.closed', payload: { kind: 'agent.closed', id: session.addressId, ...(session.activity ? { project: session.activity.project } : {}) } });
    }
    tx.deleteTaskReservation(set.lease.owner.runId);
    returnDelegated(tx, session, set.tasks);
  }
}

async function resolveTasks(dependencies: TaskReservationDependencies, tasks: readonly ReservedTaskSnapshot[], mode: 'claim' | 'complete' | 'retained'): Promise<void> {
  let resolutions: readonly ReservedTaskResolution[];
  try { resolutions = copy(await dependencies.resolveTasks(copy(tasks))); }
  catch (cause) { throw failure('TASK_SOURCE_UNKNOWN', 'OpenSpec task resolution failed', tasks, cause); }
  if (!Array.isArray(resolutions) || resolutions.length !== tasks.length) throw failure('TASK_SOURCE_UNKNOWN', 'Incomplete OpenSpec task resolution', tasks);
  const seen = new Set<string>();
  for (const resolution of resolutions) {
    const resolved = resolution && ('task' in resolution ? resolution.task : resolution.requested);
    if (!resolved?.key) throw failure('TASK_SOURCE_UNKNOWN', 'Malformed OpenSpec task resolution', resolution);
    const task = tasks.find(candidate => taskKey(candidate) === taskKey(resolved));
    if (!task) throw failure('TASK_IDENTITY_MISMATCH', 'OpenSpec returned a different task identity', resolution);
    if (seen.has(taskKey(task))) throw failure('TASK_SOURCE_UNKNOWN', 'Duplicate OpenSpec task resolution', task);
    seen.add(taskKey(task));
    if (resolution.state === 'unknown') throw failure('TASK_SOURCE_UNKNOWN', resolution.reason, task);
    if (resolution.state === 'mismatch') throw failure('TASK_IDENTITY_MISMATCH', resolution.reason, task);
    if (!sameTask(task, resolved)) throw failure('TASK_IDENTITY_MISMATCH', 'OpenSpec task snapshot changed', { requested: task, actual: resolved });
    if (!('location' in resolution) || !['active', 'archive'].includes(resolution.location) || !['open', 'completed'].includes(resolution.state)) {
      throw failure('TASK_SOURCE_UNKNOWN', 'Malformed OpenSpec task state', resolution);
    }
    if (resolution.location === 'archive' && resolution.state !== 'completed') throw failure('TASK_IDENTITY_MISMATCH', 'Archived task is incomplete; main must resolve it', task);
    if ((mode === 'complete' && resolution.state !== 'completed') ||
        (mode === 'claim' && (resolution.state !== 'open' || resolution.location !== 'active'))) {
      throw failure('TASK_NOT_COMPLETED', mode === 'complete' ? 'Task completion is not confirmed' : 'Task is not open for assignment', task);
    }
  }
}

function delegatorSet(tx: ReservationTransaction, runId: string | undefined): TaskReservationSet | undefined {
  if (!runId) return undefined;
  const session = tx.getSession(runId);
  if (!session || session.state !== 'running' || session.activity?.type !== 'coordinator') return undefined;
  return tx.listTaskReservations().find(set => set.lease.owner.runId === runId && set.lease.owner.addressId === session.addressId && set.stage === 'running');
}

function returnDelegated(tx: ReservationTransaction, session: SessionRecord | undefined, tasks: readonly ReservedTaskSnapshot[]): void {
  const link = session?.delegatedBy;
  if (!link || !tasks.length) return;
  const parent = tx.listTaskReservations().find(set => set.lease.owner.runId === link.runId && set.lease.owner.addressId === link.addressId && set.lease.owner.fence === link.fence);
  if (parent) tx.putTaskReservation({ ...parent, tasks: [...parent.tasks, ...tasks], lease: { owner: parent.lease.owner, revision: parent.lease.revision + 1 } });
}

const hasDelegates = (tx: ReservationTransaction, owner: TaskReservationOwner): boolean => tx.listSessions().some(session =>
  session.state !== 'finished' && session.delegatedBy?.runId === owner.runId && session.delegatedBy.fence === owner.fence);

function findLease(tx: ReservationTransaction, lease: TaskReservationLease): TaskReservationSet | undefined {
  return tx.listTaskReservations().find(set => sameLease(set.lease, lease));
}

export async function claimTaskReservations(dependencies: TaskReservationDependencies, input: ClaimTasksRequest): Promise<ClaimTasksResult> {
  const request = { ...input, tasks: copy(input.tasks), starter: copy(input.starter) };
  validateTasks(request.tasks);
  if (!text(request.runId) || !text(request.addressId)) throw failure('TASK_IDENTITY_INVALID', 'Address and run identity are required');
  for (;;) {
    const boot = await currentBoot(dependencies);
    validateProcess(request.starter, request.runId, boot);
    const starter = await observeProcess(dependencies, request.starter, request.runId, boot, boot);
    if (!starter.alive) throw failure('TASK_IDENTITY_INVALID', 'Starter is no longer alive', { runId: request.runId });
    const observations = await checkReservations(dependencies, boot);
    const sources = new Set(request.tasks.map(sourceOf));
    const assigned = observations.flatMap(({ set }) => set.tasks.filter(task => sources.has(sourceOf(task))));
    if (assigned.length) await resolveTasks(dependencies, assigned, 'retained');
    await resolveTasks(dependencies, request.tasks, 'claim');
    const requested = new Set(request.tasks.map(taskKey));
    const delegator = request.resolveDelegator && observations.some(({ set }) => set.tasks.some(task => requested.has(taskKey(task))))
      ? await request.resolveDelegator() : undefined;
    const result = dependencies.store.taskReservationRepository.transaction<ClaimTasksResult | null>(tx => {
      if (!observationsCurrent(tx, observations)) return null;
      closeAbandoned(tx, observations, dependencies.deferAbandonedFinalization);
      const conflicts: { task: ReservedTaskSnapshot; owner: TaskReservationOwner }[] = [];
      for (const task of request.tasks) {
        for (const set of tx.listTaskReservations()) {
          if (set.tasks.some(candidate => taskKey(task) === taskKey(candidate))) conflicts.push({ task: copy(task), owner: copy(set.lease.owner) });
        }
      }
      const parent = delegatorSet(tx, delegator);
      const foreign = conflicts.filter(conflict => conflict.owner.runId !== parent?.lease.owner.runId);
      if (foreign.length) return { reserved: false, conflicts: foreign };
      if (tx.getSession(request.runId)) throw new Error('Run identity already exists');
      if (tx.listSessions().some(session => session.addressId === request.addressId && session.state !== 'finished')) throw new Error('Address already has an active session');
      const fence = dependencies.newFence();
      if (!text(fence)) throw failure('TASK_IDENTITY_INVALID', 'A unique unpredictable fence is required');
      const session = request.reserveLaunch(tx);
      const persisted = tx.getSession(request.runId);
      if (!session || session.runId !== request.runId || session.addressId !== request.addressId || session.state !== 'reserved' ||
          !persisted || persisted.runId !== request.runId || persisted.addressId !== request.addressId || persisted.state !== 'reserved' ||
          !tx.listReservations().some(reservation => reservation.runId === request.runId)) throw failure('TASK_IDENTITY_INVALID', 'Launch participant did not reserve the requested session and admission', { runId: request.runId, addressId: request.addressId });
      if (parent && conflicts.length) {
        tx.putTaskReservation({ ...parent, tasks: parent.tasks.filter(task => !requested.has(taskKey(task))),
          lease: { owner: parent.lease.owner, revision: parent.lease.revision + 1 } });
        tx.putSession({ ...persisted, revision: persisted.revision + 1, delegatedBy: copy(parent.lease.owner) });
      }
      const lease: TaskReservationLease = { owner: { addressId: request.addressId, runId: request.runId, fence }, revision: 0 };
      tx.putTaskReservation({ lease, tasks: request.tasks, boot, stage: 'starting', starter: request.starter });
      return { reserved: true, lease: copy(lease) };
    });
    if (result) return result;
  }
}

async function advanceReservation(dependencies: TaskReservationDependencies, lease: TaskReservationLease,
  identity: ReservationProcessIdentity, stage: 'handoff' | 'running'): Promise<TaskReservationLease | null> {
  const set = listTaskReservations(dependencies.store).find(candidate => sameLease(candidate.lease, lease));
  if (!set || set.stage !== (stage === 'handoff' ? 'starting' : 'handoff')) return null;
  const boot = await currentBoot(dependencies);
  validateProcess(identity, lease.owner.runId, boot);
  const previous = await observeProcess(dependencies, guard(set), lease.owner.runId, boot, set.boot);
  const next = await observeProcess(dependencies, identity, lease.owner.runId, boot, boot);
  if (!previous.alive || !next.alive) return null;
  return dependencies.store.taskReservationRepository.transaction(tx => {
    const current = findLease(tx, lease);
    if (!current || current.stage !== set.stage) return null;
    const updated: TaskReservationSet = { ...current, stage, lease: { owner: current.lease.owner, revision: current.lease.revision + 1 },
      ...(stage === 'handoff' ? { wrapper: identity } : { agent: identity }) };
    tx.putTaskReservation(updated);
    if (stage === 'handoff') {
      const session = tx.getSession(lease.owner.runId);
      if (!session || session.addressId !== lease.owner.addressId || session.state !== 'reserved') {
        throw failure('TASK_IDENTITY_INVALID', 'Wrapper handoff session changed', lease);
      }
      if (session.launchContext) tx.putSession({ ...session, revision: session.revision + 1,
        launchContext: { ...session.launchContext, wrapper: copy(identity) } });
    }
    return copy(updated.lease);
  });
}

export async function handoffTaskReservations(dependencies: TaskReservationDependencies, request: HandoffTasksRequest): Promise<TaskReservationLease | null> {
  return advanceReservation(dependencies, copy(request.lease), copy(request.wrapper), 'handoff');
}

export async function startTaskReservations(dependencies: TaskReservationDependencies, request: StartReservedTasksRequest): Promise<TaskReservationLease | null> {
  return advanceReservation(dependencies, copy(request.lease), copy(request.agent), 'running');
}

export async function reconcileTaskReservations(dependencies: TaskReservationDependencies): Promise<ReconcileTasksResult> {
  for (;;) {
    const boot = await currentBoot(dependencies);
    const observations = await checkReservations(dependencies, boot);
    const result = dependencies.store.taskReservationRepository.transaction(tx => {
      if (!observationsCurrent(tx, observations)) return null;
      closeAbandoned(tx, observations, dependencies.deferAbandonedFinalization);
      return { retained: observations.filter(item => item.alive).map(item => copy(item.set.lease)),
        released: observations.filter(item => !item.alive).map(item => copy(item.set.lease.owner)) };
    });
    if (result) return result;
  }
}

export async function completeTaskReservations(dependencies: TaskReservationDependencies, input: CompleteReservedTasksRequest): Promise<CompleteReservedTasksResult> {
  const request = copy(input);
  const set = listTaskReservations(dependencies.store).find(candidate => sameLease(candidate.lease, request.lease));
  if (!set) return { applied: false };
  validateTasks(request.tasks);
  for (const task of request.tasks) {
    if (!set.tasks.some(candidate => sameTask(candidate, task))) throw failure('TASK_IDENTITY_MISMATCH', 'Completed task is not part of the original assignment', task);
  }
  await resolveTasks(dependencies, request.tasks, 'complete');
  return dependencies.store.taskReservationRepository.transaction(tx => {
    const current = findLease(tx, request.lease);
    if (!current) return { applied: false };
    const tasks = current.tasks.filter(task => !request.tasks.some(completed => sameTask(task, completed)));
    if (!tasks.length && !hasDelegates(tx, current.lease.owner)) {
      tx.deleteTaskReservation(request.lease.owner.runId);
      return { applied: true, lease: null };
    }
    const lease = { owner: current.lease.owner, revision: current.lease.revision + 1 };
    tx.putTaskReservation({ ...current, tasks, lease });
    return { applied: true, lease: copy(lease) };
  });
}

export async function releaseTaskReservations(dependencies: TaskReservationDependencies, input: ReleaseTasksRequest): Promise<boolean> {
  const request = { ...input, lease: copy(input.lease) };
  const set = listTaskReservations(dependencies.store).find(candidate => sameLease(candidate.lease, request.lease));
  if (!set) return false;
  if (request.reason === 'cancelled') {
    if (set.stage !== 'starting') return false;
  } else if (request.reason === 'succeeded' || request.reason === 'failed') {
    const boot = await currentBoot(dependencies);
    const observation = await observeProcess(dependencies, guard(set), request.lease.owner.runId, boot, set.boot);
    if (observation.alive) return false;
  } else {
    throw failure('TASK_IDENTITY_INVALID', 'Unknown task release reason', request.reason);
  }
  return dependencies.store.taskReservationRepository.transaction(tx => {
    const current = findLease(tx, request.lease);
    if (!current) return false;
    request.closeLaunch(tx);
    const session = tx.getSession(request.lease.owner.runId);
    if (!session || session.addressId !== request.lease.owner.addressId || session.state !== 'finished' ||
        tx.listReservations().some(reservation => reservation.runId === request.lease.owner.runId)) {
      throw failure('TASK_IDENTITY_INVALID', 'Close participant did not close the requested launch', request.lease);
    }
    tx.deleteTaskReservation(request.lease.owner.runId);
    returnDelegated(tx, session, current.tasks);
    return true;
  });
}

export function listTaskReservations(store: StateStore): TaskReservationSet[] {
  return store.taskReservationRepository.transaction(tx => copy(tx.listTaskReservations()));
}
