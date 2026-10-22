import type { DatabaseSync } from 'node:sqlite';
import type { AgentReportResult } from './agent-report.ts';
import type { PendingIntent, SessionRecord } from './session-state.ts';
import { bindStartupContextReview, settleStartupContextReview, listStartupContextReviewEvents, pruneStartupContextTraces, readStartupContextTrace, recordStartupContextCompletion, type StartupContextCapturePorts } from './startup-context.ts';
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
    for (const event of listStartupContextReviewEvents(ports.database).filter(event => event.runIds.includes(runId))) {
      pending.push({ id: event.id, runId, event: event.event, payload: { to: event.to, runIds: event.runIds } });
    }
  } catch {
    ports.diagnostic(`Startup context collection failed for run ${runId}`);
  }
  const finished = await ports.sessions.finish(session, finishedAt, pending);
  if (session.activity?.phase === 'context-review') {
    settleStartupContextReview(ports.database, { reviewRunId: runId, status: report.status, finishedAt });
  }
  if (finished.state === 'finished') await ports.removeRunDirectory(session);
  return finished;
}

export function reserveStartupContextReview(
  input: { readonly runId: string; readonly phase: 'context-review'; readonly brief: string },
  ports: Pick<StartupContextLifecyclePorts, 'database'>,
): StartupContextReviewReservation {
  listStartupContextReviewEvents(ports.database);
  ports.database.exec('SAVEPOINT reserve_startup_context_review');
  try {
    const row = ports.database.prepare('SELECT id, payload FROM startup_context_reviews WHERE closed_at IS NULL AND review_run_id IS NULL ORDER BY rowid LIMIT 1').get();
    if (!row) throw new Error('No open unbound startup context review package is available');
    const event = JSON.parse(row.payload as string);
    bindStartupContextReview(ports.database, { eventId: row.id as string, reviewRunId: input.runId, phase: input.phase });
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
