export type AdmissionSnapshot = {
  status: 'ANY_RUN' | 'HOTFIX_ONLY' | 'NO_RESOURCES' | 'UNKNOWN';
  reason: string;
};

export type ResourceWaitResult =
  | { exitCode: 0; kind: 'permit'; requestId: string; level: string; grantedAt: number; reservation: false }
  | { exitCode: 1; kind: 'error'; requestId: string; reason: string; details: string; remediation: string };

export type ResourceWaitOptions = {
  grantIntervalMs: number;
  levels: readonly { id: string; priority: number }[];
};

export type ResourceWaitDependencies = {
  now: () => number;
  readSnapshot: () => Promise<AdmissionSnapshot>;
  isClientAlive: (clientId: string) => boolean;
  watchResources: (wake: () => Promise<void>) => () => void;
  schedule: (at: number, wake: () => Promise<void>) => () => void;
  loadLastGrant: () => number | null;
  saveLastGrant: (at: number) => void;
};

export type ResourceWaitQueue = {
  enqueue: (request: { clientId: string; level?: string; signal?: AbortSignal }) => {
    id: string;
    result: Promise<ResourceWaitResult>;
  };
  pump: () => Promise<void>;
  cancel: (requestId: string, reason: string) => void;
  inspect: () => { pending: readonly string[]; lastGrantedAt: number | null };
  close: (reason: string) => void;
};

export function createResourceWaitQueue(
  options: ResourceWaitOptions,
  dependencies: ResourceWaitDependencies,
): ResourceWaitQueue {
  type Entry = {
    id: string;
    clientId: string;
    level: string;
    priority: number;
    sequence: number;
    signal?: AbortSignal;
    detach: () => void;
    resolve: (result: ResourceWaitResult) => void;
  };
  const pending = new Map<string, Entry>();
  const levels = new Map(options.levels.map(level => [level.id, level.priority]));
  let sequence = 0;
  let lastGrantedAt: number | null = null;
  let closed: string | null = null;
  let startupError: string | null = null;
  let unwatch: (() => void) | undefined;
  let unschedule: (() => void) | undefined;
  let scheduledAt: number | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;
  const details = (error: unknown) => error instanceof Error ? error.message : String(error);
  const fail = (entry: Entry, reason: string, message: string, remediation = 'Retry resource wait after correcting the reported problem.') => {
    pending.delete(entry.id);
    entry.detach();
    entry.resolve({ exitCode: 1, kind: 'error', requestId: entry.id, reason, details: message, remediation });
  };
  const clearTimer = () => {
    const stop = unschedule;
    unschedule = undefined;
    scheduledAt = undefined;
    stop?.();
  };
  const ordered = () => [...pending.values()].sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  const prune = () => {
    for (const entry of pending.values()) {
      if (entry.signal?.aborted) fail(entry, 'cancelled', 'The waiting request was aborted.');
      else if (!dependencies.isClientAlive(entry.clientId)) fail(entry, 'client_lost', 'The waiting client is no longer alive.');
    }
    if (!pending.size) clearTimer();
  };
  const step = async () => {
    if (closed) return;
    prune();
    if (!pending.size) return;
    const now = dependencies.now();
    if (!Number.isFinite(now)) throw new Error('The service clock is unavailable.');
    if (lastGrantedAt !== null && now < lastGrantedAt + options.grantIntervalMs) {
      const at = lastGrantedAt + options.grantIntervalMs;
      if (scheduledAt !== at) {
        clearTimer();
        scheduledAt = at;
        unschedule = dependencies.schedule(at, async () => {
          clearTimer();
          await pump();
        });
      }
      return;
    }
    clearTimer();
    const snapshot = await dependencies.readSnapshot();
    if (closed) return;
    prune();
    if (!pending.size) return;
    if (snapshot.status === 'UNKNOWN' || !['ANY_RUN', 'HOTFIX_ONLY', 'NO_RESOURCES'].includes(snapshot.status)) {
      throw new Error(snapshot.reason || 'Resource measurements are unavailable.');
    }
    if (snapshot.status === 'NO_RESOURCES') return;
    const entry = ordered().find(candidate => snapshot.status === 'ANY_RUN' || candidate.level === 'hotfix');
    if (!entry) return;
    const grantedAt = dependencies.now();
    if (!Number.isFinite(grantedAt)) throw new Error('The service clock is unavailable.');
    if (lastGrantedAt !== null && grantedAt < lastGrantedAt + options.grantIntervalMs) {
      dirty = true;
      return;
    }
    if (entry.signal?.aborted || !dependencies.isClientAlive(entry.clientId)) {
      fail(entry, 'cancelled', 'The waiting client ended before admission.');
      dirty = true;
      return;
    }
    dependencies.saveLastGrant(grantedAt);
    lastGrantedAt = grantedAt;
    pending.delete(entry.id);
    entry.detach();
    entry.resolve({ exitCode: 0, kind: 'permit', requestId: entry.id, level: entry.level, grantedAt, reservation: false });
    if (pending.size) dirty = true;
  };
  function pump(): Promise<void> {
    if (closed) return Promise.resolve();
    dirty = true;
    if (!running) {
      running = Promise.resolve().then(async () => {
        while (dirty && !closed) {
          dirty = false;
          try {
            await step();
          } catch (error) {
            clearTimer();
            for (const entry of pending.values()) fail(entry, 'resource_error', details(error));
          }
        }
      }).finally(() => {
        running = undefined;
        if (dirty && !closed) void pump();
      });
    }
    return running;
  }
  try {
    if (!Number.isFinite(options.grantIntervalMs) || options.grantIntervalMs <= 0) throw new Error('grantIntervalMs must be a positive finite interval.');
    lastGrantedAt = dependencies.loadLastGrant();
    if (lastGrantedAt !== null && !Number.isFinite(lastGrantedAt)) throw new Error('The persisted grant time is invalid.');
    unwatch = dependencies.watchResources(pump);
  } catch (error) {
    startupError = details(error);
  }
  return {
    enqueue(request) {
      const id = `resource-wait-${++sequence}`;
      let resolve!: (result: ResourceWaitResult) => void;
      const result = new Promise<ResourceWaitResult>(settle => { resolve = settle; });
      const entry: Entry = {
        id, clientId: request.clientId, level: request.level ?? '', priority: levels.get(request.level ?? '') ?? Infinity,
        sequence, signal: request.signal, detach: () => {}, resolve,
      };
      if (!request.level || !levels.has(request.level)) {
        fail(entry, 'invalid_level', `Allowed levels: ${[...levels.keys()].join(', ')}.`, `Example: raf resource wait --level ${options.levels[0]?.id ?? 'normal'}`);
      } else if (closed || startupError) {
        fail(entry, 'unavailable', closed ?? startupError!);
      } else if (request.signal?.aborted) {
        fail(entry, 'cancelled', 'The waiting request was aborted.');
      } else {
        pending.set(id, entry);
        const abort = () => {
          if (pending.has(id)) fail(entry, 'cancelled', 'The waiting request was aborted.');
          void pump();
        };
        request.signal?.addEventListener('abort', abort, { once: true });
        entry.detach = () => request.signal?.removeEventListener('abort', abort);
        void pump();
      }
      return { id, result };
    },
    pump,
    cancel(requestId, reason) {
      const entry = pending.get(requestId);
      if (entry) fail(entry, 'cancelled', reason);
      void pump();
    },
    inspect: () => ({ pending: ordered().map(entry => entry.id), lastGrantedAt }),
    close(reason) {
      if (closed !== null) return;
      closed = reason || 'Resource wait service closed.';
      clearTimer();
      unwatch?.();
      unwatch = undefined;
      for (const entry of pending.values()) fail(entry, 'closed', closed);
    },
  };
}
