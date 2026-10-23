import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planTestRun, runTestRun, validateTestRunConfig } from '../src/test-runs.ts';
import type { TestId, TestRunConfig, TestRunContext, TestRunEnvironment, TestRunGroup, TestRunPlan, TestRunPorts, UnitTestPolicy } from '../src/test-runs.ts';
import { runSandboxTestCommand } from '../src/sandbox-test-run.ts';
import type { SandboxTestRunPorts } from '../src/sandbox-test-run.ts';
import { auditEtchlyInventory, classifyVitestResult, planVitestInvocations, prepareEtchlyEnvironment, runVitestBatch } from '../src/test-run-etchly.ts';
import type { EtchlyEnvironmentFacts, EtchlyInventoryFact, EtchlyTestRunProfile, VitestBatchApi, VitestLifecycleEvent } from '../src/test-run-etchly.ts';
import type { DiagnosticLimits } from '../src/test-run-diagnostics.ts';
import * as etchlyAdapter from '../src/test-run-etchly.ts';
import { observeEtchlyInventory } from '../src/test-run-etchly-inventory.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = '/work/etchly-develop';
const group = 'reduce-etchly-codebase/product-defaults';
const product = 'app/admin/sections/product-defaults.test.tsx';
const worker = 'worker/scripts/checks-composition.test.ts';
const policy: UnitTestPolicy = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8')).unitTests;
const limits: DiagnosticLimits = JSON.parse(readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8')).diagnostics;
const paths = { workspace, qaHome: '/qa/home', fixtureRoots: ['/qa/tmp'] };
const definitions = [
  ['vitest-app', 'app', 'app', product],
  ['vitest-worker', 'worker', 'worker-unit', worker],
  ['vitest-worker-consent-dom', 'worker', 'worker-consent-dom', 'worker/src/cookie-consent-ui.test.ts'],
  ...['assessment', 'domain', 'i18n', 'markdown', 'ui-core'].map(w => [`vitest-${w}`, `shared/${w}`, '', `shared/${w}/src/value.test.ts`]),
] as const;

function profiles(): Record<string, EtchlyTestRunProfile> {
  return Object.fromEntries([
    ...definitions.map(([id, cwd, project, file]) => {
      const prefix = cwd.startsWith('shared/') ? '../../' : '../';
      return [id, {
        cwd, executable: '/local/node',
        argv: ['--import', `${prefix}scripts/shared-library-runtime.mjs`, `${prefix}node_modules/vitest/vitest.mjs`, 'run', '--configLoader', 'runner', ...(project ? ['--project', project] : [])],
        unitFiles: [file, `${cwd}/${id}.other.test.ts`], exactIds: 'vitest-test-name', resultAdapter: 'vitest-events',
        environment: { isolatedHome: true, stateOrigin: true }, checks: ['vitest.config.ts'],
      } satisfies EtchlyTestRunProfile];
    }),
    ['node-root', {
      cwd: '.', executable: '/local/node', argv: ['--test'],
      unitFiles: ['scripts/node-digest.test.mjs', 'scripts/node-runtime.test.mjs'],
      exactIds: 'node-test-name', resultAdapter: 'node-test-events',
      environment: { isolatedHome: true, stateOrigin: true }, checks: [],
    } satisfies EtchlyTestRunProfile],
  ]);
}

function config(): TestRunConfig {
  const hints = Object.fromEntries(['refusal', 'setup', 'assertions', 'timeout', 'interruption'].map(k => [k, `hint-${k}`]));
  return {
    diagnostics: limits, temporaryArtifacts: JSON.parse(readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8')).temporaryArtifacts,
    phases: Object.fromEntries(['red', 'implement', 'qa', 'hotfix'].map(phase => [phase, {
      allowed: true, purpose: phase === 'red' ? 'initial-red' : 'verification', hints,
    }])), hints: Object.fromEntries(Object.entries(hints).map(([k, v]) => [v, `fixture ${k}`])),
    projects: { etchly: {
      profiles: profiles(),
      groups: {
        [group]: { profileId: 'vitest-app', files: [product] },
        'reduce-etchly-codebase/worker-composition': { profileId: 'vitest-worker', files: [worker] },
      },
    } },
  } as unknown as TestRunConfig;
}

function context(): TestRunContext {
  return { cwd: workspace, workspace, projectWorkspaces: { etchly: [workspace], raf: ['/work/raf-develop'] },
    agentPhases: ['red', 'implement', 'qa', 'hotfix'], activeChanges: ['reduce-etchly-codebase'],
    agentId: 'etchly-implement', sha: 'fixture-sha', home: '/qa/home', statePath: '/qa/home/.raf/state.sqlite',
    tmpPath: '/qa/state-tmp', operationalHome: '/operational/home' };
}

function environment(): TestRunEnvironment {
  const files = Object.values(profiles()).flatMap(p => p.unitFiles);
  return { canonicalWorkspace: workspace, canonicalCwd: workspace, gitIdentityMatches: true,
    runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true, resultAdapterAvailable: true,
    artifactsWritable: true, treeControlSupported: true, isolatedHome: true, stateOriginAllowed: true,
    stateAliasesOperational: false, tmpAliasesOperational: false, inheritedOperationalChannel: false,
    unitFiles: files, files: Object.fromEntries(files.map(file => [file, { kind: 'file', realpath: `${workspace}/${file}`, unit: true }])) };
}

function request(files?: string[], selectedGroup = group) {
  return { project: 'etchly', phase: 'implement', group: selectedGroup, ...(files ? { files } : {}) };
}

function invocationPlan(files = [product], testIds: TestId[] = []): TestRunPlan {
  return { request: { ...request(files), ...(testIds.length ? { only: testIds } : {}) }, workspace, profileId: 'vitest-app',
    selection: { files, testIds }, command: { executable: '/local/node', argv: [], cwd: `${workspace}/app`, shell: false,
      environment: { HOME: '/qa/home', statePath: '/qa/home/.raf/state.sqlite', tmpPath: '/qa/state-tmp', TMPDIR: '/qa/private-run' } } };
}

function facts(): EtchlyEnvironmentFacts {
  return { workspace, branch: 'develop', expectedLibrary: '/work/shared-libs-develop', actualLibrary: '/work/shared-libs-develop', libraryBranch: 'develop',
    nodeAvailable: true, vitestAvailable: true, adapterCompatible: true, preloadAvailable: true, aliasesAvailable: true,
    configAvailable: true, happyDomRequired: true, happyDomAvailable: true, isolatedHome: true, stateOrigin: true,
    privateTmpWritable: true, browserRequired: false, trustedBrowserCache: '/host/cache', requestedBrowserCache: null, browserAvailable: true };
}

function refusal(operation: () => unknown, terms: RegExp): void {
  assert.throws(operation, error => {
    const e = error as Error & { code?: string; errorCode?: string };
    assert.match(`${e.code ?? e.errorCode ?? ''} ${e.message}`, terms);
    return true;
  });
}

function classify(events: VitestLifecycleEvent[], exitCode = 0) {
  return classifyVitestResult(events, { exitCode, signal: null, stderr: 'FAIL is untrusted text' }, 'app', limits, paths);
}

const localId = { file: 'admin/sections/product-defaults.test.tsx', name: 'defaults suite literal a.* [x] (one)|two$' };
const canonicalId = { ...localId, file: product };

for (const [id, cwd, project, file] of definitions) {
  test(`${id}: profile schema accepts existing fields and chooses one root-relative file`, () => {
    const c = config();
    c.projects.etchly.groups['reduce-etchly-codebase/workspace-case'] = { profileId: id, files: [file] };
    validateTestRunConfig(c, ['red', 'implement', 'qa', 'hotfix'], policy);
    const p = planTestRun(request([file], 'reduce-etchly-codebase/workspace-case'), c, context(), environment());
    assert.equal(p.profileId, id);
    assert.equal(p.command.cwd, `${workspace}/${cwd}`);
    assert.deepEqual(p.selection.files, [file]);
    assert.equal(p.command.shell, false);
    const commands = planVitestInvocations(p, profiles()[id], policy, '/trusted/vitest-reporter.mjs', []);
    assert.equal(commands.length, 1);
    const argv = commands[0].argv;
    const run = argv.indexOf('run');
    assert.ok(run > 0);
    assert.equal(argv[run + 1], file.slice(cwd.length + 1));
    assert.equal(argv.filter(a => a === file || a === file.slice(cwd.length + 1)).length, 1);
    const prefix = cwd.startsWith('shared/') ? '../../' : '../';
    assert.ok(argv.includes(`${prefix}scripts/shared-library-runtime.mjs`));
    assert.ok(argv.includes(`${prefix}node_modules/vitest/vitest.mjs`));
    assert.deepEqual(argv.slice(argv.indexOf('--configLoader'), argv.indexOf('--configLoader') + 2), ['--configLoader', 'runner']);
    if (project) assert.deepEqual(argv.slice(argv.indexOf('--project'), argv.indexOf('--project') + 2), ['--project', project]);
    else assert.equal(argv.includes('--project'), false);
    assert.equal(argv[argv.indexOf('--testTimeout') + 1], String(policy.timeoutMs));
    assert.equal(argv[argv.indexOf('--hookTimeout') + 1], String(policy.timeoutMs));
    assert.ok(argv.includes('/trusted/vitest-reporter.mjs'));
    assert.doesNotMatch(argv.join(' '), /npm|--workspaces|--passWithNoTests/);
    assert.deepEqual(commands[0].environment, p.command.environment);
  });
}

test('product-defaults explicit files and configured preset have identical canonical selection', () => {
  const c = config(), ctx = context(), env = environment();
  const explicit = planTestRun(request([product]), c, ctx, env);
  const preset = planTestRun(request(), c, ctx, env);
  assert.deepEqual(explicit.selection, preset.selection);
  assert.equal(preset.profileId, 'vitest-app');
});

test('Node root adapter and raf cwd-dot profile retain their configured argv and addresses', () => {
  const c = config(), file = 'scripts/node-digest.test.mjs';
  c.projects.etchly.groups['reduce-etchly-codebase/node-digest'] = { profileId: 'node-root', files: [file] };
  const p = planTestRun(request([file], 'reduce-etchly-codebase/node-digest'), c, context(), environment());
  assert.equal(p.command.cwd, workspace);
  assert.deepEqual(p.selection.files, [file]);
  assert.ok(p.command.argv.includes(file));
  assert.ok(p.command.argv.includes('--test'));
  assert.equal(p.command.argv.some(a => /vitest/.test(a)), false);
  const ctx = context(), env = environment();
  c.projects.raf = { profiles: { node: c.projects.etchly.profiles['node-root'] }, groups: { 'add-raf-test-run/node': { profileId: 'node', files: [file] } } };
  ctx.workspace = ctx.cwd = '/work/raf-develop'; ctx.activeChanges = ['add-raf-test-run'];
  env.canonicalWorkspace = env.canonicalCwd = ctx.workspace;
  env.unitFiles = profiles()['node-root'].unitFiles;
  env.files = Object.fromEntries(env.unitFiles.map(f => [f, { kind: 'file', realpath: `${ctx.workspace}/${f}`, unit: true }]));
  assert.equal(planTestRun({ project: 'raf', phase: 'red', group: 'add-raf-test-run/node' }, c, ctx, env).command.cwd, ctx.workspace);
});

for (const [label, files] of [
  ['app plus worker', [product, worker]],
  ['shared workspaces', ['shared/domain/src/value.test.ts', 'shared/i18n/src/value.test.ts']],
  ['Node plus Vitest', [product, 'scripts/node-digest.test.mjs']],
] as const) test(`refuse mixed ${label} before runner construction`, () => {
  const c = config();
  c.projects.etchly.groups[group].files = [...files];
  refusal(() => planTestRun(request([...files]), c, context(), environment()), /profile|mixed|runner|selection/i);
});

for (const file of ['worker/scripts/concept-import/native-continuation.test.ts', 'app/tools/browser.test.ts',
  'worker/src/test-support/live-worker.test.ts', 'shared-libs/resource-protocol/packages/store/src/store.test.ts']) {
  test(`non-unit selection refuses ${file} with a specific path`, () => {
    const c = config(), env = environment();
    env.files[file] = { kind: 'file', realpath: `${workspace}/${file}`, unit: false };
    c.projects.etchly.groups[group].files = [file];
    refusal(() => planTestRun(request([file]), c, context(), env), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

for (const file of ['app', 'app/**/*.test.ts', '../outside.test.ts', '/outside.test.ts', '--config=evil.test.ts']) {
  test(`unsafe or broad address refuses ${file}`, () => {
    refusal(() => planTestRun(request([file]), config(), context(), environment()), /file|path|selection|glob|directory|option|workspace/i);
  });
}

test('symlink selection outside canonical workspace is refused even when classified unit', () => {
  const env = environment(); env.files[product].realpath = '/work/shared-libs-develop/outside.test.ts';
  refusal(() => planTestRun(request([product]), config(), context(), env), /workspace|escape|symlink|outside/i);
});

test('unknown group never gains a preset from a suffix or profile ID', () => {
  refusal(() => planTestRun(request([product], 'reduce-etchly-codebase/unknown'), config(), context(), environment()), /group|configured|authorized/i);
});

test('full project inventory includes node-root and every Vitest workspace', () => {
  const c = config(), files = Object.values(c.projects.etchly.profiles).flatMap(p => p.unitFiles);
  refusal(() => planTestRun(request(files), c, context(), environment()), /full|entire|suite/i);
});

test('host refuses an etchly request from a live raf implement assignment before obtaining QA state', async () => {
  let contexts = 0;
  const identity = { pid: 1001, startedAt: '2026-10-23T00:00:00Z' };
  const ports: SandboxTestRunPorts = {
    caller: identity, entrypoint: ['/trusted/node', '/trusted/raf.ts'],
    control: async () => ({ ancestors: [identity], sessions: [{ process: identity, state: 'running', assignment: {
      runId: 'raf-run', agentId: 'raf-implement', type: 'implement', phase: 'implement', project: 'raf',
      workspace: '/work/raf-develop', branch: 'develop', changes: ['add-raf-test-run'],
    } }], workspaces: [{ project: 'etchly', workspace, branch: 'develop', actualBranch: 'develop' }],
      activeChanges: ['reduce-etchly-codebase'], groups: [{ project: 'etchly', workspace, group }] }),
    unitContext: async () => { contexts++; throw new Error('must not open state'); },
    communicate: async () => { throw new Error('not a communication command'); },
  };
  const reply = await runSandboxTestCommand({ cwd: workspace,
    command: `/trusted/node /trusted/raf.ts test run --project etchly --phase implement --group ${group} --files ${product}` }, ports);
  assert.notEqual(reply.code, 0);
  assert.match(reply.stdout + reply.stderr, /CALLER_UNAUTHORIZED/);
  assert.equal(contexts, 0);
});

const inventory = { profiles: { 'vitest-app': [product], 'vitest-worker': [worker], 'node-root': ['scripts/node-digest.test.mjs'] }, sourceHashes: { 'app/vitest.config.ts': 'hash-a', 'test-support/vitest-project-files.ts': 'hash-classifier' } };
const observed: EtchlyInventoryFact[] = [
  { file: product, profileId: 'vitest-app', classification: 'unit' },
  { file: worker, profileId: 'vitest-worker', classification: 'unit' },
  { file: 'scripts/node-digest.test.mjs', profileId: 'node-root', classification: 'unit' },
];

test('static inventory accepts exactly one current profile for every unit and excludes integration facts', () => {
  const extra = { file: 'worker/scripts/concept-import/native-continuation.test.ts', profileId: null, classification: 'integration' };
  assert.doesNotThrow(() => auditEtchlyInventory(structuredClone(inventory), [...observed, extra], inventory.sourceHashes));
});

for (const variant of ['new', 'deleted', 'reclassified', 'duplicate', 'moved-profile', 'stale-config', 'stale-graph'] as const) {
  test(`static inventory fails closed on ${variant}, naming paths and conf address`, () => {
    const c = structuredClone(inventory), o = structuredClone(observed), hashes: Record<string, string> = { ...inventory.sourceHashes };
    let target = product;
    if (variant === 'new') { target = 'app/admin/new.test.ts'; o.push({ file: target, profileId: 'vitest-app', classification: 'unit' }); }
    if (variant === 'deleted') o.shift();
    if (variant === 'reclassified') { o[0].classification = 'integration'; o[0].profileId = null; }
    if (variant === 'duplicate') c.profiles['vitest-worker'].push(product);
    if (variant === 'moved-profile') o[0].profileId = 'vitest-worker';
    if (variant === 'stale-config') { target = 'app/vitest.config.ts'; hashes[target] = 'changed'; }
    if (variant === 'stale-graph') { target = 'test-support/vitest-project-files.ts'; hashes[target] = 'changed'; }
    assert.throws(() => auditEtchlyInventory(c, o, hashes), error => {
      const e = error as Error & { code?: string; errorCode?: string };
      assert.match(`${e.code ?? e.errorCode ?? ''} ${e.message}`, /INVENTORY_INCOMPLETE/);
      assert.ok(e.message.includes(target));
      assert.match(e.message, /conf\/test-runs\.json.*projects.*etchly/);
      return true;
    });
  });
}

test('isolated HOME and private TMPDIR preserve only the trusted host browser cache', () => {
  const env = prepareEtchlyEnvironment(facts(), { home: '/qa/home', tmp: '/qa/private-run' });
  assert.deepEqual(env, { HOME: '/qa/home', TMPDIR: '/qa/private-run', PLAYWRIGHT_BROWSERS_PATH: '/host/cache' });
  const f = facts(); f.trustedBrowserCache = null;
  assert.deepEqual(prepareEtchlyEnvironment(f, { home: '/qa/home', tmp: '/qa/private-run' }), { HOME: '/qa/home', TMPDIR: '/qa/private-run' });
});

for (const key of ['nodeAvailable', 'vitestAvailable', 'adapterCompatible', 'preloadAvailable', 'aliasesAvailable', 'configAvailable', 'happyDomAvailable', 'isolatedHome', 'stateOrigin', 'privateTmpWritable'] as const) {
  test(`missing ${key} is setup/environment failure with no automatic repair`, () => {
    const f = facts(); f[key] = false;
    refusal(() => prepareEtchlyEnvironment(f, { home: '/qa/home', tmp: '/qa/private-run' }), /setup|environment|unavailable|isolat|state|tmp|runtime|adapter|preload|alias|config|happy/i);
  });
}

for (const variant of ['missing-library', 'wrong-library', 'wrong-library-branch', 'missing-browser', 'untrusted-cache'] as const) {
  test(`${variant} refuses environment preparation`, () => {
    const f = facts();
    if (variant === 'missing-library') f.actualLibrary = null;
    if (variant === 'wrong-library') f.actualLibrary = '/work/shared-libs-main';
    if (variant === 'wrong-library-branch') f.libraryBranch = 'main';
    if (variant === 'missing-browser') { f.browserRequired = true; f.browserAvailable = false; }
    if (variant === 'untrusted-cache') f.requestedBrowserCache = '/agent/cache';
    refusal(() => prepareEtchlyEnvironment(f, { home: '/qa/home', tmp: '/qa/private-run' }), /setup|environment|library|shared|branch|browser|cache|trusted/i);
  });
}

test('green structured lifecycle returns root-relative IDs despite misleading stderr', () => {
  const r = classify([{ kind: 'collected', tests: [localId] }, { kind: 'started', test: localId }, { kind: 'passed', test: localId }, { kind: 'finished' }]);
  assert.equal(r.outcome, 'passed'); assert.deepEqual(r.passed, [canonicalId]);
  assert.deepEqual(r.knownRed, []); assert.deepEqual(r.unknown, []); assert.deepEqual(r.unexecuted, []);
});

test('first failure preserves stopped and declaratively skipped tests as unexecuted', () => {
  const stopped = { ...localId, name: 'later behavior' }, declared = { ...localId, name: 'declared skip' };
  const r = classify([{ kind: 'collected', tests: [localId, stopped, declared] }, { kind: 'started', test: localId },
    { kind: 'failed', test: localId, origin: 'test-body', error: { name: 'Error', code: 'PRODUCT_FAILURE', message: 'expected behavior absent' } },
    { kind: 'skipped', test: stopped, reason: 'first-failure' }, { kind: 'skipped', test: declared, reason: 'declared' }, { kind: 'finished' }], 1);
  assert.equal(r.outcome, 'assertions-failed'); assert.deepEqual(r.knownRed, [canonicalId]); assert.deepEqual(r.passed, []);
  assert.deepEqual(r.unexecuted, [stopped, declared].map(t => ({ ...t, file: product })));
  assert.equal(r.diagnostics[0].test?.file, product); assert.equal(r.diagnostics[0].kind, 'test-failure');
  assert.match(r.diagnostics[0].message, /expected behavior absent/);
});

for (const origin of ['import', 'collection', 'hook', 'fixture-setup', 'unknown'] as const) {
  test(`${origin} AssertionError remains setup instead of red`, () => {
    const r = classify([{ kind: 'collected', tests: [localId] },
      { kind: 'failed', test: origin === 'import' || origin === 'collection' ? null : localId, origin, error: { name: 'AssertionError', message: 'FAIL expected fixture' } }, { kind: 'finished' }], 1);
    assert.equal(r.outcome, 'setup-failed'); assert.deepEqual(r.knownRed, []);
    assert.ok(r.diagnostics.some(d => d.kind === 'setup' || d.kind === 'protocol'));
  });
}

for (const variant of ['empty', 'missing-finish', 'missing-outcome', 'broken-protocol', 'nonzero-exit', 'path-escape'] as const) {
  test(`${variant} never reports passed`, () => {
    const events: VitestLifecycleEvent[] = [{ kind: 'collected', tests: [localId] }, { kind: 'passed', test: localId }, { kind: 'finished' }];
    if (variant === 'empty') events.splice(0, events.length, { kind: 'collected', tests: [] }, { kind: 'finished' });
    if (variant === 'missing-finish') events.pop();
    if (variant === 'missing-outcome') events.splice(1, 1);
    if (variant === 'broken-protocol') events.push({ kind: 'protocol-error', message: 'truncated structured frame' });
    if (variant === 'path-escape') events.splice(0, events.length, { kind: 'collected', tests: [{ ...localId, file: '../../outside.test.ts' }] }, { kind: 'finished' });
    const r = classify(events, variant === 'nonzero-exit' ? 7 : 0);
    assert.notEqual(r.outcome, 'passed');
    if (variant === 'missing-outcome' || variant === 'missing-finish') assert.ok(r.unknown.length + r.unexecuted.length > 0);
  });
}

test('body diagnostics retain safe location and bounded redacted message through Vitest adaptation', () => {
  const error = { name: 'AssertionError', message: `expected setting; sk-proj-${'x'.repeat(80)} ${'🙂'.repeat(limits.maxMessageBytes)}`,
    stack: `AssertionError: setting\n    at check (${workspace}/app/admin/sections/product-defaults.test.tsx:12:4)\n    at private (/qa/home/private.ts:8:2)` };
  const r = classify([{ kind: 'collected', tests: [localId] }, { kind: 'started', test: localId },
    { kind: 'failed', test: localId, origin: 'test-body', error }, { kind: 'finished' }], 1);
  assert.deepEqual(r.knownRed, [canonicalId]); assert.equal(r.diagnostics[0].kind, 'assertion');
  assert.equal(r.diagnostics[0].location?.file, localId.file);
  assert.ok(Buffer.byteLength(r.diagnostics[0].message) <= limits.maxMessageBytes);
  assert.ok(r.diagnostics[0].stack.length <= limits.maxStackFrames);
  assert.doesNotMatch(JSON.stringify(r), /sk-proj-x|\/qa\/home|\/work\/etchly-develop/);
  assert.equal(r.diagnosticSummary.redacted, true); assert.equal(r.diagnosticSummary.truncated, true);
});

test('only escapes and anchors the full test name instead of selecting matching fragments', () => {
  const p = invocationPlan([product], [canonicalId]);
  const commands = planVitestInvocations(p, profiles()['vitest-app'], policy, '/trusted/reporter.mjs', [canonicalId]);
  assert.equal(commands.length, 1);
  const argv = commands[0].argv, filter = argv[argv.indexOf('-t') + 1];
  assert.ok(argv.includes('-t')); assert.ok(filter.startsWith('^')); assert.ok(filter.endsWith('$'));
  const re = new RegExp(filter);
  assert.equal(re.test(canonicalId.name), true);
  assert.equal(re.test(`prefix ${canonicalId.name}`), false);
  assert.equal(re.test(`${canonicalId.name} suffix`), false);
  assert.equal(re.test('defaults suite literal anything x one'), false);
});

test('only IDs in two files never cross-select their different names', () => {
  const secondFile = 'app/admin/other.test.tsx';
  const first = { file: product, name: 'suite first.*' }, second = { file: secondFile, name: 'suite second[0]' };
  const profile = profiles()['vitest-app']; profile.unitFiles.push(secondFile);
  const commands = planVitestInvocations(invocationPlan([product, secondFile], [first, second]), profile, policy, '/trusted/reporter.mjs', [first, second]);
  assert.equal(commands.length, 2);
  for (const [index, id] of [first, second].entries()) {
    const argv = commands[index].argv;
    assert.equal(argv[argv.indexOf('run') + 1], id.file.slice(4));
    assert.equal(argv.includes([second, first][index].file.slice(4)), false);
    const re = new RegExp(argv[argv.indexOf('-t') + 1]);
    assert.equal(re.test(id.name), true); assert.equal(re.test([second, first][index].name), false);
    assert.equal(commands[index].environment.TMPDIR, '/qa/private-run');
  }
});

test('identical full names in separate files retain separate exact file addresses', () => {
  const secondFile = 'app/admin/other.test.tsx';
  const ids = [product, secondFile].map(file => ({ file, name: 'suite shared [literal].*' }));
  const profile = profiles()['vitest-app']; profile.unitFiles.push(secondFile);
  const commands = planVitestInvocations(invocationPlan([product, secondFile], ids), profile, policy, '/trusted/reporter.mjs', ids);
  assert.equal(commands.length, 2);
  for (const [index, id] of ids.entries()) {
    const argv = commands[index].argv;
    assert.equal(argv[argv.indexOf('run') + 1], id.file.slice(4));
    assert.equal(argv.includes(ids[1 - index].file.slice(4)), false);
    const filter = argv[argv.indexOf('-t') + 1];
    assert.ok(filter.startsWith('^')); assert.ok(filter.endsWith('$'));
    assert.equal(new RegExp(filter).test(id.name), true);
    assert.equal(new RegExp(filter).test(`prefix ${id.name}`), false);
  }
});

test('only unknown ID or a file outside selection is refused without a whole-file fallback', () => {
  refusal(() => planVitestInvocations(invocationPlan([product], [canonicalId]), profiles()['vitest-app'], policy, '/trusted/reporter.mjs', []), /known|red|only|id/i);
  const outside = { ...canonicalId, file: 'app/admin/outside.test.tsx' };
  refusal(() => planVitestInvocations(invocationPlan([product], [outside]), profiles()['vitest-app'], policy, '/trusted/reporter.mjs', [outside]), /file|selection|only/i);
});

test('Node environment does not require DOM dependencies or a browser when the unit does not use them', () => {
  const f = facts(); f.happyDomRequired = false; f.happyDomAvailable = false;
  f.trustedBrowserCache = null; f.browserAvailable = false;
  assert.doesNotThrow(() => prepareEtchlyEnvironment(f, { home: '/qa/home', tmp: '/qa/private-run' }));
});

test('browser fixture without a trusted host cache is setup failure even if another cache exists', () => {
  const f = facts(); f.browserRequired = true; f.trustedBrowserCache = null; f.browserAvailable = true;
  refusal(() => prepareEtchlyEnvironment(f, { home: '/qa/home', tmp: '/qa/private-run' }), /setup|browser|cache|trusted/i);
});

test('absolute runner file is normalized once to the canonical root-relative identity', () => {
  const absolute = { ...localId, file: `${workspace}/${product}` };
  const r = classify([{ kind: 'collected', tests: [absolute] }, { kind: 'started', test: absolute }, { kind: 'passed', test: absolute }, { kind: 'finished' }]);
  assert.deepEqual(r.passed, [canonicalId]);
});

test('mixed body failure and later hook failure retain both facts without turning setup into red', () => {
  const hook = { ...localId, name: 'later hook' };
  const r = classify([{ kind: 'collected', tests: [localId, hook] }, { kind: 'started', test: localId },
    { kind: 'failed', test: localId, origin: 'test-body', error: { name: 'Error', message: 'behavior failed' } },
    { kind: 'failed', test: hook, origin: 'hook', error: { name: 'AssertionError', message: 'hook preparation failed' } }, { kind: 'finished' }], 1);
  assert.deepEqual(r.knownRed, [canonicalId]); assert.ok(r.failureKinds.includes('assertions')); assert.ok(r.failureKinds.includes('setup'));
  assert.ok(r.diagnostics.some(d => d.kind === 'test-failure')); assert.ok(r.diagnostics.some(d => d.kind === 'setup'));
});

test('unreceived outcomes stay unknown and raw FAIL/PASS text cannot manufacture a lifecycle', () => {
  const r = classifyVitestResult([], { exitCode: 0, signal: null, stderr: 'Tests 99 passed PASS' }, 'app', limits, paths);
  assert.notEqual(r.outcome, 'passed'); assert.deepEqual(r.passed, []);
  assert.ok(r.diagnostics.some(d => d.kind === 'protocol' || d.kind === 'runner'));
});

test('trusted Vitest API applies structured runner without an unsupported CLI flag', async () => {
  const run = (etchlyAdapter as any).runVitestBatch;
  assert.equal(typeof run, 'function', 'Vitest CLI rejects --runner; use the trusted programmatic boundary');
  const argv = ['run', 'admin/value.test.ts', '--project', 'app', '-t', '^literal\\[x\\]$', '--hookTimeout', '1234'];
  const projects = [{ config: { runner: '/etchly/file-budget-runner.ts', hookTimeout: 9, include: ['value.test.ts'] } }, { config: { runner: '/etchly/file-budget-runner.ts', hookTimeout: 10 } }];
  const calls: unknown[] = [];
  const api = {
    parseCLI(args: string[]) {
      assert.deepEqual(args, ['vitest', ...argv]);
      assert.equal(args.includes('--runner'), false);
      return { filter: ['admin/value.test.ts'], options: { run: true, project: ['app'], testNamePattern: '^literal\\[x\\]$', hookTimeout: 1234 } };
    },
    async createVitest(mode: string, options: any) {
      assert.equal(mode, 'test');
      assert.equal(options.watch, false);
      assert.deepEqual(options.project, ['app']);
      assert.equal(options.testNamePattern, '^literal\\[x\\]$');
      return { projects, async start(files: string[]) {
        assert.deepEqual(files, ['admin/value.test.ts']);
        for (const p of projects) {
          assert.equal(p.config.runner, '/trusted/structured-runner.ts');
          assert.equal(p.config.hookTimeout, 1234);
        }
        assert.deepEqual(projects[0].config.include, ['value.test.ts']);
        calls.push('start');
      }, async close() { calls.push('close'); } };
    },
  };
  await run(api, argv, '/trusted/structured-runner.ts');
  assert.deepEqual(calls, ['start', 'close']);
  api.createVitest = async () => ({ projects, async start() { throw new Error('collection failure'); }, async close() { calls.push('close-after-failure'); } }) as any;
  await assert.rejects(run(api, argv, '/trusted/structured-runner.ts'), /collection failure/);
  assert.equal(calls.at(-1), 'close-after-failure');
});

test('missing Etchly audited prerequisite is environment setup rather than stale inventory refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'raf-etchly-prerequisite-'));
  try {
    await assert.rejects(observeEtchlyInventory(root, {}), (error: any) => {
      assert.equal(error.code, 'ENVIRONMENT_INVALID');
      assert.match(error.message, /package\.json/);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [label, profileId, preset, dom] of [
  ['app explicit files', 'vitest-app', false, true],
  ['product-defaults preset', 'vitest-app', true, true],
  ['worker consent DOM', 'vitest-worker-consent-dom', false, true],
  ['ui-core DOM', 'vitest-ui-core', false, true],
  ['worker Node control', 'vitest-worker', false, false],
] as const) {
  test(`external trusted runner retains its filesystem identity for ${label}`, async () => {
    const c = config(), profile = c.projects.etchly.profiles[profileId];
    const file = profile.unitFiles[0], selectedGroup = 'reduce-etchly-codebase/external-runner';
    c.projects.etchly.groups[selectedGroup] = { profileId, files: [file] };
    const plan = planTestRun(request(preset ? undefined : [file], selectedGroup), c, context(), environment());
    const batch = planVitestInvocations(plan, profile, policy, '/trusted/raf/src/test-run-vitest-reporter.ts', [])[0];
    const argv = batch.argv.slice(batch.argv.indexOf('run'));
    const runner = '/trusted/raf/src/test-run-vitest-runner.ts';
    const projectConfig = { root: batch.cwd, environment: dom ? 'happy-dom' : 'node',
      runner: `${batch.cwd}/file-budget-runner.ts`, hookTimeout: 1,
      include: ['only-unit-files'], setupFiles: ['test-support/setup.ts'],
      deps: { web: { transformCss: true } } };
    const retained = structuredClone(projectConfig);
    const calls: string[] = [];
    const api: VitestBatchApi = {
      parseCLI(args) {
        assert.deepEqual(args, ['vitest', ...argv]);
        assert.equal(args.includes('--runner'), false);
        return { filter: [file.slice(profile.cwd.length + 1)], options: {
          run: true, hookTimeout: policy.timeoutMs, project: profileId === 'vitest-app' ? ['app'] :
            profileId === 'vitest-worker-consent-dom' ? ['worker-consent-dom'] :
              profileId === 'vitest-worker' ? ['worker-unit'] : undefined,
        } };
      },
      async createVitest(mode, options) {
        assert.equal(mode, 'test');
        assert.equal(options.watch, false);
        return { projects: [{ config: projectConfig }], async start(files) {
          assert.deepEqual(files, [file.slice(profile.cwd.length + 1)]);
          const id = projectConfig.runner;
          assert.equal(typeof id, 'string');
          const loadedFile = id.startsWith('/@fs/') ? id.slice('/@fs'.length) :
            id.startsWith('file:') ? fileURLToPath(id) : dom ? `${projectConfig.root}${id}` : id;
          assert.equal(loadedFile, runner, 'DOM URL resolution must reach the external trusted runner, not a path under the Etchly root');
          assert.equal(projectConfig.hookTimeout, policy.timeoutMs);
          assert.equal(projectConfig.root, retained.root);
          assert.equal(projectConfig.environment, retained.environment);
          assert.deepEqual(projectConfig.include, retained.include);
          assert.deepEqual(projectConfig.setupFiles, retained.setupFiles);
          assert.equal(projectConfig.deps.web.transformCss, retained.deps.web.transformCss);
          calls.push('start');
        }, async close() { calls.push('close'); } };
      },
    };
    await runVitestBatch(api, argv, runner);
    assert.deepEqual(calls, ['start', 'close']);
    assert.equal(batch.environment.HOME, '/qa/home');
    assert.deepEqual(plan.selection.files, [file]);
    assert.ok(batch.argv.some(arg => arg.endsWith('scripts/shared-library-runtime.mjs')));
  });
}

for (const missing of ['runtimeAvailable', 'dependenciesAvailable', 'resultAdapterAvailable'] as const) {
  test(`full explicit Etchly inventory is refused before missing ${missing}`, () => {
    const c = config(), env = environment();
    const files = Object.values(c.projects.etchly.profiles).flatMap(profile => profile.unitFiles);
    env[missing] = false;
    assert.throws(() => planTestRun(request(files), c, context(), env), (error: any) => {
      assert.equal(error.code, 'UNSAFE_SELECTION');
      assert.match(error.message, /full|entire|suite/i);
      return true;
    });
  });
}

for (const fullSuite of [true, false]) {
  test(`${fullSuite ? 'full-suite-explicit refuses before' : 'valid subset retains'} Etchly browser-cache preflight failure`, async () => {
    const c = config();
    const files = fullSuite ? Object.values(c.projects.etchly.profiles).flatMap(profile => profile.unitFiles) : [product];
    const calls = { preflight: 0, spawn: 0, temporary: 0 };
    let stored: TestRunGroup | null = null;
    const ports: TestRunPorts = {
      state: { async transaction(operation) {
        return operation({ get: () => stored, list: () => stored ? [stored] : [],
          put: value => { stored = structuredClone(value); }, delete: () => { stored = null; } });
      } },
      clock: { now: () => Date.parse('2026-10-23T00:00:00Z'), schedule: () => () => {} },
      newRunId: () => 'etchly-selection-priority',
      async preflight() {
        calls.preflight++;
        throw Object.assign(new Error('Etchly setup: browser cache; repair environment without install or branch changes'), { code: 'ENVIRONMENT_INVALID' });
      },
      async prepareTemporary() { calls.temporary++; throw new Error('must not allocate run tmp'); },
      async spawn() { calls.spawn++; throw new Error('must not spawn a runner'); },
      subscribeInterruption: () => () => {},
      async reconcile() { return { alive: false, deadlineReached: false, cleanup: { complete: true, remainingPids: [] } }; },
    };
    const result = await runTestRun(request(files), c, policy, context(), ports);
    assert.equal(result.outcome, fullSuite ? 'refused' : 'setup-failed');
    assert.equal(result.errorCode, fullSuite ? 'UNSAFE_SELECTION' : 'ENVIRONMENT_INVALID');
    assert.deepEqual(result.failureKinds, [fullSuite ? 'refusal' : 'setup']);
    assert.deepEqual(calls, { preflight: fullSuite ? 0 : 1, spawn: 0, temporary: 0 });
    assert.equal(result.command, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.timeoutCount, 0);
    assert.deepEqual(result.knownRed, []);
    assert.deepEqual(result.passed, []);
    assert.deepEqual(result.cleanup, { complete: true, remainingPids: [] });
  });
}
