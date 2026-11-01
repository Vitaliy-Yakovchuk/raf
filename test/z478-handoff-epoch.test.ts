import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runAgentWithQueue, type AgentQueueProcess, type AgentQueueRecord, type AgentQueueRequest, type AgentRunQueuePorts } from '../src/agent-run-queue.ts';
import type { AdmissionSnapshot } from '../src/admission-snapshot.ts';
import type { ProcessObservation, SessionRecord } from '../src/session-state.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';
import {
  claimTaskReservations, handoffTaskReservations, listTaskReservations,
  type ClaimTasksRequest, type MachineBootIdentity, type ReservationProcessIdentity,
  type ReservedTaskSnapshot, type TaskReservationDependencies,
} from '../src/task-reservations.ts';

const queueId = 'z478-queue';

function admission(): AdmissionSnapshot {
  return {
    level: 'ANY_RUN', requestedTier: 'normal', allowed: true, reasons: ['z478'],
    measurement: {
      machineId: 'unit-machine', loadAverage1m: null, availableCores: null,
      totalRamBytes: null, availableRamBytes: null, memoryPressure: null, fileSystems: [],
    },
    thresholds: null, reservation: { requested: { ramBytes: 8, diskBytes: { dev: 16 } }, unused: { ramBytes: 0, diskBytes: {} } },
    remaining: null, estimate: { status: 'KNOWN', sources: ['z478'], reason: null }, queueId,
  };
}

function queueFixture() {
  const controller = new AbortController();
  const request: AgentQueueRequest = {
    orchestratorRoot: '/unit/root', homeDirectory: '/unit/qa-home', developmentDirectory: '/unit/root/raf-hotfix',
    project: 'raf', agentId: 'z478-agent', agentType: 'implement',
    owner: { runId: 'z478-launch', fence: 'z478-fence' },
    clientIdentity: { pid: 3421608, startedAt: '2026-10-26T20:51:00.000Z', machineId: 'unit-machine', bootId: 'unit-boot' },
    selections: [{ change: 'complete-raf-flow-contracts', items: ['Z.478'] }],
    coordinator: null, signal: controller.signal,
  };
  const record: AgentQueueRecord = {
    queueId, requestId: 'z478-request', agentId: request.agentId, owner: request.owner,
    clientIdentity: request.clientIdentity, coordinator: null, eventHandle: null,
  };
  const process: AgentQueueProcess = {
    pid: 42001, startedAt: '2026-10-26T20:51:01.000Z', machineId: 'unit-machine', bootId: 'unit-boot', runnerSessionId: 'z478-runner',
  };
  const validation = {
    fingerprint: 'z478',
    assignment: { root: request.orchestratorRoot, baselineArchives: [], changes: [] },
    requested: { ramBytes: 8, diskBytes: { dev: 16 } }, requiredFileSystemIds: ['dev'],
  };
  return { controller, request, record, process, validation };
}

test('Z.478 serviceEpoch change during handoff launches again and keeps the reservation', async () => {
  const f = queueFixture();
  let epoch = 'epoch-1';
  const epochs: string[] = [];
  let firstAborted = false;
  const ports = {
    validate: async () => ({ ok: true as const, validation: f.validation }),
    claimAndAdmit: async () => ({ kind: 'reserved' as const, record: f.record, admission: admission() }),
    waitForResources: async () => { throw new Error('admitted handoff must not return to resource wait'); },
    transition: async () => true,
    recheckAndReserve: async () => { throw new Error('admitted handoff must not reserve again'); },
    start: async (_record: AgentQueueRecord, _validation: unknown, signal?: AbortSignal) => {
      epochs.push(epoch);
      if (epochs.length === 1) {
        epoch = 'epoch-2';
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250);
          const abort = () => { clearTimeout(timer); firstAborted = true; reject(new Error('aborted')); };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return f.process;
    },
    watchServiceEpoch: async (signal: AbortSignal) => {
      const baseline = epoch;
      while (epoch === baseline) {
        if (signal.aborted) throw new Error('watch aborted');
        await new Promise(resolve => setImmediate(resolve));
      }
      return epoch;
    },
    verifyReady: async () => f.process,
    commitReady: async () => true,
    cleanup: async () => { throw new Error('epoch change must relaunch the held reservation, not drop it'); },
    observe: async () => ({ owner: 'client' as const, client: 'alive' as const, agent: 'dead' as const, reason: 'unused' }),
    writeStderr: () => {},
  };
  const result = await runAgentWithQueue(f.request, ports as AgentRunQueuePorts);
  assert.equal(result.exitCode, 0);
  assert.equal(firstAborted, true, 'the handoff started on the old serviceEpoch must be aborted');
  assert.deepEqual(epochs, ['epoch-1', 'epoch-2'], 'handoff must launch on the new serviceEpoch');
});

test('Z.478 SIGTERM during handoff releases the reservation', async () => {
  const f = queueFixture();
  const cleanupReasons: string[] = [];
  let commits = 0;
  const ports = {
    validate: async () => ({ ok: true as const, validation: f.validation }),
    claimAndAdmit: async () => ({ kind: 'reserved' as const, record: f.record, admission: admission() }),
    waitForResources: async () => { throw new Error('unused'); },
    transition: async () => true,
    recheckAndReserve: async () => { throw new Error('unused'); },
    start: async (_record: AgentQueueRecord, _validation: unknown, signal?: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        const abort = () => { clearTimeout(timer); reject(new Error('aborted')); };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        f.controller.abort();
      });
      return f.process;
    },
    verifyReady: async () => f.process,
    commitReady: async () => { commits += 1; return true; },
    cleanup: async (_record: AgentQueueRecord, reason: string) => {
      cleanupReasons.push(reason);
      return { state: 'released' as const, reason: 'worker stopped', completed: ['launch claims'], pending: [] };
    },
    observe: async () => ({ owner: 'client' as const, client: 'alive' as const, agent: 'dead' as const, reason: 'unused' }),
    writeStderr: () => {},
  };
  const result = await runAgentWithQueue(f.request, ports as AgentRunQueuePorts);
  assert.equal(result.exitCode, 1);
  assert.equal(commits, 0, 'an interrupted handoff must not commit');
  assert.deepEqual(cleanupReasons, ['cancelled']);
  const body = JSON.parse(result.stderr);
  assert.equal(body.code, 'LAUNCH_CANCELLED');
  assert.equal(body.details.cleanup.state, 'released');
});

const observedAt = '2026-10-26T21:01:00.000Z';

function task(taskId: string): ReservedTaskSnapshot {
  return { key: { project: 'raf', changeId: 'complete-raf-flow-contracts', taskId }, changeInstance: 'change-instance-original', fingerprint: `initial-content:${taskId}` };
}

function identity(runId: string, role: string, pid: number): ReservationProcessIdentity {
  return {
    pid, startedAt: '2026-10-26T20:51:00.000Z', runner: 'fixture-runner', runnerSessionId: `${runId}:${role}`,
    tmuxSession: `fixture-${runId}`,
    evidence: { machineId: 'fixture-machine', bootId: 'fixture-boot', runId, command: `fixture-${role}`, role },
  };
}

function exited(): ProcessObservation {
  return { state: 'exited', observedAt, exitCode: null, evidence: 'fixture verified process exit' };
}

test('Z.478 a dead handoff wrapper is replaced by the next launch of the same reservation', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'raf-z478-handoff-'));
  const stores: StateStore[] = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = openStateStore(join(directory, 'state.sqlite'));
  stores.push(store);
  const observations = new Map<string, ProcessObservation>();
  let fence = 0;
  const boot: MachineBootIdentity = { machineId: 'fixture-machine', bootId: 'fixture-boot' };
  const dependencies = (): TaskReservationDependencies => ({
    store, currentBoot: async () => structuredClone(boot),
    observe: async expected => structuredClone(observations.get(JSON.stringify(expected)) ?? { state: 'alive', observedAt, identity: expected }),
    resolveTasks: async tasks => tasks.map(snapshot => ({ state: 'open' as const, task: snapshot, location: 'active' as const })),
    newFence: () => `fixture-fence-${++fence}`,
  });
  const runId = 'z478-run';
  const request: ClaimTasksRequest = {
    addressId: runId, runId, tasks: [task('Z.478')], starter: identity(runId, 'starter', 3421608),
    reserveLaunch: tx => {
      const session: SessionRecord = {
        runId, addressId: runId, revision: 0, state: 'reserved',
        activity: { type: 'implement', project: 'raf', features: ['complete-raf-flow-contracts'], phase: 'hotfix', cwd: directory },
        launchContext: { assignment: { root: directory, baselineArchives: [], changes: [] }, selection: { runner: 'codex', model: 'm', effort: 'high' }, reportPath: join(directory, 'report.json'), briefPath: join(directory, 'brief.txt') },
      };
      tx.putSession(session);
      tx.putReservation({ runId, resource: 'runtime', amount: 1 });
      return session;
    },
  };
  const claimed = await claimTaskReservations(dependencies(), request);
  assert.equal(claimed.reserved, true);
  if (!claimed.reserved) return;
  const wrapper = identity(runId, 'wrapper', 41002);
  const handed = await handoffTaskReservations(dependencies(), { lease: claimed.lease, wrapper });
  assert.ok(handed);
  observations.set(JSON.stringify(wrapper), exited());
  const replacement = identity(runId, 'wrapper', 41004);
  const resumed = await handoffTaskReservations(dependencies(), { lease: handed!, wrapper: replacement });
  assert.ok(resumed, 'a dead wrapper during handoff must be replaced so the launch can continue');
  assert.equal(resumed!.owner.fence, handed!.owner.fence);
  assert.notEqual(resumed!.revision, handed!.revision);
  const stored = listTaskReservations(store).find(set => set.lease.owner.runId === runId);
  assert.equal(stored?.stage, 'handoff');
  assert.equal(stored?.wrapper?.pid, replacement.pid);
  const live = await handoffTaskReservations(dependencies(), { lease: resumed!, wrapper: identity(runId, 'wrapper', 41005) });
  assert.equal(live, null, 'a live wrapper keeps the handoff fence');
  assert.equal(listTaskReservations(store)[0]?.wrapper?.pid, replacement.pid);
  observations.set(JSON.stringify(identity(runId, 'starter', 3421608)), exited());
  observations.set(JSON.stringify(replacement), exited());
  const withoutStarter = await handoffTaskReservations(dependencies(), { lease: resumed!, wrapper: identity(runId, 'wrapper', 41006) });
  assert.equal(withoutStarter, null, 'a dead starter cannot be replaced into a new wrapper');
});
