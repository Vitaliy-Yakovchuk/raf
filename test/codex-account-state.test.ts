import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createConnection, createServer, type Server } from 'node:net';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareCodexSandbox, type CodexSandboxRequest } from '../src/codex-sandbox.ts';

const confDirectory = fileURLToPath(new URL('../../conf/', import.meta.url));
const codexProtocol = JSON.parse(readFileSync(join(confDirectory, 'raf.json'), 'utf8')).runnerProtocols.find((entry: { runner: string }) => entry.runner === 'codex');
assert.ok(codexProtocol, 'codex protocol must exist');
const transitionMs: number = codexProtocol.timeouts.transitionMs;
assert.ok(Number.isFinite(transitionMs) && transitionMs > 0);

type CommandResult = { code: number | string | null; stdout: string; stderr: string };
type ActiveSocket = { path: string; server: Server };
type Fixture = {
  root: string;
  accountHome: string;
  accountState: string;
  realState: string;
  accountTmp: string;
  realTmp: string;
  workspace: string;
  runDirectory: string;
  files: string[];
  sockets: ActiveSocket[];
  database: DatabaseSync;
  request: CodexSandboxRequest;
};

function execute(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(executable, [...args], { cwd, env: environment, timeout: transitionMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? null : 0, stdout, stderr });
    });
  });
}

async function listener(path: string): Promise<ActiveSocket> {
  const server = createServer(socket => socket.end('fixture-alive'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.removeListener('error', reject); resolve(); });
  });
  return { path, server };
}

function exchange(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let result = '';
    socket.setEncoding('utf8');
    socket.setTimeout(transitionMs, () => socket.destroy(new Error('fixture listener timed out')));
    socket.on('data', value => { result += value; });
    socket.once('error', reject);
    socket.once('end', () => resolve(result));
  });
}

async function fixture(t: TestContext, symlinkState = false, symlinkTmp = false): Promise<Fixture> {
  const scratch = await fs.realpath(process.env.RAF_TEST_SCRATCH_ROOT ?? os.userInfo().homedir);
  const root = await fs.mkdtemp(join(scratch, '.raf-y6-'));
  const sockets: ActiveSocket[] = [];
  let database: DatabaseSync | undefined;
  t.after(async () => {
    for (const { server } of sockets) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    database?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const accountHome = join(root, 'account');
  const accountState = join(accountHome, '.raf');
  const realState = symlinkState ? join(root, 'state-target') : accountState;
  const accountTmp = join(accountState, 'tmp');
  const realTmp = symlinkTmp ? join(root, 'tmp-target') : join(realState, 'tmp');
  const standHome = join(root, 'stand');
  const standState = join(standHome, '.raf');
  const standTmp = join(standState, 'tmp');
  const runDirectory = join(standTmp, 'own-run');
  const workspace = join(root, 'work');
  for (const path of [accountHome, realState, realTmp, standState, runDirectory, workspace]) await fs.mkdir(path, { recursive: true });
  if (symlinkState) await fs.symlink(realState, accountState);
  if (symlinkTmp) await fs.symlink(realTmp, join(realState, 'tmp'));
  database = new DatabaseSync(join(realState, 'state.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=73; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'y6-state\');');
  const bugs = new DatabaseSync(join(realState, 'bugs.sqlite'));
  bugs.exec('CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES (6)');
  bugs.close();
  await fs.writeFile(join(realState, 'secrets.json'), JSON.stringify({ fixture: randomUUID() }), { mode: 0o600 });
  await fs.writeFile(join(standState, 'secrets.json'), JSON.stringify({ fixture: randomUUID() }), { mode: 0o600 });
  await fs.writeFile(join(root, 'host-readable.txt'), 'host-read-control');
  await fs.mkdir(join(realTmp, 'tmux'));
  sockets.push(await listener(join(realTmp, 'tmux', 'server.sock')));
  sockets.push(await listener(join(realState, 'service.sock')));
  const files = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'secrets.json', 'bugs.sqlite'].map(name => join(accountState, name));
  const request: CodexSandboxRequest = {
    runId: randomUUID(),
    invocation: { executable: 'codex', args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'], liveTaskVerified: false },
    scope: { hidden: [standState, standTmp], readable: [runDirectory], tmuxDirectory: runDirectory, excludedCommands: [] },
    cwd: workspace,
    runDirectory,
    writableDirectories: [workspace, runDirectory],
    environment: { ...process.env, HOME: standHome, RAF_QA_HOME: standHome },
  };
  return { root, accountHome, accountState, realState, accountTmp, realTmp, workspace, runDirectory, files, sockets, database, request };
}

function passwdHome(t: TestContext, f: Fixture): void {
  const account = os.userInfo();
  const previousHome = process.env.HOME;
  process.env.HOME = f.request.environment.HOME;
  const mock = t.mock.method(os, 'userInfo', () => ({ ...account, homedir: f.accountHome }));
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  assert.notEqual(os.homedir(), os.userInfo().homedir, 'HOME and passwd home must describe different active roots');
}

async function hostControl(f: Fixture): Promise<void> {
  for (const path of f.files) {
    assert.ok((await fs.stat(path)).size > 0, `live host fixture ${path}`);
    const handle = await fs.open(path, 'r');
    try {
      const data = Buffer.alloc(1);
      assert.equal((await handle.read(data, 0, 1, 0)).bytesRead, 1, `host can read ${path}`);
    } finally { await handle.close(); }
  }
  assert.equal((await fs.stat(join(f.accountState, 'secrets.json'))).mode & 0o777, 0o600);
  for (const { path, server } of f.sockets) {
    assert.ok(server.listening, `listener remains live: ${path}`);
    assert.equal(await exchange(path), 'fixture-alive');
  }
  const sqlite = await execute('sqlite3', ['-readonly', join(f.accountState, 'state.sqlite'), 'pragma user_version'], f.workspace, process.env);
  assert.equal(sqlite.code, 0, `sqlite3 host control: ${sqlite.stderr}`);
  assert.equal(sqlite.stdout.trim(), '73');
}

const probeProgram = String.raw`
import fs from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const input = JSON.parse(process.argv[1]);
if (await fs.readFile(input.publicFile, 'utf8') !== 'host-read-control') throw new Error('public host read control failed');
const checks = [];
for (const path of input.files) {
  try { const handle = await fs.open(path, 'r'); await handle.read(Buffer.alloc(1), 0, 1, 0); await handle.close(); checks.push({ kind: 'read', path, code: 'READ_OK' }); }
  catch (error) { checks.push({ kind: 'read', path, code: error.code }); }
}
for (const path of input.sockets) {
  const code = await new Promise(resolve => {
    const socket = createConnection(path);
    socket.once('connect', () => { socket.destroy(); resolve('CONNECT_OK'); });
    socket.once('error', error => resolve(error.code));
  });
  checks.push({ kind: 'connect', path, code });
}
for (const path of input.sqlite) {
  const result = spawnSync('sqlite3', ['-readonly', path, 'pragma user_version'], { encoding: 'utf8' });
  checks.push({ kind: 'sqlite', path, code: result.status, value: result.stdout?.trim(), error: result.error?.code });
}
for (const path of input.shell) {
  const result = spawnSync('/bin/sh', ['-c', 'cat "$1" >/dev/null', 'y6-child', path], { encoding: 'utf8' });
  checks.push({ kind: 'shell', path, code: result.status, error: result.error?.code });
}
for (const path of input.childNode) {
  const result = spawnSync(process.execPath, ['-e', 'require("node:fs").readFileSync(process.argv[1])', path], { encoding: 'utf8' });
  checks.push({ kind: 'child-node', path, code: result.status, error: result.error?.code });
}
for (const directory of input.allowed) {
  await fs.writeFile(join(directory, 'own-result.json'), JSON.stringify({ status: 'succeeded' }));
  const path = join(directory, 'own.sock');
  const server = createServer(socket => socket.end('own-ipc'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const value = await new Promise((resolve, reject) => {
    const socket = createConnection(path); let value = ''; socket.setEncoding('utf8');
    socket.on('data', data => { value += data; }); socket.once('error', reject); socket.once('end', () => resolve(value));
  });
  if (value !== 'own-ipc') throw new Error('own IPC exchange failed');
  await new Promise(resolve => server.close(resolve));
  await fs.rm(path, { force: true });
}
console.log(JSON.stringify({ checks, allowed: input.allowed }));
`;

async function protectionMatrix(t: TestContext, symlinkState: boolean, symlinkTmp: boolean): Promise<void> {
  const f = await fixture(t, symlinkState, symlinkTmp);
  passwdHome(t, f);
  await hostControl(f);
  const aliases = join(f.workspace, 'aliases');
  await fs.mkdir(aliases);
  const secretFiles = f.files.filter(file => file.endsWith('/secrets.json'));
  const files = new Set(secretFiles);
  for (const file of secretFiles) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const real = join(f.realState, name);
    const alias = join(aliases, name);
    await fs.symlink(file, alias);
    files.add(alias);
    files.add(real);
    files.add(`/proc/self/root${file}`);
    files.add(`/proc/self/root${real}`);
  }
  const prepared = await prepareCodexSandbox(f.request);
  try {
    assert.equal(prepared.environment.HOME, f.request.environment.HOME);
    assert.equal(prepared.environment.TMUX_TMPDIR, f.runDirectory);
    const input = {
      publicFile: join(f.root, 'host-readable.txt'),
      files: [...files, join(dirname(f.request.runDirectory), '..', 'secrets.json')],
      sockets: [],
      sqlite: [],
      shell: [join(f.accountState, 'secrets.json'), join(aliases, 'secrets.json'), `/proc/self/root${join(f.realState, 'secrets.json')}`],
      childNode: [join(f.accountState, 'secrets.json'), join(aliases, 'secrets.json')],
      allowed: [f.workspace, f.runDirectory],
    };
    const result = await execute(prepared.toolSandbox.executable, [...prepared.toolSandbox.args, process.execPath, '--input-type=module', '-e', probeProgram, JSON.stringify(input)], f.workspace, prepared.environment);
    assert.equal(result.code, 0, `native sandbox probe must run: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output.allowed, input.allowed);
    assert.equal(output.checks.length, input.files.length + input.sockets.length + input.sqlite.length + input.shell.length + input.childNode.length);
    for (const check of output.checks) {
      if (check.kind === 'read' || check.kind === 'connect') {
        assert.ok(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(check.code), `${check.kind} must deny live account resource ${check.path}: ${check.code}`);
      } else {
        assert.equal(check.error, undefined, `required ${check.kind} executable must exist`);
        assert.equal(typeof check.code, 'number');
        assert.notEqual(check.code, 0, `${check.kind} must deny account resource ${check.path}`);
        if (check.kind === 'sqlite') assert.notEqual(check.value, '73');
      }
    }
    for (const directory of input.allowed) assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'own-result.json'), 'utf8')), { status: 'succeeded' });
  } finally {
    try { await hostControl(f); }
    finally {
      await prepared.cleanup();
      await prepared.cleanup();
    }
  }
  await hostControl(f);
}

test('Y.6: alternate HOME still hides the passwd account 0600 secret', async t => {
  await protectionMatrix(t, false, false);
});

test('Y.6: symlinked account secret is hidden through lexical paths and realpaths', async t => {
  await protectionMatrix(t, true, true);
});
