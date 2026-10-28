import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { acquireHotfixReader, sealHotfixSnapshot } from '../src/hotfix-activation.ts';
import { mainRoute } from '../src/hotfix-host.ts';
import { ProductionMainSymlinkStorage } from '../src/main-symlink-storage.ts';

test('reader uses the registered main directory without copying code or publishing a generation registry', async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/no-generations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = join(root, 'raf-main');
  const develop = join(root, 'raf-develop');
  await fs.mkdir(develop);
  await fs.mkdir(join(root, 'conf'));
  execFileSync('git', ['init', '-b', 'develop', develop]);
  execFileSync('git', ['-C', develop, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base']);
  execFileSync('git', ['-C', develop, 'worktree', 'add', '-b', 'main', main]);
  for (const path of ['bin/raf.ts', 'bin/service.ts', 'src/production-entry.ts', 'src/production-runtime.ts', 'src/state-store.ts']) {
    await fs.mkdir(dirname(join(main, path)), { recursive: true });
    await fs.writeFile(join(main, path), '');
  }
  execFileSync('git', ['-C', main, 'add', 'bin', 'src']);
  execFileSync('git', ['-C', main, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  await fs.writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } } } }));
  await fs.writeFile(join(root, 'conf/raf.json'), '{}');
  await fs.writeFile(join(root, 'conf/flow.json'), JSON.stringify({ unitTests: { timeoutMs: 60000 } }));
  const host = { orchestratorRoot: root, qaHome: join(root, 'home'), environment: {}, sandboxExecutable: 'unused' };
  const route = await mainRoute(host);
  const reader = await acquireHotfixReader(host, 'cli');
  t.after(() => reader.release());
  assert.equal(reader.generationRoot, main);
  assert.equal(reader.commit, execFileSync('git', ['-C', main, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal((await fs.readdir(route.control)).includes('generations'), false);
  assert.equal((await fs.readdir(route.control)).includes('registry.json'), false);
  await reader.release();
});

test('publication records only the fixed main slots and intent without retained generation copies', async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/no-generations-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { a: join(root, 'raf-main-a'), b: join(root, 'raf-main-b') };
  await fs.mkdir(join(root, 'conf'));
  for (const path of Object.values(roots)) {
    await fs.mkdir(path);
    for (const name of ['bin/raf.ts', 'bin/service.ts', 'src/production-entry.ts', 'src/production-runtime.ts', 'src/state-store.ts']) {
      await fs.mkdir(dirname(join(path, name)), { recursive: true });
      await fs.writeFile(join(path, name), '');
    }
  }
  const control = join(root, 'control');
  const context = { control, roots, published: join(control, 'main-symlink-published.json'), intent: join(control, 'main-symlink-intent.json') };
  const storage = new ProductionMainSymlinkStorage({ orchestratorRoot: root, qaHome: join(root, 'home'), environment: {}, sandboxExecutable: 'unused' });
  t.mock.method(storage as any, 'context', async () => context);
  const previous = { active: 'a', slots: { a: { root: roots.a, commit: 'a'.repeat(40), fingerprint: 'old' }, b: { root: roots.b, commit: 'b'.repeat(40), fingerprint: 'new' } } };
  const candidate = { workspace: { cwd: roots.b }, snapshot: { root: roots.b, configurationRoot: root }, commit: 'b'.repeat(40) };
  await storage.writeIntent({ id: 'fixture', previous, candidate, destination: 'b' } as any);
  assert.deepEqual((await fs.readdir(control)).sort(), ['main-symlink-intent.json', 'main-symlink-published.json']);
  const published = JSON.parse(await fs.readFile(context.published, 'utf8'));
  assert.equal(published.a.root, roots.a);
  assert.equal(published.b.root, roots.b);
  assert.equal('generationRoot' in published.a, false);
  assert.equal('generationRoot' in published.b, false);
});

test('verification snapshot describes the hotfix branch in place without a sealed tree copy', async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/no-sealed-copy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const develop = join(root, 'raf-develop'), main = join(root, 'raf-main'), hotfix = join(root, 'raf-hotfix');
  await fs.mkdir(develop); await fs.mkdir(join(root, 'conf'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(develop, 'init', '-b', 'develop');
  git(develop, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base');
  git(develop, 'worktree', 'add', '-b', 'main', main);
  git(develop, 'worktree', 'add', '-b', 'hotfix', hotfix);
  await fs.writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } } } }));
  await fs.writeFile(join(root, 'conf/raf.json'), '{}');
  await fs.writeFile(join(root, 'conf/flow.json'), JSON.stringify({ unitTests: { timeoutMs: 60000 } }));
  await fs.writeFile(join(hotfix, 'marker'), 'candidate');
  const host = { orchestratorRoot: root, qaHome: join(root, 'qa'), environment: {}, sandboxExecutable: 'unused' };
  const workspace = { project: 'raf', targetBranch: 'main', orchestratorRoot: root, cwd: hotfix, repositoryIdentity: join(develop, '.git'), gitDirectory: git(hotfix, 'rev-parse', '--absolute-git-dir'), commonDirectory: join(develop, '.git'), runId: 'fixture', baseCommit: git(main, 'rev-parse', 'HEAD'), ownershipPath: join(root, '.raf-hotfix/runs/fixture/ownership.json') };
  const snapshot = await sealHotfixSnapshot(host, workspace as any);
  assert.equal(snapshot.root, hotfix);
  assert.equal(snapshot.configurationRoot, root);
  assert.deepEqual(snapshot.files.map(file => file.path), ['marker']);
  assert.equal((await fs.readdir((await mainRoute(host)).control).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).includes('snapshots'), false);
});
