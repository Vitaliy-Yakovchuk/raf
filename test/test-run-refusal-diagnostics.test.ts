import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRun } from '../src/test-runs.ts';
import type { TestId, TestRunResult } from '../src/test-runs.ts';
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

for (const phase of ['red', 'implement', 'qa', 'hotfix']) {
  test(`INVENTORY_INCOMPLETE names every absent configured file and the conf repair before spawn in ${phase}`, async () => {
    const harness = new RunHarness();
    const missing = ['test/resource-wait-runtime.test.ts', 'test/secrets-import.test.ts'];
    harness.config.projects.raf.profiles.node.unitFiles.push(...missing);
    const beforeConfig = structuredClone(harness.config);
    const result = await execute(harness, { phase });

    assert.equal(result.outcome, 'refused');
    assert.equal(result.errorCode, 'INVENTORY_INCOMPLETE');
    assert.equal(harness.spawns.length, 0);
    assert.equal(result.exitCode, null);
    assert.equal(result.timeoutCount, 0);
    const diagnostic = result.diagnostics.find(entry => entry.kind === 'preflight' && entry.errorCode === 'INVENTORY_INCOMPLETE');
    assert.ok(diagnostic, 'the inventory refusal must retain its inline preflight reason');
    assert.equal(diagnostic.test, null);
    for (const file of missing) assert.ok(diagnostic.message.includes(file), `missing inventory file ${file} must be named`);
    const instructions = [diagnostic.message, ...result.hints].join('\n');
    assert.ok(instructions.includes('conf/test-runs.json'), 'name the configuration that needs repair');
    assert.ok(instructions.includes('unitFiles'), 'identify the inventory entry to repair');
    assert.match(instructions, /виправ|видал|приб[еир]|онов|узгод|створ|дод|repair|remove|update|correct|restore|create/iu);
    assert.deepEqual(harness.config, beforeConfig, 'refusal must not silently edit the configured inventory');
  });
}

test('INVENTORY_INCOMPLETE also identifies a selected file absent from the environment and preserves the aggregate', async () => {
  const harness = new RunHarness();
  harness.environment.unitFiles = files.filter(file => file !== alpha.file);
  delete harness.environment.files[alpha.file];
  const previous = fixtureGroup({ knownRed: [alpha], timeoutCount: policy.optimizeAfterTimeouts, state: 'optimize' });
  harness.state.seed(previous);

  const result = await execute(harness);

  assert.equal(result.errorCode, 'INVENTORY_INCOMPLETE');
  assert.equal(harness.spawns.length, 0);
  assert.ok(result.diagnostics.some(entry => entry.kind === 'preflight' && entry.message.includes(alpha.file)));
  assert.deepEqual(harness.state.get(), previous, 'a preflight refusal cannot consume budget or erase known red');
});

test('GROUP_RENAME_REFUSED names the owning group and explains how to release the selection before spawn', async () => {
  const harness = new RunHarness();
  const conflictingGroup = 'add-raf-test-run/arguments';
  const requestedGroup = 'add-raf-test-run/refusal-diagnostics';
  harness.config.projects.raf.groups[requestedGroup] = { profileId: 'node', files: files.slice(0, 2) };
  const previous = fixtureGroup({
    key: { ...key, group: conflictingGroup },
    knownRed: [alpha], timeoutCount: policy.optimizeAfterTimeouts, state: 'optimize',
  });
  harness.state.seed(previous);

  const result = await execute(harness, { group: requestedGroup });

  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, 'GROUP_RENAME_REFUSED');
  assert.equal(harness.spawns.length, 0);
  const diagnostic = result.diagnostics.find(entry => entry.kind === 'preflight' && entry.errorCode === 'GROUP_RENAME_REFUSED');
  assert.ok(diagnostic, 'keep the group conflict as an inline preflight diagnostic');
  assert.ok(diagnostic.message.includes(conflictingGroup), 'identify the existing owner, not only the requested group');
  const instructions = [diagnostic.message, ...result.hints].join('\n');
  assert.match(instructions, /звільн|закри|закрит|заверш|архів|release|close|finish|complete|cleanup/iu, 'explain the supported release or close/cleanup action');
  assert.deepEqual(harness.state.get(previous.key), previous, 'a rename cannot reset the old group budget');
  assert.equal(harness.state.get({ ...key, group: requestedGroup }), undefined, 'a refusal cannot create a replacement aggregate');
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

  const next = await execute(harness, { phase: 'qa' });
  assert.equal(next.outcome, 'passed');
  assert.deepEqual(removed(next) ?? [], [], 'a later run must not re-emit historical removal as fresh evidence');
});

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

  const result = await execute(harness, { phase: 'implement', only: [alpha] });

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
