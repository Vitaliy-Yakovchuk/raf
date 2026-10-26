import { resolve, relative, sep, isAbsolute } from 'node:path';

export type TestKind = 'unit' | 'integration';
export type TestId = { file: string; name: string };
export type TimeoutPolicy = { source: string; timeoutMs: number };
export type TestRunProfileFailure = Error & { code: string; pointer?: string; file?: string };
export type RawConfiguration = Record<string, unknown>;
export type SelectionRequest = {
  project: string;
  workspace: string;
  branch: string;
  phase: string;
  group: string;
  files?: string[];
  only?: TestId[];
};
export type InventoryFact = {
  file: string;
  exists: boolean;
  canonicalInsideWorkspace: boolean;
  kind: TestKind;
};
export type PreparedTestRun = {
  request: SelectionRequest;
  testKind: TestKind;
  profileId: string;
  selection: { files: string[]; testIds: TestId[] };
  command: { executable: string; argv: string[]; cwd: string };
  timeoutPolicy: TimeoutPolicy;
  unitPolicy: { optimizeAfterTimeouts: number; maxGroupTimeouts: number };
};
export type CallerAuthorization = { callerPhase: string; sourceChange: string; sourceItem: string };
export type InFlight = { runId: string; startedAtMs: number; deadlineMs: number; timeoutPolicy: TimeoutPolicy };
export type ActiveTestGroup = {
  key: { project: string; workspace: string; group: string };
  profileId: string;
  testKind?: TestKind;
  timeoutCount: number;
  knownRed: TestId[];
  unexecuted: TestId[];
  unknown: TestId[];
  inFlight: InFlight | null;
  lastFinalizedRunId?: string;
};
export type ReservationInput = { runId: string; nowMs: number; agentId: string; sha: string };
export type TestRunReservation = {
  plan: PreparedTestRun;
  authorization: CallerAuthorization;
  aggregate: ActiveTestGroup;
  run: InFlight;
  disposition: 'spawn' | 'reconcile';
};
export type ExecutionFacts = {
  outcome: 'passed' | 'assertions-failed' | 'setup-failed' | 'timed-out' | 'interrupted' | 'refused';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  protocolComplete: boolean;
  cleanup: { complete: boolean; remaining: string[] };
  passed: TestId[];
  knownRed: TestId[];
  unexecuted: TestId[];
  unknown: TestId[];
  failureKinds: string[];
  diagnostics: { kind: string; message: string; origin: string }[];
  diagnosticSummary: Record<string, unknown>;
  environmentSummary: Record<string, unknown>;
};
export type IntegrationContractResult = ExecutionFacts & {
  phase: string;
  callerPhase: string | null;
  testKind: TestKind | null;
  timeoutPolicy: TimeoutPolicy | null;
  selection: PreparedTestRun['selection'];
  command: PreparedTestRun['command'];
  groupState: string;
  nextAction: string;
  timeoutCount: number;
};
export type CompletionDecision = {
  result: IntegrationContractResult;
  aggregate: ActiveTestGroup;
  cliCode: number;
};
export type TestRunTransportEnvelope = { result: IntegrationContractResult; stderr: string; cliCode: number };

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function reject(code: string, pointer?: string, file?: string, reason?: string): never { throw Object.assign(new Error([code, pointer, file, reason].filter(Boolean).join(': ')), { code, ...(pointer ? { pointer } : {}), ...(file ? { file } : {}) }); }
const safe = (file: unknown): file is string => typeof file === 'string' && !!file && !isAbsolute(file) && !/^[A-Za-z]:|[\\*?\[\]{}\0]/.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('-'));
const equal = (left: readonly string[], right: readonly string[]) => left.length === right.length && new Set(left).size === left.length && left.every(file => right.includes(file));
const pointerToken = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const key = (id: TestId) => JSON.stringify([id.file, id.name]);
const unique = (ids: TestId[]) => [...new Map(ids.map(id => [key(id), id])).values()];
const contains = (ids: TestId[], id: TestId) => ids.some(other => key(other) === key(id));
export const profileTestKind = (profile: { testKind?: TestKind }): TestKind => profile.testKind ?? 'unit';
export const profileFiles = (profile: { testKind?: TestKind; unitFiles?: string[]; integrationFiles?: string[] }): string[] => (profileTestKind(profile) === 'integration' ? profile.integrationFiles : profile.unitFiles) ?? [];

export function testRunTimeoutPolicy(kind: TestKind, flow: RawConfiguration): TimeoutPolicy {
  const section = kind === 'integration' ? 'integrationTests' : 'unitTests';
  const source = `conf/flow.json#/${section}/timeoutMs`;
  if (!record(flow[section]) || !positive(flow[section].timeoutMs)) reject('CONFIGURATION_INVALID', source);
  return { source, timeoutMs: flow[section].timeoutMs };
}

export function validateProfileInventories(configuration: RawConfiguration, flow: RawConfiguration): void {
  if (!record(configuration.projects)) reject('CONFIGURATION_INVALID', 'conf/test-runs.json#/projects');
  for (const [projectId, project] of Object.entries(configuration.projects)) {
    const base = `conf/test-runs.json#/projects/${pointerToken(projectId)}`;
    if (!record(project) || !record(project.profiles) || !record(project.groups)) reject('CONFIGURATION_INVALID', base);
    const membership = new Set<string>();
    for (const [id, profile] of Object.entries(project.profiles)) {
      const pointer = `${base}/profiles/${pointerToken(id)}`;
      if (!record(profile)) reject('CONFIGURATION_INVALID', pointer);
      const kind = profileTestKind(profile);
      if (!['unit', 'integration'].includes(kind)) reject('CONFIGURATION_INVALID', `${pointer}/testKind`);
      const field = kind === 'unit' ? 'unitFiles' : 'integrationFiles';
      const other = kind === 'unit' ? 'integrationFiles' : 'unitFiles';
      if (Object.hasOwn(profile, other)) reject('CONFIGURATION_INVALID', `${pointer}/${other}`);
      const files = profile[field];
      if (!Array.isArray(files) || !files.length || files.some(file => !safe(file)) || new Set(files).size !== files.length) reject('CONFIGURATION_INVALID', `${pointer}/${field}`);
      for (const file of files) {
        if (membership.has(file)) reject('CONFIGURATION_INVALID', `${pointer}/${field}`, file);
        membership.add(file);
      }
      if (kind === 'integration') {
        if (!['node-test-events', 'vitest-events'].includes(profile.resultAdapter)) reject('CONFIGURATION_INVALID', `${pointer}/resultAdapter`);
        if (profile.resultAdapter === 'vitest-events' && (projectId !== 'etchly' || id !== 'vitest-worker-d1-integration')) reject('CONFIGURATION_INVALID', `${pointer}/resultAdapter`);
        if (profile.exactIds !== (profile.resultAdapter === 'vitest-events' ? 'vitest-test-name' : 'node-test-name')) reject('CONFIGURATION_INVALID', `${pointer}/exactIds`);
        if (profile.resultAdapter === 'vitest-events' && (projectId !== 'etchly' || id !== 'vitest-worker-d1-integration' || profile.cwd !== 'worker' || profile.argv?.join('\0') !== ['--import', '../scripts/shared-library-runtime.mjs', '../node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner', '--project', 'worker-d1-integration'].join('\0') || !profile.environment?.isolatedHome || !profile.environment?.stateOrigin)) reject('CONFIGURATION_INVALID', pointer);
        testRunTimeoutPolicy(kind, flow);
      }
    }
    for (const [id, preset] of Object.entries(project.groups)) {
      const pointer = `${base}/groups/${pointerToken(id)}`;
      if (!record(preset) || !project.profiles[preset.profileId] || !Array.isArray(preset.files) || !preset.files.length || new Set(preset.files).size !== preset.files.length) reject('CONFIGURATION_INVALID', pointer);
      for (const file of preset.files) if (!safe(file) || !profileFiles(project.profiles[preset.profileId]).includes(file)) reject('CONFIGURATION_INVALID', `${pointer}/files`, file, `group files must belong to profile ${profileTestKind(project.profiles[preset.profileId]) === 'unit' ? 'unitFiles' : 'integrationFiles'} (projects/${projectId}/groups/${id})`);
    }
  }
}

export function prepareTestRunProfile(configuration: RawConfiguration, flow: RawConfiguration, request: SelectionRequest, inventory: InventoryFact[]): PreparedTestRun {
  validateProfileInventories(configuration, flow);
  const project = (configuration.projects as Record<string, any>)[request.project];
  if (!project) reject('UNKNOWN_PROJECT');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(request.group) || request.group.split('/').some(part => part === '.' || part === '..')) reject('INVALID_GROUP');
  if (!(configuration.phases as any)?.[request.phase]?.allowed) reject('PHASE_NOT_ALLOWED');
  const integration = request.phase === 'integration';
  const preset = project.groups[request.group];
  if (integration && (!preset || request.only !== undefined)) reject('UNSAFE_SELECTION');
  if (request.files !== undefined && request.only !== undefined) reject('SELECTION_CONFLICT');
  const files: string[] = request.files ?? request.only?.map(id => id.file) ?? preset?.files ?? [];
  if (!files.length || files.some(file => !safe(file)) || new Set(files).size !== files.length) reject('UNSAFE_SELECTION');
  if (integration && !equal(files, preset.files)) reject('UNSAFE_SELECTION');
  const selectedFiles: string[] = integration ? [...preset.files] : files;
  const profiles = Object.entries(project.profiles).filter(([, profile]) => files.every(file => profileFiles(profile as any).includes(file)));
  if (profiles.length !== 1) reject('UNSAFE_SELECTION');
  const [profileId, profile] = profiles[0] as [string, any];
  const testKind = profileTestKind(profile);
  if (integration !== (testKind === 'integration') || integration && preset.profileId !== profileId) reject('PHASE_NOT_ALLOWED');
  for (const [id, profile] of Object.entries(project.profiles) as [string, any][]) for (const file of profileFiles(profile)) {
    const fact = inventory.find(fact => fact.file === file);
    const pointer = `conf/test-runs.json#/projects/${request.project}/profiles/${id}/${profileTestKind(profile) === 'unit' ? 'unitFiles' : 'integrationFiles'}`;
    if (request.project === 'raf' && !selectedFiles.includes(file) && !fact?.exists) continue;
    if (!fact?.exists || !fact.canonicalInsideWorkspace) reject(profileTestKind(profile) === 'integration' ? 'CONFIGURATION_INVALID' : 'INVENTORY_INCOMPLETE', pointer, file);
    if (fact.kind !== profileTestKind(profile)) reject('CONFIGURATION_INVALID', pointer, file);
  }
  const cwd = resolve(request.workspace, profile.cwd);
  if (cwd !== request.workspace && !cwd.startsWith(request.workspace + sep)) reject('UNSAFE_SELECTION');
  if (typeof profile.executable !== 'string' || !Array.isArray(profile.argv) || /^(?:.*\/)?(?:sh|bash|dash|zsh|fish|cmd|powershell)$/.test(profile.executable) || profile.argv.some((arg: string) => ['-e', '--eval', '-c', '--command'].includes(arg))) reject('CONFIGURATION_INVALID', `conf/test-runs.json#/projects/${request.project}/profiles/${profileId}/command`);
  const testIds = unique(request.only ?? []);
  const argv = [...profile.argv];
  if (testIds.length) {
    if (!profile.exactIds || testIds.some(id => !safe(id.file) || typeof id.name !== 'string' || !id.name.trim())) reject('INVALID_TEST_ID');
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    argv.push(`--test-name-pattern=^(?:${testIds.map(id => escape(id.name)).join('|')})$`);
  }
  const cwdFiles = selectedFiles.map(file => relative(cwd, resolve(request.workspace, file)));
  if (cwdFiles.some(file => !safe(file))) reject('UNSAFE_SELECTION');
  if (profile.resultAdapter === 'vitest-events') {
    const run = argv.indexOf('run');
    if (run < 1) reject('CONFIGURATION_INVALID', `conf/test-runs.json#/projects/${request.project}/profiles/${profileId}/argv`);
    argv.splice(run + 1, 0, ...cwdFiles);
  } else argv.push(...cwdFiles);
  return { request, testKind, profileId, selection: { files: [...selectedFiles], testIds }, command: { executable: profile.executable, argv, cwd }, timeoutPolicy: testRunTimeoutPolicy(testKind, flow), unitPolicy: flow.unitTests as PreparedTestRun['unitPolicy'] };
}

export function reserveTestRunProfile(plan: PreparedTestRun, authorization: CallerAuthorization, aggregate: ActiveTestGroup | null, input: ReservationInput): TestRunReservation {
  const identity = { project: plan.request.project, workspace: plan.request.workspace, group: plan.request.group };
  if (aggregate && (Object.keys(identity).some(field => (aggregate.key as any)[field] !== (identity as any)[field]) || aggregate.profileId !== plan.profileId || (aggregate.testKind ?? 'unit') !== plan.testKind)) reject('GROUP_PROFILE_MISMATCH');
  const group = structuredClone(aggregate ?? { key: identity, profileId: plan.profileId, testKind: plan.testKind, timeoutCount: 0, knownRed: [], unexecuted: [], unknown: [], inFlight: null });
  group.testKind = plan.testKind;
  if (group.inFlight) return { plan, authorization, aggregate: group, run: group.inFlight, disposition: 'reconcile' };
  if (plan.testKind === 'unit') {
    if (plan.selection.testIds.some(id => !contains(group.knownRed, id))) reject('UNKNOWN_RED_TEST');
    if (group.timeoutCount >= plan.unitPolicy.maxGroupTimeouts && !plan.selection.testIds.length) reject('GROUP_BUDGET_EXHAUSTED');
  }
  const run = { runId: input.runId, startedAtMs: input.nowMs, deadlineMs: input.nowMs + plan.timeoutPolicy.timeoutMs, timeoutPolicy: { ...plan.timeoutPolicy } };
  group.inFlight = run;
  return { plan, authorization, aggregate: group, run, disposition: 'spawn' };
}

export function completeTestRunProfile(reservation: TestRunReservation, execution: ExecutionFacts): CompletionDecision {
  const { plan, run } = reservation;
  const aggregate = structuredClone(reservation.aggregate);
  const finalized = aggregate.lastFinalizedRunId === run.runId;
  const confirmed = execution.protocolComplete && execution.cleanup.complete && !execution.cleanup.remaining.length && !execution.timedOut && execution.outcome !== 'interrupted';
  const passed = confirmed ? execution.passed : [];
  aggregate.knownRed = unique([...aggregate.knownRed.filter(id => !contains(passed, id)), ...execution.knownRed]);
  aggregate.unexecuted = unique([...aggregate.unexecuted.filter(id => !contains([...passed, ...execution.knownRed], id)), ...execution.unexecuted]);
  aggregate.unknown = unique([...aggregate.unknown.filter(id => !contains(passed, id)), ...execution.unknown]);
  if (!finalized && execution.timedOut) aggregate.timeoutCount++;
  aggregate.lastFinalizedRunId = run.runId;
  if (execution.cleanup.complete && !execution.cleanup.remaining.length) aggregate.inFlight = null;
  let outcome = execution.outcome;
  const complete = outcome === 'passed' && confirmed && !execution.timedOut && execution.exitCode === 0 && !execution.signal && passed.length > 0 && !aggregate.knownRed.length && !aggregate.unexecuted.length && !aggregate.unknown.length && plan.selection.files.every(file => passed.some(id => id.file === file));
  if (outcome === 'passed' && !complete) outcome = aggregate.knownRed.length ? 'assertions-failed' : 'setup-failed';
  let groupState = complete ? 'complete' : 'idle', nextAction = complete ? 'complete' : 'fix-implementation';
  if (plan.testKind === 'integration' && !complete) { groupState = 'incomplete'; nextAction = 'complete-integration'; }
  else if (!complete && aggregate.timeoutCount >= plan.unitPolicy.maxGroupTimeouts) { groupState = aggregate.knownRed.length ? 'confirm-known-red' : 'unverified-remainder'; nextAction = aggregate.knownRed.length ? 'confirm-known-red' : 'review-remainder'; }
  else if (!complete && aggregate.timeoutCount >= plan.unitPolicy.optimizeAfterTimeouts) { groupState = 'optimize'; nextAction = 'optimize'; }
  else if (!complete && outcome === 'setup-failed') nextAction = 'fix-setup';
  else if (!complete && outcome === 'timed-out') nextAction = plan.request.phase === 'red' ? 'implement' : 'retry';
  const result = { ...execution, outcome, knownRed: aggregate.knownRed, unexecuted: aggregate.unexecuted, unknown: aggregate.unknown, phase: plan.request.phase, callerPhase: reservation.authorization.callerPhase, testKind: plan.testKind, timeoutPolicy: { ...run.timeoutPolicy }, selection: plan.selection, command: plan.command, groupState, nextAction, timeoutCount: aggregate.timeoutCount };
  return { result, aggregate, cliCode: complete ? 0 : 1 };
}

export function testRunTransportDeadline(reservation: TestRunReservation, readinessTimeoutMs: number): number {
  return reservation.run.deadlineMs;
}

export async function relayTestRunProfileResult(reservation: TestRunReservation, exchange: (deadlineMs: number) => Promise<TestRunTransportEnvelope>): Promise<TestRunTransportEnvelope> {
  return await exchange(testRunTransportDeadline(reservation, 0));
}
