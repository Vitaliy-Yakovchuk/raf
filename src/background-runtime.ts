import { spawn, execFileSync } from 'node:child_process';
import { promises as fs, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export type ServiceFailure = {
  exitCode: 1;
  reason: string;
  details: string;
  remediation: string;
};

export type ServiceStatus = {
  exitCode: 0;
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
  resolveMainPath: () => Promise<string>;
  validateMainSnapshot?: (path: string) => Promise<boolean>;
  spawn?: typeof spawn;
  nodeExecutable?: string;
};

export type ServiceRequest = { operation: string; payload: unknown };
export type ServiceResponse = { exitCode: 0; value: unknown } | ServiceFailure;

export type BackgroundRuntime = {
  start: () => Promise<ServiceStatus | ServiceFailure>;
  ensureReady: () => Promise<ServiceStatus | ServiceFailure>;
  status: () => Promise<ServiceStatus | ServiceFailure>;
  stop: () => Promise<ServiceStatus | ServiceFailure>;
  request: (request: ServiceRequest, options?: { signal?: AbortSignal }) => Promise<ServiceResponse>;
};

export type ServiceHostOptions = {
  stateDirectory: string;
  socketPath: string;
  handlers: {
    recover: () => Promise<void>;
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
};

const failure = (reason: string, error: unknown): ServiceFailure => ({
  exitCode: 1, reason, details: error instanceof Error ? error.message : String(error),
  remediation: 'Check the configured raf main checkout, service entry, state directory permissions and service.log, then retry service start.',
});
const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
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

function exchange(socketPath: string, message: unknown, timeout?: number, signal?: AbortSignal): Promise<any> {
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
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
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
  const probe = () => exchange(options.socketPath, { kind: 'status' }, options.readinessTimeoutMs);
  const status = async (): Promise<ServiceStatus | ServiceFailure> => {
    try {
      try {
        const response = await probe();
        if (response.exitCode === 0 && response.state === 'ready' && alive(response.pid)) return response;
      } catch {}
      const record = await readRecord(options.stateDirectory);
      return { exitCode: 0, state: record && record.state !== 'stopped' ? 'failed' : 'stopped',
        pid: record && alive(record.pid) ? record.pid : null, mainPath: record?.mainPath ?? null,
        stopReason: record?.stopReason ?? null, reasonKnown: record?.stopReason != null };
    } catch (error) { return failure('Cannot inspect service state', error); }
  };
  const start = async (): Promise<ServiceStatus | ServiceFailure> => {
    let lockOwned = false;
    let child: ReturnType<typeof spawn> | undefined;
    const token = randomUUID();
    const lock = join(options.stateDirectory, 'service-start.lock');
    try {
      await fs.mkdir(options.stateDirectory, { recursive: true });
      const deadline = Date.now() + options.readinessTimeoutMs;
      while (!lockOwned) {
        const current = await status();
        if (current.exitCode === 0 && current.state === 'ready') return current;
        const candidate = join(options.stateDirectory, `start.${token}.tmp`);
        await fs.writeFile(candidate, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
        try { await fs.link(candidate, lock); lockOwned = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
          if (!alive(owner.pid)) await fs.unlink(lock).catch(() => {});
        } finally { await fs.unlink(candidate).catch(() => {}); }
        if (!lockOwned) {
          if (Date.now() >= deadline) throw new Error('Timed out waiting for the service startup owner');
          await pause(25);
        }
      }
      const existing = await status();
      if (existing.exitCode === 0 && existing.state === 'ready') return existing;
      const previous = await readRecord(options.stateDirectory);
      if (previous && alive(previous.pid) && previous.state !== 'stopped') throw new Error(`Recorded service PID ${previous.pid} is alive but readiness failed; refusing to replace its socket`);
      const mainPath = await dependencies.resolveMainPath();
      if (!mainPath) throw new Error('Configured raf main checkout is missing');
      const root = resolve(mainPath);
      await fs.realpath(root);
      const branch = (() => { try { return execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })();
      if (branch !== 'main' && !await dependencies.validateMainSnapshot?.(root)) throw new Error(`Configured raf main checkout is on branch ${branch || '(detached)'}, expected main`);
      const entry = resolve(root, options.entryRelativePath);
      if (!entry.startsWith(root + '/')) throw new Error('Service entry must be within the configured main checkout');
      await fs.access(entry);
      try {
        const stat = await fs.lstat(options.socketPath);
        if (!stat.isSocket() || !previous || alive(previous.pid)) throw new Error('Socket exists without verified dead service ownership');
        await fs.unlink(options.socketPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const log = await fs.open(join(options.stateDirectory, 'service.log'), 'a', 0o600);
      try {
        child = (dependencies.spawn ?? spawn)(dependencies.nodeExecutable ?? process.execPath, [entry], {
          cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, RAF_STATE_DIRECTORY: options.stateDirectory, RAF_SOCKET_PATH: options.socketPath, RAF_MAIN_PATH: root },
        });
      } finally { await log.close(); }
      let childError: Error | undefined;
      child.on('error', error => { childError = error; });
      child.unref();
      while (Date.now() < deadline) {
        if (childError) throw childError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Service exited before readiness: code=${child.exitCode}, signal=${child.signalCode}`);
        try {
          const result = await probe();
          if (result.exitCode === 0 && result.state === 'ready' && result.pid === child.pid) return result;
        } catch {}
        await pause(25);
      }
      throw new Error(`Service PID ${child.pid} did not complete recovery and readiness within ${options.readinessTimeoutMs} ms`);
    } catch (error) {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const running = child;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { running.kill('SIGKILL'); resolve(); }, options.readinessTimeoutMs);
          running.once('exit', () => { clearTimeout(timer); resolve(); });
          running.kill('SIGTERM');
        });
      }
      const log = await fs.readFile(join(options.stateDirectory, 'service.log'), 'utf8').catch(() => '');
      const persisted = await readRecord(options.stateDirectory).catch(() => null);
      if (persisted?.stopReason) error = `${error instanceof Error ? error.message : error}\n${persisted.stopReason}`;
      if (child?.pid && persisted?.pid === child.pid) {
        await writeRecord(options.stateDirectory, { ...persisted, state: 'failed', stopReason: error instanceof Error ? error.message : String(error) }).catch(() => {});
      }
      return failure('Service startup failed', `${error instanceof Error ? error.message : error}${log ? '\n' + log.slice(-8192) : ''}`);
    } finally {
      if (lockOwned) {
        const owner = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null);
        if (owner?.token === token) await fs.unlink(lock).catch(() => {});
      }
    }
  };
  return {
    start, ensureReady: start, status,
    stop: async () => {
      const current = await status();
      if (current.exitCode !== 0 || current.state !== 'ready') return current;
      try { return await exchange(options.socketPath, { kind: 'stop' }, options.readinessTimeoutMs); }
      catch (error) { return failure('Service stop failed', error); }
    },
    request: async (request, requestOptions) => {
      if (requestOptions?.signal?.aborted) return failure('Service request cancelled', 'The caller aborted the request');
      const ready = await start();
      if (ready.exitCode !== 0) return ready;
      try { return await exchange(options.socketPath, { kind: 'request', request }, undefined, requestOptions?.signal); }
      catch (error) { return failure('Service request failed', error); }
    },
  };
}

export async function runServiceHost(options: ServiceHostOptions): Promise<{
  close: () => Promise<void>;
  closed: Promise<void>;
}> {
  await fs.mkdir(options.stateDirectory, { recursive: true });
  const record: RecordState = { pid: process.pid, token: randomUUID(), mainPath: process.env.RAF_MAIN_PATH ?? process.cwd(), state: 'starting', stopReason: null };
  const sockets = new Set<Socket>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let closing: Promise<void> | undefined;
  const serviceStatus = (): ServiceStatus => ({ exitCode: 0, state: record.state === 'ready' ? 'ready' : record.state === 'stopped' ? 'stopped' : 'failed', pid: record.state === 'ready' ? process.pid : null, mainPath: record.mainPath, stopReason: record.stopReason, reasonKnown: record.stopReason !== null });
  const server = createServer(socket => {
    sockets.add(socket);
    const controller = new AbortController();
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); controller.abort(); });
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
        if (message.kind === 'status') socket.end(JSON.stringify(serviceStatus()) + '\n');
        else if (message.kind === 'stop') {
          await shutdown(false, socket);
          socket.end(JSON.stringify(serviceStatus()) + '\n');
        } else if (message.kind === 'request' && record.state === 'ready') {
          const value = await options.handlers.handle(message.request, { signal: controller.signal, clientId: randomUUID() });
          if (!controller.signal.aborted) socket.end(JSON.stringify({ exitCode: 0, value }) + '\n');
        } else socket.end(JSON.stringify(failure('Service not ready', record.state)) + '\n');
      })().catch(error => { if (!socket.destroyed) socket.end(JSON.stringify(failure('Service operation failed', error)) + '\n'); });
    });
  });
  const shutdown = (failed = false, replySocket?: Socket): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      process.off('exit', onExit);
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      server.close();
      for (const socket of sockets) if (socket !== replySocket) socket.destroy();
      try {
        await options.handlers.shutdown();
        record.state = failed ? 'failed' : 'stopped';
        record.stopReason ??= failed ? 'Service failed' : 'Service stopped normally';
      } catch (error) { record.state = 'failed'; record.stopReason = String(error); }
      await writeRecord(options.stateDirectory, record);
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
    await Promise.race([options.handlers.recover(), closed.then(() => { throw new Error('Service stopped during recovery'); })]);
    record.state = 'ready';
    await writeRecord(options.stateDirectory, record);
    server.on('error', error => { record.stopReason = String(error); void shutdown(true); });
    return { close: () => shutdown(), closed };
  } catch (error) {
    if (server.listening) { record.stopReason = String(error); await shutdown(true); }
    throw error;
  }
}
