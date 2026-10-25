import { isAbsolute, posix, resolve } from 'node:path';
import ts from 'typescript';

export type WorkerTestClass = 'unit' | 'integration' | 'harness' | 'd1' | 'plan-d1';

export interface IntegrationProfileContract {
  testKind?: 'unit' | 'integration';
  cwd: string;
  executable: string;
  argv: string[];
  exactIds: string | null;
  resultAdapter: string;
  unitFiles?: string[];
  integrationFiles?: string[];
  environment: { isolatedHome: boolean; stateOrigin: boolean };
  checks: string[];
}

export interface InventoryObservation {
  existingFiles: string[];
  classifiedFiles: Record<string, WorkerTestClass>;
  sourceHashes: Record<string, string>;
  expectedSourceHashes: Record<string, string>;
}

export interface ContractFailure {
  errorCode: string;
  pointer: string;
  files: string[];
  reason: string;
}

export interface IntegrationSelection {
  profileId: string;
  files: string[];
}

export interface IntegrationBudget {
  source: string;
  timeoutMs: number;
  deadline: number;
}

export interface EtchlyCommandPlan {
  cwd: string;
  executable: string;
  argv: string[];
  selectedFiles: string[];
  timeoutPolicy: { source: string; timeoutMs: number };
  deadline: number;
  transportDeadline: number;
}

export interface EtchlyEnvironmentObservation {
  missingChecks: string[];
  executableRuntime: boolean;
  compatibleBridge: boolean;
  sharedLibsBranchMatches: boolean;
  resourceProtocolInstalled: boolean;
  localBuildValid: boolean;
  privateTmpWritable: boolean;
  loopbackAvailable: boolean;
  isolatedHome: string;
  operationalHome: string;
  stateOriginVerified: boolean;
  privateRunRoot: string;
  inheritedEnv: Record<string, string>;
}

export interface EtchlyEnvironmentPlan {
  env: Record<string, string>;
  ownedPaths: string[];
}

export interface EtchlyCaller {
  phase: string;
  project: string;
  workspace: string;
  branch: string;
  activeChanges: string[];
  live: boolean;
  trusted: boolean;
  trustedEntrypoint: boolean;
  channelCompatible: boolean;
  isolationVerified: boolean;
  regressionGroups: string[];
}

export interface IntegrationEvent {
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  origin: 'collection' | 'import' | 'global-setup' | 'hook' | 'test-body';
  message?: string;
}

export interface IntegrationCompletion {
  selectedFiles: string[];
  events: IntegrationEvent[];
  protocolComplete: boolean;
  childExitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  cleanupComplete: boolean;
  knownRed: string[];
  unknown: string[];
  unexecuted: string[];
  callerPhase: string;
  budget: IntegrationBudget;
}

export interface EtchlyIntegrationResult {
  outcome: string;
  cliCode: number;
  exitCode: number | null;
  groupState: string;
  nextAction: string;
  phase: 'integration';
  callerPhase: string;
  testKind: 'integration';
  timeoutPolicy: { source: string; timeoutMs: number };
  cleanup: { complete: boolean };
  knownRed: string[];
  unexecuted: string[];
  unknown: string[];
  testIds: string[];
  diagnostics: { origin: string; message: string }[];
}

export interface IntegrationRecoveryObservation {
  deadline: number;
  now: number;
  timeoutCount: number;
  timeoutRecorded: boolean;
  deadlineExceeded: boolean;
  interrupted: boolean;
  concurrentOwnerAlive: boolean;
  processes: { pid: number; owned: boolean; exitConfirmed: boolean }[];
  artifacts: { path: string; owned: boolean; removed: boolean }[];
  files: string[];
}

export interface IntegrationRecoveryPlan {
  deadline: number;
  timeoutCount: number;
  groupState: string;
  nextAction: string;
  retryFiles: string[];
  canSpawn: boolean;
  cleanupComplete: boolean;
  signalPids: number[];
  removePaths: string[];
}

export function validateEtchlyIntegrationInventories(
  profiles: Record<string, IntegrationProfileContract>, observation: InventoryObservation,
): ContractFailure[] {
  const issues: ContractFailure[] = [];
  const members = new Map<string, string>();
  const d1 = Object.entries(profiles).filter(([, profile]) => profile.testKind === 'integration' && profile.resultAdapter === 'vitest-events');
  for (const [id, profile] of Object.entries(profiles)) {
    const pointer = `conf/test-runs.json#/projects/etchly/profiles/${id}`;
    const integration = profile.testKind === 'integration';
    const workerD1 = integration && profile.resultAdapter === 'vitest-events';
    const files = integration ? profile.integrationFiles : profile.unitFiles;
    const adapterValid = workerD1 ? profile.exactIds === 'vitest-test-name' && profile.environment.isolatedHome && profile.environment.stateOrigin && d1Command(profile) : profile.resultAdapter === 'node-test-events' && profile.exactIds === 'node-test-name';
    if (integration && (Object.hasOwn(profile, 'unitFiles') || !adapterValid)) issues.push(problem('CONFIGURATION_INVALID', pointer, files ?? [], 'Invalid integration profile or adapter pair'));
    if (!integration && profile.integrationFiles !== undefined || !files?.length) issues.push(problem('CONFIGURATION_INVALID', pointer, files ?? [], 'Inventory must be nonempty and match testKind'));
    for (const file of files ?? []) {
      if (!safeFile(file) || members.has(file)) issues.push(problem('CONFIGURATION_INVALID', pointer, [file], 'Unsafe or duplicate membership'));
      members.set(file, id);
      if (!observation.existingFiles.includes(file) || (!integration || workerD1) && observation.classifiedFiles[file] !== (workerD1 ? 'd1' : 'unit')) issues.push(problem('INVENTORY_INCOMPLETE', `${pointer}/${integration ? 'integrationFiles' : 'unitFiles'}`, [file], 'Missing or reclassified file; reconcile inventory and groups'));
    }
  }
  if (d1.length) for (const [file, classification] of Object.entries(observation.classifiedFiles)) {
    if (classification === 'd1' && !d1.some(([, profile]) => profile.integrationFiles?.includes(file))) issues.push(problem('INVENTORY_INCOMPLETE', 'conf/test-runs.json#/projects/etchly/profiles/vitest-worker-d1-integration/integrationFiles', [file], 'Unregistered D1 file; reconcile inventory and groups'));
  }
  for (const file of new Set([...Object.keys(observation.expectedSourceHashes), ...Object.keys(observation.sourceHashes)])) {
    if (observation.sourceHashes[file] !== observation.expectedSourceHashes[file]) issues.push(problem('INVENTORY_INCOMPLETE', 'conf/test-runs.json#/projects/etchly/profiles', [file], 'Audited classification source changed; repeat static review'));
  }
  return issues;
}

export function selectEtchlyIntegrationPreset(
  profile: IntegrationProfileContract, preset: IntegrationSelection,
  request: { phase: string; files?: string[]; only?: string[] },
): IntegrationSelection | ContractFailure {
  const files = request.files ?? preset.files;
  const pointer = 'conf/test-runs.json#/projects/etchly/groups';
  if (request.phase !== 'integration' || profile.testKind !== 'integration' || request.only !== undefined || preset.profileId !== 'vitest-worker-d1-integration' || !files.length || !sameFiles(files, preset.files) || files.some(file => !safeFile(file) || !file.startsWith('worker/') || !profile.integrationFiles?.includes(file))) return problem('UNSAFE_SELECTION', pointer, files, 'Integration requires the exact configured preset without --only');
  return { profileId: preset.profileId, files: [...preset.files] };
}

export function resolveEtchlyIntegrationBudget(
  flow: { unitTests?: { timeoutMs?: unknown }; integrationTests?: { timeoutMs?: unknown } },
  now: number, inFlight?: IntegrationBudget,
): IntegrationBudget | ContractFailure {
  const source = 'conf/flow.json#/integrationTests/timeoutMs';
  if (inFlight) return { ...inFlight };
  const timeoutMs = flow.integrationTests?.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) return problem('CONFIGURATION_INVALID', source, [], 'Positive integer integration budget required; no unit fallback');
  return { source, timeoutMs: timeoutMs as number, deadline: now + (timeoutMs as number) };
}

export function planEtchlyIntegrationCommand(
  root: string, profile: IntegrationProfileContract, selection: IntegrationSelection,
  budget: IntegrationBudget, reporterPath: string,
): EtchlyCommandPlan {
  const selected = selectEtchlyIntegrationPreset(profile, selection, { phase: 'integration' });
  if ('errorCode' in selected || !d1Command(profile)) throw Object.assign(new Error('Invalid worker-d1 command or selection'), { code: 'UNSAFE_SELECTION' });
  const run = profile.argv.indexOf('run');
  const argv = [...profile.argv.slice(0, run + 1), ...selected.files.map(file => file.slice('worker/'.length)), ...profile.argv.slice(run + 1), '--testTimeout', String(budget.timeoutMs), '--hookTimeout', String(budget.timeoutMs), '--reporter', reporterPath];
  return { cwd: resolve(root, profile.cwd), executable: profile.executable, argv, selectedFiles: [...selected.files], timeoutPolicy: { source: budget.source, timeoutMs: budget.timeoutMs }, deadline: budget.deadline, transportDeadline: budget.deadline };
}

export function prepareEtchlyIntegrationEnvironment(
  observation: EtchlyEnvironmentObservation,
): EtchlyEnvironmentPlan | ContractFailure {
  const required = ['executableRuntime', 'compatibleBridge', 'sharedLibsBranchMatches', 'resourceProtocolInstalled', 'localBuildValid', 'privateTmpWritable', 'loopbackAvailable', 'stateOriginVerified'] as const;
  const missing = [...observation.missingChecks, ...required.filter(check => !observation[check])];
  const { isolatedHome, operationalHome, privateRunRoot } = observation;
  if (![isolatedHome, operationalHome, privateRunRoot].every(path => isAbsolute(path) && resolve(path) === path) || overlaps(isolatedHome, operationalHome) || overlaps(privateRunRoot, operationalHome) || privateRunRoot === isolatedHome) missing.push('private HOME/TMPDIR');
  if (missing.length) return problem('ENVIRONMENT_INVALID', 'conf/test-runs.json#/projects/etchly/profiles/vitest-worker-d1-integration/checks', missing, `Etchly setup: ${missing.join(', ')}; repair dependencies/build/isolation without install or hidden build`);
  const env = Object.fromEntries(Object.entries(observation.inheritedEnv).filter(([key]) => ['PATH', 'LANG', 'TZ', 'SYSTEMROOT'].includes(key) || key.startsWith('LC_')));
  const ownedPaths = ['tmp', 'wrangler-logs', 'node-compile-cache', 'npm-cache'].map(path => resolve(privateRunRoot, path));
  return { env: { ...env, HOME: isolatedHome, TMPDIR: ownedPaths[0], ETCHLY_ENV: 'local', CI: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: ownedPaths[1], NODE_COMPILE_CACHE: ownedPaths[2], npm_config_offline: 'true', npm_config_cache: ownedPaths[3] }, ownedPaths };
}

export function authorizeEtchlyIntegrationCaller(
  caller: EtchlyCaller,
  request: { phase: string; project: string; workspace: string; branch: string; group: string; testKind: 'unit' | 'integration' },
): { callerPhase: string } | ContractFailure {
  const identity = caller.trusted && caller.live && caller.trustedEntrypoint && caller.channelCompatible && caller.isolationVerified && request.project === caller.project && request.workspace === caller.workspace && request.branch === caller.branch && caller.activeChanges.includes(request.group.split('/')[0]);
  const unitRed = caller.project === 'raf' && ['spec', 'design', 'test-scaffold'].includes(caller.phase) && request.phase === 'red' && request.testKind === 'unit';
  const integration = caller.project === 'etchly' && ['implement', 'qa', 'hotfix'].includes(caller.phase) && request.phase === 'integration' && request.testKind === 'integration';
  if (!identity || !unitRed && !integration) return problem('CALLER_UNAUTHORIZED', 'assignment', [], 'A live trusted own caller and verified isolation are required');
  return { callerPhase: caller.phase };
}

export function completeEtchlyIntegrationRun(completion: IntegrationCompletion): EtchlyIntegrationResult {
  const knownRed = new Set(completion.knownRed), unknown = new Set(completion.unknown), unexecuted = new Set(completion.unexecuted);
  const testIds = new Set<string>(), passedFiles = new Set<string>();
  const diagnostics: EtchlyIntegrationResult['diagnostics'] = [];
  let setup = false;
  for (const event of completion.events) {
    const id = `${event.file}::${event.name}`;
    testIds.add(id);
    if (!completion.selectedFiles.includes(event.file) || !safeFile(event.file) || !event.name) setup = true;
    if (event.status === 'passed') passedFiles.add(event.file);
    else if (event.status === 'skipped') unexecuted.add(id);
    else {
      diagnostics.push({ origin: event.origin, message: (event.message ?? 'Vitest failure').replace(/\b(authorization|cookie|set-cookie|password|passwd|token|api[_-]?key|secret)\b(\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1$2<redacted>') });
      if (event.origin === 'test-body') knownRed.add(id);
      else { setup = true; unknown.add(id); }
    }
  }
  if (!completion.protocolComplete || !testIds.size || completion.childExitCode === null || completion.childExitCode !== 0 && !knownRed.size) setup = true;
  const remaining = unexecuted.size || unknown.size || !completion.selectedFiles.length || completion.selectedFiles.some(file => !passedFiles.has(file));
  const outcome = completion.timedOut ? 'timed-out' : completion.interrupted ? 'interrupted' : setup ? 'setup-failed' : knownRed.size ? 'assertions-failed' : remaining || !completion.cleanupComplete ? 'setup-failed' : 'passed';
  return { outcome, cliCode: outcome === 'passed' ? 0 : 1, exitCode: completion.childExitCode, groupState: outcome === 'passed' ? 'complete' : 'incomplete', nextAction: outcome === 'passed' ? 'complete' : 'complete-integration', phase: 'integration', callerPhase: completion.callerPhase, testKind: 'integration', timeoutPolicy: { source: completion.budget.source, timeoutMs: completion.budget.timeoutMs }, cleanup: { complete: completion.cleanupComplete }, knownRed: [...knownRed], unexecuted: [...unexecuted], unknown: [...unknown], testIds: [...testIds], diagnostics };
}

export function reconcileEtchlyIntegrationRun(observation: IntegrationRecoveryObservation): IntegrationRecoveryPlan {
  const signalPids = observation.processes.filter(process => process.owned && !process.exitConfirmed).map(process => process.pid);
  const removePaths = observation.artifacts.filter(artifact => artifact.owned && !artifact.removed).map(artifact => artifact.path);
  const cleanupComplete = !signalPids.length && !removePaths.length;
  const concurrent = observation.concurrentOwnerAlive;
  return { deadline: observation.deadline, timeoutCount: observation.timeoutCount + (observation.deadlineExceeded && !observation.timeoutRecorded && !concurrent && !observation.interrupted ? 1 : 0), groupState: concurrent ? 'running' : 'incomplete', nextAction: concurrent ? 'reconcile' : 'complete-integration', retryFiles: [...observation.files], canSpawn: !concurrent && cleanupComplete, cleanupComplete, signalPids: concurrent ? [] : signalPids, removePaths: concurrent ? [] : removePaths };
}

export function classifyEtchlyWorkerTestGraph(input: {
  sources: Record<string, string>;
  testFiles: string[];
  boundaries: Record<string, WorkerTestClass>;
  planFiles: string[];
}): Record<string, WorkerTestClass> {
  const normalize = (file: string) => posix.normalize(file.replaceAll('\\', '/'));
  const sources = new Map(Object.entries(input.sources).map(([file, source]) => [normalize(file), source]));
  const boundaries = new Map(Object.entries(input.boundaries).map(([file, kind]) => [normalize(file), kind]));
  const priority: WorkerTestClass[] = ['unit', 'integration', 'd1', 'harness', 'plan-d1'];
  const edges = new Map<string, string[]>(), classes = new Map(boundaries);
  const pending = input.testFiles.map(normalize), seen = new Set<string>();
  for (const file of pending) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (boundaries.has(file)) continue;
    const source = sources.get(file);
    if (source === undefined || /\/(?:bundled-prompt-packages|ui(?:-admin)?\.source)\.ts$/.test(file)) continue;
    const dependencies = runtimeImports(file, source).map(specifier => {
      if (!specifier.startsWith('.')) return boundaries.has(specifier) ? specifier : null;
      const base = normalize(posix.join(posix.dirname(file), specifier));
      return [base, ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].map(suffix => base + suffix), ...(/\.[cm]?js$/.test(base) ? [base.replace(/\.[cm]?js$/, '.ts')] : [])].find(candidate => sources.has(candidate) || boundaries.has(candidate)) ?? null;
    }).filter((file): file is string => file !== null);
    edges.set(file, dependencies);
    pending.push(...dependencies);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, dependencies] of edges) {
      const highest = dependencies.reduce<WorkerTestClass>((kind, dependency) => priority.indexOf(classes.get(dependency) ?? 'unit') > priority.indexOf(kind) ? classes.get(dependency)! : kind, classes.get(file) ?? 'unit');
      if (highest !== (classes.get(file) ?? 'unit')) { classes.set(file, highest); changed = true; }
    }
  }
  return Object.fromEntries(input.testFiles.map(file => [file, input.planFiles.includes(file) ? 'plan-d1' : classes.get(normalize(file)) ?? 'unit']));
}

const safeFile = (file: string) => !!file && !isAbsolute(file) && !/^[A-Za-z]:|[\\*?\[\]{}\0]/.test(file) && file.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('-'));
const sameFiles = (left: string[], right: string[]) => left.length === right.length && new Set(left).size === left.length && left.every(file => right.includes(file));
const overlaps = (left: string, right: string) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
const problem = (errorCode: string, pointer: string, files: string[], reason: string): ContractFailure => ({ errorCode, pointer, files, reason });
function d1Command(profile: IntegrationProfileContract): boolean {
  const argv = profile.argv;
  return profile.cwd === 'worker' && argv.join('\0') === ['--import', '../scripts/shared-library-runtime.mjs', '../node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner', '--project', 'worker-d1-integration'].join('\0') && (profile.executable === 'node' || profile.executable.endsWith('/node'));
}

export function runtimeImports(file: string, source: string): string[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  const add = (node: ts.Node | undefined) => { if (node && ts.isStringLiteralLike(node)) imports.add(node.text); };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause || !clause.isTypeOnly && (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings) || !clause.namedBindings.elements.length || clause.namedBindings.elements.some(element => !element.isTypeOnly))) add(node.moduleSpecifier);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(element => !element.isTypeOnly))) add(node.moduleSpecifier);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
      return;
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return [...imports];
}
