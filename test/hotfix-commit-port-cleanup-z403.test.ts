import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { prepareHotfixWorktree, startHotfixCommitPort, type HotfixHost } from '../src/hotfix-worktree.ts';
import { createRafTemporarySocketEndpoint, rafSocketRoot } from '../src/raf-temporary-socket.ts';

async function present(path: string): Promise<boolean> {
  return fs.lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'z403-')));
  const aliases = new Map<string, string>();
  const closers: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    for (const [alias, target] of aliases) {
      if (await fs.readlink(alias).catch(() => undefined) === target) await fs.unlink(alias);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const runDirectory = async () => {
    const path = join(root, 'long-run-directory-'.repeat(8), randomUUID());
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  };
  const endpoint = async () => {
    const directory = await runDirectory();
    const created = await createRafTemporarySocketEndpoint({ runId: randomUUID(), directory, basename: 'hotfix-commit.sock', serverCwd: root, clientCwd: root });
    const alias = dirname(created.bind.address);
    const target = await fs.readlink(alias);
    aliases.set(alias, target);
    closers.push(() => created.cleanup());
    return { endpoint: created, directory, alias, target };
  };
  return { root, aliases, closers, runDirectory, endpoint };
}

function reply(address: string): Promise<{ error: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    let output = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => socket.end('{}\n'));
    socket.on('data', chunk => { output += chunk; });
    socket.once('end', () => {
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

async function hotfixFixture(t: TestContext) {
  const f = await fixture(t);
  const home = join(f.root, 'home');
  const main = join(f.root, 'raf-main');
  const hotfix = join(f.root, 'raf-hotfix');
  await fs.mkdir(home);
  await fs.mkdir(main);
  await fs.mkdir(join(f.root, 'conf'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Z403', GIT_AUTHOR_EMAIL: 'z403@example.invalid', GIT_COMMITTER_NAME: 'Z403', GIT_COMMITTER_EMAIL: 'z403@example.invalid' });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '--allow-empty', '-qm', 'isolated fixture');
  git(f.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main');
  git(f.root, 'submodule', 'absorbgitdirs');
  git(main, 'worktree', 'add', '-b', 'develop', join(f.root, 'raf-develop'));
  git(main, 'worktree', 'add', '-b', 'hotfix', hotfix);
  const conf = process.env.HOTFIX_FIXTURE_CONF;
  await fs.copyFile(conf ? join(conf, 'flow.json') : new URL('../../conf/flow.json', import.meta.url), join(f.root, 'conf/flow.json'));
  await fs.writeFile(join(f.root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } } } }));
  const host: HotfixHost = { orchestratorRoot: f.root, qaHome: home, environment: env, sandboxExecutable: 'unused-unit-fixture' };
  const port = async () => {
    const directory = await f.runDirectory();
    const workspace = await prepareHotfixWorktree(host, randomUUID());
    const opened = await startHotfixCommitPort(host, workspace, directory);
    f.closers.push(() => opened.close());
    const entries = (await fs.readdir(directory)).filter(name => name.startsWith('.ipc-'));
    assert.equal(entries.length, 1, 'port has one owned socket directory');
    const target = await fs.realpath(join(directory, entries[0]));
    const matches: string[] = [];
    for (const name of await fs.readdir(rafSocketRoot())) {
      const alias = join(rafSocketRoot(), name);
      if (await fs.readlink(alias).catch(() => undefined) === target) matches.push(alias);
    }
    assert.equal(matches.length, 1, 'port has one compact alias to its own directory');
    const alias = matches[0];
    f.aliases.set(alias, target);
    const address = join(alias, 'hotfix-commit.sock');
    assert.ok(Buffer.byteLength(join(target, 'hotfix-commit.sock')) >= 108, 'canonical port path exceeds sun_path');
    assert.ok(Buffer.byteLength(address) < 104, 'compact address fits supported pathname limits');
    assert.match((await reply(address)).error, /Invalid hotfix commit request/, 'active port receives and responds before teardown');
    return { port: opened, directory, target, alias, address };
  };
  return { ...f, port };
}

for (const removed of ['nothing', 'runDirectory', '.ipc'] as const) {
  test(`[Z403 port ${removed}] active hotfix port releases only its alias after lifecycle teardown`, async t => {
    const f = await hotfixFixture(t);
    const own = await f.port();
    const peer = await f.port();
    const peerIdentity = await fs.lstat(peer.alias);
    if (removed !== 'nothing') {
      await fs.rm(removed === 'runDirectory' ? own.directory : own.target, { recursive: true });
      assert.equal(await present(own.target), false);
      assert.equal((await fs.lstat(own.alias)).isSymbolicLink(), true, 'lstat observes the owned dangling alias');
    }
    const closeError = await own.port.close().then(() => undefined, error => error);
    assert.equal(await present(own.alias), false, `lifecycle close must release owned alias even after ${removed} teardown; close error: ${closeError}`);
    assert.equal(closeError, undefined, 'finished port cleanup tolerates its already removed directory');
    assert.equal(await present(own.target), false);
    assert.equal((await fs.lstat(peer.alias)).ino, peerIdentity.ino, 'peer alias identity survives');
    assert.equal(await fs.readlink(peer.alias), peer.target, 'peer routing survives');
    assert.match((await reply(peer.address)).error, /Invalid hotfix commit request/, 'peer port still serves requests');
  });
}

for (const removed of ['runDirectory', '.ipc'] as const) {
  test(`[Z403 endpoint ${removed}] cleanup releases a dangling owned alias and remains repeatable`, async t => {
    const f = await fixture(t);
    const own = await f.endpoint();
    const peer = await f.endpoint();
    await fs.rm(removed === 'runDirectory' ? own.directory : own.target, { recursive: true });
    const cleanupError = await own.endpoint.cleanup().then(() => undefined, error => error);
    assert.equal(await present(own.alias), false, `own dangling alias must be released; cleanup error: ${cleanupError}`);
    assert.equal(cleanupError, undefined);
    await own.endpoint.cleanup();
    assert.equal(await fs.readlink(peer.alias), peer.target);
    assert.equal((await fs.lstat(peer.target)).isDirectory(), true);
  });
}

test('[Z403 ownership] missing directory does not authorize unlinking a retargeted foreign alias', async t => {
  const f = await fixture(t);
  const own = await f.endpoint();
  const peer = await f.endpoint();
  await fs.rm(own.directory, { recursive: true });
  await fs.unlink(own.alias);
  await fs.symlink(peer.target, own.alias, 'dir');
  f.aliases.set(own.alias, peer.target);
  const identity = await fs.lstat(own.alias);
  await own.endpoint.cleanup().catch(() => undefined);
  assert.equal(await fs.readlink(own.alias), peer.target, 'replacement alias retained');
  assert.equal((await fs.lstat(own.alias)).ino, identity.ino);
  assert.equal(await fs.readlink(peer.alias), peer.target);
  assert.equal((await fs.lstat(peer.target)).isDirectory(), true);
});

test('[Z403 ownership] an existing replacement directory keeps its files and routing', async t => {
  const f = await fixture(t);
  const own = await f.endpoint();
  const displaced = own.target + '.displaced';
  await fs.rename(own.target, displaced);
  await fs.mkdir(own.target, { mode: 0o700 });
  const sentinel = join(own.target, 'foreign.txt');
  await fs.writeFile(sentinel, 'foreign resource');
  const identity = await fs.lstat(own.target);
  await own.endpoint.cleanup().catch(() => undefined);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'foreign resource');
  assert.equal((await fs.lstat(own.target)).ino, identity.ino);
  assert.equal(await fs.readlink(own.alias), own.target);
});
