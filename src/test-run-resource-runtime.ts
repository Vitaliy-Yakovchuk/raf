import { createStoredLaunchQueueEvents, storedLaunchQueueIdentity } from './stored-launch-queue-events.ts';
import { hasTestRunPredecessor } from './test-run-queue-priority.ts';
import { runtimeResourceUsage } from './resource-usage-runtime.ts';
import type { UsageContext, UsageFinishReason, UsageIdentity } from './resource-usage.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  root: string; workspace: string; home: string; machineId: string; config: unknown; resultStatePath?: string; items?: UsageContext['items'];
}): TestRunResourcePort & { bindSpawn(identity: string): void; spawnFailed(): void } {
  const ownerIdentity = testWrapperIdentity();
  const queueIdentity = storedLaunchQueueIdentity(store, options.machineId);
  const queueEvents = createStoredLaunchQueueEvents(store, queueIdentity);
  const usage = runtimeResourceUsage(store.startupContextDatabase, options.root);
  let timer: ReturnType<typeof setInterval> | undefined;
  let pendingReasons: string[] = [];
  const usageIdentity = (claim: TestRunResourceClaim): UsageIdentity | null => {
    const record = usage.repository.get({ kind: 'test', id: claim.testRunId });
    return record?.context.identity.fence === claim.fence && record.context.identity.machineId === claim.machineId ? record.context.identity : null;
  };
  const sample = (claim: TestRunResourceClaim) => {
    try {
      const identity = usageIdentity(claim);
      if (!identity?.root) return;
      const at = Date.now();
      let observation;
      try { observation = usage.measurement.sample(identity, at); }
      catch { observation = { identity, at, ram: null, disk: [], reasons: ['Test lifecycle measurement unavailable'] }; }
      observation.reasons.push(...pendingReasons);
      if (usage.tracker.observe(observation)) pendingReasons = [];
    } catch { pendingReasons = ['A test usage sample could not be persisted']; }
  };
  const bindUsage = (claim: TestRunResourceClaim, processIdentity: string) => {
    const identity = usageIdentity(claim);
    if (!identity) return;
    const root = JSON.parse(processIdentity);
    if (!root.start || !Number.isSafeInteger(root.pid) || root.boot !== identity.bootId) return;
    usage.tracker.started({ ...identity, root: { pid: root.pid, startTicks: root.start, bootId: root.boot } }, Date.now());
    sample(claim);
    if (!timer) {
      const cadence = JSON.parse(readFileSync(join(options.root, 'conf/raf.json'), 'utf8')).service.hostTickIntervalMs;
      timer = setInterval(() => sample(claim), cadence);
      timer.unref();
    }
  };
  const finishUsage = (claim: TestRunResourceClaim, reason: UsageFinishReason) => {
    if (timer) { clearInterval(timer); timer = undefined; }
    const identity = usageIdentity(claim);
    if (identity) usage.tracker.finish(identity, { at: Date.now(), reason, verifiedComplete: false, reasons: [...pendingReasons, 'Sampled lifecycle observation; continuous peak and shared disk attribution are incomplete'] });
  };
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
  const bindPending = (testRunId: string, processIdentity: string) => store.eventRepository.transaction(tx => {
    const state = tx.loadQueue(queueIdentity)!;
    tx.saveQueue(queueIdentity, { ...state, pendingTests: state.pendingTests?.map(test =>
      test.testRunId === testRunId && test.ownerIdentity === ownerIdentity ? { ...test, processIdentity } : test) });
  });
  return {
    beforeSpawn: async (claim, paths) => {
      const identity = usageIdentity(claim);
      const record = identity && usage.repository.get(identity);
      if (!identity || !record || record.startedAt !== null) return;
      record.context.attributedPaths = [...new Set(paths)];
      record.baseline = usage.measurement.baseline(record.context);
      usage.repository.merge(identity, record);
    },
    sampleUsage: async claim => { sample(claim); },
    finishUsage: async (claim, reason) => { finishUsage(claim, reason); },
    resourceUsage: async claim => { const identity = usageIdentity(claim); return identity ? usage.repository.get(identity) : null; },
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
        bindPending(ownClaim!.testRunId, identity);
        bindUsage(ownClaim!, identity);
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
      const candidates = store.sessionRepository.transaction(tx => (tx.listActiveSessions?.() ?? tx.listSessions()).filter(row => row.state === 'running' && row.process), 'read');
      const observations = await observeProcesses(candidates.map(row => row.process!));
      const observedProcesses = candidates.flatMap((row, i) => observations[i].state === 'alive' ? [{ runId: row.runId, identity: row.process! }] : []);
      return store.sessionRepository.transaction(tx => {
        const estimate = { status: request.estimate.status, sources: request.estimate.sources,
          reason: [...measured.reasons, ...volumes.reasons, ...(request.estimate.reason ? [request.estimate.reason] : [])].join('; ') || null };
        if (estimate.reason) estimate.status = 'UNKNOWN';
        let admission = buildAdmissionSnapshot({ input: { measurement: measured.measurement, requested: request.estimate.reservation,
          unusedReservations: [], ...volumes, estimate }, policy, requestedTier: request.requestedTier, queueId: queueEvents.queueId() });
        if (request.estimate.status === 'KNOWN' && estimate.status === 'KNOWN') {
          const decision = evaluateLaunchAdmissionInTransaction(tx, { requested: request.estimate.reservation, ...volumes, estimate }, { measurement: measured.measurement, observedProcesses }, input => {
            admission = buildAdmissionSnapshot({ input: { ...input, estimate }, policy, requestedTier: request.requestedTier, queueId: queueEvents.queueId() });
            return { level: admission.level, allowed: { normal: admission.level === 'ANY_RUN', hotfix: ['ANY_RUN', 'HOTFIX_ONLY'].includes(admission.level) }, reasons: admission.reasons, measurement: input.measurement, remaining: admission.remaining };
          });
          if (decision.level === 'UNKNOWN' && admission.level !== 'UNKNOWN') admission = buildAdmissionSnapshot({ input: {
            measurement: measured.measurement, requested: null, unusedReservations: [], ...volumes,
            estimate: { ...estimate, status: 'UNKNOWN', reason: decision.reasons.join('; ') } }, policy, requestedTier: request.requestedTier, queueId: queueEvents.queueId() });
        }
        if (!admission.allowed) return { status: 'refused' as const, claim: null, admission, nextAction: admission.level === 'UNKNOWN' ? 'fix-setup' as const : 'retry' as const };
        if (request.deferReservation || !request.queuePermit && hasTestRunPredecessor(store, queueIdentity, request.requestedTier)) return { status: 'refused' as const, claim: null, admission, nextAction: 'retry' as const };
        if (tx.listReservations().some(row => row.runId === request.testRunId)) throw new Error('Test run identity already reserved');
        const claim: TestRunResourceClaim = { machineId: options.machineId, testRunId: request.testRunId, fence: randomUUID(), groupKey: request.groupKey, deadlineMs: request.deadlineMs, processIdentity: null };
        tx.putReservation({ runId: request.testRunId, resource: 'test-run', amount: request.estimate.reservation!.ramBytes,
          resourceBundle: { machineId: options.machineId, resources: request.estimate.reservation! }, testRun: { claim, committed: false, ownerIdentity } });
        usage.tracker.prepare({ identity: { kind: 'test', id: claim.testRunId, machineId: options.machineId, bootId: JSON.parse(ownerIdentity).boot, fence: claim.fence, root: null },
          project: request.groupKey.project, agentType: null, testProfile: request.profileId ?? null, items: options.items ?? [],
          requestedEstimate: { ...request.estimate.reservation!, sources: request.estimate.sources, confHash: createHash('sha256').update(JSON.stringify(options.config)).digest('hex') },
          requiredFileSystems: volumes.requiredFileSystemIds.map(id => ({ id, paths: Object.values(paths).filter(path => measured.fileSystemByPath[path] === id) })),
          resultStatePath: options.resultStatePath,
        }, true, Date.now());
        ownClaim = structuredClone(claim);
        return { status: 'prepared' as const, claim: structuredClone(claim), admission };
      });
    },
    commit: claim => update(claim, row => { row.testRun!.committed = true; row.testRun!.claim.deadlineMs = claim.deadlineMs; }),
    current: async claim => store.sessionRepository.transaction(tx => !!find(tx.listReservations(), claim), 'read'),
    bindProcess: async (claim, identity) => {
      if (!await update(claim, row => {
        if (!row.testRun!.committed) throw new Error('Uncommitted resource claim');
        row.testRun!.claim.processIdentity = identity;
        bindPending(claim.testRunId, identity);
      })) throw new Error('Resource claim lost before binding process');
      claim.processIdentity = identity;
      bindUsage(claim, identity);
    },
    observeTree: async claim => {
      const row = store.sessionRepository.transaction(tx => find(tx.listReservations(), claim), 'read');
      if (!row) return { state: 'unknown', processIdentity: claim.processIdentity, consumed: null };
      if (row.testRun!.claim.processIdentity) return observeReservedTestTree(row.testRun!.claim.processIdentity);
      if (row.testRun!.spawning) return { state: 'unknown', processIdentity: null, consumed: null,
        unboundOwner: row.testRun!.ownerIdentity === ownerIdentity ? 'alive' : observeReservedTestTree(row.testRun!.ownerIdentity ?? null).state };
      if (row.testRun!.ownerIdentity === ownerIdentity) return { state: 'dead', processIdentity: null, consumed: null };
      const owner = observeReservedTestTree(row.testRun!.ownerIdentity);
      return { state: owner.state, processIdentity: null, consumed: null };
    },
    accountUsage: async claim => { sample(claim); },
    release: async claim => store.sessionRepository.transaction(tx => {
      if (!find(tx.listReservations(), claim)) return false;
      const identity = usageIdentity(claim);
      const record = identity && usage.repository.get(identity);
      if (record?.finishedAt === null) finishUsage(claim, record.startedAt === null ? 'spawn-failure' : 'death');
      tx.deleteReservation(claim.testRunId); return true;
    }),
    list: async machineId => store.sessionRepository.transaction(tx => tx.listReservations().flatMap(row => row.testRun?.claim.machineId === machineId ? [structuredClone(row.testRun.claim)] : []), 'read'),
  };
}
