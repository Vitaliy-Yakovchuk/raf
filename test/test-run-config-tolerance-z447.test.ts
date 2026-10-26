import assert from 'node:assert/strict';
import test from 'node:test';
import { planTestRun, runTestRun, validateTestRunConfig } from '../src/test-runs.ts';
import { prepareTestRunProfile } from '../src/test-run-integration-profiles.ts';
import { alpha, beta, files, fixtureConfig, fixtureContext, fixtureEnvironment, fixtureRequest, policy, RunHarness } from './helpers/test-run-fixture.ts';

for (const [label, entry] of [
  ['null profile', null],
  ['unknown kind', { testKind: 'stand' }],
  ['malformed argv', { argv: 'run' }],
  ['unsupported adapter', { resultAdapter: 'unknown' }],
  ['both inventories', { integrationFiles: ['test/integration.test.ts'] }],
  ['empty inventory', { unitFiles: [] }],
  ['shell command', { executable: 'bash', argv: ['-c', 'echo unsafe'] }],
  ['unsafe inventory', { unitFiles: ['../outside.test.ts'] }],
] as const) {
  test(`Z447 skips ${label} and dependent group while keeping valid project configuration`, t => {
    const config = fixtureConfig();
    (config.projects as any).other = { profiles: { broken: entry === null ? null : { ...config.projects.raf.profiles.node, ...entry } }, groups: { 'other/broken': { profileId: 'broken', files: [files[0]] } } };
    const before = structuredClone(config);
    let warnings = '';
    t.mock.method(process.stderr, 'write', chunk => { warnings += String(chunk); return true; });
    const validated = validateTestRunConfig(config, Object.keys(config.phases), policy);
    assert.deepEqual(validated.projects.raf, before.projects.raf);
    assert.equal(validated.projects.other.profiles.broken, undefined);
    assert.equal(validated.projects.other.groups['other/broken'], undefined);
    assert.match(warnings, /Warning:.*projects\/other\/profiles\/broken/);
    assert.match(warnings, /projects\/other\/groups\/other(?:~1|\/)broken/);
    assert.deepEqual(config, before, 'validation must not rewrite source configuration');
    assert.deepEqual(planTestRun(fixtureRequest(), validated, fixtureContext(), fixtureEnvironment()).selection.files, files.slice(0, 2));
  });
}

for (const [label, entry] of [
  ['null', null],
  ['unknown profile', { profileId: 'missing', files: [files[0]] }],
  ['foreign file', { profileId: 'node', files: ['test/not-in-inventory.test.ts'] }],
  ['empty', { profileId: 'node', files: [] }],
  ['duplicate', { profileId: 'node', files: [files[0], files[0]] }],
] as const) {
  test(`Z447 skips ${label} group with warning and runs valid group`, async t => {
    const harness = new RunHarness();
    (harness.config.projects.raf.groups as any)['other/broken'] = entry;
    let warnings = '';
    t.mock.method(process.stderr, 'write', chunk => { warnings += String(chunk); return true; });
    const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
    assert.equal(result.outcome, 'passed');
    assert.equal(harness.spawns.length, 1);
    assert.deepEqual(result.passed, [alpha, beta]);
    assert.match(warnings, /Warning:.*projects\/raf\/groups\/other(?:~1|\/)broken/);
  });
}

test('Z447 ignores an invalid profile before checking duplicate inventory membership', t => {
  const config = fixtureConfig();
  config.projects.raf.profiles = { broken: { ...config.projects.raf.profiles.node, argv: ['--eval', 'unsafe'] }, ...config.projects.raf.profiles };
  t.mock.method(process.stderr, 'write', () => true);
  const validated = validateTestRunConfig(config, Object.keys(config.phases), policy);
  assert.equal(validated.projects.raf.profiles.broken, undefined);
  assert.ok(validated.projects.raf.profiles.node);
});

test('Z447 missing configured unit files warn and leave runnable files in the preset', async t => {
  const harness = new RunHarness();
  delete harness.environment.files[files[1]];
  harness.environment.unitFiles = harness.environment.unitFiles.filter(file => file !== files[1]);
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  let warnings = '';
  t.mock.method(process.stderr, 'write', chunk => { warnings += String(chunk); return true; });
  const result = await runTestRun(fixtureRequest({ files: undefined }), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.selection.files, [files[0]]);
  assert.match(warnings, /Warning:.*beta\.test\.ts/);
});

function integrationFixture() {
  const configuration = fixtureConfig();
  const profile = configuration.projects.raf.profiles.node;
  configuration.projects.raf.profiles.integration = { ...profile, testKind: 'integration', unitFiles: undefined, integrationFiles: ['test/live.test.ts', 'test/deleted.test.ts'] };
  delete configuration.projects.raf.profiles.integration.unitFiles;
  configuration.projects.raf.groups['change/live'] = { profileId: 'integration', files: ['test/live.test.ts', 'test/deleted.test.ts'] };
  return {
    configuration, flow: { unitTests: policy, integrationTests: { timeoutMs: policy.timeoutMs } },
    request: { project: 'raf', workspace: '/qa/workspace', branch: 'hotfix', phase: 'integration', group: 'change/live' },
    inventory: [{ file: 'test/live.test.ts', exists: true, canonicalInsideWorkspace: true, kind: 'integration' as const }],
  };
}

test('Z447 missing selected integration file warns and is excluded without changing source preset', t => {
  const input = integrationFixture();
  let warnings = '';
  t.mock.method(process.stderr, 'write', chunk => { warnings += String(chunk); return true; });
  const plan = prepareTestRunProfile(input.configuration as any, input.flow, input.request, input.inventory);
  assert.deepEqual(plan.selection.files, ['test/live.test.ts']);
  assert.ok(!plan.command.argv.includes('test/deleted.test.ts'));
  assert.deepEqual(input.configuration.projects.raf.groups['change/live'].files, ['test/live.test.ts', 'test/deleted.test.ts']);
  assert.match(warnings, /Warning:.*test\/deleted\.test\.ts/);
});

test('Z447 invalid unrelated group cannot stop integration selection', t => {
  const input = integrationFixture();
  input.configuration.projects.raf.groups['change/live'].files = ['test/live.test.ts'];
  (input.configuration.projects.raf.groups as any)['other/broken'] = null;
  t.mock.method(process.stderr, 'write', () => true);
  assert.deepEqual(prepareTestRunProfile(input.configuration as any, input.flow, input.request, input.inventory).selection.files, ['test/live.test.ts']);
});

test('Z447 an empty selection after skipping missing files does not spawn a runner', async t => {
  const harness = new RunHarness();
  harness.environment.files = {};
  harness.environment.unitFiles = [];
  t.mock.method(process.stderr, 'write', () => true);
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, 'EMPTY_SELECTION');
  assert.equal(harness.spawns.length, 0);
});
