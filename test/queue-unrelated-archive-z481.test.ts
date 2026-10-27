import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { openStateStore } from '../src/state-store.ts';
import { createAgentQueueState } from '../src/agent-queue-state.ts';
import { createProductionAgentQueue } from '../src/production-agent-queue.ts';
import { runAgentWithQueue, type AgentQueueProcess, type AgentRunQueuePorts } from '../src/agent-run-queue.ts';
import type { RuntimeConfiguration, RuntimeContext, RuntimeReservationInput, RuntimeServices, RuntimeTaskContext } from '../src/app-runtime.ts';
import type { AdmissionSnapshot } from '../src/admission-snapshot.ts';
import type { AssignmentSnapshot } from '../src/assignment.ts';
import type { ProcessIdentity } from '../src/session-state.ts';
import type { ReservedTaskSnapshot } from '../src/task-reservations.ts';

type Drift = 'unrelated-archive' | 'assigned-source' | 'description';

async function launch(t: TestContext, drift: Drift) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-z481-'));
  const statePath = join(directory, 'state.sqlite');
  const store = openStateStore(statePath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const queue = createAgentQueueState(store);
  const description = 'Queue recheck keeps the assigned item';
  const assignment: AssignmentSnapshot = {
    root: directory,
    changes: [{ id: 'complete-raf-flow-contracts', items: [{ id: 'Z.481', description }] }],
    baselineArchives: [],
  };
  const initial: RuntimeTaskContext = {
    branch: 'develop',
    outcome: 'complete-raf-flow-contracts:Z.481 — queued launch survives an unrelated archive',
    writeBoundaries: [directory],
    sources: ['openspec/changes/complete-raf-flow-contracts/tasks.md — Z.481'],
    reportSchema: { type: 'object', required: ['status'], additionalProperties: true, properties: {} } as RuntimeTaskContext['reportSchema'],
    requested: { ramBytes: 8, diskBytes: { fixture: 16 } },
    requiredFileSystemIds: ['fixture'],
    estimate: { status: 'KNOWN', tier: 'normal', ramBytes: 8, diskBytesPerFileSystem: 16, source: 'unit-fixture', sources: ['unit-fixture'] },
  };
  const input: RuntimeReservationInput = {
    runId: 'z481-queue-run', addressId: 'z481-worker', tmuxSession: 'z481-worker',
    activity: { type: 'implement', project: 'raf', phase: 'implement', features: ['complete-raf-flow-contracts'], cwd: directory },
    assignment, selection: { status: 'selected', runner: 'codex', model: 'fixture', effort: 'high', reason: 'unit fixture', quota: 'available' },
    statePath, tmpRoot: directory, reportPath: join(directory, 'report.json'),
    requested: initial.requested, requiredFileSystemIds: [...initial.requiredFileSystemIds],
    taskContext: {
      parameters: { id: 'z481-worker', type: 'implement', project: 'raf', features: ['complete-raf-flow-contracts'], phase: 'implement', complexity: 'mechanical', tasks: ['complete-raf-flow-contracts:Z.481'] },
      context: initial,
    },
  };
  let waiting = false;
  const calls = { start: 0 };
  const current = (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
  const api: RuntimeServices = {
    assignment: {
      validate: async () => {
        if (waiting && drift === 'description') return { ok: false, kind: 'invalid-assignment', root: directory, issues: [{
          change: 'complete-raf-flow-contracts', requestedItems: ['Z.481'], reason: 'Пункт Z.481 змінив опис', foundItems: [], archives: [], remedy: 'Уточніть доручення за актуальними даними OpenSpec і повторіть перевірку.',
        }] };
        const baselineArchives = waiting && drift === 'unrelated-archive' ? ['2026-10-26-foreign-change'] : [];
        return { ok: true, snapshot: { ...assignment, baselineArchives } };
      },
      compose: async () => { throw new Error('compose is outside the queue recheck'); },
    },
    resolveTask: async () => {
      if (!waiting || drift === 'description') return initial;
      if (drift === 'assigned-source') return { ...initial, sources: ['openspec/changes/complete-raf-flow-contracts/tasks.md — опис дорученого пункту змінено'] };
      return { ...initial, writeBoundaries: [...initial.writeBoundaries, join(directory, 'foreign-archive')], reportSchema: { ...initial.reportSchema, unrelated: true } };
    },
    route: async () => ({ ok: true, project: 'raf', branch: 'develop', cwd: directory }),
    routingSnapshot: async () => ({ runnerEnabled: { codex: true }, cliAvailable: { codex: true }, quotas: [] }),
    selectModel: () => ({ status: 'selected', runner: 'codex', model: 'fixture', effort: 'high', reason: 'unit fixture', quota: 'available' }),
    listModels: () => [],
    prepareReport: async () => { throw new Error('prepareReport is outside the queue recheck'); },
    reserve: async reservation => {
      const claim = reservation.queueClaim;
      if (!claim) return { admitted: false, reason: 'Queue claim is required', admission: null };
      const admission = admit(claim.record.queueId, claim.record.clientIdentity.machineId);
      const task: ReservedTaskSnapshot = { key: { project: 'raf', changeId: 'complete-raf-flow-contracts', taskId: 'Z.481' }, changeInstance: 'z481-instance', fingerprint: 'z481-task' };
      if (!claim.rechecking) {
        queue.transaction(tx => {
          tx.putSession({ runId: input.runId, addressId: input.addressId, state: 'reserved', revision: 0, activity: input.activity });
          queue.save({ record: claim.record, phase: 'waiting', tasks: [task], fingerprint: claim.validation.fingerprint });
        });
        return { admitted: false, waiting: true, reason: 'Existing launch queue requires a resource permit', admission };
      }
      queue.transaction(tx => {
        const own = queue.get(claim.record);
        if (!own) throw new Error('queue entry missing before recheck');
        queue.assertClaim(tx, { ...own, fingerprint: claim.validation.fingerprint }, claim.validation);
      });
      return { admitted: true, admission };
    },
    adapter: { start: async () => { throw new Error('adapter start is outside the queue recheck'); } },
    verifyStarted: async () => { throw new Error('verifyStarted is outside the queue recheck'); },
    commitStarted: async (runId, identity) => {
      const session = current(runId);
      return session?.state === 'running' && isDeepStrictEqual(session.process, identity);
    },
    compensate: async () => ({ stopped: true }),
    abortLaunch: async runId => {
      queue.transaction(tx => {
        const session = tx.getSession(runId);
        if (session && session.state !== 'finished') tx.putSession({ ...session, state: 'finished', finishedAt: '2026-10-26T00:00:00Z', revision: session.revision + 1 });
      });
    },
    control: { ps: async () => [], update: async () => { throw new Error('unused'); }, message: async () => { throw new Error('unused'); }, close: async () => { throw new Error('unused'); }, interrupt: async () => {}, attachMain: async () => { throw new Error('unused'); } },
  };
  const dependencies: Parameters<typeof createProductionAgentQueue>[1] = {
    store, context: {
      orchestratorRoot: directory, confRoot: directory, artifactPath: directory, statePath,
      tmpRoot: directory, mode: 'test', commandStartedAtMs: Date.now(), resolveCaller: async () => undefined,
    } satisfies RuntimeContext,
    api, configuration: {} as RuntimeConfiguration, current, caller: async () => undefined,
    observe: async identity => ({ state: 'alive', identity, observedAt: '2026-10-26T00:00:00Z' }),
    reconcile: async () => {}, cleanReport: async () => {},
  };
  const production = await createProductionAgentQueue(input, dependencies);
  const identity: ProcessIdentity = {
    pid: 4810, startedAt: '2026-10-26T00:00:00Z', runner: 'codex', runnerSessionId: 'native-z481', tmuxSession: input.tmuxSession,
    evidence: { machineId: production.request.clientIdentity.machineId, bootId: production.request.clientIdentity.bootId, runId: input.runId },
  };
  const process: AgentQueueProcess = {
    pid: identity.pid, startedAt: identity.startedAt, runner: identity.runner, runnerSessionId: identity.runnerSessionId,
    machineId: identity.evidence.machineId, bootId: identity.evidence.bootId,
  };
  const ports: AgentRunQueuePorts = {
    ...production.ports,
    waitForResources: async () => {
      waiting = true;
      return { kind: 'permit', exitCode: 0, reservation: false, permit: { requestId: 'z481-permit', serviceEpoch: 'z481-epoch', grantedAt: 1 } };
    },
    start: async (record) => {
      calls.start++;
      queue.transaction(tx => {
        const session = tx.getSession(input.runId)!;
        tx.putSession({ ...session, state: 'running', revision: session.revision + 1, process: identity,
          launchContext: { agentQueue: record, assignment: input.assignment, selection: input.selection,
            briefPath: join(directory, 'brief.md'), reportPath: input.reportPath } });
        assert.equal(queue.confirmReady(tx, record), true);
      });
      return process;
    },
    verifyReady: async () => process,
  };
  const result = await runAgentWithQueue(production.request, ports);
  return { result, calls };

  function admit(queueId: string, machineId: string): AdmissionSnapshot {
    return {
      level: 'ANY_RUN', requestedTier: 'normal', allowed: true, reasons: [],
      measurement: { machineId, loadAverage1m: null, availableCores: null, totalRamBytes: null, availableRamBytes: null, memoryPressure: null, fileSystems: [] },
      thresholds: null, remaining: null, reservation: { requested: input.requested, unused: { ramBytes: 0, diskBytes: {} } },
      estimate: { status: 'KNOWN', sources: ['unit-fixture'], reason: null }, queueId,
    };
  }
}

test('Z.481 queued launch starts after an unrelated change is archived', async t => {
  const { result, calls } = await launch(t, 'unrelated-archive');
  assert.equal(calls.start, 1, result.stderr);
  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'running');
  assert.equal(body.queue.waited, true);
});

test('Z.481 assigned source change still rejects the queued launch', async t => {
  const { result, calls } = await launch(t, 'assigned-source');
  assert.equal(calls.start, 0, result.stderr);
  assert.equal(result.exitCode, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.code, 'TASK_CONTEXT_CHANGED');
});

test('Z.481 changed item description still rejects the queued launch', async t => {
  const { result, calls } = await launch(t, 'description');
  assert.equal(calls.start, 0, result.stderr);
  assert.equal(result.exitCode, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.code, 'INVALID_ASSIGNMENT');
  assert.match(failure.message, /Пункт Z\.481 змінив опис/);
});
