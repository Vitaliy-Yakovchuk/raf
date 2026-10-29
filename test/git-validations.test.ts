import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveProductionStore } from '../src/main-production-store.ts';
import { validateWorkspace, validateReleaseWorkspace, hotfixRoute } from '../src/hotfix-host.ts';
import { captureReportedCommitLaunchContext } from '../src/reported-commits.ts';
import { runGitFreeCommand } from '../src/git.ts';

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-git-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['conf', 'main/.git', 'develop/.git', 'hotfix/.git']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'main', branchPaths: { main: 'main', develop: 'develop', hotfix: 'hotfix' } } } }));
  await writeFile(join(root, 'conf/flow.json'), JSON.stringify({ unitTests: { timeoutMs: 1200000 } }));
  return root;
}

test('production route accepts the actual main store without Git identity validation', async t => {
  const root = await fixture(t);
  const result = await runGitFreeCommand('route', () => resolveProductionStore(root, join(root, 'main')));
  assert.equal(result.production, join(root, 'main/.git'));
  assert.equal(result.split, true);
});

test('hotfix and release validation do not require repository identity or base ancestry', async t => {
  const root = await fixture(t);
  const host = { orchestratorRoot: root, qaHome: join(root, 'qa'), environment: {}, sandboxExecutable: '' };
  const workspace = { runId: 'sample', orchestratorRoot: root, project: 'raf' as const, targetBranch: 'main' as const, cwd: join(root, 'hotfix'), ownershipPath: join(root, '.raf-hotfix/runs/sample/ownership.json'), baseCommit: 'old-head', repositoryIdentity: 'old-store', gitDirectory: join(root, 'hotfix/.git'), commonDirectory: 'old-common' };
  await validateWorkspace(host, workspace);
  await validateReleaseWorkspace(host, { ...workspace, cwd: join(root, 'develop') }, 'develop');
});

test('launch context does not inspect or capture HEAD', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'main/.git/HEAD'), 'a'.repeat(40));
  const context = await captureReportedCommitLaunchContext('run', '/report', [join(root, 'main')], []);
  assert.equal(context.repositories[0].launchHead, '');
});

test('main snapshot inspection does not run Git or validate store registration', async t => {
  const root = await fixture(t);
  await rm(join(root, 'main'), { recursive: true });
  for (const slot of ['a', 'b']) await mkdir(join(root, 'main-' + slot, '.git'), { recursive: true });
  await symlink('main-a', join(root, 'main'));
  await writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'develop', hotfix: 'hotfix' }, mainCopies: ['main-a', 'main-b'] } } }));
  const { createProductionMainSymlinkStorage } = await import('../src/main-symlink-storage.ts');
  const storage = createProductionMainSymlinkStorage({ orchestratorRoot: root, qaHome: join(root, 'qa'), environment: {}, sandboxExecutable: '' });
  // The production class uses the conventional logical name.
  await symlink('main-a', join(root, 'raf-main'));
  const state = await runGitFreeCommand('inspect', () => storage.inspect());
  assert.equal(state.active, 'a');
  assert.equal(state.slots.b.root, join(root, 'main-b'));
});

test('main layout validation ignores Git refs, gitlinks and repository identity', async () => {
  const { assertMainReleaseLayout } = await import('../src/main-symlink-release.ts');
  assert.doesNotThrow(() => assertMainReleaseLayout({
    active: 'a', slots: { a: { root: '/root/main-a', commit: 'a', fingerprint: 'a' }, b: { root: '/root/main-b', commit: 'b', fingerprint: 'b' } },
    mainRef: 'old', head: 'old', indexTree: 'old', gitlink: { path: 'old', commit: 'old', repository: '' }, gitmodules: { path: 'old', repository: 'other' }, foreignIndexFingerprint: '', activationComplete: true, handoverComplete: true, readers: { a: [], b: [] },
  }, '/root/raf-main'));
});

test('workspace description does not require main HEAD or Git metadata validation', async t => {
  const root = await fixture(t);
  const host = { orchestratorRoot: root, qaHome: join(root, 'qa'), environment: {}, sandboxExecutable: '' };
  const { describeHotfixWorktree } = await import('../src/hotfix-worktree.ts');
  assert.equal((await describeHotfixWorktree(host, 'no-head')).baseCommit, '');
  await rm(join(root, 'hotfix/.git'), { recursive: true });
  assert.equal((await hotfixRoute(host)).cwd, join(root, 'hotfix'));
  await rm(join(root, 'main/.git'), { recursive: true });
  await rm(join(root, 'develop/.git'), { recursive: true });
  assert.equal((await resolveProductionStore(root, join(root, 'main'))).production, join(root, 'main/.git'));
});

test('snapshot validation binds file content without validating Git HEAD', async t => {
  const root = await fixture(t);
  const host = { orchestratorRoot: root, qaHome: join(root, 'qa'), environment: {}, sandboxExecutable: '' };
  const { describeHotfixWorktree } = await import('../src/hotfix-worktree.ts');
  const { sealHotfixSnapshot } = await import('../src/hotfix-activation.ts');
  await writeFile(join(root, 'main/.git/HEAD'), 'a'.repeat(40));
  const workspace = await describeHotfixWorktree(host, 'snapshot');
  await writeFile(join(root, 'hotfix/.git/HEAD'), 'b'.repeat(40));
  const before = await sealHotfixSnapshot(host, workspace);
  await writeFile(join(root, 'hotfix/.git/HEAD'), 'c'.repeat(40));
  const after = await sealHotfixSnapshot(host, workspace);
  assert.equal(after.fingerprint, before.fingerprint);
});
