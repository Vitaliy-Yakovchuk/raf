import assert from 'node:assert/strict';
import test from 'node:test';
import { planTestRun, runTestRun } from '../src/test-runs.ts';
import { prepareTestRunProfile } from '../src/test-run-integration-profiles.ts';
import { RunHarness, files, policy } from './helpers/test-run-fixture.ts';

const group = 'fix-preview-sso/resource-contracts';
const integrationFiles = ['worker/test/resource-contracts.test.ts', 'worker/test/resource-extra.test.ts'];

function fixture() {
  const h = new RunHarness();
  h.context.integrationTests = { timeoutMs: 211 };
  h.config.projects.raf.profiles['vitest-worker-integration'] = {
    testKind: 'integration', cwd: 'worker', executable: 'node',
    argv: ['../node_modules/vitest/vitest.mjs', 'run', '--project', 'worker-integration'],
    integrationFiles, exactIds: 'vitest-test-name', resultAdapter: 'vitest-events',
    environment: { isolatedHome: true, stateOrigin: true }, checks: [],
  };
  h.config.projects.raf.groups[group] = { profileId: 'vitest-worker-integration', files: integrationFiles };
  for (const file of integrationFiles) h.environment.files[file] = {
    kind: 'file', realpath: `${h.context.workspace}/${file}`, unit: false, testKind: 'integration',
  };
  return h;
}

for (const phase of [undefined, 'red', 'implement', 'hotfix', 'qa', 'integration']) {
  for (const selection of ['preset', 'files', 'subset'] as const) {
    test(`Z459 ${phase ?? 'omitted'} phase selects integration by profile (${selection})`, async () => {
      const h = fixture();
      const selected = selection === 'subset' ? integrationFiles.slice(0, 1) : integrationFiles;
      const request = { project: 'raf', phase, group, ...(selection === 'preset' ? {} : { files: selected }) };
      h.events = selected.flatMap(file => [{ kind: 'passed' as const, test: { file, name: 'resource contract' } }]);
      h.events.push({ kind: 'complete', expected: selected.map(file => ({ file, name: 'resource contract' })) });
      const result = await runTestRun(request, h.config, policy, h.context, h.ports);
      assert.equal(result.outcome, 'passed', JSON.stringify(result.diagnostics));
      assert.equal(result.testKind, 'integration');
      assert.equal(result.profileId, 'vitest-worker-integration');
      assert.deepEqual(result.timeoutPolicy, { source: 'conf/flow.json#/integrationTests/timeoutMs', timeoutMs: 211 });
      assert.deepEqual(result.selection.files, selected);
      assert.deepEqual(result.command?.argv, ['../node_modules/vitest/vitest.mjs', 'run', ...selected.map(file => file.slice(7)), '--project', 'worker-integration']);
      assert.equal(result.command?.cwd, `${h.context.workspace}/worker`);
      assert.equal(result.cleanup.complete, true);
      assert.equal(result.timedOut, false);
      assert.equal(result.groupState, 'complete');
      assert.deepEqual(result.knownRed, []);
      assert.deepEqual(result.unexecuted, []);
      assert.deepEqual(result.unknown, []);
      assert.equal(h.spawns.length, 1);
    });
  }
}

for (const phase of ['red', 'implement', 'hotfix', 'integration']) {
  test(`Z459 profile preparation ignores ${phase} label for integration and unit`, () => {
    const h = fixture();
    const inventory = Object.entries(h.environment.files).map(([file, fact]) => ({
      file, exists: true, canonicalInsideWorkspace: true, kind: fact.unit ? 'unit' as const : 'integration' as const,
    }));
    const flow = { unitTests: policy, integrationTests: h.context.integrationTests };
    const request = { project: 'raf', workspace: h.context.workspace, branch: 'hotfix', phase, group };
    const integration = prepareTestRunProfile(h.config as any, flow, request, inventory);
    assert.equal(integration.testKind, 'integration');
    const unit = prepareTestRunProfile(h.config as any, flow, { ...request, group: 'add-raf-test-run/unit' }, inventory);
    assert.equal(unit.testKind, 'unit');
    const unitPlan = planTestRun({ project: 'raf', phase, group: 'add-raf-test-run/unit' }, h.config, h.context, h.environment);
    assert.equal(unitPlan.testKind, 'unit');
    assert.deepEqual(unitPlan.selection.files, files.slice(0, 2));
  });
}

for (const phase of ['red', 'integration']) {
  test(`Z459 ${phase} keeps integration selection guards`, () => {
    const h = fixture();
    const request = { project: 'raf', phase, group };
    for (const overrides of [
      { only: [{ file: integrationFiles[0], name: 'resource contract' }] },
      { files: [integrationFiles[0], files[0]] },
      { files: ['../outside.test.ts'] },
      { files: ['worker/test/*.test.ts'] },
      { group: 'fix-preview-sso/unknown', files: integrationFiles },
    ]) {
      assert.throws(() => planTestRun({ ...request, ...overrides }, h.config, h.context, h.environment));
    }
  });
}
