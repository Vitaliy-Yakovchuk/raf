import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTestRun } from '../src/test-runs.ts';
import type { TestId, TestRunResult } from '../src/test-runs.ts';
import { acknowledgeTestRunDelivery } from '../src/test-run-state-recovery.ts';
import {
  alpha, beta, files, fixtureGroup, fixtureRequest, flushMicrotasks, key, policy, RunHarness,
} from './helpers/test-run-fixture.ts';

const removedAlpha: TestId = { file: alpha.file, name: 'deleted alpha behavior' };
const removedBeta: TestId = { file: beta.file, name: 'deleted beta behavior' };

function removed(result: TestRunResult): TestId[] | undefined {
  return (result as TestRunResult & { removed?: TestId[] }).removed;
}

function execute(harness: RunHarness, overrides: Parameters<typeof fixtureRequest>[0] = {}): Promise<TestRunResult> {
  return runTestRun(fixtureRequest(overrides), harness.config, policy, harness.context, harness.ports);
}

for (const [workspace, otherWorkspace] of [['raf-develop', 'raf-hotfix'], ['raf-hotfix', 'raf-develop']]) {
  function workspaceHarness(): RunHarness {
    const harness = new RunHarness();
    harness.context.workspace = harness.context.cwd = `/work/${workspace}`;
    harness.environment.canonicalWorkspace = harness.environment.canonicalCwd = harness.context.workspace;
    for (const [file, fact] of Object.entries(harness.environment.files)) fact.realpath = `${harness.context.workspace}/${file}`;
    harness.config.projects.raf.profiles.node.unitFiles.push(`test/only-in-${otherWorkspace}.test.ts`);
    return harness;
  }

  for (const selection of ['files', 'preset'] as const) {
    test(`raf inventory: ${workspace} runs ${selection} while an unselected test exists only in ${otherWorkspace}`, async () => {
      const harness = workspaceHarness();
      const beforeConfig = structuredClone(harness.config);
      const result = await execute(harness, { phase: 'hotfix', ...(selection === 'preset' ? { files: undefined } : {}) });

      assert.equal(result.outcome, 'passed');
      assert.equal(harness.spawns.length, 1);
      assert.deepEqual(result.selection.files, files.slice(0, 2));
      assert.deepEqual(result.knownRed, []);
      assert.deepEqual(result.unexecuted, []);
      assert.deepEqual(result.unknown, []);
      assert.deepEqual(harness.config, beforeConfig, 'the shared inventory must remain unchanged');
    });
  }

}

test('a selected file absent from the environment is skipped with a warning and the rest of the group runs', async t => {
  const harness = new RunHarness();
  harness.environment.unitFiles = files.filter(file => file !== alpha.file);
  delete harness.environment.files[alpha.file];
  const warnings: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => { warnings.push(String(chunk)); return true; });
  const result = await execute(harness);
  t.mock.restoreAll();
  assert.notEqual(result.outcome, 'refused');
  assert.equal(harness.spawns.length, 1);
  assert.ok(!result.selection.files.includes(alpha.file));
  assert.ok(warnings.some(line => line.includes(alpha.file)));
});

test('a complete selected-file collection removes stale knownRed IDs, marks them separately, and permits passed', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ knownRed: [removedAlpha, alpha, removedBeta] }));

  const result = await execute(harness, { phase: 'implement' });

  assert.deepEqual(result.knownRed, [], 'IDs absent from the current complete collection must leave knownRed');
  assert.equal(result.outcome, 'passed');
  assert.equal(result.groupState, 'complete');
  assert.equal(result.nextAction, 'complete');
  assert.deepEqual(removed(result), [removedAlpha, removedBeta]);
  assert.deepEqual(result.passed, [alpha, beta], 'removed tests are not reported as executed passes');
  assert.deepEqual(result.unexecuted, []);
  assert.deepEqual(result.unknown, []);
  const saved = harness.state.get();
  assert.ok(saved?.lastResult);
  assert.deepEqual(saved.knownRed, []);
  assert.equal(saved.state, 'complete');
  assert.deepEqual(removed(saved.lastResult), [removedAlpha, removedBeta], 'lastResult must persist the same removal evidence');

  const replay = await execute(harness, { phase: 'qa' });
  assert.deepEqual(replay, result, 'state-open-recovery S08: an unacknowledged result must be replayed unchanged');
  assert.equal(harness.spawns.length, 1, 'pending delivery must not spawn another test run');

  await acknowledgeTestRunDelivery(result, harness.ports.state);
  const next = await execute(harness, { phase: 'qa' });
  assert.notEqual(next.runId, result.runId, 'confirmed receipt permits a fresh run');
  assert.equal(harness.spawns.length, 2);
  assert.equal(next.outcome, 'passed');
  assert.deepEqual(removed(next) ?? [], [], 'a later run must not re-emit historical removal as fresh evidence');
});

test('a complete collection retires knownRed and unexecuted IDs from a deleted workspace file', async () => {
  const harness = new RunHarness();
  delete harness.environment.files[beta.file];
  harness.state.seed(fixtureGroup({ knownRed: [removedBeta], unexecuted: [beta] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];

  const result = await execute(harness, { phase: 'hotfix', files: [alpha.file] });

  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.removed, [removedBeta, beta]);
  assert.deepEqual(result.passed, [alpha]);
  assert.deepEqual(result.knownRed, []);
  assert.deepEqual(result.unexecuted, []);
  assert.deepEqual(result.unknown, []);
  assert.equal(result.groupState, 'complete');
  assert.equal(result.nextAction, 'complete');
  assert.deepEqual(harness.state.get()?.knownRed, []);
  assert.deepEqual(harness.state.get()?.unexecuted, []);
  assert.deepEqual(harness.state.get()?.lastResult?.removed, [removedBeta, beta]);
});

test('an existing file outside the profile inventory retains its aggregate IDs', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'raf-existing-test-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, 'test'));
  writeFileSync(join(workspace, beta.file), '');
  const harness = new RunHarness();
  harness.context.workspace = workspace;
  harness.context.cwd = workspace;
  harness.context.projectWorkspaces.raf.push(workspace);
  harness.environment.canonicalWorkspace = workspace;
  harness.environment.canonicalCwd = workspace;
  for (const [file, fact] of Object.entries(harness.environment.files)) fact.realpath = join(workspace, file);
  delete harness.environment.files[beta.file];
  harness.state.seed(fixtureGroup({ key: { ...key, workspace }, knownRed: [removedBeta], unexecuted: [beta] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];

  const result = await execute(harness, { phase: 'hotfix', files: [alpha.file] });

  assert.equal(result.outcome, 'assertions-failed');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.knownRed, [removedBeta]);
  assert.deepEqual(result.unexecuted, [beta]);
});

for (const incomplete of ['only', 'protocol-error', 'cleanup'] as const) {
  test(`${incomplete} cannot retire IDs from a deleted workspace file`, async () => {
    const harness = new RunHarness();
    delete harness.environment.files[beta.file];
    harness.state.seed(fixtureGroup({ knownRed: [removedBeta], unexecuted: [beta] }));
    harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
    if (incomplete === 'protocol-error') harness.events.push({ kind: 'protocol-error', diagnostic: 'incomplete collection' });
    if (incomplete === 'cleanup') harness.cleanupResult = { complete: false, remainingPids: [103] };

    const result = await execute(harness, incomplete === 'only'
      ? { phase: 'hotfix', files: undefined, only: [alpha] }
      : { phase: 'hotfix', files: [alpha.file] });

    assert.notEqual(result.outcome, 'passed');
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.knownRed, [removedBeta]);
    assert.deepEqual(result.unexecuted, [beta]);
  });
}

test('a complete collection retires deleted IDs while retaining a current assertion failure', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ knownRed: [removedAlpha, alpha] }));
  harness.events = [
    { kind: 'assertion-failed', test: alpha, diagnostic: 'current behavior still fails' },
    { kind: 'passed', test: beta },
    { kind: 'complete', expected: [alpha, beta] },
  ];
  harness.exit = { exitCode: 1, signal: null, stderr: '' };

  const result = await execute(harness, { phase: 'implement' });

  assert.equal(result.outcome, 'assertions-failed');
  assert.deepEqual(result.knownRed, [alpha]);
  assert.deepEqual(removed(result), [removedAlpha]);
  assert.deepEqual(harness.state.get()?.knownRed, [alpha]);
});

test('collection reconciliation uses full file/name identity when another file retains the same test name', async () => {
  const harness = new RunHarness();
  const renamedAlpha = { file: alpha.file, name: 'replacement alpha behavior' };
  const sameNameInBeta = { file: beta.file, name: removedAlpha.name };
  harness.state.seed(fixtureGroup({ knownRed: [removedAlpha, sameNameInBeta] }));
  harness.events = [
    { kind: 'passed', test: renamedAlpha },
    { kind: 'assertion-failed', test: sameNameInBeta, diagnostic: 'the other file still fails' },
    { kind: 'complete', expected: [renamedAlpha, sameNameInBeta] },
  ];
  harness.exit = { exitCode: 1, signal: null, stderr: '' };

  const result = await execute(harness, { phase: 'implement' });

  assert.deepEqual(result.knownRed, [sameNameInBeta]);
  assert.deepEqual(removed(result), [removedAlpha]);
  assert.equal(result.outcome, 'assertions-failed');
});

test('a narrowed file selection cannot retire knownRed belonging to an uncollected file', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ knownRed: [removedAlpha, removedBeta] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];

  const result = await execute(harness, { phase: 'implement', files: [alpha.file] });

  assert.deepEqual(result.knownRed, [removedBeta]);
  assert.deepEqual(removed(result), [removedAlpha]);
  assert.notEqual(result.outcome, 'passed');
  assert.deepEqual(harness.state.get()?.knownRed, [removedBeta]);
});

test('a filtered --only completion cannot prove that another knownRed in the same file was deleted', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ knownRed: [alpha, removedAlpha] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];

  const result = await execute(harness, { phase: 'implement', files: undefined, only: [alpha] });

  assert.deepEqual(result.knownRed, [removedAlpha]);
  assert.deepEqual(removed(result) ?? [], []);
  assert.notEqual(result.outcome, 'passed');
  assert.deepEqual(harness.state.get()?.knownRed, [removedAlpha]);
});

test('a timeout before authoritative collection preserves knownRed and the group timeout budget', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ knownRed: [removedAlpha] }));
  harness.finishImmediately = false;
  harness.events = [{ kind: 'discovered', test: alpha }];
  const pending = execute(harness, { phase: 'implement' });
  await flushMicrotasks();
  assert.equal(harness.spawns.length, 1, 'the timeout fixture must reach the managed runner');
  harness.clock.advance(policy.timeoutMs);

  const result = await pending;

  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.knownRed, [removedAlpha]);
  assert.deepEqual(removed(result) ?? [], []);
  assert.equal(result.timeoutCount, 1);
  assert.deepEqual(harness.state.get()?.knownRed, [removedAlpha]);
});

for (const failure of ['missing-complete', 'protocol-error', 'setup', 'empty-collection'] as const) {
  test(`${failure} cannot turn unobserved knownRed into removed IDs or passed`, async () => {
    const harness = new RunHarness();
    harness.state.seed(fixtureGroup({ knownRed: [removedAlpha] }));
    harness.events = [{ kind: 'passed', test: alpha }, { kind: 'passed', test: beta }];
    if (failure === 'protocol-error') harness.events.push({ kind: 'protocol-error', diagnostic: 'truncated collection stream' });
    if (failure === 'setup') {
      harness.events = [{ kind: 'setup-failed', test: alpha, diagnostic: 'collection did not finish' }];
      harness.exit = { exitCode: 1, signal: null, stderr: '' };
    }
    if (failure === 'empty-collection') harness.events = [{ kind: 'complete', expected: [] }];

    const result = await execute(harness, { phase: 'implement' });

    assert.deepEqual(result.knownRed, [removedAlpha]);
    assert.deepEqual(removed(result) ?? [], []);
    assert.notEqual(result.outcome, 'passed');
    assert.deepEqual(harness.state.get()?.knownRed, [removedAlpha]);
  });
}
