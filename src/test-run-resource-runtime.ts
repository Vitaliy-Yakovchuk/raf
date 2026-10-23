import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { buildAdmissionSnapshot } from './admission-snapshot.ts';
import { evaluateLaunchAdmissionInTransaction } from './launch-state.ts';
import { loadFlowPolicy } from './flow-policy.ts';
import { deriveResourceAdmissionVolumes } from './home-disk-admission.ts';
import { createResourceSnapshotReader, observeProcesses } from './os-runtime.ts';
import { resolveTestProfileResourceEstimate } from './resource-estimates.ts';
import { observeReservedTestTree, testWrapperIdentity } from './test-run-resource-process.ts';
import type { StateStore } from './state-store.ts';
import type { AdmissionReservation } from './session-state.ts';
import type { TestRunResourceClaim, TestRunResourcePort } from './test-run-reservations.ts';

export function createTestRunResourcePort(store: StateStore, options: {
  root: string; workspace: string; home: string; machineId: string; config: unknown;
}): TestRunResourcePort & { bindSpawn(identity: string): void; spawnFailed(): void } {
  const ownerIdentity = testWrapperIdentity();
  let ownClaim: TestRunResourceClaim | null = null;
  const paths = { orchestratorRoot: options.root, workspace: options.workspace, home: options.home };
  const match = (row: AdmissionReservation | undefined, claim: TestRunResourceClaim) => row?.testRun?.claim.fence === claim.fence
    && row.testRun.claim.machineId === claim.machineId && row.testRun.claim.testRunId === claim.testRunId;
  const find = (rows: AdmissionReservation[], claim: TestRunResourceClaim) => rows.find(row => row.runId === claim.testRunId && match(row, claim));
  const update = async (claim: TestRunResourceClaim, operation: (row: AdmissionReservation) => void) => store.sessionRepository.transaction(tx => {
    const row = find(tx.listReservations(), claim);
    if (!row) return false;
    operation(row); tx.putReservation(row); return true;
  });
  const snapshot = () => createResourceSnapshotReader({ machineId: options.machineId, paths: [...new Set(Object.values(paths))] }).read();
  return {
    spawnFailed: () => {
      if (!ownClaim) return;
      store.sessionRepository.transaction(tx => {
        const row = find(tx.listReservations(), ownClaim!);
        if (row?.testRun && !row.testRun.claim.processIdentity) { row.testRun.spawning = false; tx.putReservation(row); }
      });
    },
    bindSpawn: identity => {
      if (!ownClaim) throw new Error('No resource claim for spawn');
      store.sessionRepository.transaction(tx => {
        const row = find(tx.listReservations(), ownClaim!);
        if (!row?.testRun?.committed) throw new Error('Resource claim lost at spawn');
        row.testRun.claim.processIdentity = identity; tx.putReservation(row);
      });
    },
    markSpawning: async claim => { if (!await update(claim, row => { row.testRun!.spawning = true; })) throw new Error('Resource claim lost before spawn'); },
    estimateProfile: async (project, profileId) => {
      const measured = await snapshot();
      const volumes = deriveResourceAdmissionVolumes(paths, measured.fileSystemByPath);
      return resolveTestProfileResourceEstimate({ testRuns: options.config, project, profileId, fileSystemIds: volumes.requiredFileSystemIds });
    },
    prepare: async request => {
      const measured = await snapshot();
      const volumes = deriveResourceAdmissionVolumes(paths, measured.fileSystemByPath);
      const policy = loadFlowPolicy(join(options.root, 'conf/flow.json'));
      const candidates = store.sessionRepository.transaction(tx => tx.listSessions().filter(row => row.state === 'running' && row.process), 'read');
      const observations = await observeProcesses(candidates.map(row => row.process!));
      const observedProcesses = candidates.flatMap((row, i) => observations[i].state === 'alive' ? [{ runId: row.runId, identity: row.process! }] : []);
      return store.sessionRepository.transaction(tx => {
        const estimate = { status: request.estimate.status, sources: request.estimate.sources,
          reason: [...measured.reasons, ...volumes.reasons, ...(request.estimate.reason ? [request.estimate.reason] : [])].join('; ') || null };
        if (estimate.reason) estimate.status = 'UNKNOWN';
        let admission = buildAdmissionSnapshot({ input: { measurement: measured.measurement, requested: request.estimate.reservation,
          unusedReservations: [], ...volumes, estimate }, policy, requestedTier: request.requestedTier, queueId: '' });
        if (request.estimate.status === 'KNOWN' && estimate.status === 'KNOWN') {
          const decision = evaluateLaunchAdmissionInTransaction(tx, { requested: request.estimate.reservation, ...volumes, estimate }, { measurement: measured.measurement, observedProcesses }, input => {
            admission = buildAdmissionSnapshot({ input: { ...input, estimate }, policy, requestedTier: request.requestedTier, queueId: '' });
            return { level: admission.level, allowed: { normal: admission.level === 'ANY_RUN', hotfix: ['ANY_RUN', 'HOTFIX_ONLY'].includes(admission.level) }, reasons: admission.reasons, measurement: input.measurement, remaining: admission.remaining };
          });
          if (decision.level === 'UNKNOWN' && admission.level !== 'UNKNOWN') admission = buildAdmissionSnapshot({ input: {
            measurement: measured.measurement, requested: null, unusedReservations: [], ...volumes,
            estimate: { ...estimate, status: 'UNKNOWN', reason: decision.reasons.join('; ') } }, policy, requestedTier: request.requestedTier, queueId: '' });
        }
        if (!admission.allowed) return { status: 'refused' as const, claim: null, admission, nextAction: admission.level === 'UNKNOWN' ? 'fix-setup' as const : 'retry' as const };
        if (tx.listReservations().some(row => row.runId === request.testRunId)) throw new Error('Test run identity already reserved');
        const claim: TestRunResourceClaim = { machineId: options.machineId, testRunId: request.testRunId, fence: randomUUID(), groupKey: request.groupKey, deadlineMs: request.deadlineMs, processIdentity: null };
        tx.putReservation({ runId: request.testRunId, resource: 'test-run', amount: request.estimate.reservation!.ramBytes,
          resourceBundle: { machineId: options.machineId, resources: request.estimate.reservation! }, testRun: { claim, committed: false, ownerIdentity } });
        ownClaim = structuredClone(claim);
        return { status: 'prepared' as const, claim: structuredClone(claim), admission };
      });
    },
    commit: claim => update(claim, row => { row.testRun!.committed = true; }),
    current: async claim => store.sessionRepository.transaction(tx => !!find(tx.listReservations(), claim), 'read'),
    bindProcess: async (claim, identity) => {
      if (!await update(claim, row => {
        if (!row.testRun!.committed) throw new Error('Uncommitted resource claim');
        row.testRun!.claim.processIdentity = identity;
      })) throw new Error('Resource claim lost before binding process');
      claim.processIdentity = identity;
    },
    observeTree: async claim => {
      const row = store.sessionRepository.transaction(tx => find(tx.listReservations(), claim), 'read');
      if (!row) return { state: 'unknown', processIdentity: claim.processIdentity, consumed: null };
      if (row.testRun!.claim.processIdentity) return observeReservedTestTree(row.testRun!.claim.processIdentity);
      if (row.testRun!.spawning) return { state: 'unknown', processIdentity: null, consumed: null };
      if (row.testRun!.ownerIdentity === ownerIdentity) return { state: 'dead', processIdentity: null, consumed: null };
      const owner = observeReservedTestTree(row.testRun!.ownerIdentity);
      return { state: owner.state, processIdentity: null, consumed: null };
    },
    accountUsage: async () => {},
    release: async claim => store.sessionRepository.transaction(tx => {
      if (!find(tx.listReservations(), claim)) return false;
      tx.deleteReservation(claim.testRunId); return true;
    }),
    list: async machineId => store.sessionRepository.transaction(tx => tx.listReservations().flatMap(row => row.testRun?.claim.machineId === machineId ? [structuredClone(row.testRun.claim)] : []), 'read'),
  };
}
