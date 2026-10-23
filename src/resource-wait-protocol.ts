import type { AdmissionSnapshot } from './resource-wait.ts';

export type ResourceWaitIdentity = {
  pid: number;
  startedAt: string;
  machineId: string;
  bootId: string;
};

export type ResourceWaitProtocolOptions = {
  levels: readonly { id: string; priority: number }[];
  grantIntervalMs: number;
  hostTickIntervalMs: number;
  deliveryTimeoutMs: number;
  readinessTimeoutMs: number;
};

export type ResourceWaitRequest = {
  level?: string;
  clientIdentity: ResourceWaitIdentity;
  connectionId: string;
  developmentDirectory: string;
  signal?: AbortSignal;
};

export type ResourceWaitTicket = { requestId: string; serviceEpoch: string };
export type ResourceWaitOffer = ResourceWaitTicket & { offerId: string; deadline: number };
export type ResourceWaitPermit = ResourceWaitTicket & { grantedAt: number };
export type ResourceWaitLastGrant = ResourceWaitPermit & { bootIdentity: string; monotonicAt: number };
export type ResourceWaitDiagnostic = {
  reason: string;
  details: string;
  remediation: string;
  received: unknown;
  expected: unknown;
  completed: readonly string[];
  pending: readonly string[];
};
export type ResourceWaitWireResult = ResourceWaitOffer & (
  | { kind: 'permit'; permit: ResourceWaitPermit }
  | { kind: 'error'; diagnostic: ResourceWaitDiagnostic }
);
export type ResourceWaitClientObservation =
  | { state: 'alive'; identity: ResourceWaitIdentity }
  | { state: 'dead' | 'unknown'; reason: string };
export type ResourceWaitPending = ResourceWaitRequest & ResourceWaitTicket & {
  sequence: number;
  phase: 'waiting' | 'offered' | 'client-ready';
  offer: ResourceWaitOffer | null;
};
export type ResourceWaitProbeSnapshot = { observedAt: number; data: unknown };
export type ResourceWaitProtocolPorts = {
  monotonicNow: () => number;
  wallNow: () => number;
  bootIdentity: () => string;
  nextId: () => string;
  schedule: (at: number, wake: () => Promise<void>) => () => void;
  readSnapshot: (requests: readonly ResourceWaitPending[]) => Promise<ResourceWaitProbeSnapshot>;
  evaluateSnapshot: (snapshot: ResourceWaitProbeSnapshot, request: ResourceWaitPending) => AdmissionSnapshot;
  observeClient: (identity: ResourceWaitIdentity) => Promise<ResourceWaitClientObservation>;
  isConnectionOpen: (connectionId: string) => boolean;
  sendOffer: (connectionId: string, offer: ResourceWaitOffer) => Promise<void>;
  sendResult: (connectionId: string, result: ResourceWaitWireResult) => Promise<void>;
  sendError: (connectionId: string, ticket: ResourceWaitTicket, diagnostic: ResourceWaitDiagnostic) => Promise<void>;
  loadLastGrant: () => Promise<ResourceWaitLastGrant | null>;
  commitLastGrant: (change: {
    expectedEpoch: string;
    previous: ResourceWaitLastGrant | null;
    next: ResourceWaitLastGrant;
  }) => Promise<'committed' | 'not-committed' | 'unknown'>;
};
export type ResourceWaitProtocol = {
  start: (serviceEpoch: string) => Promise<void>;
  enqueue: (request: ResourceWaitRequest) => ResourceWaitTicket;
  pump: () => Promise<void>;
  ready: (offer: ResourceWaitOffer, clientIdentity: ResourceWaitIdentity) => Promise<'issued' | 'already-issued' | 'ignored' | 'error'>;
  cancel: (ticket: ResourceWaitTicket, clientIdentity: ResourceWaitIdentity, reason: string) => Promise<'cancelled' | 'already-issued' | 'ignored'>;
  disconnect: (connectionId: string) => Promise<void>;
  stop: (reason: string) => Promise<void>;
  inspect: () => {
    pending: readonly ResourceWaitPending[];
    lastGrant: ResourceWaitLastGrant | null;
    stopped: boolean;
  };
};

export class ResourceWaitProtocolService implements ResourceWaitProtocol {
  constructor(options: ResourceWaitProtocolOptions, ports: ResourceWaitProtocolPorts) {
    throw new Error('NotImplemented');
  }

  async start(serviceEpoch: string): Promise<void> {
    throw new Error('NotImplemented');
  }

  enqueue(request: ResourceWaitRequest): ResourceWaitTicket {
    throw new Error('NotImplemented');
  }

  async pump(): Promise<void> {
    throw new Error('NotImplemented');
  }

  async ready(offer: ResourceWaitOffer, clientIdentity: ResourceWaitIdentity): Promise<'issued' | 'already-issued' | 'ignored' | 'error'> {
    throw new Error('NotImplemented');
  }

  async cancel(ticket: ResourceWaitTicket, clientIdentity: ResourceWaitIdentity, reason: string): Promise<'cancelled' | 'already-issued' | 'ignored'> {
    throw new Error('NotImplemented');
  }

  async disconnect(connectionId: string): Promise<void> {
    throw new Error('NotImplemented');
  }

  async stop(reason: string): Promise<void> {
    throw new Error('NotImplemented');
  }

  inspect(): ReturnType<ResourceWaitProtocol['inspect']> {
    throw new Error('NotImplemented');
  }
}

export function readResourceWaitProtocolOptions(configuration: {
  constants: unknown;
  raf: unknown;
}): ResourceWaitProtocolOptions {
  throw new Error('NotImplemented');
}

export function createResourceWaitProtocol(
  options: ResourceWaitProtocolOptions,
  ports: ResourceWaitProtocolPorts,
): ResourceWaitProtocol {
  throw new Error('NotImplemented');
}

export type ResourceWaitEndpoint = { endpoint: string; serviceEpoch: string };
export type ResourceWaitHandshake =
  | { kind: 'ready'; endpoint: ResourceWaitEndpoint; ownsFence: true; stateValidated: true; acceptsEnqueue: true }
  | { kind: 'unavailable'; reason: string; received: unknown; expected: unknown };
export type ResourceWaitStarterPorts = {
  monotonicNow: () => number;
  handshake: () => Promise<ResourceWaitHandshake>;
  acquireStartLease: () => Promise<{ release: () => Promise<void> } | null>;
  startMain: () => Promise<void>;
  waitForChange: (deadline: number) => Promise<void>;
};
export type ResourceWaitServiceConnector = { ensureReady: () => Promise<ResourceWaitEndpoint> };

export class ResourceWaitServiceStarter implements ResourceWaitServiceConnector {
  constructor(options: Pick<ResourceWaitProtocolOptions, 'readinessTimeoutMs'>, ports: ResourceWaitStarterPorts) {
    throw new Error('NotImplemented');
  }

  async ensureReady(): Promise<ResourceWaitEndpoint> {
    throw new Error('NotImplemented');
  }
}

export function createResourceWaitServiceConnector(
  options: Pick<ResourceWaitProtocolOptions, 'readinessTimeoutMs'>,
  ports: ResourceWaitStarterPorts,
): ResourceWaitServiceConnector {
  throw new Error('NotImplemented');
}

export type ResourceWaitCommandResult =
  | { exitCode: 0; kind: 'permit'; permit: ResourceWaitPermit; reservation: false }
  | { exitCode: 1; kind: 'error'; diagnostic: ResourceWaitDiagnostic };
export type ResourceWaitClientConnection = {
  enqueue: (request: ResourceWaitRequest) => Promise<ResourceWaitTicket>;
  receive: () => Promise<
    | { kind: 'offer'; offer: ResourceWaitOffer }
    | { kind: 'result'; result: ResourceWaitWireResult }
    | { kind: 'closed'; reason: string }
  >;
  sendReady: (offer: ResourceWaitOffer) => Promise<void>;
  cancel: (ticket: ResourceWaitTicket) => Promise<void>;
  close: () => Promise<void>;
};
export type ResourceWaitCommandPorts = {
  ensureReady: () => Promise<ResourceWaitEndpoint>;
  connect: (endpoint: ResourceWaitEndpoint) => Promise<ResourceWaitClientConnection>;
  recordDuration: (elapsedMs: number) => void;
};

export async function runResourceWaitCommand(
  request: ResourceWaitRequest,
  options: Pick<ResourceWaitProtocolOptions, 'levels'>,
  ports: ResourceWaitCommandPorts,
): Promise<ResourceWaitCommandResult> {
  throw new Error('NotImplemented');
}

export type ResourceWaitAdmissionAttempt =
  | { admitted: true; reservationId: string }
  | { admitted: false; reason: string };

export async function admitAgentRunAfterResourceWait(ports: {
  wait: () => Promise<ResourceWaitCommandResult>;
  admitAndReserve: () => Promise<ResourceWaitAdmissionAttempt>;
}): Promise<
  | { kind: 'attempted'; permit: ResourceWaitPermit; admission: ResourceWaitAdmissionAttempt }
  | { kind: 'error'; diagnostic: ResourceWaitDiagnostic }
> {
  throw new Error('NotImplemented');
}
