import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceMainHandover,
  assertMainSlotReusable,
  beginMainHandover,
  drainMainFacts,
  finishMainOperation,
  loadPinnedMainAsset,
  pinMainOperation,
  recordMainFact,
  recoverMainHandover,
} from '../src/main-generation-handover.ts';
import type {
  ComponentOwner,
  ComponentRole,
  FactKind,
  HandoverContext,
  HandoverRuntime,
  HandoverState,
  HandoverStore,
  MainGeneration,
  OwnerToken,
  PendingFact,
  PinnedOperation,
  ProtocolKind,
  ReadinessProof,
} from '../src/main-generation-handover.ts';

const roles: ComponentRole[] = ['service', 'worker', 'notice'];
const protocolKinds: ProtocolKind[] = ['report', 'event', 'message', 'reminder', 'address'];
const factKinds: FactKind[] = ['report', 'event', 'message', 'reminder'];
const duties: Record<ComponentRole, string[]> = {
  service: ['bugs', 'resource-wait'],
  worker: ['reports', 'events', 'messages'],
  notice: ['reminders'],
};

function generation(id: string, protocol: number): MainGeneration {
  return {
    id,
    root: `/isolated/main-${id.toLowerCase()}`,
    published: true,
    protocols: Object.fromEntries(protocolKinds.map(kind => [kind, {
      emits: protocol,
      accepts: [1, 2],
    }])) as MainGeneration['protocols'],
  };
}

function fixture() {
  const runner = {
    address: 'agent-original', runId: 'run-original', pid: 41001,
    startedAt: '2026-10-23T00:00:00.000Z', session: 'session-original',
    runnerSessionId: 'runner-session-original', tmp: '/isolated/tmp/run-original',
    report: '/isolated/tmp/run-original/session-original.json',
  };
  let persisted: HandoverState = {
    activeGeneration: 'A',
    generations: { A: generation('A', 1), B: generation('B', 2) },
    owners: Object.fromEntries(roles.map(role => [`A-${role}`, {
      ownerId: `A-${role}`, role, generation: 'A', epoch: 1, phase: 'active',
    }])),
    activeOwners: { service: 'A-service', worker: 'A-worker', notice: 'A-notice' },
    operations: {}, runners: { [runner.runId]: runner }, facts: {}, transition: null,
    resourceWait: { queue: ['wait-first', 'wait-second'], lastGrant: 12345 },
    bugSync: { cursor: 'bugs-cursor-original' },
  };
  let serial: Promise<unknown> = Promise.resolve();
  const store: HandoverStore = {
    async read() { await serial; return structuredClone(persisted); },
    transaction<T>(update: (state: HandoverState) => T): Promise<T> {
      const result = serial.then(() => {
        const draft = structuredClone(persisted);
        const value = update(draft);
        persisted = draft;
        return structuredClone(value);
      });
      serial = result.catch(() => undefined);
      return result;
    },
  };
  const live = new Set(roles.map(role => `A-${role}`));
  const ready = new Map<string, ReadinessProof>();
  const starts: Array<{ owner: ComponentOwner; duties: string[] }> = [];
  const stops: string[] = [];
  const effects = new Map<string, PendingFact>();
  const attempts: Array<{ owner: OwnerToken; factId: string; key: string }> = [];
  const runnerActions: string[] = [];
  const assets: Array<{ root: string; kind: string }> = [];
  const checkpoints: HandoverState[] = [];
  let loseAcknowledgement = false;
  const runtime: HandoverRuntime = {
    async start(owner, assignedDuties) {
      starts.push({ owner: structuredClone(owner), duties: [...assignedDuties] });
      live.add(owner.ownerId);
    },
    async readiness(owner) { return ready.get(owner.ownerId) ?? null; },
    async isAlive(owner) { return live.has(owner.ownerId); },
    async stop(owner) {
      checkpoints.push(await store.read());
      stops.push(owner.ownerId);
      live.delete(owner.ownerId);
    },
    async loadAsset(root, kind) {
      assets.push({ root, kind });
      assert.ok(['/isolated/main-a', '/isolated/main-b'].includes(root));
      return `${root}:${kind}`;
    },
    async acceptFact(owner, fact, key) {
      const state = await store.read();
      const role = fact.kind === 'reminder' ? 'notice' : 'worker';
      const active = state.owners[state.activeOwners[role]];
      assert.equal(owner.ownerId, active.ownerId, 'only the durable observation owner may accept');
      assert.equal(owner.epoch, active.epoch, 'stale epochs must be fenced');
      assert.ok(live.has(owner.ownerId), 'a dead observer cannot deliver');
      assert.equal(fact.runId, runner.runId);
      assert.equal(fact.address, runner.address);
      attempts.push({ owner: structuredClone(owner), factId: fact.id, key });
      const previous = effects.get(key);
      if (previous) assert.deepEqual(previous, fact, 'idempotency key must not merge distinct facts');
      else effects.set(key, structuredClone(fact));
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        live.delete(owner.ownerId);
        throw new Error('OBSERVER_DIED_AFTER_ACCEPT');
      }
    },
    async runnerAction(action, runId) {
      runnerActions.push(`${action}:${runId}`);
      assert.fail('handover must preserve runner and its temporary directory');
    },
  };
  const context: HandoverContext = { store, runtime };
  async function publish(target: string): Promise<void> {
    await store.transaction(state => { state.activeGeneration = target; });
  }
  async function readyTargets(): Promise<void> {
    const state = await store.read();
    assert.ok(state.transition);
    for (const id of Object.values(state.transition.newOwners)) {
      const owner = state.owners[id];
      ready.set(id, { ownerId: id, epoch: owner.epoch, restored: true });
    }
  }
  async function active(role: ComponentRole): Promise<ComponentOwner> {
    const state = await store.read();
    return state.owners[state.activeOwners[role]];
  }
  async function invariant(): Promise<void> {
    const state = await store.read();
    assert.deepEqual(state.runners, { [runner.runId]: runner });
    assert.deepEqual(state.resourceWait, { queue: ['wait-first', 'wait-second'], lastGrant: 12345 });
    assert.deepEqual(state.bugSync, { cursor: 'bugs-cursor-original' });
    assert.deepEqual(runnerActions, []);
    for (const role of roles) {
      const owners = Object.values(state.owners).filter(owner => owner.role === role && owner.phase === 'active');
      assert.equal(owners.length, 1, `exactly one durable owner for ${role}`);
      assert.equal(owners[0].ownerId, state.activeOwners[role]);
    }
    for (const start of starts) assert.deepEqual([...start.duties].sort(), [...duties[start.owner.role]].sort());
  }
  function fact(kind: FactKind, id: string, source = 'A'): PendingFact {
    return {
      id, kind, address: runner.address, runId: runner.runId, generation: source,
      protocol: source === 'A' ? 1 : 2,
      payload: kind === 'report' ? { status: 'succeeded', reportPath: runner.report } : { text: id },
    };
  }
  return {
    context, store, runtime, live, ready, starts, stops, effects, attempts, assets, checkpoints,
    publish, readyTargets, active, invariant, fact,
    loseNextAcknowledgement() { loseAcknowledgement = true; },
  };
}

async function switchTo(f: ReturnType<typeof fixture>, target = 'B'): Promise<string> {
  await f.publish(target);
  const id = await beginMainHandover(f.context, target);
  await f.readyTargets();
  assert.equal((await advanceMainHandover(f.context, id)).status, 'complete');
  await f.invariant();
  return id;
}

for (const kind of ['cli', 'bug-sync', 'resource-wait', 'worker-import', 'hook-notice'] as PinnedOperation['kind'][]) {
  test(`handover pins ${kind} catalog and deferred import until its old operation drains`, async () => {
    const f = fixture();
    const role = kind === 'bug-sync' || kind === 'resource-wait' ? 'service' : kind === 'hook-notice' ? 'notice' : 'worker';
    const operation = await pinMainOperation(f.context, { id: 'in-flight', ownerId: `A-${role}`, kind });
    assert.equal(operation.generation, 'A');
    assert.equal(await loadPinnedMainAsset(f.context, operation.id, 'catalog'), '/isolated/main-a:catalog');
    await f.publish('B');
    const id = await beginMainHandover(f.context, 'B');
    await f.readyTargets();
    assert.equal(await loadPinnedMainAsset(f.context, operation.id, 'module'), '/isolated/main-a:module');
    assert.equal((await advanceMainHandover(f.context, id)).status, 'waiting');
    assert.ok(f.live.has(`A-${role}`), 'old owner must drain on its pinned code');
    await assert.rejects(assertMainSlotReusable(f.context, 'A'), /SLOT_IN_USE/);
    await finishMainOperation(f.context, operation.id);
    assert.equal((await advanceMainHandover(f.context, id)).status, 'complete');
    const next = await pinMainOperation(f.context, {
      id: 'next-operation', ownerId: (await f.active(role)).ownerId, kind,
    });
    assert.equal(next.generation, 'B');
    assert.equal(await loadPinnedMainAsset(f.context, next.id, 'catalog'), '/isolated/main-b:catalog');
    assert.equal(await loadPinnedMainAsset(f.context, next.id, 'module'), '/isolated/main-b:module');
    assert.deepEqual(f.assets.map(asset => asset.root), [
      '/isolated/main-a', '/isolated/main-a', '/isolated/main-b', '/isolated/main-b',
    ]);
    await f.invariant();
  });
}

test('handover requires explicit service, worker and notice readiness before retiring any old owner', async () => {
  const f = fixture();
  await f.publish('B');
  const id = await beginMainHandover(f.context, 'B');
  assert.equal((await advanceMainHandover(f.context, id)).status, 'waiting');
  assert.deepEqual(f.stops, []);
  assert.equal(f.starts.length, roles.length);
  assert.deepEqual((await f.store.read()).activeOwners, {
    service: 'A-service', worker: 'A-worker', notice: 'A-notice',
  });
  const state = await f.store.read();
  assert.ok(state.transition);
  const targetIds = Object.values(state.transition.newOwners);
  for (const targetId of targetIds.slice(0, -1)) {
    const owner = state.owners[targetId];
    f.ready.set(targetId, { ownerId: targetId, epoch: owner.epoch, restored: true });
  }
  assert.equal((await advanceMainHandover(f.context, id)).status, 'waiting');
  assert.deepEqual(f.stops, []);
  await f.readyTargets();
  assert.equal((await advanceMainHandover(f.context, id)).status, 'complete');
  for (const role of roles) assert.equal((await f.active(role)).generation, 'B');
  assert.deepEqual([...f.stops].sort(), roles.map(role => `A-${role}`).sort());
  for (const checkpoint of f.checkpoints) {
    for (const role of roles) assert.equal(checkpoint.owners[checkpoint.activeOwners[role]].generation, 'B');
  }
  await assertMainSlotReusable(f.context, 'A');
  await f.invariant();
});

for (const proof of ['wrong-epoch', 'wrong-owner', 'not-restored', 'dead-process']) {
  test(`handover rejects readiness evidence: ${proof}`, async () => {
    const f = fixture();
    await f.publish('B');
    const id = await beginMainHandover(f.context, 'B');
    await f.readyTargets();
    const state = await f.store.read();
    assert.ok(state.transition);
    const worker = state.owners[state.transition.newOwners.worker];
    if (proof === 'wrong-epoch') f.ready.set(worker.ownerId, { ...worker, epoch: worker.epoch - 1, restored: true });
    if (proof === 'wrong-owner') f.ready.set(worker.ownerId, { ...worker, ownerId: 'foreign-owner', restored: true });
    if (proof === 'not-restored') f.ready.set(worker.ownerId, { ...worker, restored: false });
    if (proof === 'dead-process') f.live.delete(worker.ownerId);
    assert.notEqual((await advanceMainHandover(f.context, id)).status, 'complete');
    assert.equal((await f.active('worker')).ownerId, 'A-worker');
    assert.deepEqual(f.stops, []);
    await assert.rejects(assertMainSlotReusable(f.context, 'A'), /SLOT_IN_USE/);
    await f.invariant();
  });
}

for (const timing of ['before', 'during', 'after']) {
  test(`report committed ${timing} handover is accepted exactly once with its original run identity`, async () => {
    const f = fixture();
    const report = f.fact('report', `report-${timing}`);
    if (timing === 'before') {
      await recordMainFact(f.context, report);
      await drainMainFacts(f.context, await f.active('worker'));
    }
    await f.publish('B');
    const id = await beginMainHandover(f.context, 'B');
    if (timing === 'during') await recordMainFact(f.context, report);
    await f.readyTargets();
    assert.equal((await advanceMainHandover(f.context, id)).status, 'complete');
    if (timing === 'after') await recordMainFact(f.context, report);
    await drainMainFacts(f.context, await f.active('worker'));
    await recordMainFact(f.context, report);
    await drainMainFacts(f.context, await f.active('worker'));
    await recoverMainHandover({ store: f.store, runtime: f.runtime });
    assert.deepEqual([...f.effects.values()], [report]);
    assert.equal(f.attempts.length, 1);
    const stored = (await f.store.read()).facts[report.id];
    assert.equal(stored.status, 'accepted');
    assert.deepEqual(stored.fact, report);
    await f.invariant();
  });
}

test('old observer death before readiness preserves pending report and permits durable recovery', async () => {
  const f = fixture();
  await f.publish('B');
  const id = await beginMainHandover(f.context, 'B');
  const report = f.fact('report', 'report-with-dead-old-owner');
  await recordMainFact(f.context, report);
  f.live.delete('A-worker');
  assert.notEqual((await recoverMainHandover({ store: f.store, runtime: f.runtime })).status, 'complete');
  assert.equal((await f.store.read()).facts[report.id].status, 'pending');
  assert.equal(f.effects.size, 0);
  await f.readyTargets();
  assert.equal((await advanceMainHandover(f.context, id)).status, 'complete');
  await drainMainFacts(f.context, await f.active('worker'));
  await recoverMainHandover({ store: f.store, runtime: f.runtime });
  await recoverMainHandover({ store: f.store, runtime: f.runtime });
  assert.deepEqual([...f.effects.values()], [report]);
  assert.equal(f.attempts.length, 1);
  await f.invariant();
});

test('pending events, addressed messages and reminders survive recovery and are fenced against old owners', async () => {
  const f = fixture();
  const pending = factKinds.map(kind => f.fact(kind, `pending-${kind}`));
  await Promise.all(pending.map(fact => recordMainFact(f.context, fact)));
  await switchTo(f);
  const starts = f.starts.length;
  for (let retry = 0; retry < 3; retry++) {
    await recoverMainHandover({ store: f.store, runtime: f.runtime });
    await drainMainFacts(f.context, await f.active('worker'));
    await drainMainFacts(f.context, await f.active('notice'));
  }
  assert.equal(f.starts.length, starts, 'completed recovery must not spawn duplicate components');
  assert.deepEqual([...f.effects.values()].map(fact => fact.id).sort(), pending.map(fact => fact.id).sort());
  assert.equal(f.attempts.length, pending.length);
  await assert.rejects(drainMainFacts(f.context, { ownerId: 'A-worker', epoch: 1 }), /OWNER_FENCED/);
  await assert.rejects(drainMainFacts(f.context, { ...(await f.active('worker')), epoch: 0 }), /OWNER_FENCED/);
  await assert.rejects(drainMainFacts(f.context, await f.active('service')), /ROLE_FORBIDDEN/);
  for (const row of Object.values((await f.store.read()).facts)) assert.equal(row.status, 'accepted');
  await f.invariant();
});

test('death after accepting a fact but before its acknowledgement recovers without duplicate effects', async () => {
  const f = fixture();
  const report = f.fact('report', 'acknowledgement-lost');
  await recordMainFact(f.context, report);
  f.loseNextAcknowledgement();
  await assert.rejects(drainMainFacts(f.context, await f.active('worker')), /OBSERVER_DIED_AFTER_ACCEPT/);
  assert.equal((await f.store.read()).facts[report.id].status, 'pending');
  assert.equal(f.effects.size, 1);
  await switchTo(f);
  await recoverMainHandover({ store: f.store, runtime: f.runtime });
  await drainMainFacts(f.context, await f.active('worker'));
  await drainMainFacts(f.context, await f.active('worker'));
  assert.equal((await f.store.read()).facts[report.id].status, 'accepted');
  assert.deepEqual([...f.effects.values()], [report]);
  assert.equal(new Set(f.attempts.map(attempt => attempt.key)).size, 1);
  await f.invariant();
});

test('a new observer dying before takeover is replaced from durable state without retiring the old observer', async () => {
  const f = fixture();
  await f.publish('B');
  await beginMainHandover(f.context, 'B');
  await f.readyTargets();
  const initial = await f.store.read();
  assert.ok(initial.transition);
  const dead = initial.owners[initial.transition.newOwners.worker];
  f.live.delete(dead.ownerId);
  const report = f.fact('report', 'new-observer-died');
  await recordMainFact(f.context, report);
  assert.equal((await recoverMainHandover({ store: f.store, runtime: f.runtime })).status, 'waiting');
  assert.equal((await f.active('worker')).ownerId, 'A-worker');
  assert.ok(f.live.has('A-worker'));
  assert.equal((await f.store.read()).facts[report.id].status, 'pending');
  const recovered = await f.store.read();
  assert.ok(recovered.transition);
  const replacement = recovered.owners[recovered.transition.newOwners.worker];
  assert.notEqual(replacement.ownerId, dead.ownerId);
  assert.ok(replacement.epoch > dead.epoch);
  await f.readyTargets();
  assert.equal((await recoverMainHandover({ store: f.store, runtime: f.runtime })).status, 'complete');
  await drainMainFacts(f.context, await f.active('worker'));
  await assert.rejects(drainMainFacts(f.context, dead), /OWNER_FENCED/);
  assert.deepEqual([...f.effects.values()], [report]);
  await f.invariant();
});

test('rollback after the new observer dies preserves pending facts and does not reuse its old epoch', async () => {
  const f = fixture();
  await switchTo(f);
  const dead = await f.active('worker');
  f.live.delete(dead.ownerId);
  const report = f.fact('report', 'rollback-pending-report', 'B');
  await recordMainFact(f.context, report);
  await switchTo(f, 'A');
  await drainMainFacts(f.context, await f.active('worker'));
  await recoverMainHandover({ store: f.store, runtime: f.runtime });
  await assert.rejects(drainMainFacts(f.context, dead), /OWNER_FENCED/);
  assert.equal((await f.store.read()).facts[report.id].status, 'accepted');
  assert.deepEqual([...f.effects.values()], [report]);
  await f.invariant();
});

test('worker report and message processing remains independent of service readiness and service lifetime', async () => {
  const f = fixture();
  f.live.delete('A-service');
  const pending = [f.fact('report', 'no-service-report'), f.fact('message', 'no-service-message')];
  for (const fact of pending) await recordMainFact(f.context, fact);
  await drainMainFacts(f.context, await f.active('worker'));
  assert.deepEqual([...f.effects.values()], pending);
  assert.deepEqual(f.starts, [], 'direct agent operations must not autostart a service');
  assert.deepEqual(f.stops, []);
  await f.invariant();
});

test('concurrent drains and concurrent recovery retain one ownership transition and one fact acceptance', async () => {
  const f = fixture();
  const report = f.fact('report', 'concurrent-report');
  await recordMainFact(f.context, report);
  await f.publish('B');
  const [first, second] = await Promise.all([
    beginMainHandover(f.context, 'B'), beginMainHandover({ store: f.store, runtime: f.runtime }, 'B'),
  ]);
  assert.equal(first, second);
  await f.readyTargets();
  await Promise.all([
    recoverMainHandover(f.context), recoverMainHandover({ store: f.store, runtime: f.runtime }),
  ]);
  const owner = await f.active('worker');
  await Promise.all([drainMainFacts(f.context, owner), drainMainFacts(f.context, owner)]);
  assert.equal(f.starts.length, roles.length);
  assert.deepEqual([...f.effects.values()], [report]);
  assert.equal(new Set(f.attempts.map(attempt => attempt.key)).size, 1);
  await f.invariant();
});

for (const kind of protocolKinds) {
  for (const direction of ['A-to-B', 'B-to-A']) {
    test(`handover refuses incompatible ${kind} protocol in ${direction} before component changes`, async () => {
      const f = fixture();
      await f.store.transaction(state => {
        const reader = direction === 'A-to-B' ? 'B' : 'A';
        state.generations[reader].protocols[kind].accepts = [reader === 'A' ? 1 : 2];
      });
      await f.publish('B');
      await assert.rejects(beginMainHandover(f.context, 'B'), /PROTOCOL_INCOMPATIBLE/);
      assert.deepEqual(f.starts, []);
      assert.deepEqual(f.stops, []);
      await assert.rejects(assertMainSlotReusable(f.context, 'A'), /SLOT_IN_USE/);
      assert.equal((await f.active('worker')).generation, 'A');
      await f.invariant();
    });
  }
}

test('reverse handover accepts facts from both protocol versions and preserves the live runner', async () => {
  const f = fixture();
  await switchTo(f);
  await assertMainSlotReusable(f.context, 'A');
  const pending = factKinds.flatMap(kind => ['A', 'B'].map(source => f.fact(kind, `${source}-${kind}`, source)));
  for (const fact of pending) await recordMainFact(f.context, fact);
  await f.publish('A');
  const reverse = await beginMainHandover(f.context, 'A');
  assert.equal((await advanceMainHandover(f.context, reverse)).status, 'waiting');
  await assert.rejects(assertMainSlotReusable(f.context, 'B'), /SLOT_IN_USE/);
  await f.readyTargets();
  assert.equal((await advanceMainHandover(f.context, reverse)).status, 'complete');
  await drainMainFacts(f.context, await f.active('worker'));
  await drainMainFacts(f.context, await f.active('notice'));
  await recoverMainHandover({ store: f.store, runtime: f.runtime });
  for (const role of roles) {
    const owner = await f.active(role);
    assert.equal(owner.generation, 'A');
    assert.notEqual(owner.ownerId, `A-${role}`, 'returning to A requires a fresh ownership identity');
    assert.ok(owner.epoch > 1, 'an old A token must stay fenced after rollback');
  }
  assert.equal(f.effects.size, pending.length);
  assert.deepEqual([...f.effects.values()].map(fact => fact.id).sort(), pending.map(fact => fact.id).sort());
  await assert.rejects(drainMainFacts(f.context, { ownerId: 'A-worker', epoch: 1 }), /OWNER_FENCED/);
  await assertMainSlotReusable(f.context, 'B');
  await f.invariant();
});

test('slot preparation is blocked by handover, active ownership or any outstanding operation lease', async () => {
  const f = fixture();
  await assert.rejects(assertMainSlotReusable(f.context, 'A'), /SLOT_IN_USE/);
  await assertMainSlotReusable(f.context, 'B');
  await f.publish('B');
  const id = await beginMainHandover(f.context, 'B');
  for (const slot of ['A', 'B']) await assert.rejects(assertMainSlotReusable(f.context, slot), /SLOT_IN_USE/);
  await assert.rejects(beginMainHandover(f.context, 'A'), /HANDOVER_IN_PROGRESS/);
  await f.readyTargets();
  assert.equal((await advanceMainHandover(f.context, id)).status, 'complete');
  await f.store.transaction(state => {
    state.operations['legacy-reader'] = { id: 'legacy-reader', ownerId: 'legacy-cli', generation: 'A', kind: 'cli' };
  });
  const before = await f.store.read();
  await assert.rejects(assertMainSlotReusable(f.context, 'A'), /SLOT_IN_USE/);
  assert.deepEqual(await f.store.read(), before, 'a failed preparation gate cannot erase ownership or facts');
  await finishMainOperation(f.context, 'legacy-reader');
  await assertMainSlotReusable(f.context, 'A');
  await f.invariant();
});

test('retired metadata alone cannot release a slot while the old process is still reading it', async () => {
  const f = fixture();
  f.runtime.stop = async owner => { f.stops.push(owner.ownerId); };
  await f.publish('B');
  const id = await beginMainHandover(f.context, 'B');
  await f.readyTargets();
  assert.notEqual((await advanceMainHandover(f.context, id)).status, 'complete');
  await assert.rejects(assertMainSlotReusable(f.context, 'A'), /SLOT_IN_USE/);
  for (const role of roles) f.live.delete(`A-${role}`);
  assert.equal((await recoverMainHandover({ store: f.store, runtime: f.runtime })).status, 'complete');
  await assertMainSlotReusable(f.context, 'A');
  await f.invariant();
});
