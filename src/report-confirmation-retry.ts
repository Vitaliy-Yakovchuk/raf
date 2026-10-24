export type ConfirmationRoute = 'watcher' | 'worker-result' | 'reconciliation';
export type ConfirmationTrigger = 'snapshot' | 'automatic-pass' | 'runner-exit' | 'restart';
export type ConfirmationStage = 'queue' | 'source-before-repair' | 'validate-commits' | 'repair' | 'source-before-checkbox' | 'checkbox' | 'source-before-final' | 'final-check' | 'accept';

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
  | { kind: 'rejected'; failure: ConfirmationFailure }
  | { kind: 'awaiting-archive'; reason: string }
  | { kind: 'budget-exhausted'; reason: string };

export interface ConfirmationBudget {
  deadline: number;
  remainingMs: number;
  pollMs?: number;
}

export interface ConfirmationStepContext {
  request: ConfirmationRequest;
  candidate: ConfirmationCandidate;
  budget: ConfirmationBudget;
}

export interface PendingConfirmation {
  runId: string;
  reportPath: string;
  launchIdentity: string;
  candidateBytes: string;
  stage: ConfirmationStage;
  cause: 'writer-busy' | 'source-read-race' | 'index-busy' | 'deadline';
  reason: string;
  deadline: number;
  exhausted: true;
}

export type ConfirmationOutcome =
  | { kind: 'accepted'; status: 'succeeded' | 'failed' }
  | { kind: 'pending'; diagnostic: PendingConfirmation }
  | { kind: 'rejected'; failure: ConfirmationFailure }
  | { kind: 'superseded' }
  | { kind: 'no-report' }
  | { kind: 'awaiting-archive'; reason: string }
  | { kind: 'configuration-error'; pointer: string };

export interface ConfirmationPorts {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  runnerProtocol(runner: string): unknown;
  currentRun(): Promise<{ runId: string; state: 'open' | 'accepted' | 'closed' }>;
  readReport(): Promise<
    | { kind: 'candidate'; candidate: ConfirmationCandidate }
    | { kind: 'absent' }
    | { kind: 'invalid'; bytes: string; failure: ConfirmationFailure }
  >;
  enterAttempt(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  releaseAttempt(): Promise<void>;
  verifySource(stage: 'source-before-repair' | 'source-before-checkbox' | 'source-before-final', context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  validateCommits(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  repairCommits(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  confirmCheckboxes(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  finalCheck(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  accept(context: ConfirmationStepContext): Promise<ConfirmationStepResult>;
  reject(request: ConfirmationRequest, snapshotBytes: string, failure: ConfirmationFailure): Promise<void>;
  retainPending(diagnostic: PendingConfirmation): Promise<void>;
  scheduleAutomaticPass(request: ConfirmationRequest, resume: () => Promise<ConfirmationOutcome>): Promise<void>;
  finishNoReport(request: ConfirmationRequest): Promise<void>;
}

export async function confirmReportWithRetry(
  request: ConfirmationRequest,
  ports: ConfirmationPorts,
  cycleDeadline?: number,
): Promise<ConfirmationOutcome> {
  const pointer = 'conf/raf.json#/runnerProtocols';
  const protocol = ports.runnerProtocol(request.runner) as { timeouts?: { transitionMs?: number; pollMs?: number } } | undefined;
  const transitionMs = protocol?.timeouts?.transitionMs;
  const pollMs = protocol?.timeouts?.pollMs;
  if (typeof transitionMs !== 'number' || !Number.isFinite(transitionMs) || transitionMs <= 0
    || typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs <= 0) return { kind: 'configuration-error', pointer };
  const deadline = cycleDeadline ?? ports.now() + transitionMs;
  let candidate: ConfirmationCandidate | undefined;
  let stage: ConfirmationStage = 'queue';
  let last: { cause: PendingConfirmation['cause']; reason: string } = { cause: 'deadline', reason: 'Confirmation budget exhausted' };
  const current = async () => {
    const run = await ports.currentRun();
    return run.runId === request.runId && run.state === 'open';
  };
  const fresh = async () => {
    if (!await current()) return false;
    const snapshot = await ports.readReport();
    return snapshot.kind === 'candidate' && snapshot.candidate.bytes === candidate!.bytes;
  };
  const pending = async (): Promise<ConfirmationOutcome> => {
    if (!await fresh()) return { kind: 'superseded' };
    const diagnostic: PendingConfirmation = { runId: request.runId, reportPath: request.reportPath,
      launchIdentity: request.launchIdentity, candidateBytes: candidate!.bytes, stage,
      ...last, deadline, exhausted: true };
    await ports.retainPending(diagnostic);
    await ports.scheduleAutomaticPass(request, () => confirmReportWithRetry({ ...request, trigger: 'automatic-pass' }, ports));
    return { kind: 'pending', diagnostic };
  };
  for (;;) {
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
    if (ports.now() >= deadline) return pending();
    const context: ConfirmationStepContext = { request, candidate, budget: { deadline, remainingMs: deadline - ports.now(), pollMs } };
    let step: ConfirmationStepResult = { kind: 'ok' };
    const steps: [ConfirmationStage, () => Promise<ConfirmationStepResult>][] = [
      ['queue', () => ports.enterAttempt(context)],
      ['source-before-repair', () => ports.verifySource('source-before-repair', context)],
      ['validate-commits', () => ports.validateCommits(context)],
      ['repair', () => ports.repairCommits(context)],
      ...(candidate.status === 'succeeded' ? [
        ['source-before-checkbox', () => ports.verifySource('source-before-checkbox', context)],
        ['checkbox', () => ports.confirmCheckboxes(context)],
      ] as [ConfirmationStage, () => Promise<ConfirmationStepResult>][] : []),
      ['source-before-final', () => ports.verifySource('source-before-final', context)],
      ['final-check', () => ports.finalCheck(context)],
      ['accept', () => ports.accept(context)],
    ];
    try {
      for (const [nextStage, action] of steps) {
        stage = nextStage;
        if (!await fresh()) return { kind: 'superseded' };
        context.budget.remainingMs = Math.max(0, deadline - ports.now());
        if (!context.budget.remainingMs) break;
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
    if (step.kind === 'awaiting-archive') return step;
    if (step.kind === 'budget-exhausted') {
      if (last.cause === 'deadline') last = { cause: 'deadline', reason: step.reason };
      return pending();
    }
    if (step.kind === 'transient') last = { cause: step.cause, reason: step.reason };
    if (ports.now() >= deadline) return pending();
    await ports.sleep(Math.min(pollMs, deadline - ports.now()));
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

export class ConfirmationBudgetExhaustedError extends Error {}
