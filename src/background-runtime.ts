import { readWaitIdentity, observeWaitIdentity, tryWaitLease, verifyWaitPeer } from './resource-wait-identity.ts';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { promises as fs, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { releaseOwnedWriterLocks } from './owned-writer-lock.ts';
import { ServiceLifecycleController, type ServiceLifecycleRecord } from './service-lifecycle.ts';

export type ServiceFailure = {
  exitCode: 1;
  reason: string;
  details: string;
  remediation: string;
};

export type ServiceStatus = {
  exitCode: 0;
  serviceEpoch?: string;
  resourceWaitReady?: boolean;
  state: 'ready' | 'stopped' | 'failed';
  pid: number | null;
  mainPath: string | null;
  stopReason: string | null;
  reasonKnown: boolean;
};

export type BackgroundRuntimeOptions = {
  stateDirectory: string;
  socketPath: string;
  entryRelativePath: string;
  readinessTimeoutMs: number;
};

export type BackgroundRuntimeDependencies = {
  resolveMainPath: (signal?: AbortSignal) => Promise<string>;
  validateMainSnapshot?: (path: string) => Promise<boolean>;
  spawn?: typeof spawn;
  nodeExecutable?: string;
};

export type ServiceRequest = { operation: string; payload: unknown };
export type ServiceResponse = { exitCode: 0; value: unknown } | ServiceFailure;

export type BackgroundRuntime = {
  start: () => Promise<ServiceStatus | ServiceFailure>;
  ensureReady: (options?: { signal?: AbortSignal }) => Promise<ServiceStatus | ServiceFailure>;
  status: () => Promise<ServiceStatus | ServiceFailure>;
  stop: () => Promise<ServiceStatus | ServiceFailure>;
  request: (request: ServiceRequest, options?: { signal?: AbortSignal }) => Promise<ServiceResponse>;
};

export type ServiceHostOptions = {
  stateDirectory: string;
  socketPath: string;
  handlers: {
    recover: (bootstrap?: { serviceEpoch: string }) => Promise<void>;
    resourceWait?: (socket: Socket, message: any, signal: AbortSignal) => Promise<void>;
    handle: (request: ServiceRequest, context: { signal: AbortSignal; clientId: string }) => Promise<unknown>;
    shutdown: () => Promise<void>;
  };
};

type RecordState = {
  pid: number;
  token: string;
  mainPath: string;
  state: 'starting' | 'ready' | 'stopped' | 'failed';
  stopReason: string | null;
  identity?: import('./resource-wait-protocol.ts').ResourceWaitIdentity;
};

const failure = (reason: string, error: unknown): ServiceFailure => ({
  exitCode: 1, reason, details: error instanceof Error ? error.message : String(error),
  remediation: 'Check the configured raf main checkout, service entry, state directory permissions and service.log, then retry service start.',
});
const readRecord = async (directory: string): Promise<RecordState | null> => {
  try { return JSON.parse(await fs.readFile(join(directory, 'service.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
const writeRecord = async (directory: string, record: RecordState) => {
  const temporary = join(directory, `service.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(temporary, join(directory, 'service.json'));
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function exchange(socketPath: string, message: unknown, timeout?: number, signal?: AbortSignal,
  peer?: { identity: ServiceLifecycleRecord['identity']; timeoutMs: number }): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let finished = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('Service request cancelled'));
    const timer = timeout === undefined ? undefined : setTimeout(() => finish(new Error(`Service did not respond within ${timeout} ms`)), timeout);
    socket.on('connect', () => {
      void (async () => {
        if (peer) {
          await verifyWaitPeer(socket, peer.identity, peer.timeoutMs);
          if ((await observeWaitIdentity(peer.identity)).state !== 'alive') throw new Error('Service peer identity changed');
        }
        if (!finished) socket.write(JSON.stringify(message) + '\n');
      })().catch(finish);
    });
    socket.on('data', data => {
      buffer += data.toString();
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        try { finish(undefined, JSON.parse(buffer.slice(0, end))); } catch (error) { finish(error); }
      }
    });
    socket.on('error', finish);
    socket.on('close', () => finish(new Error('Service connection lost before response')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createBackgroundRuntime(
  options: BackgroundRuntimeOptions,
  dependencies: BackgroundRuntimeDependencies,
): BackgroundRuntime {
  const startup = new AsyncLocalStorage<{ child?: ReturnType<typeof spawn>; logOffset?: number }>();
  const remaining = (deadline: number) => {
    const value = deadline - performance.now();
    if (value <= 0) throw new Error('Service readiness budget exhausted');
    return Math.ceil(value);
  };
  const lifecycleRecord = async (): Promise<ServiceLifecycleRecord | null> => {
    const record = await readRecord(options.stateDirectory);
    if (!record) return null;
    if (!record.identity) throw new Error('Recorded service owner identity is unavailable');
    return { ...record, identity: record.identity, serviceEpoch: record.token };
  };
  const controller = new ServiceLifecycleController(options, {
    now: () => performance.now(),
    exclusive: async (deadline, operation) => {
      await fs.mkdir(options.stateDirectory, { recursive: true });
      let lease: Awaited<ReturnType<typeof tryWaitLease>> = null;
      while (!lease) {
        lease = await tryWaitLease(join(options.stateDirectory, 'service-start.lock'), remaining(deadline));
        if (!lease) await pause(Math.min(25, remaining(deadline)));
      }
      try { remaining(deadline); return await operation(); }
      finally { await lease.release(); }
    },
    readRecord: lifecycleRecord,
    observe: async identity => (await observeWaitIdentity(identity)).state,
    resolveMainPath: dependencies.resolveMainPath,
    validateMainSnapshot: async root => {
      if (await fs.realpath(root) !== root) return false;
      const branch = await promisify(execFile)('git', ['-C', root, 'branch', '--show-current'], { timeout: options.readinessTimeoutMs }).then(result => result.stdout.trim()).catch(() => '');
      return branch === 'main' || !!await dependencies.validateMainSnapshot?.(root);
    },
    entryExists: async entry => {
      try { return (await fs.stat(entry)).isFile(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    },
    spawn: async input => {
      const previous = await readRecord(options.stateDirectory);
      try {
        const endpoint = await fs.lstat(options.socketPath);
        if (!endpoint.isSocket() || !previous?.identity || (await observeWaitIdentity(previous.identity)).state !== 'dead') throw new Error('Socket exists without verified dead service ownership');
        const current = await fs.lstat(options.socketPath);
        if (current.dev !== endpoint.dev || current.ino !== endpoint.ino) throw new Error('Service endpoint ownership changed before cleanup');
        await fs.unlink(options.socketPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      remaining(input.deadline);
      const log = await fs.open(join(options.stateDirectory, 'service.log'), 'a', 0o600);
      let spawned!: Promise<void>;
      try {
        const attempt = startup.getStore();
        if (!attempt) throw new Error('Service spawn requires an active startup attempt');
        attempt.logOffset = (await log.stat()).size;
        const child = (dependencies.spawn ?? spawn)(dependencies.nodeExecutable ?? process.execPath, [input.entry], {
          cwd: input.cwd, detached: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, RAF_STATE_DIRECTORY: options.stateDirectory, RAF_SOCKET_PATH: options.socketPath, RAF_MAIN_PATH: input.mainPath },
        });
        attempt.child = child;
        spawned = new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', resolve);
        });
        void spawned.catch(() => {});
      } finally { await log.close(); }
      const processToStart = startup.getStore()!.child!;
      await spawned;
      processToStart.unref();
      if (!processToStart.pid) throw new Error('Spawn did not return a service PID');
      return readWaitIdentity(processToStart.pid);
    },
    handshake: async (deadline, signal) => {
      const owner = await lifecycleRecord();
      if (!owner) return null;
      let response: any;
      try { response = await exchange(options.socketPath, { kind: 'status' }, remaining(deadline), signal, { identity: owner.identity, timeoutMs: remaining(deadline) }); }
      catch (error) {
        if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
        throw error;
      }
      const record = await lifecycleRecord();
      if (!record || response.exitCode !== 0 || response.state !== 'ready') return null;
      return { ...response, identity: record.identity, exclusiveOwner: response.exclusiveOwner === true,
        databaseOpen: response.databaseOpen === true, lastGrantLoaded: response.lastGrantLoaded === true };
    },
    waitForChange: async (deadline, signal) => {
      if (signal?.aborted) throw new Error('Service readiness cancelled');
      await pause(Math.min(25, remaining(deadline)));
    },
    shutdown: async (owner, deadline) => {
      if ((await observeWaitIdentity(owner.identity)).state !== 'alive') throw new Error('Service owner changed before shutdown');
      const response = await exchange(options.socketPath, { kind: 'stop', serviceEpoch: owner.serviceEpoch }, remaining(deadline), undefined, { identity: owner.identity, timeoutMs: remaining(deadline) });
      return { acknowledged: response.exitCode === 0 && response.serviceEpoch === owner.serviceEpoch && ['stopped', 'failed'].includes(response.state) };
    },
    awaitShutdown: async (owner, deadline) => {
      for (;;) {
        const observation = await observeWaitIdentity(owner.identity);
        if (observation.state === 'dead') return true;
        if (observation.state !== 'alive') return false;
        await pause(Math.min(25, remaining(deadline)));
      }
    },
    exchange: async (request, serviceEpoch, signal) => {
      const owner = await lifecycleRecord();
      if (!owner || owner.serviceEpoch !== serviceEpoch) throw new Error('Service epoch changed before request');
      return exchange(options.socketPath, { kind: 'request', request, serviceEpoch }, undefined, signal, { identity: owner.identity, timeoutMs: options.readinessTimeoutMs });
    },
  });
  const start = async (startOptions?: { signal?: AbortSignal }): Promise<ServiceStatus | ServiceFailure> => startup.run({}, async () => {
    let result = await controller.ensureReady(startOptions);
    const attempt = startup.getStore()!;
    const spawned = attempt.child;
    if (result.exitCode !== 0 && spawned?.pid) {
      try {
        if (spawned.exitCode === null && spawned.signalCode === null) {
          const exited = new Promise<void>(resolve => spawned.once('exit', () => resolve()));
          spawned.kill('SIGTERM');
          const escalation = setTimeout(() => spawned.kill('SIGKILL'), options.readinessTimeoutMs);
          try { await exited; } finally { clearTimeout(escalation); }
        }
        const log = await fs.readFile(join(options.stateDirectory, 'service.log'));
        const currentLog = log.subarray(Math.max(attempt.logOffset ?? log.length, log.length - 8192)).toString();
        if (currentLog) result = { ...result, details: `${result.details}\n${currentLog}` };
        const record = await readRecord(options.stateDirectory);
        if (record?.pid === spawned.pid) await writeRecord(options.stateDirectory, { ...record, state: 'failed', stopReason: result.details });
      } catch (error) {
        result = failure(result.reason, `${result.details}\nStartup cleanup or diagnostic persistence failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  });
  return {
    start, ensureReady: start, status: () => controller.status(), stop: () => controller.stop(),
    request: async (request, requestOptions) => {
      const ready = await start(requestOptions);
      if (ready.exitCode !== 0) return ready;
      try {
        const owner = await lifecycleRecord();
        if (!owner || owner.serviceEpoch !== ready.serviceEpoch) throw new Error('Service epoch changed before request');
        return await exchange(options.socketPath, { kind: 'request', request, serviceEpoch: ready.serviceEpoch }, undefined, requestOptions?.signal, { identity: owner.identity, timeoutMs: options.readinessTimeoutMs });
      }
      catch (error) { return failure('Service request failed', error); }
    },
  };
}

export async function runServiceHost(options: ServiceHostOptions): Promise<{
  close: () => Promise<void>;
  closed: Promise<void>;
}> {
  await fs.mkdir(options.stateDirectory, { recursive: true });
  const ownerPath = join(options.stateDirectory, 'service-owner.lock');
  const identity = await readWaitIdentity();
  const owner = await tryWaitLease(ownerPath);
  if (!owner) throw new Error('OS service owner lock is held; refusing second service');
  const releaseOwner = () => owner.release();
  const record: RecordState = { pid: process.pid, identity, token: randomUUID(), mainPath: process.env.RAF_MAIN_PATH ?? process.cwd(), state: 'starting', stopReason: null };
  const sockets = new Set<Socket>();
  const resourceWaitSockets = new Set<Socket>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let closing: Promise<void> | undefined;
  const serviceStatus = (): ServiceStatus => ({ serviceEpoch: record.token, resourceWaitReady: record.state === 'ready' && !!options.handlers.resourceWait, exitCode: 0, state: record.state === 'ready' ? 'ready' : record.state === 'stopped' ? 'stopped' : 'failed', pid: record.state === 'ready' ? process.pid : null, mainPath: record.mainPath, stopReason: record.stopReason, reasonKnown: record.stopReason !== null });
  const server = createServer(socket => {
    sockets.add(socket);
    const controller = new AbortController();
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); resourceWaitSockets.delete(socket); controller.abort(); });
    socket.on('end', () => controller.abort());
    let buffer = '';
    let handled = false;
    socket.on('data', data => {
      if (handled) return;
      buffer += data.toString();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      void (async () => {
        const message = JSON.parse(buffer.slice(0, end));
        if (message.kind === 'resource-wait' && !closing && record.state === 'ready' && options.handlers.resourceWait) {
          resourceWaitSockets.add(socket);
          await options.handlers.resourceWait(socket, message, controller.signal);
        }
        else if (message.kind === 'status') socket.end(JSON.stringify({ ...serviceStatus(), exclusiveOwner: true, databaseOpen: record.state === 'ready', lastGrantLoaded: record.state === 'ready' }) + '\n');
        else if (message.kind === 'stop' && message.serviceEpoch === record.token) {
          await shutdown(false, socket);
          socket.end(JSON.stringify(serviceStatus()) + '\n');
        } else if (message.kind === 'request' && message.serviceEpoch === record.token && !closing && record.state === 'ready') {
          const value = await options.handlers.handle(message.request, { signal: controller.signal, clientId: randomUUID() });
          if (!controller.signal.aborted) socket.end(JSON.stringify({ exitCode: 0, value }) + '\n');
        } else socket.end(JSON.stringify(failure('Service not ready', record.state)) + '\n');
      })().catch(error => { if (!socket.destroyed) socket.end(JSON.stringify(failure('Service operation failed', error)) + '\n'); });
    });
  });
  const shutdown = (failed = false, replySocket?: Socket): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      releaseOwnedWriterLocks();
      process.off('exit', onExit);
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      server.close();
      for (const socket of sockets) if (socket !== replySocket && !resourceWaitSockets.has(socket)) socket.destroy();
      try {
        await options.handlers.shutdown();
        record.state = failed ? 'failed' : 'stopped';
        record.stopReason ??= failed ? 'Service failed' : 'Service stopped normally';
      } catch (error) { record.state = 'failed'; record.stopReason = String(error); }
      finally { for (const socket of sockets) if (socket !== replySocket) socket.destroy(); }
      await writeRecord(options.stateDirectory, record);
      await releaseOwner();
      resolveClosed();
    })();
    return closing;
  };
  const onSignal = () => { void shutdown(); };
  const onExit = (code: number) => {
    record.state = 'failed';
    record.stopReason = `Service process exited unexpectedly with code ${code}`;
    const temporary = join(options.stateDirectory, `service.${record.token}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
      renameSync(temporary, join(options.stateDirectory, 'service.json'));
    } catch {}
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => { server.off('error', reject); resolve(); });
    });
    await fs.chmod(options.socketPath, 0o600);
    await writeRecord(options.stateDirectory, record);
    process.on('exit', onExit);
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    await Promise.race([options.handlers.recover({ serviceEpoch: record.token }), closed.then(() => { throw new Error('Service stopped during recovery'); })]);
    record.state = 'ready';
    await writeRecord(options.stateDirectory, record);
    server.on('error', error => { record.stopReason = String(error); void shutdown(true); });
    return { close: () => shutdown(), closed };
  } catch (error) {
    if (server.listening) { record.stopReason = String(error); await shutdown(true); }
    else await releaseOwner();
    throw error;
  }
}
