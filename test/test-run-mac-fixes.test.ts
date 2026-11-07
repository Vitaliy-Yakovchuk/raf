import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import type { ParsedTestRunArgs } from '../src/test-runs.ts';
import { RunHarness } from './helpers/test-run-fixture.ts';

function fixture(t: TestContext, request?: ParsedTestRunArgs) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raf-mac-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = new RunHarness();
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  h.context.cwd = h.context.workspace = workspace;
  h.context.projectWorkspaces = { raf: [workspace] };
  h.context.home = join(root, 'home');
  h.context.statePath = join(root, 'home/.raf/state.sqlite');
  h.context.tmpPath = join(root, 'home/.raf/tmp');
  const selected = h.config.projects.raf.profiles.node;
  selected.executable = process.execPath;
  selected.checks = [];
  selected.unitFiles = ['selected.test.ts'];
  writeFileSync(join(workspace, 'selected.test.ts'), '');
  h.config.projects.raf.groups['add-raf-test-run/unit'].files = selected.unitFiles;
  h.config.projects.raf.profiles.unselected = {
    ...selected, executable: join(root, 'missing-runner'),
    unitFiles: ['unselected.test.ts'], checks: ['missing-dependency'],
  };
  const ports = createTestRunPorts(h.config, {
    mode: 'qa', orchestratorRoot: root, codeRoot: workspace, homeDirectory: h.context.home,
    statePath: h.context.statePath, tmpRoot: h.context.tmpPath, tmuxSocketPath: join(root, 'tmux.sock'),
  }, () => { throw new Error('State must not be opened'); }, {}, {
    flow: Buffer.from('{}'), testRuns: Buffer.from('{}'), projects: Buffer.from('{}'),
  }, request);
  return { root, h, ports };
}

for (const selection of [{ files: ['selected.test.ts'] }, {}, { only: ['selected.test.ts::example'] }]) {
  test(`preflight checks only requested raf profiles (${Object.keys(selection)[0] ?? 'group'})`, async t => {
    const { h, ports } = fixture(t, { project: 'raf', phase: 'hotfix', group: 'add-raf-test-run/unit', ...selection });
    const environment = await ports.preflight(h.context);
    assert.equal(environment.runtimeAvailable, true);
    assert.equal(environment.localRunnerAvailable, true);
    assert.equal(environment.dependenciesAvailable, true);
  });
}

for (const alias of [false, true]) {
  test(`configured temporary root creates and cleans canonical private children (alias=${alias})`, async t => {
    const { root, h, ports } = fixture(t);
    const temporary = join(root, 't');
    mkdirSync(temporary, { mode: 0o700 });
    const configured = join(root, 'a');
    symlinkSync(temporary, configured);
    h.config.temporaryArtifacts = { root: alias ? configured : temporary, minimumNestedSocketPathBytes: 1 };
    let saved: unknown;
    const reservation = await ports.prepareTemporary!('mac-root', h.context, async value => { saved = value; });
    t.after(() => rmSync(reservation.temporary.path, { recursive: true, force: true }));
    assert.deepEqual(saved, reservation);
    assert.equal(reservation.temporary.path, realpathSync(reservation.temporary.path));
    assert.equal(join(reservation.temporary.path, '..'), temporary);
    assert.equal(reservation.temporary.mode & 0o777, 0o700);
    assert.deepEqual(await ports.cleanupTemporary!(reservation, true), { cleanup: 'complete', diagnostic: null });
    assert.equal(existsSync(reservation.temporary.path), false);
  });
}

test('configured temporary alias still rejects an unsafe writable target', async t => {
  const { root, h, ports } = fixture(t);
  const temporary = join(root, 'unsafe');
  mkdirSync(temporary, { mode: 0o777 });
  chmodSync(temporary, 0o777);
  const configured = join(root, 'a');
  symlinkSync(temporary, configured);
  h.config.temporaryArtifacts = { root: configured, minimumNestedSocketPathBytes: 1 };
  await assert.rejects(() => ports.prepareTemporary!('unsafe', h.context, async () => {
    assert.fail('Unsafe root must not reserve a child');
  }), { code: 'TEMPORARY_DIRECTORY_INVALID' });
});
