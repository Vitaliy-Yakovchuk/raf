import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as release from '../src/main-symlink-release.ts';
import type { MainSymlinkStorage } from '../src/main-symlink-release.ts';
import { processStart } from '../src/hotfix-host.ts';
import type { HotfixHost } from '../src/hotfix-worktree.ts';

const factory = () => {
  const value = (release as Record<string, unknown>).createProductionMainSymlinkStorage;
  assert.equal(typeof value, 'function', 'MainSymlinkRelease must expose its production storage provider');
  return value as (host: HotfixHost) => MainSymlinkStorage;
};

test('Z.461 production storage implements the existing publication and recovery ports', () => {
  const storage = factory()({ orchestratorRoot: '/isolated/root', qaHome: '/isolated/home', environment: {}, sandboxExecutable: 'codex' });
  assert.equal(storage.logicalPath, '/isolated/root/raf-main');
  for (const name of ['inspect', 'withPublicationLock', 'prepareVerified', 'assertSnapshot', 'readIntent', 'writeIntent', 'probeRename', 'createTemporarySymlink', 'renameSymlink', 'removeTemporarySymlink', 'reconcileGit', 'clearIntent', 'resolvePublished', 'loadPublished'] as const) assert.equal(typeof storage[name], 'function', name);
});

test('Z.461 native rename replaces a symlink and retains both physical directories', async t => {
  const create = factory();
  const root = await fs.mkdtemp(join(tmpdir(), 'z461-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = join(root, 'raf-main-a'), b = join(root, 'raf-main-b');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(join(a, 'marker'), 'A'); await fs.writeFile(join(b, 'marker'), 'B');
  await fs.symlink(a, join(root, 'raf-main'));
  const storage = create({ orchestratorRoot: root, qaHome: join(root, 'qa'), environment: {}, sandboxExecutable: 'codex' });
  assert.deepEqual(await storage.probeRename(), { supported: true, sameDevice: true });
  const temporary = await storage.createTemporarySymlink(b);
  assert.equal(await fs.realpath(storage.logicalPath), a);
  await storage.renameSymlink(temporary, storage.logicalPath);
  await storage.removeTemporarySymlink(temporary);
  assert.equal(await fs.realpath(storage.logicalPath), b);
  assert.equal(await fs.readFile(join(a, 'marker'), 'utf8'), 'A');
  assert.equal(await fs.readFile(join(b, 'marker'), 'utf8'), 'B');
  assert.deepEqual((await fs.readdir(root)).sort(), ['raf-main', 'raf-main-a', 'raf-main-b']);
});

test('Z.461 native publication keeps the old symlink when rename fails and removes its temporary', async t => {
  const create = factory();
  const root = await fs.mkdtemp(join(tmpdir(), 'z461-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b');
  await fs.mkdir(a); await fs.mkdir(b); await fs.symlink(a, join(root, 'raf-main'));
  const storage = create({ orchestratorRoot: root, qaHome: join(root, 'qa'), environment: {}, sandboxExecutable: 'codex' });
  storage.inspect = async () => ({ slots: { a: { root: a }, b: { root: b } } } as any);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === storage.logicalPath) throw Object.assign(new Error('injected EXDEV'), { code: 'EXDEV' });
    return rename(from, to);
  });
  await assert.rejects(release.createMainSymlinkSwitch(storage).exchange(storage.logicalPath, b), { code: 'EXDEV' });
  assert.equal(await fs.realpath(storage.logicalPath), a);
  assert.deepEqual((await fs.readdir(root)).sort(), ['a', 'b', 'raf-main']);
});

test('Z.461 writer identity remains available without Linux procfs', async t => {
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (String(path).startsWith('/proc/')) throw Object.assign(new Error('procfs absent on macOS'), { code: 'ENOENT' });
    return readFile(path, ...args);
  });
  assert.match(await processStart(process.pid), /\S/);
});
