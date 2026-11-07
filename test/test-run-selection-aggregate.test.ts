import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTestRun } from '../src/test-runs.ts';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { alpha, beta, fixtureConfig, fixtureContext, fixtureGroup, fixtureRequest, policy, RunHarness } from './helpers/test-run-fixture.ts';

for (const selection of ['files', 'only'] as const) {
  for (const ledger of ['knownRed', 'unexecuted'] as const) {
    test(`${selection} selection retains ${ledger} in an unselected file across phase and SHA`, async () => {
      const harness = new RunHarness();
      harness.state.seed(fixtureGroup({ timeoutCount: 1, [ledger]: [beta] }));
      harness.context.agentId = 'next-agent';
      harness.context.sha = 'next-sha';
      harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
      const request = fixtureRequest({ phase: 'hotfix', files: selection === 'files' ? [alpha.file] : undefined,
        only: selection === 'only' ? [alpha] : undefined });
      const result = await runTestRun(request, harness.config, policy, harness.context, harness.ports);
      assert.deepEqual(result.removed, []);
      assert.deepEqual(result[ledger], [beta]);
      assert.deepEqual(harness.state.get()?.[ledger], [beta]);
      assert.equal(result.timeoutCount, 1);
      assert.notEqual(result.groupState, 'complete');
      assert.notEqual(result.nextAction, 'complete');
      assert.notEqual(result.outcome, 'passed');
    });
  }
}

test('complete selected-file inventory removes only its missing IDs', async () => {
  const harness = new RunHarness();
  const stale = { ...alpha, name: 'deleted behavior' };
  harness.state.seed(fixtureGroup({ knownRed: [stale, beta] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  const result = await runTestRun(fixtureRequest({ files: [alpha.file] }), harness.config, policy, harness.context, harness.ports);
  assert.deepEqual(result.removed, [stale]);
  assert.deepEqual(result.knownRed, [beta]);
  assert.notEqual(result.groupState, 'complete');
});

test('only selection retains an unconfirmed ID in the same selected file', async () => {
  const harness = new RunHarness();
  const other = { ...alpha, name: 'another behavior' };
  harness.state.seed(fixtureGroup({ knownRed: [alpha, other] }));
  harness.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  const result = await runTestRun(fixtureRequest({ files: undefined, only: [alpha] }), harness.config, policy, harness.context, harness.ports);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.knownRed, [other]);
  assert.notEqual(result.groupState, 'complete');
});

for (const selection of ['files', 'only', 'preset'] as const) {
  test(`preflight ${selection} checks dependencies only for selected profiles`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'selection-preflight-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (path: string, text = '') => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('conf/projects.json', JSON.stringify({ version: 1, projects: {
      raf: { path: 'raf-main', branchPaths: { main: 'raf-main' }, profile: 'raf' },
    }, profiles: { raf: { production: 'main', environments: { runtime: 'main' } } } }));
    write('conf/raf.json', JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
    write('raf-main/src/state-store.ts');
    write(`raf-main/${alpha.file}`);
    write(`raf-main/${beta.file}`);
    write('raf-main/selected.config');
    mkdirSync(join(root, 'qa-home'));
    const home = join(root, 'qa-home');
    const inherited = { HOME: home, RAF_QA_HOME: home, PATH: process.env.PATH };
    const state = resolveStateContext({ orchestratorRoot: root, modulePath: join(root, 'raf-main/src/state-store.ts'),
      homeDirectory: home, operatingSystemHome: join(root, 'working-home'), environment: inherited, entryPoint: 'cli' });
    const workspace = join(root, 'raf-main');
    const config = fixtureConfig();
    const selected = config.projects.raf.profiles.node;
    selected.executable = process.execPath;
    selected.unitFiles = [alpha.file];
    selected.checks = ['selected.config'];
    config.projects.raf.profiles.foreign = { ...selected, unitFiles: [beta.file], checks: ['missing-foreign.config'] };
    const group = 'add-raf-test-run/unit';
    config.projects.raf.groups[group].files = [alpha.file];
    const request = { project: 'raf', phase: 'hotfix', group,
      ...(selection === 'files' ? { files: [alpha.file] } : selection === 'only' ? { only: [`${alpha.file}::${alpha.name}`] } : {}) };
    const context = { ...fixtureContext(), cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] },
      home, statePath: state.statePath, tmpPath: state.tmpRoot, operationalHome: join(root, 'working-home') };
    write('conf/flow.json', JSON.stringify({ unitTests: policy }));
    write('conf/test-runs.json', JSON.stringify(config));
    const ports = createTestRunPorts(config, state, () => { throw new Error('preflight must not open state'); }, inherited, undefined, request);
    assert.equal((await ports.preflight(context)).dependenciesAvailable, true);
    rmSync(join(workspace, 'selected.config'));
    assert.equal((await ports.preflight(context)).dependenciesAvailable, false, 'selected dependency remains required');
  });
}
