import type { DatabaseSync } from 'node:sqlite';
import type { AgentReportResult } from './agent-report.ts';
import type { AssignmentSnapshot } from './assignment.ts';
import type { PendingIntent, SessionRecord } from './session-state.ts';
import { bindStartupContextReview, pendingStartupContextReviewEvent, settleStartupContextReview, listStartupContextReviewEvents, pruneStartupContextTraces, readStartupContextTrace, recordStartupContextCompletion, type StartupContextCapturePorts } from './startup-context.ts';
import { captureStartupContextJournal, type StartupContextJournal } from './startup-context-journal.ts';

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
  let session = ports.sessions.get(runId);
  if (!session) throw new Error('Unknown startup context run');
  if (session.state === 'finished') {
    settleStartupContextReview(ports.database, { reviewRunId: runId, status: session.result?.status ?? 'failed', finishedAt: session.finishedAt! });
    return session;
  }
  if (session.state !== 'exited' || session.observation?.state !== 'exited') throw new Error('Confirmed runner exit is required before startup context finalization');
  const report = await ports.sessions.acceptReport(session);
  session = ports.sessions.get(runId) ?? session;
  const finishedAt = ports.now();
  const pending: PendingIntent[] = [];
  try {
    let trace = readStartupContextTrace(ports.database, runId);
    if (!trace) {
      const journal = await ports.collectJournal(session);
      const briefParts = await ports.readBriefParts(session);
      const runner = session.process?.runner ?? session.launchContext?.selection.runner;
      if (runner !== 'claude' && runner !== 'codex') throw new Error('Unsupported startup context runner');
      trace = captureStartupContextJournal({ runId, agentType: session.activity?.type ?? 'unknown', phase: session.activity?.phase ?? 'unknown', runner, journal, briefParts, report: report.report }, ports);
    }
    recordStartupContextCompletion(ports.database, { runId, phase: trace.phase, trace, finishedAt, flowPath: ports.flowPath, mainAddress: ports.mainAddress });
  } catch {
    ports.diagnostic(`Startup context collection failed for run ${runId}`);
  }
  if (session.activity?.phase === 'context-review') {
    settleStartupContextReview(ports.database, { reviewRunId: runId, status: report.status, finishedAt });
  }
  const event = pendingStartupContextReviewEvent(ports.database);
  if (event && !event.mainDelivery) pending.push({ id: event.id, runId, event: event.event, payload: { to: event.to, runIds: event.runIds } });
  const finished = await ports.sessions.finish(session, finishedAt, pending);
  if (finished.state === 'finished') await ports.removeRunDirectory(session);
  return finished;
}

export function reserveStartupContextReview(
  input: { readonly runId: string; readonly phase: 'context-review'; readonly brief: string; readonly assignment?: AssignmentSnapshot },
  ports: Pick<StartupContextLifecyclePorts, 'database'>,
): StartupContextReviewReservation | undefined {
  const packageIds = new Set(input.assignment?.changes.flatMap(change => change.items.flatMap(item =>
    [...item.description.matchAll(/\bcontext-review\.due\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/giu)].map(match => match[1].toLowerCase()),
  )));
  if (packageIds.size === 0) return undefined;
  listStartupContextReviewEvents(ports.database);
  ports.database.exec('SAVEPOINT reserve_startup_context_review');
  try {
    const open = ports.database.prepare('SELECT id FROM startup_context_reviews WHERE closed_at IS NULL AND review_run_id IS NULL').all();
    const row = open.find(review => packageIds.has(review.id as string));
    const event = pendingStartupContextReviewEvent(ports.database);
    if (!row || !event) {
      ports.database.exec('RELEASE reserve_startup_context_review');
      return undefined;
    }
    for (const review of open) {
      bindStartupContextReview(ports.database, { eventId: review.id as string, reviewRunId: input.runId, phase: input.phase });
    }
    const reservation = { contextReviewId: row.id as string, runIds: event.runIds as string[], brief: `${input.brief}\n\ncontextReviewId: ${row.id}\nrunIds: ${JSON.stringify(event.runIds)}\n` };
    ports.database.exec('RELEASE reserve_startup_context_review');
    return reservation;
  } catch (error) {
    ports.database.exec('ROLLBACK TO reserve_startup_context_review; RELEASE reserve_startup_context_review');
    throw error;
  }
}

export function cleanupStartupContextCompleted(
  now: string,
  ports: Pick<StartupContextLifecyclePorts, 'database' | 'flowPath'> & {
    readonly sessions: Pick<StartupContextLifecyclePorts['sessions'], 'cleanupCompleted'>;
  },
): number {
  pruneStartupContextTraces(ports.database, { now, flowPath: ports.flowPath });
  return ports.sessions.cleanupCompleted(now);
}
