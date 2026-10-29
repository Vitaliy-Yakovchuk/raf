import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitAgentRunAfterResourceWait, createResourceWaitServiceConnector, runResourceWaitCommand,
  type ResourceWaitCommandPorts, type ResourceWaitCommandResult, type ResourceWaitClientConnection,
  type ResourceWaitHandshake, type ResourceWaitStarterPorts,
  type ResourceWaitWireResult, type ResourceWaitOffer, type ResourceWaitDiagnostic,
} from '../src/resource-wait-protocol.ts';
import { configuration, deferred, ManualClock, options, request } from './helpers/resource-wait-protocol-fixture.ts';

const endpoint = { endpoint: 'fixture://shared-runtime/resource-wait', serviceEpoch: 'epoch-1' };
const ticket = { requestId: 'request-1', serviceEpoch: endpoint.serviceEpoch };
const offer: ResourceWaitOffer = { ...ticket, offerId: 'offer-1', deadline: 1000 };
const permit = { ...ticket, grantedAt: 2000 };
const diagnostic: ResourceWaitDiagnostic = {
  reason: 'fixture unavailable', details: 'resource wait fixture error', remediation: 'retry a separate wait',
  received: 'unavailable', expected: 'ready', completed: [], pending: ['permit'],
};
const success: ResourceWaitCommandResult = { exitCode: 0, kind: 'permit', permit, reservation: false };
const failure: ResourceWaitCommandResult = { exitCode: 1, kind: 'error', diagnostic };
const wireSuccess: ResourceWaitWireResult = { ...offer, kind: 'permit', permit };

class StarterEnvironment {
  clock = new ManualClock();
  locked = false;
  ready = false;
  starts = 0;
  handshakes = 0;
  releases = 0;
  deadlines: number[] = [];
  startFailure: Error | null = null;
  handshakeFailure = 'fixture socket missing';
  afterStart: (() => Promise<void>) | null = null;
  ports: ResourceWaitStarterPorts = {
    monotonicNow: () => this.clock.monotonic,
    handshake: async (): Promise<ResourceWaitHandshake> => {
      this.handshakes++;
      return this.ready
        ? { kind: 'ready', endpoint, ownsFence: true, stateValidated: true, acceptsEnqueue: true }
        : { kind: 'unavailable', reason: this.handshakeFailure, received: 'socket/PID only', expected: 'current fence and validated state and enqueue' };
    },
    acquireStartLease: async () => {
      if (this.locked) return null;
      this.locked = true;
      return { release: async () => { this.locked = false; this.releases++; } };
    },
    startMain: async () => {
      this.starts++;
      if (this.startFailure) throw this.startFailure;
      await this.afterStart?.();
    },
    waitForChange: async deadline => {
      this.deadlines.push(deadline);
      this.clock.monotonic = Math.min(deadline, this.clock.monotonic + 1);
    },
  };
}

class ClientEnvironment {
  ensureCalls = 0;
  connectCalls = 0;
  enqueueCalls = 0;
  readyCalls = 0;
  cancelCalls = 0;
  closeCalls = 0;
  emaWrites: number[] = [];
  events: string[] = [];
  readinessFailure: Error | null = null;
  messages: Awaited<ReturnType<ResourceWaitClientConnection['receive']>>[] = [
    { kind: 'offer', offer }, { kind: 'result', result: wireSuccess },
  ];
  beforeReceive: (() => Promise<void>) | null = null;
  connection: ResourceWaitClientConnection = {
    enqueue: async () => { this.enqueueCalls++; this.events.push('enqueue'); return ticket; },
    receive: async () => {
      await this.beforeReceive?.();
      const next = this.messages.shift();
      this.events.push(next?.kind ?? 'closed');
      return next ?? { kind: 'closed', reason: 'fixture EOF' };
    },
    sendReady: async () => { this.readyCalls++; this.events.push('ready'); },
    cancel: async () => { this.cancelCalls++; this.events.push('cancel'); },
    close: async () => { this.closeCalls++; this.events.push('close'); },
  };
  ports: ResourceWaitCommandPorts = {
    ensureReady: async () => {
      this.ensureCalls++;
      if (this.readinessFailure) throw this.readinessFailure;
      return endpoint;
    },
    connect: async selected => {
      assert.deepEqual(selected, endpoint);
      this.connectCalls++;
      return this.connection;
    },
    recordDuration: elapsed => { this.emaWrites.push(elapsed); },
  };
}

for (const level of [undefined, 'unknown']) {
  test(`[resource-wait/cli] ${String(level)} level fails with allowed values and example before service startup`, async () => {
    const env = new ClientEnvironment();
    const result = await runResourceWaitCommand({ ...request(), level }, options(), env.ports);
    assert.equal(result.exitCode, 1);
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') {
      const text = JSON.stringify(result.diagnostic);
      for (const allowed of options().levels) assert.ok(text.includes(allowed.id));
      assert.match(text, /resource wait.*--level/);
      assert.ok(result.diagnostic.remediation.trim());
    }
    assert.equal(env.ensureCalls, 0);
    assert.equal(env.connectCalls, 0);
    assert.equal(env.enqueueCalls, 0);
    assert.deepEqual(env.emaWrites, []);
  });
}

test('[resource-wait/readiness] concurrent independent connectors start one main service under a shared lease', async () => {
  const env = new StarterEnvironment();
  const started = deferred<void>();
  const release = deferred<void>();
  env.afterStart = async () => { started.resolve(); await release.promise; env.ready = true; };
  const connectors = Array.from({ length: 8 }, () => createResourceWaitServiceConnector(options(), env.ports));
  const waits = connectors.map(connector => connector.ensureReady());
  const completed = Promise.all(waits);
  await Promise.race([started.promise, completed]);
  assert.equal(env.starts, 1);
  assert.equal(env.ready, false);
  release.resolve();
  assert.deepEqual(await completed, connectors.map(() => endpoint));
  assert.equal(env.starts, 1);
  assert.equal(env.releases, 1);
});

test('[resource-wait/readiness] existing valid owner is reused without spawning', async () => {
  const env = new StarterEnvironment();
  env.ready = true;
  const connector = createResourceWaitServiceConnector(options(), env.ports);
  assert.deepEqual(await connector.ensureReady(), endpoint);
  assert.equal(env.starts, 0);
});

for (const observed of ['stale epoch', 'socket file only', 'PID only', 'spawn success without initialized SQLite']) {
  test(`[resource-wait/readiness] ${observed} becomes ready beyond the warning threshold`, async () => {
    const env = new StarterEnvironment();
    env.handshakeFailure = observed;
    const budget = 17;
    env.clock.monotonic = 500;
    const connector = createResourceWaitServiceConnector({ readinessTimeoutMs: budget }, env.ports);
    env.ports.waitForChange = async deadline => {
      env.deadlines.push(deadline);
      env.clock.monotonic++;
      if (env.clock.monotonic > 500 + budget) env.ready = true;
    };
    assert.deepEqual(await connector.ensureReady(), endpoint);
    assert.equal(env.starts, 1, 'waiting does not spawn another service');
    assert.ok(env.clock.monotonic > 500 + budget);
    assert.ok(env.deadlines.length > 1);
  });
}

test('[resource-wait/readiness] unknown live owner cannot be replaced by a second service', async () => {
  const env = new StarterEnvironment();
  env.locked = true;
  env.handshakeFailure = 'owner identity unavailable';
  const connector = createResourceWaitServiceConnector({ readinessTimeoutMs: 19 }, env.ports);
  env.ports.waitForChange = async () => { throw new Error('owner identity unavailable'); };
  await assert.rejects(connector.ensureReady(), /owner|identity/i);
  assert.equal(env.starts, 0);
  assert.equal(env.locked, true);
  assert.equal(env.releases, 0);
});

for (const cause of ['main entry unavailable', 'SQLite initialization failed']) {
  test(`[resource-wait/readiness] ${cause} is explicit and releases the startup lease`, async () => {
    const env = new StarterEnvironment();
    env.startFailure = new Error(cause);
    const connector = createResourceWaitServiceConnector(options(), env.ports);
    await assert.rejects(connector.ensureReady(), new RegExp(cause));
    assert.equal(env.starts, 1);
    assert.equal(env.releases, 1);
  });
}

test('[resource-wait/client] readiness failure never enqueues and carries useful diagnostics', async () => {
  const env = new ClientEnvironment();
  env.readinessFailure = new Error('main entry unavailable; expected validated endpoint');
  const result = await runResourceWaitCommand(request(), options(), env.ports);
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.diagnostic.reason + result.diagnostic.details, /main entry unavailable/);
    assert.ok(result.diagnostic.remediation.trim());
    assert.ok(result.diagnostic.expected);
    assert.ok(result.diagnostic.received);
  }
  assert.equal(env.connectCalls, 0);
  assert.equal(env.enqueueCalls, 0);
  assert.deepEqual(env.emaWrites, []);
});

test('[resource-wait/client] offer and ready are insufficient; only matching final commit result returns zero', async () => {
  const env = new ClientEnvironment();
  const offered = deferred<void>();
  const final = deferred<void>();
  let calls = 0;
  env.beforeReceive = async () => {
    if (++calls === 2) { offered.resolve(); await final.promise; }
  };
  let finished = false;
  const waiting = runResourceWaitCommand(request(), options(), env.ports).then(result => { finished = true; return result; });
  await Promise.race([offered.promise, waiting]);
  assert.equal(env.readyCalls, 1);
  assert.equal(finished, false);
  final.resolve();
  assert.deepEqual(await waiting, success);
  assert.deepEqual(env.events, ['enqueue', 'offer', 'ready', 'result', 'close']);
  assert.equal(env.closeCalls, 1);
  assert.deepEqual(env.emaWrites, []);
});

for (const mismatch of ['epoch', 'requestId', 'offerId'] as const) {
  test(`[resource-wait/client] mismatched final ${mismatch} cannot report success`, async () => {
    const env = new ClientEnvironment();
    const wrong = structuredClone(wireSuccess);
    if (mismatch === 'epoch') { wrong.serviceEpoch = 'stale-epoch'; if (wrong.kind === 'permit') wrong.permit.serviceEpoch = 'stale-epoch'; }
    else if (mismatch === 'requestId') { wrong.requestId = 'different-request'; if (wrong.kind === 'permit') wrong.permit.requestId = 'different-request'; }
    else wrong.offerId = 'different-offer';
    env.messages = [{ kind: 'offer', offer }, { kind: 'result', result: wrong }, { kind: 'closed', reason: 'fixture ended' }];
    const result = await runResourceWaitCommand(request(), options(), env.ports);
    assert.equal(result.exitCode, 1);
    assert.equal(env.connectCalls, 1);
    assert.equal(env.closeCalls, 1);
    assert.deepEqual(env.emaWrites, []);
  });
}

test('[resource-wait/client] loss after ready reports uncertain delivery without reconnect or another permit', async () => {
  const env = new ClientEnvironment();
  env.messages = [{ kind: 'offer', offer }, { kind: 'closed', reason: 'service crashed after ready' }];
  const result = await runResourceWaitCommand(request(), options(), env.ports);
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    const text = JSON.stringify(result.diagnostic);
    assert.match(text, /commit|закоміч|uncertain|невизнач/i);
    assert.ok(text.includes(ticket.requestId));
    assert.ok(text.includes(ticket.serviceEpoch));
    assert.ok(result.diagnostic.completed.length > 0);
    assert.ok(result.diagnostic.pending.length > 0);
    assert.ok(result.diagnostic.remediation.trim());
  }
  assert.equal(env.connectCalls, 1);
  assert.equal(env.enqueueCalls, 1);
  assert.equal(env.readyCalls, 1);
  assert.equal(env.closeCalls, 1);
  assert.deepEqual(env.emaWrites, []);
});

test('[resource-wait/client] timeout cancellation closes its channel and never updates EMA', async () => {
  const env = new ClientEnvironment();
  const controller = new AbortController();
  env.beforeReceive = async () => {
    controller.abort(new Error('fixture external timeout'));
  };
  env.messages = [{ kind: 'closed', reason: 'fixture external timeout' }];
  const result = await runResourceWaitCommand(request(101, 'normal', controller.signal), options(), env.ports);
  assert.equal(result.exitCode, 1);
  assert.equal(env.readyCalls, 0);
  assert.equal(env.cancelCalls, 1);
  assert.equal(env.closeCalls, 1);
  assert.deepEqual(env.emaWrites, []);
});

test('[resource-wait/timing] the canonical command excludes resource wait from duration accounting', () => {
  const conf = configuration();
  const command = conf.constants.commands.find((entry: { path: string[] }) => entry.path.join(' ') === 'resource wait');
  assert.ok(command);
  assert.equal(command.recordDuration, false);
  assert.equal(command.parameters.find((entry: { name: string }) => entry.name === 'level').required, true);
  assert.equal(command.valueSources.level, 'raf-constants.json#/resourceWaitLevels');
});

test('[resource-wait/timing] explicit service error never updates EMA', async () => {
  const env = new ClientEnvironment();
  env.messages = [{ kind: 'result', result: { ...offer, kind: 'error', diagnostic } }];
  const result = await runResourceWaitCommand(request(), options(), env.ports);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(env.emaWrites, []);
  assert.equal(env.closeCalls, 1);
});

test('[resource-wait/agent-run] a permit requires a fresh concrete admission and atomic reservation', async () => {
  const calls: string[] = [];
  const result = await admitAgentRunAfterResourceWait({
    wait: async () => { calls.push('permit'); return success; },
    admitAndReserve: async () => { calls.push('fresh-admission-and-reserve'); return { admitted: false, reason: 'resources fell after wait' }; },
  });
  assert.equal(result.kind, 'attempted');
  if (result.kind === 'attempted') assert.deepEqual(result.admission, { admitted: false, reason: 'resources fell after wait' });
  assert.deepEqual(calls, ['permit', 'fresh-admission-and-reserve']);
});

test('[resource-wait/agent-run] failed wait prevents the next launch as required by &&', async () => {
  let launches = 0;
  const result = await admitAgentRunAfterResourceWait({
    wait: async () => failure,
    admitAndReserve: async () => { launches++; return { admitted: true, reservationId: 'must-not-exist' }; },
  });
  assert.equal(result.kind, 'error');
  assert.equal(launches, 0);
});

test('[resource-wait/agent-run] repeat admission asks for a fresh permit rather than reusing a failed attempt', async () => {
  let waits = 0;
  let attempts = 0;
  const ports = {
    wait: async (): Promise<ResourceWaitCommandResult> => ({ ...success, permit: { ...permit, requestId: `fresh-permit-${++waits}` } }),
    admitAndReserve: async () => ++attempts === 1
      ? { admitted: false as const, reason: 'temporary shortage' }
      : { admitted: true as const, reservationId: 'atomic-reservation-1' },
  };
  const first = await admitAgentRunAfterResourceWait(ports);
  const second = await admitAgentRunAfterResourceWait(ports);
  assert.equal(first.kind, 'attempted');
  assert.equal(second.kind, 'attempted');
  if (first.kind === 'attempted' && second.kind === 'attempted') {
    assert.equal(first.admission.admitted, false);
    assert.equal(second.admission.admitted, true);
    assert.notEqual(first.permit.requestId, second.permit.requestId);
  }
  assert.equal(waits, 2);
  assert.equal(attempts, 2);
});

for (const interruption of ['closed', 'service-stopped', 'stale-open-channel'] as const) {
  test(`[resource-wait/client] queued request obtains a new epoch permit after ${interruption}`, async () => {
    const controller = new AbortController();
    const nextEndpoint = { ...endpoint, serviceEpoch: 'epoch-2' };
    const nextTicket = { requestId: 'request-2', serviceEpoch: nextEndpoint.serviceEpoch };
    const nextOffer = { ...nextTicket, offerId: 'offer-2', deadline: 3000 };
    const nextPermit = { ...nextTicket, grantedAt: 4000 };
    const events: string[] = [];
    const watching = deferred<void>();
    const changed = deferred<typeof endpoint>();
    let current = endpoint;
    let watches = 0;
    const ports: ResourceWaitCommandPorts & {
      watchService: (selected: typeof endpoint, signal: AbortSignal) => Promise<typeof endpoint>;
    } = {
      ensureReady: async () => current,
      watchService: async (selected, signal) => {
        watches++;
        if (selected.serviceEpoch === endpoint.serviceEpoch) { watching.resolve(); return changed.promise; }
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('watch stopped')), { once: true }));
      },
      connect: async selected => {
        const old = selected.serviceEpoch === endpoint.serviceEpoch;
        const frames: Awaited<ReturnType<ResourceWaitClientConnection['receive']>>[] = [
          { kind: 'offer', offer }, { kind: 'result', result: wireSuccess },
          { kind: 'offer', offer: nextOffer }, { kind: 'result', result: { ...nextOffer, kind: 'permit', permit: nextPermit } },
        ];
        return {
          enqueue: async input => {
            assert.equal(input.clientIdentity, controllerRequest.clientIdentity);
            assert.equal(input.workload, 'agent');
            events.push(`enqueue:${selected.serviceEpoch}`);
            return old ? ticket : nextTicket;
          },
          receive: async () => {
            if (!old) return frames.shift()!;
            current = nextEndpoint;
            if (interruption === 'stale-open-channel') return new Promise(() => {});
            changed.resolve(nextEndpoint);
            return interruption === 'closed' ? { kind: 'closed', reason: 'old service exited' }
              : { kind: 'result', result: { ...offer, kind: 'error', diagnostic: { ...diagnostic, reason: 'service_stopped' } } };
          },
          sendReady: async selectedOffer => { events.push(`ready:${selectedOffer.serviceEpoch}`); },
          cancel: async () => {},
          close: async () => { events.push(`close:${selected.serviceEpoch}`); },
        };
      },
      recordDuration: () => {},
    };
    const controllerRequest = { ...request(101, 'normal', controller.signal), workload: 'agent' as const };
    const waiting = runResourceWaitCommand(controllerRequest, options(), ports);
    try {
      if (interruption === 'stale-open-channel') {
        await Promise.race([watching.promise, new Promise(resolve => setImmediate(resolve))]);
        assert.ok(watches > 0, 'a queued client observes a replacement service even while its old channel stays open');
        changed.resolve(nextEndpoint);
      }
      assert.deepEqual(await waiting, { exitCode: 0, kind: 'permit', permit: nextPermit, reservation: false });
      assert.deepEqual(events, ['enqueue:epoch-1', 'close:epoch-1', 'enqueue:epoch-2', 'ready:epoch-2', 'close:epoch-2']);
    } finally {
      controller.abort();
      await waiting;
    }
  });
}

for (const workload of ['agent', 'test'] as const) {
  for (const interruption of ['service-stopped-no-endpoint', 'service-stopped-old-epoch', 'closed'] as const) {
    test(`[resource-wait/client] ${workload} survives stop then generation swap then start (${interruption})`, async () => {
      const controller = new AbortController();
      const replacement = deferred<typeof endpoint>();
      const stopped = deferred<void>();
      const nextEndpoint = { ...endpoint, serviceEpoch: 'generation-2' };
      const nextTicket = { requestId: 'replacement-request', serviceEpoch: nextEndpoint.serviceEpoch };
      const nextOffer = { ...nextTicket, offerId: 'replacement-offer', deadline: 3000 };
      const nextPermit = { ...nextTicket, grantedAt: 4000 };
      const events: string[] = [];
      let completed = false;
      let readinessCalls = 0;
      let watchAborts = 0;
      const waiting = runResourceWaitCommand({ ...request(101, 'normal', controller.signal), workload }, options(), {
        ensureReady: async () => {
          assert.equal(++readinessCalls, 1, 'a queued client must not start the old generation in the swap gap');
          return endpoint;
        },
        refreshEndpoint: async () => interruption === 'service-stopped-old-epoch' ? endpoint : null,
        watchService: async (selected, signal) => {
          signal.addEventListener('abort', () => { watchAborts++; }, { once: true });
          return selected.serviceEpoch === endpoint.serviceEpoch ? replacement.promise : new Promise(() => {});
        },
        connect: async selected => {
          const old = selected.serviceEpoch === endpoint.serviceEpoch;
          const frames: Awaited<ReturnType<ResourceWaitClientConnection['receive']>>[] = [
            { kind: 'offer', offer }, { kind: 'result', result: wireSuccess },
            { kind: 'offer', offer: nextOffer }, { kind: 'result', result: { ...nextOffer, kind: 'permit', permit: nextPermit } },
          ];
          return {
            enqueue: async input => {
              assert.equal(input.workload, workload);
              assert.equal(input.clientIdentity.pid, 101);
              events.push(`enqueue:${selected.serviceEpoch}`);
              return old ? ticket : nextTicket;
            },
            receive: async () => {
              if (!old) return frames.shift()!;
              stopped.resolve();
              return interruption === 'closed' ? { kind: 'closed', reason: 'Service stopped' }
                : { kind: 'result', result: { ...offer, kind: 'error', diagnostic: { ...diagnostic, reason: 'service_stopped' } } };
            },
            sendReady: async selectedOffer => { events.push(`ready:${selectedOffer.serviceEpoch}`); },
            cancel: async () => {},
            close: async () => { events.push(`close:${selected.serviceEpoch}`); },
          };
        },
        recordDuration: () => {},
      }).then(result => { completed = true; return result; });
      try {
        await stopped.promise;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(completed, false, 'stop must keep the queued client waiting while no replacement service is ready');
        assert.deepEqual(events, ['enqueue:epoch-1']);
        events.push('swap-generation');
        replacement.resolve(nextEndpoint);
        assert.deepEqual(await waiting, { exitCode: 0, kind: 'permit', permit: nextPermit, reservation: false });
        assert.deepEqual(events, ['enqueue:epoch-1', 'swap-generation', 'close:epoch-1', 'enqueue:generation-2', 'ready:generation-2', 'close:generation-2']);
        assert.equal(watchAborts, 2);
      } finally {
        controller.abort();
        replacement.resolve(nextEndpoint);
        await waiting;
      }
    });
  }
}

test('[resource-wait/client] cancellation during stopped generation wait does not enqueue a replacement', async () => {
  const controller = new AbortController();
  const stopped = deferred<void>();
  let closed = 0;
  let enqueued = 0;
  let watcherAborted = false;
  const waiting = runResourceWaitCommand(request(101, 'normal', controller.signal), options(), {
    ensureReady: async () => endpoint,
    refreshEndpoint: async () => null,
    watchService: async (_endpoint, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { watcherAborted = true; reject(new Error('watch cancelled')); }, { once: true });
    }),
    connect: async () => ({
      enqueue: async () => { enqueued++; return ticket; },
      receive: async () => { stopped.resolve(); return { kind: 'result', result: { ...offer, kind: 'error', diagnostic: { ...diagnostic, reason: 'service_stopped' } } }; },
      sendReady: async () => assert.fail('no offer in stopped generation'),
      cancel: async () => {},
      close: async () => { closed++; },
    }),
    recordDuration: () => {},
  });
  await stopped.promise;
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await waiting;
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.diagnostic.details, /cancelled/);
  assert.equal(enqueued, 1);
  assert.equal(closed, 1);
  assert.equal(watcherAborted, true);
});

test('[resource-wait/client] terminal service stop without a watcher preserves its diagnostic without starting a service', async () => {
  const env = new ClientEnvironment();
  const stoppedDiagnostic = { ...diagnostic, reason: 'service_stopped', details: 'Service stopped' };
  env.messages = [{ kind: 'result', result: { ...offer, kind: 'error', diagnostic: stoppedDiagnostic } }];
  env.beforeReceive = async () => { env.readinessFailure = new Error('Stopped service has no ready endpoint'); };
  assert.deepEqual(await runResourceWaitCommand(request(), options(), env.ports), {
    exitCode: 1, kind: 'error', diagnostic: stoppedDiagnostic,
  });
  assert.equal(env.ensureCalls, 1, 'a terminal stop without a service watcher must not auto-start the stopped generation');
  assert.equal(env.closeCalls, 1);
});
