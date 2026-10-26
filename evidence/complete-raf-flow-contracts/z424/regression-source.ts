import assert from 'node:assert/strict';
import test from 'node:test';
import { planTestRun, runTestRun } from '../src/test-runs.ts';
import { prepareTestRunProfile, type InventoryFact } from '../src/test-run-integration-profiles.ts';
import { files, fixtureRequest, policy, RunHarness } from './helpers/test-run-fixture.ts';

const integrationFile = 'test/local-integration.test.ts';
const otherUnit = 'test/other-branch-unit.test.ts';
const otherIntegration = 'test/other-branch-integration.test.ts';
const integrationGroup = 'add-raf-test-run/local-integration';

function fixture(branch: string) {
  const h = new RunHarness();
  h.context.workspace = h.context.cwd = `/work/raf-${branch}`;
  h.context.integrationTests = { timeoutMs: policy.timeoutMs };
  h.environment.canonicalWorkspace = h.environment.canonicalCwd = h.context.workspace;
  for (const [file, fact] of Object.entries(h.environment.files)) fact.realpath = `${h.context.workspace}/${file}`;
  h.config.phases.integration = { ...h.config.phases.hotfix, allowed: true, purpose: 'verification' };
  h.config.projects.raf.profiles.node.unitFiles!.push(otherUnit);
  const { unitFiles, ...node } = h.config.projects.raf.profiles.node;
  h.config.projects.raf.profiles.integration = { ...node, testKind: 'integration', integrationFiles: [integrationFile, otherIntegration] };
  h.config.projects.raf.groups[integrationGroup] = { profileId: 'integration', files: [integrationFile] };
  h.environment.files[integrationFile] = { kind: 'file', realpath: `${h.context.workspace}/${integrationFile}`, unit: false, testKind: 'integration' };
  return h;
}

function request(kind: 'unit' | 'integration', preset = false) {
  return kind === 'unit' ? fixtureRequest({ phase: 'hotfix', ...(preset ? { files: undefined } : {}) })
    : fixtureRequest({ phase: 'integration', group: integrationGroup, files: preset ? undefined : [integrationFile] });
}

function prepare(h: RunHarness, r: ReturnType<typeof request>) {
  const inventory: InventoryFact[] = Object.entries(h.environment.files).map(([file, fact]) => ({
    file, exists: fact.kind === 'file', canonicalInsideWorkspace: fact.realpath === `${h.context.workspace}/${file}`,
    kind: fact.testKind ?? (fact.unit ? 'unit' : 'integration'),
  }));
  return prepareTestRunProfile(h.config as unknown as Record<string, unknown>, {
    unitTests: policy, integrationTests: h.context.integrationTests,
  }, { ...r, workspace: h.context.workspace, branch: '' }, inventory);
}

for (const branch of ['develop', 'hotfix']) for (const kind of ['unit', 'integration'] as const) {
  for (const preset of [false, true]) {
    test(`Z424 ${branch} ${kind} ${preset ? 'preset' : 'files'} ignores absent registrations from the other branch`, () => {
      const h = fixture(branch), r = request(kind, preset);
      const before = structuredClone(h.config);
      const planned = planTestRun(r, h.config, h.context, h.environment);
      const prepared = prepare(h, r);
      const expected = kind === 'unit' ? files.slice(0, 2) : [integrationFile];
      assert.deepEqual(planned.selection.files, expected);
      assert.deepEqual(prepared.selection.files, expected);
      assert.equal(planned.testKind, kind);
      assert.equal(prepared.testKind, kind);
      assert.deepEqual(h.config, before);
    });
  }

  test(`Z424 ${branch} ${kind} selected absent registered file refuses before state or spawn`, async () => {
    const h = fixture(branch), r = request(kind, true);
    const missing = kind === 'unit' ? otherUnit : otherIntegration;
    h.config.projects.raf.groups[r.group].files = [missing];
    assert.throws(() => prepare(h, r), error => error instanceof Error && error.message.includes(missing));
    const result = await runTestRun(r, h.config, policy, h.context, h.ports);
    assert.equal(result.outcome, 'refused');
    assert.ok(result.diagnostics.some(d => d.message.includes(missing)));
    assert.equal(h.state.transactionCount, 0);
    assert.equal(h.spawns.length, 0);
  });

  test(`Z424 ${branch} ${kind} unregistered selected file still refuses`, () => {
    const h = fixture(branch), r = request(kind);
    const unregistered = 'test/unregistered.test.ts';
    h.environment.files[unregistered] = { kind: 'file', realpath: `${h.context.workspace}/${unregistered}`, unit: kind === 'unit', testKind: kind };
    if (kind === 'unit') h.environment.unitFiles.push(unregistered);
    r.files = [unregistered];
    assert.throws(() => planTestRun(r, h.config, h.context, h.environment));
    assert.throws(() => prepare(h, r));
  });

  test(`Z424 ${branch} ${kind} present integration registration outside the workspace still refuses`, () => {
    const h = fixture(branch), r = request(kind);
    h.environment.files[otherIntegration] = { kind: 'file', realpath: '/outside/other.test.ts', unit: false, testKind: 'integration' };
    assert.throws(() => planTestRun(r, h.config, h.context, h.environment), /other-branch-integration/);
    assert.throws(() => prepare(h, r), /other-branch-integration/);
  });

  test(`Z424 ${branch} ${kind} present misclassified integration registration still refuses`, () => {
    const h = fixture(branch), r = request(kind);
    h.environment.files[otherIntegration] = { kind: 'file', realpath: `${h.context.workspace}/${otherIntegration}`, unit: true, testKind: 'unit' };
    assert.throws(() => planTestRun(r, h.config, h.context, h.environment), /other-branch-integration/);
    assert.throws(() => prepare(h, r), /other-branch-integration/);
  });
}

test('Z424 unit execution passes with absent unit and integration files registered for another branch', async () => {
  const h = fixture('hotfix');
  const result = await runTestRun(request('unit'), h.config, policy, h.context, h.ports);
  assert.equal(result.outcome, 'passed');
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(result.knownRed, []);
  assert.deepEqual(result.unexecuted, []);
  assert.deepEqual(result.unknown, []);
});

test('Z424 integration selection must still equal the configured preset', () => {
  const h = fixture('develop'), r = request('integration');
  r.files = [otherIntegration];
  assert.throws(() => planTestRun(r, h.config, h.context, h.environment), /UNSAFE_SELECTION/);
  assert.throws(() => prepare(h, r), /UNSAFE_SELECTION/);
});

test('Z424 absent other-branch entries do not permit the complete local unit suite', () => {
  const h = fixture('hotfix'), r = request('unit');
  r.files = [...files];
  assert.throws(() => planTestRun(r, h.config, h.context, h.environment), /Full unit suite/);
  assert.throws(() => prepare(h, r), /UNSAFE_SELECTION/);
});
