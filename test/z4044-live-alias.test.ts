import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, connect } from 'node:net';
import { test } from 'node:test';
import { withRuntimeHostAlias } from './helpers/z4044-runtime-alias.mjs';

async function fixture(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'z40442-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'runtime');
  await fs.mkdir(directory, { mode: 0o700 });
  const endpoint = path.join(root, 'host.sock');
  const options = { directory, actor: 'a', endpoint };
  const alias = path.join(directory, 'z4044-main-alias-a.sock');
  return { root, options, alias };
}

test('[Z.404.4.2 S01] alias is created only around the post-snapshot runtime probe and removed before return', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.options.endpoint, 'confirmed host sentinel');
  await assert.rejects(fs.lstat(f.alias), { code: 'ENOENT' });
  const value = await withRuntimeHostAlias(f.options, async (alias: string) => {
    assert.equal(alias, f.alias);
    assert.equal(await fs.readlink(alias), f.options.endpoint);
    assert.equal(await fs.readFile(alias, 'utf8'), 'confirmed host sentinel');
    return { reached: true };
  });
  assert.deepEqual(value, { reached: true });
  await assert.rejects(fs.lstat(f.alias), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.options.endpoint, 'utf8'), 'confirmed host sentinel');
});

test('[Z.404.4.2 S02] concurrent a/b probes have independent aliases and cleanup', async t => {
  const f = await fixture(t);
  const b = path.join(f.options.directory, 'z4044-main-alias-b.sock');
  await withRuntimeHostAlias(f.options, async (a: string) => {
    await withRuntimeHostAlias({ ...f.options, actor: 'b' }, async (alias: string) => {
      assert.equal(alias, b);
      assert.notEqual(alias, a);
      assert.equal(await fs.readlink(a), f.options.endpoint);
      assert.equal(await fs.readlink(b), f.options.endpoint);
    });
    await assert.rejects(fs.lstat(b), { code: 'ENOENT' });
    assert.equal(await fs.readlink(a), f.options.endpoint);
  });
  await assert.rejects(fs.lstat(f.alias), { code: 'ENOENT' });
});

test('[Z.404.4.2 S03] probe failure still removes the owned alias and preserves the failure', async t => {
  const f = await fixture(t), failure = new Error('deny assertion failed');
  await assert.rejects(withRuntimeHostAlias(f.options, async () => { throw failure; }), error => error === failure);
  await assert.rejects(fs.lstat(f.alias), { code: 'ENOENT' });
});

for (const kind of ['file', 'symlink']) {
  test(`[Z.404.4.2 S04 ${kind}] cleanup rejects replacement identity and retains the replacement`, async t => {
    const f = await fixture(t), saved = f.alias + '.saved';
    await assert.rejects(withRuntimeHostAlias(f.options, async (alias: string) => {
      await fs.rename(alias, saved);
      if (kind === 'file') await fs.writeFile(alias, 'foreign');
      else await fs.symlink(f.options.endpoint, alias);
    }), /runtime alias .* identity retained/);
    assert.equal((await fs.lstat(f.alias)).isSymbolicLink(), kind === 'symlink');
    assert.equal(await fs.readlink(saved), f.options.endpoint);
  });
}

test('[Z.404.4.2 S05] replaced parent directory blocks cleanup of a foreign alias', async t => {
  const f = await fixture(t), moved = f.options.directory + '-saved';
  await assert.rejects(withRuntimeHostAlias(f.options, async () => {
    await fs.rename(f.options.directory, moved);
    await fs.mkdir(f.options.directory, { mode: 0o700 });
    await fs.symlink(f.options.endpoint, f.alias);
  }), /runtime alias parent .* identity retained/);
  assert.equal(await fs.readlink(f.alias), f.options.endpoint);
  assert.equal(await fs.readlink(path.join(moved, path.basename(f.alias))), f.options.endpoint);
});

test('[Z.404.4.2 S06] changed parent mode blocks unlink', async t => {
  const f = await fixture(t);
  await assert.rejects(withRuntimeHostAlias(f.options, async () => {
    await fs.chmod(f.options.directory, 0o750);
  }), /runtime alias parent mode identity retained/);
  assert.equal(await fs.readlink(f.alias), f.options.endpoint);
});

for (const kind of ['file', 'symlink']) {
  test(`[Z.404.4.2 S07 ${kind}] existing alias refuses creation without overwriting or removing it`, async t => {
    const f = await fixture(t);
    if (kind === 'file') await fs.writeFile(f.alias, 'foreign');
    else await fs.symlink(f.options.endpoint, f.alias);
    let reached = false;
    await assert.rejects(withRuntimeHostAlias(f.options, async () => { reached = true; }), { code: 'EEXIST' });
    assert.equal(reached, false);
    if (kind === 'file') assert.equal(await fs.readFile(f.alias, 'utf8'), 'foreign');
    else assert.equal(await fs.readlink(f.alias), f.options.endpoint);
  });
}

test('[Z.404.4.2 S08] symlink parent is refused without touching its target', async t => {
  const f = await fixture(t), indirect = path.join(f.root, 'indirect');
  await fs.symlink(f.options.directory, indirect);
  await assert.rejects(withRuntimeHostAlias({ ...f.options, directory: indirect }, async () => assert.fail('probe reached')), /parent is a directory/);
  await assert.rejects(fs.lstat(f.alias), { code: 'ENOENT' });
});

test('[Z.404.4.2 S09] shared writable parent is refused before alias creation', async t => {
  const f = await fixture(t);
  await fs.chmod(f.options.directory, 0o777);
  await assert.rejects(withRuntimeHostAlias(f.options, async () => assert.fail('probe reached')), /not writable by other users/);
  await assert.rejects(fs.lstat(f.alias), { code: 'ENOENT' });
});

for (const override of [{ actor: 'c' }, { directory: 'relative' }, { endpoint: 'relative' }]) {
  test(`[Z.404.4.2 S10 ${JSON.stringify(override)}] invalid runtime selection is refused`, async t => {
    const f = await fixture(t);
    await assert.rejects(withRuntimeHostAlias({ ...f.options, ...override }, async () => assert.fail('probe reached')));
    await assert.rejects(fs.lstat(f.alias), { code: 'ENOENT' });
  });
}

test('[Z.404.4.2 S11] runtime alias transports a real Unix endpoint outside a sandbox', async t => {
  const root = await fs.mkdtemp('/tmp/z40442-socket-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const endpoint = path.join(root, 'host.sock'), server = createServer(socket => socket.end('host sentinel'));
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    await withRuntimeHostAlias({ directory: root, actor: 'a', endpoint }, async (alias: string) => {
      assert.ok(Buffer.byteLength(alias) <= 107, 'positive control must fit sun_path');
      const payload = await new Promise<string>((resolve, reject) => {
        let value = '';
        const socket = connect(alias);
        socket.setTimeout(5000, () => socket.destroy(new Error('unit sentinel deadline')));
        socket.on('error', reject);
        socket.on('data', bytes => value += bytes);
        socket.on('end', () => resolve(value));
      });
      assert.equal(payload, 'host sentinel');
    });
    assert.ok((await fs.lstat(endpoint)).isSocket());
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('[Z.404.4.2 S12] stand snapshots regular helpers while worker owns the short actor alias lifetime', async () => {
  const read = (name: string) => fs.readFile(new URL(`./helpers/${name}`, import.meta.url), 'utf8');
  const stand = await read('z4044-live-stand.mjs'), worker = await read('z4044-live-worker.mjs'), boundaries = await read('z4044-live-boundaries.mjs');
  assert.doesNotMatch(stand, /symlinkSync|symlink\(/, 'versioned stand preparation never creates the host alias');
  assert.match(stand, /copyFileSync\([^\n]*z4044-runtime-alias\.mjs/);
  assert.ok(stand.indexOf('await hostControls()') < stand.indexOf("request('launch-a'"), 'host endpoint is confirmed before worker launch');
  assert.match(worker, /withRuntimeHostAlias\([\s\S]*alias => checkBoundaries\(own, actor, path\.relative\(cwd, alias\)\)/);
  const ready = worker.indexOf("atomic(path.join(own, 'probe.json'), probe)");
  assert.ok(ready > worker.indexOf('await withRuntimeHostAlias'), 'cleanup completes before ready marker or commit');
  assert.match(stand, /assert\.equal\(git\(hotfix, 'status', '--porcelain'\), ''/);
  assert.match(boundaries, /assert\.equal\(runtimeAlias, `qa\/z4044-main-alias-\$\{actor\}\.sock`/);
  assert.match(boundaries, /Buffer\.byteLength\(runtimeAlias\) <= 107/);
  assert.match(boundaries, /\[\.\.\.config\.endpoints, runtimeAlias\]/);
  for (const retained of ['config.denyReads', 'config.ports', 'result.ipc.push', 'result.tmux.push', 'observeOwnTmuxShutdown']) assert.ok(boundaries.includes(retained), `${retained} remains in the combined boundary probe`);
});
