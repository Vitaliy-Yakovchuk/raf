import type { DatabaseSync } from 'node:sqlite';
import type { AgentReportResult } from './agent-report.ts';
import type { PendingIntent, SessionRecord } from './session-state.ts';
import type { StartupContextCapturePorts } from './startup-context.ts';
import type { StartupContextJournal } from './startup-context-journal.ts';

export interface StartupContextLifecyclePorts extends StartupContextCapturePorts {
  readonly database: DatabaseSync;
  readonly flowPath: string;
  readonly mainAddress: string;
  now(): string;
  readonly sessions: {
    get(runId: string): SessionRecord | undefined;
    acceptReport(session: SessionRecord): Promise<AgentReportResult>;
    finish(session: SessionRecord, finishedAt: string, pending: readonly PendingIntent[]): Promise<SessionRecord>;
    cleanupCompleted(now: string): number;
  };
  collectJournal(session: SessionRecord): Promise<StartupContextJournal>;
  readBriefParts(session: SessionRecord): Promise<readonly { readonly source: string; readonly text: string }[]>;
  removeRunDirectory(session: SessionRecord): Promise<void>;
  diagnostic(reason: string): void;
}

export interface StartupContextReviewReservation {
  readonly contextReviewId: string;
  readonly runIds: readonly string[];
  readonly brief: string;
}

export async function finalizeStartupContextRun(
  runId: string,
  ports: StartupContextLifecyclePorts,
): Promise<SessionRecord> {
  throw new Error('NotImplemented');
}

export function reserveStartupContextReview(
  input: { readonly runId: string; readonly phase: 'context-review'; readonly brief: string },
  ports: Pick<StartupContextLifecyclePorts, 'database'>,
): StartupContextReviewReservation {
  throw new Error('NotImplemented');
}

export function cleanupStartupContextCompleted(
  now: string,
  ports: Pick<StartupContextLifecyclePorts, 'database' | 'flowPath' | 'sessions'>,
): number {
  throw new Error('NotImplemented');
}
