import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRunCli } from '../src/test-run-cli.ts';
import type { TestRunResult } from '../src/test-runs.ts';
import { alpha, beta, gamma, fixtureGroup, policy, RunHarness } from './helpers/test-run-fixture.ts';

const group = 'add-raf-test-run/unit';
async function run(harness: RunHarness, selection: string[] = []) {
  let result: TestRunResult;
  const cliCode = await runTestRunCli(['--project', 'raf', '--phase', 'implement', '--group', group, ...selection], {
    config: harness.config, policy, context: harness.context, runtime: harness.ports,
    stdout: text => { result = JSON.parse(text); }, stderr: () => {},
  });
  return { result: result!, cliCode };
}

for (const selection of [[], ['--files', alpha.file]]) {
  test(`registry contraction retires stale ledger and CLI passes: ${selection.join(' ') || 'preset'}`, async () => {
    const harness = new RunHarness();
    harness.config.projects.raf.groups[group].files = [alpha.file, beta.file, gamma.file];
    harness.state.seed(fixtureGroup({ timeoutCount: 1 }));
    harness.events = [{ kind: 'passed', test: alpha }, { kind: 'assertion-failed', test: beta },
      { kind: 'discovered', test: gamma }];
    harness.exit.exitCode = 1;
    const red = await run(harness);
    assert.equal(red.cliCode, 1);
    assert.deepEqual(red.result.knownRed, [beta]);
    assert.deepEqual(red.result.unexecuted, [gamma]);
    harness.config.projects.raf.groups[group].files = [alpha.file];
    harness.context.sha = 'next-sha';
    harness.context.agentId = 'next-agent';
    harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
    harness.exit.exitCode = 0;
    const green = await run(harness, selection);
    assert.equal(green.cliCode, 0);
    assert.equal(green.result.outcome, 'passed');
    assert.deepEqual(green.result.removed, [beta, gamma]);
    assert.deepEqual(green.result.removalReasons, [beta, gamma].map(test => ({ test, reason: 'outside-configured-selection' })));
    assert.deepEqual(green.result.knownRed, []);
    assert.deepEqual(green.result.unexecuted, []);
    assert.equal(green.result.timeoutCount, 1);
    assert.equal(green.result.groupState, 'complete');
    assert.equal(green.result.nextAction, 'complete');
    assert.deepEqual(harness.state.get()?.knownRed, []);
    assert.deepEqual(harness.state.get()?.unexecuted, []);
    assert.deepEqual((await run(harness)).result.removed, []);
  });
}

test('only confirmation cannot retire stale ledger without complete discovery', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ knownRed: [beta], unexecuted: [gamma] }));
  harness.config.projects.raf.groups[group].files = [alpha.file];
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  const { result } = await run(harness, ['--only', `${alpha.file}::${alpha.name}`]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.knownRed, [beta]);
  assert.deepEqual(result.unexecuted, [gamma]);
});
