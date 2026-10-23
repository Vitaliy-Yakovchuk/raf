import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { AdmissionSnapshot } from '../../src/resource-wait.ts';
import type {
  ResourceWaitIdentity, ResourceWaitLastGrant, ResourceWaitOffer,
  ResourceWaitPending, ResourceWaitProbeSnapshot, ResourceWaitProtocolOptions,
  ResourceWaitProtocolPorts, ResourceWaitWireResult, ResourceWaitDiagnostic,
  ResourceWaitTicket, ResourceWaitClientObservation,
} from '../../src/resource-wait-protocol.ts';

const constants = JSON.parse(readFileSync(new URL('../../../conf/raf-constants.json', import.meta.url), 'utf8'));
const raf = JSON.parse(readFileSync(new URL('../../../conf/raf.json', import.meta.url), 'utf8'));

export function configuration() {
  return structuredClone({ constants, raf });
}

export function options(overrides: Partial<ResourceWaitProtocolOptions> = {}): ResourceWaitProtocolOptions {
  return {
    levels: constants.resourceWaitLevels,
    grantIntervalMs: raf.resourceWait.grantIntervalMs,
    hostTickIntervalMs: raf.service.hostTickIntervalMs,
    deliveryTimeoutMs: raf.resourceWait.deliveryTimeoutMs,
    readinessTimeoutMs: raf.service.readinessTimeoutMs,
    ...overrides,
  };
}

export function identity(pid = 101): ResourceWaitIdentity {
  return { pid, startedAt: `start-${pid}`, machineId: 'fixture-machine', bootId: 'fixture-boot' };
}

export function request(pid = 101, level: string | undefined = 'normal', signal?: AbortSignal) {
  return { clientIdentity: identity(pid), connectionId: `connection-${pid}`, developmentDirectory: `/fixture/project-${pid}`, level, signal };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

export class ManualClock {
  monotonic = 0;
  wall = 1_000_000;
  timers = new Map<number, { at: number; wake: () => Promise<void> }>();
  nextTimer = 0;
  schedule = (at: number, wake: () => Promise<void>) => {
    const id = ++this.nextTimer;
    this.timers.set(id, { at, wake });
    return () => { this.timers.delete(id); };
  };
  async advanceTo(target: number): Promise<void> {
    let wakes = 0;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      if (++wakes > 200) throw new Error('fixture detected busy loop');
      this.monotonic = Math.max(this.monotonic, due[1].at);
      this.timers.delete(due[0]);
      await due[1].wake();
    }
    this.monotonic = target;
  }
}

export class ProtocolEnvironment {
  clock = new ManualClock();
  ownerEpoch = 'epoch-1';
  boot = 'fixture-boot';
  row: ResourceWaitLastGrant | null = null;
  commits: ResourceWaitLastGrant[] = [];
  offers: { connectionId: string; offer: ResourceWaitOffer }[] = [];
  results: { connectionId: string; result: ResourceWaitWireResult }[] = [];
  errors: { connectionId: string; ticket: ResourceWaitTicket; diagnostic: ResourceWaitDiagnostic }[] = [];
  observations = new Map<number, ResourceWaitClientObservation>();
  disconnected = new Set<string>();
  admission: AdmissionSnapshot = { status: 'ANY_RUN', reason: 'fixture available' };
  probes = 0;
  probing = 0;
  maxProbing = 0;
  commitsInFlight = 0;
  maxCommitsInFlight = 0;
  nextId = 0;
  readFailure: Error | null = null;
  commitOutcome: 'committed' | 'not-committed' | 'unknown' = 'committed';
  unknownCommitWrites = false;
  failFinalDelivery = false;
  onProbe: ((requests: readonly ResourceWaitPending[]) => Promise<ResourceWaitProbeSnapshot>) | null = null;
  onObserve: ((client: ResourceWaitIdentity) => Promise<ResourceWaitClientObservation>) | null = null;
  onCommit: (() => Promise<void>) | null = null;
  ports: ResourceWaitProtocolPorts = {
    monotonicNow: () => this.clock.monotonic,
    wallNow: () => this.clock.wall,
    bootIdentity: () => this.boot,
    nextId: () => `nonce-${++this.nextId}`,
    schedule: (at, wake) => this.clock.schedule(at, wake),
    readSnapshot: async requests => {
      this.probes++;
      this.maxProbing = Math.max(this.maxProbing, ++this.probing);
      try {
        return this.onProbe ? await this.onProbe(requests) : { observedAt: this.clock.monotonic, data: { ...this.admission } };
      } finally { this.probing--; }
    },
    evaluateSnapshot: snapshot => snapshot.data as AdmissionSnapshot,
    observeClient: async client => this.onObserve ? this.onObserve(client) : this.observations.get(client.pid) ?? { state: 'alive', identity: { ...client } },
    isConnectionOpen: connectionId => !this.disconnected.has(connectionId),
    sendOffer: async (connectionId, offer) => { this.offers.push({ connectionId, offer: { ...offer } }); },
    sendResult: async (connectionId, result) => {
      if (this.failFinalDelivery) throw new Error('fixture final channel closed');
      this.results.push({ connectionId, result: structuredClone(result) });
    },
    sendError: async (connectionId, ticket, diagnostic) => { this.errors.push({ connectionId, ticket, diagnostic }); },
    loadLastGrant: async () => {
      if (this.readFailure) throw this.readFailure;
      return this.row ? structuredClone(this.row) : null;
    },
    commitLastGrant: async change => {
      this.maxCommitsInFlight = Math.max(this.maxCommitsInFlight, ++this.commitsInFlight);
      try {
        await this.onCommit?.();
        if (change.expectedEpoch !== this.ownerEpoch || !isDeepStrictEqual(change.previous, this.row)) return 'not-committed';
        if (this.commitOutcome === 'committed' || this.unknownCommitWrites) {
          this.row = structuredClone(change.next);
          this.commits.push(structuredClone(change.next));
        }
        return this.commitOutcome;
      } finally { this.commitsInFlight--; }
    },
  };
}
