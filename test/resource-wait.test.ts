import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createResourceWaitQueue, type AdmissionSnapshot, type ResourceWaitResult } from '../src/resource-wait.ts';

const config = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));

function fixture(interval = config.resourceWait.grantIntervalMs, previous: number | null = null) {
  let time = 100_000;
  let lastGrant = previous;
  let reads = 0;
  let watches = 0;
  let unwatches = 0;
  let snapshot: AdmissionSnapshot = { status: 'ANY_RUN', reason: 'Measured admission available' };
  let reader = async () => snapshot;
  let wake: (() => Promise<void>) | undefined;
  const dead = new Set<string>();
  const grants: number[] = [];
  const timers = new Map<number, () => Promise<void>>();
  const queue = createResourceWaitQueue({ grantIntervalMs: interval, levels: constants.resourceWaitLevels }, {
    now: () => time,
    readSnapshot: async () => { reads++; return reader(); },
    isClientAlive: id => !dead.has(id),
    watchResources: callback => { watches++; wake = callback; return () => { unwatches++; }; },
    schedule: (at, callback) => { timers.set(at, callback); return () => { timers.delete(at); }; },
    loadLastGrant: () => lastGrant,
    saveLastGrant: at => { lastGrant = at; grants.push(at); },
  });
  return {
    queue, dead, grants, timers,
    stats: () => ({ reads, watches, unwatches }),
    time: (value: number) => { time = value; },
    snapshot: (value: AdmissionSnapshot) => { snapshot = value; },
    reader: (value: () => Promise<AdmissionSnapshot>) => { reader = value; },
    wake: async () => { assert.ok(wake); await wake(); },
  };
}

function permit(result: ResourceWaitResult, level: string, at: number) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.kind, 'permit');
  if (result.kind !== 'permit') assert.fail(result.reason);
  assert.equal(result.level, level);
  assert.equal(result.grantedAt, at);
  assert.equal(result.reservation, false);
}

function failure(result: ResourceWaitResult) {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.kind, 'error');
  if (result.kind !== 'error') assert.fail('Expected diagnostic error');
  assert.ok(result.reason.trim());
  assert.ok(result.details.trim());
  assert.ok(result.remediation.trim());
}

test('later hotfix precedes normal requests while equal priorities retain FIFO', async () => {
  const f = fixture();
  const first = f.queue.enqueue({ clientId: 'first', level: 'normal' });
  const second = f.queue.enqueue({ clientId: 'second', level: 'normal' });
  const hotfix = f.queue.enqueue({ clientId: 'hotfix', level: 'hotfix' });
  await f.queue.pump();
  permit(await hotfix.result, 'hotfix', 100_000);
  assert.deepEqual(f.queue.inspect().pending, [first.id, second.id]);
  f.time(100_000 + config.resourceWait.grantIntervalMs);
  await f.queue.pump();
  permit(await first.result, 'normal', 100_000 + config.resourceWait.grantIntervalMs);
  f.time(100_000 + 2 * config.resourceWait.grantIntervalMs);
  await f.queue.pump();
  permit(await second.result, 'normal', 100_000 + 2 * config.resourceWait.grantIntervalMs);
  assert.deepEqual(f.queue.inspect().pending, []);
});

test('configured global interval applies across levels and concurrent pump calls', async () => {
  const f = fixture(23_000);
  const hotfix = f.queue.enqueue({ clientId: 'a', level: 'hotfix' });
  const normal = f.queue.enqueue({ clientId: 'b', level: 'normal' });
  await Promise.all([f.queue.pump(), f.queue.pump(), f.queue.pump()]);
  permit(await hotfix.result, 'hotfix', 100_000);
  f.time(122_999);
  await f.queue.pump();
  assert.deepEqual(f.grants, [100_000]);
  assert.deepEqual(f.queue.inspect().pending, [normal.id]);
  f.time(123_000);
  await f.queue.pump();
  permit(await normal.result, 'normal', 123_000);
});

test('head cancellation and silent client death neither consume grant nor restart cooldown', async () => {
  const f = fixture();
  const controller = new AbortController();
  const canceled = f.queue.enqueue({ clientId: 'canceled', level: 'hotfix', signal: controller.signal });
  const dead = f.queue.enqueue({ clientId: 'dead', level: 'normal' });
  const live = f.queue.enqueue({ clientId: 'live', level: 'normal' });
  controller.abort(new Error('external timeout'));
  f.dead.add('dead');
  await f.queue.pump();
  failure(await canceled.result);
  failure(await dead.result);
  permit(await live.result, 'normal', 100_000);
  assert.deepEqual(f.grants, [100_000]);
  assert.deepEqual(f.queue.inspect().pending, []);
});

test('abort during asynchronous measurement wins before permit commit', async () => {
  const f = fixture();
  const measurement = Promise.withResolvers<AdmissionSnapshot>();
  const started = Promise.withResolvers<void>();
  f.reader(() => { started.resolve(); return measurement.promise; });
  const controller = new AbortController();
  const request = f.queue.enqueue({ clientId: 'a', level: 'normal', signal: controller.signal });
  const pumping = f.queue.pump();
  await started.promise;
  controller.abort();
  measurement.resolve({ status: 'ANY_RUN', reason: 'Measured' });
  await pumping;
  failure(await request.result);
  assert.deepEqual(f.grants, []);
  assert.equal(f.queue.inspect().lastGrantedAt, null);
});

test('client death during measurement is rechecked at commit without explicit cancel', async () => {
  const f = fixture();
  const measurement = Promise.withResolvers<AdmissionSnapshot>();
  const started = Promise.withResolvers<void>();
  f.reader(() => { started.resolve(); return measurement.promise; });
  const request = f.queue.enqueue({ clientId: 'a', level: 'normal' });
  const pumping = f.queue.pump();
  await started.promise;
  f.dead.add('a');
  measurement.resolve({ status: 'ANY_RUN', reason: 'Measured' });
  await pumping;
  failure(await request.result);
  assert.deepEqual(f.grants, []);
  assert.deepEqual(f.queue.inspect().pending, []);
});

test('one shared monitor serves many waiters and blocked queues do not busy poll', async () => {
  const f = fixture();
  f.snapshot({ status: 'NO_RESOURCES', reason: 'Memory pressure' });
  const requests = Array.from({ length: 100 }, (_, i) => f.queue.enqueue({ clientId: `client-${i}`, level: 'normal' }));
  await f.wake();
  assert.equal(f.stats().watches, 1);
  assert.equal(f.stats().reads, 1);
  assert.ok(f.timers.size <= 1);
  assert.equal(f.queue.inspect().pending.length, 100);
  assert.deepEqual(f.grants, []);
  f.queue.close('service stopped');
  for (const request of requests) failure(await request.result);
  assert.equal(f.stats().unwatches, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.queue.inspect().pending, []);
});

test('admission levels are reused and resources are checked again before next grant', async () => {
  const f = fixture();
  const normal = f.queue.enqueue({ clientId: 'normal', level: 'normal' });
  const hotfix = f.queue.enqueue({ clientId: 'hotfix', level: 'hotfix' });
  f.snapshot({ status: 'HOTFIX_ONLY', reason: 'Normal threshold unavailable' });
  await f.queue.pump();
  permit(await hotfix.result, 'hotfix', 100_000);
  f.time(100_000 + config.resourceWait.grantIntervalMs);
  f.snapshot({ status: 'NO_RESOURCES', reason: 'Critical pressure' });
  await f.queue.pump();
  assert.deepEqual(f.queue.inspect().pending, [normal.id]);
  assert.deepEqual(f.grants, [100_000]);
  f.snapshot({ status: 'ANY_RUN', reason: 'Recovered' });
  await f.wake();
  permit(await normal.result, 'normal', 100_000 + config.resourceWait.grantIntervalMs);
});

for (const level of [undefined, 'invented']) {
  test(`invalid level ${String(level)} reports allowed values and example without enqueue`, async () => {
    const f = fixture();
    const request = f.queue.enqueue({ clientId: 'a', level });
    const result = await request.result;
    failure(result);
    assert.match(JSON.stringify(result), /hotfix/);
    assert.match(JSON.stringify(result), /normal/);
    assert.match(JSON.stringify(result), /raf resource wait --level/);
    assert.deepEqual(f.queue.inspect().pending, []);
    assert.deepEqual(f.grants, []);
    assert.equal(f.stats().reads, 0);
  });
}

test('unknown measurements and collection failures produce diagnostic nonzero results', async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    f.reader(async () => {
      if (throws) throw new Error('RAM source unavailable');
      return { status: 'UNKNOWN', reason: 'RAM source unavailable' };
    });
    const request = f.queue.enqueue({ clientId: 'a', level: 'normal' });
    await f.queue.pump();
    const result = await request.result;
    failure(result);
    assert.match(JSON.stringify(result), /RAM source unavailable/);
    assert.deepEqual(f.grants, []);
    assert.deepEqual(f.queue.inspect().pending, []);
  }
});

test('restart restores only last actual grant and never abandoned pending requests', async () => {
  const f = fixture(config.resourceWait.grantIntervalMs, 99_999);
  assert.deepEqual(f.queue.inspect().pending, []);
  const request = f.queue.enqueue({ clientId: 'new-client', level: 'hotfix' });
  await f.queue.pump();
  assert.deepEqual(f.grants, []);
  f.time(99_999 + config.resourceWait.grantIntervalMs);
  await f.queue.pump();
  permit(await request.result, 'hotfix', 99_999 + config.resourceWait.grantIntervalMs);
});

test('explicit cancellation during cooldown leaves the original next grant time intact', async () => {
  const f = fixture();
  const granted = f.queue.enqueue({ clientId: 'first', level: 'normal' });
  await f.queue.pump();
  permit(await granted.result, 'normal', 100_000);
  const canceled = f.queue.enqueue({ clientId: 'second', level: 'normal' });
  const survivor = f.queue.enqueue({ clientId: 'third', level: 'normal' });
  f.time(100_001);
  f.queue.cancel(canceled.id, 'client disconnected');
  f.queue.cancel(canceled.id, 'duplicate disconnect');
  failure(await canceled.result);
  assert.equal(f.queue.inspect().lastGrantedAt, 100_000);
  assert.deepEqual(f.queue.inspect().pending, [survivor.id]);
  f.time(100_000 + config.resourceWait.grantIntervalMs);
  await f.queue.pump();
  permit(await survivor.result, 'normal', 100_000 + config.resourceWait.grantIntervalMs);
});

test('an already aborted caller cannot enter the queue or consume a permit', async () => {
  const f = fixture();
  const request = f.queue.enqueue({ clientId: 'a', level: 'hotfix', signal: AbortSignal.abort() });
  failure(await request.result);
  await f.queue.pump();
  assert.deepEqual(f.queue.inspect().pending, []);
  assert.deepEqual(f.grants, []);
});

test('service closure during measurement fails pending requests and prevents late grants', async () => {
  const f = fixture();
  const measurement = Promise.withResolvers<AdmissionSnapshot>();
  const started = Promise.withResolvers<void>();
  f.reader(() => { started.resolve(); return measurement.promise; });
  const request = f.queue.enqueue({ clientId: 'a', level: 'normal' });
  const pumping = f.queue.pump();
  await started.promise;
  f.queue.close('service connection lost');
  measurement.resolve({ status: 'ANY_RUN', reason: 'Measured' });
  await pumping;
  const result = await request.result;
  failure(result);
  assert.match(JSON.stringify(result), /service connection lost/);
  assert.deepEqual(f.grants, []);
  assert.deepEqual(f.queue.inspect().pending, []);
});
