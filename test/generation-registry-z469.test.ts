import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireHotfixReader, retainHotfixGeneration } from '../src/hotfix-activation.ts';
import { hash, inventory, mainRoute } from '../src/hotfix-host.ts';
import { createHotfixRuntimeInventory } from '../src/hotfix-runtime-inventory.ts';
import type { HotfixHost } from '../src/hotfix-worktree.ts';

const execute = promisify(execFile);
const conf = process.env.HOTFIX_FIXTURE_CONF ?? join(dirname(fileURLToPath(import.meta.url)), '../../conf');
const flow = JSON.parse(await fs.readFile(join(conf, 'flow.json'), 'utf8'));
const protocols = JSON.parse(await fs.readFile(join(conf, 'raf.json'), 'utf8')).runnerProtocols;
const options = { timeout: flow.unitTests.timeoutMs };

test('[Z469] service admission publishes the previous generation in the same registry write', options, async (t: TestContext) => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/z469-'));
  const qaHome = join(root, 'home');
  const develop = join(root, 'raf-develop');
  const main = join(root, 'raf-main');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  for (const path of [qaHome, develop, join(root, 'conf')]) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: qaHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') };
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete environment[key];
  await fs.writeFile(environment.GIT_CONFIG_GLOBAL!, '');
  const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args], { env: environment })).stdout.trim();
  const identity = ['-c', 'user.name=Z469 fixture', '-c', 'user.email=z469@example.invalid', '-c', 'commit.gpgsign=false'];
  await git(develop, 'init', '-b', 'develop');
  await git(develop, ...identity, 'commit', '--allow-empty', '-m', 'develop');
  await git(develop, 'worktree', 'add', '-b', 'main', main);
  for (const path of ['bin/raf.ts', 'bin/service.ts', 'src/production-entry.ts', 'src/production-runtime.ts', 'src/state-store.ts']) {
    await fs.mkdir(dirname(join(main, path)), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(main, path), '', { mode: 0o644 });
  }
  await git(main, ...identity, 'add', '--', 'bin', 'src');
  await git(main, ...identity, 'commit', '-m', 'fixture');
  await fs.writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop' } } } }));
  await fs.writeFile(join(root, 'conf/raf.json'), JSON.stringify({ runnerProtocols: protocols }));
  await fs.writeFile(join(root, 'conf/flow.json'), JSON.stringify({ unitTests: flow.unitTests }));
  const host: HotfixHost = { orchestratorRoot: root, qaHome, environment: {}, sandboxExecutable: 'unused-z469-unit-fixture' };
  const route = await mainRoute(host);
  const oldRoot = join(route.control, 'generations/previous-z469/raf-main');
  await fs.mkdir(join(oldRoot, 'src'), { recursive: true, mode: 0o700 });
  const marker = join(oldRoot, 'src/entry.mjs');
  await fs.writeFile(marker, 'export const generation = "previous";\n', { mode: 0o600 });
  assert.equal(await fs.realpath(oldRoot), oldRoot);
  const commit = await git(main, 'rev-parse', 'HEAD');
  const files = await inventory(oldRoot);
  const previousGeneration = {
    root: oldRoot,
    commit,
    fingerprint: hash(JSON.stringify(files)),
    files,
    runtimeInventory: createHotfixRuntimeInventory(oldRoot, commit, { scopes: ['src'], rootFiles: [], excludedTrees: [], entrypoints: ['src/entry.mjs'] }),
  };
  const previousState = {
    current: oldRoot,
    generations: { [oldRoot]: previousGeneration },
    prepared: ['keep-newest'],
    garbage: [{ path: join(route.control, 'generations/garbage-z469'), root: join(route.control, 'generations/garbage-z469/raf-main'), kind: 'generation' as const }],
  };
  const staleState = { current: 'stale-generation', generations: { 'stale-generation': { root: 'stale-generation' } }, prepared: ['stale-only'] };
  await fs.mkdir(route.control, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(route.control, 'registry.pre-20261026T184408.json'), JSON.stringify(staleState));
  await fs.writeFile(join(route.control, 'registry.pre-20261026T184531.json'), JSON.stringify(previousState));
  const expected = JSON.parse(JSON.stringify(previousState));
  const registryPath = join(route.control, 'registry.json');
  const stop = { done: false };
  const capture = async (samples: unknown[]) => {
    try { samples.push(JSON.parse(await fs.readFile(registryPath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  const samples: unknown[] = [];
  const polling = (async () => {
    while (!stop.done) {
      await capture(samples);
      await delay(5);
    }
    await capture(samples);
  })();
  let admission: { ok: true } | { ok: false; error: unknown };
  try {
    const lease = await acquireHotfixReader(host, 'service');
    admission = { ok: true };
    await lease.release();
  } catch (error) {
    admission = { ok: false, error };
  }
  stop.done = true;
  await polling;
  assert.ok(samples.length > 0, `service admission must publish registry.json (${admission.ok ? 'admitted' : admission.error instanceof Error ? admission.error.message : String(admission.error)})`);
  for (const state of samples as Array<{ current: string; generations: Record<string, unknown> }>) {
    assert.notEqual(state.current, oldRoot, 'published registry must name the newly activated generation');
    const generations = { ...state.generations };
    delete generations[state.current];
    assert.deepEqual({ ...state, current: oldRoot, generations }, expected, 'previously registered generation must remain in every published registry.json');
  }
  const retained = await retainHotfixGeneration(host, oldRoot);
  assert.ok(retained, 'previously registered generation must stay retainable');
  await retained.release();
});
