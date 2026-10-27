import { isDeepStrictEqual } from 'node:util';
import type { TestRunConfigurationSnapshot, TestRunConfigurationDependencyPort } from './test-run-config-dependencies.ts';
import type { TestRunQueueRecord } from './test-run-queue.ts';
import type { ResourceUsageRecord, UsageFinishReason } from './resource-usage.ts';
import type { ResourceEstimateResolution, ResourceReservationEstimate } from './resource-estimates.ts';
import type { TestRunQueuePort, TestRunResourceRoute } from './test-run-queue.ts';
import { observeReservedTestTree } from './test-run-resource-process.ts';
import { runTestRun, reconcileTestRunGroup, testRunFailureResult } from './test-runs.ts';
import type { TestRunGroup, TestRunPlan, TestRunContext, TestRunGroupKey, TestRunPorts, TestRunRequest, TestRunResult, UnitTestPolicy } from './test-runs.ts';

export interface TestRunResourceClaim {
  machineId: string;
  testRunId: string;
  fence: string;
  groupKey: TestRunGroupKey;
  deadlineMs: number;
  processIdentity: string | null;
}

export interface TestRunResourceRequest {
  testRunId: string;
  profileId?: string;
  groupKey: TestRunGroupKey;
  requestedTier: 'normal' | 'hotfix';
  estimate: ResourceEstimateResolution;
  deadlineMs: number;
  queuePermit?: boolean;
  deferReservation?: boolean;
}

export type TestRunResourcePreparation =
  | { status: 'prepared'; claim: TestRunResourceClaim; admission: object }
  | { status: 'refused'; claim: null; admission: object; nextAction: 'retry' | 'fix-setup' };

export interface TestRunTreeObservation {
  state: 'dead' | 'alive' | 'unknown';
  processIdentity: string | null;
  consumed: ResourceReservationEstimate | null;
  unboundOwner?: 'dead' | 'alive' | 'unknown';
}

export interface TestRunResourcePort {
  beforeSpawn?(claim: TestRunResourceClaim, paths: string[]): Promise<void>;
  sampleUsage?(claim: TestRunResourceClaim): Promise<void>;
  finishUsage?(claim: TestRunResourceClaim, reason: UsageFinishReason): Promise<void>;
  resourceUsage?(claim: TestRunResourceClaim): Promise<ResourceUsageRecord | null>;
  markSpawning?(claim: TestRunResourceClaim): Promise<void>;
  spawnFailed?(): void;
  estimateProfile(project: string, profileId: string): Promise<ResourceEstimateResolution>;
  prepare(request: TestRunResourceRequest): Promise<TestRunResourcePreparation>;
  commit(claim: TestRunResourceClaim): Promise<boolean>;
  current(claim: TestRunResourceClaim): Promise<boolean>;
  bindProcess(claim: TestRunResourceClaim, processIdentity: string): Promise<void>;
  observeTree(claim: TestRunResourceClaim): Promise<TestRunTreeObservation>;
  accountUsage(claim: TestRunResourceClaim, consumed: ResourceReservationEstimate): Promise<void>;
  release(claim: TestRunResourceClaim): Promise<boolean>;
  list(machineId: string): Promise<TestRunResourceClaim[]>;
}

export interface ResourceReservedTestRunPorts extends TestRunPorts {
  configurationDependencies?: TestRunConfigurationDependencyPort;
  resourceRoute?: TestRunResourceRoute;
  queue?: TestRunQueuePort;
  wrapperIdentity?: string;
  resources: TestRunResourcePort;
  machineId: string;
}

export interface ResourceReservedTestRunResult extends TestRunResult {
  admission: object | null;
  queue?: { queueId: string; waited: boolean } | null;
}

export interface TestRunResourceReconciliation {
  released: TestRunResourceClaim[];
  retained: TestRunResourceClaim[];
}

const pendingGroups = new WeakMap<object, Map<string, string>>();

export async function runResourceReservedTestRun(
  request: TestRunRequest,
  configInput: unknown,
  policy: UnitTestPolicy,
  context: TestRunContext,
  ports: ResourceReservedTestRunPorts,
): Promise<ResourceReservedTestRunResult> {
  const started = ports.clock.now();
  let claim: TestRunResourceClaim | null = null;
  let released = false;
  let admission: object | null = null;
  let refusal: 'retry' | 'fix-setup' | null = null;
  let previous: TestRunGroup | null = null;
  let owned: TestRunGroup | null = null;
  let plan: TestRunPlan | null = null;
  let currentConfiguration: import('./test-runs.ts').TestRunConfig | undefined;
  let runId = '';
  let record: TestRunQueueRecord | null = null;
  let queueStarted = false;
  let pendingOwned = false;
  let accepted = false;
  let waitError: string | null = null;
  let configurationSnapshot: TestRunConfigurationSnapshot | undefined;
  let preSpawnRejected = false;
  let interrupted: string | null = null;
  const controller = new AbortController();
  let unsubscribe = () => {};
  let requestedTier: 'normal' | 'hotfix' = 'normal';
  const pendingKey = JSON.stringify([request.project, context.workspace, request.group]);
  const pending = pendingGroups.get(ports.state) ?? new Map<string, string>();
  pendingGroups.set(ports.state, pending);
  const fail = (code: string, message = code): never => { throw Object.assign(new Error(message), { code }); };
  const checkPending = () => { if (pending.has(pendingKey) && pending.get(pendingKey) !== runId) fail('GROUP_IN_FLIGHT'); };
  const checkSignal = () => { if (controller.signal.aborted) fail('INTERRUPTED', interrupted ?? 'Interrupted while waiting'); };
  const releasePrepared = async () => {
    if (!claim || released) return;
    const observed = await ports.resources.observeTree(claim);
    if (observed.state === 'dead') released = await ports.resources.release(claim);
  };
  const key = { project: request.project, workspace: context.workspace, group: request.group };
  const recheckConfiguration = async (at: 'reservation' | 'spawn') => {
    if (configurationSnapshot) await ports.configurationDependencies!.recheck(configurationSnapshot, at);
    configInput = ports.configurationDependencies?.current?.() ?? configInput;
  };
  const updatePlan = async (environment: import('./test-runs.ts').TestRunEnvironment, group: TestRunGroup) => {
    if (!ports.configurationDependencies?.current) return;
    const { planTestRun, validateTestRunConfig } = await import('./test-runs.ts');
    currentConfiguration = validateTestRunConfig(configInput, context.agentPhases, policy, context.integrationTests);
    const updated = planTestRun(request, currentConfiguration, context, environment);
    if ((updated.testKind ?? 'unit') !== group.testKind) fail('GROUP_PROFILE_MISMATCH');
    plan = updated;
    group.profileId = plan.profileId;
    group.selection = plan.selection;
    Object.assign(group.inFlight!, { selection: plan.selection, command: plan.command });
  };
  const lost = () => Object.assign(new Error('Resource reservation fence lost'), { code: 'RESERVATION_LOST' });
  const restore = async () => ports.state.transaction(tx => {
    const group = tx.get(key);
    if (group?.inFlight?.runId !== runId && !(preSpawnRejected && group?.lastResult?.runId === runId)) return;
    if (previous) tx.put(previous); else tx.delete(key);
  });
  const resourcePorts: TestRunPorts = {
    ...ports,
    ...(ports.configurationDependencies?.current ? { reservedPlan: () => ({ configuration: currentConfiguration!, plan: plan! }) } : {}),
    newRunId: () => runId = ports.newRunId(),
    reconcile: async () => ({ alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [] } }),
    state: { transaction: async operation => {
      let acquired: TestRunGroup | null = null;
      const value = await ports.state.transaction(tx => operation({
        ...tx,
        get: key => structuredClone(tx.get(key)),
        put: group => {
          if (group.inFlight?.runId === runId && !tx.get(key)?.inFlight) {
            checkPending();
            previous = structuredClone(tx.get(key));
            if (ports.wrapperIdentity) Object.assign(group.inFlight!, { wrapperIdentity: ports.wrapperIdentity, ownerIdentity: ports.wrapperIdentity });
            acquired = group;
            pending.set(pendingKey, runId);
            pendingOwned = true;
          } else tx.put(group);
        },
      }));
      const acquiredGroup = acquired as TestRunGroup | null;
      if (acquiredGroup) {
        owned = acquiredGroup;
        try {
          configurationSnapshot = await ports.configurationDependencies?.capture();
          if (ports.queue?.claimGroup && !await ports.queue.claimGroup(runId, key)) fail('GROUP_IN_FLIGHT');
          unsubscribe = ports.subscribeInterruption(signal => { interrupted = signal; controller.abort(); });
          let permit = false;
          let mustWait = await ports.queue?.hasPending(requestedTier) ?? false;
          for (;;) {
            checkSignal();
            await recheckConfiguration('reservation');
            const environment = await ports.preflight(context);
            await updatePlan(environment, acquiredGroup);
            {
              const estimate = await ports.resources.estimateProfile(request.project, plan!.profileId);
              const prepared = await ports.resources.prepare({ testRunId: runId, profileId: plan!.profileId, groupKey: key,
                requestedTier, estimate, queuePermit: permit, deferReservation: mustWait, deadlineMs: ports.clock.now() + acquiredGroup.inFlight!.timeoutPolicy!.timeoutMs });
              admission = prepared.admission;
              if (prepared.status === 'prepared') {
                claim = prepared.claim;
                released = false;
                if (!mustWait) break;
                await releasePrepared();
                if (!released) throw lost();
                claim = null;
              }
              if (prepared.status === 'refused' && prepared.nextAction === 'fix-setup') {
                refusal = 'fix-setup';
                fail('RESOURCE_UNAVAILABLE', 'Resource admission is unknown');
              }
            }
            if (!ports.queue) fail('RESOURCE_WAIT_UNAVAILABLE', 'Resource queue is unavailable');
            if (!record) record = await ports.queue!.enqueue({ testRunId: runId, groupKey: key, requestedTier, admission });
            if (!await ports.queue!.transition(record, 'waiting')) throw lost();
            ports.queue!.writeStderr(JSON.stringify({ kind: 'launch-queue.waiting', queueId: record.queueId,
              requestId: record.requestId, testRunId: runId, admission }) + '\n');
            const waited = await ports.queue!.waitForResources({ record, level: requestedTier, workload: 'test', signal: controller.signal });
            checkSignal();
            if (waited.kind === 'error') fail('RESOURCE_WAIT_FAILED', waited.diagnostic.details);
            if (!await ports.queue!.transition(record, 'rechecking')) throw lost();
            await recheckConfiguration('reservation');
            const refreshedEnvironment = await ports.preflight(context);
            const { planTestRun, validateTestRunConfig } = await import('./test-runs.ts');
            const updated = planTestRun(request, validateTestRunConfig(configInput, context.agentPhases, policy, context.integrationTests), context, refreshedEnvironment);
            if (!ports.configurationDependencies?.current && !isDeepStrictEqual(plan, updated)) fail('TEST_RUN_PLAN_CHANGED');
            const routes = ports.resourceRoute?.branchPaths;
            if (routes && (!Object.values(routes).includes(refreshedEnvironment.canonicalWorkspace) ||
                (routes.hotfix === refreshedEnvironment.canonicalWorkspace ? 'hotfix' : 'normal') !== requestedTier)) fail('WORKSPACE_MISMATCH');
            permit = true;
            mustWait = false;
          }
          checkSignal();
          const deadline = ports.clock.now() + acquiredGroup.inFlight!.timeoutPolicy!.timeoutMs;
          claim!.deadlineMs = deadline;
          acquiredGroup.inFlight!.deadlineMs = deadline;
          acquiredGroup.inFlight!.startedAtMs = ports.clock.now();
          if (!await ports.resources.commit(claim!) || !await ports.resources.current(claim!)) throw lost();
          if (record && !await ports.queue!.transition(record, 'starting')) throw lost();
          await recheckConfiguration('reservation');
          await updatePlan(await ports.preflight(context), acquiredGroup);
          await ports.state.transaction(tx => {
            if (!isDeepStrictEqual(tx.get(key), previous)) throw lost();
            tx.put(owned!);
          });
          accepted = true;
        } catch (error) {
          waitError = (error as any)?.code ?? 'RESOURCE_WAIT_FAILED';
          await releasePrepared();
          await restore();
          throw error;
        } finally { unsubscribe(); unsubscribe = () => {}; }
      }
      return value;
    } },
    preflight: async value => {
      const environment = await ports.preflight(value);
      const { planTestRun, validateTestRunConfig } = await import('./test-runs.ts');
      plan = planTestRun(request, validateTestRunConfig(configInput, context.agentPhases, policy, context.integrationTests), context, environment);
      if (!ports.resourceRoute || !Object.values(ports.resourceRoute.branchPaths).includes(environment.canonicalWorkspace)) fail('WORKSPACE_MISMATCH', 'A trusted canonical resource route is required');
      requestedTier = ports.resourceRoute!.branchPaths.hotfix === environment.canonicalWorkspace ? 'hotfix' : 'normal';
      checkPending();
      return environment;
    },
    spawn: async (command, onEvent) => {
      if (!claim || !await ports.resources.current(claim)) throw lost();
      const group = await ports.state.transaction(tx => tx.get(key));
      if (group?.inFlight?.runId !== runId) throw lost();
      try {
        await ports.resources.beforeSpawn?.(claim, command.environment.TMPDIR ? [command.environment.TMPDIR] : []);
        await ports.resources.markSpawning?.(claim);
        await recheckConfiguration('spawn');
        await ports.preflight(context);
      } catch (error) {
        preSpawnRejected = true;
        waitError = (error as any)?.code ?? 'RUNNER_SETUP_FAILED';
        ports.resources.spawnFailed?.();
        throw error;
      }
      const child = await ports.spawn(command, onEvent);
      try { await ports.resources.bindProcess(claim, child.identity); }
      catch (error) { await child.cleanup(owned!.inFlight!.deadlineMs, 'interruption'); throw error; }
      if (record) {
        try {
          if (!await ports.queue!.started(record, child.identity)) throw lost();
          queueStarted = true;
        } catch (error) { await child.cleanup(owned!.inFlight!.deadlineMs, 'interruption'); throw error; }
      }
      return { ...child, cleanup: async (deadline, reason) => {
        await ports.resources.sampleUsage?.(claim!);
        const cleanup = await child.cleanup(deadline, reason);
        const observed = await ports.resources.observeTree(claim!);
        if (observed.consumed) await ports.resources.accountUsage(claim!, observed.consumed);
        const treeDead = observed.state === 'dead' || (!cleanup.remainingPids.length && cleanup.complete && observed.state === 'unknown' && !await ports.resources.current(claim!));
        if (!treeDead) return { ...cleanup, complete: false };
        await ports.resources.finishUsage?.(claim!, reason === 'interruption' ? 'signal' : reason === 'recovery' ? 'death' : reason);
        if (cleanup.complete && !cleanup.remainingPids.length) {
          released = await ports.resources.release(claim!) || !(await ports.resources.list(ports.machineId)).some(item => item.testRunId === claim!.testRunId);
          if (!released) return { ...cleanup, complete: false };
        }
        return cleanup;
      } };
    },
  };
  let result: ResourceReservedTestRunResult | undefined;
  try {
    const base = await runTestRun(request, configInput, policy, context, resourcePorts);
    if (base.runId !== runId) return base as ResourceReservedTestRunResult;
    result = { ...base, admission };
    result.admission = admission;
    if (result.stateAccess) return result;
    const original = previous as TestRunGroup | null;
    if (owned && !accepted) {
      if (result.outcome !== 'setup-failed') { result.outcome = 'refused'; result.failureKinds = ['refusal']; }
      result.errorCode = refusal ? 'RESOURCE_UNAVAILABLE' : waitError ?? result.errorCode;
      result.exitCode = null; result.timedOut = false; result.nextAction = 'fix-setup';
      if (interrupted) { result.outcome = 'interrupted'; result.failureKinds = ['interruption']; result.signal = interrupted; }
      result.groupState = original?.state ?? 'idle';
      result.timeoutCount = original?.timeoutCount ?? 0; result.knownRed = original?.knownRed ?? [];
      result.unexecuted = result.selection.testIds.length ? result.selection.testIds : result.selection.files.map(file => ({ file, name: '*' }));
    }
    if (claim && !released && result.cleanup.complete) {
      const observed = await ports.resources.observeTree(claim);
      if (observed.consumed) await ports.resources.accountUsage(claim, observed.consumed);
      const treeDead = observed.state === 'dead' || (!result.cleanup.remainingPids.length && observed.state === 'unknown' && !await ports.resources.current(claim));
      if (treeDead) released = await ports.resources.release(claim) || !(await ports.resources.list(ports.machineId)).some(item => item.testRunId === claim!.testRunId);
      if (!treeDead || !released) {
        result.cleanup.complete = false; result.outcome = 'setup-failed'; result.failureKinds = ['setup'];
        result.groupState = 'reconcile'; result.nextAction = 'reconcile';
        await ports.state.transaction(tx => {
          const group = tx.get(key);
          if (!group || group.inFlight && group.inFlight.runId !== runId) return;
          group.inFlight = owned?.inFlight ?? null; group.state = 'reconcile'; group.lastResult = result!; tx.put(group);
        });
      }
    }
    if (preSpawnRejected && result.cleanup.complete && (!claim || released)) {
      await restore();
      result.outcome = 'refused'; result.failureKinds = ['refusal']; result.exitCode = null;
      result.errorCode = waitError; result.timedOut = false; result.nextAction = 'fix-setup';
      result.timeoutCount = original?.timeoutCount ?? 0; result.knownRed = original?.knownRed ?? [];
      result.unexecuted = original?.unexecuted ?? []; result.unknown = original?.unknown ?? [];
      result.groupState = original?.state ?? 'idle';
    }
    result.resourceUsage = claim ? await ports.resources.resourceUsage?.(claim) ?? null : null;
    if (result.runId === runId) result.durationMs = ports.clock.now() - started;
    const queueRecord = record as TestRunQueueRecord | null;
    result.queue = queueRecord ? { queueId: queueRecord.queueId, waited: true } : null;
    if (!refusal && owned) await ports.state.transaction(tx => {
      const group = tx.get(key);
      if (group?.lastResult?.runId === result!.runId) { group.lastResult = result!; tx.put(group); }
    });
    return result;
  } catch (error) {
    result ??= { ...testRunFailureResult(request, context, runId, started, configInput, error), admission };
    result.admission = admission;
    const queueRecord = record as TestRunQueueRecord | null;
    result.queue = queueRecord ? { queueId: queueRecord.queueId, waited: true } : null;
    result.resourceUsage = claim ? await ports.resources.resourceUsage?.(claim) ?? null : null;
    if ((error as any)?.stateAccess) { result.stateAccess = (error as any).stateAccess; result.errorCode = (error as any).code; return result; }
    result.outcome = 'setup-failed'; result.failureKinds = ['setup']; result.errorCode = 'RESOURCE_RECONCILIATION_REQUIRED';
    result.cleanup.complete = false; result.groupState = 'reconcile'; result.nextAction = 'reconcile';
    result.durationMs = ports.clock.now() - started;
    return result;
  } finally {
    unsubscribe();
    if (record && !queueStarted) {
      try { await ports.queue!.finish(record, interrupted ? 'cancelled' : 'failed', waitError ?? 'launch-failed'); }
      catch { if (result) { result.cleanup.complete = false; result.nextAction = 'reconcile'; result.groupState = 'reconcile'; result.outcome = 'setup-failed'; result.failureKinds = ['setup']; } }
    }
    if (pendingOwned) {
      try { await ports.queue?.releaseGroup?.(runId, key); }
      catch { if (result) { result.cleanup.complete = false; result.nextAction = 'reconcile'; result.groupState = 'reconcile'; result.outcome = 'setup-failed'; result.failureKinds = ['setup']; } }
      if (pending.get(pendingKey) === runId) pending.delete(pendingKey);
    }
  }
}

export async function reconcileTestRunResources(
  context: TestRunContext,
  policy: UnitTestPolicy,
  ports: ResourceReservedTestRunPorts,
): Promise<TestRunResourceReconciliation> {
  const released: TestRunResourceClaim[] = [], retained: TestRunResourceClaim[] = [];
  for (const claim of await ports.resources.list(ports.machineId)) {
    if (ports.recoverGroup && claim.groupKey.workspace !== context.workspace) {
      retained.push(claim); continue;
    }
    let observed = await ports.resources.observeTree(claim);
    if (observed.consumed) await ports.resources.accountUsage(claim, observed.consumed);
    const group = await ports.state.transaction(tx => tx.get(claim.groupKey));
    if (observed.state !== 'dead' && (!group?.inFlight || group.inFlight.runId !== claim.testRunId || ports.clock.now() < group.inFlight.deadlineMs)) {
      retained.push(claim); continue;
    }
    if (group?.inFlight?.runId === claim.testRunId) {
      if (ports.recoverGroup) { retained.push(claim); continue; }
      if (group.inFlight.processIdentity) {
        if (observed.state === 'unknown' && (observed.processIdentity !== group.inFlight.processIdentity || claim.processIdentity !== group.inFlight.processIdentity || !await ports.resources.current(claim))) {
          retained.push(claim); continue;
        }
        const reconciled = await reconcileTestRunGroup(claim.groupKey, policy, { ...context, workspace: claim.groupKey.workspace }, ports);
        if (reconciled?.inFlight) { retained.push(claim); continue; }
        observed = await ports.resources.observeTree(claim);
        if (observed.consumed) await ports.resources.accountUsage(claim, observed.consumed);
      } else if (observed.state === 'dead') {
        await ports.state.transaction(tx => {
          const current = tx.get(claim.groupKey);
          if (current?.inFlight?.runId !== claim.testRunId) return;
          current.inFlight = null; current.state = 'idle'; tx.put(current);
        });
      }
    }
    if (observed.state !== 'dead') { retained.push(claim); continue; }
    if (await ports.resources.release(claim)) {
      released.push(claim);
      const summary = await ports.resources.resourceUsage?.(claim) ?? null;
      await ports.state.transaction(tx => { const current = tx.get(claim.groupKey); if (current?.lastResult?.runId === claim.testRunId) { current.lastResult.resourceUsage = summary; tx.put(current); } });
    } else retained.push(claim);
  }
  const claims = [...released, ...retained];
  const groups = await ports.state.transaction(tx => Object.keys(context.projectWorkspaces).flatMap(project => tx.list(project, context.workspace)));
  for (const group of groups) {
    if (ports.recoverGroup) continue;
    if (!group.inFlight || claims.some(claim => claim.groupKey.project === group.key.project && claim.groupKey.workspace === group.key.workspace && claim.groupKey.group === group.key.group)) continue;
    if (group.inFlight.processIdentity) {
      await reconcileTestRunGroup(group.key, policy, context, ports);
      continue;
    }
    const owner = (group.inFlight as typeof group.inFlight & { wrapperIdentity?: string }).wrapperIdentity;
    if (owner && observeReservedTestTree(owner).state !== 'dead') continue;
    await ports.state.transaction(tx => {
      const current = tx.get(group.key);
      if (current?.inFlight?.runId !== group.inFlight!.runId || current.inFlight.processIdentity) return;
      current.inFlight = null; current.state = 'idle'; tx.put(current);
    });
  }
  return { released, retained };
}
