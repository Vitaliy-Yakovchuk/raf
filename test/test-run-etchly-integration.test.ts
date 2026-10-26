import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyEtchlyWorkerTestGraph, completeEtchlyIntegrationRun, planEtchlyIntegrationCommand,
  prepareEtchlyIntegrationEnvironment, reconcileEtchlyIntegrationRun, resolveEtchlyIntegrationBudget,
  selectEtchlyIntegrationPreset, validateEtchlyIntegrationInventories,
  type ContractFailure, type EtchlyEnvironmentObservation,
  type IntegrationCompletion, type IntegrationProfileContract, type IntegrationRecoveryObservation,
  type InventoryObservation,
} from '../src/test-run-etchly-integration.ts';

const files = [
  'worker/src/analysis-output-1177-agent-tests/invalid-analysis-retried.test.ts',
  'worker/src/accepted-source-1939-agent-tests/continuation.test.ts',
  'worker/src/summary-pass-language-agent-tests/english-course-prompt-form.test.ts',
];
const profileId = 'vitest-worker-d1-integration';
const pointer = 'conf/test-runs.json#/projects/etchly/profiles/' + profileId;
const budgetSource = 'conf/flow.json#/integrationTests/timeoutMs';
const preset = { profileId, files };
const budget = { source: budgetSource, timeoutMs: 91000, deadline: 92000 };
const profile = (): IntegrationProfileContract => ({
  testKind: 'integration', cwd: 'worker', executable: 'node',
  argv: ['--import','../scripts/shared-library-runtime.mjs','../node_modules/vitest/vitest.mjs','run','--configLoader','runner','--project','worker-d1-integration'],
  exactIds: 'vitest-test-name', resultAdapter: 'vitest-events', integrationFiles: [...files],
  environment: { isolatedHome: true, stateOrigin: true }, checks: ['worker/vitest.config.ts'],
});
const inventory = (): InventoryObservation => ({
  existingFiles: [...files], classifiedFiles: Object.fromEntries(files.map(file => [file, 'd1'])),
  sourceHashes: { config: 'config-v1', classifier: 'classifier-v1' },
  expectedSourceHashes: { config: 'config-v1', classifier: 'classifier-v1' },
});
const failure = (value: unknown): ContractFailure => {
  assert.ok(value && typeof value === 'object' && 'errorCode' in value, 'expected explicit refusal');
  return value as ContractFailure;
};

test('D01 Vitest integration accepts its adapter pair and preserves Node integration and legacy unit', () => {
  const node = { ...profile(), cwd: '.', argv: ['./scripts/test-run-node.ts'], exactIds: 'node-test-name', resultAdapter: 'node-test-events', integrationFiles: ['test/host.test.ts'] };
  const unit = { ...profile(), testKind: undefined, integrationFiles: undefined, unitFiles: ['worker/src/pure.test.ts'] };
  assert.deepEqual(validateEtchlyIntegrationInventories({ [profileId]: profile(), 'node-integration': node, 'vitest-worker': unit }, {
    ...inventory(), existingFiles: [...files, 'test/host.test.ts', 'worker/src/pure.test.ts'],
    classifiedFiles: { ...inventory().classifiedFiles, 'worker/src/pure.test.ts': 'unit' },
  }), []);
});
for (const [adapter, exactIds] of [['vitest-events','node-test-name'], ['node-test-events','vitest-test-name'], ['unknown','vitest-test-name']]) {
  test(`D01 rejects unsupported adapter/exactIds ${adapter}/${exactIds}`, () => {
    const errors = validateEtchlyIntegrationInventories({ [profileId]: { ...profile(), resultAdapter: adapter, exactIds } }, inventory());
    assert.ok(errors.some(e => e.errorCode === 'CONFIGURATION_INVALID' && e.pointer.startsWith(pointer)));
  });
}
for (const mutation of ['unitFiles','empty','duplicate','overlap'] as const) {
  test(`D01 rejects invalid typed inventory ${mutation}`, () => {
    const p = profile();
    const profiles: Record<string, IntegrationProfileContract> = { [profileId]: p };
    if (mutation === 'unitFiles') p.unitFiles = [];
    if (mutation === 'empty') p.integrationFiles = [];
    if (mutation === 'duplicate') p.integrationFiles!.push(files[0]);
    if (mutation === 'overlap') profiles.unit = { ...profile(), testKind: 'unit', integrationFiles: undefined, unitFiles: [files[0]] };
    const errors = validateEtchlyIntegrationInventories(profiles, inventory());
    assert.ok(errors.some(e => e.errorCode === 'CONFIGURATION_INVALID' && e.pointer.includes('profiles')));
  });
}
for (const kind of ['unit','integration','harness','plan-d1'] as const) {
  test(`D02 rejects D1 file reclassified as ${kind} before spawn`, () => {
    const observation = inventory(); observation.classifiedFiles[files[0]] = kind;
    const errors = validateEtchlyIntegrationInventories({ [profileId]: profile() }, observation);
    assert.ok(errors.some(e => e.files.includes(files[0]) && e.pointer === pointer + '/integrationFiles'));
  });
}
test('D02 stale rename reports exact old path and inventory pointer', () => {
  const errors = validateEtchlyIntegrationInventories({ [profileId]: profile() }, { ...inventory(), existingFiles: files.slice(1) });
  assert.ok(errors.some(e => e.files.includes(files[0]) && e.pointer === pointer + '/integrationFiles'));
});
test('D02 changed classifier/import graph requires re-audit instead of silent inventory refresh', () => {
  const observation = inventory(); observation.sourceHashes.classifier = 'classifier-v2';
  assert.ok(validateEtchlyIntegrationInventories({ [profileId]: profile() }, observation).length > 0);
});

test('D03 implicit preset and reordered exact files select the same root-relative files', () => {
  const expected = { profileId, files };
  assert.deepEqual(selectEtchlyIntegrationPreset(profile(), preset, { phase: 'integration' }), expected);
  assert.deepEqual(selectEtchlyIntegrationPreset(profile(), preset, { phase: 'integration', files: [...files].reverse() }), expected);
});
for (const [label, requested] of [
  ['empty', []], ['subset', files.slice(0,1)], ['extra', [...files,'worker/src/extra.test.ts']],
  ['duplicate', [...files,files[0]]], ['directory', ['worker/src']], ['glob',['worker/**/*.test.ts']],
  ['escape',['../outside.test.ts']], ['option',['--project']], ['cwd double prefix',['worker/worker/src/a.test.ts']],
] as const) {
  test(`D03 refuses ${label} selection with groups pointer`, () => {
    const error = failure(selectEtchlyIntegrationPreset(profile(), preset, { phase: 'integration', files: [...requested] }));
    assert.ok(error.pointer.includes('groups') || error.pointer.includes('integrationFiles'));
  });
}
for (const request of [{ phase: 'integration', only: [files[0]+'::suite test'] }, { phase: 'red' }, { phase: 'qa' }]) {
  test(`D03 refuses integration phase/type/only mismatch ${JSON.stringify(request)}`, () => {
    assert.ok(failure(selectEtchlyIntegrationPreset(profile(), preset, request)).reason);
  });
}
test('D03 refuses preset for another profile', () => {
  assert.ok(failure(selectEtchlyIntegrationPreset(profile(), { ...preset, profileId: 'vitest-worker' }, { phase: 'integration' })).reason);
});
test('D03 one-file preset equal to integration inventory remains a valid addressed scenario', () => {
  const p = { ...profile(), integrationFiles: files.slice(0,1) };
  assert.deepEqual(selectEtchlyIntegrationPreset(p, { profileId, files: files.slice(0,1) }, { phase: 'integration' }), { profileId, files: files.slice(0,1) });
});
test('D03/D04 internal argv retains preload/project, inserts cwd files immediately after run and integration timeouts', () => {
  const plan = planEtchlyIntegrationCommand('/workspace/etchly', profile(), preset, budget, '/trusted/reporter.mjs');
  assert.equal(plan.cwd, '/workspace/etchly/worker'); assert.equal(plan.executable, 'node');
  assert.deepEqual(plan.argv.slice(0,4), profile().argv.slice(0,4));
  assert.deepEqual(plan.argv.slice(4,7), files.map(file => file.slice('worker/'.length)));
  assert.deepEqual(plan.argv.slice(7,11), ['--configLoader','runner','--project','worker-d1-integration']);
  assert.ok(plan.argv.includes('/trusted/reporter.mjs'));
  for (const option of ['--testTimeout','--hookTimeout']) assert.equal(plan.argv[plan.argv.indexOf(option)+1], String(budget.timeoutMs));
  assert.deepEqual(plan.selectedFiles, files);
  assert.deepEqual(plan.timeoutPolicy, { source: budgetSource, timeoutMs: budget.timeoutMs });
  assert.equal(plan.deadline, budget.deadline); assert.equal(plan.transportDeadline, budget.deadline);
  assert.ok(!plan.argv.includes('npx') && !plan.argv.includes('worker-unit'));
});
for (const value of [undefined, null, 0, -1, 1.5, NaN, Infinity, '91000']) {
  test(`D04 invalid integration budget ${String(value)} has no unit fallback`, () => {
    const error = failure(resolveEtchlyIntegrationBudget({ unitTests: { timeoutMs: 12000 }, integrationTests: { timeoutMs: value } }, 1000));
    assert.equal(error.errorCode, 'CONFIGURATION_INVALID'); assert.equal(error.pointer, budgetSource);
  });
}
test('D04 unit changes do not affect integration budget; in-flight and recovery keep reserved deadline', () => {
  const flow = { unitTests: { timeoutMs: 1 }, integrationTests: { timeoutMs: 91000 } };
  assert.deepEqual(resolveEtchlyIntegrationBudget(flow, 1000), budget);
  assert.deepEqual(resolveEtchlyIntegrationBudget({ ...flow, unitTests: { timeoutMs: 999999 } }, 1000), budget);
  assert.deepEqual(resolveEtchlyIntegrationBudget({ integrationTests: { timeoutMs: 180000 } }, 70000, budget), budget);
});

const environment = (): EtchlyEnvironmentObservation => ({
  missingChecks: [], executableRuntime: true, compatibleBridge: true, sharedLibsBranchMatches: true,
  resourceProtocolInstalled: true, localBuildValid: true, privateTmpWritable: true, loopbackAvailable: true,
  isolatedHome: '/private/qa/home', operationalHome: '/operational/raf', stateOriginVerified: true,
  privateRunRoot: '/private/run', inheritedEnv: { PATH: '/local/bin', ETCHLY_ENV: 'local' },
});
for (const guard of ['executableRuntime','compatibleBridge','sharedLibsBranchMatches','resourceProtocolInstalled','localBuildValid','privateTmpWritable','loopbackAvailable','stateOriginVerified'] as const) {
  test(`D05 guard ${guard} refuses setup without install/build fallback`, () => {
    const error = failure(prepareEtchlyIntegrationEnvironment({ ...environment(), [guard]: false }));
    assert.ok(error.reason.includes(guard), 'diagnostic identifies failed prerequisite');
  });
}
test('D05 absent runtime/setup/migrations checks identify exact paths', () => {
  const missingChecks = ['node_modules/workerd/package.json','worker/migrations','worker/src/test-support/d1-template-global-setup.ts'];
  assert.deepEqual(failure(prepareEtchlyIntegrationEnvironment({ ...environment(), missingChecks })).files, missingChecks);
});
test('D05 operational HOME alias is rejected', () => {
  assert.ok(failure(prepareEtchlyIntegrationEnvironment({ ...environment(), isolatedHome: '/operational/raf' })).reason);
});
test('D05 external templates, caches, worker endpoints and credentials are not inherited; state stays private', () => {
  const inheritedEnv = { ...environment().inheritedEnv, ETCHLY_TEST_D1_TEMPLATE: '/outside/template', ETCHLY_TEST_NATIVE_FIXTURE_CACHE: '/outside/cache', ETCHLY_SHARED_WORKER_URL: 'https://external.invalid', ETCHLY_SHARED_WORKER_TOKEN: 'synthetic-secret', WRANGLER_LOG_PATH: '/outside/logs', NODE_COMPILE_CACHE: '/outside/compile', TMPDIR: '/outside', HOME: '/operational/raf', CLOUDFLARE_API_TOKEN: 'synthetic-cloud-token' };
  const result = prepareEtchlyIntegrationEnvironment({ ...environment(), inheritedEnv });
  assert.ok('env' in result);
  for (const name of ['ETCHLY_TEST_D1_TEMPLATE','ETCHLY_TEST_NATIVE_FIXTURE_CACHE','ETCHLY_SHARED_WORKER_URL','ETCHLY_SHARED_WORKER_TOKEN','CLOUDFLARE_API_TOKEN']) assert.equal(result.env[name], undefined);
  assert.equal(result.env.HOME, '/private/qa/home');
  for (const name of ['TMPDIR','WRANGLER_LOG_PATH','NODE_COMPILE_CACHE']) assert.ok(result.env[name].startsWith('/private/run/'));
  assert.ok(result.ownedPaths.every(path => path.startsWith('/private/run/')));
  assert.equal(result.env.ETCHLY_ENV, 'local');
});

const completion = (): IntegrationCompletion => ({ selectedFiles: files, events: files.map(file => ({ file, name: 'suite nested behaves', status: 'passed', origin: 'test-body' })), protocolComplete: true, childExitCode: 0, timedOut: false, interrupted: false, cleanupComplete: true, knownRed: [], unknown: [], unexecuted: [], callerPhase: 'qa', budget });
test('D06 complete requires all files and cleanup; root-relative full IDs and actual policy are preserved', () => {
  const result = completeEtchlyIntegrationRun(completion());
  assert.equal(result.outcome, 'passed'); assert.equal(result.groupState, 'complete'); assert.equal(result.cliCode, 0);
  assert.equal(result.phase, 'integration'); assert.equal(result.callerPhase, 'qa'); assert.equal(result.testKind, 'integration');
  assert.deepEqual(result.timeoutPolicy, { source: budgetSource, timeoutMs: 91000 });
  assert.deepEqual(result.testIds, files.map(file => file+'::suite nested behaves'));
  assert.equal(result.cleanup.complete, true); assert.equal(result.exitCode, 0);
});
for (const origin of ['collection','import','global-setup','hook','test-body'] as const) {
  test(`D06 ${origin} failure retains origin and cannot complete`, () => {
    const input = completion(); input.events[0] = { ...input.events[0], status: 'failed', origin, message: 'synthetic failure' }; input.childExitCode = 1;
    const result = completeEtchlyIntegrationRun(input);
    assert.equal(result.outcome, origin === 'test-body' ? 'assertions-failed' : 'setup-failed');
    assert.equal(result.groupState, 'incomplete'); assert.notEqual(result.cliCode, 0);
    assert.equal(result.nextAction, 'complete-integration');
    assert.ok(result.diagnostics.some(d => d.origin === origin));
  });
}
for (const mutation of ['skip','zero','lost-protocol','missing-file','known-red','unknown','unexecuted','cleanup','deadline','interruption'] as const) {
  test(`D06/D08 ${mutation} never gives complete or unit remainder`, () => {
    const input = completion();
    if (mutation === 'skip') input.events[0].status = 'skipped';
    if (mutation === 'zero') input.events = [];
    if (mutation === 'lost-protocol') input.protocolComplete = false;
    if (mutation === 'missing-file') input.events.pop();
    if (mutation === 'known-red') input.knownRed = [files[0]+'::suite nested behaves'];
    if (mutation === 'unknown') input.unknown = [files[0]+'::unknown'];
    if (mutation === 'unexecuted') input.unexecuted = [files[0]+'::pending'];
    if (mutation === 'cleanup') input.cleanupComplete = false;
    if (mutation === 'deadline') input.timedOut = true;
    if (mutation === 'interruption') input.interrupted = true;
    const result = completeEtchlyIntegrationRun(input);
    assert.notEqual(result.outcome, 'passed'); assert.notEqual(result.cliCode, 0);
    assert.equal(result.groupState, 'incomplete'); assert.equal(result.nextAction, 'complete-integration');
    assert.notEqual(result.outcome, 'unverified-remainder');
  });
}

const recovery = (): IntegrationRecoveryObservation => ({ deadline: 92000, now: 93000, timeoutCount: 9, timeoutRecorded: false, deadlineExceeded: true, interrupted: false, concurrentOwnerAlive: false, processes: [{ pid: 101, owned: true, exitConfirmed: false },{ pid: 202, owned: false, exitConfirmed: false }], artifacts: [{ path: '/private/run/d1', owned: true, removed: false },{ path: '/other/persistence', owned: false, removed: false }], files });
test('D08 recovery signals/removes only owned resources, retains deadline and full retry after unit threshold', () => {
  const result = reconcileEtchlyIntegrationRun(recovery());
  assert.deepEqual(result.signalPids, [101]); assert.deepEqual(result.removePaths, ['/private/run/d1']);
  assert.equal(result.deadline, 92000); assert.equal(result.timeoutCount, 10);
  assert.equal(result.cleanupComplete, false); assert.equal(result.canSpawn, false);
  assert.equal(result.groupState, 'incomplete'); assert.equal(result.nextAction, 'complete-integration');
  assert.deepEqual(result.retryFiles, files);
});
test('D08 repeated timeout recovery increments once; interruption does not increment', () => {
  assert.equal(reconcileEtchlyIntegrationRun({ ...recovery(), timeoutRecorded: true }).timeoutCount, 9);
  assert.equal(reconcileEtchlyIntegrationRun({ ...recovery(), deadlineExceeded: false, interrupted: true }).timeoutCount, 9);
});
test('D08 concurrent live owner prevents a second tree without cleaning its resources', () => {
  const result = reconcileEtchlyIntegrationRun({ ...recovery(), concurrentOwnerAlive: true });
  assert.equal(result.canSpawn, false); assert.deepEqual(result.signalPids, []); assert.deepEqual(result.removePaths, []);
});
test('D08 confirmed crash cleanup permits a full-preset retry without treating previous run as passed', () => {
  const result = reconcileEtchlyIntegrationRun({ ...recovery(), processes: [{ pid: 101, owned: true, exitConfirmed: true }], artifacts: [{ path: '/private/run/d1', owned: true, removed: true }], timeoutRecorded: true });
  assert.equal(result.cleanupComplete, true); assert.equal(result.canSpawn, true);
  assert.equal(result.groupState, 'incomplete'); assert.deepEqual(result.retryFiles, files);
});


test('D02 type-only imports do not confer D1 membership; runtime transitive imports and cycles do', () => {
  const sources = {
    'worker/src/type-only.test.ts': "import type { Worker } from './test-support/live-worker.ts'; export type { Worker } from './test-support/live-worker.ts';",
    'worker/src/runtime.test.ts': "import { worker } from './bridge.ts';",
    'worker/src/bridge.ts': "export { worker } from './cycle.ts';",
    'worker/src/cycle.ts': "import './bridge.ts'; export { worker } from './test-support/live-worker.ts';",
    'worker/src/plan.test.ts': "import { worker } from './test-support/live-worker.ts';",
    'worker/src/harness.test.ts': "import './test-support/live-worker.ts';",
    'worker/src/local-integration.test.ts': "import 'miniflare';",
    'worker/src/test-support/live-worker.ts': 'export const worker = 1;',
  };
  const result = classifyEtchlyWorkerTestGraph({ sources,
    testFiles: Object.keys(sources).filter(file => file.endsWith('.test.ts')),
    boundaries: { 'worker/src/test-support/live-worker.ts': 'd1', 'worker/src/harness.test.ts': 'harness', miniflare: 'integration' },
    planFiles: ['worker/src/plan.test.ts'],
  });
  assert.deepEqual(result, {
    'worker/src/type-only.test.ts': 'unit', 'worker/src/runtime.test.ts': 'd1',
    'worker/src/plan.test.ts': 'plan-d1', 'worker/src/harness.test.ts': 'harness',
    'worker/src/local-integration.test.ts': 'integration',
  });
});
test('D02 new D1 file missing from configured full inventory is reported without auto-registration', () => {
  const file = 'worker/src/new-d1.test.ts';
  const errors = validateEtchlyIntegrationInventories({ [profileId]: profile() }, {
    ...inventory(), existingFiles: [...files, file], classifiedFiles: { ...inventory().classifiedFiles, [file]: 'd1' },
  });
  assert.ok(errors.some(error => error.files.includes(file) && error.pointer === pointer+'/integrationFiles'));
});
test('D06 local file-budget stop is assertions plus unexecuted, without an outer deadline claim', () => {
  const input = completion(); input.events[0] = { ...input.events[0], status: 'failed', message: 'local file-budget exceeded' };
  input.unexecuted = [files[0]+'::later test']; input.childExitCode = 1;
  const result = completeEtchlyIntegrationRun(input);
  assert.equal(result.outcome, 'assertions-failed'); assert.deepEqual(result.unexecuted, input.unexecuted);
  assert.equal(result.groupState, 'incomplete'); assert.notEqual(result.cliCode, 0);
});
test('D06 diagnostics redact synthetic bearer credentials while retaining lifecycle origin', () => {
  const input = completion(); input.events[0] = { ...input.events[0], status: 'failed', message: 'Authorization: Bearer synthetic-sensitive-token' };
  input.childExitCode = 1;
  const result = completeEtchlyIntegrationRun(input);
  assert.ok(result.diagnostics.some(d => d.origin === 'test-body'));
  assert.ok(!JSON.stringify(result.diagnostics).includes('synthetic-sensitive-token'));
});
