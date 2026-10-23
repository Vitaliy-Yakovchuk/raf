import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import {
  createResourceWaitProtocol,
  runResourceWaitCommand,
  type ResourceWaitClientConnection,
  type ResourceWaitProtocolOptions,
  type ResourceWaitProtocolPorts,
} from '../src/resource-wait-protocol.ts';

const options: ResourceWaitProtocolOptions = {
  levels: [{ id: 'hotfix', priority: 0 }, { id: 'normal', priority: 1 }],
  grantIntervalMs: 15_000,
  hostTickIntervalMs: 15_000,
  deliveryTimeoutMs: 30_000,
  readinessTimeoutMs: 5_000,
};

for (const level of ['normal', 'hotfix']) {
  test(`service stop delivers service_stopped with exit 1 to a ${level} waiter without resources`, async (t) => {
    type Message = Awaited<ReturnType<ResourceWaitClientConnection['receive']>>;
    const identity = {
      pid: 100,
      startedAt: '2026-10-23T00:00:00.000Z',
      machineId: 'unit-machine',
      bootId: 'unit-boot',
    };
    const enqueued = Promise.withResolvers<void>();
    const deliveryStarted = Promise.withResolvers<void>();
    const allowDelivery = Promise.withResolvers<void>();
    const inbox: Message[] = [];
    const readers: Array<(message: Message) => void> = [];
    const order: string[] = [];
    const timers = new Set<() => Promise<void>>();
    const controller = new AbortController();
    let open = true;
    let nextId = 0;
    let probes = 0;
    let offers = 0;
    let commits = 0;
    let readyMessages = 0;
    let errorSends = 0;

    const publish = (message: Message): void => {
      const reader = readers.shift();
      if (reader) reader(message);
      else inbox.push(message);
    };
    const closeChannel = (): void => {
      if (!open) return;
      open = false;
      order.push('channel-closed');
      publish({ kind: 'closed', reason: 'Service connection lost before confirmed permit' });
    };

    const ports: ResourceWaitProtocolPorts = {
      monotonicNow: () => 1_000,
      wallNow: () => 1_000,
      bootIdentity: () => identity.bootId,
      nextId: () => `unit-request-${++nextId}`,
      schedule: (_at, wake) => {
        timers.add(wake);
        return () => { timers.delete(wake); };
      },
      readSnapshot: async () => {
        probes++;
        return { observedAt: 1_000, data: null };
      },
      evaluateSnapshot: () => ({ status: 'NO_RESOURCES', reason: 'unit fixture has no resources' }),
      observeClient: async (clientIdentity) => ({ state: 'alive', identity: clientIdentity }),
      isConnectionOpen: () => open,
      sendOffer: async (_connectionId, offer) => {
        offers++;
        publish({ kind: 'offer', offer });
      },
      sendResult: async (_connectionId, result) => { publish({ kind: 'result', result }); },
      sendError: async (_connectionId, ticket, diagnostic) => {
        errorSends++;
        deliveryStarted.resolve();
        await allowDelivery.promise;
        if (!open) {
          order.push('diagnostic-lost');
          return;
        }
        order.push('diagnostic-delivered');
        publish({ kind: 'result', result: {
          ...ticket, offerId: '', deadline: 1_000, kind: 'error', diagnostic,
        } });
      },
      loadLastGrant: async () => null,
      commitLastGrant: async () => {
        commits++;
        return 'committed';
      },
    };
    const protocol = createResourceWaitProtocol(options, ports);
    const connection: ResourceWaitClientConnection = {
      enqueue: async (request) => {
        const ticket = protocol.enqueue(request);
        enqueued.resolve();
        return ticket;
      },
      receive: async () => inbox.length ? inbox.shift()! : new Promise<Message>((resolve) => readers.push(resolve)),
      sendReady: async (offer) => {
        readyMessages++;
        await protocol.ready(offer, identity);
      },
      cancel: async (ticket) => { await protocol.cancel(ticket, identity, 'client_cancelled'); },
      close: async () => { closeChannel(); },
    };
    t.after(async () => {
      allowDelivery.resolve();
      controller.abort();
      closeChannel();
      await protocol.stop('Service stopped normally');
    });

    await protocol.start('unit-service-epoch');
    const completion = runResourceWaitCommand({
      level,
      clientIdentity: identity,
      connectionId: 'unit-connection',
      developmentDirectory: '/unit/develop',
      signal: controller.signal,
    }, options, {
      ensureReady: async () => ({ endpoint: '/unit/socket', serviceEpoch: 'unit-service-epoch' }),
      connect: async () => connection,
      recordDuration: () => {},
    });
    await enqueued.promise;
    await protocol.pump();
    assert.ok(probes > 0, 'the waiter was evaluated without sufficient resources');
    assert.equal(protocol.inspect().pending.length, 1);
    assert.equal(protocol.inspect().pending[0].phase, 'waiting');
    assert.equal(protocol.inspect().lastGrant, null);
    assert.equal(offers, 0);

    const stopping = protocol.stop('Service stopped normally').then(() => {
      order.push('stop-completed');
      closeChannel();
    });
    await deliveryStarted.promise;
    await setImmediate();
    allowDelivery.resolve();
    await stopping;
    const result = await completion;

    assert.equal(result.exitCode, 1);
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') assert.fail('service stop must not issue a resource permit');
    assert.equal(result.diagnostic.reason, 'service_stopped');
    assert.ok(result.diagnostic.details.length > 0);
    assert.ok(result.diagnostic.remediation.length > 0);
    assert.equal(order.includes('diagnostic-lost'), false);
    assert.ok(order.indexOf('diagnostic-delivered') >= 0);
    assert.ok(order.indexOf('diagnostic-delivered') < order.indexOf('stop-completed'));
    assert.ok(order.indexOf('diagnostic-delivered') < order.indexOf('channel-closed'));
    assert.equal(errorSends, 1);
    assert.equal(offers, 0);
    assert.equal(readyMessages, 0);
    assert.equal(commits, 0);
    assert.equal(protocol.inspect().lastGrant, null);
    assert.equal(protocol.inspect().pending.length, 0);
    assert.equal(protocol.inspect().stopped, true);
    assert.equal(timers.size, 0);
  });
}
