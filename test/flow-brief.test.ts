import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composeAssignmentBrief, type AssignmentBriefContext } from '../src/assignment.ts';
import { prepareFlowBrief, type FlowBriefInput } from '../src/flow-brief.ts';
import { deriveTaskContext } from '../src/task-context.ts';
import { assignment, change, evidenceRoot, root, scenario, workspace } from './helpers/flow-checks-fixture.ts';

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
  return { assignment: structuredClone(assignment), context, source, runId: 'agent-run', branch: 'develop', workingMain: { project: 'raf', workspace: `${root}/raf-main`, branch: 'main' } };
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

for (const runner of ['codex', 'claude', 'grok', 'agy']) test(`assembled QA brief for ${runner} contains current schema, exact sources and own-fix authority`, async () => {
  const input = fixture('qa', runner); const before = structuredClone(input);
  const prepared = prepareFlowBrief(input);
  assert.deepEqual(input, before);
  assert.ok(prepared.qa); assert.equal(prepared.qa.stage, 'qa');
  assert.equal(prepared.qa.runId, 'agent-run');
  assert.deepEqual(prepared.qa.scenarios, [{ change, item: '2.3', scenario }]);
  assert.deepEqual(prepared.qa.assignment, input.assignment);
  const schema: any = prepared.context.reportSchema;
  assert.ok(schema.required.includes('qa'));
  assert.equal(schema.additionalProperties, true);
  const qa = schema.properties.qa;
  assert.equal(qa.additionalProperties, false);
  assert.deepEqual([...qa.required].sort(), ['findings', 'followUps', 'scenarios']);
  for (const field of ['scenarios', 'findings', 'followUps']) {
    assert.equal(qa.properties[field].type, 'array');
    assert.equal(qa.properties[field].items.additionalProperties, false);
  }
  const brief = await composeAssignmentBrief(input.assignment, prepared.context, fs);
  const actual = payload(brief);
  assert.deepEqual(actual.report_schema, schema);
  assert.deepEqual(actual.assignments, input.assignment.changes);
  assert.equal(actual.report_path, input.context.reportPath);
  for (const path of [source.userQa, source.agentReport, source.flowApproval, source.unitTestRuns, source.testRuns]) assert.ok(brief.includes(path), path);
  for (const pattern of [/червон|red/i, /зелений|зелен|green/i, /цьому ж запуску|тому самому запуску/i, /тестів чи фікстур|тести.*fixture|тест.*фікстур/i, /без повторного проходу|не повторю|без повтору/i, /TestRunResult/, /stderr/, /код CLI/, /main/, /сценарі/i, /передумов/i]) assert.match(brief, pattern);
  assert.ok(!/заборонено (?:змінювати|редагувати) тести/i.test(brief));
  assert.ok(!brief.includes('qa-audit.md'));
  assert.ok(!brief.includes('RAW_AUDIT_INVENTORY'));
});

for (const stage of ['main', 'test-scaffold', 'implement']) test(`shared ${stage} brief preserves stage-specific flow without upgrading it to QA`, async () => {
  const input = fixture(stage); const prepared = prepareFlowBrief(input);
  assert.equal(prepared.qa, null);
  assert.ok(!(prepared.context.reportSchema.required as string[]).includes('qa'));
  const brief = await composeAssignmentBrief(input.assignment, prepared.context, fs);
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

for (const missing of ['test-run-channel', 'write-boundaries'] as const) test(`missing ${missing} is an explicit prerequisite without widening sandbox permissions`, () => {
  const input = fixture();
  if (missing === 'test-run-channel') input.context = { ...input.context, rafSubcommands: ['agent ps', 'agent message'] };
  else input.context = { ...input.context, writeBoundaries: [`${root}/unrelated`] };
  const before = structuredClone(input.context);
  const prepared = prepareFlowBrief(input);
  assert.ok(prepared.prerequisites.length > 0);
  assert.deepEqual(prepared.context.rafSubcommands, before.rafSubcommands);
  assert.deepEqual(prepared.context.writeBoundaries, before.writeBoundaries);
});

test('required base scenarios cover every assigned QA item and preserve literal descriptions', () => {
  const input = fixture(); input.assignment.changes[0].items.push({ id: '2.5', description: 'Другий точний сценарій' });
  const prepared = prepareFlowBrief(input);
  assert.deepEqual(prepared.qa?.scenarios, [{ change, item: '2.3', scenario }, { change, item: '2.5', scenario: 'Другий точний сценарій' }]);
});

for (const stage of ['qa', 'implement'] as const) test(`existing trusted task-context generator ${stage} issues the stage-appropriate report schema`, async () => {
  const configuration = {
    projects: JSON.parse(readFileSync(new URL('projects.json', realConf), 'utf8')),
    reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }], resources: {},
  };
  const actual = await deriveTaskContext({ root, assignment, configuration, parameters: { id: 'qa-worker', type: stage, project: 'raf', phase: stage, features: [change], complexity: 'low', tasks: [`${change}:2.3`] } });
  assert.equal(actual.reportSchema.required.includes('qa'), stage === 'qa');
  if (stage === 'qa') assert.ok((actual.reportSchema.properties as any).qa);
  assert.deepEqual(actual.reportSchema.properties.status.enum, ['succeeded', 'failed']);
});
