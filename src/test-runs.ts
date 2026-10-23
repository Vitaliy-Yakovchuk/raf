export type TestRunOutcome = 'passed' | 'assertions-failed' | 'setup-failed' | 'timed-out' | 'interrupted' | 'refused' | 'unverified-remainder';
export type TestRunFailureKind = 'refusal' | 'setup' | 'assertions' | 'timeout' | 'interruption';
export type TestRunNextAction = 'complete' | 'fix-setup' | 'implement' | 'fix-implementation' | 'optimize' | 'confirm-known-red' | 'review-remainder' | 'retry' | 'reconcile';

export interface TestId {
  file: string;
  name: string;
}

export interface TestRunRequest {
  project: string;
  phase: string;
  group: string;
  files?: string[];
  only?: TestId[];
}

export interface ParsedTestRunArgs {
  project: string;
  phase: string;
  group: string;
  files?: string[];
  only?: string[];
}

export interface UnitTestPolicy {
  timeoutMs: number;
  optimizeAfterTimeouts: number;
  maxGroupTimeouts: number;
}

export interface TestRunProfile {
  cwd: string;
  executable: string;
  argv: string[];
  unitFiles: string[];
  exactIds: 'node-test-name' | null;
  resultAdapter: 'node-test-events';
  environment: { isolatedHome: boolean; stateOrigin: boolean };
  checks: string[];
}

export interface TestRunConfig {
  phases: Record<string, { allowed: boolean; purpose: 'initial-red' | 'verification' | 'none'; hints: Record<TestRunFailureKind, string> }>;
  hints: Record<string, string>;
  projects: Record<string, {
    profiles: Record<string, TestRunProfile>;
    groups: Record<string, { profileId: string; files: string[] }>;
  }>;
}

export interface TestRunContext {
  cwd: string;
  workspace: string;
  projectWorkspaces: Record<string, string[]>;
  agentPhases: string[];
  activeChanges: string[];
  agentId: string;
  sha: string;
  home: string;
  statePath: string;
  tmpPath: string;
  operationalHome: string;
}

export interface TestFileFact {
  kind: 'file' | 'directory';
  realpath: string;
  unit: boolean;
}

export interface TestRunEnvironment {
  canonicalWorkspace: string;
  canonicalCwd: string;
  gitIdentityMatches: boolean;
  runtimeAvailable: boolean;
  localRunnerAvailable: boolean;
  dependenciesAvailable: boolean;
  resultAdapterAvailable: boolean;
  artifactsWritable: boolean;
  treeControlSupported: boolean;
  isolatedHome: boolean;
  stateOriginAllowed: boolean;
  stateAliasesOperational: boolean;
  tmpAliasesOperational: boolean;
  inheritedOperationalChannel: boolean;
  unitFiles: string[];
  files: Record<string, TestFileFact>;
}

export interface TestRunCommand {
  executable: string;
  argv: string[];
  cwd: string;
  shell: false;
  environment: { HOME: string; statePath: string; tmpPath: string };
}

export interface TestRunPlan {
  request: TestRunRequest;
  workspace: string;
  profileId: string;
  selection: { files: string[]; testIds: TestId[] };
  command: TestRunCommand;
}

export type RunnerEvent =
  | { kind: 'passed' | 'assertion-failed' | 'setup-failed'; test: TestId; diagnostic?: string }
  | { kind: 'complete'; expected: TestId[] }
  | { kind: 'protocol-error'; diagnostic: string };

export interface ChildExit {
  exitCode: number | null;
  signal: string | null;
  stderr: string;
}

export interface RunnerClassification {
  outcome: TestRunOutcome;
  failureKinds: TestRunFailureKind[];
  passed: TestId[];
  knownRed: TestId[];
  unexecuted: TestId[];
  unknown: TestId[];
}

export interface TestRunCleanup {
  complete: boolean;
  remainingPids: number[];
}

export interface TestRunResult extends RunnerClassification {
  runId: string;
  project: string;
  workspace: string;
  phase: string;
  group: string;
  profileId: string | null;
  selection: { files: string[]; testIds: TestId[] };
  command: TestRunCommand | null;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cleanup: TestRunCleanup;
  groupState: 'idle' | 'running' | 'optimize' | 'confirm-known-red' | 'unverified-remainder' | 'reconcile' | 'complete';
  timeoutCount: number;
  nextAction: TestRunNextAction;
  hintIds: string[];
  hints: string[];
  evidence: string[];
  errorCode?: string;
}

export interface TestRunGroupKey {
  project: string;
  workspace: string;
  group: string;
}

export interface TestRunGroup {
  key: TestRunGroupKey;
  timeoutCount: number;
  state: TestRunResult['groupState'];
  selection: TestRunPlan['selection'];
  knownRed: TestId[];
  unexecuted: TestId[];
  inFlight: { runId: string; deadlineMs: number; processIdentity: string | null } | null;
  lastResult: TestRunResult | null;
}

export interface TestRunTransaction {
  get(key: TestRunGroupKey): TestRunGroup | null;
  list(project: string, workspace: string): TestRunGroup[];
  put(group: TestRunGroup): void;
  delete(key: TestRunGroupKey): void;
}

export interface TestRunStatePort {
  transaction<T>(operation: (transaction: TestRunTransaction) => T): Promise<T>;
}

export interface ManagedTestProcess {
  identity: string;
  wait(): Promise<ChildExit>;
  cleanup(deadlineMs: number, reason: 'exit' | 'timeout' | 'interruption' | 'recovery'): Promise<TestRunCleanup>;
}

export interface TestRunPorts {
  preflight(context: TestRunContext): Promise<TestRunEnvironment>;
  state: TestRunStatePort;
  clock: { now(): number; schedule(deadlineMs: number, callback: () => void): () => void };
  newRunId(): string;
  spawn(command: TestRunCommand, onEvent: (event: RunnerEvent) => void): Promise<ManagedTestProcess>;
  subscribeInterruption(callback: (signal: string) => void): () => void;
  reconcile(processIdentity: string | null, deadlineMs: number): Promise<{ alive: boolean; deadlineReached: boolean; cleanup: TestRunCleanup }>;
}

export function parseTestRunArgs(argv: readonly string[]): ParsedTestRunArgs {
  throw new Error('NotImplemented');
}

export function validateTestRunConfig(config: unknown, phases: readonly string[], policy: UnitTestPolicy): TestRunConfig {
  throw new Error('NotImplemented');
}

export function planTestRun(request: TestRunRequest, config: TestRunConfig, context: TestRunContext, environment: TestRunEnvironment): TestRunPlan {
  throw new Error('NotImplemented');
}

export function classifyRunnerResult(events: readonly RunnerEvent[], exit: ChildExit): RunnerClassification {
  throw new Error('NotImplemented');
}

export async function runTestRun(request: TestRunRequest, config: unknown, policy: UnitTestPolicy, context: TestRunContext, ports: TestRunPorts): Promise<TestRunResult> {
  throw new Error('NotImplemented');
}

export async function reconcileTestRunGroup(key: TestRunGroupKey, policy: UnitTestPolicy, context: TestRunContext, ports: TestRunPorts): Promise<TestRunGroup | null> {
  throw new Error('NotImplemented');
}

export async function cleanupClosedTestRunGroups(activeChanges: readonly string[], context: TestRunContext, ports: TestRunPorts): Promise<void> {
  throw new Error('NotImplemented');
}
