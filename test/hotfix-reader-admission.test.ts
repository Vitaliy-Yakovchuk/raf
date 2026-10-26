import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHotfixRuntimeInventory } from '../src/hotfix-runtime-inventory.ts';
import { acquireHotfixReader, type HotfixReaderKind, type HotfixReaderLease } from '../src/hotfix-activation.ts';
import { locked, mainRoute, processStart } from '../src/hotfix-host.ts';
import type { HotfixHost } from '../src/hotfix-worktree.ts';

const execute = promisify(execFile);
const conf = process.env.HOTFIX_FIXTURE_CONF ?? join(dirname(fileURLToPath(import.meta.url)), '../../conf');
const flow = JSON.parse(await fs.readFile(join(conf, 'flow.json'), 'utf8'));
const protocols = JSON.parse(await fs.readFile(join(conf, 'raf.json'), 'utf8')).runnerProtocols;
const transitionMs = Math.min(...Object.values(protocols).map((p: any) => p.timeouts.transitionMs));
assert.ok(Number.isSafeInteger(transitionMs) && transitionMs > 0, 'configured transition budget is required');
const options = { timeout: flow.unitTests.timeoutMs };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function outcome<T>(operation: Promise<T>) {
  return operation.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as Error }));
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/z384-'));
  const qaHome = join(root, 'home');
  const main = join(root, 'raf-main');
  const finishes: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  t.after(async () => {
    for (const finish of finishes) finish();
    await Promise.allSettled(pending);
    t.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const path of [qaHome, main, join(root, 'conf')]) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: qaHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') };
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete environment[key];
  await fs.writeFile(environment.GIT_CONFIG_GLOBAL!, '');
  const git = async (...args: string[]) => (await execute('git', ['-C', main, ...args], { env: environment })).stdout.trim();
  await git('init', '-b', 'main');
  await git('-c', 'user.name=Z384 fixture', '-c', 'user.email=z384@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  await fs.writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-main' } } } }));
  await fs.writeFile(join(root, 'conf/raf.json'), JSON.stringify({ runnerProtocols: protocols }));
  await fs.writeFile(join(root, 'conf/flow.json'), JSON.stringify({ unitTests: flow.unitTests }));
  const host: HotfixHost = { orchestratorRoot: root, qaHome, environment: {}, sandboxExecutable: 'unused-z384-unit-fixture' };
  const route = await mainRoute(host);
  const generationRoot = join(route.control, 'generations/z384/raf-main');
  await fs.mkdir(join(generationRoot, 'src'), { recursive: true });
  const contents = 'export const generation = "z384";\n';
  const marker = join(generationRoot, 'src/entry.mjs');
  await fs.writeFile(marker, contents, { mode: 0o600 });
  const files = [{ path: 'src/entry.mjs', sha256: createHash('sha256').update(contents).digest('hex'), mode: (await fs.stat(marker)).mode & 0o777 }];
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const commit = await git('rev-parse', 'HEAD');
  const runtimeInventory = createHotfixRuntimeInventory(generationRoot, commit, { scopes: ['src'], rootFiles: [], excludedTrees: [], entrypoints: ['src/entry.mjs'] });
  const state = { current: generationRoot, generations: { [generationRoot]: { root: generationRoot, commit, fingerprint, files, runtimeInventory } } };
  const registry = JSON.stringify(state);
  await fs.writeFile(join(route.control, 'registry.json'), registry);
  const lock = join(route.control, 'activation.lock');
  const leasePaths = async () => (await fs.readdir(join(route.control, 'readers')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).sort();
  const track = <T>(operation: Promise<T>) => { pending.push(operation); return operation; };
  const acquire = (kind: HotfixReaderKind = 'cli') => track(outcome(acquireHotfixReader(host, kind)));
  const hold = async () => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    finishes.push(() => finish.resolve());
    const running = track(locked(host, async () => { entered.resolve(); await finish.promise; }));
    await Promise.race([entered.promise, running.then(() => { throw new Error('fixture lock holder exited before readiness'); })]);
    const owner = await fs.readFile(join(lock, 'owner.json'), 'utf8');
    return { owner, release: async () => { finish.resolve(); await running; } };
  };
  const contention = (count = 1) => {
    const observed = deferred<void>();
    const original = fs.rename.bind(fs);
    let attempts = 0;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      try { return await original(...args); }
      catch (error) {
        if (String(args[1]) === lock && ['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          if (++attempts >= count) observed.resolve();
        }
        throw error;
      }
    });
    return observed.promise;
  };
  const intent = async () => {
    const value = { version: 1, phase: 'intent', base: commit, target: 'f'.repeat(commit.length), previous: generationRoot, next: join(route.control, 'generations/next/raf-main'), prepared: join(route.control, 'prepared/next'), oldTree: fingerprint, newTree: 'f'.repeat(64) };
    const bytes = JSON.stringify(value);
    await fs.writeFile(join(route.control, 'intent.json'), bytes);
    return bytes;
  };
  const unchanged = async () => {
    assert.equal(await fs.readFile(join(route.control, 'registry.json'), 'utf8'), registry);
    assert.equal(await fs.readFile(marker, 'utf8'), contents);
    assert.equal(await git('rev-parse', 'HEAD'), commit);
    assert.equal(await git('status', '--porcelain'), '');
  };
  return { host, route, lock, generationRoot, commit, fingerprint, acquire, leasePaths, hold, contention, intent, unchanged, track };
}

async function admitted(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['acquire']>>): Promise<HotfixReaderLease> {
  assert.equal(result.ok, true, result.ok ? '' : `short reader-registration lock must be retried: ${result.error.message}`);
  if (!result.ok) throw result.error;
  return result.value;
}

for (const kind of ['cli', 'service', 'worker', 'hook', 'notice'] as const) {
  test(`[Z384.S01.${kind}] reader waits for a short registration lock and retains the same generation`, options, async t => {
    const f = await fixture(t);
    const held = await f.hold();
    const collided = f.contention();
    const result = f.acquire(kind);
    await collided;
    assert.deepEqual(await f.leasePaths(), [], 'no lease is written while another registration owns the lock');
    assert.equal(await fs.readFile(join(f.lock, 'owner.json'), 'utf8'), held.owner);
    await held.release();
    const lease = await admitted(await result);
    assert.equal(lease.generationRoot, f.generationRoot);
    assert.equal(lease.commit, f.commit);
    assert.equal(lease.fingerprint, f.fingerprint);
    const path = join(f.route.control, 'readers', lease.id + '.json');
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { root: f.generationRoot, pid: process.pid, start: await processStart(process.pid) });
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    await lease.release();
    await lease.release();
    assert.deepEqual(await f.leasePaths(), []);
    await f.unchanged();
  });
}

test('[Z384.S02] parallel command readers all survive registration contention with independent leases', options, async t => {
  const f = await fixture(t);
  const held = await f.hold();
  const kinds: HotfixReaderKind[] = ['cli', 'service', 'worker', 'hook', 'notice'];
  const collided = f.contention(kinds.length);
  const waiting = kinds.map(kind => f.acquire(kind));
  await collided;
  assert.deepEqual(await f.leasePaths(), []);
  await held.release();
  const leases = await Promise.all((await Promise.all(waiting)).map(admitted));
  assert.equal(new Set(leases.map(lease => lease.id)).size, kinds.length);
  assert.ok(leases.every(lease => lease.generationRoot === f.generationRoot && lease.commit === f.commit));
  assert.equal((await f.leasePaths()).length, kinds.length);
  await leases[0].release();
  assert.equal((await f.leasePaths()).length, kinds.length - 1);
  for (const lease of leases.slice(1)) await lease.release();
  assert.deepEqual(await f.leasePaths(), []);
  await f.unchanged();
});

test('[Z464.S01] twenty parallel command startups wait beyond transitionMs and retain independent reader leases', options, async t => {
  const f = await fixture(t);
  const held = await f.hold();
  const collided = f.contention(20);
  const waiting = Array.from({ length: 20 }, () => f.acquire('cli'));
  await collided;
  const now = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => now() + transitionMs * 2);
  await delay(50);
  assert.equal(await fs.readFile(join(f.lock, 'owner.json'), 'utf8'), held.owner, 'waiting must not steal a live lock');
  assert.deepEqual(await f.leasePaths(), []);
  await held.release();
  const results = await Promise.all(waiting);
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.error.message), [], 'all twenty startups must survive registration contention beyond the runner transition budget');
  const leases = await Promise.all(results.map(admitted));
  assert.equal(new Set(leases.map(lease => lease.id)).size, 20);
  assert.equal((await f.leasePaths()).length, 20);
  assert.ok(leases.every(lease => lease.generationRoot === f.generationRoot && lease.commit === f.commit && lease.fingerprint === f.fingerprint));
  for (const lease of leases) await lease.release();
  assert.deepEqual(await f.leasePaths(), []);
  await f.unchanged();
});

test('[Z384.S04] a live activation intent refuses readers without admitting them or changing writer state', options, async t => {
  const f = await fixture(t);
  const held = await f.hold();
  const intent = await f.intent();
  const result = await f.acquire();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /activat.*(?:busy|progress|pending|intent|exclusive)/iu);
    assert.doesNotMatch(result.error.message, /lock.*(?:timeout|timed out|deadline)/iu);
  }
  assert.equal(await fs.readFile(join(f.lock, 'owner.json'), 'utf8'), held.owner);
  assert.equal(await fs.readFile(join(f.route.control, 'intent.json'), 'utf8'), intent);
  assert.deepEqual(await f.leasePaths(), []);
  await f.unchanged();
  await held.release();
});

test('[Z384.S05] an activation intent appearing during contention is recognized before admission', options, async t => {
  const f = await fixture(t);
  const held = await f.hold();
  const collided = f.contention();
  const waiting = f.acquire();
  await collided;
  const intent = await f.intent();
  const result = await waiting;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /activat.*(?:busy|progress|pending|intent|exclusive)/iu);
    assert.doesNotMatch(result.error.message, /lock.*(?:timeout|timed out|deadline)/iu);
  }
  assert.equal(await fs.readFile(join(f.lock, 'owner.json'), 'utf8'), held.owner);
  assert.equal(await fs.readFile(join(f.route.control, 'intent.json'), 'utf8'), intent);
  assert.deepEqual(await f.leasePaths(), []);
  await f.unchanged();
  await held.release();
});

test('[Z384.S06] a failed lock callback releases its own lock and preserves the original failure', options, async t => {
  const f = await fixture(t);
  const failure = new Error('z384 callback failure');
  await assert.rejects(locked(f.host, async () => { throw failure; }, true), error => error === failure);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  const lease = await admitted(await f.acquire());
  await lease.release();
  assert.deepEqual(await f.leasePaths(), []);
  await f.unchanged();
});
