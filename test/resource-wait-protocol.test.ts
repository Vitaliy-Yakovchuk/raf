import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createResourceWaitProtocol, readResourceWaitProtocolOptions,
  type ResourceWaitOffer, type ResourceWaitProtocolOptions,
} from '../src/resource-wait-protocol.ts';
import { configuration, deferred, identity, options, ProtocolEnvironment, request } from './helpers/resource-wait-protocol-fixture.ts';

async function protocol(env = new ProtocolEnvironment(), overrides: Partial<ResourceWaitProtocolOptions> = {}) {
  const config = options(overrides);
  const queue = createResourceWaitProtocol(config, env.ports);
  await queue.start(env.ownerEpoch);
  return { env, queue, config };
}

function lastOffer(env: ProtocolEnvironment, requestId: string): ResourceWaitOffer {
  const found = env.offers.filter(entry => entry.offer.requestId === requestId).at(-1);
  assert.ok(found, 'selected request receives an offer');
  return found!.offer;
}

for (const field of ['grantIntervalMs', 'hostTickIntervalMs', 'deliveryTimeoutMs', 'readinessTimeoutMs'] as const) {
  for (const invalid of [undefined, 0, -1, 1.5, Infinity, NaN]) {
    test(`[resource-wait/config] rejects ${field}=${String(invalid)} without fallback`, () => {
      const conf = configuration();
      const location = field === 'grantIntervalMs' || field === 'deliveryTimeoutMs' ? conf.raf.resourceWait : conf.raf.service;
      location[field] = invalid;
      assert.throws(() => readResourceWaitProtocolOptions(conf), (error: unknown) => {
        assert.match(String(error), new RegExp(field));
        return true;
      });
    });
  }
}

test('[resource-wait/config] reads all budgets and priorities from the supplied catalog', () => {
  const conf = configuration();
  conf.raf.resourceWait.grantIntervalMs = 137;
  conf.raf.resourceWait.deliveryTimeoutMs = 283;
  conf.raf.service.hostTickIntervalMs = 41;
  conf.raf.service.readinessTimeoutMs = 509;
  conf.constants.resourceWaitLevels = [{ id: 'normal', priority: 9 }, { id: 'hotfix', priority: 2 }];
  assert.deepEqual(readResourceWaitProtocolOptions(conf), {
    levels: conf.constants.resourceWaitLevels,
    grantIntervalMs: 137, deliveryTimeoutMs: 283, hostTickIntervalMs: 41, readinessTimeoutMs: 509,
  });
});

for (const level of [undefined, 'unknown']) {
  test(`[resource-wait/level] rejects ${String(level)} before queue acceptance`, async () => {
    const { queue, env } = await protocol();
    assert.throws(() => queue.enqueue({ ...request(), level }), /level/i);
    assert.equal(queue.inspect().pending.length, 0);
    assert.equal(env.probes, 0);
    assert.equal(env.commits.length, 0);
  });
}

test('[resource-wait/ordering] later hotfix preempts an offered normal and preserves normal FIFO', async () => {
  const { queue, env, config } = await protocol();
  const first = queue.enqueue(request(101));
  const second = queue.enqueue(request(102));
  await queue.pump();
  const withdrawn = lastOffer(env, first.requestId);
  const sequence = queue.inspect().pending.find(item => item.requestId === first.requestId)!.sequence;
  const hotfix = queue.enqueue(request(103, 'hotfix'));
  await queue.pump();
  assert.equal(await queue.ready(withdrawn, identity(101)), 'ignored');
  assert.equal(queue.inspect().pending.find(item => item.requestId === first.requestId)!.sequence, sequence);
  assert.equal(await queue.ready(lastOffer(env, hotfix.requestId), identity(103)), 'issued');
  await env.clock.advanceTo(config.grantIntervalMs);
  await queue.pump();
  assert.equal(await queue.ready(lastOffer(env, first.requestId), identity(101)), 'issued');
  await env.clock.advanceTo(2 * config.grantIntervalMs);
  await queue.pump();
  assert.equal(await queue.ready(lastOffer(env, second.requestId), identity(102)), 'issued');
  assert.deepEqual(env.commits.map(row => row.requestId), [hotfix.requestId, first.requestId, second.requestId]);
  assert.equal(queue.inspect().pending.length, 0);
});

test('[resource-wait/ordering] configured priority controls selection independently of catalog order', async () => {
  const { queue, env } = await protocol(new ProtocolEnvironment(), { levels: [...options().levels].reverse() });
  queue.enqueue(request(101));
  const hotfix = queue.enqueue(request(102, 'hotfix'));
  await queue.pump();
  assert.equal(env.offers[0].offer.requestId, hotfix.requestId);
});

test('[resource-wait/ordering] insufficient resources keep the head waiting without bypass', async () => {
  const { queue, env } = await protocol();
  env.admission = { status: 'NO_RESOURCES', reason: 'fixture shortage' };
  const hotfix = queue.enqueue(request(101, 'hotfix'));
  const normal = queue.enqueue(request(102));
  await queue.pump();
  assert.equal(env.offers.length, 0);
  assert.deepEqual(queue.inspect().pending.map(item => item.requestId), [hotfix.requestId, normal.requestId]);
  assert.equal(env.errors.length, 0);
});

test('[resource-wait/interval] first permit is immediate; all levels share the exact monotonic boundary', async () => {
  const { queue, env, config } = await protocol();
  const first = queue.enqueue(request());
  await queue.pump();
  assert.equal(env.results.length, 0, 'offer does not resolve as a permit');
  assert.equal(env.row, null, 'offer does not consume interval');
  assert.equal(await queue.ready(lastOffer(env, first.requestId), identity()), 'issued');
  const second = queue.enqueue(request(102, 'hotfix'));
  await env.clock.advanceTo(config.grantIntervalMs - 1);
  await queue.pump();
  assert.equal(env.offers.some(item => item.offer.requestId === second.requestId), false);
  await env.clock.advanceTo(config.grantIntervalMs);
  await queue.pump();
  assert.equal(await queue.ready(lastOffer(env, second.requestId), identity(102)), 'issued');
  assert.equal(env.commits.length, 2);
  assert.equal(env.commits[1].monotonicAt - env.commits[0].monotonicAt, config.grantIntervalMs);
});

test('[resource-wait/interval] delayed durable commit starts the interval at observed completion', async () => {
  const { queue, env, config } = await protocol();
  const first = queue.enqueue(request());
  await queue.pump();
  const entered = deferred<void>();
  const release = deferred<void>();
  env.onCommit = async () => { entered.resolve(); await release.promise; };
  const issuing = queue.ready(lastOffer(env, first.requestId), identity());
  await Promise.race([entered.promise, issuing]);
  env.clock.monotonic = config.grantIntervalMs * 2;
  const completedAt = env.clock.monotonic;
  release.resolve();
  assert.equal(await issuing, 'issued');
  env.onCommit = null;
  const next = queue.enqueue(request(102));
  await env.clock.advanceTo(completedAt + config.grantIntervalMs - 1);
  await queue.pump();
  assert.equal(env.offers.some(item => item.offer.requestId === next.requestId), false);
  await env.clock.advanceTo(completedAt + config.grantIntervalMs);
  await queue.pump();
  assert.equal(await queue.ready(lastOffer(env, next.requestId), identity(102)), 'issued');
});

for (const jump of [-1_000_000_000, 1_000_000_000]) {
  test(`[resource-wait/interval] wall clock jump ${jump} cannot shorten the interval`, async () => {
    const { queue, env, config } = await protocol();
    const first = queue.enqueue(request());
    await queue.pump();
    await queue.ready(lastOffer(env, first.requestId), identity());
    env.clock.wall += jump;
    const next = queue.enqueue(request(102));
    await env.clock.advanceTo(config.grantIntervalMs - 1);
    await queue.pump();
    assert.equal(env.offers.some(item => item.offer.requestId === next.requestId), false);
    await env.clock.advanceTo(config.grantIntervalMs);
    await queue.pump();
    assert.equal(await queue.ready(lastOffer(env, next.requestId), identity(102)), 'issued');
  });
}

for (const boundary of ['waiting', 'offered', 'client-ready'] as const) {
  test(`[resource-wait/cancel] cancellation at ${boundary} wins before commit; late ready is inert`, async () => {
    const { queue, env } = await protocol();
    const first = queue.enqueue(request());
    const survivor = queue.enqueue(request(102));
    let offer: ResourceWaitOffer | undefined;
    let ready: Promise<string> | undefined;
    const observed = deferred<void>();
    const release = deferred<void>();
    if (boundary !== 'waiting') {
      await queue.pump();
      offer = lastOffer(env, first.requestId);
    }
    if (boundary === 'client-ready') {
      env.onObserve = async client => {
        observed.resolve();
        await release.promise;
        return { state: 'alive', identity: client };
      };
      ready = queue.ready(offer!, identity());
      await Promise.race([observed.promise, ready]);
    }
    assert.equal(await queue.cancel(first, identity(), 'external timeout'), 'cancelled');
    release.resolve();
    if (ready) assert.equal(await ready, 'ignored');
    env.onObserve = null;
    if (offer) assert.equal(await queue.ready(offer, identity()), 'ignored');
    assert.equal(env.row, null);
    assert.deepEqual(queue.inspect().pending.map(item => item.requestId), [survivor.requestId]);
    await queue.pump();
    assert.equal(await queue.ready(lastOffer(env, survivor.requestId), identity(102)), 'issued');
    assert.equal(env.clock.monotonic, 0, 'cancelled request added no interval');
    assert.equal(env.commits.length, 1);
  });
}

test('[resource-wait/cancel] commit wins; cancellation and repeated ready retain the durable interval', async () => {
  const { queue, env, config } = await protocol();
  const first = queue.enqueue(request());
  await queue.pump();
  const offer = lastOffer(env, first.requestId);
  assert.equal(await queue.ready(offer, identity()), 'issued');
  const row = structuredClone(env.row);
  assert.equal(await queue.cancel(first, identity(), 'late timeout'), 'already-issued');
  assert.equal(await queue.ready(offer, identity()), 'already-issued');
  assert.deepEqual(env.row, row);
  assert.equal(env.commits.length, 1);
  const second = queue.enqueue(request(102));
  await env.clock.advanceTo(config.grantIntervalMs - 1);
  await queue.pump();
  assert.equal(env.offers.some(entry => entry.offer.requestId === second.requestId), false);
});

test('[resource-wait/cancel] AbortSignal removes only its pending request', async () => {
  const { queue, env } = await protocol();
  const controller = new AbortController();
  const first = queue.enqueue(request(101, 'normal', controller.signal));
  const survivor = queue.enqueue(request(102));
  controller.abort(new Error('fixture external timeout'));
  await queue.pump();
  assert.equal(queue.inspect().pending.some(item => item.requestId === first.requestId), false);
  assert.equal(env.row, null);
  assert.equal(await queue.ready(lastOffer(env, survivor.requestId), identity(102)), 'issued');
});

test('[resource-wait/cancel] EOF cleans up an offer without delaying the next client', async () => {
  const { queue, env } = await protocol();
  const first = queue.enqueue(request());
  const next = queue.enqueue(request(102));
  await queue.pump();
  const stale = lastOffer(env, first.requestId);
  await queue.disconnect(request().connectionId);
  assert.equal(await queue.ready(stale, identity()), 'ignored');
  await queue.pump();
  assert.equal(await queue.ready(lastOffer(env, next.requestId), identity(102)), 'issued');
  assert.equal(env.commits.length, 1);
});

test('[resource-wait/delivery] configured offer timeout frees head without charging an interval', async () => {
  const { queue, env, config } = await protocol(new ProtocolEnvironment(), { deliveryTimeoutMs: 113 });
  const first = queue.enqueue(request());
  const next = queue.enqueue(request(102));
  await queue.pump();
  const expired = lastOffer(env, first.requestId);
  assert.equal(expired.deadline, config.deliveryTimeoutMs);
  await env.clock.advanceTo(config.deliveryTimeoutMs - 1);
  assert.equal(queue.inspect().pending.some(item => item.requestId === first.requestId), true);
  await env.clock.advanceTo(config.deliveryTimeoutMs);
  await queue.pump();
  assert.equal(queue.inspect().pending.some(item => item.requestId === first.requestId), false);
  assert.equal(await queue.ready(expired, identity()), 'ignored');
  assert.equal(env.errors.some(item => item.ticket.requestId === first.requestId), true);
  assert.equal(await queue.ready(lastOffer(env, next.requestId), identity(102)), 'issued');
  assert.equal(env.commits.length, 1);
});

test('[resource-wait/delivery] resource shortage can wait beyond delivery budget before an offer', async () => {
  const { queue, env, config } = await protocol();
  env.admission = { status: 'NO_RESOURCES', reason: 'fixture shortage' };
  const ticket = queue.enqueue(request());
  await queue.pump();
  await env.clock.advanceTo(2 * config.deliveryTimeoutMs);
  assert.equal(queue.inspect().pending.some(item => item.requestId === ticket.requestId), true);
  assert.equal(env.errors.length, 0);
});

for (const phase of ['waiting', 'offered'] as const) {
  for (const loss of ['SIGKILL-inherited-channel', 'pid-reuse', 'unknown-identity'] as const) {
    test(`[resource-wait/liveness] ${loss} in ${phase} is removed on shared tick without client cleanup`, async () => {
      const { queue, env, config } = await protocol();
      if (phase === 'waiting') env.admission = { status: 'NO_RESOURCES', reason: 'fixture shortage' };
      const dead = queue.enqueue(request());
      queue.enqueue(request(102));
      await queue.pump();
      env.observations.set(101, loss === 'pid-reuse'
        ? { state: 'alive', identity: { ...identity(), startedAt: 'reused-start' } }
        : { state: loss === 'unknown-identity' ? 'unknown' : 'dead', reason: loss });
      assert.equal(env.disconnected.size, 0, 'inherited connection stays open');
      await env.clock.advanceTo(config.hostTickIntervalMs);
      await queue.pump();
      assert.equal(queue.inspect().pending.some(item => item.requestId === dead.requestId), false);
      assert.equal(env.commits.length, 0);
      assert.equal(queue.inspect().pending.some(item => item.clientIdentity.pid === 102), true);
    });
  }
}

test('[resource-wait/liveness] death observed during ready prevents commit without waiting for a tick', async () => {
  const { queue, env } = await protocol();
  const first = queue.enqueue(request());
  await queue.pump();
  env.observations.set(101, { state: 'dead', reason: 'SIGKILL before commit' });
  assert.notEqual(await queue.ready(lastOffer(env, first.requestId), identity()), 'issued');
  assert.equal(env.row, null);
  assert.equal(queue.inspect().pending.length, 0);
});

test('[resource-wait/fence] stale epoch, wrong offer and another process cannot grant or cancel a request', async () => {
  const { queue, env } = await protocol();
  const ticket = queue.enqueue(request());
  await queue.pump();
  const offer = lastOffer(env, ticket.requestId);
  assert.equal(await queue.ready({ ...offer, serviceEpoch: 'old-epoch' }, identity()), 'ignored');
  assert.equal(await queue.ready({ ...offer, offerId: 'unknown-offer' }, identity()), 'ignored');
  assert.equal(await queue.ready(offer, identity(999)), 'ignored');
  assert.equal(await queue.cancel(ticket, identity(999), 'not the owner'), 'ignored');
  assert.equal(env.row, null);
  assert.equal(await queue.ready(offer, identity()), 'issued');
});

test('[resource-wait/fence] old service cannot commit after ownership changed', async () => {
  const { queue, env } = await protocol();
  const ticket = queue.enqueue(request());
  await queue.pump();
  env.ownerEpoch = 'epoch-2';
  assert.notEqual(await queue.ready(lastOffer(env, ticket.requestId), identity()), 'issued');
  assert.equal(env.row, null);
  assert.equal(env.results.some(item => item.result.kind === 'permit'), false);
});

test('[resource-wait/monitor] idle queue does no probes and active clients share one pending probe', async () => {
  const { queue, env, config } = await protocol();
  await env.clock.advanceTo(config.hostTickIntervalMs * 3);
  await queue.pump();
  assert.equal(env.probes, 0);
  const entered = deferred<void>();
  const release = deferred<void>();
  env.onProbe = async () => {
    entered.resolve();
    await release.promise;
    return { observedAt: env.clock.monotonic, data: { status: 'NO_RESOURCES', reason: 'fixture shortage' } };
  };
  queue.enqueue(request());
  const first = queue.pump();
  await Promise.race([entered.promise, first]);
  for (let pid = 102; pid < 122; pid++) queue.enqueue(request(pid));
  const concurrent = queue.pump();
  await Promise.resolve();
  assert.equal(env.probes, 1);
  assert.equal(env.maxProbing, 1);
  release.resolve();
  await Promise.all([first, concurrent]);
  assert.equal(env.maxProbing, 1);
  await queue.stop('fixture finished');
  const before = env.probes;
  await env.clock.advanceTo(env.clock.monotonic + config.hostTickIntervalMs * 2);
  assert.equal(env.probes, before);
  assert.equal(env.clock.timers.size, 0);
});

test('[resource-wait/monitor] a cancelled request cannot resurrect when its asynchronous probe completes', async () => {
  const { queue, env } = await protocol();
  const entered = deferred<void>();
  const release = deferred<void>();
  env.onProbe = async () => {
    entered.resolve(); await release.promise;
    return { observedAt: env.clock.monotonic, data: { status: 'ANY_RUN', reason: 'available' } };
  };
  const ticket = queue.enqueue(request());
  const pumping = queue.pump();
  await Promise.race([entered.promise, pumping]);
  assert.equal(await queue.cancel(ticket, identity(), 'timeout during probe'), 'cancelled');
  release.resolve();
  await pumping;
  assert.equal(env.offers.length, 0);
  assert.equal(env.row, null);
  assert.equal(queue.inspect().pending.length, 0);
});

test('[resource-wait/monitor] cache expiry uses configured tick; stale and UNKNOWN do not grant', async () => {
  const { queue, env, config } = await protocol(new ProtocolEnvironment(), { hostTickIntervalMs: 47 });
  const ticket = queue.enqueue(request());
  await queue.pump();
  const offer = lastOffer(env, ticket.requestId);
  const before = env.probes;
  env.clock.monotonic = config.hostTickIntervalMs + 1;
  env.admission = { status: 'UNKNOWN', reason: 'fixture probe unavailable' };
  assert.notEqual(await queue.ready(offer, identity()), 'issued');
  assert.equal(env.probes, before + 1);
  assert.equal(env.row, null);
  assert.equal(env.errors.some(item => item.ticket.requestId === ticket.requestId), true);
  assert.equal(queue.inspect().pending.length, 0);
});

test('[resource-wait/monitor] precommit resource recheck respects the requested level', async () => {
  const { queue, env } = await protocol();
  env.admission = { status: 'HOTFIX_ONLY', reason: 'only hotfix fits' };
  const normal = queue.enqueue(request());
  await queue.pump();
  assert.equal(env.offers.length, 0);
  const hotfix = queue.enqueue(request(102, 'hotfix'));
  await queue.pump();
  assert.equal(await queue.ready(lastOffer(env, hotfix.requestId), identity(102)), 'issued');
  assert.equal(queue.inspect().pending.some(item => item.requestId === normal.requestId), true);
});

for (const outcome of ['not-committed', 'unknown'] as const) {
  test(`[resource-wait/persistence] ${outcome} cannot produce a success result`, async () => {
    const { queue, env } = await protocol();
    const ticket = queue.enqueue(request());
    await queue.pump();
    env.commitOutcome = outcome;
    assert.notEqual(await queue.ready(lastOffer(env, ticket.requestId), identity()), 'issued');
    assert.equal(env.results.some(item => item.result.kind === 'permit'), false);
    assert.ok(env.errors.length > 0 || queue.inspect().stopped, 'store failure is explicit');
  });
}

test('[resource-wait/persistence] unknown commit with a durable row is reconciled or stops further grants', async () => {
  const { queue, env, config } = await protocol();
  const ticket = queue.enqueue(request());
  await queue.pump();
  env.commitOutcome = 'unknown';
  env.unknownCommitWrites = true;
  assert.notEqual(await queue.ready(lastOffer(env, ticket.requestId), identity()), 'issued');
  assert.equal(env.row?.requestId, ticket.requestId);
  assert.equal(env.results.some(item => item.result.kind === 'permit'), false);
  if (!queue.inspect().stopped) {
    const next = queue.enqueue(request(102));
    await env.clock.advanceTo(config.grantIntervalMs - 1);
    await queue.pump();
    assert.equal(env.offers.some(item => item.offer.requestId === next.requestId), false);
  }
});

test('[resource-wait/persistence] durable read failure is not treated as an empty first launch', async () => {
  const env = new ProtocolEnvironment();
  env.readFailure = new Error('fixture corrupt lastGrant');
  const queue = createResourceWaitProtocol(options(), env.ports);
  await assert.rejects(queue.start(env.ownerEpoch), /lastGrant|corrupt/i);
  assert.equal(env.commits.length, 0);
  assert.equal(env.offers.length, 0);
});

test('[resource-wait/persistence] concurrent ready messages produce at most one in-flight commit', async () => {
  const { queue, env } = await protocol();
  const ticket = queue.enqueue(request());
  await queue.pump();
  const offer = lastOffer(env, ticket.requestId);
  const entered = deferred<void>();
  const release = deferred<void>();
  env.onCommit = async () => { entered.resolve(); await release.promise; };
  const first = queue.ready(offer, identity());
  await Promise.race([entered.promise, first]);
  const second = queue.ready(offer, identity());
  await Promise.resolve();
  assert.equal(env.maxCommitsInFlight, 1);
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.sort(), ['already-issued', 'issued']);
  assert.equal(env.commits.length, 1);
  assert.equal(queue.inspect().pending.length, 0);
});

test('[resource-wait/persistence] final delivery failure retains the committed singleton', async () => {
  const { queue, env } = await protocol();
  const ticket = queue.enqueue(request());
  await queue.pump();
  env.failFinalDelivery = true;
  await queue.ready(lastOffer(env, ticket.requestId), identity());
  assert.equal(env.row?.requestId, ticket.requestId);
  assert.equal(env.commits.length, 1);
  assert.equal(queue.inspect().pending.length, 0);
  assert.equal(await queue.cancel(ticket, identity(), 'after delivery failure'), 'already-issued');
});

for (const restart of ['same-boot', 'new-boot', 'regressed-monotonic'] as const) {
  test(`[resource-wait/restart] ${restart} waits a full interval from readiness without restoring old requests`, async () => {
    const { queue, env, config } = await protocol();
    const old = queue.enqueue(request());
    await queue.pump();
    const oldOffer = lastOffer(env, old.requestId);
    await queue.ready(oldOffer, identity());
    queue.enqueue(request(102));
    await queue.stop('fixture service crash after commit');
    env.ownerEpoch = 'epoch-2';
    if (restart === 'new-boot') env.boot = 'fixture-next-boot';
    env.clock.monotonic = restart === 'regressed-monotonic' ? -100 : config.grantIntervalMs * 5;
    env.clock.wall += 1_000_000;
    const readyAt = env.clock.monotonic;
    const resumed = createResourceWaitProtocol(config, env.ports);
    await resumed.start(env.ownerEpoch);
    assert.equal(resumed.inspect().pending.length, 0);
    assert.equal(await resumed.ready(oldOffer, identity()), 'ignored');
    const fresh = resumed.enqueue(request(103, 'hotfix'));
    await env.clock.advanceTo(readyAt + config.grantIntervalMs - 1);
    await resumed.pump();
    assert.equal(env.offers.some(item => item.offer.requestId === fresh.requestId), false);
    await env.clock.advanceTo(readyAt + config.grantIntervalMs);
    await resumed.pump();
    assert.equal(await resumed.ready(lastOffer(env, fresh.requestId), identity(103)), 'issued');
    assert.equal(env.row?.serviceEpoch, 'epoch-2');
    assert.equal(env.commits.length, 2, 'the fake journal is test evidence; durable storage is one row');
  });
}

test('[resource-wait/delivery] backpressure on an offer cannot block cancellation', async () => {
  const { queue, env } = await protocol();
  const entered = deferred<void>();
  const release = deferred<void>();
  const send = env.ports.sendOffer;
  env.ports.sendOffer = async (connection, offer) => {
    await send(connection, offer);
    entered.resolve();
    await release.promise;
  };
  const ticket = queue.enqueue(request());
  const pumping = queue.pump();
  await Promise.race([entered.promise, pumping]);
  assert.equal(await queue.cancel(ticket, identity(), 'timeout under backpressure'), 'cancelled');
  release.resolve();
  await pumping;
  assert.equal(env.row, null);
  assert.equal(queue.inspect().pending.length, 0);
});

test('[resource-wait/cancel] commit wins before final delivery; blocked transport cannot roll it back', async () => {
  const { queue, env } = await protocol();
  const entered = deferred<void>();
  const release = deferred<void>();
  const send = env.ports.sendResult;
  env.ports.sendResult = async (connection, result) => {
    entered.resolve();
    await release.promise;
    await send(connection, result);
  };
  const ticket = queue.enqueue(request());
  await queue.pump();
  const issuing = queue.ready(lastOffer(env, ticket.requestId), identity());
  await Promise.race([entered.promise, issuing]);
  assert.equal(env.row?.requestId, ticket.requestId);
  assert.equal(await queue.cancel(ticket, identity(), 'timeout before final result'), 'already-issued');
  env.observations.set(101, { state: 'dead', reason: 'death observed after commit' });
  release.resolve();
  await issuing;
  assert.equal(env.commits.length, 1);
  assert.equal(env.row?.requestId, ticket.requestId);
});

test('[resource-wait/ordering] hotfix arriving during precommit liveness invalidates the lower offer', async () => {
  const { queue, env } = await protocol();
  const normal = queue.enqueue(request());
  await queue.pump();
  const oldOffer = lastOffer(env, normal.requestId);
  const oldSequence = queue.inspect().pending.find(item => item.requestId === normal.requestId)!.sequence;
  const entered = deferred<void>();
  const release = deferred<void>();
  env.onObserve = async client => { entered.resolve(); await release.promise; return { state: 'alive', identity: client }; };
  const issuing = queue.ready(oldOffer, identity());
  await Promise.race([entered.promise, issuing]);
  const hotfix = queue.enqueue(request(102, 'hotfix'));
  release.resolve();
  assert.equal(await issuing, 'ignored');
  env.onObserve = null;
  await queue.pump();
  assert.equal(env.row, null);
  assert.equal(queue.inspect().pending.find(item => item.requestId === normal.requestId)!.sequence, oldSequence);
  assert.equal(await queue.ready(lastOffer(env, hotfix.requestId), identity(102)), 'issued');
  assert.equal(env.row?.requestId, hotfix.requestId);
});

test('[resource-wait/monitor] probe data that is already stale cannot authorize a permit', async () => {
  const { queue, env, config } = await protocol();
  env.clock.monotonic = config.hostTickIntervalMs * 2;
  env.onProbe = async () => ({ observedAt: 0, data: { status: 'ANY_RUN', reason: 'stale fixture sample' } });
  const ticket = queue.enqueue(request());
  await queue.pump();
  assert.equal(env.offers.some(item => item.offer.requestId === ticket.requestId), false);
  assert.equal(env.row, null);
});

test('[resource-wait/restart] crash before commit does not create an interval', async () => {
  const { queue, env, config } = await protocol();
  const ticket = queue.enqueue(request());
  await queue.pump();
  const oldOffer = lastOffer(env, ticket.requestId);
  await queue.stop('fixture crash before commit');
  assert.equal(env.row, null);
  env.ownerEpoch = 'epoch-2';
  const resumed = createResourceWaitProtocol(config, env.ports);
  await resumed.start(env.ownerEpoch);
  const fresh = resumed.enqueue(request(102));
  await resumed.pump();
  assert.equal(await resumed.ready(oldOffer, identity()), 'ignored');
  assert.equal(await resumed.ready(lastOffer(env, fresh.requestId), identity(102)), 'issued');
  assert.equal(env.clock.monotonic, 0);
  assert.equal(env.commits.length, 1);
});

test('[resource-wait/monitor] snapshot expiring during asynchronous liveness is rechecked before commit', async () => {
  const { queue, env, config } = await protocol();
  const ticket = queue.enqueue(request());
  await queue.pump();
  const entered = deferred<void>();
  const release = deferred<void>();
  env.onObserve = async client => { entered.resolve(); await release.promise; return { state: 'alive', identity: client }; };
  const issuing = queue.ready(lastOffer(env, ticket.requestId), identity());
  await Promise.race([entered.promise, issuing]);
  env.clock.monotonic = config.hostTickIntervalMs + 1;
  env.admission = { status: 'UNKNOWN', reason: 'probe failed while liveness awaited' };
  release.resolve();
  assert.notEqual(await issuing, 'issued');
  assert.equal(env.row, null);
  assert.equal(env.results.some(item => item.result.kind === 'permit'), false);
});

test('[resource-wait/persistence] only the current lastGrant answers already-issued; completed requests are discarded', async () => {
  const { queue, env, config } = await protocol();
  const first = queue.enqueue(request());
  await queue.pump();
  const oldOffer = lastOffer(env, first.requestId);
  await queue.ready(oldOffer, identity());
  const second = queue.enqueue(request(102));
  await env.clock.advanceTo(config.grantIntervalMs);
  await queue.pump();
  await queue.ready(lastOffer(env, second.requestId), identity(102));
  assert.equal(await queue.ready(oldOffer, identity()), 'ignored');
  assert.equal(await queue.cancel(first, identity(), 'ancient request'), 'ignored');
  assert.equal(env.row?.requestId, second.requestId);
  assert.equal(env.commits.length, 2);
  assert.equal(queue.inspect().pending.length, 0);
  const before = env.probes;
  await env.clock.advanceTo(env.clock.monotonic + config.hostTickIntervalMs * 2);
  assert.equal(env.probes, before, 'resource monitoring stops after queue drains');
});
