import { readFileSync } from 'node:fs';
import type {
  ChildExit, RunnerEvent, TestId, TestRunCommand, TestRunConfig, TestRunContext,
  TestRunEnvironment, TestRunGroup, TestRunGroupKey, TestRunPorts, TestRunRequest,
  TestRunTransaction, UnitTestPolicy,
} from '../../src/test-runs.ts';

const constants = JSON.parse(readFileSync(new URL('../../../conf/raf-constants.json', import.meta.url), 'utf8'));
export const policy: UnitTestPolicy = JSON.parse(readFileSync(new URL('../../../conf/flow.json', import.meta.url), 'utf8')).unitTests;
export const files = ['test/alpha.test.ts', 'test/beta.test.ts', 'test/gamma.test.ts', 'test/delta.test.ts'];
export const alpha: TestId = { file: files[0], name: 'literal a.* [x] (one)|two$' };
export const beta: TestId = { file: files[1], name: 'second behavior' };
export const gamma: TestId = { file: files[2], name: 'third behavior' };
export const key: TestRunGroupKey = { project: 'raf', workspace: '/work/raf-develop', group: 'add-raf-test-run/unit' };

export function fixtureConfig(): TestRunConfig {
  const phases = [...new Set([...constants.agentPhases.map((phase: { id: string }) => phase.id), 'red'])] as string[];
  const hints: TestRunConfig['hints'] = {};
  return {
    phases: Object.fromEntries(phases.map(phase => [phase, {
      allowed: ['red', 'implement', 'qa', 'hotfix', 'integration'].includes(phase),
      purpose: phase === 'red' ? 'initial-red' : ['implement', 'qa', 'hotfix', 'integration'].includes(phase) ? 'verification' : 'none',
      hints: Object.fromEntries(['refusal', 'setup', 'assertions', 'timeout', 'interruption'].map(kind => {
        const id = `${phase}-${kind}`;
        hints[id] = `fixture:${id}`;
        return [kind, id];
      })) as TestRunConfig['phases'][string]['hints'],
    }])),
    hints,
    diagnostics: {
      maxEntries: 64, maxMessageBytes: 4096, maxStackFrames: 16, maxStackBytes: 8192,
      maxTotalBytes: 65536, maxProtocolLineBytes: 65536, maxStderrBytes: 8192, redactionPatterns: [],
    },
    temporaryArtifacts: { root: '/tmp', minimumNestedSocketPathBytes: 80 },
    projects: { raf: {
      profiles: { node: {
        cwd: '.', executable: '/local/node', argv: ['--test'], unitFiles: [...files],
        exactIds: 'node-test-name', resultAdapter: 'node-test-events',
        environment: { isolatedHome: true, stateOrigin: true }, checks: ['runtime', 'dependencies', 'git', 'state'],
      } },
      groups: { 'add-raf-test-run/unit': { profileId: 'node', files: files.slice(0, 2) } },
    } },
  };
}

export function fixtureContext(): TestRunContext {
  return {
    cwd: key.workspace, workspace: key.workspace, projectWorkspaces: { raf: [key.workspace, '/work/raf-hotfix'] },
    agentPhases: [...new Set([...constants.agentPhases.map((phase: { id: string }) => phase.id), 'red'])] as string[],
    activeChanges: ['add-raf-test-run'], agentId: 'author', sha: 'sha-before', home: '/qa/home',
    statePath: '/qa/home/.raf/state.sqlite', tmpPath: '/qa/home/.raf/tmp', operationalHome: '/operational/home',
  };
}

export function fixtureEnvironment(): TestRunEnvironment {
  return {
    canonicalWorkspace: key.workspace, canonicalCwd: key.workspace, 
    runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true,
    resultAdapterAvailable: true, artifactsWritable: true, treeControlSupported: true,
    isolatedHome: true, stateOriginAllowed: true, stateAliasesOperational: false,
    tmpAliasesOperational: false, inheritedOperationalChannel: false, unitFiles: [...files],
    files: Object.fromEntries(files.map(file => [file, { kind: 'file', realpath: `${key.workspace}/${file}`, unit: true }])),
  };
}

export function fixtureRequest(overrides: Partial<TestRunRequest> = {}): TestRunRequest {
  return { project: 'raf', phase: 'red', group: key.group, files: files.slice(0, 2), ...overrides };
}

export function fixtureGroup(overrides: Partial<TestRunGroup> = {}): TestRunGroup {
  return {
    key: { ...key }, timeoutCount: 0, state: 'idle', selection: { files: files.slice(0, 2), testIds: [] },
    knownRed: [], unexecuted: [], inFlight: null, lastResult: null, ...overrides,
  };
}

export class ManualClock {
  time = 1_800_000_000_000;
  jobs = new Map<number, { deadline: number; callback: () => void }>();
  sequence = 0;
  now = (): number => this.time;
  schedule = (deadline: number, callback: () => void): (() => void) => {
    const id = ++this.sequence;
    this.jobs.set(id, { deadline, callback });
    return () => { this.jobs.delete(id); };
  };
  advance(milliseconds: number): void {
    const end = this.time + milliseconds;
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.deadline <= end).sort((a, b) => a[1].deadline - b[1].deadline)[0];
      if (!next) break;
      this.time = next[1].deadline;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
  }
}

export class MemoryState {
  records = new Map<string, TestRunGroup>();
  operations: string[] = [];
  inTransaction = false;
  transactionCount = 0;
  transaction = async <T>(operation: (transaction: TestRunTransaction) => T): Promise<T> => {
    this.transactionCount++;
    this.inTransaction = true;
    try {
      return operation({
        get: groupKey => { this.operations.push('get'); return structuredClone(this.records.get(JSON.stringify([groupKey.project, groupKey.workspace, groupKey.group])) ?? null); },
        list: (project, workspace) => { this.operations.push('list'); return structuredClone([...this.records.values()].filter(group => group.key.project === project && group.key.workspace === workspace)); },
        put: group => { this.operations.push('put'); this.records.set(JSON.stringify([group.key.project, group.key.workspace, group.key.group]), structuredClone(group)); },
        delete: groupKey => { this.operations.push('delete'); this.records.delete(JSON.stringify([groupKey.project, groupKey.workspace, groupKey.group])); },
      });
    } finally {
      this.inTransaction = false;
    }
  };
  seed(group: TestRunGroup): void { this.records.set(JSON.stringify([group.key.project, group.key.workspace, group.key.group]), structuredClone(group)); }
  get(groupKey: TestRunGroupKey = key): TestRunGroup | undefined { return this.records.get(JSON.stringify([groupKey.project, groupKey.workspace, groupKey.group])); }
}

export class RunHarness {
  config = fixtureConfig();
  context = fixtureContext();
  environment = fixtureEnvironment();
  clock = new ManualClock();
  state = new MemoryState();
  spawns: TestRunCommand[] = [];
  cleanupCalls: { deadline: number; reason: string }[] = [];
  preflightCalls = 0;
  reconcileCalls = 0;
  sequence = 0;
  events: RunnerEvent[] = [
    { kind: 'passed', test: alpha }, { kind: 'passed', test: beta }, { kind: 'complete', expected: [alpha, beta] },
  ];
  exit: ChildExit = { exitCode: 0, signal: null, stderr: '' };
  cleanupResult = { complete: true, remainingPids: [] as number[] };
  processPids = [101, 102, 103];
  remainingPids: number[] = [];
  finishImmediately = true;
  spawnError: Error | null = null;
  preflightError: Error | null = null;
  recovered = { alive: false, deadlineReached: false, cleanup: { complete: true, remainingPids: [] as number[] } };
  eventSink: ((event: RunnerEvent) => void) | null = null;
  interrupt: ((signal: string) => void) | null = null;
  resolveExit: ((exit: ChildExit) => void) | null = null;
  spawnInsideTransaction = false;
  ports: TestRunPorts = {
    preflight: async () => {
      this.preflightCalls++;
      if (this.preflightError) throw this.preflightError;
      return structuredClone(this.environment);
    },
    state: this.state,
    clock: this.clock,
    newRunId: () => `fixture-run-${++this.sequence}`,
    spawn: async (command, onEvent) => {
      this.spawnInsideTransaction ||= this.state.inTransaction;
      if (this.spawnError) throw this.spawnError;
      this.spawns.push(structuredClone(command));
      this.remainingPids = [...this.processPids];
      this.eventSink = onEvent;
      this.events.forEach(onEvent);
      const pending = new Promise<ChildExit>(resolve => { this.resolveExit = resolve; });
      return {
        identity: `fixture-process-${this.sequence}`,
        wait: () => this.finishImmediately ? Promise.resolve(this.exit) : pending,
        cleanup: async (deadline, reason) => {
          this.cleanupCalls.push({ deadline, reason });
          this.remainingPids = [...this.cleanupResult.remainingPids];
          this.resolveExit?.({ exitCode: null, signal: reason === 'timeout' ? 'SIGKILL' : 'SIGTERM', stderr: '' });
          return structuredClone(this.cleanupResult);
        },
      };
    },
    subscribeInterruption: callback => { this.interrupt = callback; return () => { this.interrupt = null; }; },
    reconcile: async () => { this.reconcileCalls++; return structuredClone(this.recovered); },
  };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}
