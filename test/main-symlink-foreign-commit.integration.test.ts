import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './hotfix-fixture.ts';
import { activateHotfix, acquireHotfixReader } from '../src/hotfix-activation.ts';
import { createProductionMainSymlinkStorage } from '../src/main-symlink-storage.ts';
import { assertMainReleaseLayout } from '../src/main-symlink-release.ts';

test('production activation publishes while other agents commit foreign Orchestrator files', async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const storage = createProductionMainSymlinkStorage(f.host);
  const g = (...args: string[]) => git(f.root, f.environment, ...args);
  const initial = await storage.inspect(); assertMainReleaseLayout(initial, storage.logicalPath);
  const candidate = await f.verified('B');
  const commits: string[] = [];
  const result = await activateHotfix(f.host, candidate, { checkpoint: async phase => {
    if (phase !== 'before-intent' && phase !== 'before-switch') return;
    const name = `foreign-${phase}.txt`;
    await fs.writeFile(join(f.root, name), phase + '\n');
    g('add', name);
    g('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'foreign ' + phase, '--', name);
    commits.push(name);
  } });
  assert.equal(result.status, 'activated');
  assert.deepEqual(commits, ['foreign-before-intent.txt', 'foreign-before-switch.txt']);
  const final = await storage.inspect(); assertMainReleaseLayout(final, storage.logicalPath);
  assert.notEqual(final.active, initial.active);
  assert.equal(final.head, candidate.commit);
  assert.equal(g('show', ':raf-main'), 'raf-main-' + final.active);
  for (const name of commits) assert.equal(g('show', ':' + name), name.slice('foreign-'.length, -'.txt'.length));
  assert.equal(await storage.readIntent(), undefined);
});

test('a configuration change before the switch refuses publication without leaving a recovery intent', async t => {
  const f = await fixture(t, true);
  await f.startMain();
  const storage = createProductionMainSymlinkStorage(f.host);
  const initial = await storage.inspect(); assertMainReleaseLayout(initial, storage.logicalPath);
  const candidate = await f.verified('B');
  await assert.rejects(activateHotfix(f.host, candidate, { checkpoint: async phase => {
    if (phase === 'before-switch') await fs.writeFile(join(f.root, 'conf', 'concurrent-writer.json'), '{}\n');
  } }), /changed/);
  assert.equal(await storage.readIntent(), undefined);
  const after = await storage.inspect(); assertMainReleaseLayout(after, storage.logicalPath);
  assert.equal(after.active, initial.active);
  assert.equal(after.head, initial.head);
  const reader = await acquireHotfixReader(f.host, 'cli');
  await reader.release();
});
