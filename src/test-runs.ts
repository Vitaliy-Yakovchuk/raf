import { normalizeRunnerEvents, RunnerProtocol, type CanonicalRunnerEvent } from './test-run-protocol.ts';
import type { StateAccessFailure, RecoveryDelivery } from './test-run-state-recovery.ts';
import { profileFiles, profileTestKind, prepareTestRunProfile, testRunTimeoutPolicy, validateProfileInventories } from './test-run-integration-profiles.ts';
import type { TestKind, TimeoutPolicy } from './test-run-integration-profiles.ts';
import type { ResourceEstimateValues } from './resource-estimates.ts';
import { TestRunDiagnostics, diagnosticConfigurationFailure, rejectTestRunConfiguration, validateDiagnosticLimits, validateRunTemporaryConfiguration } from './test-run-diagnostics.ts';
import type { DiagnosticLimits, DiagnosticAttachment, InlineDiagnostic, DiagnosticEnvironmentSummary, RunTemporaryConfiguration, RunTemporaryReservation } from './test-run-diagnostics.ts';
import { parseCommandArguments } from './cli-arguments.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type TestRunOutcome = 'passed' | 'assertions-failed' | 'setup-failed' | 'timed-out' | 'interrupted' | 'refused' | 'unverified-remainder';
export type TestRunFailureKind = 'refusal' | 'setup' | 'assertions' | 'timeout' | 'interruption';
export type TestRunNextAction = 'complete' | 'fix-setup' | 'implement' | 'fix-implementation' | 'optimize' | 'confirm-known-red' | 'review-remainder' | 'retry' | 'reconcile' | 'complete-integration';

export interface TestId {
  file: string;
  name: string;
}

export interface TestRunRequest {
  project: string;
  phase: string;
  group: string;
  files?: string[];
  only?: TestId[];
}

export interface ParsedTestRunArgs {
  project: string;
  phase?: string;
  group: string;
  files?: string[];
  only?: string[];
}

export interface UnitTestPolicy {
  timeoutMs: number;
  optimizeAfterTimeouts: number;
  maxGroupTimeouts: number;
}

export interface TestRunProfile {
  resourceEstimate?: ResourceEstimateValues;
  cwd: string;
  executable: string;
  argv: string[];
  testKind?: TestKind;
  integrationFiles?: string[];
  unitFiles?: string[];
  exactIds: 'node-test-name' | 'vitest-test-name' | null;
  resultAdapter: 'node-test-events' | 'vitest-events';
  environment: { isolatedHome: boolean; stateOrigin: boolean };
  checks: string[];
}

export interface TestRunConfig {
  diagnostics: DiagnosticLimits;
  temporaryArtifacts: RunTemporaryConfiguration;
  phases: Record<string, { hints: Record<TestRunFailureKind, string> }>;
  hints: Record<string, string>;
  projects: Record<string, {
    profiles: Record<string, TestRunProfile>;
    groups: Record<string, { profileId: string; files: string[] }>;
  }>;
}

export interface TestRunContext {
  integrationTests?: { timeoutMs: number };
  callerPhase?: string;
  cwd: string;
  workspace: string;
  projectWorkspaces: Record<string, string[]>;
  agentPhases: string[];
  activeChanges: string[];
  agentId: string;
  sha: string;
  home: string;
  statePath: string;
  tmpPath: string;
  operationalHome: string;
}

export interface TestFileFact {
  kind: 'file' | 'directory';
  realpath: string;
  unit: boolean;
  testKind?: TestKind;
}

export interface TestRunEnvironment {
  canonicalWorkspace: string;
  canonicalCwd: string;
  runtimeAvailable: boolean;
  localRunnerAvailable: boolean;
  dependenciesAvailable: boolean;
  resultAdapterAvailable: boolean;
  artifactsWritable: boolean;
  treeControlSupported: boolean;
  isolatedHome: boolean;
  stateOriginAllowed: boolean;
  stateAliasesOperational: boolean;
  tmpAliasesOperational: boolean;
  inheritedOperationalChannel: boolean;
  unitFiles: string[];
  integrationFiles?: string[];
  files: Record<string, TestFileFact>;
}

export interface TestRunCommand {
  executable: string;
  argv: string[];
  cwd: string;
  shell: false;
  environment: { HOME: string; statePath: string; tmpPath: string; testIds?: TestId[]; TMPDIR?: string; timeoutPolicy?: TimeoutPolicy; vitestBatches?: TestRunCommand[] };
}

export interface TestRunPlan {
  request: TestRunRequest;
  workspace: string;
  profileId: string;
  testKind?: TestKind;
  timeoutPolicy?: TimeoutPolicy;
  selection: { files: string[]; testIds: TestId[] };
  command: TestRunCommand;
}

export type RunnerEvent =
  | { kind: 'diagnostic'; diagnostics: InlineDiagnostic[]; diagnosticSummary?: DiagnosticAttachment['diagnosticSummary']; evidence: string[] }
  | { kind: 'discovered'; test: TestId; parent?: TestId }
  | { kind: 'container-complete'; test: TestId }
  | { kind: 'passed' | 'assertion-failed' | 'setup-failed'; test: TestId; diagnostic?: string; inlineDiagnostic?: InlineDiagnostic }
  | { kind: 'complete'; expected: TestId[]; adapter?: 'vitest-events' }
  | { kind: 'expected'; test: TestId }
  | { kind: 'complete'; expectedCount: number; adapter?: 'vitest-events' }
  | { kind: 'file-setup-failed'; inlineDiagnostic?: InlineDiagnostic }
  | { kind: 'protocol-error'; diagnostic: string };

export interface ChildExit {
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stderrTruncated?: boolean;
}

export interface RunnerClassification {
  outcome: TestRunOutcome;
  failureKinds: TestRunFailureKind[];
  passed: TestId[];
  knownRed: TestId[];
  unexecuted: TestId[];
  unknown: TestId[];
}

export interface TestRunCleanup {
  complete: boolean;
  remainingPids: number[];
}

export interface TestRunResult extends RunnerClassification {
  testKind: TestKind | null;
  timeoutPolicy: TimeoutPolicy | null;
  callerPhase: string | null;
  resourceUsage?: import('./resource-usage.ts').ResourceUsageRecord | null;
  removed: TestId[];
  diagnostics: InlineDiagnostic[];
  diagnosticSummary: DiagnosticAttachment['diagnosticSummary'];
  environmentSummary: DiagnosticEnvironmentSummary;
  runId: string;
  project: string;
  workspace: string;
  phase: string;
  group: string;
  profileId: string | null;
  selection: { files: string[]; testIds: TestId[] };
  command: TestRunCommand | null;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cleanup: TestRunCleanup;
  stateAccess: StateAccessFailure | null;
  groupSnapshot: 'unavailable' | 'absent' | 'loaded';
  groupState: 'idle' | 'running' | 'optimize' | 'confirm-known-red' | 'unverified-remainder' | 'reconcile' | 'complete' | 'incomplete' | null;
  timeoutCount: number | null;
  nextAction: TestRunNextAction;
  hintIds: string[];
  hints: string[];
  evidence: string[];
  inFlight?: { runId: string; deadlineMs: number; processIdentity: string | null };
  errorCode?: string;
}

export interface TestRunGroupKey {
  project: string;
  workspace: string;
  group: string;
}

export interface TestRunGroup {
  testKind?: TestKind;
  profileId?: string;
  key: TestRunGroupKey;
  timeoutCount: number;
  state: NonNullable<TestRunResult['groupState']>;
  delivery?: RecoveryDelivery | null;
  selection: TestRunPlan['selection'];
  knownRed: TestId[];
  unexecuted: TestId[];
  unknown?: TestId[];
  inFlight: { runId: string; deadlineMs: number; startedAtMs?: number; timeoutPolicy?: TimeoutPolicy; callerPhase?: string | null; processIdentity: string | null; wrapperIdentity?: string; ownerIdentity?: string | null; recoveryReleasePending?: boolean; phase?: string | null; selection?: TestRunPlan['selection']; command?: TestRunCommand | null; testKind?: TestKind | null; startedAt?: string | null; finishedAtMs?: number | null; deadlineObservedAtMs?: number | null; temporary?: RunTemporaryReservation } | null;
  lastResult: TestRunResult | null;
}

export interface TestRunTransaction {
  get(key: TestRunGroupKey): TestRunGroup | null;
  list(project: string, workspace: string): TestRunGroup[];
  put(group: TestRunGroup): void;
  delete(key: TestRunGroupKey): void;
}

export interface TestRunStatePort {
  transaction<T>(operation: (transaction: TestRunTransaction) => T): Promise<T>;
}

export interface ManagedTestProcess {
  identity: string;
  wait(): Promise<ChildExit>;
  cleanup(deadlineMs: number, reason: 'exit' | 'timeout' | 'interruption' | 'recovery'): Promise<TestRunCleanup>;
}

export interface TestRunPorts {
  reservedPlan?: () => { configuration: TestRunConfig; plan: TestRunPlan };
  deferDelivery?: boolean;
  recoverGroup?: (key: TestRunGroupKey) => Promise<TestRunResult | null>;
  diagnosticEnvironment?: (command: TestRunCommand | null) => DiagnosticEnvironmentSummary;
  prepareTemporary?: (runId: string, context: TestRunContext, save: (reservation: RunTemporaryReservation) => Promise<void>) => Promise<RunTemporaryReservation>;
  cleanupTemporary?: (reservation: RunTemporaryReservation, treeTerminated: boolean) => Promise<{ cleanup: 'complete' | 'incomplete'; diagnostic: InlineDiagnostic | null }>;
  preflight(context: TestRunContext): Promise<TestRunEnvironment>;
  state: TestRunStatePort;
  clock: { now(): number; schedule(deadlineMs: number, callback: () => void): () => void };
  newRunId(): string;
  spawn(command: TestRunCommand, onEvent: (event: RunnerEvent) => void): Promise<ManagedTestProcess>;
  subscribeInterruption(callback: (signal: string) => void): () => void;
  reconcile(processIdentity: string | null, deadlineMs: number): Promise<{ alive: boolean; deadlineReached: boolean; cleanup: TestRunCleanup }>;
}

const failure = (code: string, message = code): never => { throw Object.assign(new Error(`${code}: ${message}`), { code }); };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !v.includes('\0');
const safeFile = (v: string) => text(v) && !isAbsolute(v) && !/^[A-Za-z]:|[\\*?\[\]{}\0]/.test(v) && !v.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('-'));
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
const idKey = (id: TestId) => JSON.stringify([id.file, id.name]);
const uniqueIds = (ids: readonly TestId[]) => [...new Map(ids.map(id => [idKey(id), id])).values()];
const containsId = (ids: readonly TestId[], id: TestId) => ids.some(other => idKey(other) === idKey(id));
const kinds: TestRunFailureKind[] = ['refusal', 'setup', 'assertions', 'timeout', 'interruption'];

export function parseTestRunArgs(argv: readonly string[]): ParsedTestRunArgs {
  const parsed = parseCommandArguments(argv, {
    path: ['test', 'run'], handlerName: 'test run',
    parameters: ['project', 'phase', 'group', 'files', 'only'].map(name => ({
      name, option: `--${name}`, multiple: name === 'files' || name === 'only',
      required: ['project', 'group'].includes(name),
    })),
  });
  if ('error' in parsed) return failure(parsed.error.code === 'UNKNOWN_ARGUMENT' ? 'INVALID_ARGUMENT' : parsed.error.code, `${parsed.error.details.parameter ?? ''}: ${parsed.error.message}`);
  const { params } = parsed;
  for (const [name, value] of Object.entries(params)) if (![value].flat().every(text)) failure('MISSING_VALUE', `--${name}`);
  if (params.files && params.only) failure('SELECTION_CONFLICT');
  return { ...params } as unknown as ParsedTestRunArgs;
}

export function validateTestRunConfig(config: unknown, phases: readonly string[], policy: UnitTestPolicy, integrationTests?: { timeoutMs: number }): TestRunConfig {
  const invalid = (field: string): never => rejectTestRunConfiguration(`CONFIGURATION_INVALID: ${field}`);
  if (!record(policy) || (['timeoutMs', 'optimizeAfterTimeouts', 'maxGroupTimeouts'] as const).some(key => !Number.isSafeInteger(policy[key]) || policy[key] <= 0) || policy.optimizeAfterTimeouts >= policy.maxGroupTimeouts) invalid('conf/flow.json#/unitTests');
  if (!record(config) || !record(config.phases) || !record(config.hints) || !record(config.projects)) return invalid('conf/test-runs.json');
  const validated = validateProfileInventories(config, { unitTests: policy, integrationTests });
  validateDiagnosticLimits(validated.diagnostics);
  validateRunTemporaryConfiguration(validated.temporaryArtifacts);
  for (const [id, value] of Object.entries(validated.hints)) if (!text(id) || !text(value)) invalid(`hints/${id}`);
  if (Object.keys(validated.phases).some(id => !phases.includes(id))) invalid('phases');
  for (const id of phases) {
    const phase = validated.phases[id];
    if (!record(phase) || !record(phase.hints)) invalid(`phases/${id}`);
    for (const kind of kinds) if (!text(phase.hints[kind]) || !text(validated.hints[phase.hints[kind]])) invalid(`phases/${id}/hints/${kind}`);
  }
  return validated as unknown as TestRunConfig;
}

export function planTestRun(request: TestRunRequest, config: TestRunConfig, context: TestRunContext, env: TestRunEnvironment): TestRunPlan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(request.group) || request.group.split('/').some(x => x === '..' || x === '.')) failure('INVALID_GROUP');
  const project = config.projects[request.project];
  if (!project || !context.projectWorkspaces[request.project]?.includes(context.workspace)) failure('UNKNOWN_PROJECT');
  if (env.canonicalWorkspace !== context.workspace || env.canonicalCwd !== context.cwd || context.cwd !== context.workspace) failure('WORKSPACE_MISMATCH');
  for (const key of ['runtimeAvailable', 'localRunnerAvailable', 'dependenciesAvailable', 'resultAdapterAvailable', 'artifactsWritable', 'treeControlSupported'] as const) if (!env[key]) failure('ENVIRONMENT_INVALID', key);
  if (env.stateAliasesOperational || env.tmpAliasesOperational || env.inheritedOperationalChannel) failure('STATE_CONTEXT_REFUSED');
  if (request.files !== undefined && request.only !== undefined) failure('SELECTION_CONFLICT');
  if (request.files?.length === 0 || request.only?.length === 0) failure('EMPTY_SELECTION');
  if (request.only?.some(id => !record(id) || !safeFile(id.file) || !text(id.name))) failure('INVALID_TEST_ID');
  const preset = project.groups[request.group] ?? project.groups[request.group.slice(request.group.indexOf('/') + 1)];
  const files = [...new Set(request.files ?? request.only?.map(id => id.file) ?? preset?.files ?? [])];
  if (!files.length) failure('EMPTY_SELECTION');
  if (files.some(file => !safeFile(file))) failure('UNSAFE_SELECTION');
  if (files.some(file => Object.values(project.profiles).some(profile => profileTestKind(profile) === 'integration' && profileFiles(profile).includes(file)))) {
    const prepared = prepareTestRunProfile(config as unknown as Record<string, unknown>, { integrationTests: context.integrationTests, unitTests: {} }, { ...request, workspace: context.workspace, branch: '' }, Object.entries(env.files).map(([file, fact]) => ({ file, exists: fact.kind === 'file', canonicalInsideWorkspace: fact.realpath === resolve(context.workspace, file), kind: fact.testKind ?? (fact.unit ? 'unit' : 'integration') })));
    const profile = project.profiles[prepared.profileId];
    if (profile.environment.isolatedHome && (!env.isolatedHome || context.home === context.operationalHome) || profile.environment.stateOrigin && !env.stateOriginAllowed) failure('STATE_CONTEXT_REFUSED');
    return { ...prepared, workspace: context.workspace, command: { ...prepared.command, shell: false, environment: { HOME: context.home, statePath: context.statePath, tmpPath: context.tmpPath } } };
  }
  for (const [id, profile] of Object.entries(project.profiles)) if (profile.testKind === 'integration') for (const file of profileFiles(profile)) {
    const fact = env.files[file];
    if (!fact) continue;
    if (!fact || fact.kind !== 'file' || fact.realpath !== resolve(context.workspace, file) || fact.unit || fact.testKind && fact.testKind !== 'integration') failure('CONFIGURATION_INVALID', `conf/test-runs.json#/projects/${request.project}/profiles/${id}/integrationFiles: ${file}`);
  }
  const configuredInventory = [...new Set(Object.values(project.profiles).flatMap(p => p.testKind === 'integration' ? [] : p.unitFiles ?? []))];
  const requiredInventory = request.project === 'raf' ? configuredInventory.filter(file => files.includes(file)) : configuredInventory;
  const missing = requiredInventory.filter(file => !env.unitFiles.includes(file) || env.files[file]?.kind !== 'file');
  const unexpected = env.unitFiles.filter(file => !configuredInventory.includes(file));
  if (missing.length || unexpected.length) process.stderr.write(`Warning: unit inventory differs; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}; missing files are skipped\n`);
  files.splice(0, files.length, ...files.filter(file => !missing.includes(file) && env.files[file]?.kind === 'file'));
  if (!files.length) failure('EMPTY_SELECTION');
  const unregistered = files.filter(file => request.files?.includes(file) && !configuredInventory.includes(file));
  for (const file of files) if (!unregistered.includes(file) && (!configuredInventory.includes(file) || env.files[file]?.unit === false)) failure('UNSAFE_SELECTION', `Non-unit file ${file}: excluded by unit include/classification; reconcile conf/test-runs.json#/projects/${request.project}/profiles`);
  let profiles = Object.entries(project.profiles).filter(([, profile]) => profile.testKind !== 'integration' && files.every(file => unregistered.includes(file) ? inside(resolve(context.workspace, file), resolve(context.workspace, profile.cwd)) : (profile.unitFiles ?? []).includes(file)));
  if (unregistered.length && profiles.length > 1) {
    const preferred = profiles.filter(([id]) => id === preset?.profileId);
    profiles = preferred.length ? preferred : [profiles.reduce((best, next) => resolve(context.workspace, next[1].cwd).length > resolve(context.workspace, best[1].cwd).length ? next : best)];
  }
  if (profiles.length !== 1) failure('PROFILE_AMBIGUOUS', 'Selection must belong to one configured profile');
  const [profileId, profile] = profiles[0];
  if (!request.files && !request.only && preset?.profileId !== profileId) failure('PROFILE_AMBIGUOUS');
  const cwd = resolve(context.workspace, profile.cwd);
  if (!inside(cwd, context.workspace)) failure('WORKSPACE_MISMATCH');
  if (profile.environment.isolatedHome && (!env.isolatedHome || context.home === context.operationalHome) || profile.environment.stateOrigin && !env.stateOriginAllowed) failure('STATE_CONTEXT_REFUSED');
  for (const file of files) {
    const fact = env.files[file];
    const canonicalFile = fact ? relative(context.workspace, fact.realpath) : '';
    if (!fact || fact.kind !== 'file' || !fact.unit || !env.unitFiles.includes(file) || !inside(fact.realpath, cwd) || !unregistered.includes(file) && !profile.unitFiles?.includes(canonicalFile) || !env.unitFiles.includes(canonicalFile)) failure('UNSAFE_SELECTION', `File ${file}: directory or symlink outside canonical workspace or unit inventory ${context.workspace}`);
  }
  files.splice(0, files.length, ...new Set(files.map(file => relative(context.workspace, env.files[file].realpath))));
  const testIds = uniqueIds((request.only ?? []).filter(id => env.files[id.file]?.kind === 'file').map(id => ({ ...id, file: relative(context.workspace, env.files[id.file].realpath) })));
  if (testIds.length && !['node-test-name', 'vitest-test-name'].includes(profile.exactIds ?? '')) failure('EXACT_IDS_UNSUPPORTED');
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const argv = [...profile.argv];
  if (testIds.length && profile.resultAdapter === 'node-test-events') argv.push(`--test-name-pattern=^(?:${testIds.map(id => escape(id.name)).join('|')})$`);
  if (profile.resultAdapter === 'vitest-events') {
    const run = argv.indexOf('run');
    if (run < 0) failure('CONFIGURATION_INVALID', 'Vitest run required');
    argv.splice(run + 1, 0, ...files.map(file => relative(cwd, resolve(context.workspace, file))));
  } else argv.push(...files.map(file => relative(cwd, resolve(context.workspace, file))));
  return { request, workspace: context.workspace, profileId, testKind: 'unit', selection: { files, testIds },
    command: { executable: profile.executable, argv, cwd, shell: false, environment: { HOME: context.home, statePath: context.statePath, tmpPath: context.tmpPath, ...(testIds.length ? { testIds } : {}) } } };
}

export function classifyRunnerResult(events: readonly RunnerEvent[], exit: ChildExit): RunnerClassification {
  let passed: TestId[] = [], knownRed: TestId[] = [], unknown: TestId[] = [], expected: TestId[] = [];
  const completedContainers: TestId[] = [];
  let complete = false, setup = false, vitest = false;
  for (const event of normalizeRunnerEvents(events)) {
    if (event.kind === 'discovered') {
      expected = uniqueIds([...expected, event.test]);
    } else if (event.kind === 'container-complete') completedContainers.push(event.test);
    else if (event.kind === 'complete') { complete = true; vitest ||= event.adapter === 'vitest-events'; expected = uniqueIds([...expected, ...event.expected]); }
    else if (event.kind === 'protocol-error' || event.kind === 'file-setup-failed') setup = true;
    else if (event.kind === 'passed') passed.push(event.test);
    else if (event.kind === 'assertion-failed') knownRed.push(event.test);
    else { setup = true; unknown.push(event.test); }
  }
  knownRed = uniqueIds(knownRed);
  passed = uniqueIds(passed).filter(id => !containsId(knownRed, id) && !containsId(unknown, id));
  unknown = uniqueIds(unknown);
  const unexecuted = expected.filter(id => !containsId([...passed, ...knownRed, ...unknown, ...completedContainers], id));
  if (!complete || !expected.length || unexecuted.length && !vitest || exit.exitCode !== 0 && !knownRed.length || exit.signal) setup = true;
  const failureKinds: TestRunFailureKind[] = [...(setup ? ['setup' as const] : []), ...(knownRed.length ? ['assertions' as const] : [])];
  return { outcome: setup ? 'setup-failed' : knownRed.length ? 'assertions-failed' : unexecuted.length ? 'unverified-remainder' : 'passed', failureKinds, passed, knownRed, unexecuted, unknown };
}

function unavailableEnvironment(context: TestRunContext): DiagnosticEnvironmentSummary {
  return { executable: process.execPath, runtimeVersion: process.version, adapter: 'unavailable', isolation: 'unavailable', configurationFingerprints: { flow: '', testRuns: '', projects: '' }, tmpPathBytes: Buffer.byteLength(context.tmpPath), privateRunTmp: false };
}
function emptyResult(request: TestRunRequest, context: TestRunContext, runId: string, now: number): TestRunResult {
  return { testKind: null, timeoutPolicy: null, callerPhase: context.callerPhase ?? null, diagnostics: [], diagnosticSummary: { totalEntries: 0, retainedEntries: 0, omittedEntries: 0, truncated: false, redacted: false }, environmentSummary: unavailableEnvironment(context), runId, project: request.project, workspace: context.workspace, phase: request.phase, group: request.group, profileId: null,
    selection: { files: request.files ?? [], testIds: request.only ?? [] }, command: null, startedAt: new Date(now).toISOString(), durationMs: 0,
    exitCode: null, signal: null, timedOut: false, cleanup: { complete: true, remainingPids: [] }, outcome: 'refused', failureKinds: ['refusal'],
    passed: [], knownRed: [], unexecuted: [], unknown: [], removed: [], stateAccess: null, groupSnapshot: 'unavailable', groupState: null, timeoutCount: null, nextAction: 'fix-setup', hintIds: [], hints: [], evidence: [] };
}
function attachHints(result: TestRunResult, config: TestRunConfig | null): TestRunResult {
  const phase = config?.phases[result.phase];
  result.hintIds = [...new Set(result.failureKinds.map(kind => phase?.hints?.[kind]).filter((v): v is string => typeof v === 'string' && typeof config?.hints[v] === 'string'))];
  result.hints = result.hintIds.map(id => config!.hints[id]);
  return result;
}
function groupState(group: TestRunGroup, policy: UnitTestPolicy): NonNullable<TestRunResult['groupState']> {
  return group.timeoutCount >= policy.maxGroupTimeouts ? group.knownRed.length ? 'confirm-known-red' : 'unverified-remainder' : group.timeoutCount >= policy.optimizeAfterTimeouts ? 'optimize' : 'idle';
}
function aggregateHasExecutedTests(group: { knownRed?: readonly unknown[]; unknown?: readonly unknown[]; lastResult?: { passed?: readonly unknown[]; knownRed?: readonly unknown[]; unknown?: readonly unknown[] } | null }, current?: { passed?: readonly unknown[]; knownRed?: readonly unknown[]; unknown?: readonly unknown[] }): boolean {
  return [group.knownRed, group.unknown, group.lastResult?.passed, group.lastResult?.knownRed, group.lastResult?.unknown, current?.passed, current?.knownRed, current?.unknown].some(list => (list?.length ?? 0) > 0);
}

export async function runTestRun(request: TestRunRequest, configInput: unknown, policy: UnitTestPolicy, context: TestRunContext, ports: TestRunPorts): Promise<TestRunResult> {
  const started = ports.clock.now();
  const result = emptyResult(request, context, ports.newRunId(), started);
  let config: TestRunConfig | null = null, plan: TestRunPlan, environment: TestRunEnvironment;
  let diagnostics: TestRunDiagnostics | null = null;
  const attach = () => {
    if (diagnostics) Object.assign(result, diagnostics.attach(result, ports.diagnosticEnvironment?.(result.command) ?? result.environmentSummary));
    return attachHints(result, config);
  };
  try {
    diagnostics = new TestRunDiagnostics((configInput as TestRunConfig)?.diagnostics, { workspace: context.workspace, qaHome: context.home, fixtureRoots: [] });
    config = validateTestRunConfig(configInput, context.agentPhases, policy, context.integrationTests);
    const configuredProfile = config.projects[request.project]?.profiles[config.projects[request.project]?.groups[request.group]?.profileId];
    if (configuredProfile) { result.testKind = profileTestKind(configuredProfile); result.timeoutPolicy = testRunTimeoutPolicy(result.testKind, { unitTests: policy, integrationTests: context.integrationTests }); }
    environment = await ports.preflight(context);
    plan = planTestRun(request, config, context, environment);
  } catch (error) {
    result.errorCode = (error as any)?.code ?? 'ENVIRONMENT_INVALID';
    if (['ENVIRONMENT_INVALID', 'STATE_CONTEXT_REFUSED'].includes(result.errorCode!)) { result.outcome = 'setup-failed'; result.failureKinds = ['setup']; }
    if (!diagnostics) return testRunFailureResult(request, context, result.runId, started, configInput, error);
    diagnostics.preflight(error);
    result.evidence = [];
    return attach();
  }
  result.testKind = plan.testKind ?? 'unit'; result.timeoutPolicy = testRunTimeoutPolicy(result.testKind, { unitTests: policy, integrationTests: context.integrationTests });
  plan.timeoutPolicy = result.timeoutPolicy;
  if (result.testKind === 'integration') plan.command.environment.timeoutPolicy = result.timeoutPolicy;
  result.profileId = plan.profileId; result.selection = plan.selection; result.command = plan.command;
  const key = { project: request.project, workspace: context.workspace, group: request.group };
  let deadline = started + result.timeoutPolicy.timeoutMs;
  let reserved: TestRunGroup | null = null;
  let pendingResult: TestRunResult | null = null;
  try {
    const recovered = await ports.recoverGroup?.(key);
    if (recovered) return recovered;
    await ports.state.transaction(tx => {
      let group = tx.get(key);
      result.groupSnapshot = group ? 'loaded' : 'absent'; result.groupState = group?.state ?? 'idle'; result.timeoutCount = group?.timeoutCount ?? 0;
      if (group) {
        result.timeoutCount = group.timeoutCount; result.knownRed = group.knownRed; result.unexecuted = group.unexecuted;
      }
      const executed = !!group && aggregateHasExecutedTests(group);
      if (group && executed && (group.testKind ?? 'unit') !== result.testKind) failure('GROUP_PROFILE_MISMATCH');
      if (group?.delivery?.pending && group.lastResult?.runId === group.delivery.runId && !group.inFlight) { pendingResult = structuredClone(group.lastResult); return; }
      if (group?.inFlight) {
        const { runId, deadlineMs, processIdentity } = group.inFlight;
        result.inFlight = { runId, deadlineMs, processIdentity };
        failure('GROUP_IN_FLIGHT', `Group ${key.group} retains inFlight runId ${runId}, deadlineMs ${deadlineMs}; reconcile the original tree before retrying.`);
      }
      const previousProfile = group?.profileId ?? group?.lastResult?.profileId;
      const previousKind = group?.testKind;
      const kindDrift = !!(group && !executed && previousKind && previousKind !== result.testKind);
      if (group && ((previousProfile && previousProfile !== plan.profileId) || kindDrift)) {
        const fromKind = kindDrift ? `/${previousKind}` : '';
        const toKind = kindDrift ? `/${result.testKind}` : '';
        process.stderr.write(`Warning: test-run group ${key.group} profile changed from ${previousProfile ?? 'unset'}${fromKind} to ${plan.profileId}${toKind}; starting a new profile aggregate with the existing timeout and outstanding test ledger\n`);
        group = { key, testKind: result.testKind!, profileId: plan.profileId, timeoutCount: group.timeoutCount, state: 'idle',
          selection: plan.selection, knownRed: group.knownRed, unexecuted: group.unexecuted,
          unknown: group.unknown ?? group.lastResult?.unknown ?? [], inFlight: null, lastResult: null };
      }
      group ??= { key, testKind: result.testKind!, profileId: plan.profileId, timeoutCount: 0, state: 'idle', selection: plan.selection, knownRed: [], unexecuted: [], inFlight: null, lastResult: null };
      result.timeoutCount = group.timeoutCount; result.knownRed = group.knownRed; result.unexecuted = group.unexecuted;
      group.testKind = result.testKind!; group.profileId = plan.profileId; group.selection = plan.selection; group.state = 'running'; group.inFlight = { runId: result.runId, deadlineMs: deadline, startedAtMs: started, timeoutPolicy: result.timeoutPolicy!, callerPhase: result.callerPhase, processIdentity: null, phase: request.phase, selection: plan.selection, command: plan.command, testKind: result.testKind, startedAt: result.startedAt, finishedAtMs: null, deadlineObservedAtMs: null };
      tx.put(group); reserved = group;
    });
    if (reserved && ports.reservedPlan) {
      ({ configuration: config, plan } = ports.reservedPlan());
      plan.timeoutPolicy = result.timeoutPolicy!;
      if (result.testKind === 'integration') plan.command.environment.timeoutPolicy = result.timeoutPolicy!;
      result.profileId = plan.profileId; result.selection = plan.selection; result.command = plan.command;
      diagnostics = new TestRunDiagnostics(config.diagnostics, { workspace: context.workspace, qaHome: context.home, fixtureRoots: [] });
    }
  } catch (error) {
    result.errorCode = (error as any)?.code ?? 'STATE_FAILED';
    if (result.errorCode === 'STATE_FAILED') { result.outcome = 'setup-failed'; result.failureKinds = ['setup']; }
    if (result.errorCode === 'GROUP_IN_FLIGHT') {
      result.groupState = 'reconcile'; result.nextAction = 'reconcile';
      try { if (!ports.recoverGroup) await reconcileTestRunGroup(key, policy, context, ports); }
      catch (recoveryError) {
        result.outcome = 'setup-failed'; result.failureKinds = ['setup']; result.errorCode = 'STATE_FAILED';
        diagnostics?.preflight(recoveryError);
      }
    }
    result.stateAccess = (error as any)?.stateAccess ?? null;
    diagnostics?.preflight(error);
    result.evidence = [];
    return attach();
  }
  if (!reserved) return pendingResult ?? attach();
  deadline = (reserved as TestRunGroup).inFlight!.deadlineMs;
  const events: CanonicalRunnerEvent[] = [];
  const protocol = new RunnerProtocol();
  let temporary: RunTemporaryReservation | undefined;
  const recordEvent = (event: CanonicalRunnerEvent) => {
    if (event.kind === 'diagnostic') {
      for (const entry of event.diagnostics) diagnostics?.inline(entry);
      if (event.diagnosticSummary) diagnostics?.omitted(event.diagnosticSummary.omittedEntries, event.diagnosticSummary.redacted, event.diagnosticSummary.truncated);
      result.evidence = [...new Set([...result.evidence, ...event.evidence])];
      return;
    }
    if ('inlineDiagnostic' in event && event.inlineDiagnostic) diagnostics?.inline(event.inlineDiagnostic);
    else if (event.kind === 'protocol-error') diagnostics?.protocolError(event.diagnostic);
    else if (event.kind === 'assertion-failed' || event.kind === 'setup-failed') diagnostics?.failure({ test: event.test, origin: event.kind === 'assertion-failed' ? 'test-body' : 'unknown', error: event.diagnostic });
    if ('diagnostic' in event || 'inlineDiagnostic' in event) { const { diagnostic, inlineDiagnostic, ...facts } = event as any; events.push(facts as CanonicalRunnerEvent); }
    else events.push(event);
  };
  const onEvent = (event: RunnerEvent) => {
    try { const value = protocol.accept(event); if (value) recordEvent(value); }
    catch { recordEvent({ kind: 'protocol-error', diagnostic: 'Invalid JSON runner protocol' }); }
  };
  let child: ManagedTestProcess | null = null, interruption: string | null = null;
  let cancelDeadline = () => {}, unsubscribe = () => {};
  let exit: ChildExit = { exitCode: null, signal: null, stderr: '' };
  let reason: 'exit' | 'timeout' | 'interruption' = 'exit';
  try {
    let interrupt!: (value: 'interruption' | 'timeout') => void;
    const stopped = new Promise<'interruption' | 'timeout'>(resolve => { interrupt = resolve; });
    cancelDeadline = ports.clock.schedule(deadline, () => interrupt('timeout'));
    unsubscribe = ports.subscribeInterruption(signal => { interruption = signal; interrupt('interruption'); });
    if (ports.prepareTemporary) {
      try {
        temporary = await ports.prepareTemporary(result.runId, context, async reservation => { await ports.state.transaction(tx => { const group = tx.get(key); if (!group?.inFlight || group.inFlight.runId !== result.runId) return failure('RESERVATION_LOST'); group.inFlight.temporary = reservation; tx.put(group); }); });
        plan.command.environment.TMPDIR = temporary.temporary.path;
      } catch (error) {
        const unusable = error as { code?: unknown; diagnostic?: InlineDiagnostic; message?: string };
        if (unusable?.code !== 'TEMPORARY_DIRECTORY_INVALID') throw error;
        delete plan.command.environment.TMPDIR;
        diagnostics?.inline({ kind: 'preflight', test: null, errorCode: 'TEMPORARY_DIRECTORY_INVALID', message: `Warning: ${unusable.message}; the run uses the system tmp`, location: null, stack: [], redacted: false, truncated: false });
      }
    }
    if (ports.clock.now() >= deadline) { reason = 'timeout'; }
    else if (interruption) { reason = 'interruption'; }
    else child = await ports.spawn(plan.command, onEvent);
    if (child) {
    await ports.state.transaction(tx => {
      const group = tx.get(key);
      if (!group || !group.inFlight || group.inFlight.runId !== result.runId) return failure('RESERVATION_LOST');
      group.inFlight.processIdentity = child!.identity; tx.put(group);
    });
    const finished = await Promise.race([child.wait(), stopped]);
    if (typeof finished === 'string') reason = finished; else exit = finished;
    await ports.state.transaction(tx => { const group = tx.get(key); if (group?.inFlight?.runId !== result.runId) return; if (reason === 'exit') group.inFlight.finishedAtMs = ports.clock.now(); else if (reason === 'timeout') group.inFlight.deadlineObservedAtMs = ports.clock.now(); tx.put(group); });
    result.cleanup = await child.cleanup(deadline, reason);
    if (!result.cleanup.remainingPids.length) result.cleanup.complete = true;
    if (reason !== 'exit' && result.cleanup.complete) exit = await child.wait();
    }
  } catch (error) {
    diagnostics?.failure({ test: null, origin: 'fixture-setup', error });
    result.errorCode = (error as any)?.code ?? 'RUNNER_SETUP_FAILED';
    events.push({ kind: 'protocol-error', diagnostic: '' });
    if (child) {
      try {
        result.cleanup = await child.cleanup(deadline, 'interruption');
        if (!result.cleanup.remainingPids.length) result.cleanup.complete = true;
      } catch { result.cleanup = { complete: false, remainingPids: [] }; }
    }
  } finally { cancelDeadline(); unsubscribe(); }
  if (temporary && ports.cleanupTemporary) {
    const treeTerminated = result.cleanup.complete && !result.cleanup.remainingPids.length;
    try {
      const cleaned = await ports.cleanupTemporary(temporary, treeTerminated);
      if (cleaned.diagnostic) diagnostics?.inline(cleaned.diagnostic);
      if (!treeTerminated && cleaned.cleanup !== 'complete') result.cleanup.complete = false;
    } catch (error) {
      if (treeTerminated) diagnostics?.inline({ kind: 'preflight', test: null, errorCode: 'TEMPORARY_DIRECTORY_INVALID', message: 'Warning: Temporary directory ownership could not be verified; leaving directory untouched', location: null, stack: [], redacted: false, truncated: false });
      else { diagnostics?.failure({ test: null, origin: 'fixture-setup', error }); result.cleanup.complete = false; }
    }
  }
  try { protocol.finish(); } catch { recordEvent({ kind: 'protocol-error', diagnostic: 'Incomplete runner expected inventory' }); }
  diagnostics?.stderrChunk(Buffer.from(exit.stderr));
  if (exit.stderrTruncated) diagnostics?.markStderrTruncated();
  if (child && reason === 'exit') diagnostics?.childExit({ ...exit, validProtocol: events.some(e => e.kind === 'complete') && !events.some(e => e.kind === 'protocol-error') });
  const classified = classifyRunnerResult(events, exit);
  Object.assign(result, classified, { exitCode: exit.exitCode, signal: interruption ?? exit.signal, timedOut: reason === 'timeout', durationMs: ports.clock.now() - started });
  if (result.testKind === 'integration' && result.outcome === 'unverified-remainder') { result.outcome = 'setup-failed'; result.failureKinds.push('setup'); }
  if (reason !== 'exit') {
    result.outcome = reason === 'timeout' ? 'timed-out' : 'interrupted';
    result.failureKinds = [...new Set<TestRunFailureKind>([...classified.failureKinds.filter(k => k !== 'setup' || events.some(e => e.kind === 'setup-failed' || e.kind === 'protocol-error')), reason === 'timeout' ? 'timeout' : 'interruption'])];
  }
  if (!result.cleanup.complete || result.cleanup.remainingPids.length) {
    result.cleanup.complete = false;
    result.outcome = 'setup-failed'; result.failureKinds = [...new Set<TestRunFailureKind>([...result.failureKinds, 'setup'])];
    result.errorCode = 'CLEANUP_INCOMPLETE';
  }
  try { await ports.state.transaction(tx => {
    const group = tx.get(key);
    if (!group || group.inFlight?.runId !== result.runId) return;
    const collected = uniqueIds(events.flatMap(event => event.kind === 'complete' ? event.expected : event.kind === 'discovered' || event.kind === 'container-complete' ? [event.test] : []));
    const completeCollection = !request.only && reason === 'exit' && result.cleanup.complete && !classified.failureKinds.includes('setup') && events.some(event => event.kind === 'complete');
    const removed = (id: TestId) => completeCollection && (!plan.selection.files.includes(id.file) || !containsId(collected, id));
    result.removed = uniqueIds([...group.knownRed, ...group.unexecuted].filter(removed));
    group.knownRed = uniqueIds([...group.knownRed.filter(id => !removed(id) && (!events.some(event => event.kind === 'complete') || events.some(event => event.kind === 'protocol-error') || !containsId(result.passed, id))), ...result.knownRed]);
    result.knownRed = group.knownRed;
    result.unexecuted = uniqueIds([...group.unexecuted.filter(id => !removed(id) && !containsId([...result.passed, ...result.knownRed], id)), ...result.unexecuted, ...plan.selection.testIds.filter(id => !containsId([...result.passed, ...classified.knownRed], id))]);
    if (result.testKind === 'integration') {
      const confirmed = reason === 'exit' && result.cleanup.complete && !classified.failureKinds.includes('setup') && events.some(event => event.kind === 'complete');
      const confirmedPassed = confirmed ? result.passed : [];
      const previous = reserved as TestRunGroup;
      const configuredFiles = config.projects[request.project]?.groups[request.group]?.files;
      const integrationRemoved = (id: TestId) => removed(id) || completeCollection && !!configuredFiles && !configuredFiles.includes(id.file) && !containsId(collected, id);
      result.removed = uniqueIds([...previous.knownRed, ...previous.unexecuted].filter(integrationRemoved));
      group.knownRed = uniqueIds([...previous.knownRed.filter(id => !integrationRemoved(id) && !containsId(confirmedPassed, id)), ...classified.knownRed]);
      result.knownRed = group.knownRed;
      result.unexecuted = uniqueIds([...previous.unexecuted.filter(id => !integrationRemoved(id) && !containsId([...confirmedPassed, ...classified.knownRed], id)), ...classified.unexecuted]);
      result.unknown = uniqueIds([...(previous.unknown ?? previous.lastResult?.unknown ?? []).filter(id => !containsId(confirmedPassed, id)), ...classified.unknown]);
      group.unknown = result.unknown;
    }
    group.unexecuted = result.unexecuted;
    if (result.timedOut) group.timeoutCount++;
    result.timeoutCount = group.timeoutCount;
    result.groupState = !result.cleanup.complete ? 'reconcile' : groupState(group, policy);
    if (result.outcome === 'passed' && result.knownRed.length) { result.outcome = 'assertions-failed'; result.failureKinds.push('assertions'); }
    if (result.outcome === 'passed' && (result.unexecuted.length || result.unknown.length)) {
      result.outcome = result.testKind === 'unit' && group.timeoutCount >= policy.maxGroupTimeouts ? 'unverified-remainder' : 'setup-failed';
      if (result.outcome === 'setup-failed') result.failureKinds.push('setup');
    }
    if (result.testKind === 'integration' && result.outcome === 'passed' && !plan.selection.files.every(file => result.passed.some(id => id.file === file))) { result.outcome = 'setup-failed'; result.failureKinds.push('setup'); }
    if (result.outcome === 'passed' && !result.unexecuted.length && !result.unknown.length && !result.knownRed.length) result.groupState = 'complete';
    if (!result.cleanup.complete) result.nextAction = 'reconcile';
    else if (result.failureKinds.includes('setup')) result.nextAction = 'fix-setup';
    else if (result.outcome === 'interrupted') result.nextAction = 'retry';
    else if (result.groupState === 'confirm-known-red') result.nextAction = 'confirm-known-red';
    else if (result.groupState === 'unverified-remainder') result.nextAction = 'review-remainder';
    else if (result.groupState === 'optimize' && result.timedOut) result.nextAction = 'optimize';
    else if (result.outcome === 'passed') result.nextAction = 'complete';
    else if (request.phase === 'red') result.nextAction = 'implement';
    else result.nextAction = result.timedOut ? 'retry' : 'fix-implementation';
    if (result.testKind === 'integration' && result.outcome !== 'passed') { result.groupState = 'incomplete'; result.nextAction = 'complete-integration'; }
    attachHints(result, config);
    result.groupSnapshot = 'loaded';
    group.state = result.groupState!;
    if (result.cleanup.complete) group.inFlight = null;
    if (result.cleanup.complete && !aggregateHasExecutedTests(group, result)) { delete group.testKind; delete group.profileId; }
    attach();
    group.lastResult = result; group.delivery = { runId: result.runId, pending: true, receiptId: null, returned: false, forwardedToMain: false }; tx.put(group);
  }); } catch (error) {
    result.outcome = 'setup-failed'; result.errorCode = 'STATE_FAILED';
    result.failureKinds = [...new Set<TestRunFailureKind>([...result.failureKinds, 'setup'])];
    result.groupState = 'reconcile'; result.nextAction = 'reconcile';
    diagnostics?.preflight(error);
    attachHints(result, config);
  }
  return attach();
}

export async function reconcileTestRunGroup(key: TestRunGroupKey, policy: UnitTestPolicy, context: TestRunContext, ports: TestRunPorts): Promise<TestRunGroup | null> {
  validatePolicy(policy);
  if (key.workspace !== context.workspace) failure('WORKSPACE_MISMATCH');
  const group = await ports.state.transaction(tx => tx.get(key));
  if (!group?.inFlight) return group;
  const observed = await ports.reconcile(group.inFlight.processIdentity, group.inFlight.deadlineMs);
  const treeTerminated = !observed.alive && !observed.cleanup.remainingPids.length && observed.cleanup.complete;
  const temporaryCleanup = group.inFlight.temporary && ports.cleanupTemporary ? await ports.cleanupTemporary(group.inFlight.temporary, treeTerminated) : null;
  return ports.state.transaction(tx => {
    const current = tx.get(key);
    if (!current?.inFlight || current.inFlight.runId !== group.inFlight!.runId) return current;
    if (observed.alive) return current;
    const complete = treeTerminated;
    const flight = current.inFlight;
    const recorded = current.lastResult?.runId === flight.runId;
    const timedOut = observed.deadlineReached && !(flight.finishedAtMs != null && flight.finishedAtMs < flight.deadlineMs);
    if (timedOut && !recorded) current.timeoutCount++;
    const result = recorded ? current.lastResult! : emptyResult({ project: key.project, phase: flight.phase ?? 'recovery', group: key.group, files: current.selection.files }, context, flight.runId, flight.startedAtMs ?? flight.deadlineMs - (flight.timeoutPolicy?.timeoutMs ?? policy.timeoutMs));
    result.testKind = current.testKind ?? 'unit'; result.timeoutPolicy = flight.timeoutPolicy ?? testRunTimeoutPolicy('unit', { unitTests: policy }); result.callerPhase = flight.callerPhase ?? null;
    if (result.testKind === 'integration') result.phase = 'integration';
    if (!recorded) {
      result.outcome = timedOut ? 'timed-out' : 'setup-failed';
      result.timedOut = timedOut;
      result.failureKinds = timedOut ? ['timeout'] : ['setup'];
      result.command = flight.command ?? null; result.startedAt = flight.startedAt ?? result.startedAt;
      result.knownRed = current.knownRed;
      result.unexecuted = current.unexecuted;
      result.unknown = current.unknown ?? current.lastResult?.unknown ?? [];
      result.profileId = current.profileId ?? current.lastResult?.profileId ?? null;
      result.selection = current.selection;
      result.diagnostics = [{ kind: 'runner', test: null, message: 'Recovery lost current run diagnostic details', location: null, stack: [], redacted: false, truncated: false, unavailableReason: 'Current run details unavailable after recovery' }];
      result.diagnosticSummary = { totalEntries: 1, retainedEntries: 1, omittedEntries: 0, truncated: false, redacted: false };
    }
    if (!complete) {
      result.cleanup = { ...observed.cleanup, complete: false };
      result.errorCode = 'CLEANUP_INCOMPLETE';
      result.outcome = 'setup-failed';
      result.failureKinds = [...new Set<TestRunFailureKind>([...result.failureKinds, 'setup'])];
    } else result.cleanup = observed.cleanup;
    result.groupSnapshot = 'loaded';
    result.timeoutCount = current.timeoutCount;
    result.groupState = 'reconcile'; result.nextAction = 'reconcile';
    if (result.testKind === 'integration') { result.groupState = 'incomplete'; result.nextAction = 'complete-integration'; }
    if (!recorded) { current.lastResult = result; current.delivery = { runId: result.runId, pending: true, receiptId: null, returned: false, forwardedToMain: false }; }
    current.state = result.groupState!;
    if (complete) current.inFlight = null;
    tx.put(current); return current;
  });
}
function validatePolicy(policy: UnitTestPolicy): void {
  if (!policy || Object.values(policy).some(n => !Number.isSafeInteger(n) || n <= 0) || policy.optimizeAfterTimeouts >= policy.maxGroupTimeouts) failure('CONFIGURATION_INVALID');
}
export async function cleanupClosedTestRunGroups(activeChanges: readonly string[], context: TestRunContext, ports: TestRunPorts): Promise<void> {
  await ports.state.transaction(tx => {
    for (const project of Object.keys(context.projectWorkspaces)) {
      for (const group of tx.list(project, context.workspace)) if (!activeChanges.includes(group.key.group.split('/')[0]) && !group.inFlight && !group.delivery?.pending) tx.delete(group.key);
    }
  });
}

export function testRunFailureResult(request: TestRunRequest, context: TestRunContext, runId: string, now: number, config: unknown, error: unknown): TestRunResult {
  const result = emptyResult(request, context, runId, now);
  result.errorCode = (error as any)?.code ?? 'INVALID_ARGUMENT';
  result.stateAccess = (error as any)?.stateAccess ?? null;
  result.evidence = [];
  const configured = record(config) && record(config.phases) && record(config.hints) ? config as unknown as TestRunConfig : null;
  if (configured) {
    try { const diagnostics = new TestRunDiagnostics(configured.diagnostics, { workspace: context.workspace, qaHome: context.home, fixtureRoots: [] }); diagnostics.preflight(error); Object.assign(result, diagnostics.attach(result, result.environmentSummary)); } catch { }
  }
  if (!result.diagnostics.length) { result.diagnostics = [diagnosticConfigurationFailure(error) ?? { kind: 'preflight', test: null, errorCode: result.errorCode, message: `Preflight refused (${result.errorCode}); diagnostic configuration unavailable`, location: null, stack: [], redacted: false, truncated: false, unavailableReason: 'Valid diagnostic configuration unavailable' }]; result.diagnosticSummary = { totalEntries: 1, retainedEntries: 1, omittedEntries: 0, truncated: false, redacted: false }; }
  return attachHints(result, configured);
}
