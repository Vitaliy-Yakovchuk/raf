import type { AssignmentBriefContext, AssignmentSnapshot } from './assignment.ts';
import type { FlowQaLaunchContext } from './flow-qa-report.ts';

export interface FlowBriefInput {
  assignment: AssignmentSnapshot;
  context: AssignmentBriefContext;
  runId: string;
  branch: string;
  workingMain: { project: string; workspace: string; branch: string };
  source: { userQa: string; agentReport: string; agentRun: string; featureTestAuthoring: string; featureImplementation: string; unitTestRuns: string; testRuns: string; flowApproval: string };
}
export interface FlowBriefPreparation {
  context: AssignmentBriefContext;
  qa: FlowQaLaunchContext | null;
  prerequisites: readonly string[];
}
export function prepareFlowBrief(input: FlowBriefInput): FlowBriefPreparation {
  throw new Error('NotImplemented');
}
