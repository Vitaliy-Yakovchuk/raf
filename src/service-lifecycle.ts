import type { BackgroundRuntime, BackgroundRuntimeOptions, ServiceFailure, ServiceRequest, ServiceResponse, ServiceStatus } from './background-runtime.ts';
import type { ResourceWaitIdentity } from './resource-wait-protocol.ts';
import type { DeliveryReceipt, MessageRequest, VerifiedSender } from './agent-control.ts';
import type { MainNotifier } from './bug-sync.ts';

export type ServiceLifecycleRecord = {
  pid: number;
  identity: ResourceWaitIdentity;
  serviceEpoch: string;
  mainPath: string;
  state: 'starting' | 'ready' | 'stopped' | 'failed';
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

  constructor(options: BackgroundRuntimeOptions, ports: ServiceLifecyclePorts) {
    this.options = options;
    this.ports = ports;
  }

  async start(): Promise<ServiceStatus | ServiceFailure> {
    throw new Error('NotImplemented: ServiceLifecycleController.start');
  }

  async ensureReady(options?: { signal?: AbortSignal }): Promise<ServiceStatus | ServiceFailure> {
    throw new Error('NotImplemented: ServiceLifecycleController.ensureReady');
  }

  async status(): Promise<ServiceStatus | ServiceFailure> {
    throw new Error('NotImplemented: ServiceLifecycleController.status');
  }

  async stop(): Promise<ServiceStatus | ServiceFailure> {
    throw new Error('NotImplemented: ServiceLifecycleController.stop');
  }

  async request(request: ServiceRequest, options?: { signal?: AbortSignal }): Promise<ServiceResponse> {
    throw new Error('NotImplemented: ServiceLifecycleController.request');
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

  constructor(ports: ServiceProducerPorts) {
    this.ports = ports;
  }

  async recover(bootstrap: { serviceEpoch: string }): Promise<void> {
    throw new Error('NotImplemented: ServiceProducerRuntime.recover');
  }

  async shutdown(): Promise<void> {
    throw new Error('NotImplemented: ServiceProducerRuntime.shutdown');
  }

  async notifyMain(text: string): Promise<DeliveryReceipt> {
    throw new Error('NotImplemented: ServiceProducerRuntime.notifyMain');
  }
}
