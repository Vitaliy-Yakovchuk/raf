import { sameProcessOwnership } from './process-identity.ts';
import { forceCloseInTransaction } from './session-state.ts';
import type { SessionRecord, SessionRepository, SessionTransaction } from './session-state.ts';

export type AgentCloseOptions = { force?: boolean; reason?: string };

export type AcceptedCloseReport = {
  runId: string;
  status: 'succeeded' | 'failed';
  eventRecorded: boolean;
};

export interface AgentClosePreparationDependencies {
  repository: SessionRepository;
  acceptPendingReport(session: SessionRecord): Promise<SessionRecord>;
  acceptedReport(transaction: SessionTransaction, session: SessionRecord): AcceptedCloseReport | null;
  eventForStatus(status: 'succeeded' | 'failed'): string;
}

export async function prepareAgentClose(
  dependencies: AgentClosePreparationDependencies,
  session: SessionRecord,
  options: AgentCloseOptions = {},
): Promise<SessionRecord> {
  if (!options.force) await dependencies.acceptPendingReport(session);
  return dependencies.repository.transaction(tx => {
    const current = tx.getSession(session.runId);
    if (!current || current.addressId !== session.addressId || !current.process || !session.process || !sameProcessOwnership(current.process, session.process)) throw new Error(`Run ${session.runId} is no longer the selected live session`);
    const fact = dependencies.acceptedReport(tx, current);
    const ready = !!current.result && fact?.runId === current.runId && fact.status === current.result.status && fact.eventRecorded;
    const closeAsFailed = options.force === true || !ready;
    if (current.state !== 'running' && !(closeAsFailed && current.state === 'exited')) throw new Error(`Run ${session.runId} is no longer the selected live session`);
    return closeAsFailed ? forceCloseInTransaction(tx, current, options.reason?.trim() || 'Closed without an accepted report', dependencies.eventForStatus('failed')) : current;
  });
}
