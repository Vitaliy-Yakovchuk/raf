import { createHash } from 'node:crypto';
import type { TestRunResult } from '../../src/test-runs.ts';
import type { FlowQaEvidencePorts, FlowQaLaunchContext, FlowTestRunFact, FlowTestRunStore } from '../../src/flow-qa-report.ts';

export const change = 'enforce-flow-approaches';
export const scenario = 'Report acceptance on isolated stand';
export const root = '/flow-unit';
export const workspace = `${root}/raf-develop`;
export const evidenceRoot = `${root}/openspec/changes/${change}`;
export const reportPath = `${root}/tmp/agent-run/qa-worker.json`;
export const requirement = 'openspec/changes/enforce-flow-approaches/specs/core/process/user-qa/spec.md';
export const sha = 'a'.repeat(40);
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const address = { change, item: '2.3', scenario };
export const assignment = { root, baselineArchives: [], changes: [{ id: change, items: [{ id: '2.3', description: scenario }] }] };
export const unitPolicy = { timeoutMs: 10000, optimizeAfterTimeouts: 2, maxGroupTimeouts: 3 };
export const testId = { file: 'test/regression.test.ts', name: 'own regression' };
export const group = `${change}/flow-checks`;
export function result(phase: 'red' | 'qa'): TestRunResult {
  const red = phase === 'red';
  return {
    testKind: 'unit', timeoutPolicy: { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: unitPolicy.timeoutMs }, callerPhase: 'qa',
    diagnostics: [], diagnosticSummary: { totalEntries: 0, retainedEntries: 0, omittedEntries: 0, truncated: false, redacted: false },
    environmentSummary: { executable: 'node', runtimeVersion: process.version, adapter: 'node-test-events', isolation: 'isolated', configurationFingerprints: { flow: 'fixture', testRuns: 'fixture', projects: 'fixture' }, tmpPathBytes: 30, privateRunTmp: true },
    runId: `test-${phase}`, project: 'raf', workspace, phase, group, profileId: 'node',
    selection: { files: [testId.file], testIds: [testId] }, command: { executable: 'node', argv: ['runner.ts'], cwd: workspace, shell: false, environment: { HOME: '/flow-unit/qa-home', statePath: '/flow-unit/qa-home/state.sqlite', tmpPath: '/flow-unit/qa-home/tmp' } },
    startedAt: red ? '2026-10-24T10:00:00.000Z' : '2026-10-24T10:00:02.000Z', durationMs: 100,
    exitCode: red ? 1 : 0, signal: null, timedOut: false, cleanup: { complete: true, remainingPids: [] },
    stateAccess: null, groupSnapshot: 'loaded', groupState: red ? 'incomplete' : 'complete', timeoutCount: 0,
    nextAction: red ? 'implement' : 'complete', hintIds: [], hints: [], evidence: [],
    outcome: red ? 'assertions-failed' : 'passed', failureKinds: red ? ['assertions'] : [],
    passed: red ? [] : [testId], knownRed: red ? [testId] : [], unexecuted: [], unknown: [], removed: [],
  };
}
export function launch(): FlowQaLaunchContext {
  return {
    stage: 'qa', runId: 'agent-run', agentId: 'qa-worker', project: 'raf', workspace, branch: 'develop', assignment: structuredClone(assignment),
    reportSchema: { type: 'object', required: ['status', 'answer', 'changes', 'commits', 'qa'], properties: {} },
    scenarios: [{ ...address }], allowedEvidenceRoots: [workspace, evidenceRoot],
    workingMain: { project: 'raf', workspace: `${root}/raf-main`, branch: 'main' },
  };
}
export function noFindingsReport() {
  return {
    status: 'succeeded', answer: 'proposedTasks заборонено; один прохід QA', commits: [{ repository: workspace, sha }],
    changes: [{ id: change, items: [{ id: '2.3', status: 'succeeded' }] }],
    qa: { scenarios: [{ ...address, status: 'succeeded', evidence: [`${evidenceRoot}/stand.md`] }], findings: [], followUps: [] },
  };
}
export function fixedReport(): any {
  const report: any = noFindingsReport();
  report.qa.scenarios[0] = { ...address, status: 'failed', reason: 'Found defect on first execution', evidence: [`${evidenceRoot}/stand.md`] };
  report.qa.findings = [{ ...address, requirement, fixed: true, evidence: [`${evidenceRoot}/fix.diff`], commits: report.commits,
    regression: { kind: 'unit', group, red: { resultPath: `${evidenceRoot}/red.json`, stderrPath: `${evidenceRoot}/red.stderr`, cliCode: 1 }, green: { resultPath: `${evidenceRoot}/green.json`, stderrPath: `${evidenceRoot}/green.stderr`, cliCode: 0 } } }];
  return report;
}
export function qaFixture() {
  const trusted = launch();
  const report = fixedReport();
  const files = new Map<string, string>([[`${evidenceRoot}/stand.md`, 'first executed scenario: failed'], [`${evidenceRoot}/fix.diff`, 'own code/test/fixture fix']]);
  const facts = new Map<string, FlowTestRunFact>();
  const openItems = new Map([[change, ['2.4', '2.5']]]);
  function saveResult(phase: 'red' | 'qa', value: TestRunResult) {
    const prefix = phase === 'red' ? 'red' : 'green';
    const text = JSON.stringify(value);
    files.set(`${evidenceRoot}/${prefix}.json`, text);
    files.set(`${evidenceRoot}/${prefix}.stderr`, '');
    facts.set(value.runId, { testRunId: value.runId, agentRunId: trusted.runId, agentId: trusted.agentId, project: 'raf', workspace, group: value.group, phase: value.phase, selection: structuredClone(value.selection), resultDigest: digest(text), stderrDigest: digest(''), cliCode: phase === 'red' ? 1 : 0 });
  }
  saveResult('red', result('red'));
  saveResult('qa', result('qa'));
  const ports: FlowQaEvidencePorts = {
    async readOpenItems(id) { return openItems.get(id) ?? []; },
  };
  const input = { report, reportPath, trusted };
  return { input, ports, files, facts, openItems, saveResult };
}
export function memoryFactStore(facts = new Map<string, FlowTestRunFact>()): FlowTestRunStore {
  return {
    async put(fact) { facts.set(fact.testRunId, structuredClone(fact)); },
    async get(id) { return structuredClone(facts.get(id) ?? null); },
    async removeForAgentRun(id) { for (const [key, fact] of facts) if (fact.agentRunId === id) facts.delete(key); },
  };
}
