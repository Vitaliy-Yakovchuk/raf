import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planTestRun, validateTestRunConfig } from '../src/test-runs.ts';
import type { TestId, TestRunConfig, TestRunContext, TestRunEnvironment, TestRunPlan, UnitTestPolicy } from '../src/test-runs.ts';
import { runSandboxTestCommand } from '../src/sandbox-test-run.ts';
import type { SandboxTestRunPorts } from '../src/sandbox-test-run.ts';
import { auditEtchlyInventory, classifyVitestResult, planVitestInvocations, prepareEtchlyEnvironment } from '../src/test-run-etchly.ts';
import type { EtchlyEnvironmentFacts, EtchlyInventoryFact, EtchlyTestRunProfile, VitestLifecycleEvent } from '../src/test-run-etchly.ts';
import type { DiagnosticLimits } from '../src/test-run-diagnostics.ts';

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
        unitFiles: [file, `${cwd}/other.test.ts`], exactIds: 'vitest-test-name', resultAdapter: 'vitest-events',
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
  for (const [f, fact] of Object.entries(env.files)) fact.realpath = `${ctx.workspace}/${f}`;
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
  c.projects.etchly.groups[group].files = files;
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
