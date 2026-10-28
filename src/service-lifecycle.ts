import type { BackgroundRuntime, BackgroundRuntimeOptions, ServiceFailure, ServiceRequest, ServiceResponse, ServiceStatus } from './background-runtime.ts';
import type { ResourceWaitIdentity } from './resource-wait-protocol.ts';
import type { DeliveryReceipt, MessageRequest, VerifiedSender } from './agent-control.ts';
import type { MainNotifier } from './bug-sync.ts';
import { isAbsolute, resolve } from 'node:path';

const failure = (reason: string, error: unknown): ServiceFailure => ({
  exitCode: 1, reason, details: error instanceof Error ? error.message : String(error),
  remediation: 'Inspect the current service owner, configured main generation and service.log before retrying.',
});
const sameIdentity = (a: ResourceWaitIdentity, b: ResourceWaitIdentity) =>
  a.pid === b.pid && a.startedAt === b.startedAt && a.machineId === b.machineId && a.bootId === b.bootId;

export type ServiceLifecycleRecord = {
  pid: number;
  identity: ResourceWaitIdentity;
  serviceEpoch: string;
  mainPath: string;
  state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
  stopReason: string | null;
};

export type ServiceReadiness = {
  pid: number;
  identity: ResourceWaitIdentity;
  serviceEpoch: string;
  mainPath: string;
  exclusiveOwner: boolean;
  databaseOpen: boolean;
  lastGrantLoaded: boolean;
  resourceWaitReady: boolean;
};

export type ServiceLifecyclePorts = {
  now: () => number;
  exclusive: <T>(deadline: number, operation: () => Promise<T>) => Promise<T>;
  readRecord: () => Promise<ServiceLifecycleRecord | null>;
  observe: (identity: ResourceWaitIdentity) => Promise<'alive' | 'dead' | 'unknown'>;
  resolveMainPath: (signal?: AbortSignal) => Promise<string>;
  validateMainSnapshot: (root: string) => Promise<boolean>;
  entryExists: (entry: string) => Promise<boolean>;
  spawn: (input: { entry: string; cwd: string; mainPath: string; deadline: number }) => Promise<ResourceWaitIdentity>;
  handshake: (deadline: number, signal?: AbortSignal) => Promise<ServiceReadiness | null>;
  waitForChange: (deadline: number, signal?: AbortSignal) => Promise<void>;
  shutdown: (owner: ServiceLifecycleRecord, deadline: number) => Promise<{ acknowledged: boolean }>;
  awaitShutdown: (owner: ServiceLifecycleRecord, deadline: number) => Promise<boolean>;
  exchange: (request: ServiceRequest, serviceEpoch: string, signal?: AbortSignal) => Promise<ServiceResponse>;
};

export class ServiceLifecycleController implements BackgroundRuntime {
  readonly options: BackgroundRuntimeOptions;
  readonly ports: ServiceLifecyclePorts;
  private stoppingOwner?: ServiceLifecycleRecord;

  constructor(options: BackgroundRuntimeOptions, ports: ServiceLifecyclePorts) {
    this.options = options;
    this.ports = ports;
  }

  async start(): Promise<ServiceStatus | ServiceFailure> {
    return this.ensureReady();
  }

  async ensureReady(options?: { signal?: AbortSignal }): Promise<ServiceStatus | ServiceFailure> {
    const deadline = this.ports.now() + this.options.readinessTimeoutMs;
    const signal = options?.signal;
    try {
      this.checkDeadline(deadline, signal);
      return await this.within(deadline, signal, () => this.ports.exclusive(deadline, async () => {
        this.checkDeadline(deadline, signal);
        const previous = await this.ports.readRecord();
        if (previous) {
          const observation = await this.ports.observe(previous.identity);
          if (observation === 'unknown') {
            if (previous.state !== 'stopped') throw new Error('Service owner identity is unknown');
          } else if (observation === 'alive') {
            if (!this.isStopping(previous)) {
              const ready = await this.ready(previous, deadline, signal);
              if (ready) return ready;
            }
            const latest = await this.ports.readRecord();
            const stopping = this.isStopping(previous) || (latest !== null && sameIdentity(latest.identity, previous.identity) && this.isStopping(latest));
            if (!stopping) throw new Error('Existing service owner is alive without verified readiness');
            if (!await this.ports.awaitShutdown(previous, deadline)) throw new Error('Previous service owner did not finish shutting down');
          }
        }
        this.checkDeadline(deadline, signal);
        const mainPath = await this.ports.resolveMainPath(signal);
        if (!mainPath || !isAbsolute(mainPath) || !await this.ports.validateMainSnapshot(mainPath)) throw new Error('Configured main generation is missing or unverified');
        const entry = resolve(mainPath, this.options.entryRelativePath);
        if (isAbsolute(this.options.entryRelativePath) || !entry.startsWith(resolve(mainPath) + '/') || !await this.ports.entryExists(entry)) throw new Error('Service entry is missing or outside the main generation');
        this.checkDeadline(deadline, signal);
        const owner = await this.ports.spawn({ entry, cwd: mainPath, mainPath, deadline });
        this.stoppingOwner = undefined;
        for (;;) {
          this.checkDeadline(deadline, signal);
          const record = await this.ports.readRecord();
          if (record && sameIdentity(record.identity, owner)) {
            if (record.state === 'failed' || record.state === 'stopped' || record.state === 'stopping') throw new Error(record.stopReason ?? 'Service stopped before readiness');
            if (record.mainPath !== mainPath) throw new Error('Service mainPath differs from spawned generation');
            const ready = await this.ready(record, deadline, signal);
            if (ready) return ready;
          }
          const observation = await this.ports.observe(owner);
          if (observation !== 'alive') throw new Error(`Service owner is ${observation} before readiness`);
          await this.ports.waitForChange(deadline, signal);
        }
      }));
    } catch (error) { return failure('Service startup failed', error); }
  }

  async status(): Promise<ServiceStatus | ServiceFailure> {
    try {
      const record = await this.ports.readRecord();
      if (!record) return this.snapshot(null, 'stopped');
      if (record.state === 'stopped') return this.snapshot(record, 'stopped');
      const observation = await this.ports.observe(record.identity);
      if (observation === 'alive') {
        const ready = await this.ready(record, this.ports.now() + this.options.readinessTimeoutMs);
        if (ready) return ready;
      }
      return this.snapshot(record, 'failed', observation === 'alive' ? record.pid : null);
    } catch (error) { return failure('Cannot inspect service state', error); }
  }

  async stop(): Promise<ServiceStatus | ServiceFailure> {
    const deadline = this.ports.now() + this.options.readinessTimeoutMs;
    try {
      const owner = await this.ports.readRecord();
      if (!owner) return this.snapshot(null, 'stopped');
      if (owner.state === 'stopped') {
        if (await this.ports.observe(owner.identity) === 'alive' && !await this.ports.awaitShutdown(owner, deadline)) throw new Error('Service shutdown is not confirmed');
        return this.snapshot(owner, 'stopped');
      }
      const observation = await this.ports.observe(owner.identity);
      if (observation === 'dead') return this.snapshot(owner, 'failed');
      const stopping = this.isStopping(owner);
      const starting = owner.state === 'starting' && Boolean(owner.serviceEpoch) && owner.pid === owner.identity.pid;
      if (observation !== 'alive' || (!stopping && !starting && !await this.ready(owner, deadline))) throw new Error('Cannot verify current service owner for shutdown');
      this.checkDeadline(deadline);
      if (!stopping) {
        this.stoppingOwner = owner;
        const receipt = await this.ports.shutdown(owner, deadline);
        if (!receipt.acknowledged) throw new Error('Service shutdown is not confirmed');
      }
      if (!await this.ports.awaitShutdown(owner, deadline)) throw new Error('Service shutdown is not confirmed');
      this.checkDeadline(deadline);
      const record = await this.ports.readRecord();
      if (!record || record.serviceEpoch !== owner.serviceEpoch || !sameIdentity(record.identity, owner.identity) || !['stopped', 'failed'].includes(record.state)) throw new Error('Shutdown record does not confirm the current service epoch');
      return this.snapshot(record, record.state as 'stopped' | 'failed');
    } catch (error) { return failure('Service stop failed', error); }
  }

  private isStopping(record: ServiceLifecycleRecord | null): boolean {
    if (!record) return false;
    if (record.state === 'stopping' || record.state === 'stopped') return true;
    return this.stoppingOwner !== undefined && sameIdentity(this.stoppingOwner.identity, record.identity) && this.stoppingOwner.serviceEpoch === record.serviceEpoch;
  }

  async request(request: ServiceRequest, options?: { signal?: AbortSignal }): Promise<ServiceResponse> {
    const ready = await this.ensureReady(options);
    if (ready.exitCode !== 0) return ready;
    try {
      if (!ready.serviceEpoch || options?.signal?.aborted) throw new Error('Service request cancelled or epoch unavailable');
      return await this.ports.exchange(request, ready.serviceEpoch, options?.signal);
    } catch (error) { return failure('Service request failed', error); }
  }

  private checkDeadline(deadline: number, signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Service readiness cancelled');
    if (this.ports.now() >= deadline) throw new Error('Service readiness deadline exhausted');
  }

  private async within<T>(deadline: number, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    this.checkDeadline(deadline, signal);
    return new Promise<T>((resolve, reject) => {
      const abort = () => finish(new Error('Service readiness cancelled'));
      const timer = setTimeout(() => finish(new Error('Service readiness deadline exhausted')), Math.max(1, deadline - this.ports.now()));
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value as T);
      };
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(operation).then(value => {
        try { this.checkDeadline(deadline, signal); finish(undefined, value); } catch (error) { finish(error); }
      }, error => finish(error));
      if (signal?.aborted) abort();
    });
  }

  private snapshot(record: ServiceLifecycleRecord | null, state: ServiceStatus['state'], pid: number | null = null): ServiceStatus {
    return { exitCode: 0, state, pid, mainPath: record?.mainPath ?? null,
      stopReason: record?.stopReason ?? null, reasonKnown: record?.stopReason != null,
      ...(state === 'ready' && record ? { serviceEpoch: record.serviceEpoch, resourceWaitReady: true } : {}) };
  }

  private async ready(record: ServiceLifecycleRecord, deadline: number, signal?: AbortSignal): Promise<ServiceStatus | null> {
    if (record.state !== 'ready' || !record.serviceEpoch || record.pid !== record.identity.pid) return null;
    const handshake = await this.ports.handshake(deadline, signal);
    this.checkDeadline(deadline, signal);
    if (!handshake || handshake.serviceEpoch !== record.serviceEpoch || handshake.pid !== record.pid ||
        handshake.mainPath !== record.mainPath || !sameIdentity(handshake.identity, record.identity) ||
        !handshake.exclusiveOwner || !handshake.databaseOpen || !handshake.lastGrantLoaded || !handshake.resourceWaitReady ||
        await this.ports.observe(record.identity) !== 'alive') return null;
    return this.snapshot(record, 'ready', record.pid);
  }
}

export type SharedSystemDelivery = (request: MessageRequest, sender: VerifiedSender) => Promise<DeliveryReceipt>;

export type ServiceProducerPorts = {
  sharedDelivery?: SharedSystemDelivery;
  bugSync: { start: (notifier: MainNotifier) => Promise<void>; stop: () => Promise<void> };
  resourceWait: { start: (serviceEpoch: string) => Promise<void>; stop: () => Promise<void> };
};

export class ServiceProducerRuntime {
  readonly ports: ServiceProducerPorts;
  private recovery?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(ports: ServiceProducerPorts) {
    this.ports = ports;
  }

  async recover(bootstrap: { serviceEpoch: string; signal?: AbortSignal }): Promise<void> {
    if (this.stopping || bootstrap.signal?.aborted) throw new Error('Service producers are stopped');
    if (!this.recovery) this.recovery = (async () => {
      if (!bootstrap.serviceEpoch) throw new Error('Service epoch is required');
      await this.ports.resourceWait.start(bootstrap.serviceEpoch);
      if (this.stopping || bootstrap.signal?.aborted) {
        await this.ports.resourceWait.stop();
        return;
      }
      try {
        await this.ports.bugSync.start({ notify: async notice => {
          const text = notice.kind === 'new-bug' ? `New bug ${notice.bugKey}` : `New human comment ${notice.commentId} on ${notice.bugKey}`;
          const receipt = await this.notifyMain(text);
          if (!receipt.accepted) throw new Error(receipt.reason);
        } });
        if (this.stopping || bootstrap.signal?.aborted) {
          await this.ports.bugSync.stop();
          await this.ports.resourceWait.stop();
        }
      } catch (error) { await this.ports.resourceWait.stop(); throw error; }
    })();
    return this.recovery;
  }

  async shutdown(): Promise<void> {
    if (!this.stopping) this.stopping = (async () => {
      try { await this.ports.bugSync.stop(); } finally { await this.ports.resourceWait.stop(); }
    })();
    return this.stopping;
  }

  async notifyMain(text: string): Promise<DeliveryReceipt> {
    if (!this.ports.sharedDelivery) return { accepted: false, reason: 'Shared main delivery transport is unavailable or unverified' };
    try {
      const receipt = await this.ports.sharedDelivery({ to: 'main', text }, { kind: 'system' });
      if (!receipt || typeof receipt.accepted !== 'boolean' || receipt.accepted && !receipt.receiptId) return { accepted: false, reason: 'Shared delivery did not confirm acceptance' };
      return receipt;
    }
    catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
}
