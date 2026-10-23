import type { StateStore } from './state-store.ts';

export interface ReportRejectionSnapshot {
  readonly reportPath: string;
  readonly bytes: Uint8Array | null;
  readonly reason: string;
}

export function recordReportRejection(store: StateStore, runId: string, snapshot: ReportRejectionSnapshot): void {
  throw new Error('NotImplemented');
}
