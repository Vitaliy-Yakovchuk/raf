import type { AdmissionSnapshot } from './resource-wait.ts';
import type { ResourceReservation } from './resource-admission.ts';

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
  workload?: 'test' | 'agent';
  requested?: ResourceReservation;
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
  | { kind: 'waiting'; admission: AdmissionSnapshot }
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
  observeClients?: (identities: readonly ResourceWaitIdentity[]) => Promise<ResourceWaitClientObservation[]>;
  isConnectionOpen: (connectionId: string) => boolean;
  sendOffer: (connectionId: string, offer: ResourceWaitOffer) => Promise<void>;
  sendResult: (connectionId: string, result: ResourceWaitWireResult) => Promise<void>;
  sendError: (connectionId: string, ticket: ResourceWaitTicket, diagnostic: ResourceWaitDiagnostic) => Promise<void>;
  sendWaiting?: (connectionId: string, frame: { requestId: string; serviceEpoch: string; admission: AdmissionSnapshot }) => Promise<void>;
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

const diagnostic = (reason: string, details: string, received: unknown = null, expected: unknown = null): ResourceWaitDiagnostic => ({
  reason, details, remediation: 'Correct the reported service, identity or resource problem, then start a new resource wait.',
  received, expected, completed: [], pending: ['confirmed resource permit'],
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const sameIdentity = (a: ResourceWaitIdentity, b: ResourceWaitIdentity) =>
  a.pid === b.pid && a.startedAt === b.startedAt && a.machineId === b.machineId && a.bootId === b.bootId;
const validIdentity = (value: ResourceWaitIdentity) => value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
  (['startedAt', 'machineId', 'bootId'] as const).every(key => typeof value[key] === 'string' && value[key].trim());
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

export class ResourceWaitProtocolService implements ResourceWaitProtocol {
  private options: ResourceWaitProtocolOptions;
  private ports: ResourceWaitProtocolPorts;
  private pending = new Map<string, ResourceWaitPending>();
  private detach = new Map<string, () => void>();
  private epoch = '';
  private sequence = 0;
  private lastGrant: ResourceWaitLastGrant | null = null;
  private lastIdentity: ResourceWaitIdentity | null = null;
  private nextGrantAt = -Infinity;
  private stopped = true;
  private timer?: () => void;
  private running?: Promise<void>;
  private dirty = false;
  private cache: ResourceWaitProbeSnapshot | null = null;
  private cacheDirectories = new Set<string>();
  private warnedOffers = new Set<string>();

  constructor(options: ResourceWaitProtocolOptions, ports: ResourceWaitProtocolPorts) {
    if (![options.grantIntervalMs, options.hostTickIntervalMs, options.deliveryTimeoutMs, options.readinessTimeoutMs].every(positive) ||
        !Array.isArray(options.levels) || !options.levels.length || options.levels.some(level => !level.id?.trim() || !Number.isFinite(level.priority)) ||
        new Set(options.levels.map(level => level.id)).size !== options.levels.length) throw new Error('Invalid resource wait configuration');
    this.options = options;
    this.ports = ports;
  }

  async start(serviceEpoch: string): Promise<void> {
    if (!this.stopped || !serviceEpoch) throw new Error('Resource wait requires a new service epoch');
    const grant = await this.ports.loadLastGrant();
    if (grant && (!grant.requestId || !grant.serviceEpoch || !grant.bootIdentity || !Number.isFinite(grant.grantedAt) || !Number.isFinite(grant.monotonicAt))) throw new Error('Invalid persisted resource wait lastGrant');
    this.epoch = serviceEpoch;
    this.lastGrant = grant;
    this.lastIdentity = null;
    this.sequence = 0;
    this.cache = null;
    this.cacheDirectories.clear();
    this.nextGrantAt = grant ? this.ports.monotonicNow() + this.options.grantIntervalMs : -Infinity;
    this.stopped = false;
  }

  private ordered() {
    const priorities = new Map(this.options.levels.map(level => [level.id, level.priority]));
    return [...this.pending.values()].sort((a, b) => priorities.get(a.level!)! - priorities.get(b.level!)! || Number(a.workload !== 'test') - Number(b.workload !== 'test') || a.sequence - b.sequence);
  }

  private remove(entry: ResourceWaitPending) {
    this.pending.delete(entry.requestId);
    if (entry.offer) this.warnedOffers.delete(entry.offer.offerId);
    this.detach.get(entry.requestId)?.();
    this.detach.delete(entry.requestId);
    if (!this.pending.size) { this.timer?.(); this.timer = undefined; this.cache = null; }
  }

  private async reportWaiting(admission: AdmissionSnapshot) {
    for (const item of this.ordered()) {
      if (item.phase !== 'waiting' || !this.current(item)) continue;
      await this.ports.sendWaiting?.(item.connectionId, { requestId: item.requestId, serviceEpoch: item.serviceEpoch, admission });
    }
  }

  private async fail(entry: ResourceWaitPending, reason: string, details: string) {
    this.remove(entry);
    await this.ports.sendError(entry.connectionId, entry, diagnostic(reason, details)).catch(() => {});
  }

  private current(entry: ResourceWaitPending, offer?: ResourceWaitOffer) {
    return !this.stopped && this.pending.get(entry.requestId) === entry && entry.serviceEpoch === this.epoch &&
      !entry.signal?.aborted && this.ports.isConnectionOpen(entry.connectionId) &&
      (!offer || entry.offer?.offerId === offer.offerId && entry.offer.deadline === offer.deadline && offer.serviceEpoch === this.epoch);
  }

  private arm() {
    this.timer?.(); this.timer = undefined;
    if (this.stopped || !this.pending.size) return;
    const now = this.ports.monotonicNow();
    let at = now + this.options.hostTickIntervalMs;
    if (this.nextGrantAt > now) at = Math.min(at, this.nextGrantAt);
    for (const entry of this.pending.values()) if (entry.offer && entry.offer.deadline > now) at = Math.min(at, entry.offer.deadline);
    this.timer = this.ports.schedule(at, async () => { this.timer = undefined; await this.pump(); });
  }

  enqueue(request: ResourceWaitRequest): ResourceWaitTicket {
    const ticket = { requestId: this.ports.nextId(), serviceEpoch: this.epoch };
    if (this.stopped) throw new Error('Resource wait service is not ready');
    if (!this.options.levels.some(level => level.id === request.level)) throw new Error(`Invalid resource wait level; allowed: ${this.options.levels.map(level => level.id).join(', ')}`);
    if (request.workload !== undefined && request.workload !== 'agent' && request.workload !== 'test') throw new Error('Invalid resource wait workload');
    if (!validIdentity(request.clientIdentity) || !request.connectionId || !request.developmentDirectory) throw new Error('Missing resource wait client identity or development directory');
    const entry: ResourceWaitPending = { ...request, ...ticket, sequence: ++this.sequence, phase: 'waiting', offer: null };
    this.pending.set(ticket.requestId, entry);
    const abort = () => { void this.cancel(ticket, request.clientIdentity, 'Client cancelled'); };
    request.signal?.addEventListener('abort', abort, { once: true });
    this.detach.set(ticket.requestId, () => request.signal?.removeEventListener('abort', abort));
    const head = this.ordered()[0];
    for (const previous of this.pending.values()) if (previous !== head && previous.offer) { previous.offer = null; previous.phase = 'waiting'; }
    if (request.signal?.aborted) abort();
    void this.pump();
    return ticket;
  }

  private async live(entry: ResourceWaitPending, observed?: ResourceWaitClientObservation) {
    if (!this.current(entry)) { if (this.pending.has(entry.requestId)) await this.fail(entry, 'client_lost', 'Client connection closed or request cancelled'); return false; }
    const observation = observed ?? await this.ports.observeClient(entry.clientIdentity);
    if (!this.current(entry)) return false;
    if (observation.state !== 'alive' || !sameIdentity(observation.identity, entry.clientIdentity)) {
      await this.fail(entry, observation.state === 'unknown' ? 'identity_unknown' : 'client_lost', observation.state === 'alive' ? 'Client PID was reused' : observation.reason);
      return false;
    }
    return true;
  }

  private async snapshot() {
    const now = this.ports.monotonicNow();
    const requests = this.ordered();
    if (!this.cache || now < this.cache.observedAt || now - this.cache.observedAt >= this.options.hostTickIntervalMs || requests.some(request => !this.cacheDirectories.has(request.developmentDirectory))) {
      this.cache = await this.ports.readSnapshot(requests);
      this.cacheDirectories = new Set(requests.map(request => request.developmentDirectory));
      if (this.ordered().some(request => !this.cacheDirectories.has(request.developmentDirectory))) return this.snapshot();
    }
    const age = this.ports.monotonicNow() - this.cache.observedAt;
    if (!Number.isFinite(age) || age < 0 || age > this.options.hostTickIntervalMs) throw new Error('Stale resource snapshot cannot authorize a permit');
    return this.cache;
  }

  private async step() {
    const entries = [...this.pending.values()];
    const observations = entries.length ? await this.ports.observeClients?.(entries.map(entry => entry.clientIdentity)) : undefined;
    if (observations && observations.length !== entries.length) throw new Error('Client identity scan does not match the pending queue');
    for (const [index, entry] of entries.entries()) {
      if (!await this.live(entry, observations?.[index])) continue;
      if (entry.offer && this.ports.monotonicNow() >= entry.offer.deadline && !this.warnedOffers.has(entry.offer.offerId)) { this.warnedOffers.add(entry.offer.offerId); process.stderr.write(`Warning: resource wait client ${entry.requestId} has not completed offer delivery after ${this.options.deliveryTimeoutMs} ms; waiting\n`); }
    }
    if (this.stopped || !this.pending.size) return;
    if (this.ports.monotonicNow() < this.nextGrantAt) return;
    const snapshot = await this.snapshot();
    if (this.stopped) return;
    const entry = this.ordered()[0];
    if (!entry || !this.current(entry)) return;
    const admission = this.ports.evaluateSnapshot(snapshot, entry);
    if (admission.status === 'UNKNOWN' || !['ANY_RUN', 'HOTFIX_ONLY', 'NO_RESOURCES'].includes(admission.status)) { await this.fail(entry, 'resource_unknown', admission.reason); this.dirty = true; return; }
    if (admission.status === 'NO_RESOURCES' || admission.status === 'HOTFIX_ONLY' && entry.level !== 'hotfix') { await this.reportWaiting(admission); return; }
    if (entry.phase === 'waiting') {
      const offer = { requestId: entry.requestId, serviceEpoch: this.epoch, offerId: this.ports.nextId(), deadline: this.ports.monotonicNow() + this.options.deliveryTimeoutMs };
      entry.offer = offer; entry.phase = 'offered';
      void this.ports.sendOffer(entry.connectionId, offer).catch(async error => { if (this.current(entry, offer)) { await this.fail(entry, 'delivery_failed', message(error)); void this.pump(); } });
      return;
    }
    if (entry.phase !== 'client-ready' || !entry.offer) { await this.reportWaiting(admission); return; }
    const offer = entry.offer;
    if (!await this.live(entry) || !this.current(entry, offer) || this.ordered()[0] !== entry) return;
    const currentSnapshot = await this.snapshot();
    if (!this.current(entry, offer) || this.ordered()[0] !== entry) return;
    const final = this.ports.evaluateSnapshot(currentSnapshot, entry);
    if (final.status === 'UNKNOWN') { await this.fail(entry, 'resource_unknown', final.reason); return; }
    if (final.status !== 'ANY_RUN' && !(final.status === 'HOTFIX_ONLY' && entry.level === 'hotfix')) { entry.phase = 'waiting'; entry.offer = null; await this.reportWaiting(final); return; }
    const now = this.ports.monotonicNow();
    if (now < this.nextGrantAt) return;
    const next: ResourceWaitLastGrant = { requestId: entry.requestId, serviceEpoch: this.epoch, grantedAt: this.ports.wallNow(), bootIdentity: this.ports.bootIdentity(), monotonicAt: now };
    const outcome = await this.ports.commitLastGrant({ expectedEpoch: this.epoch, previous: this.lastGrant, next });
    if (outcome !== 'committed') {
      if (outcome === 'unknown') { await this.stop('Grant commit outcome unknown; reconcile durable lastGrant before restarting'); }
      else { await this.fail(entry, 'commit_failed', 'Resource grant transaction was not committed (including service fence mismatch)'); }
      return;
    }
    this.lastGrant = next;
    this.lastIdentity = entry.clientIdentity;
    this.nextGrantAt = this.ports.monotonicNow() + this.options.grantIntervalMs;
    this.remove(entry);
    void this.ports.sendResult(entry.connectionId, { ...offer, kind: 'permit', permit: { requestId: next.requestId, serviceEpoch: next.serviceEpoch, grantedAt: next.grantedAt } }).catch(() => {});
    this.dirty = true;
  }

  pump(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    if (!this.running) this.running = Promise.resolve().then(async () => {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        try { await this.step(); }
        catch (error) { for (const entry of [...this.pending.values()]) await this.fail(entry, 'resource_error', message(error)); }
      }
    }).finally(() => { this.running = undefined; this.arm(); if (this.dirty && !this.stopped) void this.pump(); });
    return this.running;
  }

  async ready(offer: ResourceWaitOffer, clientIdentity: ResourceWaitIdentity): Promise<'issued' | 'already-issued' | 'ignored' | 'error'> {
    if (this.lastGrant?.requestId === offer.requestId && this.lastGrant.serviceEpoch === offer.serviceEpoch && this.lastIdentity && sameIdentity(this.lastIdentity, clientIdentity)) return 'already-issued';
    const entry = this.pending.get(offer.requestId);
    if (!entry || !this.current(entry, offer) || !sameIdentity(entry.clientIdentity, clientIdentity)) return 'ignored';
    const duplicate = entry.phase === 'client-ready';
    entry.phase = 'client-ready';
    await this.pump();
    return this.lastGrant?.requestId === offer.requestId ? duplicate ? 'already-issued' : 'issued' : 'ignored';
  }

  async cancel(ticket: ResourceWaitTicket, clientIdentity: ResourceWaitIdentity, reason: string): Promise<'cancelled' | 'already-issued' | 'ignored'> {
    if (this.lastGrant?.requestId === ticket.requestId && this.lastGrant.serviceEpoch === ticket.serviceEpoch && this.lastIdentity && sameIdentity(this.lastIdentity, clientIdentity)) return 'already-issued';
    const entry = this.pending.get(ticket.requestId);
    if (!entry || entry.serviceEpoch !== ticket.serviceEpoch || !sameIdentity(entry.clientIdentity, clientIdentity)) return 'ignored';
    await this.fail(entry, 'cancelled', reason);
    void this.pump();
    return 'cancelled';
  }

  async disconnect(connectionId: string): Promise<void> {
    for (const entry of [...this.pending.values()]) if (entry.connectionId === connectionId) await this.fail(entry, 'client_lost', 'Client connection closed');
    void this.pump();
  }

  async stop(reason: string): Promise<void> {
    this.stopped = true; this.timer?.(); this.timer = undefined; this.cache = null;
    await Promise.all([...this.pending.values()].map(entry => this.fail(entry, 'service_stopped', reason)));
  }

  inspect(): ReturnType<ResourceWaitProtocol['inspect']> {
    return { pending: this.ordered().map(entry => ({ ...entry })), lastGrant: this.lastGrant && { ...this.lastGrant }, stopped: this.stopped };
  }
}

export function readResourceWaitProtocolOptions(configuration: { constants: unknown; raf: unknown }): ResourceWaitProtocolOptions {
  const constants = configuration.constants as { resourceWaitLevels?: ResourceWaitProtocolOptions['levels'] };
  const raf = configuration.raf as { resourceWait?: { grantIntervalMs?: number; deliveryTimeoutMs?: number }; service?: { hostTickIntervalMs?: number; readinessTimeoutMs?: number } };
  const options = { levels: constants?.resourceWaitLevels, grantIntervalMs: raf?.resourceWait?.grantIntervalMs, deliveryTimeoutMs: raf?.resourceWait?.deliveryTimeoutMs, hostTickIntervalMs: raf?.service?.hostTickIntervalMs, readinessTimeoutMs: raf?.service?.readinessTimeoutMs };
  for (const key of ['grantIntervalMs', 'deliveryTimeoutMs', 'hostTickIntervalMs', 'readinessTimeoutMs'] as const) if (!positive(options[key])) throw new Error(`Invalid configured resource wait ${key}`);
  if (!Array.isArray(options.levels) || !options.levels.length || options.levels.some(level => !level.id?.trim() || !Number.isFinite(level.priority)) || new Set(options.levels.map(level => level.id)).size !== options.levels.length) throw new Error('Invalid resourceWaitLevels catalog');
  return options as ResourceWaitProtocolOptions;
}

export function createResourceWaitProtocol(options: ResourceWaitProtocolOptions, ports: ResourceWaitProtocolPorts): ResourceWaitProtocol {
  return new ResourceWaitProtocolService(options, ports);
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
  private options: Pick<ResourceWaitProtocolOptions, 'readinessTimeoutMs'>;
  private ports: ResourceWaitStarterPorts;
  constructor(options: Pick<ResourceWaitProtocolOptions, 'readinessTimeoutMs'>, ports: ResourceWaitStarterPorts) {
    if (!positive(options.readinessTimeoutMs)) throw new Error('Invalid readinessTimeoutMs');
    this.options = options; this.ports = ports;
  }

  async ensureReady(): Promise<ResourceWaitEndpoint> {
    const deadline = this.ports.monotonicNow() + this.options.readinessTimeoutMs;
    let last: ResourceWaitHandshake | undefined;
    let started = false;
    let warned = false;
    for (;;) {
      last = await this.ports.handshake();
      if (!warned && this.ports.monotonicNow() >= deadline) { warned = true; process.stderr.write(`Warning: resource service readiness still pending after ${this.options.readinessTimeoutMs} ms; waiting\n`); }
      if (last.kind === 'ready' && last.ownsFence && last.stateValidated && last.acceptsEnqueue && last.endpoint?.endpoint && last.endpoint.serviceEpoch) return last.endpoint;
      const lease = started ? null : await this.ports.acquireStartLease();
      if (lease) {
        try {
          const current = await this.ports.handshake();
          if (current.kind === 'ready' && current.ownsFence && current.stateValidated && current.acceptsEnqueue && current.endpoint?.endpoint && current.endpoint.serviceEpoch) return current.endpoint;
          started = true;
          await this.ports.startMain();
        } finally { await lease.release(); }
      }
      await this.ports.waitForChange(Math.max(deadline, this.ports.monotonicNow() + this.options.readinessTimeoutMs));
    }
  }
}

export function createResourceWaitServiceConnector(options: Pick<ResourceWaitProtocolOptions, 'readinessTimeoutMs'>, ports: ResourceWaitStarterPorts): ResourceWaitServiceConnector {
  return new ResourceWaitServiceStarter(options, ports);
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
  ensureReady: (signal?: AbortSignal) => Promise<ResourceWaitEndpoint>;
  connect: (endpoint: ResourceWaitEndpoint) => Promise<ResourceWaitClientConnection>;
  recordDuration: (elapsedMs: number) => void;
  watchService?: (endpoint: ResourceWaitEndpoint, signal: AbortSignal) => Promise<ResourceWaitEndpoint>;
  refreshEndpoint?: (signal?: AbortSignal) => Promise<ResourceWaitEndpoint | null>;
};

export async function runResourceWaitCommand(
  request: ResourceWaitRequest,
  options: Pick<ResourceWaitProtocolOptions, 'levels'>,
  ports: ResourceWaitCommandPorts,
): Promise<ResourceWaitCommandResult> {
  if (!options.levels.some(level => level.id === request.level)) return { exitCode: 1, kind: 'error', diagnostic: diagnostic('invalid_level', `Allowed levels: ${options.levels.map(level => level.id).join(', ')}. Example: raf resource wait --level ${options.levels[0]?.id}`, request.level, options.levels) };
  let connection: ResourceWaitClientConnection | undefined;
  let ticket: ResourceWaitTicket | undefined;
  let ready = false;
  let aborted = false;
  let onAbort: (() => void) | undefined;
  try {
    if (request.signal?.aborted) throw new Error('Resource wait cancelled');
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { aborted = true; if (ticket) void connection!.cancel(ticket).catch(() => {}); reject(new Error('Resource wait cancelled')); };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
    });
    let endpoint = await Promise.race([ports.ensureReady(request.signal), cancelled]);
    for (;;) {
      const watching = new AbortController();
      const changed = ports.watchService?.(endpoint, watching.signal).then(endpoint => ({ kind: 'service-changed' as const, endpoint }));
      let retired = false;
      try {
        const connected = await Promise.race([
          ports.connect(endpoint).then(async value => {
            if (aborted || retired) await value.close();
            return { kind: 'connection' as const, value };
          }), cancelled, ...(changed ? [changed] : []),
        ]);
        if (connected.kind === 'service-changed') { endpoint = connected.endpoint; continue; }
        const selected = connected.value;
        connection = selected;
        const enqueued = await Promise.race([
          selected.enqueue(request).then(value => {
            if (aborted) void selected.cancel(value).catch(() => {});
            return { kind: 'ticket' as const, value };
          }), cancelled, ...(changed ? [changed] : []),
        ]);
        if (enqueued.kind === 'service-changed') { endpoint = enqueued.endpoint; continue; }
        ticket = enqueued.value;
        if (ticket.serviceEpoch !== endpoint.serviceEpoch || !ticket.requestId) throw new Error('Resource wait enqueue returned a mismatched epoch or requestId');
        let lastOffer: ResourceWaitOffer | undefined;
        for (;;) {
          const incoming = await Promise.race([selected.receive(), cancelled, ...(!ready && changed ? [changed] : [])]);
          if (incoming.kind === 'service-changed') {
            endpoint = incoming.endpoint;
            break;
          }
          if (incoming.kind === 'closed') {
            if (ready) throw new Error(incoming.reason);
            endpoint = changed ? (await Promise.race([changed, cancelled])).endpoint
              : await Promise.race([ports.ensureReady(request.signal), cancelled]);
            break;
          }
          const envelope = incoming.kind === 'offer' ? incoming.offer : incoming.result;
          if (envelope.requestId !== ticket.requestId || envelope.serviceEpoch !== ticket.serviceEpoch) continue;
          if (incoming.kind === 'result' && incoming.result.kind === 'waiting') {
            process.stderr.write(JSON.stringify({ kind: 'resource-wait.waiting', requestId: ticket.requestId, serviceEpoch: ticket.serviceEpoch, admission: incoming.result.admission }) + '\n');
            continue;
          }
          if (incoming.kind === 'offer') {
            lastOffer = incoming.offer;
            if (aborted) throw new Error('Resource wait cancelled');
            ready = true;
            watching.abort();
            await Promise.race([selected.sendReady(incoming.offer), cancelled]);
          } else {
            if (incoming.result.kind === 'error') {
              if (!ready && incoming.result.diagnostic.reason === 'service_stopped') {
                if (changed) {
                  endpoint = (await Promise.race([changed, cancelled])).endpoint;
                  break;
                }
                const replacement = ports.refreshEndpoint ? await Promise.race([ports.refreshEndpoint(request.signal), cancelled]) : null;
                if (replacement && replacement.serviceEpoch !== endpoint.serviceEpoch) { endpoint = replacement; break; }
              }
              return { exitCode: 1, kind: 'error', diagnostic: incoming.result.diagnostic };
            }
            if (!ready || !lastOffer || incoming.result.offerId !== lastOffer.offerId || incoming.result.permit.requestId !== ticket.requestId || incoming.result.permit.serviceEpoch !== ticket.serviceEpoch) continue;
            return { exitCode: 0, kind: 'permit', permit: incoming.result.permit, reservation: false };
          }
        }
      } finally {
        retired = true;
        watching.abort();
        void changed?.catch(() => {});
        await connection?.close().catch(() => {});
        connection = undefined;
      }
      ticket = undefined;
    }
  } catch (error) {
    const failure = diagnostic(ready ? 'delivery_unknown' : 'resource_wait_failed', `${message(error)}${ready ? '; permit delivery is unconfirmed and may have committed; no automatic retry' : ''}`, ticket ?? message(error), 'matching committed permit');
    if (ticket) failure.completed = ready ? ['enqueue', 'ready sent'] : ['enqueue'];
    return { exitCode: 1, kind: 'error', diagnostic: (error as { diagnostic?: ResourceWaitDiagnostic })?.diagnostic ?? failure };
  } finally {
    if (onAbort) request.signal?.removeEventListener('abort', onAbort);
    await connection?.close().catch(() => {});
  }
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
  const waited = await ports.wait();
  if (waited.kind === 'error') return { kind: 'error', diagnostic: waited.diagnostic };
  return { kind: 'attempted', permit: waited.permit, admission: await ports.admitAndReserve() };
}
