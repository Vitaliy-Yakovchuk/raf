import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function flowSources(root: string) {
  const source = (capability: string, change?: string) => {
    const delta = change && join(root, 'openspec/changes', change, 'specs', capability, 'spec.md');
    return delta && existsSync(delta) ? delta : join(root, 'openspec/specs', capability, 'spec.md');
  };
  return { userQa: source('core/process/user-qa', 'enforce-flow-approaches'), agentReport: source('projects/raf/agent-report', 'enforce-flow-approaches'), agentRun: source('projects/raf/agent-run', 'enforce-flow-approaches'), featureTestAuthoring: source('core/process/feature-test-authoring', 'add-raf-test-run'), featureImplementation: source('core/process/feature-implementation'), unitTestRuns: source('core/process/unit-test-runs', 'add-raf-test-run'), testRuns: source('projects/raf/test-runs', 'add-raf-test-run'), flowApproval: source('projects/orchestrator/flow-approval') };
}
