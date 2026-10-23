import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { failureText, git, productionPreparation, timeout, z12Fixture } from './z12-fixture.ts';

test('[workspace-routing] Z.12 root main without branchPaths is verified and never creates a synthetic tree', { timeout }, async t => {
  const f = await z12Fixture(t);
  const before = await f.unchanged();
  assert.deepEqual(await f.route(), { ok: true, project: 'orchestrator', branch: 'main', cwd: f.root });
  assert.ok(f.reads.includes(f.root), 'root filesystem and Git must be checked');
  assert.deepEqual(await f.unchanged(), before);
  assert.ok(!(await readdir(f.root)).includes('orchestrator-main'));
});

test('[workspace-routing] Z.12 root develop is UNKNOWN_BRANCH without fallback or I/O', { timeout }, async t => {
  const f = await z12Fixture(t);
  const result = await f.route('orchestrator', 'develop');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'UNKNOWN_BRANCH');
    for (const pattern of [/orchestrator/, /develop/, /main/, /projects\.json/]) assert.match(result.error.message, pattern);
  }
  assert.deepEqual(f.reads, []);
});

for (const invalid of ['missing-root', 'non-git-root', 'other-branch', 'detached-head', 'parent-git-root']) {
  test(`[workspace-routing] Z.12 ${invalid}: fail before runner/tmux and preserve files and HEAD`, { timeout }, async t => {
    const f = await z12Fixture(t);
    let selectedRoot = f.root;
    if (invalid === 'missing-root') selectedRoot = join(f.base, 'missing');
    if (invalid === 'non-git-root') await rename(join(f.root, '.git'), join(f.base, 'saved-git'));
    if (invalid === 'other-branch') git(f.root, 'checkout', '-q', '-b', 'other');
    if (invalid === 'detached-head') git(f.root, 'checkout', '-q', '--detach');
    if (invalid === 'parent-git-root') { selectedRoot = join(f.root, 'nested'); await mkdir(selectedRoot); }
    const before = { sentinel: await readFile(join(f.root, 'sentinel.txt'), 'utf8'), conf: await readFile(join(f.confRoot, 'projects.json'), 'utf8'), head: invalid === 'non-git-root' ? null : git(f.root, 'rev-parse', 'HEAD'), symbolic: invalid === 'non-git-root' ? null : git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD') };
    const code = ['other-branch', 'detached-head'].includes(invalid) ? 'BRANCH_MISMATCH' : 'WORKSPACE_UNAVAILABLE';
    const h = await productionPreparation(t, f);
    const result = await h.services.route({ root: selectedRoot, project: 'orchestrator', branch: 'main' });
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.error.code, code);
    if (selectedRoot === f.root) {
      await assert.rejects(h.run(), error => new RegExp(code).test(failureText(error)));
      assert.deepEqual(h.prepared, []);
      assert.deepEqual(h.reserved, []);
    }
    assert.ok(h.calls.every(call => call.startsWith('git ')));
    assert.equal(await readFile(join(f.root, 'sentinel.txt'), 'utf8'), before.sentinel);
    assert.equal(await readFile(join(f.confRoot, 'projects.json'), 'utf8'), before.conf);
    if (before.head !== null) { assert.equal(git(f.root, 'rev-parse', 'HEAD'), before.head); assert.equal(git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD'), before.symbolic); }
    assert.ok(!(await readdir(f.root)).includes('orchestrator-main'));
  });
}

for (const project of ['app', 'raf']) {
  test(`[workspace-routing] Z.12 ${project}: path='.' cannot borrow the Orchestrator root exception`, { timeout }, async t => {
    const f = await z12Fixture(t);
    f.projects.projects[project] = { path: '.', profile: 'orchestrator' };
    const result = await f.route(project, 'main');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'UNKNOWN_BRANCH');
    assert.deepEqual(f.reads, []);
  });
}

test('[workspace-routing] Z.12 root exception requires the registered path dot', { timeout }, async t => {
  const f = await z12Fixture(t);
  f.projects.projects.orchestrator.path = 'orchestrator-main';
  const result = await f.route();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'UNKNOWN_BRANCH');
  assert.deepEqual(f.reads, []);
});

for (const defect of ['wrong-link', 'wrong-library-branch', 'missing-library', 'missing-mapping']) {
  test(`[workspace-routing] Z.12 product ${defect}: shared-libs stays on the selected profile branch`, { timeout }, async t => {
    const f = await z12Fixture(t);
    const branch = (await f.derive('spec', 'app')).branch;
    assert.equal(branch, 'integration');
    if (defect === 'wrong-link') { await rm(join(f.root, 'app-integration/shared-libs')); await symlink('../shared-libs-main', join(f.root, 'app-integration/shared-libs')); }
    if (defect === 'wrong-library-branch') git(join(f.root, 'shared-libs-integration'), 'checkout', '-q', '-b', 'wrong');
    if (defect === 'missing-library') await rename(join(f.root, 'shared-libs-integration'), join(f.base, 'saved-library'));
    if (defect === 'missing-mapping') delete f.projects.projects['shared-libs'].branchPaths!.integration;
    const result = await f.route('app', branch);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, defect === 'wrong-link' ? 'SHARED_LIBS_LINK_INVALID' : defect === 'wrong-library-branch' ? 'SHARED_LIBS_BRANCH_MISMATCH' : 'SHARED_LIBS_UNAVAILABLE');
    assert.ok(!f.reads.includes(join(f.root, 'app-main')));
    assert.ok(!f.reads.includes(join(f.root, 'shared-libs-main')));
  });
}
