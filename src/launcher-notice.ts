import type { SessionRecord } from './session-state.ts';

export const DEFAULT_LAUNCHER = 'main';
export const NO_REPORT_REASON = 'процес завершився без валідного звіту';
export const NOTIFY_TARGET_INVALID = 'NOTIFY_TARGET_INVALID';

export type NotifyTarget = { addressId: string; runId: string };
export type SessionNotify = { notify?: NotifyTarget };
export type ResultAddressee = { addressId: string; runId: string | null };

export type ResultNoticeStatus = 'succeeded' | 'failed';

export type ResultNoticeContent = {
  address: string;
  status: ResultNoticeStatus;
  items: readonly string[];
  reportPath: string;
  answer: string;
  reason: string | null;
};

export type ResultNoticeDelivery = {
  id: string;
  recipient: string;
  state: 'pending' | 'delivered';
  attempts: number;
  lastError: string | null;
};

export type PsSessionView = SessionRecord & SessionNotify & { resultNotice?: ResultNoticeDelivery };

export type ResultNotice = ResultNoticeDelivery & {
  runId: string;
  recipientRunId: string | null;
  text: string;
  source: SessionRecord;
};

export function resultAddressee(session: SessionRecord & SessionNotify): ResultAddressee {
  const target = session.notify ?? session.delegatedBy ?? session.launchedBy;
  return target ? { addressId: target.addressId, runId: target.runId } : { addressId: DEFAULT_LAUNCHER, runId: null };
}

export function resultNoticeText(content: ResultNoticeContent): string {
  return [`raf event: agent.${content.status}`, `Agent: ${content.address}`, `Result: ${content.status}`,
    `Items: ${content.items.join(', ')}`, `Report: ${content.reportPath}`, `Answer: ${content.answer}`,
    ...(content.reason ? [`Reason: ${content.reason}`] : [])].join('\n');
}

export function createResultNotice(session: SessionRecord): ResultNotice | undefined {
  if (!session.launchContext || session.addressId === DEFAULT_LAUNCHER ||
      (!session.result && session.observation?.state !== 'exited')) return undefined;
  const target = resultAddressee(session);
  const content: ResultNoticeContent = {
    address: session.addressId,
    status: session.result?.status === 'succeeded' ? 'succeeded' : 'failed',
    items: session.launchContext.assignment.changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)),
    reportPath: session.launchContext.reportPath,
    answer: session.result?.response ?? '',
    reason: session.result ? null : NO_REPORT_REASON,
  };
  return { id: `${session.runId}:result-notice`, runId: session.runId, recipient: target.addressId,
    recipientRunId: target.runId, state: 'pending', attempts: 0, lastError: null, text: resultNoticeText(content),
    source: { runId: session.runId, addressId: session.addressId, revision: session.revision, state: session.state,
      ...(session.activity ? { activity: structuredClone(session.activity) } : {}) } };
}
