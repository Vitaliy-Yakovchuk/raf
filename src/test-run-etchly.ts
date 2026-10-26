import { isAbsolute, relative, resolve, sep } from 'node:path';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { profileTestKind } from './test-run-integration-profiles.ts';
import { TestRunDiagnostics } from './test-run-diagnostics.ts';
import type { ChildExit, RunnerClassification, TestId, TestRunCommand, TestRunPlan, TestRunProfile, UnitTestPolicy } from './test-runs.ts';
import type { DiagnosticAttachment, DiagnosticLimits, DiagnosticOrigin, DiagnosticPaths } from './test-run-diagnostics.ts';

export type EtchlyTestRunProfile = Omit<TestRunProfile, 'exactIds' | 'resultAdapter'> & {
  exactIds: 'node-test-name' | 'vitest-test-name' | null;
  resultAdapter: 'node-test-events' | 'vitest-events';
};

export interface EtchlyInventoryFact {
  file: string;
  profileId: string | null;
  classification: string;
}

export interface EtchlyInventorySnapshot {
  profiles: Record<string, readonly string[]>;
  sourceHashes: Record<string, string>;
}

export interface EtchlyEnvironmentFacts {
  workspace: string;
  branch: string;
  expectedLibrary: string;
  actualLibrary: string | null;
  nodeAvailable: boolean;
  vitestAvailable: boolean;
  adapterCompatible: boolean;
  preloadAvailable: boolean;
  aliasesAvailable: boolean;
  configAvailable: boolean;
  happyDomRequired: boolean;
  happyDomAvailable: boolean;
  isolatedHome: boolean;
  stateOrigin: boolean;
  privateTmpWritable: boolean;
  browserRequired: boolean;
  trustedBrowserCache: string | null;
  requestedBrowserCache: string | null;
  browserAvailable: boolean;
}

export interface EtchlyPreparedEnvironment {
  HOME: string;
  TMPDIR: string;
  PLAYWRIGHT_BROWSERS_PATH?: string;
}

export type VitestLifecycleEvent =
  | { kind: 'collected'; tests: TestId[] }
  | { kind: 'started' | 'passed'; test: TestId }
  | { kind: 'failed'; test: TestId | null; origin: DiagnosticOrigin; error: unknown }
  | { kind: 'skipped'; test: TestId; reason: 'declared' | 'first-failure' }
  | { kind: 'finished' }
  | { kind: 'protocol-error'; message: string };

export type VitestClassification = RunnerClassification & Pick<DiagnosticAttachment, 'diagnostics' | 'diagnosticSummary'>;

export function auditEtchlyInventory(
  configured: EtchlyInventorySnapshot,
  observed: readonly EtchlyInventoryFact[],
  currentSourceHashes: Readonly<Record<string, string>>,
): void {
  const issues: string[] = [];
  const memberships = new Map<string, string>();
  for (const [profile, files] of Object.entries(configured.profiles)) for (const file of files) {
    if (memberships.has(file)) issues.push(`duplicate ${file}`);
    memberships.set(file, profile);
  }
  const seen = new Set<string>();
  for (const fact of observed) {
    if (seen.has(fact.file)) issues.push(`duplicate observed ${fact.file}`);
    seen.add(fact.file);
    const expected = memberships.get(fact.file);
    if (expected && (fact.classification !== 'unit' || fact.profileId !== expected)) issues.push(`reclassified ${fact.file}: ${fact.classification}/${fact.profileId}`);
    if (!expected && fact.classification === 'unit') issues.push(`unexpected ${fact.file}`);
  }
  const missing = [...memberships.keys()].filter(file => !seen.has(file));
  if (missing.length) process.stderr.write(`Warning: etchly inventory is missing ${missing.join(', ')}; missing files are skipped\n`);
  for (const key of new Set([...Object.keys(configured.sourceHashes), ...Object.keys(currentSourceHashes)])) {
    if (configured.sourceHashes[key] !== currentSourceHashes[key]) issues.push(`changed source ${key}`);
  }
  if (issues.length) throw Object.assign(new Error(`INVENTORY_INCOMPLETE: ${issues.join('; ')}. Reconcile conf/test-runs.json#/projects/etchly/profiles and groups after static audit; no discovery fallback.`), { code: 'INVENTORY_INCOMPLETE' });
}

export function prepareEtchlyEnvironment(
  facts: EtchlyEnvironmentFacts,
  privatePaths: { home: string; tmp: string },
): EtchlyPreparedEnvironment {
  const required = ['nodeAvailable', 'vitestAvailable', 'adapterCompatible', 'preloadAvailable', 'aliasesAvailable', 'configAvailable', 'isolatedHome', 'stateOrigin', 'privateTmpWritable'] as const;
  const problems: string[] = required.filter(key => !facts[key]);
  if (!facts.actualLibrary || facts.actualLibrary !== facts.expectedLibrary) problems.push('shared-libs physical path');
  if (facts.happyDomRequired && !facts.happyDomAvailable) problems.push('happy-dom');
  if (facts.requestedBrowserCache && facts.requestedBrowserCache !== facts.trustedBrowserCache) problems.push('untrusted PLAYWRIGHT_BROWSERS_PATH');
  if (facts.browserRequired && (!facts.trustedBrowserCache || !facts.browserAvailable)) problems.push('browser cache');
  if (!isAbsolute(privatePaths.home) || !isAbsolute(privatePaths.tmp) || privatePaths.home === facts.workspace || privatePaths.tmp === facts.workspace) problems.push('private HOME/TMPDIR');
  if (problems.length) throw Object.assign(new Error(`Etchly setup: ${problems.join(', ')}; repair environment without install or branch changes`), { code: 'ENVIRONMENT_INVALID' });
  return { HOME: privatePaths.home, TMPDIR: privatePaths.tmp, ...(facts.trustedBrowserCache ? { PLAYWRIGHT_BROWSERS_PATH: facts.trustedBrowserCache } : {}) };
}

export function planVitestInvocations(
  plan: TestRunPlan,
  profile: EtchlyTestRunProfile,
  policy: Pick<UnitTestPolicy, 'timeoutMs'>,
  trustedReporter: string,
  knownRed: readonly TestId[],
): TestRunCommand[] {
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  if (profile.resultAdapter !== 'vitest-events' || profile.exactIds !== 'vitest-test-name') fail('EXACT_IDS_UNSUPPORTED', 'Expected Vitest adapter');
  if (profileTestKind(profile) === 'integration' && plan.selection.testIds.length) fail('UNSAFE_SELECTION', 'Integration does not allow --only');
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0) fail('CONFIGURATION_INVALID', 'Positive selected timeoutPolicy required');
  const run = profile.argv.indexOf('run');
  if (run < 1 || !profile.argv.includes('--configLoader') || profile.argv[profile.argv.indexOf('--configLoader') + 1] !== 'runner') fail('CONFIGURATION_INVALID', 'Local Vitest run and configLoader runner required');
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const files = plan.selection.files;
  const batches = plan.selection.testIds.length ? files.map(file => [file]) : [files];
  return batches.map(batch => {
    const ids = plan.selection.testIds.filter(id => batch.includes(id.file));
    if (plan.selection.testIds.length && !ids.length) fail('INVALID_TEST_ID', 'Exact IDs required for every selected file');
    const cwdFiles = batch.map(file => {
      const path = resolve(plan.workspace, file);
      const cwdFile = relative(plan.command.cwd, path);
      if (!cwdFile || cwdFile.startsWith('..') || isAbsolute(cwdFile)) fail('UNSAFE_SELECTION', file);
      return cwdFile;
    });
    const argv = [...profile.argv.slice(0, run + 1), ...cwdFiles, ...profile.argv.slice(run + 1), '--testTimeout', String(policy.timeoutMs), '--hookTimeout', String(policy.timeoutMs), '--reporter', trustedReporter];
    if (ids.length) argv.push('-t', `^(?:${ids.map(id => escape(id.name)).join('|')})$`);
    return { ...plan.command, argv, shell: false, environment: { ...plan.command.environment, ...(ids.length ? { testIds: ids } : {}) } };
  });
}

export interface VitestBatchApi {
  parseCLI(argv: string[]): { filter: string[]; options: Record<string, any> };
  createVitest(mode: string, options: Record<string, any>): Promise<{
    projects: { config: Record<string, any>; vite?: { config: { server: { fs: { allow: string[] } } } } }[];
    start(files: string[]): Promise<unknown>;
    close(): Promise<unknown>;
  }>;
}

export async function runVitestBatch(api: VitestBatchApi, argv: string[], runner: string, privateCache?: string): Promise<void> {
  const { filter, options } = api.parseCLI(['vitest', ...argv]);
  const vitest = await api.createVitest('test', { ...options, watch: false, runner, ...(privateCache ? { cache: false, cacheDir: privateCache } : {}) });
  try {
    for (const project of vitest.projects) {
      const allowed = project.vite?.config.server.fs.allow;
      const runnerPath = runner.split(sep).join('/');
      if (allowed && !allowed.includes(runnerPath)) allowed.push(runnerPath);
      project.config.runner = project.config.environment && project.config.environment !== 'node' ? pathToFileURL(runner).href : runner;
      project.config.hookTimeout = options.hookTimeout;
      if (options.testTimeout !== undefined) project.config.testTimeout = options.testTimeout;
    }
    await vitest.start(filter);
  } finally {
    await vitest.close();
  }
}

export async function runVitestBatchFromSource(api: VitestBatchApi, argv: string[], source: string, temporary: string, privateCache = false): Promise<void> {
  const directory = mkdtempSync(resolve(temporary, 'vitest-runner-'));
  try {
    const runner = resolve(directory, 'test-run-vitest-runner.ts');
    copyFileSync(source, runner);
    await runVitestBatch(api, argv, runner, privateCache ? resolve(directory, 'cache') : undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function classifyVitestResult(
  events: readonly VitestLifecycleEvent[],
  exit: ChildExit,
  profileCwd: string,
  limits: DiagnosticLimits,
  paths: DiagnosticPaths,
): VitestClassification {
  const diagnostics = new TestRunDiagnostics(limits, { ...paths, workspace: resolve(paths.workspace, profileCwd) });
  const canonical = (id: TestId): TestId => {
    const prefix = relative(paths.workspace, resolve(paths.workspace, profileCwd));
    const path = isAbsolute(id.file) ? id.file : resolve(paths.workspace, prefix && (id.file === prefix || id.file.startsWith(prefix + '/')) ? id.file : `${prefix}/${id.file}`);
    const file = relative(paths.workspace, path);
    if (!file || file.startsWith('..') || isAbsolute(file)) throw new Error('Vitest identity outside workspace');
    return { file, name: id.name };
  };
  const key = (id: TestId) => JSON.stringify([id.file, id.name]);
  const expected = new Map<string, TestId>(), passed = new Map<string, TestId>(), red = new Map<string, TestId>(), unknown = new Map<string, TestId>();
  let finished = false, setup = false;
  for (const event of events) {
    try {
      if (finished) { setup = true; diagnostics.protocolError('Events after finished'); }
      if (event.kind === 'collected') for (const raw of event.tests) { const id = canonical(raw); expected.set(key(id), id); }
      else if (event.kind === 'finished') finished = true;
      else if (event.kind === 'protocol-error') { setup = true; diagnostics.protocolError(event.message); }
      else if (event.kind === 'failed') {
        const id = event.test ? canonical(event.test) : null;
        const disposition = diagnostics.failure({ test: id, origin: event.origin, error: event.error });
        if (id) { expected.set(key(id), id); passed.delete(key(id)); }
        if (disposition.failureKind === 'assertions' && id) red.set(key(id), id);
        else { setup = true; if (id) unknown.set(key(id), id); }
      } else {
        const id = canonical(event.test); expected.set(key(id), id);
        if (event.kind === 'passed' && !red.has(key(id)) && !unknown.has(key(id))) passed.set(key(id), id);
      }
    } catch (error) { setup = true; diagnostics.protocolError(error instanceof Error ? error.message : 'Invalid Vitest identity'); }
  }
  if (!finished) { for (const [key, id] of passed) unknown.set(key, id); passed.clear(); }
  const unexecuted = [...expected].filter(([id]) => !passed.has(id) && !red.has(id) && !unknown.has(id)).map(([, id]) => id);
  if (!finished || !expected.size || exit.signal || exit.exitCode !== 0 && !red.size) setup = true;
  if (!finished) diagnostics.protocolError('Missing Vitest finished event');
  if (!expected.size) diagnostics.protocolError('Empty Vitest collection');
  diagnostics.stderrChunk(Buffer.from(exit.stderr));
  if (exit.stderrTruncated) diagnostics.markStderrTruncated();
  diagnostics.childExit({ ...exit, validProtocol: finished && !setup });
  const result: RunnerClassification = { outcome: setup ? 'setup-failed' : red.size ? 'assertions-failed' : unexecuted.length ? 'unverified-remainder' : 'passed', failureKinds: [...(setup ? ['setup' as const] : []), ...(red.size ? ['assertions' as const] : [])], passed: [...passed.values()], knownRed: [...red.values()], unknown: [...unknown.values()], unexecuted };
  return { ...result, ...diagnostics.attach({ ...result, runId: '', timeoutCount: 0, timedOut: false, cleanup: null, evidence: [] }, {} as any) };
}
