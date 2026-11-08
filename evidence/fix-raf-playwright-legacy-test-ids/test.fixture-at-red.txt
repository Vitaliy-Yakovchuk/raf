import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRunCli } from '../src/test-run-cli.ts';
import type { TestId, TestRunGroup, TestRunResult } from '../src/test-runs.ts';
import { alpha, beta, files, fixtureGroup, policy, RunHarness } from './helpers/test-run-fixture.ts';

const group = 'add-raf-test-run/unit';
const current = { ...alpha, name: `${alpha.file} > suite > edits map` };
const legacy = { ...current, name: ` > ${current.name}` };

function harnessFor(adapter = 'node-test-events', integration = true) {
  const harness = new RunHarness();
  const { unitFiles, ...profile } = harness.config.projects.raf.profiles.node;
  harness.config.projects.raf.profiles.node = {
    ...profile, resultAdapter: adapter,
    argv: adapter === 'vitest-events' ? ['vitest.mjs', 'run'] : profile.argv,
    exactIds: adapter === 'vitest-events' ? 'vitest-test-name' : 'node-test-name',
    ...(integration ? { testKind: 'integration', integrationFiles: files } : { unitFiles }),
  };
  harness.context.integrationTests = { timeoutMs: policy.timeoutMs };
  if (integration) {
    for (const fact of Object.values(harness.environment.files)) {
      Object.assign(fact, { unit: false, testKind: 'integration' });
    }
  }
  harness.events = [{ kind: 'passed', test: current }, { kind: 'passed', test: beta },
    { kind: 'complete', expected: [current, beta] }];
  return harness;
}

function seed(harness: RunHarness, overrides: Partial<TestRunGroup>) {
  harness.state.seed(fixtureGroup({
    profileId: 'node', testKind: harness.config.projects.raf.profiles.node.testKind ?? 'unit', ...overrides,
  }));
}

async function run(harness: RunHarness, selection = ['--files', alpha.file, beta.file]) {
  let result: TestRunResult;
  const cliExitCode = await runTestRunCli([
    '--project', 'raf', '--phase', 'hotfix', '--group', group, ...selection,
  ], {
    config: harness.config, policy, context: harness.context, runtime: harness.ports,
    stdout: text => { result = JSON.parse(text); }, stderr: () => {},
  });
  return { result: result!, cliExitCode };
}

for (const selection of [[], ['--files', alpha.file, beta.file]]) {
  test(`legacy Playwright unknown matches passed ID without retiring history: ${selection.join(' ') || 'full group'}`, async () => {
    const harness = harnessFor();
    seed(harness, { unknown: [legacy], profileId: 'node', testKind: 'integration', timeoutCount: 1 });
    const { result, cliExitCode } = await run(harness, selection);
    assert.equal(cliExitCode, 0);
    assert.equal(result.outcome, 'passed');
    assert.deepEqual(result.unknown, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.passed, [current, beta]);
    assert.equal(result.groupState, 'complete');
    assert.equal(result.nextAction, 'complete');
    assert.equal(result.timeoutCount, 1);
    assert.deepEqual(harness.state.get()?.unknown, []);
    assert.equal((await run(harness, selection)).cliExitCode, 0);
  });
}

test('legacy outstanding ledgers retain a collected test that has no terminal result', async () => {
  const harness = harnessFor();
  seed(harness, { knownRed: [legacy], unexecuted: [legacy], unknown: [legacy] });
  harness.events = [{ kind: 'passed', test: beta }, { kind: 'complete', expected: [current, beta] }];
  const { result, cliExitCode } = await run(harness);
  assert.equal(cliExitCode, 1);
  assert.deepEqual(result.knownRed, [current]);
  assert.deepEqual(result.unknown, [current]);
  assert.deepEqual(result.unexecuted, [current]);
  assert.deepEqual(result.removed, []);
});

test('legacy knownRed and unexecuted are confirmed by the canonical passed ID', async () => {
  const harness = harnessFor();
  seed(harness, { knownRed: [legacy], unexecuted: [legacy] });
  const { result, cliExitCode } = await run(harness);
  assert.equal(cliExitCode, 0);
  assert.deepEqual(result.knownRed, []);
  assert.deepEqual(result.unexecuted, []);
  assert.deepEqual(result.removed, []);
});

test('legacy unknown fallback from lastResult uses the same identity', async () => {
  const harness = harnessFor();
  const { result: prior } = await run(harness);
  seed(harness, { lastResult: { ...prior, unknown: [legacy] } });
  const { result, cliExitCode } = await run(harness);
  assert.equal(cliExitCode, 0);
  assert.deepEqual(result.unknown, []);
});

for (const [adapter, integration] of [['vitest-events', true], ['node-test-events', false]] as const) {
  test(`other profile ledger is unchanged: ${adapter}, integration=${integration}`, async () => {
    const harness = harnessFor(adapter, integration);
    seed(harness, { unknown: [legacy] });
    const { result } = await run(harness);
    assert.deepEqual(harness.state.get()?.unknown, [legacy]);
    if (integration) assert.deepEqual(result.unknown, [legacy]);
  });
}

test('a different file or title is not treated as the same test', async () => {
  const harness = harnessFor();
  const unrelated: TestId[] = [
    { ...legacy, file: beta.file },
    { ...legacy, name: `${legacy.name} differently` },
  ];
  seed(harness, { unknown: unrelated });
  const { result, cliExitCode } = await run(harness);
  assert.equal(cliExitCode, 1);
  assert.deepEqual(result.unknown, unrelated);
});
