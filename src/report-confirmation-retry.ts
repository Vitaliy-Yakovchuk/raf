export type ConfirmationRoute = 'watcher' | 'worker-result' | 'reconciliation';
export type ConfirmationTrigger = 'snapshot' | 'runner-exit' | 'restart';
export type ConfirmationStage = 'queue' | 'checkbox' | 'final-check' | 'accept';

export interface ConfirmationRequest {
  runId: string;
  reportPath: string;
  runner: string;
  route: ConfirmationRoute;
  trigger: ConfirmationTrigger;
  launchIdentity: string;
}

export interface ConfirmationCandidate {
  bytes: string;
  status: 'succeeded' | 'failed';
  items: readonly string[];
  commits: readonly { repository: string; sha: string }[];
}

export interface ConfirmationFailure {
  code: string;
  reason: string;
  item?: string;
}

export type ConfirmationStepResult =
  | { kind: 'ok' }
  | { kind: 'transient'; cause: 'writer-busy' | 'source-read-race' | 'index-busy'; reason: string; item?: string }
  | { kind: 'rejected'; failure: ConfirmationFailure };

export interface ConfirmationBudget {
  pollMs?: number;
}

export interface ConfirmationStepContext {
  request: ConfirmationRequest;
  candidate: ConfirmationCandidate;
  budget: ConfirmationBudget;
}

export type ConfirmationOutcome =
  | { kind: 'accepted'; status: 'succeeded' | 'failed' }
  | { kind: 'rejected'; failure: ConfirmationFailure }
  | { kind: 'superseded' }
  | { kind: 'no-report' }
  | { kind: 'configuration-error'; pointer: string };

export interface ConfirmationPorts {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  waitForChange?(deadline: number, cause?: ConfirmationTransientError['cause']): Promise<void>;
  runnerProtocol(runner: string): unknown;
  currentRun(): Promise<{ runId: string; state: 'open' | 'accepted' | 'closed' }>;
  readReport(): Promise<
    | { kind: 'candidate'; candidate: ConfirmationCandidate }
    | { kind: 'absent' }
    | { kind: 'invalid'; bytes: string; failure: ConfirmationFailure }
  >;
  enterAttempt(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  releaseAttempt(): Promise<void>;
  confirmCheckboxes(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  finalCheck(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  accept(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  reject(request: ConfirmationRequest, snapshotBytes: string, failure: ConfirmationFailure): Promise<void>;
  finishNoReport(request: ConfirmationRequest): Promise<void>;
}

export async function confirmReportWithRetry(
  request: ConfirmationRequest,
  ports: ConfirmationPorts,
): Promise<ConfirmationOutcome> {
  const pointer = 'conf/raf.json#/runnerProtocols';
  const protocol = ports.runnerProtocol(request.runner) as { timeouts?: { transitionMs?: number; pollMs?: number } } | undefined;
  const transitionMs = protocol?.timeouts?.transitionMs;
  const pollMs = protocol?.timeouts?.pollMs;
  if (typeof transitionMs !== 'number' || !Number.isFinite(transitionMs) || transitionMs <= 0
    || typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs <= 0) return { kind: 'configuration-error', pointer };
  const warnAt = ports.now() + transitionMs;
  let candidate: ConfirmationCandidate | undefined;
  let stage: ConfirmationStage = 'queue';
  let warned = false;
  let reason = '';
  const current = async () => {
    let run: Awaited<ReturnType<ConfirmationPorts['currentRun']>>;
    try { run = await ports.currentRun(); }
    catch (error) { throw confirmationStateTransient(error) ?? error; }
    return run.runId === request.runId && run.state === 'open';
  };
  const fresh = async () => {
    if (!await current()) return false;
    const snapshot = await ports.readReport();
    return snapshot.kind === 'candidate' && snapshot.candidate.bytes === candidate!.bytes;
  };
  for (;;) {
    let step: ConfirmationStepResult = { kind: 'ok' };
    try {
      if (!await current()) return { kind: 'superseded' };
      const snapshot = await ports.readReport();
      if (snapshot.kind === 'absent') {
        if (candidate) return { kind: 'superseded' };
        if (request.trigger === 'runner-exit') await ports.finishNoReport(request);
        return { kind: 'no-report' };
      }
      if (snapshot.kind === 'invalid') {
        if (candidate && snapshot.bytes !== candidate.bytes) return { kind: 'superseded' };
        await ports.reject(request, snapshot.bytes, snapshot.failure);
        return { kind: 'rejected', failure: snapshot.failure };
      }
      if (candidate && snapshot.candidate.bytes !== candidate.bytes) return { kind: 'superseded' };
      candidate ??= snapshot.candidate;
      const context: ConfirmationStepContext = { request, candidate, budget: { pollMs } };
      const steps: [ConfirmationStage, () => Promise<ConfirmationStepResult>][] = [
        ['queue', () => ports.enterAttempt(context)],
        ...(candidate.status === 'succeeded' ? [
          ['checkbox', () => ports.confirmCheckboxes(context)],
        ] as [ConfirmationStage, () => Promise<ConfirmationStepResult>][] : []),
        ['final-check', () => ports.finalCheck(context)],
        ['accept', () => ports.accept(context)],
      ];
      try {
        for (const [nextStage, action] of steps) {
          stage = nextStage;
          if (!await fresh()) return { kind: 'superseded' };
          step = await action();
          if (step.kind !== 'ok') break;
          if (stage === 'accept') return { kind: 'accepted', status: candidate.status };
        }
      } finally { await ports.releaseAttempt(); }
      if (step.kind === 'rejected') {
        if (!await fresh()) return { kind: 'superseded' };
        await ports.reject(request, candidate.bytes, step.failure);
        return { kind: 'rejected', failure: step.failure };
      }
    } catch (caught) {
      const error = confirmationStateTransient(caught) ?? caught;
      if (!confirmationTransient(error)) throw error;
      step = { kind: 'transient', cause: error.cause, reason: error.message };
      if (!candidate) {
        const snapshot = await ports.readReport();
        if (snapshot.kind === 'candidate') candidate = snapshot.candidate;
      }
    }
    if (step.kind === 'transient') reason = step.reason;
    if (!warned && ports.now() >= warnAt) { warned = true; process.stderr.write(`Warning: report confirmation of ${request.runId} still pending after ${transitionMs} ms at stage ${stage}: ${reason}; retrying\n`); }
    if (ports.waitForChange) await ports.waitForChange(ports.now() + pollMs, step.kind === 'transient' ? step.cause : undefined);
    else await ports.sleep(pollMs);
  }
}

export class ConfirmationTransientError extends Error {
  readonly cause: 'writer-busy' | 'source-read-race' | 'index-busy';
  constructor(cause: 'writer-busy' | 'source-read-race' | 'index-busy', reason: string) {
    super(reason);
    this.name = 'ConfirmationTransientError';
    this.cause = cause;
  }
}

export function confirmationTransient(error: unknown): error is ConfirmationTransientError {
  return error instanceof ConfirmationTransientError;
}

export function confirmationStateTransient(error: unknown): ConfirmationTransientError | undefined {
  const source = error as { code?: unknown; errcode?: unknown } | null;
  if (typeof source?.code === 'string' && source.code.startsWith('ERR_SQLITE')
    && typeof source.errcode === 'number' && Number.isSafeInteger(source.errcode)
    && [5, 6].includes(source.errcode & 255)) {
    return new ConfirmationTransientError('source-read-race', error instanceof Error ? error.message : String(error));
  }
}

export async function readConfirmationJournal<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ConfirmationTransientError('source-read-race', `Checkbox operation journal read is incomplete: ${error.message}`);
    throw error;
  }
}
