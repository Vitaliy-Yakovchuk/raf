import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filesBelow, outputFixture, outputTimeout } from './codex-command-output-fixture.ts';
import * as commandAccess from '../src/codex-raf-command-access.ts';

test('[codex-command-fd] darwin uses /dev/fd for an open descriptor', () => {
  assert.equal(commandAccess.codexFileDescriptorPath(13, 'darwin'), '/dev/fd/13');
});

test('[codex-command-fd] Linux keeps /proc/self/fd for an open descriptor', () => {
  assert.equal(commandAccess.codexFileDescriptorPath(44, 'linux'), '/proc/self/fd/44');
});

test('[codex-command-fd] omitted platform uses the running platform', () => {
  assert.equal(commandAccess.codexFileDescriptorPath(0), process.platform === 'darwin' ? '/dev/fd/0' : '/proc/self/fd/0');
});

test('[codex-command-fd] darwin captures and replays via real directory paths', { timeout: outputTimeout }, async t => {
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  const preload = join(f.root, 'darwin-directory-fds.mjs');
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    for (const name of ['open', 'mkdir', 'lstat', 'rename', 'rm', 'readdir']) {
      const original = fs[name];
      fs[name] = async (...args) => {
        if (args.slice(0, name === 'rename' ? 2 : 1).some(path => /^\\/dev\\/fd\\/\\d+(?:\\/|$)/u.test(String(path)))) {
          throw Object.assign(new Error('ENOTDIR: directory traversal through /dev/fd'), { code: 'ENOTDIR' });
        }
        return original(...args);
      };
    }
    syncBuiltinESMExports();
  `);
  const darwin = { ...prepared, environment: { ...prepared.environment, NODE_OPTIONS: '--import=' + preload } };
  await f.configure(Buffer.from('darwin stdout\n'), Buffer.from('darwin stderr\n'), 17);
  const baseline = await filesBelow(f.runDirectory);
  const hook = await f.hook(darwin);
  assert.equal(hook.result.code, 0, hook.result.stderr.toString());
  assert.equal(hook.result.stderr.toString(), '', 'capture must not traverse /dev/fd directories');
  assert.ok(hook.replay);
  const replay = await f.replay(darwin, hook.replay);
  assert.equal(replay.code, 17, replay.stderr.toString());
  assert.equal(replay.stdout.toString(), 'darwin stdout\n');
  assert.equal(replay.stderr.toString(), 'darwin stderr\n');
  assert.equal((await f.calls()).length, 1);
  assert.deepEqual(await filesBelow(f.runDirectory), baseline);
});
