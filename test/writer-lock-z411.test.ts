import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBackgroundRuntime } from '../src/background-runtime.ts';

async function fixture(t: TestContext, mode: 'timeout' | 'stop' | 'exit' | 'foreign') {
  const root = await mkdtemp(join(tmpdir(), 'raf-z411-writer-'));
  const main = join(root, 'main');
  const stateDirectory = join(root, 'state');
  await mkdir(main); await mkdir(stateDirectory);
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: main, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Z411'); git('config', 'user.email', 'z411@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  await writeFile(join(main, 'owned.txt'), 'before\n'); git('add', '--', 'owned.txt'); git('commit', '-qm', 'baseline');
  const index = join(main, '.git', 'index');
  await copyFile(index, join(root, 'old-index'));
  await writeFile(join(main, 'owned.txt'), 'after\n'); git('add', '--', 'owned.txt'); git('commit', '-qm', 'executor');
  const head = git('rev-parse', 'HEAD');
  await copyFile(join(root, 'old-index'), index);
  const indexBytes = await readFile(index);
  const lock = index + '.lock';
  const entry = join(main, 'host.ts');
  await writeFile(entry, `
import { runServiceHost } from ${JSON.stringify(new URL('../src/background-runtime.ts', import.meta.url).href)};
import { reconcileReportedCommitIndex } from ${JSON.stringify(new URL('../src/report-commit-index.ts', import.meta.url).href)};
import { rename, writeFile } from 'node:fs/promises';
const gate = Promise.withResolvers();
let job;
const acquire = () => job = reconcileReportedCommitIndex({repositoryRoot:${JSON.stringify(main)},commits:[${JSON.stringify(head)}]}, {deadline:performance.now()+60000,pollMs:5,beforeWrite:async()=>{
  if (${JSON.stringify(mode)} === 'foreign') { await rename(${JSON.stringify(lock)}, ${JSON.stringify(lock + '.owned')}); await writeFile(${JSON.stringify(lock)}, 'foreign writer'); }
  process.send?.('held');
  if (${JSON.stringify(mode)} === 'exit') process.exit(19);
  await gate.promise;
}}).catch(error => { process.send?.({error:error.message}); });
const host = await runServiceHost({stateDirectory:${JSON.stringify(stateDirectory)},socketPath:${JSON.stringify(join(root, 'service.sock'))},handlers:{
  recover: async()=>{if (${JSON.stringify(mode)} !== 'stop') await acquire();},
  handle: async()=>{void acquire();return 'started';},
  shutdown: async()=>{gate.resolve();await job;},
}});
await host.closed;
process.disconnect?.();
`);
  let child: ChildProcess | undefined;
  const held = Promise.withResolvers<void>();
  const options = { stateDirectory, socketPath: join(root, 'service.sock'), entryRelativePath: 'host.ts', readinessTimeoutMs: 800 };
  const runtime = createBackgroundRuntime(options, { resolveMainPath: async () => main, spawn: ((cmd, args, settings) => {
    child = spawn(cmd, args, { ...settings, env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.on('message', message => { if (message === 'held') held.resolve(); });
    return child;
  }) as typeof spawn });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, runtime, held, lock, index, indexBytes, child: () => child! };
}

for (const [id, mode] of [['S03', 'timeout'], ['S04', 'stop'], ['S05', 'exit']] as const) {
  test(`Z411.${id} ${mode} releases the service owned Git writer lock`, async t => {
    const f = await fixture(t, mode);
    const startup = f.runtime.start();
    if (mode === 'stop') { assert.equal((await startup).exitCode, 0); await f.runtime.request({ operation: 'acquire', payload: {} }); }
    await f.held.promise;
    if (mode === 'stop') assert.equal((await f.runtime.stop()).exitCode, 0);
    else assert.equal((await startup).exitCode, 1);
    await assert.rejects(stat(f.lock), { code: 'ENOENT' }, 'Owned index.lock must be gone before the operation returns');
    if (mode !== 'stop') assert.deepEqual(await readFile(f.index), f.indexBytes, 'Interrupted writer must not publish an unfinished index');
  });
}

test('Z411.S06 timeout preserves a replacement foreign writer lock', async t => {
  const f = await fixture(t, 'foreign');
  const startup = f.runtime.start();
  await f.held.promise;
  assert.equal((await startup).exitCode, 1);
  assert.equal(await readFile(f.lock, 'utf8'), 'foreign writer');
  assert.deepEqual(await readFile(f.index), f.indexBytes);
});
