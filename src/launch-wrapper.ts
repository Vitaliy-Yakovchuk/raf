import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentReportWatcher } from './agent-report.ts';
import type { AdapterCommand, AdapterSelection } from './agent-adapters.ts';
import type { AgentReportExit, AgentReportPorts, AgentReportRequest, AgentReportResult } from './agent-report.ts';
import type { ProcessIdentity } from './session-state.ts';
import { commandFailure, failureContext } from './cli-contract.ts';

export interface LaunchWrapperRequest extends AgentReportRequest {
  readonly statePath: string;
  readonly cwd: string;
  readonly tmuxSession: string;
  readonly selection: AdapterSelection;
  readonly brief: string;
  readonly readinessTimeoutMs: number;
}
export type LaunchReadiness =
  | { state: 'starting' }
  | { state: 'ready'; runnerSessionId: string }
  | { state: 'auth_required' | 'permission_required' | 'unknown_screen' | 'timeout' | 'exited'; reason: string };
export type LaunchOwnership =
  | { state: 'owned'; identity: ProcessIdentity; processKind: 'agent' | 'runner-owned' }
  | { state: 'mismatch' | 'unknown' | 'exited'; reason: string };
export interface LaunchHandshake {
  readonly runId: string;
  readonly address: string;
  readonly reportPath: string;
  readonly identity: ProcessIdentity;
}
export interface LaunchWrapperPorts {
  readonly transport: {
    startWithoutInput(request: LaunchWrapperRequest, reportPath: string): Promise<void>;
    waitReady(timeoutMs: number): Promise<LaunchReadiness>;
    ownership(): Promise<LaunchOwnership>;
    deliver(brief: string): Promise<void>;
    waitExit(): Promise<AgentReportExit>;
    stop(identity: ProcessIdentity): Promise<void>;
  };
  readonly report: Omit<AgentReportPorts, 'process' | 'result'>;
  readonly lifecycle: {
    started(handshake: LaunchHandshake): Promise<void>;
    acceptReport(result: AgentReportResult): Promise<void>;
    finish(handshake: LaunchHandshake, exit: AgentReportExit): Promise<void>;
    failed(runId: string, reason: string, recoverable: boolean): Promise<void>;
  };
  handshake(handshake: LaunchHandshake): Promise<void>;
}
export interface PersistentWrapperOptions {
  readonly workerCommand: AdapterCommand;
  readonly timeoutMs: number;
}
export interface PersistentWrapperLaunch extends LaunchHandshake {
  readonly wrapperPid: number;
}
export type PersistentWrapperFailure = Error & { readonly wrapper: { terminate(): Promise<void> } };
const validIdentity = (identity: ProcessIdentity, request: LaunchWrapperRequest): boolean =>
  identity !== null && typeof identity === 'object' && Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
  typeof identity.startedAt === 'string' && identity.startedAt.trim().length > 0 &&
  identity.runner === request.selection.runner && typeof identity.runnerSessionId === 'string' && identity.runnerSessionId.trim().length > 0 &&
  identity.tmuxSession === request.tmuxSession && identity.evidence !== null && typeof identity.evidence === 'object' &&
  Object.keys(identity.evidence).length > 0 && Object.values(identity.evidence).every(value => typeof value === 'string' && value.length > 0) &&
  identity.evidence.runId === request.runId && typeof identity.evidence.command === 'string' && identity.evidence.command.trim().length > 0;

const sameIdentity = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
  left.pid === right.pid && left.startedAt === right.startedAt && left.runner === right.runner &&
  left.runnerSessionId === right.runnerSessionId && left.tmuxSession === right.tmuxSession &&
  Object.entries(left.evidence).every(([key, value]) => right.evidence[key] === value);

async function within<T>(operation: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${stage} timeout after ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function withAccompanyingFailure(primary: unknown, cleanup: unknown): Error {
  const describe = (value: unknown) => value instanceof Error ? value.message : String(value);
  const message = `${describe(primary)}; accompanying cleanup failure: ${describe(cleanup)}`;
  const context = failureContext(primary);
  return context ? commandFailure({ ...context, message, reason: message }) : new Error(message);
}

export async function runLaunchWrapper(request: LaunchWrapperRequest, ports: LaunchWrapperPorts): Promise<void> {
  if (!Number.isFinite(request.readinessTimeoutMs) || request.readinessTimeoutMs <= 0) throw new Error('Runner readiness timeout must be positive');
  let watcher: Awaited<ReturnType<typeof createAgentReportWatcher>> | undefined;
  let identity: ProcessIdentity | undefined;
  let attempted = false;
  let ended = false;
  try {
    watcher = await createAgentReportWatcher(request, {
      ...ports.report,
      process: { onExit: () => () => {} },
      result: result => ports.lifecycle.acceptReport(result),
    });
    attempted = true;
    await ports.transport.startWithoutInput(request, watcher.path);
    const readiness = await within(ports.transport.waitReady(request.readinessTimeoutMs), request.readinessTimeoutMs, 'Runner readiness');
    if (readiness.state !== 'ready') throw new Error(`Runner readiness ${readiness.state}: ${'reason' in readiness ? readiness.reason : 'runner has not become ready'}`);
    const ownership = await ports.transport.ownership();
    if (ownership.state !== 'owned') throw new Error(`Runner ownership ${ownership.state}: ${ownership.reason}`);
    if (!['agent', 'runner-owned'].includes(ownership.processKind) || !validIdentity(ownership.identity, request) || ownership.identity.runnerSessionId !== readiness.runnerSessionId) throw new Error('Runner identity does not match the ready native session and launch');
    identity = structuredClone(ownership.identity);
    const handshake: LaunchHandshake = { runId: request.runId, address: request.address, reportPath: watcher.path, identity };
    await ports.transport.deliver(request.brief);
    await ports.lifecycle.started(handshake);
    await ports.handshake(handshake);
    const exit = await ports.transport.waitExit();
    ended = true;
    await watcher.finish(exit);
    await ports.lifecycle.finish(handshake, exit);
    await watcher.dispose();
  } catch (error) {
    let recoverable = attempted;
    if (recoverable && !ended) {
      try {
        const ownership = await ports.transport.ownership();
        if (ownership.state === 'exited') recoverable = false;
        else if (ownership.state === 'owned' && validIdentity(ownership.identity, request) && ['agent', 'runner-owned'].includes(ownership.processKind) && (!identity || sameIdentity(identity, ownership.identity))) {
          await ports.transport.stop(ownership.identity);
          await within(ports.transport.waitExit(), request.readinessTimeoutMs, 'Owned runner stop confirmation');
          recoverable = false;
        }
      } catch {}
    }
    try { await ports.lifecycle.failed(request.runId, error instanceof Error ? error.message : String(error), recoverable); }
    catch (cleanup) { throw withAccompanyingFailure(error, cleanup); }
    if (!recoverable) await watcher?.dispose();
    throw error;
  }
}

export async function launchPersistentWrapper(request: LaunchWrapperRequest, options: PersistentWrapperOptions): Promise<PersistentWrapperLaunch> {
  if (!isAbsolute(request.statePath) || !isAbsolute(request.cwd) || !isAbsolute(request.tmpRoot) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.address)) throw new Error('Wrapper requires absolute state, cwd, tmp paths and valid run/address identities');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Wrapper handshake timeout must be positive');
  const directory = await fs.mkdtemp(join(tmpdir(), 'rw-'));
  await fs.chmod(directory, 0o700);
  const socketPath = join(directory, 'h.sock');
  const requestPath = join(directory, 'request.json');
  const nonce = randomUUID();
  const sockets = new Set<Socket>();
  const server = createServer();
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const runDirectory = join(request.tmpRoot, request.runId);
  await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const logPath = join(runDirectory, 'worker.log');
  const log = await fs.open(logPath, 'wx+', 0o600);
  const workerOutput = async () => {
    const { size } = await log.stat();
    const length = Math.min(size, 16384);
    const { buffer, bytesRead } = await log.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  };
  try {
    await fs.writeFile(requestPath, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    await fs.writeFile(requestPath + '.peer', JSON.stringify({ parentPid: process.pid, nonce }), { mode: 0o600, flag: 'wx' });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    await fs.chmod(socketPath, 0o600);
    return await new Promise<PersistentWrapperLaunch>((resolve, reject) => {
      const terminate = async () => {
        const owned = child;
        if (!owned?.pid || owned.exitCode !== null || owned.signalCode !== null) return;
        owned.ref();
        const exited = new Promise<void>(resolve => owned.once('exit', () => resolve()));
        try { process.kill(-owned.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        await exited;
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        void workerOutput().catch(() => '').then(output => reject(Object.assign(new Error(`Wrapper launch ${request.runId} failed: ${String(error)}${output.trim() ? `; worker: ${output.slice(-4096).trim()}` : ''}; verify runner readiness and recover this run before retrying`), { wrapper: { terminate } })));
      };
      server.on('error', fail);
      server.on('connection', socket => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        let buffer = '';
        socket.on('data', data => {
          if (settled) return;
          buffer += data.toString();
          const end = buffer.indexOf('\n');
          if (end < 0) return;
          try {
            const handshake = JSON.parse(buffer.slice(0, end)) as LaunchHandshake & { wrapperPeer?: { pid: number; nonce: string } };
            if (handshake.wrapperPeer && (handshake.wrapperPeer.pid !== child?.pid || handshake.wrapperPeer.nonce !== nonce)) throw new Error('Wrapper handshake peer mismatch');
            if (handshake.runId !== request.runId || handshake.address !== request.address || handshake.reportPath !== join(request.tmpRoot, request.runId, `${request.address}.json`) || !validIdentity(handshake.identity, request)) throw new Error('Handshake does not match the requested run, report path or verified runner identity');
            process.kill(handshake.identity.pid, 0);
            if (!child?.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Wrapper exited before handshake');
            settled = true;
            resolve({ ...handshake, wrapperPid: child.pid });
          } catch (error) { fail(error); }
        });
      });
      const command = options.workerCommand;
      child = spawn(command.executable, [...command.args], {
        cwd: command.cwd ?? request.cwd,
        detached: true,
        stdio: [command.stdin === undefined ? 'ignore' : 'pipe', log.fd, log.fd],
        env: { ...process.env, RAF_WRAPPER_REQUEST_PATH: requestPath, RAF_WRAPPER_HANDSHAKE_SOCKET: socketPath },
      });
      child.once('error', fail);
      child.once('exit', (code, signal) => fail(`Worker exited before readiness: code=${code}, signal=${signal}`));
      if (command.stdin !== undefined) {
        child.stdin!.on('error', fail);
        child.stdin!.end(command.stdin);
      }
      child.unref();
      timer = setTimeout(() => fail(`Readiness handshake timeout after ${options.timeoutMs} ms`), options.timeoutMs);
    });
  } finally {
    if (timer) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await log.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function consumeWrapperRequest(): Promise<{ request: LaunchWrapperRequest; handshake(handshake: LaunchHandshake): Promise<void> }> {
  const requestPath = process.env.RAF_WRAPPER_REQUEST_PATH;
  const socketPath = process.env.RAF_WRAPPER_HANDSHAKE_SOCKET;
  if (!requestPath || !socketPath || !isAbsolute(requestPath) || !isAbsolute(socketPath) || join(requestPath, '..') !== join(socketPath, '..')) throw new Error('Private wrapper request and handshake socket required');
  const [requestStat, socketStat, directoryStat] = await Promise.all([fs.lstat(requestPath), fs.lstat(socketPath), fs.lstat(join(requestPath, '..'))]);
  if (!requestStat.isFile() || !socketStat.isSocket() || !directoryStat.isDirectory() || [requestStat, socketStat, directoryStat].some(stat => stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw new Error('Wrapper IPC must be private and owned by the current user');
  const value = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  const peerPath = requestPath + '.peer';
  const peerStat = await fs.lstat(peerPath);
  if (!peerStat.isFile() || peerStat.uid !== process.getuid?.() || (peerStat.mode & 0o077) !== 0) throw new Error('Wrapper bootstrap peer must be private');
  const peer = JSON.parse(await fs.readFile(peerPath, 'utf8'));
  if (!peer || peer.parentPid !== process.ppid || typeof peer.nonce !== 'string' || !peer.nonce) throw new Error('Wrapper bootstrap does not belong to this parent invocation');
  const request = value as LaunchWrapperRequest;
  if (!isAbsolute(request.statePath) || !isAbsolute(request.cwd) || !isAbsolute(request.tmpRoot) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.address) || !/^[A-Za-z0-9_-]+$/.test(request.tmuxSession) || !request.assignment || !request.selection || typeof request.brief !== 'string' || !request.brief.trim() || !Number.isFinite(request.readinessTimeoutMs) || request.readinessTimeoutMs <= 0) throw new Error('Invalid wrapper request');
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let sent = false;
  return { request, handshake: async handshake => {
    if (sent || handshake.runId !== request.runId || handshake.address !== request.address || !validIdentity(handshake.identity, request)) throw new Error('Invalid or duplicate worker handshake');
    sent = true;
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.end(JSON.stringify({ ...handshake, wrapperPeer: { pid: process.pid, nonce: peer.nonce } }) + '\n', () => resolve()); });
  } };
}
