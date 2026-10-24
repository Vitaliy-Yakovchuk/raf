import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFlowTaskPlan, type FlowTaskPlanInput } from '../src/flow-task-plan.ts';
import { address, assignment, change, digest, evidenceRoot, requirement, root, scenario } from './helpers/flow-checks-fixture.ts';

const taskPath = `${evidenceRoot}/tasks.md`;
const evidencePath = `${evidenceRoot}/qa-evidence.json`;
const oldPlan = `- [x] 2.3 [qa] ${scenario}\n  Результат: [QA evidence](${evidencePath})\n`;
function fixture(): FlowTaskPlanInput {
  return {
    assignment: structuredClone(assignment), phase: 'launch',
    initial: [{ change, path: taskPath, text: oldPlan }], current: [{ change, path: taskPath, text: oldPlan }],
    evidence: [{ path: evidencePath, digest: digest('accepted bytes'), acceptedDigest: digest('accepted bytes'), agentRunId: 'previous-qa-run', scenarios: [{ ...address, status: 'failed', executed: true }], findings: [{ ...address, fixed: true }] }],
    workingMain: { project: 'raf', workspace: `${root}/raf-main`, branch: 'main' },
  };
}
function append(input: FlowTaskPlanInput, text: string) { input.current = [{ change, path: taskPath, text: oldPlan + text + '\n' }]; }

for (const phase of ['launch', 'report'] as const) {
  for (const label of ['[qa] Повторити QA', '[implement] Не QA: виправлення іншим агентом', '[test-scaffold] Написати регресію для передачі fix']) {
    test(`${phase} rejects explicit same-scenario handoff despite stage or label ${label}`, async () => {
      const input = fixture(); input.phase = phase;
      append(input, `- [ ] 2.4 ${label}; source ${change}:2.3; scenario "${scenario}"; evidence ${evidencePath}`);
      const original = structuredClone(input);
      const checked = await validateFlowTaskPlan(input);
      assert.equal(checked.ok, false);
      const issue = checked.issues.find(issue => issue.path === taskPath && issue.line === 3);
      assert.ok(issue);
      assert.equal(issue.change, change); assert.equal(issue.item, '2.4');
      assert.ok(issue.requirement.includes('user-qa'));
      assert.ok(JSON.stringify(issue.received).includes(evidencePath));
      assert.ok(issue.expected.trim()); assert.ok(issue.remediation.trim());
      assert.deepEqual(input, original, 'checking cannot edit plan or rebind immutable assignment');
    });
  }
}

test('renamed action targeting an accepted finding in another selected change still rejects fix transfer', async () => {
  const input = fixture();
  input.assignment.changes.push({ id: 'followup-change', items: [{ id: '1.1', description: 'Repair' }] });
  input.current = [...input.current, { change: 'followup-change', path: `${root}/openspec/changes/followup-change/tasks.md`, text: `- [ ] 1.1 [implement] Виправити іншим агентом; source ${change}:2.3; scenario "${scenario}"; evidence ${evidencePath}\n` }];
  const checked = await validateFlowTaskPlan(input);
  assert.equal(checked.ok, false);
  assert.ok(checked.issues.some(issue => issue.change === 'followup-change' && issue.item === '1.1'));
});

for (const label of ['[qa] Повторити QA', '[implement] Не QA: усунути баг', '[qa] QA після викладки']) test(`ambiguous ${label} warns with source and main action instead of blocking`, async () => {
  const input = fixture(); append(input, `- [ ] 2.4 ${label}`);
  const checked = await validateFlowTaskPlan(input);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.issues, []);
  assert.ok(checked.warnings.some(w => w.path === taskPath && w.line === 3 && w.requirement.includes('user-qa') && w.remediation.trim()));
});

test('suspicious new scaffold/implement/qa after failed QA warns without pretending provenance is proven', async () => {
  const input = fixture();
  append(input, '- [ ] 2.4 [test-scaffold] Нові тести\n- [ ] 2.5 [implement] Виправити\n- [ ] 2.6 [qa] Перевірити');
  const checked = await validateFlowTaskPlan(input);
  assert.equal(checked.ok, true); assert.ok(checked.warnings.length > 0);
});

for (const provenance of ['missing', 'unaccepted', 'changed-digest']) test(`unavailable ${provenance} provenance after tmp cleanup is warning, not proof of repeat`, async () => {
  const input = fixture();
  append(input, `- [ ] 2.4 [qa] Повторити QA; source ${change}:2.3; scenario "${scenario}"; evidence ${evidencePath}`);
  if (provenance === 'missing') input.evidence = [];
  if (provenance === 'unaccepted') input.evidence[0].acceptedDigest = null;
  if (provenance === 'changed-digest') input.evidence[0].digest = digest('changed bytes');
  const checked = await validateFlowTaskPlan(input);
  assert.equal(checked.ok, true); assert.deepEqual(checked.issues, []); assert.ok(checked.warnings.length > 0);
});

test('initial feature scaffold/implement/qa chain is allowed without a synthetic warning', async () => {
  const input = fixture(); input.evidence = []; input.initial = [];
  input.current = [{ change, path: taskPath, text: '- [ ] 2.1 [test-scaffold] Тести нової фічі\n- [ ] 2.2 [implement] Після 2.1 реалізація\n- [ ] 2.3 [qa] Після 2.2 перший прохід\n' }];
  const checked = await validateFlowTaskPlan(input);
  assert.equal(checked.ok, true); assert.deepEqual(checked.warnings, []);
});

test('nested task number alone does not infer QA origin', async () => {
  const input = fixture(); input.evidence = []; input.initial = [];
  input.current = [{ change, path: taskPath, text: '- [ ] 6.2.1 [test-scaffold] Нова функція\n- [ ] 6.2.2 [implement] Реалізація\n- [ ] 6.2.3 [qa] Перший прохід\n' }];
  const checked = await validateFlowTaskPlan(input);
  assert.equal(checked.ok, true); assert.deepEqual(checked.warnings, []);
});

for (const kind of ['deployment', 'first-execution', 'working-main-hotfix'] as const) test(`addressed ${kind} remains a permitted open action`, async () => {
  const input = fixture();
  const action = kind === 'deployment' ? 'Викласти виправлення, перевірити фактичний результат викладки' : kind === 'first-execution' ? `Перший прохід "${scenario}": раніше стенд недоступний` : 'Hotfix бага робочої raf main';
  if (kind === 'first-execution') { input.evidence[0].scenarios = [{ ...address, status: 'failed', executed: false }]; input.evidence[0].findings = []; }
  if (kind === 'working-main-hotfix') input.evidence[0].workingMainHotfix = { verified: true, ...input.workingMain };
  append(input, `- [ ] 2.4 [${kind === 'first-execution' ? 'qa' : 'implement'}] ${action}; source ${change}:2.3; evidence ${evidencePath}`);
  const before = structuredClone(input);
  const checked = await validateFlowTaskPlan(input);
  assert.equal(checked.ok, true); assert.deepEqual(checked.issues, []);
  assert.deepEqual(input, before, 'open action must not be marked complete by plan validation');
});

test('develop hotfix label cannot exempt explicit QA fix transfer', async () => {
  const input = fixture();
  input.evidence[0].workingMainHotfix = { verified: true, project: 'raf', workspace: `${root}/raf-develop`, branch: 'develop' };
  append(input, `- [ ] 2.4 [implement] Hotfix: виправити іншим агентом; source ${change}:2.3; scenario "${scenario}"; evidence ${evidencePath}`);
  assert.equal((await validateFlowTaskPlan(input)).ok, false);
});

test('historical closed repeat is preserved, not retroactively rejected', async () => {
  const input = fixture();
  const historical = `${oldPlan}- [x] 1.8 [qa] Повторити QA; source ${change}:2.3; scenario "${scenario}"; evidence ${evidencePath}\n`;
  input.initial[0].text = historical; input.current[0].text = historical;
  const original = structuredClone(input);
  assert.equal((await validateFlowTaskPlan(input)).ok, true);
  assert.deepEqual(input, original);
});

test('rewritten existing open line is checked against launch snapshot, not only new item numbers', async () => {
  const input = fixture();
  input.initial[0].text += '- [ ] 2.4 [implement] Викладка\n';
  append(input, `- [ ] 2.4 [implement] Не QA: виправити іншим агентом; source ${change}:2.3; scenario "${scenario}"; evidence ${evidencePath}`);
  input.phase = 'report';
  assert.equal((await validateFlowTaskPlan(input)).ok, false);
});

test('unrelated unselected change does not widen the checked assignment', async () => {
  const input = fixture();
  input.current = [...input.current, { change: 'unselected', path: `${root}/openspec/changes/unselected/tasks.md`, text: '- [ ] 8.1 [qa] Повторити QA\n' }];
  const before = structuredClone(input.assignment);
  const checked = await validateFlowTaskPlan(input);
  assert.equal(checked.ok, true); assert.deepEqual(checked.warnings, []); assert.deepEqual(input.assignment, before);
});
