import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateLaunchAdmissionInTransaction } from '../src/launch-state.ts';
import { evaluateResourceAdmission } from '../src/resource-admission.ts';
import {
  createResourceWaitProtocol, runResourceWaitCommand,
  type ResourceWaitClientConnection,
} from '../src/resource-wait-protocol.ts';
import { identity, options, ProtocolEnvironment, request } from './helpers/resource-wait-protocol-fixture.ts';

const GiB = 1024 ** 3;

async function protocol() {
  const env = new ProtocolEnvironment();
  const queue = createResourceWaitProtocol(options(), env.ports);
  await queue.start(env.ownerEpoch);
  return { env, queue };
}

test('Z.476 shortage tells the client and the next ANY_RUN admits', async () => {
  const { env, queue } = await protocol();
  env.admission = { status: 'HOTFIX_ONLY', reason: 'normal disk below threshold' };
  const ticket = queue.enqueue(request());
  await queue.pump();
  assert.equal(env.offers.length, 0, 'shortage must not offer a normal client');
  assert.equal(env.waiting.length, 1, 'each shortage evaluation must reach the client');
  assert.deepEqual(env.waiting[0].frame, {
    requestId: ticket.requestId,
    serviceEpoch: ticket.serviceEpoch,
    admission: env.admission,
  });
  env.admission = { status: 'ANY_RUN', reason: 'fixture available' };
  await env.clock.advanceTo(options().hostTickIntervalMs);
  await queue.pump();
  assert.equal(env.offers.length, 1, 'ANY_RUN must admit the waiting normal entry on the next host tick');
  assert.equal(await queue.ready(env.offers[0].offer, identity()), 'issued');
});

test('Z.476 a closed previous client does not block ANY_RUN admission', async () => {
  const { env, queue } = await protocol();
  const stale = queue.enqueue(request(101));
  const next = queue.enqueue(request(102));
  env.disconnected.add('connection-101');
  await queue.pump();
  assert.equal(queue.inspect().pending.some(item => item.requestId === stale.requestId), false, 'a closed client must leave the queue');
  assert.equal(env.offers.some(item => item.offer.requestId === next.requestId), true, 'ANY_RUN must admit the next entry');
  assert.equal(await queue.ready(env.offers.at(-1)!.offer, identity(102)), 'issued');
});

test('Z.476 resource wait prints every waiting frame before the permit', async () => {
  const endpoint = { endpoint: 'fixture://z476', serviceEpoch: 'epoch-1' };
  const ticket = { requestId: 'request-1', serviceEpoch: 'epoch-1' };
  const offer = { ...ticket, offerId: 'offer-1', deadline: 1000 };
  const permit = { ...ticket, grantedAt: 2000 };
  const messages: Awaited<ReturnType<ResourceWaitClientConnection['receive']>>[] = [
    { kind: 'result', result: { ...offer, kind: 'waiting', admission: { status: 'HOTFIX_ONLY', reason: 'normal disk below threshold' } } },
    { kind: 'offer', offer },
    { kind: 'result', result: { ...offer, kind: 'permit', permit } },
  ];
  const stderr: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const connection: ResourceWaitClientConnection = {
      enqueue: async () => ticket,
      receive: async () => messages.shift() ?? { kind: 'closed', reason: 'fixture EOF' },
      sendReady: async () => {},
      cancel: async () => {},
      close: async () => {},
    };
    const result = await runResourceWaitCommand(request(), options(), {
      ensureReady: async () => endpoint,
      connect: async () => connection,
      recordDuration: () => {},
    });
    assert.equal(result.exitCode, 0);
    const line = stderr.map(String).join('').split('\n').find(item => item.includes('resource-wait.waiting'));
    assert.ok(line, 'the waiting evaluation must be visible to the client');
    assert.deepEqual(JSON.parse(line), {
      kind: 'resource-wait.waiting',
      requestId: ticket.requestId,
      serviceEpoch: ticket.serviceEpoch,
      admission: { status: 'HOTFIX_ONLY', reason: 'normal disk below threshold' },
    });
  } finally {
    process.stderr.write = write;
  }
});

test('Z.476 a finished agent reservation does not keep normal below ANY_RUN', () => {
  const measurement = {
    machineId: 'z476', loadAverage1m: 0, availableCores: 8,
    totalRamBytes: 32 * GiB, availableRamBytes: 16 * GiB, memoryPressure: 'normal' as const,
    fileSystems: [{ id: 'volume', totalBytes: 100 * GiB, availableBytes: 25 * GiB }],
  };
  const requested = { ramBytes: 1, diskBytes: { volume: 1 } };
  const reservation = {
    runId: 'done', resource: 'runtime', amount: 0,
    resourceBundle: { machineId: 'z476', resources: { ramBytes: 0, diskBytes: { volume: 20 * GiB } } },
  };
  const evaluate = (state: 'finished' | 'reserved' | 'absent') => evaluateLaunchAdmissionInTransaction({
    listReservations: () => [reservation],
    getSession: () => state === 'absent' ? undefined : { runId: 'done', addressId: 'done', revision: 1, state },
  }, { requested, requiredFileSystemIds: ['volume'] }, { measurement, observedProcesses: [] }, evaluateResourceAdmission);
  assert.equal(evaluate('finished').level, 'ANY_RUN');
  assert.equal(evaluate('absent').level, 'ANY_RUN');
  assert.equal(evaluate('reserved').level, 'NO_RESOURCES');
});
