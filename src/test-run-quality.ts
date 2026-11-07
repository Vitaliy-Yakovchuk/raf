import type { TestId, TestRunCleanup, TestRunGroup, TestRunGroupKey, TestRunPlan, TestRunResult, UnitTestPolicy } from './test-runs.ts';

export interface QualityFunction {
  id: string;
  path: string;
  startByte: number;
  endByte: number;
}

export interface QualityMutation {
  siteId: string;
  functionId: string;
  path: string;
  startByte: number;
  endByte: number;
  beforeBase64: string;
  afterBase64: string;
}

export interface QualityRequest {
  version: 1;
  mode: 'baseline' | 'mutant';
  source: { baseRevision: string; revision: string; files: { path: string; sha256: string }[] };
  changedFunctions: QualityFunction[];
  baselineRunId?: string;
  mutant?: QualityMutation;
}

export interface QualityInput {
  path: string;
  bytes: Uint8Array;
  realpath: string;
  role: 'source' | 'test' | 'config' | 'dependency' | 'control';
}

export interface QualitySnapshot {
  digest: string;
  inputs: QualityInput[];
}

export interface QualityContext {
  runId: string;
  owner: string;
  canonicalWorkspace: string;
  profileId: string;
  profileCwd: string;
  selection: TestRunPlan['selection'];
  selectionDigest: string;
  configDigest: string;
  dependencyDigest: string;
  sourceAdapter: { id: string; version: string };
  siteSelector: { id: string; version: string };
}

export interface QualityExecution {
  runId: string;
  owner: string;
  canonicalWorkspace: string;
  executionRoot: string;
  cwd: string;
  sourceSnapshotDigest: string;
  executionSnapshotDigest: string;
  selection: TestRunPlan['selection'];
  inputs: QualityInput[];
  selectedSites: QualityMutation[];
}

export interface QualityBaseline {
  runId: string;
  owner: string;
  sourceSnapshotDigest: string;
  selectionDigest: string;
  configDigest: string;
  dependencyDigest: string;
  producer: { id: string; version: string };
  result: Pick<TestRunResult, 'outcome' | 'exitCode' | 'timedOut' | 'cleanup' | 'unknown' | 'unexecuted'>;
}

export interface QualityTransportPorts {
  snapshot(): Promise<QualitySnapshot>;
  readCurrent(path: string): Promise<Uint8Array>;
  loadBaseline(runId: string): Promise<QualityBaseline | null>;
  selectSites(snapshot: QualitySnapshot, functions: QualityFunction[]): Promise<{ supported: boolean; reason?: string; sites: QualityMutation[] }>;
  createPrivateCopy(snapshot: QualitySnapshot, runId: string, owner: string): Promise<{ root: string; inputs: QualityInput[] }>;
  removePrivateCopy(root: string, owner: string): Promise<void>;
}

export interface QualityLoadedSource {
  path: string;
  resolvedPath: string;
  inputSha256: string;
  transformedSha256: string | null;
  mapping: string | null;
  loaded: boolean;
  stage: 'load' | 'transform';
  runId: string;
}

export interface QualityCoverage {
  runId: string;
  sourceSnapshotDigest: string;
  selectionDigest: string;
  configDigest: string;
  dependencyDigest: string;
  producer: { id: string; version: string; complete: boolean; exitCode: number | null };
  artifact: { path: string; sha256: string; actualSha256: string; format: string; createdByRunId: string } | null;
  functions: { id: string; unit: 'function' | 'line' | 'branch'; hits: number; denominator: number; sourceSha256: string; mapped: boolean }[];
  omissions: string[];
}

export interface QualityCoverageDecision {
  accepted: boolean;
  reason: string | null;
  functions: { id: string; status: 'covered' | 'uncovered' | 'missing' | 'unsupported'; hits: number | null; denominator: number | null }[];
}

export type QualityFailure = 'refusal' | 'setup' | 'compile' | 'assertions' | 'timeout' | 'interruption';
export type MutationDisposition = 'not-applicable' | 'survived' | 'assertion-killed' | 'compile-failed' | 'setup-failed' | 'timed-out' | 'refused' | 'unverified';
export interface QualityRunFacts {
  mode: 'baseline' | 'mutant';
  runId: string;
  target: { path: string; sha256: string };
  baselineGreen: boolean;
  siteCount: number;
  loadedSources: QualityLoadedSource[];
  events: { origin: 'test-body' | 'transform' | 'import' | 'hook' | 'unknown' | 'broker'; test?: TestId; path?: string; inputSha256?: string; message: string }[];
  protocolComplete: boolean;
  cleanup: TestRunCleanup;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  rawUpstreamOutcome?: string;
}

export interface QualityClassification {
  outcome: TestRunResult['outcome'] | 'compile-failed';
  failureKinds: QualityFailure[];
  knownRed: TestId[];
  mutationDisposition: MutationDisposition;
  reason: string | null;
  nextAction: TestRunResult['nextAction'];
  rawUpstreamOutcome?: string;
}

export interface QualityEvidence {
  mode: QualityRequest['mode'];
  baselineRunId: string | null;
  sourceSnapshotDigest: string | null;
  executionSnapshotDigest: string | null;
  mutant: { siteId: string; functionId: string; path: string; beforeSha256: string; afterSha256: string } | null;
  loadedSources: QualityLoadedSource[];
  coverage: QualityCoverage | { unavailableReason: string };
  mutationDisposition: MutationDisposition;
  reason: string | null;
}

export type QualityTestRunResult = Omit<TestRunResult, 'outcome' | 'failureKinds'> & {
  outcome: QualityClassification['outcome'];
  failureKinds: QualityFailure[];
  quality: QualityEvidence;
};

export interface QualityObservation {
  runId: string;
  agentId: string;
  phase: string;
  mode: 'baseline' | 'mutant';
  sourceSnapshotDigest: string;
  executionSnapshotDigest: string;
  classification: QualityClassification;
}

export interface QualityGroup {
  aggregate: TestRunGroup;
  observations: QualityObservation[];
}

export interface QualityRecoveryCopy {
  root: string;
  owner: string;
  runId: string;
  tree: 'terminated' | 'active' | 'unknown';
}

export function parseQualityRequest(value: unknown): QualityRequest {
  throw new Error('NotImplemented');
}

export async function prepareQualityExecution(request: QualityRequest, context: QualityContext, ports: QualityTransportPorts): Promise<QualityExecution> {
  throw new Error('NotImplemented');
}

export function verifyQualityCoverage(coverage: QualityCoverage, baseline: QualityBaseline, functions: QualityFunction[], sourceHashes: Record<string, string>): QualityCoverageDecision {
  throw new Error('NotImplemented');
}

export function classifyQualityRun(facts: QualityRunFacts): QualityClassification {
  throw new Error('NotImplemented');
}

export function recordQualityObservation(group: QualityGroup, key: TestRunGroupKey, observation: QualityObservation, policy: UnitTestPolicy): QualityGroup {
  throw new Error('NotImplemented');
}

export async function recoverQualityCopies(copies: QualityRecoveryCopy[], owner: string, ports: Pick<QualityTransportPorts, 'removePrivateCopy'>): Promise<string[]> {
  throw new Error('NotImplemented');
}
