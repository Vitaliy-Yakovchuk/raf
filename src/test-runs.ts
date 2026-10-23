import { resourceEstimateInvalidPointer, type ResourceEstimateValues } from './resource-estimates.ts';
import { TestRunDiagnostics, diagnosticConfigurationFailure, rejectTestRunConfiguration, validateDiagnosticLimits, validateRunTemporaryConfiguration } from './test-run-diagnostics.ts';
import type { DiagnosticLimits, DiagnosticAttachment, InlineDiagnostic, DiagnosticEnvironmentSummary, RunTemporaryConfiguration, RunTemporaryReservation } from './test-run-diagnostics.ts';
import { parseCommandArguments } from './cli-arguments.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type TestRunOutcome = 'passed' | 'assertions-failed' | 'setup-failed' | 'timed-out' | 'interrupted' | 'refused' | 'unverified-remainder';
export type TestRunFailureKind = 'refusal' | 'setup' | 'assertions' | 'timeout' | 'interruption';
export type TestRunNextAction = 'complete' | 'fix-setup' | 'implement' | 'fix-implementation' | 'optimize' | 'confirm-known-red' | 'review-remainder' | 'retry' | 'reconcile';

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
  phase: string;
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
  unitFiles: string[];
  exactIds: 'node-test-name' | 'vitest-test-name' | null;
  resultAdapter: 'node-test-events' | 'vitest-events';
  environment: { isolatedHome: boolean; stateOrigin: boolean };
  checks: string[];
}

export interface TestRunConfig {
  diagnostics: DiagnosticLimits;
  temporaryArtifacts: RunTemporaryConfiguration;
  phases: Record<string, { allowed: boolean; purpose: 'initial-red' | 'verification' | 'none'; hints: Record<TestRunFailureKind, string> }>;
  hints: Record<string, string>;
  projects: Record<string, {
    profiles: Record<string, TestRunProfile>;
    groups: Record<string, { profileId: string; files: string[] }>;
  }>;
}

export interface TestRunContext {
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
}

export interface TestRunEnvironment {
  canonicalWorkspace: string;
  canonicalCwd: string;
  gitIdentityMatches: boolean;
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
  files: Record<string, TestFileFact>;
}

export interface TestRunCommand {
  executable: string;
  argv: string[];
  cwd: string;
  shell: false;
  environment: { HOME: string; statePath: string; tmpPath: string; testIds?: TestId[]; TMPDIR?: string; vitestBatches?: TestRunCommand[] };
}

export interface TestRunPlan {
  request: TestRunRequest;
  workspace: string;
  profileId: string;
  selection: { files: string[]; testIds: TestId[] };
  command: TestRunCommand;
}

export type RunnerEvent =
  | { kind: 'discovered'; test: TestId; parent?: TestId }
  | { kind: 'container-complete'; test: TestId }
  | { kind: 'passed' | 'assertion-failed' | 'setup-failed'; test: TestId; diagnostic?: string; inlineDiagnostic?: InlineDiagnostic }
  | { kind: 'complete'; expected: TestId[]; adapter?: 'vitest-events' }
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
  groupState: 'idle' | 'running' | 'optimize' | 'confirm-known-red' | 'unverified-remainder' | 'reconcile' | 'complete';
  timeoutCount: number;
  nextAction: TestRunNextAction;
  hintIds: string[];
  hints: string[];
  evidence: string[];
  errorCode?: string;
}

export interface TestRunGroupKey {
  project: string;
  workspace: string;
  group: string;
}

export interface TestRunGroup {
  key: TestRunGroupKey;
  timeoutCount: number;
  state: TestRunResult['groupState'];
  selection: TestRunPlan['selection'];
  knownRed: TestId[];
  unexecuted: TestId[];
  inFlight: { runId: string; deadlineMs: number; processIdentity: string | null; temporary?: RunTemporaryReservation } | null;
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
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
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
      required: ['project', 'phase', 'group'].includes(name),
    })),
  });
  if ('error' in parsed) return failure(parsed.error.code === 'UNKNOWN_ARGUMENT' ? 'INVALID_ARGUMENT' : parsed.error.code, `${parsed.error.details.parameter ?? ''}: ${parsed.error.message}`);
  const { params } = parsed;
  for (const [name, value] of Object.entries(params)) if (![value].flat().every(text)) failure('MISSING_VALUE', `--${name}`);
  if (params.files && params.only) failure('SELECTION_CONFLICT');
  return { ...params } as unknown as ParsedTestRunArgs;
}

export function validateTestRunConfig(config: unknown, phases: readonly string[], policy: UnitTestPolicy): TestRunConfig {
  const invalid = (field: string): never => rejectTestRunConfiguration(`CONFIGURATION_INVALID: ${field}`);
  if (!record(policy) || (['timeoutMs', 'optimizeAfterTimeouts', 'maxGroupTimeouts'] as const).some(key => !Number.isSafeInteger(policy[key]) || policy[key] <= 0) || policy.optimizeAfterTimeouts >= policy.maxGroupTimeouts) invalid('conf/flow.json#/unitTests');
  if (!record(config) || !record(config.phases) || !record(config.hints) || !record(config.projects)) return invalid('conf/test-runs.json');
  validateDiagnosticLimits(config.diagnostics);
  validateRunTemporaryConfiguration(config.temporaryArtifacts);
  for (const [id, value] of Object.entries(config.hints)) if (!text(id) || !text(value)) invalid(`hints/${id}`);
  if (Object.keys(config.phases).some(id => !phases.includes(id))) invalid('phases');
  for (const id of phases) {
    const phase = config.phases[id];
    if (!record(phase) || typeof phase.allowed !== 'boolean' || !['initial-red', 'verification', 'none'].includes(phase.purpose) || !record(phase.hints)) invalid(`phases/${id}`);
    if (phase.allowed && phase.purpose === 'none' || !phase.allowed && phase.purpose !== 'none') invalid(`phases/${id}/purpose`);
    if (id === 'test-scaffold' && phase.allowed || id === 'red' && (!phase.allowed || phase.purpose !== 'initial-red')) invalid(`phases/${id}/allowed`);
    for (const kind of kinds) if (!text(phase.hints[kind]) || !text(config.hints[phase.hints[kind]])) invalid(`phases/${id}/hints/${kind}`);
  }
  for (const [projectId, project] of Object.entries(config.projects)) {
    if (!record(project) || !record(project.profiles) || !Object.keys(project.profiles).length || !record(project.groups)) invalid(`projects/${projectId}`);
    for (const [id, profile] of Object.entries(project.profiles) as [string, any][]) {
      if (!record(profile) || Object.keys(profile).some(key => !['cwd', 'executable', 'argv', 'unitFiles', 'exactIds', 'resultAdapter', 'environment', 'checks', 'resourceEstimate'].includes(key)) || !text(profile.cwd) || (profile.cwd !== '.' && !safeFile(profile.cwd)) || !text(profile.executable) || !strings(profile.argv) || !strings(profile.unitFiles) || !profile.unitFiles.length || profile.unitFiles.some((f: string) => !safeFile(f)) || new Set(profile.unitFiles).size !== profile.unitFiles.length || !['node-test-name', 'vitest-test-name', null].includes(profile.exactIds) || !['node-test-events', 'vitest-events'].includes(profile.resultAdapter) || (profile.resultAdapter === 'vitest-events') !== (profile.exactIds === 'vitest-test-name') || !record(profile.environment) || typeof profile.environment.isolatedHome !== 'boolean' || typeof profile.environment.stateOrigin !== 'boolean' || !strings(profile.checks)) invalid(`projects/${projectId}/profiles/${id}`);
      if (profile.resultAdapter === 'vitest-events' && (profile.executable !== 'node' && !/\/node$/.test(profile.executable) || !profile.argv.includes('run') || profile.argv.includes('--passWithNoTests'))) invalid(`projects/${projectId}/profiles/${id}/command`);
      if (Object.hasOwn(profile, 'resourceEstimate')) {
        const problem = resourceEstimateInvalidPointer(profile.resourceEstimate, `conf/test-runs.json#/projects/${projectId.replaceAll('~', '~0').replaceAll('/', '~1')}/profiles/${id.replaceAll('~', '~0').replaceAll('/', '~1')}/resourceEstimate`);
        if (problem) invalid(problem);
      }
      if (/^(?:.*\/)?(?:sh|bash|dash|zsh|fish|cmd|powershell)$/.test(profile.executable) || profile.argv.some((arg: string) => ['-e', '--eval', '-c', '--command'].includes(arg))) invalid(`projects/${projectId}/profiles/${id}/command`);
    }
    for (const [id, preset] of Object.entries(project.groups) as [string, any][]) {
      if (!record(preset) || !project.profiles[preset.profileId] || !strings(preset.files) || !preset.files.length) invalid(`projects/${projectId}/groups/${id}`);
      if (preset.files.some((f: string) => !project.profiles[preset.profileId].unitFiles.includes(f))) invalid(`projects/${projectId}/groups/${id}: group files must belong to profile unitFiles`);
    }
  }
  return config as unknown as TestRunConfig;
}

function refuseFullUnitSuite(request: TestRunRequest, config: TestRunConfig): void {
  const project = config.projects[request.project];
  if (!project || request.only !== undefined) return;
  const preset = project.groups[request.group] ?? project.groups[request.group.slice(request.group.indexOf('/') + 1)];
  const files = [...new Set(request.files ?? preset?.files ?? [])];
  const inventory = [...new Set(Object.values(project.profiles).flatMap(profile => profile.unitFiles))];
  if (inventory.length && inventory.length === files.length && inventory.every(file => files.includes(file))) failure('UNSAFE_SELECTION', 'Full unit suite selection is refused; select a targeted subset');
}

export function planTestRun(request: TestRunRequest, config: TestRunConfig, context: TestRunContext, env: TestRunEnvironment): TestRunPlan {
  if (!context.agentPhases.includes(request.phase) || !config.phases[request.phase]) failure('UNKNOWN_PHASE');
  if (!config.phases[request.phase].allowed) failure('PHASE_NOT_ALLOWED');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(request.group) || request.group.split('/').some(x => x === '..' || x === '.')) failure('INVALID_GROUP');
  if (!context.activeChanges.includes(request.group.split('/')[0])) failure('INACTIVE_CHANGE');
  const project = config.projects[request.project];
  if (!project || !context.projectWorkspaces[request.project]?.includes(context.workspace)) failure('UNKNOWN_PROJECT');
  refuseFullUnitSuite(request, config);
  if (env.canonicalWorkspace !== context.workspace || env.canonicalCwd !== context.cwd || !env.gitIdentityMatches || context.cwd !== context.workspace) failure('WORKSPACE_MISMATCH');
  for (const key of ['runtimeAvailable', 'localRunnerAvailable', 'dependenciesAvailable', 'resultAdapterAvailable', 'artifactsWritable', 'treeControlSupported'] as const) if (!env[key]) failure('ENVIRONMENT_INVALID', key);
  if (env.stateAliasesOperational || env.tmpAliasesOperational || env.inheritedOperationalChannel) failure('STATE_CONTEXT_REFUSED');
  if (request.files !== undefined && request.only !== undefined) failure('SELECTION_CONFLICT');
  if (request.files?.length === 0 || request.only?.length === 0) failure('EMPTY_SELECTION');
  if (request.only?.some(id => !record(id) || !safeFile(id.file) || !text(id.name))) failure('INVALID_TEST_ID');
  const preset = project.groups[request.group] ?? project.groups[request.group.slice(request.group.indexOf('/') + 1)];
  if (request.project === 'etchly' && !project.groups[request.group]) failure('CALLER_UNAUTHORIZED', `Group ${request.group} is not configured`);
  const files = [...new Set(request.files ?? request.only?.map(id => id.file) ?? preset?.files ?? [])];
  if (!files.length) failure('EMPTY_SELECTION');
  if (files.some(file => !safeFile(file))) failure('UNSAFE_SELECTION');
  const configuredInventory = [...new Set(Object.values(project.profiles).flatMap(p => p.unitFiles))];
  const missing = configuredInventory.filter(file => !env.unitFiles.includes(file) || env.files[file]?.kind !== 'file');
  const unexpected = env.unitFiles.filter(file => !configuredInventory.includes(file));
  if (missing.length || unexpected.length) {
    const pointers = Object.entries(project.profiles).filter(([, profile]) => profile.unitFiles.some(file => missing.includes(file)) || unexpected.length).map(([id]) => `conf/test-runs.json#/projects/${request.project}/profiles/${id}/unitFiles`);
    failure('INVENTORY_INCOMPLETE', `Unit inventory differs; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}. Reconcile ${pointers.join(', ')} and conf/test-runs.json#/projects/${request.project}/groups with the intended unit files: restore missing files or remove stale entries; explicitly register intended new files. No automatic discovery or inventory edits were performed.`);
  }
  for (const file of files) if (!configuredInventory.includes(file) || env.files[file]?.unit === false) failure('UNSAFE_SELECTION', `Non-unit file ${file}: excluded by unit include/classification; reconcile conf/test-runs.json#/projects/${request.project}/profiles`);
  if (request.project === 'etchly' && files.some(file => !preset!.files.includes(file))) failure('CALLER_UNAUTHORIZED', `Selection is outside configured group ${request.group}: ${files.join(', ')}`);
  const profiles = Object.entries(project.profiles).filter(([, profile]) => files.every(file => profile.unitFiles.includes(file)));
  if (profiles.length !== 1) failure('PROFILE_AMBIGUOUS', 'Selection must belong to one configured profile');
  const [profileId, profile] = profiles[0];
  if (!request.files && !request.only && preset?.profileId !== profileId) failure('PROFILE_AMBIGUOUS');
  const cwd = resolve(context.workspace, profile.cwd);
  if (!inside(cwd, context.workspace)) failure('WORKSPACE_MISMATCH');
  if (profile.environment.isolatedHome && (!env.isolatedHome || context.home === context.operationalHome) || profile.environment.stateOrigin && !env.stateOriginAllowed) failure('STATE_CONTEXT_REFUSED');
  for (const file of files) {
    const fact = env.files[file];
    if (!fact || fact.kind !== 'file' || !fact.unit || !env.unitFiles.includes(file) || !inside(fact.realpath, cwd) || fact.realpath !== resolve(context.workspace, file)) failure('UNSAFE_SELECTION', `File ${file}: directory or symlink outside canonical workspace ${context.workspace}`);
  }
  const testIds = uniqueIds(request.only ?? []);
  if (testIds.length && !['node-test-name', 'vitest-test-name'].includes(profile.exactIds ?? '')) failure('EXACT_IDS_UNSUPPORTED');
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const argv = [...profile.argv];
  if (testIds.length && profile.resultAdapter === 'node-test-events') argv.push(`--test-name-pattern=^(?:${testIds.map(id => escape(id.name)).join('|')})$`);
  if (profile.resultAdapter === 'vitest-events') {
    const run = argv.indexOf('run');
    if (run < 0) failure('CONFIGURATION_INVALID', 'Vitest run required');
    argv.splice(run + 1, 0, ...files.map(file => relative(cwd, resolve(context.workspace, file))));
  } else argv.push(...files.map(file => relative(cwd, resolve(context.workspace, file))));
  return { request, workspace: context.workspace, profileId, selection: { files, testIds },
    command: { executable: profile.executable, argv, cwd, shell: false, environment: { HOME: context.home, statePath: context.statePath, tmpPath: context.tmpPath, ...(testIds.length ? { testIds } : {}) } } };
}

export function classifyRunnerResult(events: readonly RunnerEvent[], exit: ChildExit): RunnerClassification {
  let passed: TestId[] = [], knownRed: TestId[] = [], unknown: TestId[] = [], expected: TestId[] = [];
  const completedContainers: TestId[] = [];
  let complete = false, setup = false, vitest = false;
  for (const event of events) {
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
  return { diagnostics: [], diagnosticSummary: { totalEntries: 0, retainedEntries: 0, omittedEntries: 0, truncated: false, redacted: false }, environmentSummary: unavailableEnvironment(context), runId, project: request.project, workspace: context.workspace, phase: request.phase, group: request.group, profileId: null,
    selection: { files: request.files ?? [], testIds: request.only ?? [] }, command: null, startedAt: new Date(now).toISOString(), durationMs: 0,
    exitCode: null, signal: null, timedOut: false, cleanup: { complete: true, remainingPids: [] }, outcome: 'refused', failureKinds: ['refusal'],
    passed: [], knownRed: [], unexecuted: [], unknown: [], removed: [], groupState: 'idle', timeoutCount: 0, nextAction: 'fix-setup', hintIds: [], hints: [], evidence: [] };
}
function attachHints(result: TestRunResult, config: TestRunConfig | null): TestRunResult {
  const phase = config?.phases[result.phase];
  result.hintIds = [...new Set(result.failureKinds.map(kind => phase?.hints?.[kind]).filter((v): v is string => typeof v === 'string' && typeof config?.hints[v] === 'string'))];
  result.hints = result.hintIds.map(id => config!.hints[id]);
  return result;
}
function groupState(group: TestRunGroup, policy: UnitTestPolicy): TestRunResult['groupState'] {
  return group.timeoutCount >= policy.maxGroupTimeouts ? group.knownRed.length ? 'confirm-known-red' : 'unverified-remainder' : group.timeoutCount >= policy.optimizeAfterTimeouts ? 'optimize' : 'idle';
}

export async function runTestRun(request: TestRunRequest, configInput: unknown, policy: UnitTestPolicy, context: TestRunContext, ports: TestRunPorts): Promise<TestRunResult> {
  const started = ports.clock.now();
  const result = emptyResult(request, context, ports.newRunId(), started);
  let config: TestRunConfig | null = null, plan: TestRunPlan;
  let diagnostics: TestRunDiagnostics | null = null;
  const attach = () => {
    if (diagnostics) Object.assign(result, diagnostics.attach(result, ports.diagnosticEnvironment?.(result.command) ?? result.environmentSummary));
    return attachHints(result, config);
  };
  try {
    diagnostics = new TestRunDiagnostics((configInput as TestRunConfig)?.diagnostics, { workspace: context.workspace, qaHome: context.home, fixtureRoots: [] });
    config = validateTestRunConfig(configInput, context.agentPhases, policy);
    if (!context.agentPhases.includes(request.phase)) failure('UNKNOWN_PHASE');
    if (!config.phases[request.phase].allowed) failure('PHASE_NOT_ALLOWED');
    refuseFullUnitSuite(request, config);
    plan = planTestRun(request, config, context, await ports.preflight(context));
  } catch (error) {
    result.errorCode = (error as any)?.code ?? 'ENVIRONMENT_INVALID';
    if (['ENVIRONMENT_INVALID', 'STATE_CONTEXT_REFUSED'].includes(result.errorCode!)) { result.outcome = 'setup-failed'; result.failureKinds = ['setup']; }
    if (!diagnostics) return testRunFailureResult(request, context, result.runId, started, configInput, error);
    diagnostics.preflight(error);
    result.evidence = [];
    return attach();
  }
  result.profileId = plan.profileId; result.selection = plan.selection; result.command = plan.command;
  const key = { project: request.project, workspace: context.workspace, group: request.group };
  const deadline = started + policy.timeoutMs;
  let reserved: TestRunGroup | null = null;
  try {
    await ports.state.transaction(tx => {
      let group = tx.get(key);
      if (group) {
        result.timeoutCount = group.timeoutCount; result.knownRed = group.knownRed; result.unexecuted = group.unexecuted;
      }
      for (const other of tx.list(key.project, key.workspace)) {
        if (other.key.group === key.group || other.key.group.split('/')[0] !== key.group.split('/')[0]) continue;
        const overlap = plan.selection.files.filter(file => other.selection.files.includes(file));
        if (overlap.length) failure('GROUP_RENAME_REFUSED', `Files ${overlap.join(', ')} already belong to ${other.key.group}. Continue with --group ${other.key.group}. To release or reassign the selection, ask main to reconcile the existing group's selection, preserving timeoutCount and knownRed; do not rename the group or reset its state.`);
      }
      if (group?.inFlight) failure('GROUP_IN_FLIGHT');
      if (request.only && (!group || request.only.some(id => !containsId(group!.knownRed, id)))) failure('UNKNOWN_RED_TEST');
      group ??= { key, timeoutCount: 0, state: 'idle', selection: plan.selection, knownRed: [], unexecuted: [], inFlight: null, lastResult: null };
      result.timeoutCount = group.timeoutCount; result.knownRed = group.knownRed; result.unexecuted = group.unexecuted;
      if (group.timeoutCount >= policy.maxGroupTimeouts && !request.only) {
        result.groupState = groupState(group, policy);
        if (!group.knownRed.length) { result.outcome = 'unverified-remainder'; result.failureKinds = []; result.nextAction = 'review-remainder'; }
        else { result.errorCode = 'GROUP_BUDGET_EXHAUSTED'; result.nextAction = 'confirm-known-red'; }
        return;
      }
      group.selection = plan.selection; group.state = 'running'; group.inFlight = { runId: result.runId, deadlineMs: deadline, processIdentity: null };
      tx.put(group); reserved = group;
    });
  } catch (error) {
    result.errorCode = (error as any)?.code ?? 'STATE_FAILED';
    if (result.errorCode === 'STATE_FAILED') { result.outcome = 'setup-failed'; result.failureKinds = ['setup']; }
    if (result.errorCode === 'GROUP_IN_FLIGHT') {
      result.groupState = 'reconcile'; result.nextAction = 'reconcile';
      try { await reconcileTestRunGroup(key, policy, context, ports); }
      catch (recoveryError) {
        result.outcome = 'setup-failed'; result.failureKinds = ['setup']; result.errorCode = 'STATE_FAILED';
        diagnostics?.preflight(recoveryError);
      }
    }
    diagnostics?.preflight(error);
    result.evidence = [];
    return attach();
  }
  if (!reserved) return attach();
  const events: RunnerEvent[] = [];
  let temporary: RunTemporaryReservation | undefined;
  const onEvent = (event: RunnerEvent) => {
    if ('inlineDiagnostic' in event && event.inlineDiagnostic) diagnostics?.inline(event.inlineDiagnostic);
    else if (event.kind === 'protocol-error') diagnostics?.protocolError(event.diagnostic);
    else if (event.kind === 'assertion-failed' || event.kind === 'setup-failed') diagnostics?.failure({ test: event.test, origin: event.kind === 'assertion-failed' ? 'test-body' : 'unknown', error: event.diagnostic });
    if ('diagnostic' in event || 'inlineDiagnostic' in event) { const { diagnostic, inlineDiagnostic, ...facts } = event as any; events.push(facts as RunnerEvent); }
    else events.push(event);
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
      temporary = await ports.prepareTemporary(result.runId, context, async reservation => { await ports.state.transaction(tx => { const group = tx.get(key); if (!group?.inFlight || group.inFlight.runId !== result.runId) return failure('RESERVATION_LOST'); group.inFlight.temporary = reservation; tx.put(group); }); });
      plan.command.environment.TMPDIR = temporary.temporary.path;
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
    if (ports.clock.now() >= deadline && reason === 'exit') reason = 'timeout';
    result.cleanup = await child.cleanup(deadline, reason);
    if (reason !== 'exit' && result.cleanup.complete) exit = await child.wait();
    }
  } catch (error) {
    diagnostics?.failure({ test: null, origin: 'fixture-setup', error });
    result.errorCode = (error as any)?.code ?? 'RUNNER_SETUP_FAILED';
    events.push({ kind: 'protocol-error', diagnostic: '' });
    if (child) {
      try { result.cleanup = await child.cleanup(deadline, 'interruption'); } catch { result.cleanup = { complete: false, remainingPids: [] }; }
    }
  } finally { cancelDeadline(); unsubscribe(); }
  if (temporary && ports.cleanupTemporary) {
    try { const cleaned = await ports.cleanupTemporary(temporary, result.cleanup.complete); if (cleaned.diagnostic) diagnostics?.inline(cleaned.diagnostic); if (cleaned.cleanup !== 'complete') result.cleanup.complete = false; }
    catch (error) { diagnostics?.failure({ test: null, origin: 'fixture-setup', error }); result.cleanup.complete = false; }
  }
  diagnostics?.stderrChunk(Buffer.from(exit.stderr));
  if (exit.stderrTruncated) diagnostics?.markStderrTruncated();
  if (child && reason === 'exit') diagnostics?.childExit({ ...exit, validProtocol: events.some(e => e.kind === 'complete') && !events.some(e => e.kind === 'protocol-error') });
  const classified = classifyRunnerResult(events, exit);
  Object.assign(result, classified, { exitCode: exit.exitCode, signal: interruption ?? exit.signal, timedOut: reason === 'timeout', durationMs: ports.clock.now() - started });
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
    const removed = (id: TestId) => completeCollection && plan.selection.files.includes(id.file) && !containsId(collected, id);
    result.removed = uniqueIds([...group.knownRed, ...group.unexecuted].filter(removed));
    group.knownRed = uniqueIds([...group.knownRed.filter(id => !removed(id) && (!events.some(event => event.kind === 'complete') || events.some(event => event.kind === 'protocol-error') || !containsId(result.passed, id))), ...result.knownRed]);
    result.knownRed = group.knownRed;
    result.unexecuted = uniqueIds([...group.unexecuted.filter(id => !removed(id) && !containsId([...result.passed, ...result.knownRed], id)), ...result.unexecuted, ...(request.only ?? []).filter(id => !containsId([...result.passed, ...classified.knownRed], id))]);
    group.unexecuted = result.unexecuted;
    if (result.timedOut) group.timeoutCount++;
    result.timeoutCount = group.timeoutCount;
    result.groupState = !result.cleanup.complete ? 'reconcile' : groupState(group, policy);
    if (result.outcome === 'passed' && result.knownRed.length) { result.outcome = 'assertions-failed'; result.failureKinds.push('assertions'); }
    if (result.outcome === 'passed' && (result.unexecuted.length || result.unknown.length)) { result.outcome = group.timeoutCount >= policy.maxGroupTimeouts ? 'unverified-remainder' : 'setup-failed'; }
    if (result.outcome === 'passed' && !result.unexecuted.length && !result.unknown.length && !result.knownRed.length) result.groupState = 'complete';
    if (!result.cleanup.complete) result.nextAction = 'reconcile';
    else if (result.failureKinds.includes('setup')) result.nextAction = 'fix-setup';
    else if (result.outcome === 'interrupted') result.nextAction = 'retry';
    else if (result.groupState === 'confirm-known-red') result.nextAction = 'confirm-known-red';
    else if (result.groupState === 'unverified-remainder') result.nextAction = 'review-remainder';
    else if (result.groupState === 'optimize' && result.timedOut) result.nextAction = 'optimize';
    else if (result.outcome === 'passed') result.nextAction = 'complete';
    else if (config!.phases[request.phase].purpose === 'initial-red') result.nextAction = 'implement';
    else result.nextAction = result.timedOut ? 'retry' : 'fix-implementation';
    attachHints(result, config);
    group.state = result.groupState;
    if (result.cleanup.complete) group.inFlight = null;
    attach();
    group.lastResult = result; tx.put(group);
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
  const temporaryCleanup = group.inFlight.temporary && ports.cleanupTemporary ? await ports.cleanupTemporary(group.inFlight.temporary, !observed.alive && observed.cleanup.complete) : null;
  return ports.state.transaction(tx => {
    const current = tx.get(key);
    if (!current?.inFlight || current.inFlight.runId !== group.inFlight!.runId) return current;
    if (observed.alive) return current;
    const complete = observed.cleanup.complete && temporaryCleanup?.cleanup !== 'incomplete';
    const flight = current.inFlight;
    const recorded = current.lastResult?.runId === flight.runId;
    if (observed.deadlineReached && !recorded) current.timeoutCount++;
    const result = recorded ? current.lastResult! : emptyResult({ project: key.project, phase: 'recovery', group: key.group, files: current.selection.files }, context, flight.runId, flight.deadlineMs - policy.timeoutMs);
    if (!recorded) {
      result.outcome = observed.deadlineReached ? 'timed-out' : 'setup-failed';
      result.timedOut = observed.deadlineReached;
      result.failureKinds = observed.deadlineReached ? ['timeout'] : ['setup'];
      result.knownRed = current.knownRed;
      result.unexecuted = current.unexecuted;
      result.diagnostics = [{ kind: 'runner', test: null, message: 'Recovery lost current run diagnostic details', location: null, stack: [], redacted: false, truncated: false, unavailableReason: 'Current run details unavailable after recovery' }];
      result.diagnosticSummary = { totalEntries: 1, retainedEntries: 1, omittedEntries: 0, truncated: false, redacted: false };
    }
    if (!complete) {
      result.cleanup = { ...observed.cleanup, complete: false };
      result.errorCode = 'CLEANUP_INCOMPLETE';
      result.outcome = 'setup-failed';
      result.failureKinds = [...new Set<TestRunFailureKind>([...result.failureKinds, 'setup'])];
    } else result.cleanup = observed.cleanup;
    result.timeoutCount = current.timeoutCount;
    result.groupState = 'reconcile'; result.nextAction = 'reconcile';
    current.lastResult = result; current.state = 'reconcile';
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
      for (const group of tx.list(project, context.workspace)) if (!activeChanges.includes(group.key.group.split('/')[0]) && !group.inFlight) tx.delete(group.key);
    }
  });
}

export function testRunFailureResult(request: TestRunRequest, context: TestRunContext, runId: string, now: number, config: unknown, error: unknown): TestRunResult {
  const result = emptyResult(request, context, runId, now);
  result.errorCode = (error as any)?.code ?? 'INVALID_ARGUMENT';
  result.evidence = [];
  const configured = record(config) && record(config.phases) && record(config.hints) ? config as unknown as TestRunConfig : null;
  if (configured) {
    try { const diagnostics = new TestRunDiagnostics(configured.diagnostics, { workspace: context.workspace, qaHome: context.home, fixtureRoots: [] }); diagnostics.preflight(error); Object.assign(result, diagnostics.attach(result, result.environmentSummary)); } catch { }
  }
  if (!result.diagnostics.length) { result.diagnostics = [diagnosticConfigurationFailure(error) ?? { kind: 'preflight', test: null, errorCode: result.errorCode, message: `Preflight refused (${result.errorCode}); diagnostic configuration unavailable`, location: null, stack: [], redacted: false, truncated: false, unavailableReason: 'Valid diagnostic configuration unavailable' }]; result.diagnosticSummary = { totalEntries: 1, retainedEntries: 1, omittedEntries: 0, truncated: false, redacted: false }; }
  return attachHints(result, configured);
}
