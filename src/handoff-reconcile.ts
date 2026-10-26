import { isDeepStrictEqual } from 'node:util';
import { sameProcessOwnership } from './process-identity.ts';
import { listTaskReservations, type MachineBootIdentity, type ReservationProcessIdentity, type TaskReservationSet } from './task-reservations.ts';
import type { ProcessObservation } from './session-state.ts';
import type { StateStore } from './state-store.ts';

export async function reconcileHandoffLaunches(dependencies: {
  store: StateStore;
  currentBoot(): Promise<MachineBootIdentity>;
  observe(identity: ReservationProcessIdentity): Promise<ProcessObservation>;
  stopWorker(identity: ReservationProcessIdentity, runner: string): Promise<boolean>;
  stopRunner(tmuxSession: string, runner: string): Promise<boolean>;
}): Promise<boolean> {
  const { store } = dependencies;
  const current = (set: TaskReservationSet) => store.taskReservationRepository.transaction(tx => {
    const session = tx.getSession(set.lease.owner.runId);
    const reservation = tx.listTaskReservations().find(row => isDeepStrictEqual(row.lease, set.lease));
    return session?.state === 'reserved' && session.addressId === set.lease.owner.addressId && reservation?.stage === 'handoff'
      && isDeepStrictEqual(reservation.wrapper, set.wrapper) ? session : undefined;
  });
  const unknown = (message: string): never => { throw Object.assign(new Error(message), { code: 'TASK_LIVENESS_UNKNOWN' }); };
  let boot: MachineBootIdentity | undefined;
  let stopped = false;
  for (const set of listTaskReservations(store)) {
    if (set.stage !== 'handoff' || !current(set)) continue;
    boot ??= await dependencies.currentBoot();
    if (set.boot.machineId !== boot.machineId || set.boot.bootId !== boot.bootId) continue;
    const observe = async (identity: ReservationProcessIdentity | undefined) => {
      if (!identity || identity.evidence.runId !== set.lease.owner.runId ||
          identity.evidence.machineId !== boot!.machineId || identity.evidence.bootId !== boot!.bootId) return unknown('Incomplete handoff process identity');
      const observation = await dependencies.observe(identity);
      if (observation.state === 'unknown') return unknown(`Handoff process scan unknown: ${observation.error}`);
      return observation.state === 'alive' && sameProcessOwnership(identity, observation.identity) ? 'alive' : 'exited';
    };
    if (await observe(set.starter) === 'alive') continue;
    const wrapper = await observe(set.wrapper);
    const session = current(set);
    if (!session) continue;
    const runner = session.launchContext?.selection.runner;
    if (!runner || !set.wrapper) return unknown('Handoff launch metadata is unavailable');
    if (wrapper === 'alive' && !await dependencies.stopWorker(set.wrapper, runner)) return unknown('Handoff worker termination is unconfirmed');
    if (!current(set)) continue;
    if (!await dependencies.stopRunner(set.wrapper.tmuxSession, runner)) return unknown('Handoff runner termination is unconfirmed');
    stopped = true;
  }
  return stopped;
}
