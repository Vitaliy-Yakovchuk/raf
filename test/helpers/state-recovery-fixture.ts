import type { TestRunResult } from '../../src/test-runs.ts';
import type {
  RecoveryGroup, RecoveryObservation, RecoveryReply, RecoveryStatePort,
  StateOpenPorts, StateRecoveryPorts, StateRecoveryResult,
} from '../../src/test-run-state-recovery.ts';

export const key = { project: 'raf', workspace: '/qa/raf-develop', group: 'add-raf-test-run/state-open-recovery' };
export const originalRunId = '2e43aacb-f6ee-4d07-99b2-e1b62ee131c9';
export const otherRunId = 'bb217c76-2222-4333-8444-555555555555';
export const processIdentity = JSON.stringify({ pid: 42001, start: '73', boot: 'qa-boot' });
export const controlPath = '/qa/control/.raf/state.sqlite';
export const unitPath = '/qa/unit/.raf/state.sqlite';
export const red = [{ file: 'test/fixture.test.ts', name: 'known red' }];
export const remainder = [{ file: 'test/fixture.test.ts', name: 'not executed' }];
export const unknown = [{ file: 'test/fixture.test.ts', name: 'unknown' }];
export const selection = { files: ['test/fixture.test.ts'], testIds: [] };
export const command = {
  executable: '/qa/node', argv: ['./scripts/test-run-node.ts', 'test/fixture.test.ts'],
  cwd: key.workspace, shell: false as const,
  environment: { HOME: '/qa/unit', statePath: unitPath, tmpPath: '/qa/tmp' },
};
export function result(overrides: Partial<StateRecoveryResult> = {}): StateRecoveryResult {
  return {
    outcome: 'assertions-failed', failureKinds: ['assertions'], passed: [], knownRed: red,
    unexecuted: remainder, unknown, removed: [], diagnostics: [],
    diagnosticSummary: { totalEntries: 0, retainedEntries: 0, omittedEntries: 0, truncated: false, redacted: false },
    environmentSummary: {
      executable: '/qa/node', runtimeVersion: 'qa', adapter: 'node-test-events', isolation: 'qa',
      configurationFingerprints: { flow: 'f', testRuns: 't', projects: 'p' }, tmpPathBytes: 7, privateRunTmp: true,
    },
    runId: originalRunId, project: key.project, workspace: key.workspace, group: key.group,
    phase: 'red', callerPhase: 'main', profileId: 'node', selection, command,
    testKind: 'unit', timeoutPolicy: { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: 10000 },
    startedAt: new Date(1000).toISOString(), durationMs: 1000, exitCode: 1, signal: null,
    timedOut: false, cleanup: { complete: true, remainingPids: [] },
    stateAccess: null, groupSnapshot: 'loaded', groupState: 'complete', timeoutCount: 1,
    nextAction: 'implement', hintIds: [], hints: [], evidence: ['original evidence'], ...overrides,
  };
}
export function legacyResult(): TestRunResult {
  const r = result();
  return { ...r, groupState: 'running', timeoutCount: 1 };
}
export function group(overrides: Partial<RecoveryGroup> = {}): RecoveryGroup {
  return {
    key, testKind: 'unit', profileId: 'node', state: 'running', timeoutCount: 1,
    selection, knownRed: red, unexecuted: remainder, unknown,
    inFlight: {
      runId: originalRunId, processIdentity, ownerIdentity: 'existing-wrapper-identity',
      deadlineMs: 11000, startedAtMs: 1000, startedAt: new Date(1000).toISOString(),
      phase: 'red', callerPhase: 'main', selection, command, testKind: 'unit',
      timeoutPolicy: { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: 10000 },
      finishedAtMs: null, deadlineObservedAtMs: null,
    },
    lastResult: null, delivery: null, ...overrides,
  };
}
export function fixture(initial: RecoveryGroup | null = group()) {
  let stored = structuredClone(initial);
  let writes = 0;
  let tail = Promise.resolve();
  const calls = { opens: [] as string[], guards: [] as string[], cleanup: [] as string[], release: [] as string[], returned: [] as StateRecoveryResult[], messages: [] as RecoveryReply[] };
  const state: RecoveryStatePort = {
    async transaction(operation) {
      const before = tail;
      let unlock!: () => void;
      tail = new Promise<void>(resolve => { unlock = resolve; });
      await before;
      let draft = structuredClone(stored);
      try {
        const answer = operation({
          get(k) { return JSON.stringify(k) === JSON.stringify(key) ? structuredClone(draft) : null; },
          list() { return draft ? [structuredClone(draft)] : []; },
          put(g) { draft = structuredClone(g); writes++; },
          delete() { draft = null; writes++; },
        });
        stored = draft;
        return answer;
      } finally { unlock(); }
    },
  };
  const observation: RecoveryObservation = { owner: 'lost', tree: 'dead', identity: processIdentity, finishedAtMs: 5000, deadlineObservedAtMs: null, interrupted: false };
  const ports: StateRecoveryPorts = {
    state,
    async observe() { return structuredClone(observation); },
    async cleanup(run) { calls.cleanup.push(run.runId); return { complete: true, remainingPids: [] }; },
    async release(runId) { calls.release.push(runId); return true; },
    async returnResult(r) { calls.returned.push(structuredClone(r)); return { returned: false }; },
    async messageMain(reply) { calls.messages.push(structuredClone(reply)); return { accepted: false, receiptId: null, forwarded: false }; },
  };
  const open: StateOpenPorts = {
    async guard(store, path) { calls.guards.push(`${store}:${path}`); },
    async open(store, path) { calls.opens.push(`${store}:${path}`); return state; },
    limits: { maxEntries: 4, maxMessageBytes: 128, maxStackFrames: 2, maxStackBytes: 128, maxTotalBytes: 1024, maxStderrBytes: 128, redactionPatterns: ['CANARY_[A-Z_]+'] },
  };
  return { ports, open, observation, calls, get stored() { return structuredClone(stored); }, get writes() { return writes; }, replace(value: RecoveryGroup | null) { stored = structuredClone(value); } };
}

export function unitEntryFixture(initial: RecoveryGroup | null = null) {
  const f = fixture(initial);
  const otherFile = 'test/unrelated.test.ts';
  const ids = [{ file: selection.files[0], name: 'green' }];
  const phases = Object.fromEntries(['red', 'qa'].map(phase => [phase, {
    allowed: true, purpose: phase === 'red' ? 'initial-red' as const : 'verification' as const,
    hints: { refusal: 'refusal', setup: 'setup', assertions: 'assertions', timeout: 'timeout', interruption: 'interruption' },
  }]));
  const config: import('../../src/test-runs.ts').TestRunConfig = {
    diagnostics: f.open.limits,
    temporaryArtifacts: { root: '/qa/tmp', minimumNestedSocketPathBytes: 80 }, phases,
    hints: { refusal: 'Fix selection', setup: 'Fix setup', assertions: 'Fix assertions', timeout: 'Reconcile', interruption: 'Reconcile' },
    projects: { raf: {
      profiles: { node: { cwd: '.', executable: '/qa/node', argv: ['./scripts/test-run-node.ts'], unitFiles: [selection.files[0], otherFile], exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [] } },
      groups: { [key.group]: { profileId: 'node', files: selection.files } },
    } },
  };
  const context: import('../../src/test-runs.ts').TestRunContext = {
    cwd: key.workspace, workspace: key.workspace, projectWorkspaces: { raf: [key.workspace] },
    agentPhases: ['red', 'qa'], activeChanges: ['add-raf-test-run'], agentId: 'qa-caller', sha: 'f'.repeat(40),
    home: '/qa/unit', statePath: unitPath, tmpPath: '/qa/tmp', operationalHome: '/qa/operational', callerPhase: 'qa',
  };
  let spawns = 0;
  const ports: import('../../src/test-runs.ts').TestRunPorts = {
    state: f.ports.state as unknown as import('../../src/test-runs.ts').TestRunStatePort,
    clock: { now: () => 6000, schedule: () => () => undefined },
    newRunId: () => otherRunId,
    async preflight() { return {
      canonicalWorkspace: key.workspace, canonicalCwd: key.workspace, 
      runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true, resultAdapterAvailable: true,
      artifactsWritable: true, treeControlSupported: true, isolatedHome: true, stateOriginAllowed: true,
      stateAliasesOperational: false, tmpAliasesOperational: false, inheritedOperationalChannel: false,
      unitFiles: [selection.files[0], otherFile], files: Object.fromEntries([selection.files[0], otherFile].map(file => [file, { kind: 'file' as const, realpath: key.workspace + '/' + file, unit: true }])),
    }; },
    async spawn(_command, onEvent) {
      spawns++;
      onEvent({ kind: 'discovered', test: ids[0] });
      onEvent({ kind: 'passed', test: ids[0] });
      onEvent({ kind: 'complete', expected: ids });
      return { identity: processIdentity, async wait() { return { exitCode: 0, signal: null, stderr: '' }; }, async cleanup() { return { complete: true, remainingPids: [] }; } };
    },
    subscribeInterruption: () => () => undefined,
    async reconcile() { return { alive: false, deadlineReached: false, cleanup: { complete: true, remainingPids: [] } }; },
  };
  return { f, config, context, ports, get spawns() { return spawns; }, request: { project: key.project, group: key.group, phase: 'qa', files: selection.files }, policy: { timeoutMs: 10000, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 } };
}
