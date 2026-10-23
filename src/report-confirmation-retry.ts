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
  | { kind: 'transient'; cause: 'writer-busy' | 'source-read-race'; reason: string; item?: string }
  | { kind: 'rejected'; failure: ConfirmationFailure }
  | { kind: 'awaiting-archive'; reason: string };

export interface ConfirmationBudget {
  deadline: number;
  remainingMs: number;
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
  cause: 'writer-busy' | 'source-read-race' | 'deadline';
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
): Promise<ConfirmationOutcome> {
  throw new Error('NotImplemented');
}
