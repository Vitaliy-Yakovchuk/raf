import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, childMessage } from './hotfix-fixture.ts';
import { ensureMainLayoutForStart } from '../src/main-layout.ts';
import { activateHotfix, recoverHotfixActivation, acquireHotfixReader, cleanupHotfixActivation } from '../src/hotfix-activation.ts';
import { createProductionMainSymlinkStorage } from '../src/main-symlink-storage.ts';
import { assertMainReleaseLayout } from '../src/main-symlink-release.ts';
import { inventory, json, mainRoute } from '../src/hotfix-host.ts';

async function interrupted(operation: Promise<unknown>, marker: string) {
  try { await operation; }
  catch (error) {
    if (!String(error).includes(marker)) throw new Error('Unexpected publication failure: ' + String(error), { cause: error });
    return;
  }
  assert.fail('Publication passed without the requested interruption');
}

test('Z.461 production activation and recovery preserve physical Git and immutable readers through both slots', async t => {
  const f = await fixture(t);
  const projects = await json(join(f.root, 'conf/projects.json'));
  projects.projects.raf.mainCopies = ['raf-main-a', 'raf-main-b'];
  await fs.writeFile(join(f.root, 'conf/projects.json'), JSON.stringify(projects));
  await ensureMainLayoutForStart({ root: f.root, projects: projects.projects });
  await f.startMain();
  const storage = createProductionMainSymlinkStorage(f.host);
  const g = (...args: string[]) => git(f.root, f.environment, ...args);
  await fs.writeFile(join(f.root, 'foreign.txt'), 'staged foreign bytes\n'); g('add', 'foreign.txt');
  await fs.writeFile(join(f.root, 'foreign.txt'), 'unstaged foreign bytes\n');
  const foreign = () => g('ls-files', '--stage').split('\n').filter(row => !/\t(?:raf-main(?:-[ab])?|\.gitmodules)$/.test(row));
  const foreignBefore = foreign();
  const reader = await acquireHotfixReader(f.host, 'cli');
  t.after(() => reader.release());
  const readerFiles = await inventory(reader.generationRoot);
  const first = await f.verified('B');
  const initial = await storage.inspect(); assertMainReleaseLayout(initial, storage.logicalPath);
  await interrupted(activateHotfix(f.host, first, { checkpoint: async phase => {
    if (phase === 'after-intent') throw new Error('interrupted-before-switch');
  } }), 'interrupted-before-switch');
  assert.deepEqual((await cleanupHotfixActivation(f.host)).removed, []);
  assert.equal((await recoverHotfixActivation(f.host)).status, 'recovered');
  assert.equal((await recoverHotfixActivation(f.host)).status, 'idle');
  assert.equal((await storage.inspect()).active, initial.active);
  const child = f.forkModule(`
    const {promises: fs} = await import('node:fs');
    const rename = fs.rename.bind(fs);
    fs.rename = async (from, to) => {
      if (to === hotfixFixturePayload.host.orchestratorRoot + '/.gitmodules') {
        process.send({checkpoint:'metadata-index-locked'});
        await new Promise(() => {});
      }
      return rename(from, to);
    };
    const {activateHotfix} = await import(${JSON.stringify(new URL('../src/hotfix-activation.ts', import.meta.url).href)});
    await activateHotfix(hotfixFixturePayload.host, hotfixFixturePayload.candidate);
  `, { host: f.host, candidate: first });
  await childMessage(child, value => value.checkpoint === 'metadata-index-locked', f.budget);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  child.kill('SIGKILL');
  assert.deepEqual(await exited, {code:null, signal:'SIGKILL'});
  assert.equal((await recoverHotfixActivation(f.host)).status, 'recovered');
  const after = await storage.inspect(); assertMainReleaseLayout(after, storage.logicalPath);
  assert.notEqual(after.active, initial.active); assert.equal(after.head, first.commit);
  assert.equal((await activateHotfix(f.host, first)).status, 'already-active');
  assert.deepEqual(await inventory(reader.generationRoot), readerFiles);
  const second = await f.verified('A');
  await assert.rejects(activateHotfix(f.host, second), /busy/);
  assert.deepEqual(await inventory(reader.generationRoot), readerFiles);
  await reader.release();
  const indexLock = join(g('rev-parse', '--absolute-git-dir'), 'index.lock');
  await fs.writeFile(indexLock, 'foreign lock');
  try { await assert.rejects(activateHotfix(f.host, second), /Git operation pending/); }
  finally { assert.equal(await fs.readFile(indexLock, 'utf8'), 'foreign lock'); await fs.unlink(indexLock); }
  const result = await activateHotfix(f.host, second);
  assert.equal(result.status, 'activated');
  const final = await storage.inspect(); assertMainReleaseLayout(final, storage.logicalPath);
  assert.equal(final.active, initial.active); assert.equal(final.head, second.commit);
  assert.equal(g('show', ':raf-main'), 'raf-main-' + final.active);
  await assert.rejects(fs.access(join((await mainRoute(f.host)).control, 'registry.json')), { code: 'ENOENT' });
  assert.deepEqual(foreign(), foreignBefore);
  assert.equal(await fs.readFile(join(f.root, 'foreign.txt'), 'utf8'), 'unstaged foreign bytes\n');
  assert.equal(await storage.readIntent(), undefined);
});
