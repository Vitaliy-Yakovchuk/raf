import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAtomicHotfixSwitch } from '../src/hotfix-activation.ts';
import { alive, processStart } from '../src/hotfix-host.ts';
import { nativeMainLayoutPublicationProvider } from '../src/main-layout-publication.ts';

const darwinOnly = { skip: process.platform !== 'darwin' };

test('Darwin process identity recognizes a live process and rejects mismatched or exited identities', darwinOnly, async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout!, 'data');
    assert.ok(child.pid);
    const start = await processStart(child.pid);
    assert.notEqual(start, '');
    assert.equal(await processStart(child.pid), start);
    assert.equal(await alive(child.pid, start), true);
    assert.equal(await alive(child.pid, `${start}:different-process`), false);
    child.kill('SIGTERM');
    await exited;
    assert.equal(await alive(child.pid, start), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

test('Darwin same-volume atomic exchange probes and swaps a directory with a symlink without losing either target', darwinOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-mac-exchange-'));
  try {
    const left = join(root, 'left');
    const right = join(root, 'right');
    const target = join(root, 'target');
    await mkdir(left);
    await mkdir(target);
    await writeFile(join(left, 'payload'), Buffer.from([0, 1, 255, 10]));
    await writeFile(join(target, 'payload'), 'symlink target bytes');
    await symlink('target', right);
    const provider = createAtomicHotfixSwitch();

    assert.deepEqual(await provider.probe(left, right), { supported: true, sameDevice: true });
    assert.equal((await lstat(left)).isDirectory(), true);
    assert.equal(await readlink(right), 'target');
    assert.deepEqual(await readFile(join(left, 'payload')), Buffer.from([0, 1, 255, 10]));

    await provider.exchange(left, right);
    assert.equal((await lstat(left)).isSymbolicLink(), true);
    assert.equal(await readlink(left), 'target');
    assert.equal(await realpath(left), await realpath(target));
    assert.equal((await lstat(right)).isDirectory(), true);
    assert.deepEqual(await readFile(join(right, 'payload')), Buffer.from([0, 1, 255, 10]));
    assert.equal(await readFile(join(left, 'payload'), 'utf8'), 'symlink target bytes');

    await provider.exchange(left, right);
    assert.equal((await lstat(left)).isDirectory(), true);
    assert.deepEqual(await readFile(join(left, 'payload')), Buffer.from([0, 1, 255, 10]));
    assert.equal(await readlink(right), 'target');
    assert.equal(await readFile(join(target, 'payload'), 'utf8'), 'symlink target bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Darwin main layout publication preserves directory identity and relative path semantics', darwinOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-mac-publication-'));
  try {
    const logicalPath = join(root, 'raf-main');
    const activePath = join(root, 'raf-main-a');
    const intentPath = join(root, 'publication-intent.json');
    const externalPath = join(root, 'external-payload');
    const payload = Buffer.from([255, 0, 13, 10, 42]);
    await mkdir(logicalPath);
    await mkdir(join(logicalPath, 'nested'));
    await writeFile(join(logicalPath, 'nested', 'payload'), payload);
    await writeFile(externalPath, 'existing external bytes');
    await symlink('nested/payload', join(logicalPath, 'internal-link'));
    await symlink('../external-payload', join(logicalPath, 'external-link'));
    const original = await lstat(logicalPath);
    const provider = nativeMainLayoutPublicationProvider();

    await provider.assertSupported(root);
    await provider.publish({ root, logicalPath, activePath, intentPath });

    assert.equal((await lstat(logicalPath)).isSymbolicLink(), true);
    assert.equal(await readlink(logicalPath), 'raf-main-a');
    assert.equal(await realpath(logicalPath), await realpath(activePath));
    const active = await lstat(activePath);
    assert.equal(active.isDirectory(), true);
    assert.equal(active.dev, original.dev);
    assert.equal(active.ino, original.ino);
    assert.deepEqual(await readFile(join(activePath, 'nested', 'payload')), payload);
    assert.deepEqual(await readFile(join(logicalPath, 'internal-link')), payload);
    assert.equal(await readlink(join(activePath, 'internal-link')), 'nested/payload');
    assert.equal(await readlink(join(activePath, 'external-link')), '../external-payload');
    assert.equal(await readFile(join(logicalPath, 'external-link'), 'utf8'), 'existing external bytes');
    assert.equal(await readFile(externalPath, 'utf8'), 'existing external bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Darwin main layout publication rejects an occupied target while preserving both directories', darwinOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-mac-occupied-'));
  try {
    const logicalPath = join(root, 'raf-main');
    const activePath = join(root, 'raf-main-a');
    const intentPath = join(root, 'publication-intent.json');
    await mkdir(logicalPath);
    await mkdir(activePath);
    await writeFile(join(logicalPath, 'payload'), 'original main bytes');
    await writeFile(join(activePath, 'payload'), 'foreign occupied bytes');
    const provider = nativeMainLayoutPublicationProvider();

    await assert.rejects(provider.publish({ root, logicalPath, activePath, intentPath }));

    assert.equal((await lstat(logicalPath)).isDirectory(), true);
    assert.equal((await lstat(activePath)).isDirectory(), true);
    assert.equal(await readFile(join(logicalPath, 'payload'), 'utf8'), 'original main bytes');
    assert.equal(await readFile(join(activePath, 'payload'), 'utf8'), 'foreign occupied bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
