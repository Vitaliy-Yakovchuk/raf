import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createResourceWaitProtocol, runResourceWaitCommand,
  type ResourceWaitClientConnection,
} from '../src/resource-wait-protocol.ts';
import { deferred, identity, options, ProtocolEnvironment, request } from './helpers/resource-wait-protocol-fixture.ts';

for (const [olderTier, newerTier] of [['normal', 'normal'], ['hotfix', 'hotfix'], ['hotfix', 'normal']] as const) {
  test(`previous generation pending enqueue rejoins before newer ${olderTier}/${newerTier} launch`, async () => {
    const env = new ProtocolEnvironment();
    env.ownerEpoch = 'replacement-epoch';
    env.admission = { status: 'NO_RESOURCES', reason: 'hold selection until both clients register' };
    const config = options();
    const queue = createResourceWaitProtocol(config, env.ports);
    await queue.start(env.ownerEpoch);
    const oldEndpoint = { endpoint: 'fixture://old', serviceEpoch: 'previous-epoch' };
    const replacement = { endpoint: 'fixture://replacement', serviceEpoch: env.ownerEpoch };
    const changed = deferred<typeof replacement>();
    const enqueueStarted = deferred<void>();
    const controller = new AbortController();
    let oldClosed = 0;
    let oldReady = 0;
    const delivered = deferred<Awaited<ReturnType<ResourceWaitClientConnection['receive']>>>();
    const resultFrame = deferred<Awaited<ReturnType<ResourceWaitClientConnection['receive']>>>();
    env.ports.sendOffer = async (connectionId, offer) => {
      env.offers.push({ connectionId, offer });
      if (connectionId === 'connection-101') delivered.resolve({ kind: 'offer', offer });
    };
    env.ports.sendResult = async (connectionId, result) => {
      env.results.push({ connectionId, result });
      if (connectionId === 'connection-101') resultFrame.resolve({ kind: 'result', result });
    };
    let receivedOffer = false;
    const waiting = runResourceWaitCommand(request(101, olderTier, controller.signal), config, {
      ensureReady: async () => oldEndpoint,
      watchService: async selected => selected.serviceEpoch === oldEndpoint.serviceEpoch ? changed.promise : new Promise(() => {}),
      connect: async selected => selected.serviceEpoch === oldEndpoint.serviceEpoch ? {
        enqueue: async () => { enqueueStarted.resolve(); return new Promise(() => {}); },
        receive: async () => new Promise(() => {}),
        sendReady: async () => { oldReady++; },
        cancel: async () => {},
        close: async () => { oldClosed++; },
      } : {
        enqueue: async input => queue.enqueue(input),
        receive: async () => {
          if (receivedOffer) return resultFrame.promise;
          receivedOffer = true;
          return delivered.promise;
        },
        sendReady: async offer => { await queue.ready(offer, identity(101)); },
        cancel: async ticket => { await queue.cancel(ticket, identity(101), 'test cleanup'); },
        close: async () => {},
      },
      recordDuration: () => {},
    });
    try {
      await enqueueStarted.promise;
      changed.resolve(replacement);
      await new Promise(resolve => setImmediate(resolve));
      const newer = queue.enqueue(request(102, newerTier));
      await queue.pump();
      assert.deepEqual(queue.inspect().pending.map(entry => entry.clientIdentity.pid), [101, 102],
        'a live old client awaiting its ticket must rejoin the current service before a newer same/lower-tier client');
      assert.equal(oldClosed, 1);
      assert.equal(oldReady, 0);
      env.admission = { status: 'ANY_RUN', reason: 'both launches fit' };
      await env.clock.advanceTo(config.hostTickIntervalMs);
      await queue.pump();
      const older = await waiting;
      assert.equal(older.kind, 'permit');
      assert.deepEqual(env.commits.map(item => item.requestId), [queue.inspect().lastGrant!.requestId]);
      assert.equal(env.offers.some(item => item.offer.requestId === newer.requestId), false);
      await env.clock.advanceTo(env.commits[0].monotonicAt + config.grantIntervalMs);
      const offer = env.offers.find(item => item.offer.requestId === newer.requestId)!.offer;
      assert.equal(await queue.ready(offer, identity(102)), 'issued');
      assert.equal(env.commits.length, 2);
      assert.equal(env.commits[1].requestId, newer.requestId);
      assert.equal(env.commits[1].monotonicAt - env.commits[0].monotonicAt, config.grantIntervalMs);
    } finally {
      controller.abort();
      changed.resolve(replacement);
      await waiting;
      await queue.stop('test cleanup');
    }
  });
}
