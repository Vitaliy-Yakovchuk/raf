import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRun } from '../src/test-runs.ts';
import type { TestRunResult } from '../src/test-runs.ts';
import { runTestRunCli } from '../src/test-run-cli.ts';
import { acknowledgeTestRunDelivery } from '../src/test-run-state-recovery.ts';
import { alpha, beta, fixtureRequest, flushMicrotasks, policy, RunHarness } from './helpers/test-run-fixture.ts';

const request = fixtureRequest({ files: [alpha.file] });
const run = (h: RunHarness) => runTestRun(request, h.config, policy, h.context, h.ports);

function harness(): RunHarness {
  const h = new RunHarness();
  h.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  return h;
}

const mismatches: Record<string, (result: TestRunResult) => void> = {
  project: result => { result.project = 'dash'; },
  workspace: result => { result.workspace = '/work/raf-hotfix'; },
  phase: result => { result.phase = 'qa'; },
  group: result => { result.group = 'other-change/unit'; },
  files: result => { result.selection.files = [beta.file]; },
  testIds: result => { result.selection.testIds = [alpha]; },
};

for (const source of ['pending', 'recovery'] as const) {
  for (const [field, change] of Object.entries(mismatches)) {
    test(`${source}: a different ${field} cannot deliver or acknowledge another request's result`, async () => {
      const h = harness();
      const saved = await run(h);
      change(saved);
      const group = h.state.get()!;
      group.lastResult = saved;
      h.state.seed(group);
      if (source === 'recovery') h.ports.recoverGroup = async () => structuredClone(saved);
      const before = structuredClone(h.state.get());
      let stdout = '';
      const code = await runTestRunCli(['--project', request.project, '--phase', request.phase,
        '--group', request.group, '--files', alpha.file], {
        config: h.config, policy, context: h.context, runtime: h.ports,
        stdout: text => { stdout += text; }, stderr: () => {},
      });
      const returned: TestRunResult = JSON.parse(stdout);
      assert.equal(returned.errorCode, 'GROUP_IN_FLIGHT');
      assert.equal(code, 1);
      assert.equal(returned.runId, 'fixture-run-2');
      assert.equal(returned.project, request.project);
      assert.equal(returned.workspace, h.context.workspace);
      assert.equal(returned.phase, request.phase);
      assert.equal(returned.group, request.group);
      assert.deepEqual(returned.selection, { files: [alpha.file], testIds: [] });
      assert.equal(h.spawns.length, 1);
      assert.deepEqual(h.state.get(), before);
    });
  }

  test(`${source}: an identical request retains its original recovery result`, async () => {
    const h = harness();
    const saved = await run(h);
    if (source === 'recovery') h.ports.recoverGroup = async () => structuredClone(saved);
    assert.deepEqual(await run(h), saved);
    assert.equal(h.spawns.length, 1);
  });
}

test('parallel selections keep their own runId through in-flight refusal, pending delivery and fresh execution', async () => {
  const first = harness();
  first.finishImmediately = false;
  first.ports.newRunId = () => 'alpha-run';
  const second = harness();
  second.ports.state = first.state;
  second.ports.newRunId = () => `beta-run-${++second.sequence}`;
  second.ports.recoverGroup = async () => null;
  second.events = [{ kind: 'passed', test: beta }, { kind: 'complete', expected: [beta] }];
  const runSecond = () => runTestRun({ ...request, files: [beta.file] }, second.config, policy, second.context, second.ports);
  const running = run(first);
  await flushMicrotasks();
  assert.equal(first.spawns.length, 1);
  const inFlight = await runSecond();
  assert.equal(inFlight.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(inFlight.runId, 'beta-run-1');
  assert.deepEqual(inFlight.selection.files, [beta.file]);
  first.resolveExit!(first.exit);
  const original = await running;
  assert.equal(original.runId, 'alpha-run');
  assert.deepEqual(original.selection.files, [alpha.file]);
  const before = structuredClone(first.state.get());
  const pending = await runSecond();
  assert.equal(pending.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(pending.runId, 'beta-run-2');
  assert.deepEqual(pending.selection.files, [beta.file]);
  assert.deepEqual(first.state.get(), before);
  assert.equal(second.spawns.length, 0);
  await acknowledgeTestRunDelivery(original, first.state);
  const fresh = await runSecond();
  assert.equal(fresh.runId, 'beta-run-3');
  assert.deepEqual(fresh.selection.files, [beta.file]);
  assert.equal(fresh.outcome, 'passed');
  assert.equal(second.spawns.length, 1);
});
