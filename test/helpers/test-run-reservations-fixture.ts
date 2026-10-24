import assert from 'node:assert/strict';
import {
  reconcileTestRunResources,
  runResourceReservedTestRun,
  type ResourceReservedTestRunPorts,
  type TestRunResourceClaim,
  type TestRunResourcePreparation,
  type TestRunResourceRequest,
  type TestRunTreeObservation,
} from '../../src/test-run-reservations.ts';
import type { ResourceEstimateResolution } from '../../src/resource-estimates.ts';
import type {
  ChildExit, RunnerEvent, TestId, TestRunCommand, TestRunConfig, TestRunContext,
  TestRunEnvironment, TestRunGroup, TestRunGroupKey, TestRunRequest, UnitTestPolicy,
} from '../../src/test-runs.ts';

export const file = 'test/test-run-reservations.test.ts';
export const selected: TestId = { file, name: 'selected reservation behavior' };
export const oldRed: TestId = { file, name: 'previous failure' };
export const policy: UnitTestPolicy = { timeoutMs: 1000, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 };
export const estimate: ResourceEstimateResolution = {
  status: 'KNOWN', reservation: { ramBytes: 100, diskBytes: { volume: 200 } },
  sources: ['conf/test-runs.json#/projects/raf/profiles/node/resourceEstimate'], reason: null, confPointer: null,
};
export const context: TestRunContext = {
  cwd: '/qa/workspace', workspace: '/qa/workspace', projectWorkspaces: { raf: ['/qa/workspace'] },
  agentPhases: ['red', 'implement', 'qa', 'hotfix', 'test-scaffold'],
  activeChanges: ['fix-raf-load-admission'], agentId: 'fixture', sha: 'a'.repeat(40),
  home: '/qa/home-a', statePath: '/qa/home-a/state.sqlite', tmpPath: '/qa/home-a/tmp', operationalHome: '/working/home',
};
const hints = { refusal: 'refusal', setup: 'setup', assertions: 'assertions', timeout: 'timeout', interruption: 'interruption' };
export const config: TestRunConfig = {
  phases: Object.fromEntries(context.agentPhases.map(phase => [phase, {
    allowed: phase !== 'test-scaffold',
    purpose: phase === 'test-scaffold' ? 'none' : phase === 'red' ? 'initial-red' : 'verification', hints,
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
export const request: TestRunRequest = { project: 'raf', phase: 'red', group: 'fix-raf-load-admission/test-reservations', files: [file] };
export const key = (value: TestRunGroupKey): string => JSON.stringify([value.project, value.workspace, value.group]);
const sameClaim = (a: TestRunResourceClaim, b: TestRunResourceClaim): boolean =>
  a.testRunId === b.testRunId && a.fence === b.fence && a.machineId === b.machineId;
export const copy = <T>(value: T): T => structuredClone(value);

function latch<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export function machine() {
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

export function fixture(shared = machine(), qa = context) {
  const testQueue = queueFixture();
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
  let finishEvents: (() => void) | null = null;
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
    resourceRoute: { branchPaths: { develop: qa.workspace, hotfix: '/qa/hotfix' } },
    queue: testQueue.port,
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
      if (waiting) finishEvents = () => events.forEach(onEvent);
      else events.forEach(onEvent);
      return {
        identity: `tree-${owner.testRunId}`,
        async wait() { return waiting ? waiting.promise : { exitCode: 0, signal: null, stderr: '' }; },
        async cleanup(deadline, reason) {
          cleanupCalls.push({ deadline, reason });
          finishEvents = null;
          waiting?.resolve({ exitCode: null, signal: reason === 'interruption' ? 'SIGTERM' : 'SIGKILL', stderr: '' });
          return copy(cleanup);
        },
      };
    },
    async reconcile() { return { alive: false, deadlineReached: now >= 1100, cleanup: copy(cleanup) }; },
  };
  return {
    ports, groups, shared, spawned, timeline, deadlines, cleanupCalls, environment, testQueue, started: started.promise,
    run: (changes: Partial<TestRunRequest> = {}) => runResourceReservedTestRun({ ...request, ...changes }, config, policy, qa, ports),
    group: () => groups.get(key({ project: request.project, workspace: qa.workspace, group: request.group })),
    advance(ms: number) { now += ms; }, now: () => now,
    hold() { waiting = latch<ChildExit>(); },
    finish() {
      const deliver = finishEvents; finishEvents = null;
      deliver?.();
      waiting?.resolve({ exitCode: 0, signal: null, stderr: '' });
    },
    signal() { assert.ok(interrupt); interrupt('SIGTERM'); },
    deadline() { assert.ok(deadlineCallback); now = deadlines.at(-1)!; deadlineCallback(); },
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


export function queueFixture() {
  const entered = latch<void>();
  const records: import('../../src/test-run-queue.ts').TestRunQueueRecord[] = [];
  const waits: { input: Parameters<import('../../src/test-run-queue.ts').TestRunQueuePort['waitForResources']>[0]; gate: ReturnType<typeof latch<import('../../src/resource-wait-protocol.ts').ResourceWaitCommandResult>> }[] = [];
  const transitions: { record: import('../../src/test-run-queue.ts').TestRunQueueRecord; phase: string }[] = [];
  const starts: { record: import('../../src/test-run-queue.ts').TestRunQueueRecord; identity: string }[] = [];
  const finishes: { record: import('../../src/test-run-queue.ts').TestRunQueueRecord; outcome: string; reason: string }[] = [];
  const stderr: string[] = [];
  let pending = false;
  const port: import('../../src/test-run-queue.ts').TestRunQueuePort = {
    async hasPending() { return pending; },
    async enqueue(input) {
      const record = { queueId: '00000000-0000-4000-8000-000000000082', requestId: `request-${input.testRunId}`, testRunId: input.testRunId, fence: `queue-${input.testRunId}` };
      records.push(record); return record;
    },
    async waitForResources(input) {
      const gate = latch<import('../../src/resource-wait-protocol.ts').ResourceWaitCommandResult>();
      const abort = () => gate.resolve({ kind: 'error', exitCode: 1, diagnostic: { reason: 'cancelled', details: 'waiting client interrupted', remediation: 'reconcile', received: null, expected: 'permit', completed: ['enqueue'], pending: ['permit'] } });
      waits.push({ input, gate });
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      entered.resolve();
      try { return await gate.promise; }
      finally { input.signal?.removeEventListener('abort', abort); }
    },
    async transition(record, phase) { transitions.push({ record, phase }); return true; },
    async started(record, identity) { starts.push({ record, identity }); return true; },
    async finish(record, outcome, reason) { finishes.push({ record, outcome, reason }); },
    writeStderr(line) { stderr.push(line); },
  };
  return {
    port, entered: entered.promise, records, waits, transitions, starts, finishes, stderr,
    setPending(value: boolean) { pending = value; },
    grant(index = 0) {
      const wait = waits[index];
      assert.ok(wait, 'a queue wait must exist before a permit');
      wait.gate.resolve({ kind: 'permit', exitCode: 0, reservation: false, permit: { requestId: `permit-${index}`, serviceEpoch: 'epoch', grantedAt: index } });
    },
    fail(index = 0) {
      waits[index].gate.resolve({ kind: 'error', exitCode: 1, diagnostic: { reason: 'delivery_unknown', details: 'permit delivery unconfirmed', remediation: 'reconcile', received: null, expected: 'permit', completed: ['enqueue'], pending: ['permit'] } });
    },
  };
}

export async function expectWaiting(f: ReturnType<typeof fixture>, running: ReturnType<ReturnType<typeof fixture>['run']>) {
  const first = await Promise.race([f.testQueue.entered.then(() => 'waiting'), running.then(() => 'completed')]);
  assert.equal(first, 'waiting', 'resource shortage must keep the same invocation waiting rather than return RESOURCE_UNAVAILABLE');
  assert.equal(f.spawned.length, 0);
}
