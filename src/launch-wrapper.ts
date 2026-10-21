import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentReportWatcher } from './agent-report.ts';
import type { AdapterCommand, AdapterSelection } from './agent-adapters.ts';
import type { AgentReportExit, AgentReportPorts, AgentReportRequest, AgentReportResult } from './agent-report.ts';
import type { ProcessIdentity } from './session-state.ts';

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
    await ports.lifecycle.failed(request.runId, error instanceof Error ? error.message : String(error), recoverable);
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
  const sockets = new Set<Socket>();
  const server = createServer();
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    await fs.writeFile(requestPath, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    await fs.chmod(socketPath, 0o600);
    return await new Promise<PersistentWrapperLaunch>((resolve, reject) => {
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Wrapper launch ${request.runId} failed: ${String(error)}; verify runner readiness and recover this run before retrying`));
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
            const handshake = JSON.parse(buffer.slice(0, end)) as LaunchHandshake;
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
        stdio: [command.stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
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
    await fs.rm(directory, { recursive: true, force: true });
  }
}
