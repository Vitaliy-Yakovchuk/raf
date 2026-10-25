import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { openStateStore } from '../src/state-store.ts';
import { createAgentQueueState } from '../src/agent-queue-state.ts';
import { createProductionAgentQueue, reconcileFinishedAgentQueues } from '../src/production-agent-queue.ts';
import { runAgentWithQueue, type AgentQueueProcess, type AgentQueueRecord, type AgentRunQueuePorts } from '../src/agent-run-queue.ts';
import type { RuntimeConfiguration, RuntimeContext, RuntimeReservationInput, RuntimeServices } from '../src/app-runtime.ts';
import type { AdmissionSnapshot } from '../src/admission-snapshot.ts';
import type { ProcessIdentity, SessionRecord } from '../src/session-state.ts';
import type { ReservationProcessIdentity, ReservedTaskSnapshot } from '../src/task-reservations.ts';

async function fixture(t: TestContext, waited: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-start-result-'));
  const statePath = join(directory, 'state.sqlite');
  const store = openStateStore(statePath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const queue = createAgentQueueState(store);
  const current = (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
  const input: RuntimeReservationInput = {
    runId: 'start-result-run', addressId: 'start-result-worker', tmuxSession: 'start-result-worker',
    activity: { type: 'implement', project: 'raf', phase: 'implement', features: ['fix-raf-load-admission'], cwd: directory },
    assignment: { root: directory, changes: [{ id: 'fix-raf-load-admission', items: [{ id: '6.8.1', description: 'implement start result' }] }], baselineArchives: [] },
    selection: { status: 'selected', runner: 'codex', model: 'fixture', effort: 'high', reason: 'unit fixture', quota: 'available' },
    statePath, tmpRoot: directory, reportPath: join(directory, 'report.json'),
    requested: { ramBytes: 8, diskBytes: { fixture: 16 } }, requiredFileSystemIds: ['fixture'],
  };
  const calls = { start: 0, commit: 0, compensate: 0, abort: 0, cleanReport: 0 };
  const api: Pick<RuntimeServices, 'commitStarted' | 'compensate' | 'abortLaunch' | 'reserve'> = {
    commitStarted: async (runId: string, identity: ProcessIdentity) => {
      calls.commit++;
      const session = current(runId);
      return session?.state === 'running' && isDeepStrictEqual(session.process, identity);
    },
    compensate: async () => { calls.compensate++; return { stopped: false, reason: 'fixture keeps the verified live worker' }; },
    abortLaunch: async () => { calls.abort++; },
    reserve: async () => ({ admitted: true, admission }),
  };
  const dependencies: Parameters<typeof createProductionAgentQueue>[1] = {
    store, context: {
      orchestratorRoot: directory, confRoot: directory, artifactPath: directory, statePath,
      tmpRoot: directory, mode: 'test', commandStartedAtMs: Date.now(), resolveCaller: async () => undefined,
    } satisfies RuntimeContext,
    api: api as RuntimeServices, configuration: {} as RuntimeConfiguration, current, caller: async () => undefined,
    observe: async identity => ({ state: 'alive', identity, observedAt: '2026-10-24T00:00:00Z' }),
    reconcile: async () => {}, cleanReport: async () => { calls.cleanReport++; },
  };
  const production = await createProductionAgentQueue(input, dependencies);
  let record!: AgentQueueRecord;
  const validation = { assignment: input.assignment, fingerprint: 'start-result-assignment', requested: input.requested,
    requiredFileSystemIds: input.requiredFileSystemIds };
  const task: ReservedTaskSnapshot = { key: { project: 'raf', changeId: 'fix-raf-load-admission', taskId: '6.8.1' },
    changeInstance: 'start-result-instance', fingerprint: 'start-result-task' };
  const identity: ReservationProcessIdentity = {
    pid: 4242, startedAt: '2026-10-24T00:00:00Z', runner: 'codex', runnerSessionId: 'native-start-result',
    tmuxSession: input.tmuxSession, evidence: { machineId: production.request.clientIdentity.machineId,
      bootId: production.request.clientIdentity.bootId, runId: input.runId },
  };
  const process: AgentQueueProcess = { pid: identity.pid, startedAt: identity.startedAt, runner: identity.runner,
    runnerSessionId: identity.runnerSessionId, machineId: identity.evidence.machineId, bootId: identity.evidence.bootId };
  const admission: AdmissionSnapshot = {
    level: 'ANY_RUN', requestedTier: 'normal', allowed: true, reasons: [],
    measurement: { machineId: process.machineId, loadAverage1m: null, availableCores: null,
      totalRamBytes: null, availableRamBytes: null, memoryPressure: null, fileSystems: [] },
    thresholds: null, remaining: null, reservation: { requested: input.requested, unused: { ramBytes: 0, diskBytes: {} } },
    estimate: { status: 'KNOWN', sources: ['unit-fixture'], reason: null }, queueId: queue.queueId(statePath, process.machineId),
  };
  const ports: AgentRunQueuePorts = {
    ...production.ports,
    validate: async () => ({ ok: true, validation }),
    claimAndAdmit: async () => {
      const result = await production.ports.claimAndAdmit({ request: production.request, validation, tier: 'normal' });
      assert.notEqual(result.kind, 'refused');
      if (result.kind === 'refused') throw new Error('Fixture admission failed');
      record = result.record;
      queue.transaction(tx => {
        tx.putSession({ runId: input.runId, addressId: input.addressId, state: 'reserved', revision: 0, activity: input.activity });
        tx.putReservation({ runId: input.runId, resource: 'fixture', amount: 8,
          resourceBundle: { machineId: process.machineId, resources: input.requested } });
        tx.putTaskReservation({ lease: { owner: { ...record.owner, addressId: record.agentId }, revision: 0 },
          tasks: [task], boot: { machineId: process.machineId, bootId: process.bootId }, stage: 'starting', starter: identity });
        queue.save({ record, phase: waited ? 'waiting' : 'starting', tasks: [task], fingerprint: validation.fingerprint });
      });
      return { kind: waited ? 'waiting' : 'reserved', record, admission };
    },
    waitForResources: async () => ({ kind: 'permit', exitCode: 0, reservation: false,
      permit: { requestId: 'unit-permit', serviceEpoch: 'unit-epoch', grantedAt: 1 } }),
    recheckAndReserve: async () => ({ kind: 'reserved', record, admission }),
    start: async () => {
      calls.start++;
      queue.transaction(tx => {
        const session = tx.getSession(input.runId)!;
        tx.putSession({ ...session, state: 'running', revision: session.revision + 1, process: identity,
          launchContext: { agentQueue: record, assignment: input.assignment, selection: input.selection,
            briefPath: join(directory, 'brief.md'), reportPath: input.reportPath } });
        const tasks = tx.listTaskReservations().find(set => set.lease.owner.runId === input.runId)!;
        tx.putTaskReservation({ ...tasks, stage: 'running', agent: identity });
        assert.equal(queue.confirmReady(tx, record), true);
      });
      return process;
    },
    verifyReady: async () => process,
    writeStderr: () => {},
  };
  const facts = () => ({
    session: current(input.runId),
    resources: store.sessionRepository.transaction(tx => tx.listReservations(), 'read'),
    tasks: store.taskReservationRepository.transaction(tx => tx.listTaskReservations()),
    pending: store.eventRepository.transaction(tx => tx.listPending()),
  });
  const reconcile = () => reconcileFinishedAgentQueues({ store, current, observe: dependencies.observe, cleanReport: dependencies.cleanReport });
  return { input, dependencies, production, queue, current, identity, process, ports, api, calls, facts, reconcile,
    record: () => record };
}

for (const waited of [false, true]) {
  for (const reconciled of [false, true]) {
    test(`Z.393.10 handshake timeout after durable readiness: waited=${waited}, reconciled=${reconciled} cancels its worker and releases claims`, async t => {
      const f = await fixture(t, waited);
      const start = f.ports.start;
      let workerAlive = true;
      f.api.compensate = async launch => {
        f.calls.compensate++;
        assert.equal(launch.runId, f.input.runId);
        workerAlive = false;
        return { stopped: true };
      };
      f.api.abortLaunch = async (runId, reason) => {
        f.calls.abort++;
        assert.equal(workerAlive, false, 'claims cannot be released before process termination');
        f.queue.transaction(tx => {
          const session = tx.getSession(runId)!;
          tx.putSession({ ...session, state: 'finished', revision: session.revision + 1, abortReason: reason });
          tx.deleteReservation(runId);
          tx.deleteTaskReservation(runId);
        });
      };
      f.ports.start = async (record, validation) => {
        await start(record, validation);
        assert.equal(f.current(f.input.runId)?.state, 'running');
        if (reconciled) {
          await f.reconcile();
          assert.equal(f.queue.get(record), undefined);
        }
        throw new Error('Readiness handshake timeout after 30000 ms');
      };
      const result = await runAgentWithQueue(f.production.request, f.ports);
      assert.equal(result.exitCode, 1);
      const failure = JSON.parse(result.stderr);
      assert.match(failure.message, /Readiness handshake timeout/);
      assert.equal(workerAlive, false, 'failed launch must not leave its ready worker running');
      assert.equal(f.calls.compensate, 1);
      assert.equal(f.calls.abort, 1);
      assert.equal(f.calls.cleanReport, 1);
      assert.equal(f.current(f.input.runId)?.state, 'finished');
      assert.deepEqual(f.facts().tasks, []);
      assert.deepEqual(f.facts().resources, []);
      assert.equal(f.queue.get(f.record()), undefined);
      assert.equal(failure.details.cleanup.state, 'released');
      assert.equal(failure.details.retrySafe, true);
      assert.deepEqual(failure.details.pending, []);
    });
  }
}

test('Z.393.10 failed stop confirmation retains running claims and reports pending termination', async t => {
  const f = await fixture(t, false);
  const start = f.ports.start;
  f.ports.start = async (record, validation) => {
    await start(record, validation);
    throw new Error('Readiness handshake timeout after 30000 ms');
  };
  const result = await runAgentWithQueue(f.production.request, f.ports);
  const failure = JSON.parse(result.stderr);
  assert.equal(result.exitCode, 1);
  assert.equal(failure.details.cleanup.state, 'unknown');
  assert.deepEqual(failure.details.pending, ['process termination']);
  assert.equal(failure.details.retrySafe, false);
  assert.equal(f.calls.compensate, 1);
  assert.equal(f.calls.abort, 0);
  assert.equal(f.calls.cleanReport, 0);
  assert.equal(f.current(f.input.runId)?.state, 'running');
  assert.equal(f.facts().tasks.length, 1);
  assert.equal(f.facts().resources.length, 1);
});

for (const field of ['fence', 'requestId', 'queueId', 'agentId', 'runId', 'clientIdentity', 'coordinator'] as const) {
  test(`Z.393.10 removed ready entry: stale ${field} cannot cancel another launch`, async t => {
    const f = await fixture(t, false);
    await runAgentWithQueue(f.production.request, f.ports);
    const before = structuredClone(f.facts());
    const record = structuredClone(f.record());
    if (field === 'fence' || field === 'runId') record.owner[field] = 'stale-owner';
    else if (field === 'clientIdentity') record.clientIdentity.pid++;
    else if (field === 'coordinator') record.coordinator = { runId: 'other-coordinator', fence: 'other-fence' };
    else record[field] = 'stale-launch';
    const result = await f.production.ports.cleanup(record, 'launch-failed', 'Readiness handshake timeout');
    assert.equal(result.state, 'retained');
    assert.deepEqual(f.facts(), before);
    assert.equal(f.calls.compensate, 0);
    assert.equal(f.calls.abort, 0);
    assert.equal(f.calls.cleanReport, 0);
  });
}

test('Z.393.10 dead launch client reconciliation preserves the ready live worker', async t => {
  const f = await fixture(t, false);
  await f.ports.claimAndAdmit({ request: f.production.request, validation: {
    assignment: f.input.assignment, fingerprint: 'start-result-assignment', requested: f.input.requested,
    requiredFileSystemIds: f.input.requiredFileSystemIds,
  }, tier: 'normal' });
  await f.ports.start(f.record(), { assignment: f.input.assignment, fingerprint: 'start-result-assignment',
    requested: f.input.requested, requiredFileSystemIds: f.input.requiredFileSystemIds });
  const before = structuredClone(f.facts());
  const result = await f.production.ports.cleanup(f.record(), 'client-died', 'launch client exited');
  assert.equal(result.state, 'retained');
  assert.deepEqual(f.facts(), before);
  assert.equal(f.calls.compensate, 0);
  assert.equal(f.calls.abort, 0);
});

function assertRunning(result: Awaited<ReturnType<typeof runAgentWithQueue>>, f: Awaited<ReturnType<typeof fixture>>, waited: boolean) {
  assert.equal(result.exitCode, 0, `A confirmed running launch must return success; received ${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'running');
  assert.equal(body.runId, f.input.runId);
  assert.equal(body.agentId, f.input.addressId);
  assert.deepEqual(body.process, f.process);
  assert.deepEqual(body.queue, { queueId: f.record().queueId, waited });
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.compensate, 0);
  assert.equal(f.calls.abort, 0);
  assert.equal(f.calls.cleanReport, 0);
}

for (const waited of [false, true]) {
  const path = waited ? 'queued' : 'fast';
  test(`start-result ${path}: ready launch returns running without concurrent cleanup`, async (t: TestContext) => {
    const f = await fixture(t, waited);
    assertRunning(await runAgentWithQueue(f.production.request, f.ports), f, waited);
    assert.equal(f.queue.get(f.record()), undefined);
    assert.equal(f.current(f.input.runId)?.state, 'running');
  });

  for (const cleaner of ['ps', 'next-launch'] as const) {
    test(`start-result ${path}: ${cleaner} removing a ready queue entry cannot turn running into START_COMMIT_CONFLICT`, async (t: TestContext) => {
      const f = await fixture(t, waited);
      let before!: ReturnType<typeof f.facts>;
      f.ports.verifyReady = async () => {
        assert.equal(f.queue.get(f.record())?.ready, true);
        assert.equal(f.current(f.input.runId)?.state, 'running');
        before = structuredClone(f.facts());
        if (cleaner === 'ps') await f.reconcile();
        else await createProductionAgentQueue({ ...f.input, runId: 'next-run', addressId: 'next-worker' }, f.dependencies);
        assert.equal(f.queue.get(f.record()), undefined, 'Exercise actual production removal before the caller finalizes');
        assert.deepEqual(f.facts(), before, 'Reconciliation preserves the committed launch, claims and event totals');
        return f.process;
      };
      const result = await runAgentWithQueue(f.production.request, f.ports);
      assert.deepEqual(f.facts(), before, 'Final response must preserve the live worker and its ownership');
      assert.throws(() => f.queue.transaction(tx => f.queue.assertClaim(tx, {
        record: { ...f.record(), requestId: 'retry-request', owner: { runId: 'retry-run', fence: 'retry-fence' } },
        phase: 'starting', tasks: [], fingerprint: 'retry',
      }, { assignment: f.input.assignment, fingerprint: 'retry', requested: f.input.requested, requiredFileSystemIds: ['fixture'] })), /ADDRESS_IN_USE/);
      if (waited) {
        assert.equal(before.pending.length, 1);
        assert.deepEqual(before.pending[0].data, { queueId: f.record().queueId,
          generation: f.record().eventHandle!.generation, started: 1, cancelled: 0, failed: 0 });
      } else assert.deepEqual(before.pending, []);
      assertRunning(result, f, waited);
    });
  }
}

for (const field of ['pid', 'startedAt', 'machineId', 'bootId', 'runnerSessionId', 'runner'] as const) {
  test(`start-result removed entry: a different ${field} cannot acknowledge the running owner`, async (t: TestContext) => {
    const f = await fixture(t, false);
    await f.ports.claimAndAdmit({ request: f.production.request, validation: {
      assignment: f.input.assignment, fingerprint: 'start-result-assignment', requested: f.input.requested, requiredFileSystemIds: ['fixture'],
    }, tier: 'normal' });
    await f.ports.start(f.record(), { assignment: f.input.assignment, fingerprint: 'start-result-assignment', requested: f.input.requested, requiredFileSystemIds: ['fixture'] });
    await f.reconcile();
    const before = structuredClone(f.facts());
    const other = { ...f.process, [field]: field === 'pid' ? f.process.pid + 1 : 'different-identity' };
    assert.equal(await f.production.ports.commitReady(f.record(), other), false);
    assert.deepEqual(f.facts(), before);
    assert.equal(f.calls.compensate, 0);
  });
}

for (const state of ['reserved', 'exited', 'finished'] as const) {
  test(`start-result removed entry: ${state} cannot be reported as a confirmed running launch`, async (t: TestContext) => {
    const f = await fixture(t, false);
    await runAgentWithQueue(f.production.request, f.ports);
    f.queue.transaction(tx => {
      const session = tx.getSession(f.input.runId)!;
      tx.putSession({ ...session, state, revision: session.revision + 1 } satisfies SessionRecord);
    });
    const before = structuredClone(f.facts());
    assert.equal(await f.production.ports.commitReady(f.record(), f.process), false);
    assert.deepEqual(f.facts(), before);
  });
}

for (const field of ['fence', 'requestId', 'queueId', 'agentId', 'runId'] as const) {
  test(`start-result removed entry: a stale ${field} cannot acknowledge or mutate another launch`, async (t: TestContext) => {
    const f = await fixture(t, true);
    await runAgentWithQueue(f.production.request, f.ports);
    const before = structuredClone(f.facts());
    const record = structuredClone(f.record());
    if (field === 'fence' || field === 'runId') record.owner[field] = 'stale-owner';
    else record[field] = 'stale-launch';
    assert.equal(await f.production.ports.commitReady(record, f.process), false);
    assert.deepEqual(f.facts(), before);
    assert.equal(f.calls.compensate, 0);
    assert.equal(f.calls.abort, 0);
  });
}
