import type { ReportRejectionSnapshot } from './report-rejection.ts';
import type { SessionRecord } from './session-state.ts';
import { createHash } from 'node:crypto';

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
  state: 'pending' | 'delivered' | 'undelivered';
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

export function createReportDiagnosticNotice(session: SessionRecord, reason: string): ResultNotice {
  return createReportRejectionNotice(session, { reportPath: session.launchContext?.reportPath ?? '', bytes: null, reason });
}

export function createReportRejectionNotice(session: SessionRecord, snapshot: ReportRejectionSnapshot): ResultNotice {
  const target = session.notify ?? session.delegatedBy ?? session.launchedBy;
  const items = session.launchContext?.assignment.changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)).join(', ') ?? '';
  const diagnosticHeader = `Agent: ${session.addressId}\nItems: ${items}\nReport: ${snapshot.reportPath}\nReason: `;
  const reason = snapshot.reason.startsWith(diagnosticHeader) ? snapshot.reason.slice(diagnosticHeader.length) : snapshot.reason;
  const bytes = snapshot.bytes === null ? null : createHash('sha256').update(snapshot.bytes).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify([session.runId, snapshot.reportPath, bytes, reason])).digest('hex');
  return { id: `${session.runId}:report-rejected:${fingerprint}`, runId: session.runId,
    recipient: target?.addressId ?? '', recipientRunId: target?.runId ?? null, state: 'pending', attempts: 0,
    lastError: target?.runId ? null : 'Report rejection recipient identity is unavailable',
    text: ['raf event: agent.report-rejected', `Agent: ${session.addressId}`, `Run: ${session.runId}`,
      `Items: ${items}`, `Report: ${snapshot.reportPath}`, `Reason: ${reason}`].join('\n'),
    source: { runId: session.runId, addressId: session.addressId, revision: session.revision, state: session.state,
      ...(session.activity ? { activity: structuredClone(session.activity) } : {}) } };
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
    reason: session.result ? null : session.abortReason ?? NO_REPORT_REASON,
  };
  return { id: `${session.runId}:result-notice`, runId: session.runId, recipient: target.addressId,
    recipientRunId: target.runId, state: 'pending', attempts: 0, lastError: null, text: resultNoticeText(content),
    source: { runId: session.runId, addressId: session.addressId, revision: session.revision, state: session.state,
      ...(session.activity ? { activity: structuredClone(session.activity) } : {}) } };
}
