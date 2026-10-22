import type { SessionRecord } from './session-state.ts';

export const LAUNCHER_FALLBACK = 'main';
export const NO_REPORT_REASON = 'процес завершився без валідного звіту';

export type LauncherNoticeStatus = 'succeeded' | 'failed';

export type LauncherNoticeContent = {
  address: string;
  status: LauncherNoticeStatus;
  items: readonly string[];
  reportPath: string;
  answer: string;
  reason: string | null;
};

export type LauncherNoticeDelivery = {
  id: string;
  recipient: string;
  state: 'pending' | 'delivered';
  attempts: number;
  lastError: string | null;
};

export type PsSessionView = SessionRecord & { launcherNotice?: LauncherNoticeDelivery };

export function launcherRecipient(session: SessionRecord, sessions: readonly SessionRecord[]): string {
  throw new Error('NotImplemented: launcherRecipient');
}

export function launcherNoticeText(content: LauncherNoticeContent): string {
  throw new Error('NotImplemented: launcherNoticeText');
}
