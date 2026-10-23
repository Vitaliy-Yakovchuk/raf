export type TestKind = 'unit' | 'integration';
export type TestId = { file: string; name: string };
export type TimeoutPolicy = { source: string; timeoutMs: number };
export type TestRunProfileFailure = Error & { code: string; pointer?: string; file?: string };
export type RawConfiguration = Record<string, unknown>;
export type SelectionRequest = {
  project: string;
  workspace: string;
  branch: string;
  phase: string;
  group: string;
  files?: string[];
  only?: TestId[];
};
export type InventoryFact = {
  file: string;
  exists: boolean;
  canonicalInsideWorkspace: boolean;
  kind: TestKind;
};
export type PreparedTestRun = {
  request: SelectionRequest;
  testKind: TestKind;
  profileId: string;
  selection: { files: string[]; testIds: TestId[] };
  command: { executable: string; argv: string[]; cwd: string };
  timeoutPolicy: TimeoutPolicy;
  unitPolicy: { optimizeAfterTimeouts: number; maxGroupTimeouts: number };
};
export type CallerContext = {
  trusted: boolean;
  live: boolean;
  role: string;
  phase: string;
  project: string;
  workspace: string;
  branch: string;
  activeChanges: string[];
  coordinatorAuthorized: boolean;
  sourceChange: string;
  sourceItem: string;
  regressionGroups: { group: string; profileId: string; files: string[] }[];
};
export type CallerAuthorization = { callerPhase: string; sourceChange: string; sourceItem: string };
export type InFlight = { runId: string; startedAtMs: number; deadlineMs: number; timeoutPolicy: TimeoutPolicy };
export type ActiveTestGroup = {
  key: { project: string; workspace: string; group: string };
  profileId: string;
  testKind?: TestKind;
  timeoutCount: number;
  knownRed: TestId[];
  unexecuted: TestId[];
  unknown: TestId[];
  inFlight: InFlight | null;
  lastFinalizedRunId?: string;
};
export type ReservationInput = { runId: string; nowMs: number; agentId: string; sha: string };
export type TestRunReservation = {
  plan: PreparedTestRun;
  authorization: CallerAuthorization;
  aggregate: ActiveTestGroup;
  run: InFlight;
  disposition: 'spawn' | 'reconcile';
};
export type ExecutionFacts = {
  outcome: 'passed' | 'assertions-failed' | 'setup-failed' | 'timed-out' | 'interrupted' | 'refused';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  protocolComplete: boolean;
  cleanup: { complete: boolean; remaining: string[] };
  passed: TestId[];
  knownRed: TestId[];
  unexecuted: TestId[];
  unknown: TestId[];
  failureKinds: string[];
  diagnostics: { kind: string; message: string; origin: string }[];
  diagnosticSummary: Record<string, unknown>;
  environmentSummary: Record<string, unknown>;
};
export type IntegrationContractResult = ExecutionFacts & {
  phase: string;
  callerPhase: string | null;
  testKind: TestKind | null;
  timeoutPolicy: TimeoutPolicy | null;
  selection: PreparedTestRun['selection'];
  command: PreparedTestRun['command'];
  groupState: string;
  nextAction: string;
  timeoutCount: number;
};
export type CompletionDecision = {
  result: IntegrationContractResult;
  aggregate: ActiveTestGroup;
  cliCode: number;
};
export type TestRunTransportEnvelope = { result: IntegrationContractResult; stderr: string; cliCode: number };

export function prepareTestRunProfile(
  configuration: RawConfiguration,
  flow: RawConfiguration,
  request: SelectionRequest,
  inventory: InventoryFact[],
): PreparedTestRun {
  throw new Error('NotImplemented');
}

export function authorizeTestRunProfile(
  plan: PreparedTestRun,
  caller: CallerContext,
): CallerAuthorization {
  throw new Error('NotImplemented');
}

export function reserveTestRunProfile(
  plan: PreparedTestRun,
  authorization: CallerAuthorization,
  aggregate: ActiveTestGroup | null,
  input: ReservationInput,
): TestRunReservation {
  throw new Error('NotImplemented');
}

export function completeTestRunProfile(
  reservation: TestRunReservation,
  execution: ExecutionFacts,
): CompletionDecision {
  throw new Error('NotImplemented');
}

export function testRunTransportDeadline(
  reservation: TestRunReservation,
  readinessTimeoutMs: number,
): number {
  throw new Error('NotImplemented');
}

export async function relayTestRunProfileResult(
  reservation: TestRunReservation,
  exchange: (deadlineMs: number) => Promise<TestRunTransportEnvelope>,
): Promise<TestRunTransportEnvelope> {
  throw new Error('NotImplemented');
}
