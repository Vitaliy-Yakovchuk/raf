import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileTestRunResources,
  runResourceReservedTestRun,
  type ResourceReservedTestRunPorts,
  type TestRunResourceClaim,
  type TestRunResourcePreparation,
  type TestRunResourceRequest,
  type TestRunTreeObservation,
} from '../src/test-run-reservations.ts';
import type { ResourceEstimateResolution } from '../src/resource-estimates.ts';
import type {
  ChildExit, RunnerEvent, TestId, TestRunCommand, TestRunConfig, TestRunContext,
  TestRunEnvironment, TestRunGroup, TestRunGroupKey, TestRunRequest, UnitTestPolicy,
} from '../src/test-runs.ts';

const file = 'test/test-run-reservations.test.ts';
const selected: TestId = { file, name: 'selected reservation behavior' };
const oldRed: TestId = { file, name: 'previous failure' };
const policy: UnitTestPolicy = { timeoutMs: 1000, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 };
const estimate: ResourceEstimateResolution = {
  status: 'KNOWN', reservation: { ramBytes: 100, diskBytes: { volume: 200 } },
  sources: ['conf/test-runs.json#/projects/raf/profiles/node/resourceEstimate'], reason: null, confPointer: null,
};
const context: TestRunContext = {
  cwd: '/qa/workspace', workspace: '/qa/workspace', projectWorkspaces: { raf: ['/qa/workspace'] },
  agentPhases: ['red', 'implement', 'qa', 'hotfix', 'test-scaffold'],
  activeChanges: ['fix-raf-load-admission'], agentId: 'fixture', sha: 'a'.repeat(40),
  home: '/qa/home-a', statePath: '/qa/home-a/state.sqlite', tmpPath: '/qa/home-a/tmp', operationalHome: '/working/home',
};
const hints = { refusal: 'refusal', setup: 'setup', assertions: 'assertions', timeout: 'timeout', interruption: 'interruption' };
const config: TestRunConfig = {
  phases: Object.fromEntries(context.agentPhases.map(phase => [phase, {
    allowed: phase !== 'test-scaffold', purpose: phase === 'red' ? 'initial-red' : 'verification', hints,
  }])),
  hints, diagnostics: {
    maxEntries: 64, maxMessageBytes: 4096, maxStackFrames: 16, maxStackBytes: 8192,
    maxTotalBytes: 65536, maxProtocolLineBytes: 65536, maxStderrBytes: 8192, redactionPatterns: [],
  },
  temporaryArtifacts: { root: '/tmp', minimumNestedSocketPathBytes: 80 },
  projects: { raf: { profiles: { node: {
    cwd: '.', executable: 'node', argv: ['./scripts/test-run-node.ts'],
    unitFiles: [file, 'test/unrelated-fixture.test.ts'], exactIds: 'node-test-name', resultAdapter: 'node-test-events',
    environment: { isolatedHome: true, stateOrigin: true }, checks: [],
  } }, groups: { 'fix-raf-load-admission/test-reservations': { profileId: 'node', files: [file] } } } },
};
const request: TestRunRequest = { project: 'raf', phase: 'red', group: 'fix-raf-load-admission/test-reservations', files: [file] };
const key = (value: TestRunGroupKey): string => JSON.stringify([value.project, value.workspace, value.group]);
const sameClaim = (a: TestRunResourceClaim, b: TestRunResourceClaim): boolean =>
  a.testRunId === b.testRunId && a.fence === b.fence && a.machineId === b.machineId;
const copy = <T>(value: T): T => structuredClone(value);

function latch<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function machine() {
  const claims = new Map<string, TestRunResourceClaim>();
  const committed = new Set<string>();
  const observations = new Map<string, TestRunTreeObservation>();
  const calls: { operation: string; claim?: TestRunResourceClaim; request?: TestRunResourceRequest; value?: unknown }[] = [];
  let occupiedByAgent = false;
  let refusal: 'unavailable' | 'unknown' | null = null;
  let prepareFailure = false;
  let commitFailure = false;
  let staleCommit = false;
  let current = true;
  let prepareHook: (() => void) | null = null;
  let snapshot: object = Object.freeze({ decisionToken: 'opaque-admission-from-central-manager' });
  const resources: ResourceReservedTestRunPorts['resources'] = {
    async estimateProfile(project, profileId) { calls.push({ operation: 'estimate', value: [project, profileId] }); return copy(estimate); },
    async prepare(input): Promise<TestRunResourcePreparation> {
      calls.push({ operation: 'prepare', request: copy(input) });
      prepareHook?.();
      if (prepareFailure) throw new Error('prepare storage unavailable');
      if (refusal || occupiedByAgent || claims.size) return {
        status: 'refused', claim: null, admission: snapshot, nextAction: refusal === 'unknown' ? 'fix-setup' : 'retry',
      };
      const claim: TestRunResourceClaim = {
        machineId: 'machine', testRunId: input.testRunId, fence: `fence-${input.testRunId}`,
        groupKey: copy(input.groupKey), deadlineMs: input.deadlineMs, processIdentity: null,
      };
      claims.set(claim.testRunId, copy(claim));
      return { status: 'prepared', claim, admission: snapshot };
    },
    async commit(claim) {
      calls.push({ operation: 'commit', claim: copy(claim) });
      if (commitFailure) throw new Error('commit storage unavailable');
      const stored = claims.get(claim.testRunId);
      if (staleCommit || !stored || !sameClaim(stored, claim)) return false;
      committed.add(claim.testRunId); return true;
    },
    async current(claim) {
      calls.push({ operation: 'current', claim: copy(claim) });
      return current && committed.has(claim.testRunId) && !!claims.get(claim.testRunId) && sameClaim(claims.get(claim.testRunId)!, claim);
    },
    async bindProcess(claim, identity) {
      calls.push({ operation: 'bind', claim: copy(claim), value: identity });
      if (claims.has(claim.testRunId) && sameClaim(claims.get(claim.testRunId)!, claim)) claims.get(claim.testRunId)!.processIdentity = identity;
    },
    async observeTree(claim) {
      calls.push({ operation: 'observe', claim: copy(claim) });
      return copy(observations.get(claim.testRunId) ?? { state: 'dead', processIdentity: claim.processIdentity, consumed: null });
    },
    async accountUsage(claim, consumed) { calls.push({ operation: 'usage', claim: copy(claim), value: copy(consumed) }); },
    async release(claim) {
      calls.push({ operation: 'release', claim: copy(claim) });
      const stored = claims.get(claim.testRunId);
      if (!stored || !sameClaim(stored, claim)) return false;
      claims.delete(claim.testRunId); committed.delete(claim.testRunId); return true;
    },
    async list(machineId) { return [...claims.values()].filter(claim => claim.machineId === machineId).map(copy); },
  };
  return {
    resources, claims, committed, observations, calls,
    setAgent(value: boolean) { occupiedByAgent = value; },
    setRefusal(value: typeof refusal) { refusal = value; },
    setSnapshot(value: object) { snapshot = value; },
    failPrepare() { prepareFailure = true; }, failCommit() { commitFailure = true; },
    staleCommit() { staleCommit = true; }, expireCommit() { current = false; },
    onPrepare(hook: () => void) { prepareHook = hook; },
    acquireAgent(): boolean { if (claims.size || occupiedByAgent) return false; occupiedByAgent = true; return true; },
  };
}

function fixture(shared = machine(), qa = context) {
  const groups = new Map<string, TestRunGroup>();
  const spawned: TestRunCommand[] = [];
  const timeline: string[] = [];
  const deadlines: number[] = [];
  const cleanupCalls: { deadline: number; reason: string }[] = [];
  let now = 100;
  let serial = 0;
  let spawnFailure = false;
  let groupFailure = false;
  let interrupt: ((signal: string) => void) | null = null;
  let deadlineCallback: (() => void) | null = null;
  let waiting: ReturnType<typeof latch<ChildExit>> | null = null;
  let cleanup = { complete: true, remainingPids: [] as number[] };
  const started = latch<void>();
  const environment: TestRunEnvironment = {
    canonicalWorkspace: qa.workspace, canonicalCwd: qa.cwd, gitIdentityMatches: true,
    runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true, resultAdapterAvailable: true,
    artifactsWritable: true, treeControlSupported: true, isolatedHome: true, stateOriginAllowed: true,
    stateAliasesOperational: false, tmpAliasesOperational: false, inheritedOperationalChannel: false,
    unitFiles: [...config.projects.raf.profiles.node.unitFiles],
    files: Object.fromEntries(config.projects.raf.profiles.node.unitFiles.map(name => [name, { kind: 'file', realpath: `${qa.workspace}/${name}`, unit: true }])),
  };
  const ports: ResourceReservedTestRunPorts = {
    machineId: 'machine', resources: shared.resources,
    preflight: async () => { timeline.push('preflight'); return environment; },
    newRunId: () => `${qa.agentId}-${++serial}`,
    state: { async transaction(operation) { return operation({
      get: groupKey => copy(groups.get(key(groupKey)) ?? null),
      list: (project, workspace) => [...groups.values()].filter(group => group.key.project === project && group.key.workspace === workspace).map(copy),
      put: group => { if (groupFailure && group.inFlight) throw new Error('group store failure'); groups.set(key(group.key), copy(group)); },
      delete: groupKey => { groups.delete(key(groupKey)); },
    }); } },
    clock: {
      now: () => now,
      schedule(deadline, callback) { deadlines.push(deadline); deadlineCallback = callback; return () => { deadlineCallback = null; }; },
    },
    subscribeInterruption(callback) { interrupt = callback; return () => { interrupt = null; }; },
    async spawn(command, onEvent) {
      timeline.push('spawn');
      assert.equal(shared.committed.size, 1, 'spawn requires a committed resource claim');
      const owner = [...shared.claims.values()][0];
      const group = groups.get(key(owner.groupKey));
      assert.equal(group?.inFlight?.runId, owner.testRunId, 'spawn requires matching group and resource claims');
      if (spawnFailure) throw new Error('runner executable unavailable');
      spawned.push(copy(command)); started.resolve();
      const events: RunnerEvent[] = [{ kind: 'discovered', test: selected }, { kind: 'passed', test: selected }, { kind: 'complete', expected: [selected] }];
      if (!waiting) events.forEach(onEvent);
      return {
        identity: `tree-${owner.testRunId}`,
        async wait() { return waiting ? waiting.promise : { exitCode: 0, signal: null, stderr: '' }; },
        async cleanup(deadline, reason) {
          cleanupCalls.push({ deadline, reason });
          waiting?.resolve({ exitCode: null, signal: reason === 'interruption' ? 'SIGTERM' : 'SIGKILL', stderr: '' });
          return copy(cleanup);
        },
      };
    },
    async reconcile() { return { alive: false, deadlineReached: now >= 1100, cleanup: copy(cleanup) }; },
  };
  return {
    ports, groups, shared, spawned, timeline, deadlines, cleanupCalls, environment, started: started.promise,
    run: (changes: Partial<TestRunRequest> = {}) => runResourceReservedTestRun({ ...request, ...changes }, config, policy, qa, ports),
    group: () => groups.get(key({ project: request.project, workspace: qa.workspace, group: request.group })),
    advance(ms: number) { now += ms; }, now: () => now,
    hold() { waiting = latch<ChildExit>(); },
    finish() { waiting?.resolve({ exitCode: 0, signal: null, stderr: '' }); },
    signal() { assert.ok(interrupt); interrupt('SIGTERM'); },
    deadline() { now = 1100; assert.ok(deadlineCallback); deadlineCallback(); },
    failSpawn() { spawnFailure = true; }, failGroup() { groupFailure = true; },
    setCleanup(value: typeof cleanup) { cleanup = value; },
    seed(state: TestRunGroup['state'] = 'optimize', timeoutCount = 1) {
      const group: TestRunGroup = {
        key: { project: request.project, workspace: qa.workspace, group: request.group }, state, timeoutCount,
        selection: { files: [file], testIds: [] }, knownRed: [oldRed], unexecuted: [selected], inFlight: null, lastResult: null,
      };
      groups.set(key(group.key), copy(group)); return copy(group);
    },
  };
}

for (const phase of ['red', 'implement', 'qa', 'hotfix']) {
  test(`test-reservations maps ${phase} to the configured admission tier`, async () => {
    const f = fixture();
    const result = await f.run({ phase });
    const prepare = f.shared.calls.find(call => call.operation === 'prepare')!.request!;
    assert.equal(prepare.requestedTier, phase === 'hotfix' ? 'hotfix' : 'normal');
    assert.deepEqual(prepare.estimate, estimate);
    assert.deepEqual(f.shared.calls.find(call => call.operation === 'estimate')!.value, ['raf', 'node']);
    assert.equal(result.outcome, 'passed');
    assert.equal(f.spawned.length, 1);
  });
}

for (const refusal of ['unavailable', 'unknown'] as const) {
  for (const existing of [false, true]) {
    test(`test-reservations ${refusal} before spawn preserves ${existing ? 'existing' : 'new'} aggregate`, async () => {
      const f = fixture();
      const before = existing ? f.seed() : null;
      const snapshot = Object.freeze({ opaque: refusal, nested: { token: 'same-decision' } });
      f.shared.setSnapshot(snapshot); f.shared.setRefusal(refusal);
      const result = await f.run();
      assert.equal(result.outcome, 'refused');
      assert.deepEqual(result.failureKinds, ['refusal']);
      assert.equal(result.errorCode, 'RESOURCE_UNAVAILABLE');
      assert.deepEqual(result.admission, snapshot);
      assert.equal(result.exitCode, null); assert.equal(result.timedOut, false);
      assert.equal(result.nextAction, refusal === 'unknown' ? 'fix-setup' : 'retry');
      assert.equal(result.timeoutCount, before?.timeoutCount ?? 0);
      assert.deepEqual(result.knownRed, before?.knownRed ?? []);
      assert.equal(result.groupState, before?.state ?? 'idle');
      assert.deepEqual(result.selection.files, [file]);
      assert.ok(result.unexecuted.some(id => id.file === file));
      assert.deepEqual(result.passed, []);
      assert.deepEqual(f.group() ?? null, before);
      assert.equal(f.spawned.length, 0); assert.equal(f.shared.claims.size, 0);
      assert.equal(f.shared.calls.filter(call => call.operation === 'prepare').length, 1, 'no test queue or automatic retry');
    });
  }
}

test('test-reservations successful result preserves the central admission snapshot', async () => {
  const f = fixture();
  const snapshot = Object.freeze({ opaque: { decision: 'allowed', version: 'sentinel' } });
  f.shared.setSnapshot(snapshot);
  const result = await f.run();
  assert.deepEqual(result.admission, snapshot);
  assert.equal(result.outcome, 'passed');
  assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight, null);
});

for (const failure of ['phase', 'preflight'] as const) {
  test(`test-reservations ${failure} refusal does not reserve or fabricate admission`, async () => {
    const f = fixture();
    if (failure === 'preflight') f.environment.runtimeAvailable = false;
    const result = await f.run(failure === 'phase' ? { phase: 'test-scaffold' } : {});
    assert.equal(result.admission, null);
    assert.notEqual(result.outcome, 'passed');
    assert.equal(f.spawned.length, 0); assert.equal(f.shared.calls.length, 0);
  });
}

test('test-reservations GROUP_IN_FLIGHT remains separate from machine admission', async () => {
  const f = fixture(); const before = f.seed('running', 0);
  before.inFlight = { runId: 'other-run', deadlineMs: 1100, processIdentity: 'other-tree' };
  f.groups.set(key(before.key), copy(before));
  const result = await f.run();
  assert.equal(result.errorCode, 'GROUP_IN_FLIGHT');
  assert.equal(result.admission, null); assert.equal(f.spawned.length, 0);
  assert.equal(f.shared.claims.size, 0); assert.deepEqual(f.group(), before);
});

test('test-reservations different groups contend atomically for the same last slot', async () => {
  const f = fixture(); f.hold();
  const first = f.run(); await Promise.race([f.started, first]);
  const second = await f.run({ group: 'fix-raf-load-admission/another-group' });
  assert.equal(second.outcome, 'refused'); assert.equal(f.spawned.length, 1);
  assert.equal(f.shared.claims.size, 1);
  f.finish(); await first;
  assert.equal(f.shared.claims.size, 0);
});

test('test-reservations agent reservation blocks a test and is never released by it', async () => {
  const f = fixture(); f.shared.setAgent(true);
  const result = await f.run();
  assert.equal(result.outcome, 'refused'); assert.equal(f.spawned.length, 0);
  assert.equal(f.shared.calls.filter(call => call.operation === 'release').length, 0);
  assert.equal(f.shared.acquireAgent(), false);
});

test('test-reservations test reservation blocks an agent until the tree is dead', async () => {
  const f = fixture(); f.hold();
  const running = f.run(); await Promise.race([f.started, running]);
  assert.equal(f.shared.acquireAgent(), false);
  f.finish(); await running;
  assert.equal(f.shared.acquireAgent(), true);
});

for (const failure of ['prepare', 'group', 'commit', 'stale-commit', 'expired-commit'] as const) {
  test(`test-reservations ${failure} failure cannot spawn with only one valid claim`, async () => {
    const f = fixture(); const before = f.seed();
    if (failure === 'prepare') f.shared.failPrepare();
    if (failure === 'group') f.failGroup();
    if (failure === 'commit') f.shared.failCommit();
    if (failure === 'stale-commit') f.shared.staleCommit();
    if (failure === 'expired-commit') f.shared.expireCommit();
    const result = await f.run();
    assert.equal(f.spawned.length, 0); assert.notEqual(result.outcome, 'passed');
    assert.equal(f.shared.claims.size, 0, 'compensate only the unstarted own claim');
    assert.equal(f.group()?.inFlight ?? null, null);
    assert.equal(f.group()?.timeoutCount, before.timeoutCount);
    assert.deepEqual(f.group()?.knownRed, before.knownRed);
    for (const release of f.shared.calls.filter(call => call.operation === 'release')) {
      assert.equal(release.claim!.testRunId, result.runId);
    }
  });
}

test('test-reservations spawn failure releases both claims without assertions red or timeout', async () => {
  const f = fixture(); const before = f.seed(); f.failSpawn();
  const result = await f.run();
  assert.equal(result.outcome, 'setup-failed'); assert.ok(result.failureKinds.includes('setup'));
  assert.equal(result.failureKinds.includes('assertions'), false);
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, null);
  assert.equal(result.timeoutCount, before.timeoutCount); assert.deepEqual(result.knownRed, before.knownRed);
  assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight, null);
});

for (const ending of ['signal', 'deadline'] as const) {
  test(`test-reservations ${ending} cleans the tree within the original deadline`, async () => {
    const f = fixture(); f.hold();
    f.shared.onPrepare(() => f.advance(200));
    const running = f.run(); await Promise.race([f.started, running]);
    if (ending === 'signal') f.signal(); else f.deadline();
    const result = await running;
    assert.equal(result.outcome, ending === 'signal' ? 'interrupted' : 'timed-out');
    assert.equal(result.timedOut, ending === 'deadline');
    assert.equal(result.timeoutCount, ending === 'deadline' ? 1 : 0);
    assert.ok(f.deadlines.length > 0);
    assert.ok(f.deadlines.every(deadline => deadline === 1100));
    assert.ok(f.cleanupCalls.length > 0);
    assert.ok(f.cleanupCalls.every(call => call.deadline === 1100));
    assert.equal(f.shared.calls.find(call => call.operation === 'prepare')!.request!.deadlineMs, 1100);
    assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight, null);
  });
}

test('test-reservations admission that exhausts the deadline cannot start a fresh budget', async () => {
  const f = fixture(); f.shared.onPrepare(() => f.advance(policy.timeoutMs));
  const result = await f.run();
  assert.equal(f.spawned.length, 0); assert.equal(result.timedOut, true);
  assert.equal(result.outcome, 'timed-out'); assert.equal(result.timeoutCount, 1);
  assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight ?? null, null);
});

for (const state of ['alive', 'unknown'] as const) {
  test(`test-reservations ${state} descendant retains capacity until verified reconciliation`, async () => {
    const f = fixture();
    f.setCleanup({ complete: false, remainingPids: [77] });
    f.shared.onPrepare(() => {
      f.shared.observations.set('fixture-1', { state, processIdentity: 'tree-fixture-1', consumed: null });
    });
    const result = await f.run();
    assert.notEqual(result.outcome, 'passed'); assert.equal(result.nextAction, 'reconcile');
    assert.equal(f.shared.claims.size, 1); assert.ok(f.group()?.inFlight);
    assert.equal(f.shared.acquireAgent(), false);
    const retained = await reconcileTestRunResources(context, policy, f.ports);
    assert.equal(retained.retained.length, 1); assert.equal(retained.released.length, 0);
    assert.equal(f.shared.claims.size, 1);
    f.shared.observations.set(result.runId, { state: 'dead', processIdentity: 'tree-fixture-1', consumed: null });
    f.setCleanup({ complete: true, remainingPids: [] });
    const reconciled = await reconcileTestRunResources(context, policy, f.ports);
    assert.equal(reconciled.released.length, 1); assert.equal(reconciled.retained.length, 0);
    assert.equal(f.shared.claims.size, 0); assert.equal(f.group()?.inFlight, null);
    assert.equal(f.shared.acquireAgent(), true);
  });
}

function orphan(f: ReturnType<typeof fixture>, changes: Partial<TestRunResourceClaim> = {}): TestRunResourceClaim {
  const claim: TestRunResourceClaim = {
    machineId: 'machine', testRunId: 'abandoned', fence: 'old-fence',
    groupKey: { project: 'raf', workspace: context.workspace, group: request.group },
    deadlineMs: 1100, processIdentity: null, ...changes,
  };
  f.shared.claims.set(claim.testRunId, copy(claim));
  return claim;
}

test('test-reservations reconciliation compensates abandoned prepared resource claim', async () => {
  const f = fixture(); const claim = orphan(f);
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(result.released, [claim]); assert.equal(f.shared.claims.size, 0);
  assert.equal(f.spawned.length, 0);
});

test('test-reservations reconciliation compensates abandoned group-only claim', async () => {
  const f = fixture(); const group = f.seed('running', 0);
  group.inFlight = { runId: 'abandoned', deadlineMs: 1100, processIdentity: null };
  f.groups.set(key(group.key), group);
  await reconcileTestRunResources(context, policy, f.ports);
  assert.equal(f.group()?.inFlight, null); assert.equal(f.group()?.timeoutCount, 0);
  assert.deepEqual(f.group()?.knownRed, [oldRed]); assert.equal(f.spawned.length, 0);
});

test('test-reservations reconciliation cannot clear a newer group owner', async () => {
  const f = fixture(); const claim = orphan(f);
  const group = f.seed('running', 0);
  group.inFlight = { runId: 'new-owner', deadlineMs: 2100, processIdentity: 'new-tree' };
  f.groups.set(key(group.key), copy(group));
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(result.released, [claim]); assert.deepEqual(f.group(), group);
  const releases = f.shared.calls.filter(call => call.operation === 'release');
  assert.ok(releases.every(call => call.claim?.fence === 'old-fence'));
});

test('test-reservations unverified tree identity cannot release a recycled PID', async () => {
  const f = fixture(); const claim = orphan(f, { processIdentity: 'pid-77-start-old' });
  f.shared.observations.set(claim.testRunId, { state: 'unknown', processIdentity: 'pid-77-start-new', consumed: null });
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(result.retained, [claim]); assert.equal(result.released.length, 0);
  assert.equal(f.shared.claims.size, 1);
});

test('test-reservations live-tree observation reports consumption to the central manager', async () => {
  const f = fixture(); const claim = orphan(f, { processIdentity: 'live-tree' });
  const consumed = { ramBytes: 60, diskBytes: { volume: 70 } };
  f.shared.observations.set(claim.testRunId, { state: 'alive', processIdentity: 'live-tree', consumed });
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(result.retained, [claim]);
  assert.deepEqual(f.shared.calls.filter(call => call.operation === 'usage').map(call => call.value), [consumed]);
  assert.equal(f.shared.calls.some(call => call.operation === 'release'), false);
});

test('test-reservations QA homes share machine capacity while runner environment stays isolated', async () => {
  const shared = machine();
  const a = fixture(shared); a.hold();
  const qaB = { ...context, agentId: 'fixture-b', home: '/qa/home-b', statePath: '/qa/home-b/state.sqlite', tmpPath: '/qa/home-b/tmp' };
  const b = fixture(shared, qaB);
  const first = a.run(); await Promise.race([a.started, first]);
  const second = await b.run({ group: 'fix-raf-load-admission/qa-b' });
  assert.equal(second.outcome, 'refused'); assert.equal(b.spawned.length, 0);
  assert.equal(shared.claims.size, 1);
  const command = a.spawned[0];
  assert.equal(command.environment.HOME, context.home);
  assert.equal(command.environment.statePath, context.statePath);
  assert.equal(command.environment.tmpPath, context.tmpPath);
  assert.equal(JSON.stringify(command).includes(context.operationalHome), false);
  assert.ok(Object.keys(command.environment).every(name => ['HOME', 'statePath', 'tmpPath', 'testIds', 'TMPDIR'].includes(name)));
  a.finish(); await first;
  assert.equal(shared.claims.size, 0);
});

test('test-reservations simultaneous groups cannot both spawn against one machine slot', async () => {
  const shared = machine();
  const a = fixture(shared); a.hold();
  const b = fixture(shared, { ...context, agentId: 'concurrent-b' }); b.hold();
  const first = a.run();
  const second = b.run({ group: 'fix-raf-load-admission/concurrent-b' });
  const refused = await Promise.race([first, second]);
  assert.equal(refused.outcome, 'refused');
  await Promise.race([a.started, b.started, Promise.all([first, second]).then(() => assert.fail('both invocations ended before a runner started'))]);
  assert.equal(shared.claims.size, 1);
  assert.equal(a.spawned.length + b.spawned.length, 1);
  a.finish(); b.finish();
  await Promise.all([first, second]);
  assert.equal(shared.claims.size, 0);
});

test('test-reservations reconciliation release is fenced against a replacement resource owner', async () => {
  const f = fixture(); const abandoned = orphan(f);
  const replacement = { ...abandoned, fence: 'replacement-fence', processIdentity: 'replacement-tree' };
  const observe = f.ports.resources.observeTree;
  f.ports.resources.observeTree = async claim => {
    const observation = await observe(claim);
    f.shared.claims.set(claim.testRunId, copy(replacement));
    return observation;
  };
  const result = await reconcileTestRunResources(context, policy, f.ports);
  assert.deepEqual(f.shared.claims.get(abandoned.testRunId), replacement);
  assert.equal(result.released.length, 0, 'a failed fenced release is not reported as successful cleanup');
  assert.ok(f.shared.calls.filter(call => call.operation === 'release').every(call => call.claim?.fence === abandoned.fence));
});
