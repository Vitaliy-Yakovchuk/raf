import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createRafTemporarySocketEndpoint, type RafTemporarySocketEndpoint, type RafTemporarySocketScope } from '../src/raf-temporary-socket.ts';
import { hotfixCommitClientCommand } from '../src/hotfix-commit-client-command.ts';
import { prepareHotfixWorktree, startHotfixCommitPort, type HotfixHost } from '../src/hotfix-worktree.ts';
import { consumeWrapperRequest, launchPersistentWrapper, type LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import { prepareCodexSandbox, type CodexSandboxRequest } from '../src/codex-sandbox.ts';
import { readMachineBootIdentity } from '../src/os-runtime.ts';
import { TestRunDiagnostics, buildDiagnosticEnvironment, validateDiagnosticLimits, type InlineDiagnostic, type DiagnosticSummary } from '../src/test-run-diagnostics.ts';

export interface CaseInput {
  root: string;
  home: string;
  runDirectory: string;
  tmpdir: string;
  tmpRoot: string;
  workspace: string;
  runId: string;
  budgetMs: number;
  variant?: string;
  evidenceDirectory?: string;
  endpoint: 'hotfix' | 'wrapper' | 'runtime-tmux' | 'tool-tmux' | 'quota-leader';
  action: 'exchange' | 'concurrent' | 'failures' | 'hotfix-ingress' | 'wrapper-ingress' | 'sandbox-ingress' | 'wrapper-reject' | 'wrapper-peer';
}

export const fixturePath = fileURLToPath(import.meta.url);
const prefix = 'Z390_RESULT:';

interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  spawnError: { name: string; message: string; code: string | null; stack: string | null } | null;
  timedOut: null;
  invocation: { executable: string; argv: string[]; cwd: string };
}

let diagnosticInput: CaseInput | undefined;
let diagnosticIdentity: Pick<CaseInput, 'runId' | 'variant' | 'action'> | undefined;
let commandSerial = 0;
const toolMode = process.argv[2] === 'sandbox-tool';
const markerPrefix = 'Z390_PROGRESS:';
const toolCommandPrefix = 'Z390_TOOL_COMMAND:';

async function progress(marker: string): Promise<void> {
  const event = { marker, phase, runId: diagnosticIdentity?.runId ?? null, variant: diagnosticIdentity?.variant ?? null, action: diagnosticIdentity?.action ?? null };
  if (diagnosticInput?.evidenceDirectory) await appendFile(join(diagnosticInput.evidenceDirectory, 'progress.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  process.stderr.write(markerPrefix + JSON.stringify(event) + '\n');
}

async function saveCommand(directory: string, label: string, result: CommandResult, writeStreams = true): Promise<void> {
  await Promise.all([
    ...(writeStreams ? [writeFile(join(directory, `${label}.stdout`), result.stdout, { mode: 0o600 }),
      writeFile(join(directory, `${label}.stderr`), result.stderr, { mode: 0o600 })] : []),
    writeFile(join(directory, `${label}.code.json`), JSON.stringify({
      invocation: result.invocation, exit: { code: result.code, signal: result.signal, spawnError: result.spawnError, timedOut: result.timedOut },
      unavailableReason: 'No additional timeout was installed by instrumentation; timeout belongs to the existing outer runner.',
    }), { mode: 0o600 }),
  ]);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.evidence = [...new Set([...manifest.evidence, ...['stdout', 'stderr', 'code.json'].map(suffix => join(directory, `${label}.${suffix}`))])];
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
}

export async function command(executable: string, args: readonly string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  evidence?: { directory: string; label: string };
} = {}): Promise<CommandResult> {
  const evidence = options.evidence ?? (diagnosticInput?.evidenceDirectory ? { directory: diagnosticInput.evidenceDirectory, label: `tool-${++commandSerial}` } : undefined);
  if (evidence) {
    writeFileSync(join(evidence.directory, `${evidence.label}.stdout`), '', { mode: 0o600 });
    writeFileSync(join(evidence.directory, `${evidence.label}.stderr`), '', { mode: 0o600 });
    writeFileSync(join(evidence.directory, `${evidence.label}.code.json`), JSON.stringify({ invocation: { executable, argv: [...args], cwd: options.cwd ?? process.cwd() }, exit: { code: null, signal: null, spawnError: null, timedOut: null }, unavailableReason: 'Child has not closed; the outer TestRunResult owns timeout and termination facts.' }), { mode: 0o600 });
  }
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
  let spawnError: CommandResult['spawnError'] = null;
  child.stdout.on('data', chunk => { stdout += outDecoder.write(chunk); if (evidence) appendFileSync(join(evidence.directory, `${evidence.label}.stdout`), chunk); });
  child.stderr.on('data', chunk => { stderr += errDecoder.write(chunk); if (evidence) appendFileSync(join(evidence.directory, `${evidence.label}.stderr`), chunk); });
  child.once('error', error => { spawnError = { name: error.name, message: error.message, code: (error as NodeJS.ErrnoException).code ?? null, stack: error.stack ?? null }; });
  const [code, signal] = await new Promise<[number | null, string | null]>(yes => child.once('close', (code, signal) => yes([code, signal])));
  stdout += outDecoder.end(); stderr += errDecoder.end();
  const result: CommandResult = { code, signal, stdout, stderr, spawnError, timedOut: null, invocation: { executable, argv: [...args], cwd: options.cwd ?? process.cwd() } };
  if (evidence) {
    await saveCommand(evidence.directory, evidence.label, result, false);
    let serial = 0;
    for (const line of stderr.split('\n').filter(line => line.startsWith(toolCommandPrefix))) {
      await saveCommand(evidence.directory, `${evidence.label}-nested-${++serial}`, JSON.parse(line.slice(toolCommandPrefix.length)));
    }
  }
  if (toolMode) process.stderr.write(toolCommandPrefix + JSON.stringify(result) + '\n');
  return result;
}

export async function caseDiagnostic(input: CaseInput, test: { file: string; name: string }, result: Record<string, any>): Promise<{
  caseRunId: string; variant: string | null; action: CaseInput['action']; phase: string;
  diagnostics: InlineDiagnostic[]; diagnosticSummary: DiagnosticSummary; lastProgress: string | null; evidence: string[];
  evidenceIndex: { path: string | null; omitted: number; unavailableReason: string | null };
}> {
  const conf = await readFile(new URL('../../conf/test-runs.json', import.meta.url));
  const limits = validateDiagnosticLimits(JSON.parse(conf.toString()).diagnostics);
  const value = new TestRunDiagnostics(limits, { workspace: resolve(import.meta.dirname, '..'), qaHome: input.home, fixtureRoots: [input.root] });
  value.failure({ test, origin: 'test-body', error: { name: result.ok ? 'CaseProgress' : 'Error', message: result.reason ?? `case ${input.action}: ${result.phase ?? 'complete'}`, code: result.code, stack: result.stack } });
  value.stderrChunk(Buffer.from(result.exit?.stderr ?? ''));
  value.childExit({ exitCode: result.exit?.code ?? null, signal: result.exit?.signal ?? null, validProtocol: Boolean(result.ok) });
  const details = value.attach({ runId: input.runId,
    outcome: result.ok ? 'passed' : 'assertions-failed', failureKinds: [], knownRed: [], unknown: [], unexecuted: [], timeoutCount: null,
    timedOut: false, cleanup: result.cleanup ?? 'unavailable', evidence: input.evidenceDirectory ? [join(input.evidenceDirectory, 'manifest.json')] : [],
  }, buildDiagnosticEnvironment({ executable: process.execPath, runtimeVersion: process.version, adapter: 'node-test-events', isolation: 'case-process',
    configurationBytes: { flow: new Uint8Array(), testRuns: conf, projects: new Uint8Array() }, tmpPath: input.tmpdir, privateRunTmp: true }));
  const lastLine = (result.exit?.stderr ?? '').split('\n').findLast((line: string) => line.startsWith(markerPrefix));
  const manifest = input.evidenceDirectory ? JSON.parse(await readFile(join(input.evidenceDirectory, 'manifest.json'), 'utf8')) : null;
  const evidence: string[] = [...(manifest?.evidence ?? [])];
  while (evidence.length > 1 && Buffer.byteLength(JSON.stringify(evidence)) > Math.floor(limits.maxProtocolLineBytes / 4)) evidence.pop();
  const omitted = (manifest?.evidence.length ?? 0) - evidence.length;
  return { caseRunId: input.runId, variant: input.variant ?? null, action: input.action, phase: result.phase ?? 'complete',
    diagnostics: details.diagnostics, diagnosticSummary: details.diagnosticSummary,
    lastProgress: lastLine ? JSON.parse(lastLine.slice(markerPrefix.length)).marker : null, evidence,
    evidenceIndex: { path: input.evidenceDirectory ? join(input.evidenceDirectory, 'manifest.json') : null, omitted, unavailableReason: omitted ? 'Inline locator list bounded by configured protocol limit; the manifest retains every exact raw path.' : null },
  };
}

async function saveFailure(input: CaseInput, error: unknown): Promise<void> {
  if (!input.evidenceDirectory) return;
  const failure = error as NodeJS.ErrnoException;
  const record = { runId: input.runId, variant: input.variant, action: input.action, phase, reason: failure.message, code: failure.code ?? null, stack: failure.stack ?? null };
  await appendFile(join(input.evidenceDirectory, 'failure.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  await writeFile(join(input.evidenceDirectory, 'failure.json'), JSON.stringify(record), { mode: 0o600 });
}

export async function runCase(input: CaseInput): Promise<Record<string, any>> {
  const tracePath = join(input.root, 'socket-trace.jsonl');
  const traceModule = fileURLToPath(new URL('./raf-unix-socket-paths-trace.mjs', import.meta.url));
  const result = await command(process.execPath, [fixturePath, 'case', JSON.stringify(input)], {
    cwd: input.workspace,
    evidence: input.evidenceDirectory ? { directory: input.evidenceDirectory, label: 'case' } : undefined,
    env: { ...process.env, HOME: input.home, TMPDIR: input.tmpdir, TMP: input.tmpdir, TEMP: input.tmpdir, TMUX: '', TMUX_PANE: '', Z390_TRACE: tracePath, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(traceModule)}` },
  });
  const line = result.stdout.split('\n').findLast(row => row.startsWith(prefix));
  assert.ok(line, `setup/protocol failure: ${JSON.stringify(result)}`);
  const parsed = JSON.parse(line.slice(prefix.length));
  if (input.evidenceDirectory) await writeFile(join(input.evidenceDirectory, 'case-result.json'), JSON.stringify(parsed), { mode: 0o600 });
  let trace: unknown[] = [];
  try { trace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (input.evidenceDirectory) await writeFile(join(input.evidenceDirectory, 'socket-trace.json'), JSON.stringify(trace), { mode: 0o600 });
  return { ...parsed, trace, exit: result };
}

async function exchange(address: string, payload: string): Promise<string> {
  const socket = createConnection(address);
  socket.setEncoding('utf8');
  let received = '';
  socket.on('data', chunk => { received += chunk; });
  await once(socket, 'connect');
  socket.end(payload);
  await once(socket, 'close');
  return received;
}

function spawnServer(scope: RafTemporarySocketScope, payload: string) {
  const child = spawn(process.execPath, [fixturePath, 'server', '--leader-socket', scope.address, payload], {
    cwd: scope.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = new Promise<void>((yes, no) => {
    child.once('error', no);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('LISTENING\n')) yes();
    });
    child.once('exit', code => no(new Error(`listen failed (${code}): ${stderr}`)));
  });
  return { child, ready, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'close');
    child.stdin.end();
    await ended;
  } };
}

async function ipc(endpoint: RafTemporarySocketEndpoint, payload: string) {
  const server = spawnServer(endpoint.bind, payload);
  try {
    await server.ready;
    const result = await command(process.execPath, [fixturePath, 'client', endpoint.connect.address, payload], { cwd: endpoint.connect.cwd });
    assert.equal(result.code, 0, `connect failed: ${result.stderr}`);
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.payload, payload);
    assert.equal(response.cwd, endpoint.connect.cwd);
    return response;
  } finally {
    await server.close();
  }
}

function directoryFor(input: CaseInput): string {
  if (input.endpoint === 'wrapper') return join(input.tmpdir, `rw-${input.runId}`);
  if (input.endpoint === 'runtime-tmux') return join(input.tmpRoot, 'tmux');
  if (input.endpoint === 'quota-leader') return join(input.tmpRoot, 'quota', `grok-${input.runId}`);
  if (input.endpoint === 'tool-tmux') return join(input.runDirectory, `tmux-${process.getuid?.() ?? 0}`);
  return input.runDirectory;
}

function basenameFor(input: CaseInput): string {
  return ({ hotfix: 'hotfix-commit.sock', wrapper: 'h.sock', 'runtime-tmux': 'server.sock', 'tool-tmux': 'default', 'quota-leader': 'leader.sock' })[input.endpoint];
}

async function allocate(input: CaseInput): Promise<RafTemporarySocketEndpoint> {
  const directory = directoryFor(input);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.z390-caller-owned'), 'caller-owned');
  return createRafTemporarySocketEndpoint({ runId: input.runId, directory, basename: basenameFor(input), serverCwd: input.workspace, clientCwd: input.workspace });
}

async function resourceFacts(endpoint: RafTemporarySocketEndpoint) {
  const parents = [endpoint.bind, endpoint.connect].map(scope => dirname(resolve(scope.cwd, scope.address)));
  return Promise.all([...endpoint.ownedResources, ...parents].map(async path => {
    const info = await lstat(path);
    const owner = info.isDirectory() ? info : await stat(dirname(path));
    return { path, uid: owner.uid, mode: owner.mode & 0o777, real: await realpath(path) };
  }));
}

async function removed(paths: readonly string[]) {
  return Promise.all(paths.map(async path => {
    try { await lstat(path); return { path, absent: false }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { path, absent: true }; }
  }));
}

async function tmuxExchange(endpoint: RafTemporarySocketEndpoint, payload: string) {
  const commands: { address: string; cwd: string; args: string[]; code: number | null }[] = [];
  async function tmux(scope: RafTemporarySocketScope, args: string[]) {
    const result = await command('tmux', ['-S', scope.address, ...args], { cwd: scope.cwd });
    commands.push({ ...scope, args, code: result.code });
    assert.equal(result.code, 0, `tmux ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
  }
  try {
    await tmux(endpoint.bind, ['-f', '/dev/null', 'new-session', '-d', '-s', 'z390', '-c', endpoint.bind.cwd, 'cat']);
    await tmux(endpoint.connect, ['send-keys', '-t', 'z390', '-l', payload]);
    await tmux(endpoint.connect, ['send-keys', '-t', 'z390', 'Enter']);
    let capture = '';
    while (!capture.includes(payload)) capture = await tmux(endpoint.connect, ['capture-pane', '-p', '-t', 'z390']);
    const sessions = await tmux(endpoint.connect, ['list-sessions', '-F', '#{session_name}']);
    assert.ok(sessions.includes('z390'));
    return { payload, capture, commands };
  } finally {
    const cleanup = await command('tmux', ['-S', endpoint.connect.address, 'kill-server'], { cwd: endpoint.connect.cwd });
    commands.push({ ...endpoint.connect, args: ['kill-server'], code: cleanup.code });
  }
}

async function endpointExchange(input: CaseInput) {
  const endpoint = await allocate(input);
  const payload = `z390:${input.runId}:дані`;
  let facts: unknown, response: unknown;
  try {
    facts = await resourceFacts(endpoint);
    response = input.endpoint.endsWith('tmux') ? await tmuxExchange(endpoint, payload) : await ipc(endpoint, payload);
  } finally { await endpoint.cleanup(); }
  await endpoint.cleanup();
  assert.equal(await readFile(join(directoryFor(input), '.z390-caller-owned'), 'utf8'), 'caller-owned');
  return { endpoint: { bind: endpoint.bind, connect: endpoint.connect }, facts, response, cleanup: await removed(endpoint.ownedResources) };
}

async function concurrent(input: CaseInput) {
  const before = { cwd: process.cwd(), env: { ...process.env } };
  const aInput = { ...input, runId: `${input.runId}-a` };
  const bInput = { ...input, runId: `${input.runId}-b`, runDirectory: join(input.runDirectory, 'b'), tmpRoot: join(input.tmpRoot, 'b') };
  const allocations = await Promise.allSettled([allocate(aInput), allocate(bInput)]);
  const failed = allocations.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    await Promise.all(allocations.filter(result => result.status === 'fulfilled').map(result => result.value.cleanup()));
    throw failed.reason;
  }
  const [a, b] = allocations.map(result => (result as PromiseFulfilledResult<RafTemporarySocketEndpoint>).value);
  let shared: RafTemporarySocketEndpoint | undefined;
  const serverA = spawnServer(a.bind, 'A');
  const serverB = spawnServer(b.bind, 'B');
  try {
    await Promise.all([serverA.ready, serverB.ready]);
    shared = await allocate({ ...input, endpoint: 'runtime-tmux', runId: `${input.runId}-shared`, tmpRoot: join(input.tmpRoot, 'shared') });
    const sharedStart = await command('tmux', ['-S', shared.bind.address, '-f', '/dev/null', 'new-session', '-d', '-s', 'shared', 'cat'], { cwd: shared.bind.cwd });
    assert.equal(sharedStart.code, 0, `setup/shared runtime tmux: ${sharedStart.stderr}`);
    const results = await Promise.all([
      command(process.execPath, [fixturePath, 'client', a.connect.address, 'A'], { cwd: a.connect.cwd }),
      command(process.execPath, [fixturePath, 'client', b.connect.address, 'B'], { cwd: b.connect.cwd }),
    ]);
    results.forEach(result => assert.equal(result.code, 0, result.stderr));
    await serverA.close();
    await a.cleanup();
    const stillAlive = await command(process.execPath, [fixturePath, 'client', b.connect.address, 'B'], { cwd: b.connect.cwd });
    assert.equal(stillAlive.code, 0, stillAlive.stderr);
    assert.equal(JSON.parse(stillAlive.stdout).payload, 'B');
    const blocked = join(input.root, 'concurrent-blocked');
    await writeFile(blocked, 'foreign');
    await assert.rejects(createRafTemporarySocketEndpoint({ runId: `${input.runId}-failed`, directory: blocked, basename: basenameFor(input), serverCwd: input.workspace, clientCwd: input.workspace }));
    const sharedLive = await command('tmux', ['-S', shared.connect.address, 'list-sessions', '-F', '#{session_name}'], { cwd: shared.connect.cwd });
    assert.equal(sharedLive.code, 0, sharedLive.stderr);
    assert.match(sharedLive.stdout, /shared/);
    assert.equal(await readFile(join(directoryFor(aInput), '.z390-caller-owned'), 'utf8'), 'caller-owned');
    assert.equal(process.cwd(), before.cwd);
    assert.deepEqual({ ...process.env }, before.env);
    return { a: a.bind, b: b.bind, shared: shared.connect, sharedRuntimeAlive: true, stillAlive: true, isolated: true };
  } finally {
    await Promise.all([serverA.close(), serverB.close()]);
    if (shared) {
      await command('tmux', ['-S', shared.connect.address, 'kill-server'], { cwd: shared.connect.cwd });
      await shared.cleanup();
    }
    await Promise.all([a.cleanup(), b.cleanup()]);
  }
}

async function failures(input: CaseInput) {
  const a = await allocate(input);
  const sibling = join(input.root, 'foreign-sentinel');
  await writeFile(sibling, 'foreign');
  const foreignSocket = join(input.root, 'foreign.sock');
  const foreign = createServer(socket => socket.end('foreign-live'));
  foreign.listen(foreignSocket);
  await once(foreign, 'listening');
  try {
    const result = await command(process.execPath, [fixturePath, 'client', a.connect.address, 'missing'], { cwd: a.connect.cwd });
    assert.notEqual(result.code, 0, 'connect without listener must fail');
    assert.match(result.stderr, /ENOENT|ECONNREFUSED/);
    await a.cleanup();
    assert.equal(await readFile(sibling, 'utf8'), 'foreign');
    assert.equal(await readFile(join(directoryFor(input), '.z390-caller-owned'), 'utf8'), 'caller-owned');
    assert.equal(await exchange(foreignSocket, ''), 'foreign-live');
    const foreignDirectory = join(input.root, 'foreign-directory');
    await mkdir(foreignDirectory, { mode: 0o700 });
    await writeFile(join(foreignDirectory, 'keep'), 'foreign');
    const redirected = join(input.root, 'redirected-directory');
    await symlink(foreignDirectory, redirected);
    await assert.rejects(createRafTemporarySocketEndpoint({ runId: `${input.runId}-redirect`, directory: redirected, basename: basenameFor(input), serverCwd: input.workspace, clientCwd: input.workspace }), /canonical|symlink|identity|unsafe|directory/i);
    assert.equal(await readFile(join(foreignDirectory, 'keep'), 'utf8'), 'foreign');
    const blocked = join(input.root, 'blocked-directory');
    await writeFile(blocked, 'foreign-file');
    let setupError: string | null = null;
    try {
      const invalid = await createRafTemporarySocketEndpoint({ runId: `${input.runId}-bad`, directory: blocked, basename: basenameFor(input), serverCwd: input.workspace, clientCwd: input.workspace });
      await invalid.cleanup();
    } catch (error) { setupError = String(error); }
    assert.ok(setupError, 'unsafe directory must give explicit setup error');
    assert.equal(await readFile(blocked, 'utf8'), 'foreign-file');
    return { connectError: result.stderr, setupError, foreignAlive: true, cleanup: await removed(a.ownedResources) };
  } finally {
    await a.cleanup();
    await new Promise<void>((yes, no) => foreign.close(error => error ? no(error) : yes()));
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await command('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Z390', GIT_AUTHOR_EMAIL: 'z390@example.invalid', GIT_COMMITTER_NAME: 'Z390', GIT_COMMITTER_EMAIL: 'z390@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.code, 0, `fixture git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

async function worktreeRegistry(main: string, hotfix: string): Promise<string> {
  return (await git(main, 'worktree', 'list', '--porcelain')).split('\n\n').map(record => record.startsWith(`worktree ${hotfix}\n`) ? record.replace(/^HEAD [0-9a-f]+$/m, 'HEAD <hotfix-current>') : record).join('\n\n');
}

async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(path: string) {
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (info.isFile()) { hash.update(path.slice(root.length)); hash.update(await readFile(path)); }
  }
  await visit(root);
  return hash.digest('hex');
}

async function hotfixIngress(input: CaseInput) {
  const root = join(input.root, 'orchestrator');
  const main = join(root, 'raf-main'), hotfix = join(root, 'raf-hotfix'), develop = join(root, 'raf-develop');
  phase = 'setup';
  const seed = join(input.root, 'seed');
  await mkdir(seed, { recursive: true });
  await git(seed, 'init', '-b', 'main');
  await writeFile(join(seed, 'base.txt'), 'base');
  await git(seed, 'add', 'base.txt');
  await git(seed, 'commit', '-m', 'fixture base');
  await mkdir(root, { recursive: true });
  await git(root, 'init', '-b', 'main');
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', seed, 'raf-main');
  await git(root, 'commit', '-m', 'fixture raf submodule');
  await git(main, 'worktree', 'add', '-b', 'hotfix', hotfix);
  await git(main, 'worktree', 'add', '-b', 'develop', develop);
  await mkdir(join(root, 'conf'), { recursive: true });
  await writeFile(join(root, 'conf', 'flow.json'), await readFile(new URL('../../conf/flow.json', import.meta.url)));
  await writeFile(join(root, 'conf', 'projects.json'), JSON.stringify({ profiles: { default: { development: 'develop' } }, projects: { raf: { path: 'raf-main', profile: 'default', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } } } }));
  const host: HotfixHost = { orchestratorRoot: root, qaHome: input.home, environment: { HOME: input.home, GIT_AUTHOR_NAME: 'Z390', GIT_AUTHOR_EMAIL: 'z390@example.invalid', GIT_COMMITTER_NAME: 'Z390', GIT_COMMITTER_EMAIL: 'z390@example.invalid' }, sandboxExecutable: 'bwrap' };
  const workspace = await prepareHotfixWorktree(host, input.runId);
  assert.equal(workspace.cwd, hotfix);
  const mainBefore = await git(main, 'rev-parse', 'HEAD');
  const developBefore = await git(develop, 'rev-parse', 'HEAD');
  const mainGitDir = await git(main, 'rev-parse', '--absolute-git-dir');
  const metadata = await Promise.all(['index', 'HEAD'].map(name => readFile(join(mainGitDir, name))));
  const registered = await worktreeRegistry(main, hotfix);
  const developGitDir = await git(develop, 'rev-parse', '--absolute-git-dir');
  const developMetadata = await treeFingerprint(developGitDir);
  await writeFile(join(hotfix, 'own.txt'), 'own payload');
  await writeFile(join(hotfix, 'foreign.txt'), 'foreign dirty');
  phase = 'listen';
  const port = await startHotfixCommitPort(host, workspace, input.runDirectory);
  try {
    const client = hotfixCommitClientCommand(input.runDirectory, { cwd: hotfix, paths: ['own.txt'], message: 'z390 own payload' });
    assert.equal(client.cwd, hotfix);
    const result = await command(client.executable, client.args, { cwd: client.cwd, env: { ...process.env, ...client.environment } });
    assert.equal(result.code, 0, `generated client connect/commit failed: ${result.stderr}`);
    assert.deepEqual((await git(hotfix, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).split('\n'), ['own.txt']);
    assert.equal(await readFile(join(hotfix, 'foreign.txt'), 'utf8'), 'foreign dirty');
    assert.equal(await git(main, 'rev-parse', 'HEAD'), mainBefore);
    assert.equal(await git(develop, 'rev-parse', 'HEAD'), developBefore);
    assert.equal(await worktreeRegistry(main, hotfix), registered);
    assert.equal(await treeFingerprint(developGitDir), developMetadata);
    assert.deepEqual(await Promise.all(['index', 'HEAD'].map(name => readFile(join(mainGitDir, name)))), metadata);
    const committedHead = await git(hotfix, 'rev-parse', 'HEAD');
    const rejected = hotfixCommitClientCommand(input.runDirectory, { cwd: hotfix, paths: ['../raf-main/base.txt'], message: 'must refuse' });
    const refusal = await command(rejected.executable, rejected.args, { cwd: rejected.cwd, env: { ...process.env, ...rejected.environment } });
    assert.notEqual(refusal.code, 0, 'client must not authorize paths outside workspace');
    assert.equal(await git(hotfix, 'rev-parse', 'HEAD'), committedHead);
    assert.equal(await git(main, 'rev-parse', 'HEAD'), mainBefore);
    assert.equal(await git(develop, 'rev-parse', 'HEAD'), developBefore);
    assert.equal(await worktreeRegistry(main, hotfix), registered);
    assert.equal(await treeFingerprint(developGitDir), developMetadata);
    assert.deepEqual(await Promise.all(['index', 'HEAD'].map(name => readFile(join(mainGitDir, name)))), metadata);
    return { committed: true, generatedClient: client.executable, gitBoundaries: true, workspace: workspace.cwd };
  } finally { await port.close(); }
}

function wrapperRequest(input: CaseInput): LaunchWrapperRequest {
  return { runId: input.runId, address: `z390-${input.runId}`, tmpRoot: input.tmpRoot, statePath: join(input.home, '.raf', 'state.db'), cwd: input.workspace, tmuxSession: `z390-${input.runId}`, selection: { runner: 'codex', model: 'fixture', effort: 'fixture' }, brief: 'z390 payload бриф', readinessTimeoutMs: input.budgetMs, assignment: { root: input.root, changes: [{ id: 'fixture-change', items: [{ id: '1', description: 'socket fixture' }] }], baselineArchives: [] } };
}

async function wrapperIngress(input: CaseInput) {
  const request = wrapperRequest(input);
  phase = 'handshake';
  let launch;
  try { launch = await launchPersistentWrapper(request, { timeoutMs: input.budgetMs, workerCommand: { executable: process.execPath, args: [fixturePath, 'wrapper-worker'], cwd: input.workspace, environment: { ...process.env, Z390_CAPTURE: join(input.root, 'wrapper-capture.json'), Z390_REJECT: input.action === 'wrapper-reject' ? '1' : '', Z390_PEER: input.action === 'wrapper-peer' ? '1' : '' } } }); } catch (error) {
    await (error as { wrapper?: { terminate(): Promise<void> } }).wrapper?.terminate();
    throw error;
  }
  assert.equal(launch.runId, request.runId);
  assert.equal(launch.address, request.address);
  assert.equal(launch.reportPath, join(request.tmpRoot, request.runId, `${request.address}.json`));
  const capture = JSON.parse(await readFile(join(input.root, 'wrapper-capture.json'), 'utf8'));
  assert.equal(capture.request.brief, request.brief);
  assert.equal(capture.request.cwd, request.cwd);
  assert.equal(capture.request.statePath, request.statePath);
  assert.equal(capture.home, input.home);
  assert.equal(capture.cwd, input.workspace);
  if (input.action === 'wrapper-peer') assert.equal(capture.peerRejected, true);
  return { launch, capture, ready: true };
}

async function sandboxIngress(input: CaseInput) {
  await progress('unix:registered:before');
  const registered = join(input.workspace, 'registered.sock');
  const foreign = createServer(socket => socket.end('host-forbidden'));
  foreign.listen(registered);
  await once(foreign, 'listening');
  await progress('unix:registered:after');
  const secret = join(input.root, 'hidden-state', 'secret');
  await mkdir(dirname(secret), { recursive: true });
  await writeFile(secret, 'state-secret');
  const request: CodexSandboxRequest = {
    runId: input.runId,
    invocation: { executable: 'codex', args: ['--sandbox', 'workspace-write'], liveTaskVerified: false },
    scope: {
      hidden: [dirname(secret), registered],
      readable: [input.workspace],
      tmuxDirectory: input.runDirectory,
      excludedCommands: [],
    },
    cwd: input.workspace,
    runDirectory: input.runDirectory,
    writableDirectories: [input.workspace, input.runDirectory, input.tmpdir],
    environment: {
      ...process.env,
      HOME: input.home,
      TMPDIR: input.tmpdir,
      TMUX: `${join(input.root, 'foreign-tmux.sock')},1,0`,
      TMUX_PANE: '%99',
    },
  };
  phase = 'sandbox-preflight';
  let policy;
  await progress('prepare:before');
  try { policy = await prepareCodexSandbox(request); await progress('prepare:after'); } catch (error) {
    await saveFailure(input, error);
    await progress('prepare:failed');
    await progress('sandbox:cleanup:before');
    await new Promise<void>(yes => foreign.close(() => yes()));
    if (input.evidenceDirectory) await writeFile(join(input.evidenceDirectory, 'cleanup.json'), JSON.stringify({ complete: null, foreignClosed: true, unavailableReason: 'prepare did not return a policy; its internal cleanup is unobserved', phase, runId: input.runId }), { mode: 0o600 });
    await progress('sandbox:cleanup:after');
    throw error;
  }
  try {
    await progress('sandbox:tool:before');
    const result = await command(policy.toolSandbox.executable, [...policy.toolSandbox.args, process.execPath, fixturePath, 'sandbox-tool', registered, secret, JSON.stringify({ runId: input.runId, variant: input.variant, action: input.action })], { cwd: input.workspace, env: { ...process.env, ...policy.environment } });
    await progress('sandbox:tool:after');
    assert.equal(result.code, 0, `sandbox tool failed: ${result.stderr}`);
    const proof = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    assert.equal(proof.ownTmux, true);
    assert.equal(proof.hostDenied, true);
    assert.equal(proof.aliasDenied, true);
    assert.equal(proof.stateWriteDenied, true);
    assert.equal(proof.stateDenied, true);
    assert.equal(proof.tmuxInherited, false);
    assert.equal(await readFile(secret, 'utf8'), 'state-secret');
    return { ...proof, prepared: true };
  } catch (error) {
    await saveFailure(input, error);
    throw error;
  } finally {
    await progress('sandbox:cleanup:before');
    try {
      await policy.cleanup();
      await new Promise<void>((yes, no) => foreign.close(error => error ? no(error) : yes()));
      if (input.evidenceDirectory) await writeFile(join(input.evidenceDirectory, 'cleanup.json'), JSON.stringify({ complete: true, phase, runId: input.runId }), { mode: 0o600 });
      await progress('sandbox:cleanup:after');
    } catch (error) {
      if (input.evidenceDirectory) await writeFile(join(input.evidenceDirectory, 'cleanup.json'), JSON.stringify({ complete: false, phase, runId: input.runId, reason: (error as Error).message, stack: (error as Error).stack }), { mode: 0o600 });
      throw error;
    }
  }
}

let phase = 'endpoint';

async function caseMain(input: CaseInput) {
  if (input.action === 'sandbox-ingress') { diagnosticInput = input; diagnosticIdentity = input; }
  const before = { cwd: process.cwd(), home: process.env.HOME, tmpdir: process.env.TMPDIR };
  let result: unknown;
  try {
    if (input.action === 'exchange') result = await endpointExchange(input);
    else if (input.action === 'concurrent') result = await concurrent(input);
    else if (input.action === 'failures') result = await failures(input);
    else if (input.action === 'hotfix-ingress') result = await hotfixIngress(input);
    else if (input.action === 'sandbox-ingress') result = await sandboxIngress(input);
    else if (input.action === 'wrapper-reject') {
      let rejection: unknown;
      await assert.rejects(wrapperIngress(input), error => {
        rejection = error;
        return /handshake|identity|runId|mismatch|exited|invalid/i.test((error as Error).message);
      });
      let capture;
      try { capture = JSON.parse(await readFile(join(input.root, 'wrapper-capture.json'), 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw rejection;
        throw error;
      }
      assert.equal(capture.request.runId, input.runId, 'rejection requires a real child to have consumed the request');
      assert.equal(capture.identity.evidence.runId, input.runId);
      assert.equal(capture.handshakeRunId, `${input.runId}-forged`);
      result = { rejected: true };
    } else result = await wrapperIngress(input);
    assert.deepEqual({ cwd: process.cwd(), home: process.env.HOME, tmpdir: process.env.TMPDIR }, before);
    process.stdout.write(`${prefix}${JSON.stringify({ ok: true, result, before })}\n`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    await saveFailure(input, error);
    process.stdout.write(`${prefix}${JSON.stringify({ ok: false, phase, failureKind: /NotImplemented/.test(failure.message) ? 'missing-behavior' : phase === 'setup' || /spawn .*ENOENT|Operation not permitted|unshare|bwrap.*not found/i.test(failure.message) ? 'setup' : 'operation', reason: failure.message, code: failure.code, stack: failure.stack, before })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[2] === 'case') await caseMain(JSON.parse(process.argv[3]));
else if (process.argv[2] === 'server') {
  const server = createServer(socket => {
    let payload = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { payload += chunk; });
    socket.on('end', () => socket.end(payload === process.argv[5] ? payload : 'WRONG_PAYLOAD'));
  });
  assert.equal(process.argv[3], '--leader-socket');
  server.listen(process.argv[4]);
  await once(server, 'listening');
  process.stdout.write('LISTENING\n');
  process.stdin.resume();
  process.stdin.once('end', () => server.close());
} else if (process.argv[2] === 'client') {
  const payload = await exchange(process.argv[3], process.argv[4]);
  process.stdout.write(JSON.stringify({ payload, cwd: process.cwd(), home: process.env.HOME }));
} else if (process.argv[2] === 'wrapper-worker') {
  const { request, handshake } = await consumeWrapperRequest();
  let peerRejected = false;
  if (process.env.Z390_PEER) {
    const peer = await command(process.execPath, [fixturePath, 'untrusted-wrapper-peer']);
    assert.equal(peer.code, 0, peer.stderr);
    assert.equal(peer.stdout.trim(), 'PEER_REJECTED');
    peerRejected = true;
  }
  const ps = await command('ps', ['-p', String(process.pid), '-o', 'lstart=']);
  assert.equal(ps.code, 0, `setup: process start identity: ${ps.stderr}`);
  const startedAt = new Date(ps.stdout.trim()).toISOString();
  const processCommand = await command('ps', ['-p', String(process.pid), '-o', 'args=']);
  assert.equal(processCommand.code, 0, `setup: process command identity: ${processCommand.stderr}`);
  assert.ok(processCommand.stdout.trim(), 'setup: process command identity must be nonempty');
  const evidence = { ...await readMachineBootIdentity(), runId: request.runId, command: processCommand.stdout.trim() };
  const identity = { pid: process.pid, startedAt, evidence, runner: request.selection.runner, runnerSessionId: request.runId, tmuxSession: request.tmuxSession };
  const handshakeRunId = process.env.Z390_REJECT ? `${request.runId}-forged` : request.runId;
  await writeFile(process.env.Z390_CAPTURE!, JSON.stringify({ request, home: process.env.HOME, cwd: process.cwd(), peerRejected, identity, handshakeRunId }));
  await handshake({ runId: handshakeRunId, address: request.address, reportPath: join(request.tmpRoot, request.runId, `${request.address}.json`), identity });
} else if (process.argv[2] === 'untrusted-wrapper-peer') {
  let refused = false;
  try { await consumeWrapperRequest(); } catch { refused = true; }
  assert.equal(refused, true, 'inherited handshake environment must not authorize another peer');
  process.stdout.write('PEER_REJECTED');
} else if (process.argv[2] === 'sandbox-tool') {
  const identity = JSON.parse(process.argv[5]);
  diagnosticIdentity = { runId: identity.runId, variant: identity.variant, action: identity.action };
  phase = 'sandbox-tool';
  await progress('tool:before');
  assert.ok(!process.env.TMUX && !process.env.TMUX_PANE);
  let hostDenied = false, stateDenied = false, stateWriteDenied = false;
  await progress('host:socket:deny:before');
  try { await exchange(process.argv[3], 'forbidden'); } catch { hostDenied = true; }
  await progress('host:socket:deny:after');
  await progress('state:read:deny:before');
  try { await readFile(process.argv[4]); } catch { stateDenied = true; }
  await progress('state:read:deny:after');
  await progress('state:write:deny:before');
  try { await writeFile(process.argv[4], 'tampered'); } catch { stateWriteDenied = true; }
  await progress('state:write:deny:after');
  const alias = join(process.cwd(), 'registered-alias.sock');
  await symlink(process.argv[3], alias);
  let aliasDenied = false;
  await progress('alias:deny:before');
  try { await exchange(alias, 'forbidden'); } catch { aliasDenied = true; }
  await progress('alias:deny:after');
  await progress('unix:child:deny:before');
  const childConnect = await command(process.execPath, [fixturePath, 'client', process.argv[3], 'forbidden']);
  assert.notEqual(childConnect.code, 0, 'registered host endpoint must stay denied in a child');
  await progress('unix:child:deny:after');
  const actualSockets: string[] = [];
  for (const selector of [[], ['-L', `z390-${process.pid}`]]) {
    const name = selector.length ? 'named' : 'default';
    try {
      await progress(`tmux:${name}:command:before`);
      const start = await command('tmux', [...selector, '-f', '/dev/null', 'new-session', '-d', '-s', name, 'cat']);
      assert.equal(start.code, 0, start.stderr);
      await progress(`tmux:${name}:command:after`);
      await progress(`tmux:${name}:payload:before`);
      const sent = await command('tmux', [...selector, 'send-keys', '-t', name, '-l', 'sandbox-payload']);
      assert.equal(sent.code, 0, sent.stderr);
      let capture;
      do {
        capture = await command('tmux', [...selector, 'capture-pane', '-p', '-t', name]);
        assert.equal(capture.code, 0, capture.stderr);
      } while (!capture.stdout.includes('sandbox-payload'));
      await progress(`tmux:${name}:payload:after`);
      const address = await command('tmux', [...selector, 'display-message', '-p', '-t', name, '#{socket_path}']);
      assert.equal(address.code, 0, address.stderr);
      actualSockets.push(address.stdout.trim());
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      process.stderr.write('Z390_TOOL_FAILURE:' + JSON.stringify({ ...diagnosticIdentity, phase, reason: failure.message, code: failure.code ?? null, stack: failure.stack ?? null }) + '\n');
      throw error;
    } finally {
      await progress(`tmux:${name}:cleanup:before`);
      await command('tmux', [...selector, 'kill-server']);
      await progress(`tmux:${name}:cleanup:after`);
    }
  }
  await progress('tool:after');
  process.stdout.write(JSON.stringify({ ownTmux: true, hostDenied, aliasDenied, stateDenied, stateWriteDenied, tmuxInherited: false, actualSockets }) + '\n');
}
