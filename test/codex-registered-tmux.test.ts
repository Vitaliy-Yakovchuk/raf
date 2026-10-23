import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import os from 'node:os';
import { join, relative, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CodexSandboxRequest, PreparedCodexSandbox } from '../src/codex-sandbox.ts';
import type { NativeSandboxScope } from '../src/runner-protocols.ts';
import type { ProcessIdentity, SessionRecord } from '../src/session-state.ts';
import type { StateStore } from '../src/state-store.ts';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';

const confRoot = fileURLToPath(new URL('../../conf/', import.meta.url));
const timeoutMs: number = JSON.parse(readFileSync(join(confRoot, 'flow.json'), 'utf8')).unitTests.timeoutMs;
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
const transitionMs: number = JSON.parse(readFileSync(join(confRoot, 'raf.json'), 'utf8')).runnerProtocols.find((p: { runner: string }) => p.runner === 'codex').timeouts.transitionMs;
assert.ok(Number.isSafeInteger(transitionMs) && transitionMs > 0);

type Result = { code: number | string | null; stdout: string; stderr: string };
type Endpoint = { recorded: string; real: string; alias: string; session: string; identity: ProcessIdentity };
type ScopeBuilder = (type: string | undefined, cwd: string, reportDirectory: string, statePath: string, tmpRoot: string) => Promise<NativeSandboxScope>;
type Prepare = (request: CodexSandboxRequest) => Promise<PreparedCodexSandbox>;
type Fixture = {
  root: string;
  home: string;
  workspace: string;
  runDirectory: string;
  tmpRoot: string;
  statePath: string;
  environment: NodeJS.ProcessEnv;
  endpoints: Endpoint[];
  paths: string[];
  store: StateStore;
  scope: ScopeBuilder;
  prepare: Prepare;
};

function execute(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise(resolve => {
    execFile(executable, [...args], { cwd, env: environment, timeout: transitionMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? null : 0, stdout, stderr });
    });
  });
}

function succeeded(result: Result, label: string): void {
  assert.equal(result.code, 0, `${label}: ${result.code}; ${result.stderr}`);
}

async function connect(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(transitionMs, () => socket.destroy(new Error('host fixture connect timeout')));
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}

async function fixture(t: TestContext, location: 'external' | 'workspace' | 'run' = 'external'): Promise<Fixture> {
  const scratch = await fs.realpath(process.env.RAF_TEST_SCRATCH_ROOT ?? os.userInfo().homedir);
  assert.ok(scratch !== '/tmp' && !scratch.startsWith('/tmp/'), 'sandbox fixture scratch must be outside globally hidden /tmp');
  const root = await fs.mkdtemp(join(scratch, '.ry7-'));
  const home = join(root, 'h');
  const orchestratorRoot = join(root, 'o');
  const workspace = join(root, 'w');
  const tmpRoot = join(home, '.raf', 'tmp');
  const runDirectory = join(tmpRoot, 'own');
  const statePath = join(home, '.raf', 'state.sqlite');
  const endpoints: Endpoint[] = [];
  const policies: PreparedCodexSandbox[] = [];
  let store: StateStore | undefined;
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, RAF_QA_HOME: home, CODEX_HOME: join(root, 'c') };
  t.after(async () => {
    const errors: unknown[] = [];
    for (const prepared of policies.reverse()) {
      try { await prepared.cleanup(); } catch (error) { errors.push(error); }
    }
    try { store?.close(); } catch (error) { errors.push(error); }
    for (const endpoint of endpoints) {
      const result = await execute('tmux', ['-S', endpoint.real, 'kill-server'], workspace, environment);
      if (result.code !== 0) errors.push(new Error(`fixture tmux cleanup failed: ${result.stderr}`));
    }
    await fs.rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Y.71 fixture cleanup failed');
  });
  for (const path of [home, workspace, runDirectory, environment.CODEX_HOME!, join(orchestratorRoot, 'conf'), join(root, 'e')]) await fs.mkdir(path, { recursive: true });
  for (const name of ['projects.json', 'raf.json', 'models.json', 'raf-constants.json']) await fs.copyFile(join(confRoot, name), join(orchestratorRoot, 'conf', name));
  const projects = JSON.parse(await fs.readFile(join(orchestratorRoot, 'conf', 'projects.json'), 'utf8'));
  const codeRoot = join(orchestratorRoot, projects.projects.raf.branchPaths.develop);
  await prepareProductionQaFixture(t, { root: orchestratorRoot, home });
  const productionModule = join(codeRoot, 'src', 'production-runtime.ts');
  await fs.appendFile(productionModule, '\nexport { runnerSandboxScope };\n');
  const production = await import(pathToFileURL(productionModule).href) as { runnerSandboxScope: ScopeBuilder };
  assert.equal(typeof production.runnerSandboxScope, 'function', 'fixture exposes the existing production scope without changing its body');
  const guard: typeof import('../src/state-migration-guard.ts') = await import(pathToFileURL(join(codeRoot, 'src', 'state-migration-guard.ts')).href);
  const storage: typeof import('../src/state-store.ts') = await import(pathToFileURL(join(codeRoot, 'src', 'state-store.ts')).href);
  const sessions: typeof import('../src/session-state.ts') = await import(pathToFileURL(join(codeRoot, 'src', 'session-state.ts')).href);
  const sandbox: typeof import('../src/codex-sandbox.ts') = await import(pathToFileURL(join(codeRoot, 'src', 'codex-sandbox.ts')).href);
  const context = guard.productionStateContext(orchestratorRoot, productionModule, home, 'worker', environment);
  assert.equal(context.mode, 'qa');
  assert.equal(context.statePath, statePath);
  assert.equal(context.tmpRoot, tmpRoot);
  store = storage.openStateStore(statePath, { context });
  const state = sessions.createSessionState({ repository: store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  const activity = { type: 'implement', project: 'raf', features: ['y71-fixture'], phase: 'test-scaffold', cwd: workspace };
  const directoryAlias = join(root, 'link');
  await fs.symlink(join(root, 'e'), directoryAlias);
  for (const [index, address] of ['main', 'peer', 'exited-peer', 'finished-peer', 'raf', 'env-decoy'].entries()) {
    const base = index === 4 ? join(tmpRoot, 'tmux') : index === 1 && location !== 'external' ? (location === 'workspace' ? workspace : runDirectory) : join(root, 'e');
    await fs.mkdir(base, { recursive: true });
    const real = join(base, index === 4 ? 'server.sock' : `${index}.sock`);
    assert.ok(Buffer.byteLength(real) < 100, 'fixture Unix socket path must fit sockaddr_un');
    const recorded = base === join(root, 'e') ? join(directoryAlias, `${index}.sock`) : real;
    const alias = join(workspace, `alias-${index}`);
    await fs.symlink(recorded, alias);
    const session = `ry7-${index}`;
    succeeded(await execute('tmux', ['-S', real, '-f', '/dev/null', 'new-session', '-d', '-s', session, 'sleep infinity'], workspace, environment), `create live ${address} tmux`);
    const pid = await execute('tmux', ['-S', real, 'display-message', '-p', '-t', session, '#{pane_pid}'], workspace, environment);
    succeeded(pid, 'fixture pane identity');
    const identity: ProcessIdentity = { pid: Number(pid.stdout.trim()), startedAt: new Date().toISOString(), runner: index === 0 ? 'main' : 'codex', runnerSessionId: address, tmuxSession: session, evidence: { tmuxSocket: recorded, tmuxPane: '%0' } };
    assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
    endpoints.push({ recorded, real, alias, session, identity });
    if (index === 0) state.registerExistingMain(randomUUID(), identity, 'fixture-authority', { ...activity, type: 'main' });
    else if (index < 4) {
      const id = randomUUID();
      state.reserveLaunch(address, id, activity, { resource: 'fixture', amount: 1 });
      assert.equal(state.commitStarted(id, identity), true);
      if (index === 2) store.sessionRepository.transaction(tx => {
        const record = tx.getSession(id)!;
        tx.putSession({ ...record, state: 'exited', revision: record.revision + 1 });
      });
      if (index === 3) store.sessionRepository.transaction(tx => {
        const record = tx.getSession(id)!;
        tx.putSession({ ...record, state: 'finished', finishedAt: new Date().toISOString(), revision: record.revision + 1 });
      });
    }
  }
  const live = state.listReconciliationCandidates();
  assert.ok(live.some(record => record.addressId === 'main'));
  for (const endpoint of endpoints.slice(0, 3)) assert.ok(live.some(record => record.process?.evidence.tmuxSocket === endpoint.recorded));
  assert.ok(!live.some(record => record.process?.evidence.tmuxSocket === endpoints[3].recorded));
  const paths = [...new Set([...endpoints.slice(0, 3), endpoints[4]].flatMap(e => [e.recorded, e.real, e.alias, `/proc/self/root${e.real}`]))];
  const prepare: Prepare = async request => {
    const prepared = await sandbox.prepareCodexSandbox(request);
    policies.push(prepared);
    return prepared;
  };
  return { root, home, workspace, runDirectory, tmpRoot, statePath, environment, endpoints, paths, store, scope: production.runnerSandboxScope, prepare };
}

async function hostControl(f: Fixture): Promise<void> {
  for (const endpoint of f.endpoints) {
    for (const path of new Set([endpoint.real, endpoint.recorded, endpoint.alias])) {
      assert.ok((await fs.stat(path)).isSocket(), `live host socket: ${path}`);
      await connect(path);
    }
    succeeded(await execute('tmux', ['-S', endpoint.real, 'has-session', '-t', endpoint.session], f.workspace, f.environment), 'fixture session survives sandbox/cleanup');
  }
  for (const path of f.paths) {
    assert.ok((await fs.stat(path)).isSocket(), `host probe target exists: ${path}`);
    await connect(path);
  }
}

async function request(f: Fixture, foreignEnvironment: boolean): Promise<CodexSandboxRequest> {
  const names = ['HOME', 'RAF_QA_HOME', 'TMUX', 'TMUX_PANE'] as const;
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const environment = { ...f.environment };
  if (foreignEnvironment) {
    environment.TMUX = `${f.endpoints[5].real},123,0`;
    environment.TMUX_PANE = '%999';
  }
  try {
    for (const name of names) {
      if (environment[name] === undefined) delete process.env[name];
      else process.env[name] = environment[name];
    }
    const scope = await f.scope('implement', f.workspace, f.runDirectory, f.statePath, f.tmpRoot);
    return {
      runId: randomUUID(), cwd: f.workspace, runDirectory: f.runDirectory,
      writableDirectories: [f.workspace, f.runDirectory], environment, timeoutMs: transitionMs,
      invocation: { executable: 'codex', args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'], liveTaskVerified: false },
      scope,
    };
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

const childProbe = String.raw`
const { createConnection } = require('node:net');
(async () => {
  const checks = [];
  for (const path of JSON.parse(process.argv[1])) {
    const code = await new Promise(resolve => {
      const socket = createConnection(path);
      socket.setTimeout(Number(process.argv[2]), () => { socket.destroy(); resolve('ETIMEDOUT'); });
      socket.once('connect', () => { socket.destroy(); resolve('CONNECT_OK'); });
      socket.once('error', error => resolve(error.code));
    });
    checks.push({ path, code });
  }
  process.stdout.write(JSON.stringify(checks));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

const probeProgram = String.raw`
import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const input = JSON.parse(process.argv[1]);
const probe = input.childProbe;
const direct = [];
for (const path of input.paths) {
  const code = await new Promise(resolve => {
    const socket = createConnection(path);
    socket.setTimeout(input.timeoutMs, () => { socket.destroy(); resolve('ETIMEDOUT'); });
    socket.once('connect', () => { socket.destroy(); resolve('CONNECT_OK'); });
    socket.once('error', error => resolve(error.code));
  });
  direct.push({ path, code });
}
const child = spawnSync('/bin/sh', ['-c', 'exec "$1" -e "$2" "$3" "$4"', 'y71-child', process.execPath, probe, JSON.stringify(input.paths), String(input.timeoutMs)], {
  encoding: 'utf8', timeout: input.timeoutMs, env: { ...process.env, TMUX: '', TMUX_PANE: '', HOME: input.runDirectory }
});
assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
const own = [];
for (const directory of [input.workspace, input.runDirectory]) {
  const path = join(directory, 'own.sock');
  const server = createServer(socket => socket.once('data', data => socket.end(data)));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const value = await new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = '';
    socket.setEncoding('utf8'); socket.on('data', part => { data += part; });
    socket.once('error', reject); socket.once('end', () => resolve(data));
    socket.once('connect', () => socket.write('own-ipc'));
  });
  assert.equal(value, 'own-ipc');
  await new Promise(resolve => server.close(resolve));
  await fs.rm(path, { force: true });
  await fs.writeFile(join(directory, 'result.json'), JSON.stringify({ status: 'succeeded' }));
  own.push(directory);
}
assert.equal(process.env.TMUX_TMPDIR, input.runDirectory);
assert.ok(!process.env.TMUX && !process.env.TMUX_PANE);
const tmux = args => spawnSync('tmux', ['-L', input.name, ...args], { encoding: 'utf8', timeout: input.timeoutMs });
try {
  const started = tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'own', 'sleep infinity']);
  assert.ifError(started.error); assert.equal(started.status, 0, started.stderr);
  const command = tmux(['run-shell', 'printf own-tmux-ok > "'+input.tmuxResult+'"']);
  assert.equal(command.status, 0, command.stderr);
  assert.equal(await fs.readFile(input.tmuxResult, 'utf8'), 'own-tmux-ok');
} finally {
  const stopped = tmux(['kill-server']); assert.equal(stopped.status, 0, stopped.stderr);
}
process.stdout.write(JSON.stringify({ direct, child: JSON.parse(child.stdout), own }));
`;

async function exercise(f: Fixture, prepared: PreparedCodexSandbox): Promise<void> {
  assert.ok(prepared.toolSandbox.args.includes('sandbox') && prepared.toolSandbox.args.includes('linux'), 'real codex tool sandbox required; no scenario-only replacement');
  assert.match([prepared.toolSandbox.executable, ...prepared.toolSandbox.args].join(' '), /codex/);
  assert.doesNotMatch(prepared.invocation.args.join(' '), /danger-full-access|dangerously-bypass|disable-sandbox/);
  assert.equal(prepared.environment.TMUX_TMPDIR, f.runDirectory);
  assert.ok(!prepared.environment.TMUX && !prepared.environment.TMUX_PANE);
  for (const path of prepared.policyPaths) {
    const delta = relative(f.runDirectory, await fs.realpath(path));
    assert.ok(delta && delta !== '..' && !delta.startsWith(`..${sep}`), 'policy belongs to own run');
  }
  const input = { childProbe, paths: f.paths, workspace: f.workspace, runDirectory: f.runDirectory, timeoutMs: transitionMs, name: `ry7-${randomUUID()}`, tmuxResult: join(f.runDirectory, 'tmux-result') };
  const result = await execute(prepared.toolSandbox.executable, [...prepared.toolSandbox.args, process.execPath, '--input-type=module', '-e', probeProgram, JSON.stringify(input)], f.workspace, prepared.environment);
  succeeded(result, 'sandbox tool must run; missing mechanism/executable is not a target red');
  const output = JSON.parse(result.stdout);
  for (const kind of ['direct', 'child']) {
    assert.deepEqual(output[kind].map((check: { path: string }) => check.path), f.paths);
    for (const check of output[kind]) assert.ok(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(check.code), `${kind}: live registered host endpoint ${check.path} must deny connect, got ${check.code}`);
  }
  assert.deepEqual(output.own, [f.workspace, f.runDirectory]);
  for (const directory of output.own) {
    assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'result.json'), 'utf8')), { status: 'succeeded' });
    await assert.rejects(fs.stat(join(directory, 'own.sock')), { code: 'ENOENT' });
  }
  await assert.rejects(fs.stat(join(f.runDirectory, `tmux-${process.getuid!()}`, input.name)), { code: 'ENOENT' });
}

for (const foreignEnvironment of [false, true]) {
  test(`Y.71: production scope reads main/running/exited registry endpoints with ${foreignEnvironment ? 'foreign' : 'empty'} TMUX`, { timeout: timeoutMs, concurrency: false }, async t => {
    const f = await fixture(t);
    await hostControl(f);
    const before = f.store.sessionRepository.transaction(tx => tx.listSessions());
    let prepared: PreparedCodexSandbox | undefined;
    try {
      const input = await request(f, foreignEnvironment);
      assert.ok(input.scope.hidden.includes('/run'));
      assert.ok(input.scope.hidden.includes(`/tmp/tmux-${process.getuid!()}`));
      assert.ok(input.scope.hidden.includes(f.tmpRoot));
      for (const endpoint of f.endpoints.slice(0, 3)) {
        assert.ok(input.scope.hidden.includes(endpoint.recorded), `production scope missing registered address ${endpoint.recorded}`);
        assert.ok(input.scope.hidden.includes(endpoint.real), `production scope missing endpoint realpath ${endpoint.real}`);
      }
      assert.ok(!input.scope.hidden.includes(f.endpoints[3].recorded), 'finished sessions do not enter registered scope');
      prepared = await f.prepare(input);
      await exercise(f, prepared);
    } finally {
      await hostControl(f);
      await prepared?.cleanup();
      await prepared?.cleanup();
      await hostControl(f);
      assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), before, 'scope/cleanup must not reconcile or mutate sessions');
    }
  });
}

for (const location of ['workspace', 'run'] as const) {
  test(`Y.71: registered endpoint inside ${location} cannot escape via writable/run exception`, { timeout: timeoutMs, concurrency: false }, async t => {
    const f = await fixture(t, location);
    await hostControl(f);
    let prepared: PreparedCodexSandbox | undefined;
    try {
      try {
        prepared = await f.prepare(await request(f, false));
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /NotImplemented|STATE_CONTEXT|MODULE_NOT_FOUND|not defined/);
        assert.match(String((error as Error & { code?: string }).code), /SANDBOX|SCOPE/);
        assert.match(error.message, /overlap|hidden|scope|endpoint|socket|isolat/i);
        return;
      }
      await exercise(f, prepared);
    } finally {
      await hostControl(f);
      await prepared?.cleanup();
      await prepared?.cleanup();
      await hostControl(f);
    }
  });
}

for (const missing of ['missing-address', 'relative-address']) {
  test(`Y.71: registered tmux process with ${missing} refuses before brief`, { timeout: timeoutMs, concurrency: false }, async t => {
    const f = await fixture(t);
    await hostControl(f);
    f.store.sessionRepository.transaction(tx => {
      const main = tx.listSessions().find(record => record.addressId === 'main')!;
      const evidence = { ...main.process!.evidence };
      if (missing === 'missing-address') delete evidence.tmuxSocket;
      else evidence.tmuxSocket = 'relative/main.sock';
      tx.putSession({ ...main, process: { ...main.process!, evidence } } satisfies SessionRecord);
    });
    const marker = join(f.workspace, 'brief-delivered');
    let prepared: PreparedCodexSandbox | undefined;
    try {
      await assert.rejects(async () => {
        const input = await request(f, false);
        prepared = await f.prepare(input);
        await fs.writeFile(marker, 'readiness/brief must not be reached');
      }, error => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /NotImplemented|STATE_CONTEXT|MODULE_NOT_FOUND|not defined/);
        assert.match(String((error as Error & { code?: string }).code), /SANDBOX|SCOPE/);
        assert.match(error.message, /tmux|socket|evidence|address|absolute/i);
        return true;
      });
      await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    } finally {
      await prepared?.cleanup();
      await prepared?.cleanup();
      await hostControl(f);
    }
  });
}
