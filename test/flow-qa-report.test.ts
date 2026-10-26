import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentReportWatcher, readPendingAgentReport, type AgentReportPorts, type AgentReportRequest } from '../src/agent-report.ts';
import { cleanupFlowTestRuns, recordFlowTestRun, validateFlowQaReport, verifyFlowQaSnapshot, type FlowCheckResult, type FlowQaEvidencePorts, type FlowQaLaunchContext, type FlowTestRunFact } from '../src/flow-qa-report.ts';
import { address, change, digest, evidenceRoot, memoryFactStore, noFindingsReport, qaFixture, reportPath, requirement, result, root, scenario, sha, workspace } from './helpers/flow-checks-fixture.ts';

function rejected(value: FlowCheckResult, field: RegExp) {
  assert.equal(value.ok, false);
  const issue = value.issues.find(issue => field.test(issue.field));
  assert.ok(issue, `expected an addressed issue for ${field}: ${JSON.stringify(value.issues)}`);
  assert.equal(issue.change, change);
  assert.equal(issue.item, '2.3');
  assert.match(issue.requirement, /openspec\/(?:changes|specs)\//);
  assert.ok(issue.expected.trim());
  assert.ok(issue.remediation.trim());
  assert.ok(Object.hasOwn(issue, 'received'));
}

for (const kind of ['no-findings', 'fixed'] as const) test(`new QA accepts ${kind} without repeating the user scenario`, async () => {
  const f = qaFixture();
  if (kind === 'no-findings') f.input.report = noFindingsReport();
  const original = structuredClone(f.input);
  const accepted = await validateFlowQaReport(f.input, f.ports);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.issues, []);
  assert.deepEqual(f.input, original, 'first failed scenario and immutable assignment must survive unchanged');
  assert.ok(accepted.snapshot);
  assert.equal(accepted.manualEvidence, false);
});

const malformed: [string, (report: any) => void, RegExp][] = [
  ['missing qa', r => { delete r.qa; }, /^qa$/],
  ['spoofed report phase', r => { delete r.qa; r.phase = 'implement'; }, /^qa$/],
  ['missing findings', r => { delete r.qa.findings; }, /findings/],
  ['missing scenarios', r => { delete r.qa.scenarios; }, /scenarios/],
  ['missing followUps', r => { delete r.qa.followUps; }, /followUps/],
  ['unknown scenario property', r => { r.qa.scenarios[0].extra = true; }, /scenarios/],
  ['unknown finding property', r => { r.qa.findings[0].extra = true; }, /findings/],
  ['foreign change', r => { r.qa.scenarios[0].change = 'foreign'; }, /scenarios/],
  ['foreign item', r => { r.qa.scenarios[0].item = '99.9'; }, /scenarios/],
  ['empty scenario', r => { r.qa.scenarios[0].scenario = ' '; }, /scenarios/],
  ['replaced base scenario', r => { r.qa.scenarios[0].scenario = 'subscenario only'; r.qa.findings[0].scenario = 'subscenario only'; }, /scenarios/],
  ['duplicate scenario', r => { r.qa.scenarios.push(structuredClone(r.qa.scenarios[0])); }, /scenarios/],
  ['duplicate finding', r => { r.qa.findings.push(structuredClone(r.qa.findings[0])); }, /findings/],
  ['empty scenario evidence', r => { r.qa.scenarios[0].evidence = []; }, /scenarios/],
  ['failed scenario without reason', r => { delete r.qa.scenarios[0].reason; }, /scenarios/],
  ['unknown finding scenario', r => { r.qa.findings[0].scenario = 'not in scenarios'; }, /findings/],
  ['empty requirement', r => { r.qa.findings[0].requirement = ''; }, /findings/],
  ['nonboolean fixed', r => { r.qa.findings[0].fixed = 'true'; }, /findings/],
  ['missing regression', r => { delete r.qa.findings[0].regression; }, /regression/],
  ['legacy untyped commit', r => { r.qa.findings[0].commits = [sha]; }, /commits/],
  ['unmatched failed scenario', r => { r.qa.findings = []; }, /scenarios/],
  ['unfixed succeeded', r => { r.qa.findings[0] = { ...address, requirement, fixed: false, reason: 'No write access', evidence: [`${evidenceRoot}/stand.md`] }; }, /findings/],
];
for (const [name, mutate, field] of malformed) test(`QA rejects ${name} before accepting success`, async () => {
  const f = qaFixture(); mutate(f.input.report);
  rejected(await validateFlowQaReport(f.input, f.ports), field);
});

for (const proposedTasks of [[{ description: 'delegate fix' }], { tasks: ['fix'] }, 'fix elsewhere']) test(`QA rejects nonempty structured proposedTasks ${JSON.stringify(proposedTasks)}`, async () => {
  const f = qaFixture(); f.input.report.proposedTasks = proposedTasks;
  rejected(await validateFlowQaReport(f.input, f.ports), /proposedTasks/);
});
for (const proposedTasks of [undefined, null, []]) test(`QA allows empty proposedTasks ${JSON.stringify(proposedTasks)} and quoted prohibition in answer`, async () => {
  const f = qaFixture(); f.input.report.proposedTasks = proposedTasks;
  assert.equal((await validateFlowQaReport(f.input, f.ports)).ok, true);
});

for (const stage of ['implement', 'test-scaffold', 'main', 'qa']) test(`trusted ${stage} old schema is not retroactively upgraded by report fields`, async () => {
  const f = qaFixture();
  f.input.trusted.stage = stage;
  f.input.trusted.reportSchema = { required: ['status', 'answer', 'changes'] };
  delete f.input.report.qa;
  f.input.report.phase = 'qa'; f.input.report.proposedTasks = ['legacy extension'];
  assert.equal((await validateFlowQaReport(f.input, f.ports)).ok, true);
});

test('truthful failed with an unfixed finding is accepted as failed without fabricating repair', async () => {
  const f = qaFixture();
  f.input.report.status = 'failed';
  f.input.report.changes[0].items[0] = { id: '2.3', status: 'failed', reason: 'Write boundary unavailable' };
  f.input.report.qa.findings[0] = { ...address, requirement, fixed: false, reason: 'Write boundary unavailable', evidence: [`${evidenceRoot}/stand.md`] };
  const before = structuredClone(f.input.report);
  assert.equal((await validateFlowQaReport(f.input, f.ports)).ok, true);
  assert.deepEqual(f.input.report, before);
});

for (const status of ['succeeded', 'failed']) test(`unexecuted prerequisite remains ${status === 'failed' ? 'truthfully failed' : 'ineligible for succeeded'}`, async () => {
  const f = qaFixture(); f.input.report = noFindingsReport();
  f.input.report.status = status;
  f.input.report.changes[0].items[0] = { id: '2.3', status, reason: 'Device unavailable' };
  f.input.report.qa.scenarios[0] = { ...address, status: 'failed', reason: 'Device unavailable', evidence: [`${evidenceRoot}/stand.md`] };
  const checked = await validateFlowQaReport(f.input, f.ports);
  if (status === 'failed') assert.equal(checked.ok, true);
  else rejected(checked, /scenarios/);
});

for (const purpose of ['defect-fix', 'repeat-qa', 'deployment', 'first-execution']) test(`followUp ${purpose} preserves QA ownership and open destination`, async () => {
  const f = qaFixture();
  f.input.report.qa.followUps = [{ ...address, item: '2.4', sourceItem: '2.3', purpose, reason: 'Remaining action', evidence: [`${evidenceRoot}/stand.md`] }];
  const before = structuredClone(f.input.trusted.assignment);
  const checked = await validateFlowQaReport(f.input, f.ports);
  if (purpose === 'defect-fix' || purpose === 'repeat-qa') rejected(checked, /followUps/);
  else assert.equal(checked.ok, true);
  assert.deepEqual(f.input.trusted.assignment, before);
});
for (const [name, mutate] of [
  ['foreign change', (f: ReturnType<typeof qaFixture>) => { f.input.report.qa.followUps[0].change = 'foreign'; }],
  ['foreign source item', (f: ReturnType<typeof qaFixture>) => { f.input.report.qa.followUps[0].sourceItem = '9.9'; }],
  ['closed destination', (f: ReturnType<typeof qaFixture>) => { f.openItems.set(change, []); }],
] as const) test(`followUp rejects ${name}`, async () => {
  const f = qaFixture();
  f.input.report.qa.followUps = [{ ...address, item: '2.4', sourceItem: '2.3', purpose: 'deployment', reason: 'Deploy', evidence: [`${evidenceRoot}/stand.md`] }];
  mutate(f); rejected(await validateFlowQaReport(f.input, f.ports), /followUps/);
});

test('manual stand evidence is explicit limited proof and does not fabricate TestRunResult ownership', async () => {
  const f = qaFixture();
  f.input.report.qa.findings[0].regression = { kind: 'manual', redEvidence: [`${evidenceRoot}/stand.md`], greenEvidence: [`${evidenceRoot}/fix.diff`] };
  f.facts.clear();
  const checked = await validateFlowQaReport(f.input, f.ports);
  assert.equal(checked.ok, true);
  assert.equal(checked.manualEvidence, true);
  assert.ok(checked.warnings.length > 0);
});

for (const mainCase of ['develop', 'fixture', 'main-word-only', 'verified-main'] as const) test(`mainHotfix ${mainCase} cannot turn unfinished work into success`, async () => {
  const f = qaFixture();
  const mainWorkspace = f.input.trusted.workingMain.workspace;
  const finding = { ...address, requirement, fixed: false, reason: 'Working raf defect', evidence: [`${evidenceRoot}/stand.md`], mainHotfix: { workspace: mainCase === 'verified-main' ? mainWorkspace : workspace, branch: 'main', requirement: 'openspec/specs/projects/orchestrator/flow-approval/spec.md', evidence: [`${evidenceRoot}/stand.md`] } };
  f.input.report.qa.findings = [finding];
  if (mainCase === 'develop') finding.mainHotfix.branch = 'develop';
  if (mainCase === 'fixture') { f.input.trusted.workspace = `${root}/raf-stand`; finding.mainHotfix.workspace = `${root}/raf-stand`; }
  if (mainCase === 'main-word-only') { finding.mainHotfix.workspace = mainWorkspace; f.files.set(`${evidenceRoot}/stand.md`, 'main'); }
  if (mainCase === 'verified-main') { f.input.trusted.workspace = mainWorkspace; f.input.trusted.branch = 'main'; }
  rejected(await validateFlowQaReport(f.input, f.ports), /findings/);
});

test('a verified working-main bug can be reported failed with an addressed main followUp', async () => {
  const f = qaFixture(); const main = f.input.trusted.workingMain;
  f.input.trusted.workspace = main.workspace; f.input.trusted.branch = main.branch;
  f.input.report.status = 'failed'; f.input.report.changes[0].items[0] = { id: '2.3', status: 'failed', reason: 'Working main defect' };
  f.input.report.qa.findings = [{ ...address, requirement, fixed: false, reason: 'Working main defect', evidence: [`${evidenceRoot}/stand.md`], mainHotfix: { workspace: main.workspace, branch: main.branch, requirement: 'openspec/specs/projects/orchestrator/flow-approval/spec.md', evidence: [`${evidenceRoot}/stand.md`] } }];
  f.input.report.qa.followUps = [{ ...address, item: '2.4', sourceItem: '2.3', purpose: 'working-main-hotfix', reason: 'Working main defect', evidence: [`${evidenceRoot}/stand.md`] }];
  assert.equal((await validateFlowQaReport(f.input, f.ports)).ok, true);
});

test('pre-write revalidation rejects a changed report', async () => {
  const f = qaFixture();
  const first = await validateFlowQaReport(f.input, f.ports); assert.ok(first.snapshot);
  f.input.report.qa.findings[0].fixed = false;
  assert.equal((await verifyFlowQaSnapshot(first.snapshot, f.input, f.ports)).ok, false);
});

test('broker facts retain red across service reconstruction, add green, and clean up only a closed run', async () => {
  const f = qaFixture(); const backing = new Map<string, FlowTestRunFact>();
  await recordFlowTestRun(f.input.trusted, result('red'), '', 1, memoryFactStore(backing));
  const restarted = memoryFactStore(backing);
  const red = await restarted.get('test-red');
  assert.equal(red?.agentRunId, 'agent-run'); assert.equal(red?.testRunId, 'test-red');
  assert.equal(red?.resultDigest, digest(JSON.stringify(result('red'))));
  await recordFlowTestRun(f.input.trusted, result('qa'), '', 0, restarted);
  assert.equal((await restarted.get('test-qa'))?.agentRunId, red?.agentRunId);
  await cleanupFlowTestRuns('agent-run', false, restarted);
  assert.equal(backing.size, 2);
  backing.set('other', { ...red!, testRunId: 'other', agentRunId: 'other-agent-run' });
  await cleanupFlowTestRuns('agent-run', true, restarted);
  assert.deepEqual([...backing.keys()], ['other']);
});

function acceptanceFixture() {
  const f = qaFixture();
  f.input.report.proposedTasks = [{ description: 'delegate QA fix' }];
  const mutations: string[] = []; const diagnostics: string[] = []; const results: unknown[] = [];
  const path = `${root}/tmp/agent-run/qa-worker.json`;
  const request: AgentReportRequest & { flowQa: FlowQaLaunchContext } = { tmpRoot: `${root}/tmp`, runId: 'agent-run', address: 'qa-worker', assignment: f.input.trusted.assignment, flowQa: f.input.trusted };
  const ports: AgentReportPorts & { flowQaEvidence: FlowQaEvidencePorts } = {
    flowQaEvidence: f.ports,
    fs: { async mkdir() {}, async readText(p) { return p === path ? JSON.stringify(f.input.report) : f.files.get(p) ?? null; }, async removeTree() { mutations.push('cleanup'); } },
    watch() { return () => {}; }, process: { onExit() { return () => {}; } }, now: () => '2026-10-24T12:00:00Z',
    async verifyAssignmentCompletion() { return { ok: true, issues: [] }; },
    async confirmTaskCheckboxes() { mutations.push('checkbox'); return { ok: true, issues: [], commits: [], awaitingArchive: false }; },
    async diagnostic(text) { diagnostics.push(text); }, async result(value) { results.push(value); },
  };
  return { f, request, ports, mutations, diagnostics, results };
}
for (const route of ['worker-reconciliation', 'watcher', 'close'] as const) test(`shared ${route} admission rejects QA handoff before checkbox writes`, async () => {
  const h = acceptanceFixture();
  if (route === 'worker-reconciliation') assert.equal(await readPendingAgentReport(h.request, h.ports), null);
  else {
    if (route === 'close') {
      const invalid = h.f.input.report; h.f.input.report = null;
      const watcher = await createAgentReportWatcher(h.request, h.ports);
      h.f.input.report = invalid;
      await watcher.finish({ code: 0, signal: null });
      await watcher.dispose();
    } else {
      const watcher = await createAgentReportWatcher(h.request, h.ports); await watcher.dispose();
    }
    assert.ok(!h.results.some((r: any) => r.status === 'succeeded'));
  }
  assert.ok(!h.mutations.includes('checkbox'));
  assert.ok(h.diagnostics.some(text => text.includes('proposedTasks') && text.includes(`${change}:2.3`) && text.includes(reportPath) && text.includes('agent-run')));
});

test('every assigned QA base item is checked, even when an earlier item is valid', async () => {
  const f = qaFixture();
  f.input.trusted.assignment = { ...f.input.trusted.assignment, changes: [{ id: change, items: [...f.input.trusted.assignment.changes[0].items, { id: '2.5', description: 'Second required scenario' }] }] };
  f.input.trusted.scenarios = [...f.input.trusted.scenarios, { change, item: '2.5', scenario: 'Second required scenario' }];
  f.input.report.changes[0].items.push({ id: '2.5', status: 'succeeded' });
  const checked = await validateFlowQaReport(f.input, f.ports);
  assert.equal(checked.ok, false);
  assert.ok(checked.issues.some(issue => issue.item === '2.5' && /scenarios/.test(issue.field)));
});

test('unchanged snapshot passes pre-write verification without changing original failed scenario', async () => {
  const f = qaFixture();
  const checked = await validateFlowQaReport(f.input, f.ports); assert.ok(checked.snapshot);
  assert.equal((await verifyFlowQaSnapshot(checked.snapshot, f.input, f.ports)).ok, true);
  assert.equal(f.input.report.qa.scenarios[0].status, 'failed');
});

test('watcher delivers one rejection for unchanged bytes and reason, then rechecks a corrected report', async () => {
  const h = acceptanceFixture();
  let notify: Parameters<AgentReportPorts['watch']>[1] | undefined;
  h.ports.watch = (_directory, listener) => { notify = listener; return () => {}; };
  const watcher = await createAgentReportWatcher(h.request, h.ports);
  assert.ok(notify);
  await notify('modify', 'qa-worker.json'); await notify('rename', 'qa-worker.json');
  assert.equal(h.diagnostics.filter(text => text.includes('proposedTasks')).length, 1);
  assert.deepEqual(h.results, []);
  delete h.f.input.report.proposedTasks;
  await notify('modify', 'qa-worker.json');
  assert.equal(h.results.length, 1);
  assert.equal((h.results[0] as any).status, 'succeeded');
  await watcher.dispose();
});
