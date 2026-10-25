export type WorkerTestClass = 'unit' | 'integration' | 'harness' | 'd1' | 'plan-d1';

export interface IntegrationProfileContract {
  testKind?: 'unit' | 'integration';
  cwd: string;
  executable: string;
  argv: string[];
  exactIds: string;
  resultAdapter: string;
  unitFiles?: string[];
  integrationFiles?: string[];
  environment: { isolatedHome: boolean; stateOrigin: boolean };
  checks: string[];
}

export interface InventoryObservation {
  existingFiles: string[];
  classifiedFiles: Record<string, WorkerTestClass>;
  sourceHashes: Record<string, string>;
  expectedSourceHashes: Record<string, string>;
}

export interface ContractFailure {
  errorCode: string;
  pointer: string;
  files: string[];
  reason: string;
}

export interface IntegrationSelection {
  profileId: string;
  files: string[];
}

export interface IntegrationBudget {
  source: string;
  timeoutMs: number;
  deadline: number;
}

export interface EtchlyCommandPlan {
  cwd: string;
  executable: string;
  argv: string[];
  selectedFiles: string[];
  timeoutPolicy: { source: string; timeoutMs: number };
  deadline: number;
  transportDeadline: number;
}

export interface EtchlyEnvironmentObservation {
  missingChecks: string[];
  executableRuntime: boolean;
  compatibleBridge: boolean;
  sharedLibsBranchMatches: boolean;
  resourceProtocolInstalled: boolean;
  localBuildValid: boolean;
  privateTmpWritable: boolean;
  loopbackAvailable: boolean;
  isolatedHome: string;
  operationalHome: string;
  stateOriginVerified: boolean;
  privateRunRoot: string;
  inheritedEnv: Record<string, string>;
}

export interface EtchlyEnvironmentPlan {
  env: Record<string, string>;
  ownedPaths: string[];
}

export interface EtchlyCaller {
  phase: string;
  project: string;
  workspace: string;
  branch: string;
  activeChanges: string[];
  live: boolean;
  trusted: boolean;
  trustedEntrypoint: boolean;
  channelCompatible: boolean;
  isolationVerified: boolean;
  regressionGroups: string[];
}

export interface IntegrationEvent {
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  origin: 'collection' | 'import' | 'global-setup' | 'hook' | 'test-body';
  message?: string;
}

export interface IntegrationCompletion {
  selectedFiles: string[];
  events: IntegrationEvent[];
  protocolComplete: boolean;
  childExitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  cleanupComplete: boolean;
  knownRed: string[];
  unknown: string[];
  unexecuted: string[];
  callerPhase: string;
  budget: IntegrationBudget;
}

export interface EtchlyIntegrationResult {
  outcome: string;
  cliCode: number;
  exitCode: number | null;
  groupState: string;
  nextAction: string;
  phase: 'integration';
  callerPhase: string;
  testKind: 'integration';
  timeoutPolicy: { source: string; timeoutMs: number };
  cleanup: { complete: boolean };
  knownRed: string[];
  unexecuted: string[];
  unknown: string[];
  testIds: string[];
  diagnostics: { origin: string; message: string }[];
}

export interface IntegrationRecoveryObservation {
  deadline: number;
  now: number;
  timeoutCount: number;
  timeoutRecorded: boolean;
  deadlineExceeded: boolean;
  interrupted: boolean;
  concurrentOwnerAlive: boolean;
  processes: { pid: number; owned: boolean; exitConfirmed: boolean }[];
  artifacts: { path: string; owned: boolean; removed: boolean }[];
  files: string[];
}

export interface IntegrationRecoveryPlan {
  deadline: number;
  timeoutCount: number;
  groupState: string;
  nextAction: string;
  retryFiles: string[];
  canSpawn: boolean;
  cleanupComplete: boolean;
  signalPids: number[];
  removePaths: string[];
}

export function validateEtchlyIntegrationInventories(
  profiles: Record<string, IntegrationProfileContract>, observation: InventoryObservation,
): ContractFailure[] {
  throw new Error('NotImplemented');
}

export function selectEtchlyIntegrationPreset(
  profile: IntegrationProfileContract, preset: IntegrationSelection,
  request: { phase: string; files?: string[]; only?: string[] },
): IntegrationSelection | ContractFailure {
  throw new Error('NotImplemented');
}

export function resolveEtchlyIntegrationBudget(
  flow: { unitTests?: { timeoutMs?: unknown }; integrationTests?: { timeoutMs?: unknown } },
  now: number, inFlight?: IntegrationBudget,
): IntegrationBudget | ContractFailure {
  throw new Error('NotImplemented');
}

export function planEtchlyIntegrationCommand(
  root: string, profile: IntegrationProfileContract, selection: IntegrationSelection,
  budget: IntegrationBudget, reporterPath: string,
): EtchlyCommandPlan {
  throw new Error('NotImplemented');
}

export function prepareEtchlyIntegrationEnvironment(
  observation: EtchlyEnvironmentObservation,
): EtchlyEnvironmentPlan | ContractFailure {
  throw new Error('NotImplemented');
}

export function authorizeEtchlyIntegrationCaller(
  caller: EtchlyCaller,
  request: { phase: string; project: string; workspace: string; branch: string; group: string; testKind: 'unit' | 'integration' },
): { callerPhase: string } | ContractFailure {
  throw new Error('NotImplemented');
}

export function completeEtchlyIntegrationRun(completion: IntegrationCompletion): EtchlyIntegrationResult {
  throw new Error('NotImplemented');
}

export function reconcileEtchlyIntegrationRun(observation: IntegrationRecoveryObservation): IntegrationRecoveryPlan {
  throw new Error('NotImplemented');
}

export function classifyEtchlyWorkerTestGraph(input: {
  sources: Record<string, string>;
  testFiles: string[];
  boundaries: Record<string, WorkerTestClass>;
  planFiles: string[];
}): Record<string, WorkerTestClass> {
  throw new Error('NotImplemented');
}
