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
  throw new Error('NotImplemented');
}
