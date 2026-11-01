import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateResourceWaitSnapshot } from '../src/production-resource-wait.ts';
import type { StateStore } from '../src/state-store.ts';
import { options, ProtocolEnvironment, request, identity } from './helpers/resource-wait-protocol-fixture.ts';
import { createResourceWaitProtocol } from '../src/resource-wait-protocol.ts';

const GiB = 1024 ** 3;
const store = { sessionRepository: { transaction: (action: any) => action({ listReservations: () => [] }) } } as unknown as StateStore;
const probe = { observedAt: 0, data: {
  measurement: { machineId: 'fixture-machine', loadAverage1m: 2.7, availableCores: 8,
    totalRamBytes: 32 * GiB, availableRamBytes: 20 * GiB, memoryPressure: 'normal',
    fileSystems: [{ id: 'dev', totalBytes: 180 * GiB, availableBytes: 27 * GiB }] },
  fileSystemByPath: { '/fixture/root': 'dev', '/fixture/project-101': 'dev', '/fixture/project-102': 'dev', [process.env.HOME!]: 'dev' },
  reasons: [], observedProcesses: [],
} };

test('launch queue uses actual test and agent reservations before granting permits', async () => {
  const env = new ProtocolEnvironment();
  env.ports.readSnapshot = async () => ({ ...structuredClone(probe), observedAt: env.clock.monotonic });
  env.ports.evaluateSnapshot = (snapshot, entry) => evaluateResourceWaitSnapshot(store, '/fixture/root', snapshot, entry);
  const queue = createResourceWaitProtocol(options(), env.ports);
  await queue.start(env.ownerEpoch);
  const testing = queue.enqueue({ ...request(101), workload: 'test', requested: { ramBytes: 2 * GiB, diskBytes: { dev: 10 * GiB } } });
  const agent = queue.enqueue({ ...request(102), workload: 'agent', requested: { ramBytes: 2 * GiB, diskBytes: { dev: GiB } } });
  await queue.pump();
  assert.equal(env.offers.some(row => row.offer.requestId === testing.requestId), false, '27 GiB minus 10 GiB is below the normal 18 GiB floor');
  assert.equal(env.offers.length, 0, 'the smaller agent cannot bypass the waiting head');
  assert.equal(env.commits.length, 0, 'resource shortage must not consume the global grant interval');
  assert.equal(queue.inspect().lastGrant, null);
  const waiting = env.waiting.find(row => row.frame.requestId === testing.requestId)?.frame.admission;
  assert.equal(waiting?.status, 'HOTFIX_ONLY');
  assert.match(waiting.reason, /disk/i);
  assert.deepEqual(queue.inspect().pending.map(row => row.requestId), [testing.requestId, agent.requestId]);
  probe.data.measurement.fileSystems[0].availableBytes = 40 * GiB;
  env.clock.monotonic += options().hostTickIntervalMs;
  await queue.pump();
  const offer = env.offers.find(row => row.offer.requestId === testing.requestId)?.offer;
  assert.ok(offer, 'the head is offered only after its full reservation fits');
  assert.equal(await queue.ready(offer, identity(101)), 'issued');
  assert.deepEqual(env.commits.map(row => row.requestId), [testing.requestId]);
  assert.deepEqual(queue.inspect().pending.map(row => row.requestId), [agent.requestId]);
  await queue.stop('test complete');
});
