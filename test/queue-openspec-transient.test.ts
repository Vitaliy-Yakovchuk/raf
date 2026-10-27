import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { validateAssignment, type AssignmentSnapshot } from '../src/assignment.ts';
import { openStateStore } from '../src/state-store.ts';
import { createAgentQueueState } from '../src/agent-queue-state.ts';
import { createProductionAgentQueue } from '../src/production-agent-queue.ts';
import { runAgentWithQueue, type AgentQueueProcess, type AgentRunQueuePorts } from '../src/agent-run-queue.ts';
import type { RuntimeConfiguration, RuntimeContext, RuntimeReservationInput, RuntimeServices, RuntimeTaskContext } from '../src/app-runtime.ts';
import type { AdmissionSnapshot } from '../src/admission-snapshot.ts';
import type { ProcessIdentity } from '../src/session-state.ts';
import type { ReservedTaskSnapshot } from '../src/task-reservations.ts';

const change = 'fix-raf-queue-openspec-transient';
const itemId = '1.1';
const description = 'Queue recheck retries a transient OpenSpec list failure';

type Mode = 'invalid-json' | 'nonzero' | 'missing-item';

async function launch(t: TestContext, mode: Mode, recoverAfterWait = false) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-qot-'));
  const statePath = join(directory, 'state.sqlite');
  const store = openStateStore(statePath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const queue = createAgentQueueState(store);
  const assignment: AssignmentSnapshot = {
    root: directory,
    changes: [{ id: change, items: [{ id: itemId, description }] }],
    baselineArchives: [],
  };
  const initial: RuntimeTaskContext = {
    branch: 'develop',
    outcome: `${change}:${itemId} — queued launch survives one transient OpenSpec list failure`,
    writeBoundaries: [directory],
    sources: [`openspec/changes/${change}/tasks.md — ${itemId}`],
    reportSchema: { type: 'object', required: ['status'], additionalProperties: true, properties: {} } as RuntimeTaskContext['reportSchema'],
    requested: { ramBytes: 8, diskBytes: { fixture: 16 } },
    requiredFileSystemIds: ['fixture'],
    estimate: { status: 'KNOWN', tier: 'normal', ramBytes: 8, diskBytesPerFileSystem: 16, source: 'unit-fixture', sources: ['unit-fixture'] },
  };
  const input: RuntimeReservationInput = {
    runId: 'qot-queue-run', addressId: 'qot-worker', tmuxSession: 'qot-worker',
    activity: { type: 'implement', project: 'raf', phase: 'implement', features: [change], cwd: directory },
    assignment, selection: { status: 'selected', runner: 'codex', model: 'fixture', effort: 'high', reason: 'unit fixture', quota: 'available' },
    statePath, tmpRoot: directory, reportPath: join(directory, 'report.json'),
    requested: initial.requested, requiredFileSystemIds: [...initial.requiredFileSystemIds],
    taskContext: {
      parameters: { id: 'qot-worker', type: 'implement', project: 'raf', features: [change], phase: 'implement', complexity: 'mechanical', tasks: [`${change}:${itemId}`] },
      context: initial,
    },
  };
  const events: string[] = [];
  let waiting = false;
  let failedList = false;
  const calls = { start: 0 };
  const listOk = () => JSON.stringify({ changes: [{ name: change, completedTasks: 0, totalTasks: 1 }] });
  const tasksOk = (present: boolean) => JSON.stringify({ tasks: present
    ? [{ id: itemId, description, done: false }]
    : [{ id: '9.9', description: 'Інший пункт', done: false }] });
  const current = (runId: string) => store.sessionRepository.transaction(tx => tx.getSession(runId), 'read');
  const api: RuntimeServices = {
    assignment: {
      validate: request => validateAssignment(request, { fs: { readText: async () => { throw new Error('queue recheck does not read files'); } }, cli: { async exec(args, cwd) {
        assert.equal(cwd, directory);
        const key = args.join(' ');
        if (key === 'list --json') {
          if (waiting && mode !== 'missing-item' && (!failedList || recoverAfterWait && events.filter(event => event === 'wait').length === 1)) {
            failedList = true;
            events.push(mode === 'invalid-json' ? 'list-invalid' : 'list-nonzero');
            return mode === 'invalid-json'
              ? { exitCode: 0, stdout: '{', stderr: '' }
              : { exitCode: 2, stdout: '', stderr: 'openspec list failed' };
          }
          events.push('list-ok');
          return { exitCode: 0, stdout: listOk(), stderr: '' };
        }
        if (key === 'list --archived --json') {
          events.push('list-archived');
          return { exitCode: 0, stdout: JSON.stringify({ changes: [] }), stderr: '' };
        }
        if (key === `instructions apply --change ${change} --json`) {
          events.push('instructions');
          return { exitCode: 0, stdout: tasksOk(!(waiting && mode === 'missing-item')), stderr: '' };
        }
        throw new Error(`Unexpected OpenSpec command: ${key}`);
      } } }),
      compose: async () => { throw new Error('compose is outside the queue recheck'); },
    },
    resolveTask: async () => initial,
    route: async () => ({ ok: true, project: 'raf', branch: 'develop', cwd: directory }),
    routingSnapshot: async () => ({ runnerEnabled: { codex: true }, cliAvailable: { codex: true }, quotas: [] }),
    selectModel: () => ({ status: 'selected', runner: 'codex', model: 'fixture', effort: 'high', reason: 'unit fixture', quota: 'available' }),
    listModels: () => [],
    prepareReport: async () => { throw new Error('prepareReport is outside the queue recheck'); },
    reserve: async reservation => {
      const claim = reservation.queueClaim;
      if (!claim) return { admitted: false, reason: 'Queue claim is required', admission: null };
      const admission = admit(claim.record.queueId, claim.record.clientIdentity.machineId);
      const task: ReservedTaskSnapshot = { key: { project: 'raf', changeId: change, taskId: itemId }, changeInstance: 'qot-instance', fingerprint: 'qot-task' };
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
    pid: 4811, startedAt: '2026-10-26T00:00:00Z', runner: 'codex', runnerSessionId: 'native-qot', tmuxSession: input.tmuxSession,
    evidence: { machineId: production.request.clientIdentity.machineId, bootId: production.request.clientIdentity.bootId, runId: input.runId },
  };
  const process: AgentQueueProcess = {
    pid: identity.pid, startedAt: identity.startedAt, runner: identity.runner, runnerSessionId: identity.runnerSessionId,
    machineId: identity.evidence.machineId, bootId: identity.evidence.bootId,
  };
  const ports: AgentRunQueuePorts = {
    ...production.ports,
    waitForResources: async () => {
      events.push('wait');
      waiting = true;
      const requestId = `qot-permit-${events.filter(event => event === 'wait').length}`;
      return { kind: 'permit', exitCode: 0, reservation: false, permit: { requestId, serviceEpoch: 'qot-epoch', grantedAt: 1 } };
    },
    start: async (record) => {
      calls.start++;
      events.push('start');
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
  return { result, calls, events };

  function admit(queueId: string, machineId: string): AdmissionSnapshot {
    return {
      level: 'ANY_RUN', requestedTier: 'normal', allowed: true, reasons: [],
      measurement: { machineId, loadAverage1m: null, availableCores: null, totalRamBytes: null, availableRamBytes: null, memoryPressure: null, fileSystems: [] },
      thresholds: null, remaining: null, reservation: { requested: input.requested, unused: { ramBytes: 0, diskBytes: {} } },
      estimate: { status: 'KNOWN', sources: ['unit-fixture'], reason: null }, queueId,
    };
  }
}

function assertRetried(events: string[], failure: 'list-invalid' | 'list-nonzero', recoverAfterWait = false) {
  const waits = events.flatMap((event, index) => event === 'wait' ? [index] : []);
  const failedAt = events.indexOf(failure);
  const recovered = events.findIndex((event, index) => index > failedAt && event === 'list-ok');
  assert.equal(waits.length, recoverAfterWait ? 2 : 1, events.join(','));
  assert.ok(events.filter(event => event === failure).length > 0, events.join(','));
  assert.ok(waits[0] < failedAt && failedAt < recovered, events.join(','));
  if (recoverAfterWait) assert.ok(failedAt < waits[1], events.join(','));
  assert.ok(recovered > waits.at(-1)!, events.join(','));
  assert.ok(events.indexOf('start') > recovered, events.join(','));
}

test('queued launch starts after openspec list --json returns invalid JSON once', async t => {
  const { result, calls, events } = await launch(t, 'invalid-json');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls.start, 1, result.stderr);
  assertRetried(events, 'list-invalid');
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'running');
  assert.equal(body.queue.waited, true);
});

test('queued launch starts after openspec list --json exits nonzero once', async t => {
  const { result, calls, events } = await launch(t, 'nonzero');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls.start, 1, result.stderr);
  assertRetried(events, 'list-nonzero');
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 'running');
  assert.equal(body.queue.waited, true);
});

for (const mode of ['invalid-json', 'nonzero'] as const) test(`queued launch retries ${mode} OpenSpec unavailability on the next wait`, async t => {
  const { result, calls, events } = await launch(t, mode, true);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls.start, 1, result.stderr);
  assertRetried(events, mode === 'invalid-json' ? 'list-invalid' : 'list-nonzero', true);
  assert.equal(JSON.parse(result.stdout).status, 'running');
});

test('queued launch still refuses a missing item after the wait', async t => {
  const { result, calls, events } = await launch(t, 'missing-item');
  assert.equal(calls.start, 0, result.stderr);
  assert.equal(result.exitCode, 1);
  assert.equal(events.filter(event => event === 'wait').length, 1, events.join(','));
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.code, 'INVALID_ASSIGNMENT');
  assert.match(failure.message, /Пункт 1\.1 відсутній/);
});
