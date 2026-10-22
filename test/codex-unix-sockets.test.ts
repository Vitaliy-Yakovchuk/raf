import assert from 'node:assert/strict';
import { spawn, type StdioOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareCodexSandbox, type CodexSandboxRequest, type PreparedCodexSandbox } from '../src/codex-sandbox.ts';
import { buildRunnerInvocation, nativeSandboxArgs, nativeWriteScopeArgs, type Invocation, type ProtocolSettings } from '../src/runner-protocols.ts';

const confRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../conf');
const flow = JSON.parse(await readFile(join(confRoot, 'flow.json'), 'utf8'));
const timeoutMs = flow.unitTests.timeoutMs;
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'conf/flow.json#/unitTests/timeoutMs must be a positive integer');
const protocols = JSON.parse(await readFile(join(confRoot, 'raf.json'), 'utf8')).runnerProtocols;
const settings: ProtocolSettings = protocols.find((value: ProtocolSettings) => value.runner === 'codex');
assert.ok(settings, 'codex protocol must be configured');
const models = JSON.parse(await readFile(join(confRoot, 'models.json'), 'utf8')).models;
const model = models.find((value: { runner: string; enabled: boolean }) => value.runner === 'codex' && value.enabled);
assert.ok(model, 'codex needs an enabled catalog model');
const selected = { model: model.id, effort: model.effort };

type Result = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type Probe = { id: string; kind: 'file' | 'sqlite' | 'socket' | 'tcp'; path: string; port?: number };
type Observation = { id: string; ok: boolean; error: string | null };
type Disposer = () => void | Promise<void>;
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function run(invocation: Invocation, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, stdio: StdioOptions = ['ignore', 'pipe', 'pipe']): Promise<Result> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(invocation.executable, [...invocation.args, ...args], { cwd, env, stdio, timeout: timeoutMs, killSignal: 'SIGKILL' });
    let stdout = '', stderr = '';
    child.stdout?.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr?.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

function success(result: Result, label: string): void {
  assert.equal(result.signal, null, `${label}: unexpected signal ${result.signal}`);
  assert.equal(result.code, 0, `${label}: exit ${result.code}; ${result.stderr}`);
}

async function endpoint(disposers: Disposer[], path: string | null): Promise<{ server: Server; port?: number }> {
  const connections = new Set<ReturnType<typeof createConnection>>();
  const server = createServer(socket => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
    socket.write('fixture-alive');
  });
  server.on('error', () => {});
  disposers.push(async () => {
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
  });
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    server.listen(path);
  } else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { server, port: typeof address === 'object' && address !== null ? address.port : undefined };
}

async function hostConnect(probe: Probe): Promise<void> {
  await new Promise<void>((done, reject) => {
    const socket = probe.kind === 'tcp' ? createConnection({ host: probe.path, port: probe.port! }) : createConnection(probe.path);
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); done(); });
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp('/tmp/ry2-');
  const disposers: Disposer[] = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed');
  });
  const runId = randomUUID();
  const cwd = join(root, 'work');
  const hostHome = join(root, 'host');
  const standHome = join(root, 'stand');
  const tmpRoot = join(root, 'tmp');
  const runDirectory = join(tmpRoot, runId);
  const otherRun = join(tmpRoot, 'other-run');
  const gitDirectory = join(root, 'git-meta');
  const reportDirectory = join(root, 'reports');
  const changeDirectory = join(root, 'change');
  const outside = join(root, 'outside');
  const sockets = [
    join(root, `tmux-${process.getuid!()}`, 'default'),
    join(tmpRoot, 'tmux', 'server.sock'),
    join(root, 'run', 'user', String(process.getuid!()), 'bus'),
    join(root, 'unusual', 'ssh-agent.sock'),
    join(root, 'cc-socks', 'host.sock'),
    join(otherRun, 'node.sock'),
  ];
  for (const directory of [cwd, hostHome, standHome, runDirectory, otherRun, gitDirectory, reportDirectory, changeDirectory, outside]) {
    await mkdir(directory, { recursive: true });
  }
  const databases: DatabaseSync[] = [];
  disposers.push(() => { for (const database of databases) database.close(); });
  const files: Probe[] = [];
  for (const [index, home] of [hostHome, standHome].entries()) {
    const stateDirectory = join(home, '.raf');
    await mkdir(stateDirectory);
    const statePath = join(stateDirectory, 'state.sqlite');
    const database = new DatabaseSync(statePath);
    databases.push(database);
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE isolation_fixture(value TEXT); INSERT INTO isolation_fixture VALUES (\'fixture\');');
    for (const suffix of ['', '-wal', '-shm']) files.push({ id: `state-${index}${suffix}`, kind: 'file', path: statePath + suffix });
    const secret = join(stateDirectory, 'secrets.json');
    await writeFile(secret, JSON.stringify({ fixture: randomUUID() }), { mode: 0o600 });
    await chmod(secret, 0o600);
    assert.equal((await stat(secret)).mode & 0o777, 0o600);
    assert.equal((await stat(secret)).uid, process.getuid!());
    files.push({ id: `secret-${index}`, kind: 'file', path: secret });
    files.push({ id: `sqlite-${index}`, kind: 'sqlite', path: statePath });
  }
  const controls: Probe[] = sockets.map((path, index) => ({ id: `socket-${index}`, kind: 'socket', path }));
  const listeners: Server[] = [];
  for (const socket of sockets) listeners.push((await endpoint(disposers, socket)).server);
  const tcp = await endpoint(disposers, null);
  listeners.push(tcp.server);
  controls.push({ id: 'alternate-host-endpoint', kind: 'tcp', path: '127.0.0.1', port: tcp.port });
  const siblingFile = join(otherRun, 'brief.json');
  await writeFile(siblingFile, '{"fixture":true}');
  files.push({ id: 'sibling-run', kind: 'file', path: siblingFile });
  const hidden = [hostHome, standHome, tmpRoot, dirname(sockets[0]), join(root, 'run'), join(root, 'cc-socks'), dirname(sockets[3]), '/run', `/tmp/tmux-${process.getuid!()}`, '/tmp/cc-socks'];
  const writableDirectories = [cwd, runDirectory, gitDirectory, reportDirectory, changeDirectory];
  const base = buildRunnerInvocation(settings, selected);
  const invocation = { ...base, args: [...base.args, ...nativeWriteScopeArgs(settings, writableDirectories, [cwd])] };
  const environment = { ...process.env, HOME: hostHome, TMUX: `${sockets[0]},123,0`, TMUX_PANE: '%999', SSH_AUTH_SOCK: sockets[3], DBUS_SESSION_BUS_ADDRESS: `unix:path=${sockets[2]}`, XDG_RUNTIME_DIR: dirname(sockets[2]) };
  const request: CodexSandboxRequest = {
    runId, invocation, cwd, runDirectory, writableDirectories, environment, timeoutMs,
    scope: { hidden, readable: [runDirectory], tmuxDirectory: runDirectory, excludedCommands: [] },
  };
  const probes = [...files, ...controls];
  await hostControls(probes, listeners, cwd);
  return { root, cwd, runId, hostHome, standHome, tmpRoot, runDirectory, otherRun, gitDirectory, reportDirectory, changeDirectory, outside, request, probes, listeners, disposers };
}

async function hostControls(probes: readonly Probe[], listeners: readonly Server[], cwd: string): Promise<void> {
  for (const listener of listeners) assert.equal(listener.listening, true, 'fixture listener must stay alive');
  for (const probe of probes) {
    if (probe.kind === 'socket' || probe.kind === 'tcp') await hostConnect(probe);
    else {
      assert.ok((await readFile(probe.path)).length > 0, `host must read existing fixture ${probe.id}`);
      if (probe.kind === 'sqlite') {
        const result = await run({ executable: 'sqlite3', args: [], liveTaskVerified: false }, ['-readonly', probe.path, '.tables'], cwd, process.env);
        success(result, 'host sqlite3 prerequisite');
        assert.match(result.stdout, /isolation_fixture/);
      }
    }
  }
}

async function prepare(f: Fixture): Promise<PreparedCodexSandbox> {
  const prepared = await prepareCodexSandbox(f.request);
  f.disposers.push(() => prepared.cleanup());
  assert.ok(prepared.toolSandbox.executable, 'preparation must expose the actual Codex tool sandbox launcher');
  assert.ok([prepared.toolSandbox.executable, ...prepared.toolSandbox.args].some(value => /codex/.test(value)), 'real Codex sandbox is required, never a Node-only scenario executor');
  assert.ok(prepared.toolSandbox.args.includes('sandbox') && prepared.toolSandbox.args.includes('linux'), 'tool launcher must enter codex sandbox linux using the same effective policy as the interactive invocation');
  assert.equal(prepared.environment.TMUX_TMPDIR, f.runDirectory);
  assert.ok(!prepared.environment.TMUX && !prepared.environment.TMUX_PANE, 'no inherited main pane selection');
  assert.equal(prepared.environment.CODEX_HOME, f.request.environment.CODEX_HOME);
  return prepared;
}

async function tool(prepared: PreparedCodexSandbox, f: Fixture, script: string, args: readonly string[] = [], stdio?: StdioOptions): Promise<Result> {
  return await run(prepared.toolSandbox, [process.execPath, '--input-type=module', '-e', script, ...args], f.cwd, { ...prepared.environment }, stdio);
}

const probeScript = `
import {readFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {spawnSync} from 'node:child_process';
const observations=[];
for(const probe of JSON.parse(process.argv[1])) {
  let ok=false, error=null;
  try {
    if(probe.kind==='file') { await readFile(probe.path); ok=true; }
    else if(probe.kind==='sqlite') {
      const prerequisite=spawnSync('sqlite3',['-version'],{stdio:'ignore'});
      if(prerequisite.status!==0) { observations.push({id:probe.id,ok:false,error:'SQLITE_TOOL_UNAVAILABLE'}); continue; }
      const result=spawnSync('sqlite3',['-readonly',probe.path,'.tables'],{stdio:'ignore'});
      ok=result.status===0;
      error=result.error?.code ?? (ok ? null : 'SQLITE_DENIED');
    } else await new Promise(resolve=>{
      const socket=probe.kind==='tcp' ? createConnection({host:probe.path,port:probe.port}) : createConnection(probe.path);
      socket.once('connect',()=>{ok=true;socket.destroy();resolve();});
      socket.once('error',value=>{error=value.code;resolve();});
    });
  } catch(value) { error=value.code ?? value.name; }
  observations.push({id:probe.id,ok,error});
}
process.stdout.write(JSON.stringify(observations));
`;

function denied(result: Result, probes: readonly Probe[]): void {
  success(result, 'sandbox probe must execute; failed startup is not access denial');
  const observations: Observation[] = JSON.parse(result.stdout);
  assert.deepEqual(observations.map(value => value.id), probes.map(value => value.id));
  for (const observation of observations) {
    assert.equal(observation.ok, false, `${observation.id}: host resource was accessible`);
    assert.ok(observation.error, `${observation.id}: missing denial category`);
    assert.notEqual(observation.error, 'ECONNREFUSED', `${observation.id}: a dead listener is not isolation`);
    assert.notEqual(observation.error, 'ETIMEDOUT', `${observation.id}: timeout is not demonstrated isolation`);
    assert.notEqual(observation.error, 'SQLITE_TOOL_UNAVAILABLE', 'missing sqlite3 is not isolation');
  }
}

test('Y.2 policy retains workspace-write, never approvals, selection and per-run write roots', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const input = structuredClone(f.request);
  const args = nativeSandboxArgs(settings, f.request.invocation.args, f.request.scope);
  const prepared = await prepare(f);
  assert.ok(JSON.stringify(args) !== JSON.stringify(f.request.invocation.args) || JSON.stringify(prepared.invocation) !== JSON.stringify(f.request.invocation), 'codex requires a native policy or an external isolation wrapper before opening IPC');
  assert.deepEqual(f.request, input, 'preparation must not mutate caller scope, environment or invocation');
  const argv = prepared.invocation.args.join(' ');
  assert.match(argv, /workspace-write/);
  assert.match(argv, /never/);
  assert.doesNotMatch(argv, /danger-full-access|dangerously-bypass|disable-sandbox/);
  for (const value of [selected.model, selected.effort]) {
    const resolved = value === selected.model ? (settings.modelAliases[selected.model] ?? selected.model) : value;
    assert.ok(argv.includes(resolved), 'raf model and effort selection must survive preparation');
  }
  for (const path of prepared.policyPaths) {
    const canonical = await realpath(path);
    assert.ok(canonical.startsWith(f.runDirectory + sep), 'policy artifacts belong only to this run');
  }
  await hostControls(f.probes, f.listeners, f.cwd);
});

test('Y.2 real sandbox: Node Unix listen/connect/exchange in workspace and own run under hidden tmp', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  const paths = [join(f.cwd, 'node.sock'), join(f.runDirectory, 'node.sock')];
  const result = await tool(prepared, f, `
    import assert from 'node:assert/strict';
    import {createServer,createConnection} from 'node:net';
    import {once} from 'node:events';
    import {unlink} from 'node:fs/promises';
    for(const path of JSON.parse(process.argv[1])) {
      const server=createServer(socket=>socket.once('data',data=>socket.end(data)));
      server.listen(path); await once(server,'listening');
      const socket=createConnection(path); await once(socket,'connect');
      socket.write('own-ipc');
      const [data]=await once(socket,'data'); assert.equal(data.toString(),'own-ipc');
      socket.destroy(); await new Promise(done=>server.close(done));
      await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
    process.stdout.write('own-ipc-ok');
  `, [JSON.stringify(paths)]);
  success(result, 'positive Node Unix IPC (EPERM is a failure)');
  assert.equal(result.stdout, 'own-ipc-ok');
  for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
  await hostControls(f.probes, f.listeners, f.cwd);
});

test('Y.2 real sandbox: own tmux server executes a command and cleans only itself', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  const result = await tool(prepared, f, `
    import assert from 'node:assert/strict';
    import {spawnSync} from 'node:child_process';
    import {readFileSync} from 'node:fs';
    const [name,output]=process.argv.slice(1);
    const tmux=(args)=>spawnSync('tmux',['-L',name,...args],{encoding:'utf8'});
    try {
      const created=tmux(['new-session','-d','-s','own','sleep infinity']);
      assert.equal(created.status,0,created.stderr);
      const command=tmux(['wait-for','-L','fixture-lock']); assert.equal(command.status,0,command.stderr);
      const executed=tmux(['run-shell','printf own-tmux-ok > '+output]); assert.equal(executed.status,0,executed.stderr);
      assert.equal(readFileSync(output,'utf8'),'own-tmux-ok');
    } finally { const stopped=tmux(['kill-server']); assert.equal(stopped.status,0,stopped.stderr); }
    process.stdout.write('own-tmux-ok');
  `, [`y2-${f.runId}`, join(f.runDirectory, 'tmux-result')]);
  success(result, 'positive tmux IPC');
  assert.equal(result.stdout, 'own-tmux-ok');
  await assert.rejects(stat(join(f.runDirectory, `tmux-${process.getuid!()}`, `y2-${f.runId}`)), { code: 'ENOENT' });
  await hostControls(f.probes, f.listeners, f.cwd);
});

test('Y.2 real sandbox: active main/raf/bus/ssh fixtures, SQLite/WAL/SHM and 0600 secrets deny direct access', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  denied(await tool(prepared, f, probeScript, [JSON.stringify(f.probes)]), f.probes);
  await hostControls(f.probes, f.listeners, f.cwd);
});

test('Y.2 real sandbox: symlink and child Node/shell protect original absolute paths after HOME/effective UID relocation', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  const aliasProbes: Probe[] = [];
  for (const [index, probe] of f.probes.entries()) {
    if (probe.kind === 'tcp') continue;
    const alias = join(f.cwd, `alias-${index}`);
    await symlink(probe.path, alias);
    aliasProbes.push({ ...probe, id: `symlink-${probe.id}`, path: alias });
  }
  const targets = [...f.probes, ...aliasProbes];
  const result = await tool(prepared, f, `
    import {spawnSync} from 'node:child_process';
    const child=spawnSync('/bin/sh',['-c','exec "$1" --input-type=module -e "$2" "$3"','sandbox-child',process.execPath,process.argv[1],process.argv[2]],{
      env:{...process.env,HOME:process.argv[3],TMUX:'',TMUX_PANE:'',SSH_AUTH_SOCK:'',DBUS_SESSION_BUS_ADDRESS:'',XDG_RUNTIME_DIR:''},encoding:'utf8'
    });
    if(child.status!==0) { process.stderr.write(child.stderr ?? ''); process.exit(child.status ?? 1); }
    process.stdout.write(JSON.stringify({uid:process.getuid(),home:process.argv[3],observations:JSON.parse(child.stdout)}));
  `, [probeScript, JSON.stringify(targets), f.runDirectory]);
  success(result, 'child probe after HOME relocation under the mechanism effective UID');
  const identity = JSON.parse(result.stdout);
  assert.ok(Number.isInteger(identity.uid), 'record the actual effective UID even if the mechanism changes it');
  assert.notEqual(identity.home, f.hostHome);
  denied({ ...result, stdout: JSON.stringify(identity.observations) }, targets);
  await hostControls(f.probes, f.listeners, f.cwd);
});

test('Y.2 real sandbox: inherited file/socket descriptors and proc aliases cannot reopen host resources', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  const secret = f.probes.find(probe => probe.id === 'secret-0')!;
  const handle = await open(secret.path, 'r');
  f.disposers.push(() => handle.close());
  const procProbe: Probe = { id: 'host-proc-fd', kind: 'file', path: `/proc/${process.pid}/fd/${handle.fd}` };
  await readFile(procProbe.path);
  const socket = createConnection(f.probes.find(probe => probe.id === 'socket-1')!.path);
  await once(socket, 'connect');
  f.disposers.push(() => { socket.destroy(); });
  const result = await tool(prepared, f, `
    import {readSync,fstatSync} from 'node:fs';
    let file=false,socket=false;
    try { readSync(3,Buffer.alloc(1),0,1,0); file=true; } catch {}
    try { socket=fstatSync(4).isSocket(); } catch {}
    process.stdout.write(JSON.stringify({file,socket}));
  `, [], ['ignore', 'pipe', 'pipe', handle.fd, socket]);
  success(result, 'inherited descriptor probe');
  assert.deepEqual(JSON.parse(result.stdout), { file: false, socket: false }, 'sandbox must close inherited host handles');
  const procTargets = [procProbe, { ...secret, id: 'host-proc-root', path: `/proc/${process.pid}/root${secret.path}` }];
  denied(await tool(prepared, f, probeScript, [JSON.stringify(procTargets)]), procTargets);
  await hostControls(f.probes, f.listeners, f.cwd);
});

test('Y.2 real sandbox: assignment writes, JSON report and git commit work; outside and state writes fail', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const prepared = await prepare(f);
  const state = f.probes.find(probe => probe.id === 'state-0')!;
  const stateBefore = await readFile(state.path);
  const report = join(f.reportDirectory, `${f.runId}.json`);
  const result = await tool(prepared, f, `
    import assert from 'node:assert/strict';
    import {writeFile,rename,readFile} from 'node:fs/promises';
    import {spawnSync} from 'node:child_process';
    const paths=JSON.parse(process.argv[1]);
    for(const path of paths.allowed) await writeFile(path,'assignment');
    await writeFile(paths.report+'.tmp',JSON.stringify({status:'succeeded'})); await rename(paths.report+'.tmp',paths.report);
    assert.equal(JSON.parse(await readFile(paths.report,'utf8')).status,'succeeded');
    for(const path of paths.denied) await assert.rejects(writeFile(path,'forbidden'));
    const git=args=>{const value=spawnSync('git',args,{encoding:'utf8'});assert.equal(value.status,0,value.stderr);return value.stdout;};
    git(['init','--separate-git-dir='+paths.git,paths.repo]);
    git(['-C',paths.repo,'add','own.txt']);
    git(['-C',paths.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture']);
    assert.match(git(['-C',paths.repo,'rev-parse','HEAD']),/^[a-f0-9]{40,64}\\n$/);
    process.stdout.write('writes-and-git-ok');
  `, [JSON.stringify({ allowed: [join(f.cwd, 'own.txt'), join(f.changeDirectory, 'tasks'), join(f.runDirectory, 'own')], report, denied: [join(f.outside, 'no'), state.path, state.path + '-wal', state.path + '-shm'], git: f.gitDirectory, repo: f.cwd })]);
  success(result, 'writes/report/git boundaries');
  assert.equal(result.stdout, 'writes-and-git-ok');
  assert.deepEqual(await readFile(state.path), stateBefore);
  await assert.rejects(stat(join(f.outside, 'no')), { code: 'ENOENT' });
  await hostControls(f.probes, f.listeners, f.cwd);
});

for (const failure of ['missing-mechanism', 'unsafe-policy', 'hidden-cwd'] as const) {
  test(`Y.2 fail closed before brief: ${failure}, without broad retry or foreign cleanup`, { timeout: timeoutMs }, async t => {
    const f = await fixture(t);
    const original = f.request;
    const request = structuredClone(original);
    if (failure === 'missing-mechanism') request.invocation.executable = join(f.root, 'missing-codex');
    if (failure === 'unsafe-policy') request.invocation.args.push('--sandbox', 'danger-full-access');
    if (failure === 'hidden-cwd') Object.assign(request, { cwd: f.hostHome, writableDirectories: [...request.writableDirectories, f.hostHome] });
    const before = await readdir(f.runDirectory);
    await assert.rejects(prepareCodexSandbox(request), error => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.message, 'NotImplemented', 'coordinator must classify the initial scaffold exception separately');
      assert.match(error.message, /sandbox|isolation|policy|hidden|unavailable|ENOENT/i);
      return true;
    });
    assert.deepEqual(await readdir(f.runDirectory), before, 'failed preparation leaves no partial policy or brief');
    await hostControls(f.probes, f.listeners, f.cwd);
  });
}

test('Y.2 cleanup is repeatable and run-scoped; user Codex config and other runs stay intact', { timeout: timeoutMs }, async t => {
  const f = await fixture(t);
  const codexHome = join(f.root, 'codex-home');
  await mkdir(codexHome);
  const config = join(codexHome, 'config.toml');
  const configText = 'sandbox_mode = "workspace-write"\napproval_policy = "never"\n';
  await writeFile(config, configText);
  const request = { ...f.request, environment: { ...f.request.environment, CODEX_HOME: codexHome } };
  const prepared = await prepareCodexSandbox(request);
  f.disposers.push(() => prepared.cleanup());
  const policies = [...prepared.policyPaths];
  for (const path of policies) {
    assert.ok(isAbsolute(path));
    assert.ok(!relative(f.runDirectory, path).startsWith('..'));
    await stat(path);
  }
  const report = join(f.runDirectory, 'accepted-report.json');
  await writeFile(report, '{"status":"succeeded"}');
  await prepared.cleanup();
  await prepared.cleanup();
  for (const path of policies) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(await readFile(config, 'utf8'), configText);
  assert.equal(await readFile(report, 'utf8'), '{"status":"succeeded"}');
  await hostControls(f.probes, f.listeners, f.cwd);
});
