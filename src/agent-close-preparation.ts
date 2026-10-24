import type { CompiledCatalog } from './catalog.ts';
import { isDeepStrictEqual } from 'node:util';
import { commandFailure } from './cli-contract.ts';
import { forceCloseInTransaction } from './session-state.ts';
import type { SessionRecord, SessionRepository, SessionTransaction } from './session-state.ts';

export type AgentCloseOptions = { force?: boolean; reason?: string };

export type AcceptedCloseReport = {
  runId: string;
  status: 'succeeded' | 'failed';
  eventRecorded: boolean;
};

export interface AgentClosePreparationDependencies {
  compiledCatalog?: CompiledCatalog;
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
  if ((options.force !== undefined && typeof options.force !== 'boolean') || (options.force === true ? typeof options.reason !== 'string' || !options.reason.trim() : options.reason !== undefined)) throw new Error('Force requires a nonempty reason; reason requires force');
  if (session.addressId === 'main') throw new Error('Main cannot be closed');
  await dependencies.acceptPendingReport(session);
  return dependencies.repository.transaction(tx => {
    const current = tx.getSession(session.runId);
    if (!current || current.addressId !== session.addressId || current.state !== 'running' || !current.process || !session.process || !isDeepStrictEqual(current.process, session.process)) throw new Error(`Run ${session.runId} is no longer the selected live session`);
    const fact = dependencies.acceptedReport(tx, current);
    const ready = !!current.result && fact?.runId === current.runId && fact.status === current.result.status && fact.eventRecorded;
    if (!options.force && !ready) {
      const error = commandFailure({ code: 'AGENT_RESULT_PENDING', message: `Звіт запуску ${current.runId} та подію результату ще не прийнято.`, stage: 'close', source: 'agent-control', sourceCode: null, reason: 'Current run lacks an atomically accepted report and result event', received: { id: current.addressId, runId: current.runId }, expected: 'Accepted report and corresponding result event for this runId', found: { id: current.addressId, runId: current.runId, report: fact ? 'accepted' : 'pending', eventRecorded: fact?.eventRecorded ?? false }, completed: [], pending: ['report acceptance', 'close'], retrySafe: true, remediation: ['Дочекайтеся прийняття звіту або повторіть raf agent close --id ID --force --reason TEXT.', 'raf help agent close'] });
      throw Object.assign(error, { code: 'AGENT_RESULT_PENDING' });
    }
    return options.force ? forceCloseInTransaction(tx, current, options.reason!.trim(), dependencies.eventForStatus('failed')) : current;
  });
}
