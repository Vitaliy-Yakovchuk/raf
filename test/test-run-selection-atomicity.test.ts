import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runTestRun,
  type ChildExit,
  type TestId,
  type TestRunConfig,
  type TestRunContext,
  type TestRunEnvironment,
  type TestRunGroup,
  type TestRunGroupKey,
  type TestRunPorts,
  type TestRunRequest,
  type TestRunResult,
  type TestRunStatePort,
  type TestRunTransaction,
  type UnitTestPolicy,
} from '../src/test-runs.ts';

const change = 'complete-raf-flow-contracts';
const workspace = '/fixture/raf-develop';
const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/unselected.test.ts'];
const groupA = `${change}/a`;
const groupB = `${change}/b`;
const groupC = `${change}/c`;
const policy: UnitTestPolicy = { timeoutMs: 1_000, optimizeAfterTimeouts: 1, maxGroupTimeouts: 3 };
const clone = <T>(value: T): T => structuredClone(value);
const id = (file: string, name = 'retained failure'): TestId => ({ file, name });
const key = (group: string): TestRunGroupKey => ({ project: 'raf', workspace, group });
const encodeKey = (value: TestRunGroupKey): string => JSON.stringify([value.project, value.workspace, value.group]);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function config(): TestRunConfig {
  const hints = { refusal: 'refusal', setup: 'setup', assertions: 'assertions', timeout: 'timeout', interruption: 'interruption' };
  return {
    diagnostics: {
      maxEntries: 64, maxMessageBytes: 4_096, maxStackFrames: 16,
      maxStackBytes: 8_192, maxTotalBytes: 65_536,
      maxStderrBytes: 8_192, redactionPatterns: [],
    },
    temporaryArtifacts: { root: '/tmp', minimumNestedSocketPathBytes: 80 },
    phases: {
      red: { allowed: true, purpose: 'initial-red', hints },
      implement: { allowed: true, purpose: 'verification', hints },
      qa: { allowed: true, purpose: 'verification', hints },
    },
    hints,
    projects: {
      raf: {
        profiles: {
          node: {
            cwd: '.', executable: 'node', argv: ['fixture-runner.ts'], unitFiles: files,
            exactIds: 'node-test-name', resultAdapter: 'node-test-events',
            environment: { isolatedHome: true, stateOrigin: true }, checks: [],
          },
        },
        groups: {
          [groupA]: { profileId: 'node', files: [files[0]] },
          [groupB]: { profileId: 'node', files: [files[1]] },
          [groupC]: { profileId: 'node', files: [files[2]] },
        },
      },
    },
  };
}

function context(): TestRunContext {
  return {
    cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] },
    agentPhases: ['red', 'implement', 'qa'], activeChanges: [change],
    agentId: 'fixture-implement', callerPhase: 'implement', sha: 'a'.repeat(40),
    home: '/fixture/qa-home', statePath: '/fixture/qa-home/.raf/state.sqlite',
    tmpPath: '/fixture/qa-home/.raf/tmp', operationalHome: '/fixture/control-home',
  };
}

function environment(): TestRunEnvironment {
  return {
    canonicalWorkspace: workspace, canonicalCwd: workspace,
    gitIdentityMatches: true, runtimeAvailable: true, localRunnerAvailable: true,
    dependenciesAvailable: true, resultAdapterAvailable: true, artifactsWritable: true,
    treeControlSupported: true, isolatedHome: true, stateOriginAllowed: true,
    stateAliasesOperational: false, tmpAliasesOperational: false, inheritedOperationalChannel: false,
    unitFiles: files,
    files: Object.fromEntries(files.map(file => [file, { kind: 'file' as const, realpath: `${workspace}/${file}`, unit: true }])),
  };
}

function previousResult(group: string, file: string): TestRunResult {
  return {
    runId: `previous-${group}`, project: 'raf', workspace, phase: 'red', group,
    profileId: 'node', testKind: 'unit',
    timeoutPolicy: { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: policy.timeoutMs }, callerPhase: 'red',
    selection: { files: [file], testIds: [] }, command: null,
    startedAt: new Date(0).toISOString(), durationMs: policy.timeoutMs,
    exitCode: null, signal: 'SIGTERM', timedOut: true,
    outcome: 'timed-out', failureKinds: ['timeout', 'assertions'],
    passed: [], knownRed: [id(file)], unexecuted: [id(file, 'not reached')],
    unknown: [id(file, 'unknown')], removed: [id(file, 'previously removed')],
    cleanup: { complete: true, remainingPids: [] }, groupState: 'optimize',
    timeoutCount: 1, nextAction: 'optimize', hintIds: ['timeout'], hints: ['timeout'], evidence: [],
    diagnostics: [], diagnosticSummary: {
      totalEntries: 0, retainedEntries: 0, omittedEntries: 0, truncated: false, redacted: false,
    },
    environmentSummary: {
      executable: 'node', runtimeVersion: 'fixture', adapter: 'node-test-events', isolation: 'fixture',
      configurationFingerprints: { flow: 'fixture-flow', testRuns: 'fixture-tests', projects: 'fixture-projects' },
      tmpPathBytes: 0, privateRunTmp: false,
    },
  };
}

function aggregate(group: string, file: string): TestRunGroup {
  const lastResult = previousResult(group, file);
  return {
    key: key(group), testKind: 'unit', profileId: 'node', timeoutCount: 1, state: 'optimize',
    selection: clone(lastResult.selection), knownRed: clone(lastResult.knownRed),
    unexecuted: clone(lastResult.unexecuted), unknown: clone(lastResult.unknown),
    inFlight: null, lastResult,
  };
}

function memoryState(initial: TestRunGroup[] = []): {
  port: TestRunStatePort;
  snapshot: () => TestRunGroup[];
  get: (group: string) => TestRunGroup | null;
  transactions: string[][];
  firstChildBound: Promise<void>;
} {
  let rows = new Map(initial.map(row => [encodeKey(row.key), clone(row)]));
  let tail: Promise<unknown> = Promise.resolve();
  const transactions: string[][] = [];
  const firstChildBound = deferred<void>();
  return {
    snapshot: () => clone([...rows.values()].sort((a, b) => encodeKey(a.key).localeCompare(encodeKey(b.key)))),
    get: group => clone(rows.get(encodeKey(key(group))) ?? null),
    transactions,
    firstChildBound: firstChildBound.promise,
    port: {
      transaction<T>(operation: (transaction: TestRunTransaction) => T): Promise<T> {
        const pending = tail.then(() => {
          const draft = new Map([...rows].map(([k, v]) => [k, clone(v)]));
          const operations: string[] = [];
          const result = operation({
            get(k) { operations.push('get'); return clone(draft.get(encodeKey(k)) ?? null); },
            list(project, root) {
              operations.push('list');
              return clone([...draft.values()].filter(row => row.key.project === project && row.key.workspace === root));
            },
            put(row) {
              const previous = draft.get(encodeKey(row.key));
              operations.push(row.inFlight && previous?.inFlight?.runId !== row.inFlight.runId ? 'reserve' : 'put');
              draft.set(encodeKey(row.key), clone(row));
            },
            delete(k) { operations.push('delete'); draft.delete(encodeKey(k)); },
          });
          rows = draft;
          transactions.push(operations);
          if ([...rows.values()].some(row => row.inFlight?.processIdentity)) firstChildBound.resolve();
          return result;
        });
        tail = pending.catch(() => undefined);
        return pending;
      },
    },
  };
}

function harness(initial = [aggregate(groupA, files[0]), aggregate(groupB, files[1])]) {
  const state = memoryState(initial);
  const firstSpawn = deferred<void>();
  const release = deferred<void>();
  const commands: Parameters<TestRunPorts['spawn']>[0][] = [];
  let holdChild = false;
  let serial = 0;
  let reconcileCalls = 0;
  const ports: TestRunPorts = {
    state: state.port,
    preflight: async () => environment(),
    clock: { now: () => 10_000, schedule: () => () => undefined },
    newRunId: () => `fixture-run-${++serial}`,
    subscribeInterruption: () => () => undefined,
    reconcile: async () => {
      reconcileCalls++;
      return { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [90_001] } };
    },
    spawn: async (command, onEvent) => {
      commands.push(clone(command));
      firstSpawn.resolve();
      const selected = files.filter(file => command.argv.includes(file));
      const wait = async (): Promise<ChildExit> => {
        if (holdChild) await release.promise;
        const expected = command.environment.testIds?.length ? command.environment.testIds : selected.map(file => id(file));
        for (const testId of expected) {
          onEvent({ kind: 'discovered', test: testId });
          onEvent({ kind: 'passed', test: testId });
        }
        onEvent({ kind: 'complete', expected });
        return { exitCode: 0, signal: null, stderr: '' };
      };
      return { identity: `fixture-child-${commands.length}`, wait, cleanup: async () => ({ complete: true, remainingPids: [] }) };
    },
  };
  const request = (group: string, selected: string[]): TestRunRequest => ({ project: 'raf', phase: 'implement', group, files: selected });
  const cfg = config();
  const ctx = context();
  return {
    state, ports, cfg, ctx, commands, firstSpawn: firstSpawn.promise,
    hold: () => { holdChild = true; }, release: () => release.resolve(),
    reconcileCount: () => reconcileCalls,
    run: (group: string, selected: string[]) => runTestRun(request(group, selected), cfg, policy, ctx, ports),
    runRequest: (value: TestRunRequest) => runTestRun(value, cfg, policy, ctx, ports),
  };
}

function diagnosticText(result: TestRunResult): string {
  return JSON.stringify({ diagnostics: result.diagnostics, hints: result.hints });
}

test('Z399 S01 refused expansion preserves every aggregate and reports exact conflict group/files', async () => {
  const h = harness();
  const before = h.state.snapshot();
  const result = await h.run(groupA, [files[0], files[1]]);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, 'GROUP_RENAME_REFUSED');
  assert.deepEqual(result.selection.files, [files[0], files[1]]);
  assert.equal(result.exitCode, null);
  assert.equal(h.commands.length, 0);
  assert.deepEqual(h.state.snapshot(), before);
  assert.ok(diagnosticText(result).includes(groupB));
  assert.ok(diagnosticText(result).includes(files[1]));
  assert.deepEqual(h.state.get(groupA)?.selection.files, [files[0]]);
  assert.deepEqual(h.state.get(groupA)?.lastResult?.removed, [id(files[0], 'previously removed')]);
});

test('Z399 S02 refused new C leaves no row and original A retains its budget on the next accepted run', async () => {
  const h = harness();
  const before = h.state.snapshot();
  const b = h.state.get(groupB);
  const refused = await h.run(groupC, [files[0], files[1]]);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.errorCode, 'GROUP_RENAME_REFUSED');
  assert.equal(h.state.get(groupC), null);
  assert.deepEqual(h.state.snapshot(), before);
  assert.equal(h.commands.length, 0);
  const a = h.state.get(groupA)!;
  const retried = await h.runRequest({ project: 'raf', phase: 'qa', group: groupA, files: [files[0]] });
  assert.equal(retried.outcome, 'passed');
  assert.equal(h.commands.length, 1);
  assert.equal(retried.timeoutCount, a.timeoutCount);
  assert.equal(h.state.get(groupA)?.timeoutCount, a.timeoutCount);
  assert.deepEqual(h.state.get(groupA)?.selection.files, [files[0]]);
  assert.deepEqual(h.state.get(groupB), b);
  assert.equal(h.state.get(groupC), null);
});

test('Z399 S01 canonical aliases cannot evade the saved conflict selection', async () => {
  const h = harness();
  const alias = 'test/alias-b.test.ts';
  h.cfg.projects.raf.profiles.node.unitFiles = [...files, alias];
  h.ports.preflight = async () => {
    const env = environment();
    env.unitFiles = [...files, alias];
    env.files[alias] = { kind: 'file', realpath: `${workspace}/${files[1]}`, unit: true };
    return env;
  };
  const before = h.state.snapshot();
  const result = await h.run(groupA, [files[0], alias]);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, 'GROUP_RENAME_REFUSED');
  assert.ok(diagnosticText(result).includes(groupB));
  assert.ok(diagnosticText(result).includes(files[1]));
  assert.equal(h.commands.length, 0);
  assert.deepEqual(h.state.snapshot(), before);
});

test('Z399 S02 original A still runs after its own refused expansion without resetting knownRed or lastResult', async () => {
  const h = harness();
  const before = h.state.snapshot();
  const a = h.state.get(groupA)!;
  await h.run(groupA, [files[0], files[1]]);
  assert.deepEqual(h.state.snapshot(), before);
  const retried = await h.runRequest({ project: 'raf', phase: 'implement', group: groupA, only: a.knownRed });
  assert.equal(retried.outcome, 'setup-failed');
  assert.ok(retried.failureKinds.includes('setup'));
  assert.deepEqual(retried.passed, a.knownRed);
  assert.deepEqual(retried.unexecuted, a.unexecuted);
  assert.equal(retried.timeoutCount, a.timeoutCount);
  assert.deepEqual(retried.selection.testIds, a.knownRed);
  assert.equal(h.commands.length, 1);
  assert.equal(h.state.get(groupA)?.lastResult?.runId, retried.runId);
});

test('Z399 S03 concurrent overlapping groups reserve atomically and the loser cannot replace the winner inFlight', async () => {
  const h = harness([]);
  h.hold();
  const ready = deferred<void>();
  const start = deferred<void>();
  let arrivals = 0;
  h.ports.preflight = async () => {
    if (++arrivals === 2) ready.resolve();
    await start.promise;
    return environment();
  };
  const left = h.run(groupA, [files[0]]);
  const right = h.run(groupC, [files[0]]);
  try {
    await Promise.race([ready.promise, Promise.all([left, right]).then(() => assert.fail('both callers must reach preflight'))]);
    start.resolve();
    await Promise.race([h.firstSpawn, Promise.all([left, right]).then(() => assert.fail('one caller must reserve and spawn'))]);
    const winnerSnapshot = h.state.snapshot();
    assert.equal(winnerSnapshot.length, 1);
    assert.ok(winnerSnapshot[0].inFlight);
    winnerSnapshot[0].inFlight.processIdentity = 'fixture-child-1';
    await Promise.race([
      h.state.firstChildBound,
      Promise.all([left, right]).then(() => assert.fail('the winner must bind its child identity')),
    ]);
    assert.deepEqual(h.state.snapshot(), winnerSnapshot);
    const loser = await Promise.race([left, right]);
    assert.equal(loser.outcome, 'refused');
    assert.equal(loser.errorCode, 'GROUP_RENAME_REFUSED');
    assert.equal(h.commands.length, 1);
    assert.deepEqual(h.state.snapshot(), winnerSnapshot);
    assert.ok(diagnosticText(loser).includes(winnerSnapshot[0].key.group));
    assert.ok(diagnosticText(loser).includes(files[0]));
    const reservations = h.state.transactions.filter(operations => operations.includes('reserve'));
    assert.equal(reservations.length, 1);
    for (const operations of reservations) {
      assert.ok(operations.includes('list'), 'stable-group overlap check shares the reservation transaction');
    }
  } finally {
    start.resolve();
    h.release();
    await Promise.allSettled([left, right]);
  }
  const results = await Promise.all([left, right]);
  assert.deepEqual(results.map(result => result.outcome).sort(), ['passed', 'refused']);
  assert.equal(h.commands.length, 1);
});

test('Z399 S03 live competing inFlight is neither reset nor recovered as a rejected request', async () => {
  const a = aggregate(groupA, files[0]);
  a.state = 'running';
  a.inFlight = {
    runId: 'accepted-owner', deadlineMs: 10_000 + policy.timeoutMs,
    startedAtMs: 10_000,
    timeoutPolicy: { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: policy.timeoutMs },
    callerPhase: 'implement', processIdentity: 'live-owner',
  };
  const h = harness([a, aggregate(groupB, files[1])]);
  const before = h.state.snapshot();
  const result = await h.run(groupA, [files[0]]);
  assert.equal(result.outcome, 'refused');
  assert.equal(h.commands.length, 0);
  assert.deepEqual(h.state.snapshot(), before);
  assert.equal(h.state.get(groupA)?.inFlight?.runId, 'accepted-owner');
});

for (const refusal of ['budget', 'unknown-red', 'profile'] as const) {
  test(`Z399 S04 ${refusal} refusal preserves all aggregates before reservation`, async () => {
    const a = aggregate(groupA, files[0]);
    if (refusal === 'budget') {
      a.timeoutCount = policy.maxGroupTimeouts;
      a.state = 'confirm-known-red';
    }
    if (refusal === 'profile') a.profileId = 'previously-accepted-profile';
    const h = harness([a, aggregate(groupB, files[1])]);
    const before = h.state.snapshot();
    const result = refusal === 'unknown-red'
      ? await h.runRequest({ project: 'raf', phase: 'implement', group: groupA, only: [id(files[0], 'never recorded')] })
      : await h.run(groupA, [files[0]]);
    assert.equal(result.outcome, 'refused');
    if (refusal === 'unknown-red') assert.equal(result.errorCode, 'UNKNOWN_RED_TEST');
    assert.deepEqual(h.state.snapshot(), before);
    assert.equal(h.commands.length, 0);
    assert.equal(result.exitCode, null);
    assert.equal(h.reconcileCount(), 0);
    assert.ok(!h.state.transactions.some(operations => operations.includes('reserve')));
  });
}

test('Z399 S04 accepted setup before spawn keeps reservation accounting and a new lastResult', async () => {
  const h = harness();
  const a = h.state.get(groupA)!;
  const b = h.state.get(groupB);
  let observedReservation: TestRunGroup['inFlight'] = null;
  h.ports.prepareTemporary = async () => {
    observedReservation = h.state.get(groupA)?.inFlight ?? null;
    throw new Error('fixture private temporary setup unavailable');
  };
  const result = await h.run(groupA, [files[0], files[2]]);
  const reserved = observedReservation as TestRunGroup['inFlight'];
  if (!reserved) throw new Error('the injected setup failure must occur after reservation');
  assert.equal(reserved.runId, result.runId);
  assert.equal(result.outcome, 'setup-failed');
  assert.ok(result.failureKinds.includes('setup'));
  assert.equal(result.exitCode, null);
  assert.equal(h.commands.length, 0);
  assert.equal(result.timeoutCount, a.timeoutCount);
  const after = h.state.get(groupA)!;
  assert.equal(after.timeoutCount, a.timeoutCount);
  assert.equal(after.inFlight, null);
  assert.deepEqual(after.selection.files, [files[0], files[2]]);
  assert.equal(after.lastResult?.runId, result.runId);
  assert.equal(after.lastResult?.outcome, 'setup-failed');
  assert.notDeepEqual(after.lastResult, a.lastResult);
  assert.deepEqual(h.state.get(groupB), b);
});
