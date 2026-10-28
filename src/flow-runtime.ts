import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function flowSources(root: string) {
  const source = (capability: string, change?: string) => {
    const delta = change && join(root, 'openspec/changes', change, 'specs', capability, 'spec.md');
    return delta && existsSync(delta) ? delta : join(root, 'openspec/specs', capability, 'spec.md');
  };
  return { userQa: source('core/process/user-qa'), agentReport: source('projects/raf/agent-report'), agentRun: source('projects/raf/agent-run'), featureTestAuthoring: source('core/process/feature-test-authoring'), featureImplementation: source('core/process/feature-implementation'), unitTestRuns: source('core/process/unit-test-runs'), testRuns: source('projects/raf/test-runs'), flowApproval: source('projects/orchestrator/flow-approval') };
}
