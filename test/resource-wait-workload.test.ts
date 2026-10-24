import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceWaitProtocol, type ResourceWaitRequest } from '../src/resource-wait-protocol.ts';
import { identity, options, ProtocolEnvironment, request } from './helpers/resource-wait-protocol-fixture.ts';

async function fixture() {
  const env = new ProtocolEnvironment();
  const config = options();
  const queue = createResourceWaitProtocol(config, env.ports);
  await queue.start(env.ownerEpoch);
  env.admission = { status: 'NO_RESOURCES', reason: 'hold all arrivals before selection' };
  const enqueue = (pid: number, level: 'hotfix' | 'normal', workload?: 'test' | 'agent') =>
    queue.enqueue({ ...request(pid, level), ...(workload === undefined ? {} : { workload }) });
  const offer = (id: string) => {
    const value = env.offers.findLast(item => item.offer.requestId === id);
    assert.ok(value, `expected an offer for ${id}`);
    return value.offer;
  };
  const available = async () => {
    env.admission = { status: 'ANY_RUN', reason: 'all classes fit' };
    await env.clock.advanceTo(env.clock.monotonic + config.hostTickIntervalMs);
    await queue.pump();
  };
  return { queue, env, config, enqueue, offer, available };
}

test('test-queue priority is hotfix test then hotfix agent then normal test then normal agent', async () => {
  const f = await fixture();
  const normalAgent = f.enqueue(101, 'normal', 'agent');
  const normalTest = f.enqueue(102, 'normal', 'test');
  const hotfixAgent = f.enqueue(103, 'hotfix', 'agent');
  const hotfixTest = f.enqueue(104, 'hotfix', 'test');
  await f.queue.pump(); await f.available();
  const order = [hotfixTest, hotfixAgent, normalTest, normalAgent];
  assert.deepEqual(f.queue.inspect().pending.map(item => item.requestId), order.map(item => item.requestId));
  for (const [index, ticket] of order.entries()) {
    if (index) {
      const previous = f.env.commits.at(-1)!.monotonicAt;
      await f.env.clock.advanceTo(previous + f.config.grantIntervalMs - 1);
      assert.equal(f.env.offers.some(item => item.offer.requestId === ticket.requestId), false);
      await f.env.clock.advanceTo(previous + f.config.grantIntervalMs);
    }
    await f.queue.pump();
    assert.equal(await f.queue.ready(f.offer(ticket.requestId), identity([104, 103, 102, 101][index])), 'issued');
  }
  assert.deepEqual(f.env.commits.map(item => item.requestId), order.map(item => item.requestId));
  for (let i = 1; i < f.env.commits.length; i++) {
    assert.equal(f.env.commits[i].monotonicAt - f.env.commits[i - 1].monotonicAt, f.config.grantIntervalMs);
  }
});

for (const level of ['hotfix', 'normal'] as const) {
  test(`test-queue ${level} tests precede older agents and retain FIFO within each class`, async () => {
    const f = await fixture();
    const a = f.enqueue(101, level, 'agent'), b = f.enqueue(102, level, 'test');
    const c = f.enqueue(103, level, 'agent'), d = f.enqueue(104, level, 'test');
    await f.queue.pump();
    assert.deepEqual(f.queue.inspect().pending.map(item => item.requestId), [b, d, a, c].map(item => item.requestId));
  });

  test(`test-queue ${level} test arriving before offer commit invalidates agent offer without consuming interval`, async () => {
    const f = await fixture();
    const agent = f.enqueue(101, level, 'agent');
    await f.queue.pump(); await f.available();
    const offered = f.offer(agent.requestId);
    const sequence = f.queue.inspect().pending[0].sequence;
    const testing = f.enqueue(102, level, 'test'); await f.queue.pump();
    assert.equal(await f.queue.ready(offered, identity(101)), 'ignored');
    assert.equal(f.env.commits.length, 0); assert.equal(f.env.row, null);
    assert.equal(f.queue.inspect().pending.find(item => item.requestId === agent.requestId)!.sequence, sequence);
    assert.equal(await f.queue.ready(f.offer(testing.requestId), identity(102)), 'issued');
    await f.env.clock.advanceTo(f.env.commits[0].monotonicAt + f.config.grantIntervalMs);
    assert.equal(await f.queue.ready(f.offer(agent.requestId), identity(101)), 'issued');
  });

  test(`test-queue standalone and legacy ${level} waits stay in agent class`, async () => {
    const f = await fixture();
    const legacy = f.enqueue(101, level);
    const agent = f.enqueue(102, level, 'agent');
    const testing = f.enqueue(103, level, 'test');
    await f.queue.pump();
    assert.deepEqual(f.queue.inspect().pending.map(item => item.requestId), [testing, legacy, agent].map(item => item.requestId));
  });

  test(`test-queue committed ${level} agent permit is not revoked by later test`, async () => {
    const f = await fixture();
    const agent = f.enqueue(101, level, 'agent');
    await f.queue.pump(); await f.available();
    const issued = f.offer(agent.requestId);
    assert.equal(await f.queue.ready(issued, identity(101)), 'issued');
    const testing = f.enqueue(102, level, 'test'); await f.queue.pump();
    assert.equal(await f.queue.ready(issued, identity(101)), 'already-issued');
    assert.equal(f.env.commits.length, 1);
    await f.env.clock.advanceTo(f.env.commits[0].monotonicAt + f.config.grantIntervalMs);
    assert.equal(await f.queue.ready(f.offer(testing.requestId), identity(102)), 'issued');
  });
}

test('test-queue insufficient head does not allow a lower class to bypass it', async () => {
  const f = await fixture();
  const agent = f.enqueue(101, 'hotfix', 'agent');
  const testing = f.enqueue(102, 'hotfix', 'test');
  f.env.ports.evaluateSnapshot = (_snapshot, entry) => entry.requestId === testing.requestId
    ? { status: 'NO_RESOURCES', reason: 'test profile too large' }
    : { status: 'ANY_RUN', reason: 'smaller agent fits' };
  await f.queue.pump();
  assert.equal(f.env.offers.length, 0); assert.equal(f.env.commits.length, 0);
  assert.deepEqual(f.queue.inspect().pending.map(item => item.requestId), [testing, agent].map(item => item.requestId));
});

test('test-queue UNKNOWN head fails explicitly then reevaluates the next class', async () => {
  const f = await fixture();
  const agent = f.enqueue(101, 'hotfix', 'agent');
  const testing = f.enqueue(102, 'hotfix', 'test');
  f.env.ports.evaluateSnapshot = (_snapshot, entry) => entry.requestId === testing.requestId
    ? { status: 'UNKNOWN', reason: 'profile measurement unknown' }
    : { status: 'ANY_RUN', reason: 'agent data known' };
  await f.queue.pump();
  assert.equal(f.env.errors.length, 1);
  assert.equal(f.env.errors[0].ticket.requestId, testing.requestId);
  assert.equal(f.env.errors[0].diagnostic.reason, 'resource_unknown');
  assert.equal(await f.queue.ready(f.offer(agent.requestId), identity(101)), 'issued');
});

test('test-queue hotfix agent outranks normal test regardless of later workload preference', async () => {
  const f = await fixture();
  const normalTest = f.enqueue(101, 'normal', 'test');
  const hotfixAgent = f.enqueue(102, 'hotfix', 'agent');
  await f.queue.pump(); await f.available();
  assert.equal(f.env.offers.at(-1)!.offer.requestId, hotfixAgent.requestId);
  assert.deepEqual(f.queue.inspect().pending.map(item => item.requestId), [hotfixAgent, normalTest].map(item => item.requestId));
});

test('test-queue HOTFIX_ONLY grants a hotfix test while normal test remains waiting', async () => {
  const f = await fixture();
  const normal = f.enqueue(101, 'normal', 'test');
  const hotfix = f.enqueue(102, 'hotfix', 'test');
  await f.queue.pump();
  f.env.admission = { status: 'HOTFIX_ONLY', reason: 'normal threshold exceeded' };
  await f.env.clock.advanceTo(f.config.hostTickIntervalMs);
  assert.equal(await f.queue.ready(f.offer(hotfix.requestId), identity(102)), 'issued');
  await f.env.clock.advanceTo(f.env.commits[0].monotonicAt + f.config.grantIntervalMs);
  assert.equal(f.env.offers.some(item => item.offer.requestId === normal.requestId), false);
  assert.equal(f.queue.inspect().pending.length, 1);
});

test('test-queue a requeued test gets a new FIFO sequence without resetting global lastGrant', async () => {
  const f = await fixture();
  const a = f.enqueue(101, 'normal', 'test');
  await f.queue.pump(); await f.available();
  assert.equal(await f.queue.ready(f.offer(a.requestId), identity(101)), 'issued');
  const lastGrant = structuredClone(f.queue.inspect().lastGrant);
  const b = f.enqueue(102, 'normal', 'test');
  const agent = f.enqueue(103, 'normal', 'agent');
  const requeued = f.enqueue(101, 'normal', 'test');
  await f.queue.pump();
  assert.deepEqual(f.queue.inspect().pending.map(item => item.requestId), [b, requeued, agent].map(item => item.requestId));
  assert.deepEqual(f.queue.inspect().lastGrant, lastGrant);
  assert.equal(f.env.commits.length, 1);
});

for (const workload of ['unknown', '', 1, null]) {
  test(`test-queue rejects invalid internal workload ${JSON.stringify(workload)} before admission`, async () => {
    const f = await fixture();
    assert.throws(() => f.queue.enqueue({ ...request(), workload } as ResourceWaitRequest), /workload/i);
    assert.equal(f.queue.inspect().pending.length, 0);
    assert.equal(f.env.probes, 0); assert.equal(f.env.commits.length, 0);
  });
}
