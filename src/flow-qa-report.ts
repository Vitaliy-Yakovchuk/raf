import type { AssignmentSnapshot } from './assignment.ts';
import type { TestId, TestRunResult, UnitTestPolicy } from './test-runs.ts';

export interface FlowScenarioAddress { change: string; item: string; scenario: string; }
export interface FlowIssue {
  change: string;
  item: string;
  field: string;
  requirement: string;
  received: unknown;
  expected: string;
  remediation: string;
  path?: string;
  line?: number;
}
export interface FlowQaLaunchContext {
  stage: string;
  runId: string;
  agentId: string;
  project: string;
  workspace: string;
  branch: string;
  assignment: AssignmentSnapshot;
  reportSchema: Readonly<Record<string, unknown>>;
  scenarios: readonly FlowScenarioAddress[];
  allowedEvidenceRoots: readonly string[];
  workingMain: { project: string; workspace: string; branch: string };
}
export interface FlowTestRunFact {
  testRunId: string;
  agentRunId: string;
  agentId: string;
  project: string;
  workspace: string;
  group: string;
  phase: string;
  selection: TestRunResult['selection'];
  resultDigest: string;
  stderrDigest: string;
  cliCode: number;
}
export interface FlowTestRunStore {
  put(fact: FlowTestRunFact): Promise<void>;
  get(testRunId: string): Promise<FlowTestRunFact | null>;
  removeForAgentRun(agentRunId: string): Promise<void>;
}
export interface FlowQaEvidencePorts {
  readText(path: string): Promise<string | null>;
  realpath(path: string): Promise<string>;
  lookupTestRun(testRunId: string): Promise<FlowTestRunFact | null>;
  unitPolicy: UnitTestPolicy;
  integrationProfiles?: readonly { profileId: string; group: string; files: readonly string[]; timeoutMs: number }[];
  readOpenItems(change: string): Promise<readonly string[]>;
}
export interface FlowVerifiedSnapshot {
  reportDigest: string;
  files: readonly { path: string; realpath: string; digest: string }[];
  testRuns: readonly FlowTestRunFact[];
}
export interface FlowCheckResult {
  ok: boolean;
  issues: readonly FlowIssue[];
  warnings: readonly FlowIssue[];
  manualEvidence: boolean;
  unverifiedRemainder: readonly TestId[];
  snapshot?: FlowVerifiedSnapshot;
}
export interface FlowQaReportInput {
  report: unknown;
  reportPath: string;
  trusted: FlowQaLaunchContext;
}
export async function validateFlowQaReport(input: FlowQaReportInput, ports: FlowQaEvidencePorts): Promise<FlowCheckResult> {
  throw new Error('NotImplemented');
}
export async function verifyFlowQaSnapshot(snapshot: FlowVerifiedSnapshot, input: FlowQaReportInput, ports: FlowQaEvidencePorts): Promise<FlowCheckResult> {
  throw new Error('NotImplemented');
}
export async function recordFlowTestRun(caller: Pick<FlowQaLaunchContext, 'runId' | 'agentId' | 'project' | 'workspace'>, result: TestRunResult, stderr: string, cliCode: number, store: FlowTestRunStore): Promise<void> {
  throw new Error('NotImplemented');
}
export async function cleanupFlowTestRuns(agentRunId: string, closed: boolean, store: FlowTestRunStore): Promise<void> {
  throw new Error('NotImplemented');
}
