import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { openStateStore } from '../src/state-store.ts';
import { createStoredLaunchQueueEvents, storedLaunchQueueIdentity } from '../src/stored-launch-queue-events.ts';
import { createTestRunQueuePort } from '../src/test-run-queue-runtime.ts';
import { evaluateLaunchAdmissionInTransaction } from '../src/launch-state.ts';

const GiB = 1024 ** 3;
const measurement = { machineId: 'z465', loadAverage1m: 0, availableCores: 8,
  totalRamBytes: 32 * GiB, availableRamBytes: 15 * GiB, memoryPressure: 'normal' as const,
  fileSystems: [{ id: 'volume', totalBytes: 200 * GiB, availableBytes: 100 * GiB }] };
const estimate = { status: 'KNOWN' as const, sources: ['unit estimate'], reason: null,
  reservation: { ramBytes: GiB, diskBytes: { volume: GiB } } };
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('test-run-resource-runtime.ts?z465') && specifier === './os-runtime.ts') {
      return { url: 'z465:os', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'z465:os') return { format: 'module', shortCircuit: true, source:
      `export const createResourceSnapshotReader = ({paths}) => ({read: async () => ({measurement: ${JSON.stringify(measurement)}, reasons: [], fileSystemByPath: Object.fromEntries(paths.map(path => [path, 'volume']))})}); export const observeProcesses = async rows => rows.map(identity => ({state: 'alive', identity}));` };
    return next(url, context);
  },
});
const { createTestRunResourcePort } = await import('../src/test-run-resource-runtime.ts?z465');
hook.deregister();

for (const tier of ['normal', 'hotfix'] as const) {
  for (const predecessor of ['normal-agent', 'hotfix-agent', 'normal-test', 'hotfix-test'] as const) {
    test(`Z.465 ${tier} test priority behind ${predecessor}`, async t => {
      const root = mkdtempSync('/tmp/raf-z465-');
      t.after(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, 'conf'));
      for (const name of ['flow.json', 'raf.json']) writeFileSync(join(root, 'conf', name), readFileSync(new URL(`../../conf/${name}`, import.meta.url)));
      const store = openStateStore(join(root, 'state.sqlite'));
      t.after(() => store.close());
      const identity = storedLaunchQueueIdentity(store, 'z465');
      const events = createStoredLaunchQueueEvents(store, identity);
      const requestId = randomUUID(), fence = randomUUID();
      const isTest = predecessor.endsWith('test');
      const predecessorTier = predecessor.startsWith('hotfix') ? 'hotfix' : 'normal';
      const handle = events.record({ kind: isTest ? 'test-run' : 'agent-run', waited: true, requestId, fence })!;
      if (isTest) store.eventRepository.transaction(tx => {
        const state = tx.loadQueue(identity)!;
        tx.saveQueue(identity, { ...state, pendingTests: [{ testRunId: 'older-test', fence, requestedTier: predecessorTier,
          groupKey: { project: 'raf', workspace: root, group: 'older' }, ownerIdentity: 'unit', processIdentity: null, handle }] } as any);
      });
      else store.startupContextDatabase.prepare('INSERT INTO agent_launch_queue_entries(request_id, run_id, agent_id, payload) VALUES (?, ?, ?, ?)')
        .run(requestId, 'queued-agent', 'queued-agent', JSON.stringify({ phase: 'waiting', record: { requestId,
          requestedTier: predecessorTier, queueId: handle.queueId, owner: { runId: 'queued-agent', fence }, clientIdentity: { machineId: 'z465' } } }));
      const blocked = tier === 'normal' ? predecessor !== 'normal-agent' : predecessor === 'hotfix-test';
      const queue = createTestRunQueuePort(store, { root, workspace: root, home: root, machineId: 'z465', settle: async () => {} });
      const port = createTestRunResourcePort(store, { root, workspace: root, home: root, machineId: 'z465', config: {} });
      const request = { testRunId: 'new-test', groupKey: { project: 'raf', workspace: root, group: 'complete-raf-flow-contracts/z465' },
        requestedTier: tier, estimate, deadlineMs: Date.now() + 1000 };
      const prepared = await port.prepare(request);
      assert.equal((prepared.admission as any).allowed, true, 'resource measurement must allow either tier');
      assert.equal(prepared.status, blocked ? 'refused' : 'prepared', 'only equal or higher priority predecessors defer this test');
      if (prepared.status === 'prepared') await port.release(prepared.claim);
      assert.equal(await (queue.hasPending as (tier: string) => Promise<boolean>)(tier), blocked, 'initial queue check must use the same priority as the reservation race check');
      const permitted = await port.prepare({ ...request, testRunId: 'permitted-test', queuePermit: true });
      assert.equal(permitted.status, 'prepared', 'a committed permit is not revoked by later queue entries');
      if (permitted.status === 'prepared') await port.release(permitted.claim);
      const deferred = await port.prepare({ ...request, testRunId: 'deferred-test', deferReservation: true });
      assert.equal(deferred.status, 'refused', 'explicit queue deferral remains effective');
    });
  }
}

test('Z.465 fourteen observed live runtimes do not subtract their estimates from measured available RAM again', () => {
  const process = { pid: 42, startedAt: '2026-10-26T16:50:00Z', runner: 'codex', runnerSessionId: 'native',
    tmuxSession: 'unit', evidence: { machineId: 'z465', bootId: 'boot' } };
  const reservations = Array.from({ length: 14 }, (_, i) => ({ runId: `agent-${i}`, resource: 'runtime', amount: 2 * GiB,
    resourceBundle: { machineId: 'z465', resources: { ramBytes: 2 * GiB, diskBytes: { volume: GiB } } } }));
  let unused: unknown;
  const evaluate = (observedProcesses: any[]) => evaluateLaunchAdmissionInTransaction({ listReservations: () => reservations,
    getSession: runId => ({ runId, addressId: runId, revision: 1, state: 'running', process }) },
    { requested: estimate.reservation, requiredFileSystemIds: ['volume'] }, { measurement, observedProcesses }, input => {
      unused = input.unusedReservations;
      return { level: 'ANY_RUN', allowed: { normal: true, hotfix: true }, reasons: [], measurement,
        remaining: { ramBytes: measurement.availableRamBytes - input.requested.ramBytes - input.unusedReservations.reduce((sum, row) => sum + row.ramBytes, 0), diskBytes: {}, normalizedLoad: 0 } };
    });
  const observed = reservations.map(row => ({ runId: row.runId, identity: process }));
  assert.equal(evaluate(observed).remaining!.ramBytes, 14 * GiB);
  assert.deepEqual(unused, [], 'live RAM is already reflected by the OS available RAM measurement');
  evaluate([]);
  assert.equal((unused as any[]).length, 14, 'unverified runtime reservations must remain reserved');
});
