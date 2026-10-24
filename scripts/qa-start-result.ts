import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import nodeProcess from 'node:process';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';
import { readWaitIdentity, observeWaitIdentity } from '../src/resource-wait-identity.ts';
import { isDeepStrictEqual } from 'node:util';
import { openStateStore } from '../src/state-store.ts';
import { createAgentQueueState } from '../src/agent-queue-state.ts';
import { createProductionAgentQueue, reconcileFinishedAgentQueues } from '../src/production-agent-queue.ts';
import { runAgentWithQueue, type AgentQueueProcess, type AgentQueueRecord, type AgentRunQueuePorts } from '../src/agent-run-queue.ts';
import type { RuntimeConfiguration, RuntimeContext, RuntimeReservationInput, RuntimeServices } from '../src/app-runtime.ts';
import type { AdmissionSnapshot } from '../src/admission-snapshot.ts';
import type { ProcessIdentity, ProcessObservation, SessionRecord } from '../src/session-state.ts';
import type { ReservationProcessIdentity, ReservedTaskSnapshot } from '../src/task-reservations.ts';

async function observeWorker(identity: ProcessIdentity): Promise<ProcessObservation> {
  const observedAt = new Date().toISOString();
  const found = await observeWaitIdentity({ pid: identity.pid, startedAt: identity.startedAt,
    machineId: identity.evidence.machineId!, bootId: identity.evidence.bootId! });
  if (found.state === 'alive') return { state: 'alive', identity, observedAt };
  if (found.state === 'dead') return { state: 'exited', observedAt, exitCode: null, evidence: found.reason };
  return { state: 'unknown', observedAt, error: found.reason };
}

async function fixture(t: { after(callback: () => void): void }, waited: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-start-result-process-'));
  const statePath = join(directory, 'state.sqlite');
  const child = spawn(nodeProcess.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  await once(child.stdout!, 'data');
  const live = await readWaitIdentity(child.pid!);
  t.after(() => { child.kill('SIGTERM'); });
  const store = openStateStore(statePath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const queue = createAgentQueueState(store);
  const current = (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
  const input: RuntimeReservationInput = {
    runId: 'start-result-run', addressId: 'start-result-worker', tmuxSession: 'start-result-worker',
    activity: { type: 'implement', project: 'raf', phase: 'implement', features: ['fix-raf-load-admission'], cwd: directory },
    assignment: { root: directory, changes: [{ id: 'fix-raf-load-admission', items: [{ id: '6.8.1', description: 'implement start result' }] }], baselineArchives: [] },
    selection: { status: 'selected', runner: 'codex', model: 'stand-stub', effort: 'high', reason: 'controlled process stand; no model call', quota: 'available' },
    statePath, tmpRoot: directory, reportPath: join(directory, 'report.json'),
    requested: { ramBytes: 8, diskBytes: { fixture: 16 } }, requiredFileSystemIds: ['fixture'],
  };
  let duringCommit = async () => {};
  const calls = { start: 0, commit: 0, compensate: 0, abort: 0, cleanReport: 0 };
  const api: Pick<RuntimeServices, 'commitStarted' | 'compensate' | 'abortLaunch' | 'reserve'> = {
    commitStarted: async (runId: string, identity: ProcessIdentity) => {
      calls.commit++;
      await duringCommit();
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
    observe: observeWorker,
    reconcile: async () => {}, cleanReport: async () => { calls.cleanReport++; },
  };
  const production = await createProductionAgentQueue(input, dependencies);
  let record!: AgentQueueRecord;
  const validation = { assignment: input.assignment, fingerprint: 'start-result-assignment', requested: input.requested,
    requiredFileSystemIds: input.requiredFileSystemIds };
  const task: ReservedTaskSnapshot = { key: { project: 'raf', changeId: 'fix-raf-load-admission', taskId: '6.8.1' },
    changeInstance: 'start-result-instance', fingerprint: 'start-result-task' };
  const identity: ReservationProcessIdentity = {
    pid: live.pid, startedAt: live.startedAt, runner: 'codex', runnerSessionId: 'native-start-result',
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
    estimate: { status: 'KNOWN', sources: ['controlled-process-stand'], reason: null }, queueId: queue.queueId(statePath, process.machineId),
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
      permit: { requestId: 'stand-permit', serviceEpoch: 'stand-epoch', grantedAt: 1 } }),
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
  return { input, dependencies, production, queue, current, identity, process, ports, calls, facts, reconcile,
    record: () => record, child, closed, directory, statePath, duringCommit: (action: () => Promise<void>) => { duringCommit = action; } };
}

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

async function cleanInProcess(input: RuntimeReservationInput, cleaner: string) {
  const store = openStateStore(input.statePath);
  const current = (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
  const observe = observeWorker;
  try {
    const dependencies = { store, current, observe,
      cleanReport: async () => { throw new Error('A live worker must not be cleaned'); },
      context: { orchestratorRoot: input.tmpRoot, confRoot: input.tmpRoot, artifactPath: input.tmpRoot,
        statePath: input.statePath, tmpRoot: input.tmpRoot, mode: 'test', commandStartedAtMs: Date.now(), resolveCaller: async () => undefined } as RuntimeContext,
      api: {} as RuntimeServices, configuration: {} as RuntimeConfiguration,
      caller: async () => undefined, reconcile: async () => {},
    };
    if (cleaner === 'ps') await reconcileFinishedAgentQueues(dependencies);
    else await createProductionAgentQueue({ ...input, runId: 'next-run', addressId: 'next-worker' }, dependencies);
    const queue = createAgentQueueState(store);
    assert.equal(queue.list().length, 0);
    const session = current(input.runId)!;
    assert.equal(session.state, 'running');
    assert.equal((await observe(session.process!)).state, 'alive');
    return { cleaner, pid: process.pid, queueEntries: 0, state: session.state, live: true };
  } finally { store.close(); }
}

async function externalCleaner(input: RuntimeReservationInput, cleaner: string) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--cleaner', JSON.stringify(input), cleaner],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data: { toString(): string }) => { stdout += data.toString(); });
  child.stderr.on('data', (data: { toString(): string }) => { stderr += data.toString(); });
  const [exitCode, signal] = await once(child, 'close');
  assert.equal(exitCode, 0, stderr);
  return { exitCode, signal, stderr, stdout, result: JSON.parse(stdout) };
}

if (process.argv[2] === '--cleaner') {
  console.log(JSON.stringify(await cleanInProcess(JSON.parse(process.argv[3]), process.argv[4])));
} else {
  const cases: unknown[] = [];
  for (const waited of [false, true]) for (const cleaner of ['ps', 'next-launch']) for (const window of ['before-commit', 'during-commit']) {
    const callbacks: (() => void)[] = [];
    const f = await fixture({ after: callback => callbacks.unshift(callback) }, waited);
    let cleanerResult: unknown;
    try {
      let before: ReturnType<typeof f.facts>;
      const clean = async () => {
        before = structuredClone(f.facts());
        assert.equal(f.queue.get(f.record())?.ready, true);
        cleanerResult = await externalCleaner(f.input, cleaner);
        assert.equal(f.queue.get(f.record()), undefined);
        assert.deepEqual(f.facts(), before);
      };
      if (window === 'before-commit') f.ports.verifyReady = async () => { await clean(); return f.process; };
      else f.duringCommit(clean);
      const result = await runAgentWithQueue(f.production.request, f.ports);
      assertRunning(result, f, waited);
      const after = f.facts();
      assert.deepEqual(after, before!);
      assert.equal((await observeWaitIdentity({ ...f.process })).state, 'alive');
      assert.equal(await f.production.ports.commitReady(f.record(), { ...f.process, pid: f.process.pid + 1 }), false);
      assert.throws(() => f.queue.transaction(tx => f.queue.assertClaim(tx, {
        record: { ...f.record(), requestId: 'retry', owner: { runId: 'retry-run', fence: 'retry-fence' } },
        phase: 'starting', tasks: [], fingerprint: 'retry',
      }, { assignment: f.input.assignment, fingerprint: 'retry', requested: f.input.requested, requiredFileSystemIds: ['fixture'] })), /ADDRESS_IN_USE/);
      if (waited) assert.deepEqual(after.pending.map(item => item.data), [{ queueId: f.record().queueId,
        generation: f.record().eventHandle!.generation, started: 1, cancelled: 0, failed: 0 }]);
      else assert.deepEqual(after.pending, []);
      assert.equal(after.resources.length, 1);
      assert.equal(after.tasks.length, 1);
      cases.push({ waited, cleaner, window, result, cleanerResult, calls: f.calls,
        actualWorker: { pid: f.child.pid, live: true, nativeIdentity: f.process },
        state: after.session?.state, resourceClaims: after.resources.length, taskClaims: after.tasks.length,
        pending: after.pending.map(item => item.data), duplicateAddress: 'ADDRESS_IN_USE', stalePid: 'refused' });
    } finally {
      for (const callback of callbacks) callback();
      const [workerExitCode, workerSignal] = await f.closed;
      assert.equal(workerSignal, 'SIGTERM');
      assert.equal(workerExitCode, null);
      assert.equal(existsSync(f.directory), false);
      assert.equal((await observeWaitIdentity({ ...f.process })).state, 'dead');
    }
  }
  writeFileSync(process.argv[2], JSON.stringify({ kind: 'isolated-process-stand', cases,
    limitations: ['Controlled admission and assignment ports; no actual Codex/model/tmux session or public agent run command',
      'Cleaner processes call the same production functions used by ps and next launch; operational state is not accessed'],
    cleanup: { complete: true, childWorkersExited: 8, cleanerProcessesExited: 8, temporaryStatesRemoved: 8 } }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: cases.length, cleanup: 'complete' }));
}
