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

export function resultAddressee(session: SessionRecord & SessionNotify): ResultAddressee {
  throw new Error('NotImplemented: resultAddressee');
}

export function resultNoticeText(content: ResultNoticeContent): string {
  throw new Error('NotImplemented: resultNoticeText');
}
