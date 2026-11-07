import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRunCli } from '../src/test-run-cli.ts';
import type { TestRunResult } from '../src/test-runs.ts';
import { alpha, beta, files, policy, RunHarness } from './helpers/test-run-fixture.ts';

const group = 'add-raf-test-run/unit';
const stale = { ...alpha, name: ' > runtime/old title > behavior' };

function integrationHarness() {
  const harness = new RunHarness();
  const { unitFiles, ...profile } = harness.config.projects.raf.profiles.node;
  harness.config.projects.raf.profiles.integration = {
    ...profile, testKind: 'integration', integrationFiles: files,
  };
  delete harness.config.projects.raf.profiles.node;
  harness.context.integrationTests = { timeoutMs: policy.timeoutMs };
  harness.config.projects.raf.groups[group].profileId = 'integration';
  for (const fact of Object.values(harness.environment.files)) {
    Object.assign(fact, { unit: false, testKind: 'integration' });
  }
  return harness;
}

async function run(harness: RunHarness, selection: string[] = []) {
  let result: TestRunResult;
  const cliExitCode = await runTestRunCli([
    '--project', 'raf', '--phase', 'integration', '--group', group, ...selection,
  ], {
    config: harness.config, policy, context: harness.context, runtime: harness.ports,
    stdout: text => { result = JSON.parse(text); }, stderr: () => {},
  });
  return { result: result!, cliExitCode };
}

async function setupFailure(harness: RunHarness) {
  harness.events = [{ kind: 'setup-failed', test: stale }, { kind: 'complete', expected: [stale] }];
  harness.exit.exitCode = 1;
  const { result, cliExitCode } = await run(harness);
  assert.equal(cliExitCode, 1);
  assert.deepEqual(result.unknown, [stale]);
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'passed', test: beta },
    { kind: 'complete', expected: [alpha, beta] }];
  harness.exit.exitCode = 0;
}

test('full group discovery retires setup IDs with an obsolete titlePath and CLI succeeds', async () => {
  const harness = integrationHarness();
  await setupFailure(harness);
  harness.context.sha = 'new-sha';
  const { result, cliExitCode } = await run(harness);
  assert.equal(cliExitCode, 0);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.removed, [stale]);
  assert.deepEqual(result.unknown, []);
  assert.equal(result.groupState, 'complete');
  assert.equal(result.nextAction, 'complete');
  assert.deepEqual(harness.state.get()?.unknown, []);
  assert.deepEqual((await run(harness)).result.removed, []);
});

for (const selectedFiles of [[alpha.file], [alpha.file, beta.file]]) {
  test(`explicit --files preserves obsolete unknown IDs: ${selectedFiles.join(', ')}`, async () => {
    const harness = integrationHarness();
    await setupFailure(harness);
    const { result, cliExitCode } = await run(harness, ['--files', ...selectedFiles]);
    assert.equal(cliExitCode, 1);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.unknown, [stale]);
    assert.deepEqual(harness.state.get()?.unknown, [stale]);
  });
}

test('unsupported integration --only leaves the stored unknown ledger untouched', async () => {
  const harness = integrationHarness();
  await setupFailure(harness);
  const { result, cliExitCode } = await run(harness, ['--only', `${alpha.file}::${alpha.name}`]);
  assert.equal(cliExitCode, 1);
  assert.equal(result.outcome, 'refused');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(harness.state.get()?.unknown, [stale]);
});

test('full discovery retains a currently collected unknown ID', async () => {
  const harness = integrationHarness();
  await setupFailure(harness);
  harness.events = [{ kind: 'discovered', test: stale }, { kind: 'passed', test: alpha },
    { kind: 'complete', expected: [stale, alpha] }];
  const { result, cliExitCode } = await run(harness);
  assert.equal(cliExitCode, 1);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.unknown, [stale]);
});

for (const incomplete of ['missing-complete', 'protocol-error', 'setup', 'cleanup'] as const) {
  test(`incomplete discovery preserves obsolete unknown IDs: ${incomplete}`, async () => {
    const harness = integrationHarness();
    await setupFailure(harness);
    if (incomplete === 'missing-complete') harness.events.pop();
    if (incomplete === 'protocol-error') harness.events.push({ kind: 'protocol-error', diagnostic: 'incomplete discovery' });
    if (incomplete === 'setup') harness.events.push({ kind: 'setup-failed', test: alpha });
    if (incomplete === 'cleanup') harness.cleanupResult = { complete: false, remainingPids: [103] };
    const { result, cliExitCode } = await run(harness);
    assert.equal(cliExitCode, 1);
    assert.deepEqual(result.removed, []);
    assert.ok(result.unknown.some(id => id.name === stale.name));
  });
}
