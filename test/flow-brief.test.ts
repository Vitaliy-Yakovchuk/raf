import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeAssignmentBrief, type AssignmentBriefContext } from '../src/assignment.ts';
import { prepareFlowBrief, type FlowBriefInput } from '../src/flow-brief.ts';

const change = 'enforce-flow-approaches';
const scenario = 'Report acceptance on isolated stand';
const root = '/flow-unit';
const workspace = `${root}/raf-develop`;
const evidenceRoot = `${root}/openspec/changes/${change}`;
const assignment = { root, baselineArchives: [], changes: [{ id: change, items: [{ id: '2.3', description: scenario }] }] };

const realConf = new URL('../../conf/', import.meta.url);
const source = {
  userQa: `${root}/openspec/changes/enforce-flow-approaches/specs/core/process/user-qa/spec.md`,
  agentReport: `${root}/openspec/changes/enforce-flow-approaches/specs/projects/raf/agent-report/spec.md`,
  agentRun: `${root}/openspec/changes/enforce-flow-approaches/specs/projects/raf/agent-run/spec.md`,
  featureTestAuthoring: `${root}/openspec/changes/add-raf-test-run/specs/core/process/feature-test-authoring/spec.md`,
  featureImplementation: `${root}/openspec/specs/core/process/feature-implementation/spec.md`,
  unitTestRuns: `${root}/openspec/changes/add-raf-test-run/specs/core/process/unit-test-runs/spec.md`,
  testRuns: `${root}/openspec/changes/add-raf-test-run/specs/projects/raf/test-runs/spec.md`,
  flowApproval: `${root}/openspec/specs/projects/orchestrator/flow-approval/spec.md`,
};
function fixture(stage = 'qa', runner = 'codex'): FlowBriefInput {
  const context: AssignmentBriefContext = {
    cwd: workspace, briefsRoot: `${root}/conf/briefs`, runner, stage, phase: stage, project: 'raf', agentId: 'qa-worker', sessionName: 'qa-worker',
    features: [change], outcome: `${change}:2.3 — ${scenario}`, writeBoundaries: [workspace, evidenceRoot],
    sources: [`${source.agentRun} — релевантна вимога, усі сценарії`],
    reportPath: `${root}/tmp/agent-run/qa-worker.json`, reportSchema: { type: 'object', additionalProperties: true, required: ['status', 'answer', 'changes', 'commits'], properties: { status: { enum: ['succeeded', 'failed'] }, answer: { type: 'string' }, commits: { type: 'array' }, changes: { type: 'array' } } },
    rafCommand: 'node /installed/raf/bin/raf.ts', rafSubcommands: ['agent ps', 'agent message', 'test run'],
    commitOwnWork: true, commitRepositories: [workspace, root],
  };
  return { context, source };
}
const fs = {
  async readText(path: string) {
    assert.ok(path.startsWith(`${root}/conf/`), `unexpected brief read ${path}`);
    return readFileSync(new URL(path.slice(`${root}/conf/`.length), realConf), 'utf8');
  },
};
function payload(brief: string): any {
  const marker = '\n{\n  "project"';
  const offset = brief.lastIndexOf(marker);
  assert.ok(offset >= 0, 'assembled brief includes the structured assignment once');
  return JSON.parse(brief.slice(offset + 1));
}

for (const runner of ['codex', 'claude', 'grok', 'agy']) test(`assembled QA brief for ${runner} contains exact sources and own-fix authority`, async () => {
  const input = fixture('qa', runner); const before = structuredClone(input);
  const prepared = prepareFlowBrief(input);
  assert.deepEqual(input, before);
  const brief = await composeAssignmentBrief(structuredClone(assignment), prepared.context, fs);
  const actual = payload(brief);
  assert.deepEqual(actual.assignments, assignment.changes);
  assert.equal(actual.report_path, input.context.reportPath);
  for (const path of [source.userQa, source.agentReport, source.flowApproval, source.unitTestRuns, source.testRuns]) assert.ok(brief.includes(path), path);
  for (const pattern of [/червон|red/i, /зелений|зелен|green/i, /цьому ж запуску|тому самому запуску/i, /тестів чи фікстур|тести.*fixture|тест.*фікстур/i, /без повторного проходу|не повторю|без повтору/i, /TestRunResult/, /stderr/, /код CLI/, /main/, /сценарі/i, /передумов/i]) assert.match(brief, pattern);
  assert.ok(!/заборонено (?:змінювати|редагувати) тести/i.test(brief));
  assert.ok(!brief.includes('qa-audit.md'));
  assert.ok(!brief.includes('RAW_AUDIT_INVENTORY'));
});

for (const stage of ['main', 'test-scaffold', 'implement']) test(`shared ${stage} brief preserves stage-specific flow without upgrading it to QA`, async () => {
  const input = fixture(stage); const prepared = prepareFlowBrief(input);
  const brief = await composeAssignmentBrief(structuredClone(assignment), prepared.context, fs);
  if (stage === 'main') {
    assert.match(brief, /QA|qa/); assert.match(brief, /сам|той самий/); assert.match(brief, /дублю|повторн/);
  }
  if (stage === 'test-scaffold') {
    assert.match(brief, /читати.*код|код.*проєкту/); assert.match(brief, /сам.*прожени|сам.*red|власного red/);
    assert.ok(brief.includes(source.featureTestAuthoring)); assert.ok(brief.includes('--phase red'));
    assert.doesNotMatch(brief, /не читай.*production|сліпий режим|заборонено читати код/i);
  }
  if (stage === 'implement') {
    assert.match(brief, /[Нн]е читай підготовлені тести до завершення реалізації|незалежн/);
    assert.ok(brief.includes(source.featureImplementation)); assert.ok(brief.includes('--phase implement'));
  }
  assert.deepEqual(payload(brief).raf_subcommands, input.context.rafSubcommands);
  assert.deepEqual(payload(brief).write_boundaries, input.context.writeBoundaries);
});
