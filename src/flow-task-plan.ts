import type { AssignmentSnapshot } from './assignment.ts';
import type { FlowCheckResult, FlowScenarioAddress } from './flow-qa-report.ts';

export interface FlowPlanDocument { change: string; path: string; text: string; }
export interface FlowPlanEvidence {
  path: string;
  digest: string;
  acceptedDigest: string | null;
  agentRunId: string;
  scenarios: readonly (FlowScenarioAddress & { status: 'succeeded' | 'failed'; executed: boolean })[];
  findings: readonly (FlowScenarioAddress & { fixed: boolean })[];
  workingMainHotfix?: { verified: boolean; project: string; workspace: string; branch: string };
}
export interface FlowTaskPlanInput {
  assignment: AssignmentSnapshot;
  phase: 'launch' | 'report';
  initial: readonly FlowPlanDocument[];
  current: readonly FlowPlanDocument[];
  evidence: readonly FlowPlanEvidence[];
  workingMain: { project: string; workspace: string; branch: string };
}
export async function validateFlowTaskPlan(input: FlowTaskPlanInput): Promise<FlowCheckResult> {
  throw new Error('NotImplemented');
}
