import type { ResourceEstimateResolution, ResourceReservationEstimate } from './resource-estimates.ts';
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
  groupKey: TestRunGroupKey;
  requestedTier: 'normal' | 'hotfix';
  estimate: ResourceEstimateResolution;
  deadlineMs: number;
}

export type TestRunResourcePreparation =
  | { status: 'prepared'; claim: TestRunResourceClaim; admission: object }
  | { status: 'refused'; claim: null; admission: object; nextAction: 'retry' | 'fix-setup' };

export interface TestRunTreeObservation {
  state: 'dead' | 'alive' | 'unknown';
  processIdentity: string | null;
  consumed: ResourceReservationEstimate | null;
}

export interface TestRunResourcePort {
  markSpawning?(claim: TestRunResourceClaim): Promise<void>;
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
  wrapperIdentity?: string;
  resources: TestRunResourcePort;
  machineId: string;
}

export interface ResourceReservedTestRunResult extends TestRunResult {
  admission: object | null;
}

export interface TestRunResourceReconciliation {
  released: TestRunResourceClaim[];
  retained: TestRunResourceClaim[];
}

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
  let runId = '';
  const key = { project: request.project, workspace: context.workspace, group: request.group };
  const lost = () => Object.assign(new Error('Resource reservation fence lost'), { code: 'RESERVATION_LOST' });
  const restore = async () => ports.state.transaction(tx => {
    const group = tx.get(key);
    if (group?.inFlight?.runId !== runId) return;
    if (previous) tx.put(previous); else tx.delete(key);
  });
  const resourcePorts: TestRunPorts = {
    ...ports,
    newRunId: () => runId = ports.newRunId(),
    reconcile: async (identity, deadline) => ({ alive: true, deadlineReached: ports.clock.now() >= deadline, cleanup: { complete: false, remainingPids: [] } }),
    state: { transaction: async operation => {
      let acquired: TestRunGroup | null = null;
      const value = await ports.state.transaction(tx => operation({
        ...tx,
        put: group => {
          if (group.inFlight?.runId === runId && !tx.get(key)?.inFlight) {
            previous = structuredClone(tx.get(key));
            if (ports.wrapperIdentity) Object.assign(group.inFlight!, { wrapperIdentity: ports.wrapperIdentity });
            acquired = structuredClone(group);
          }
          tx.put(group);
        },
      }));
      if (acquired) {
        owned = acquired;
        try {
          const estimate = await ports.resources.estimateProfile(request.project, plan!.profileId);
          const prepared = await ports.resources.prepare({ testRunId: runId, groupKey: key,
            requestedTier: request.phase === 'hotfix' ? 'hotfix' : 'normal', estimate,
            deadlineMs: (owned as TestRunGroup | null)!.inFlight!.deadlineMs });
          admission = prepared.admission;
          if (prepared.status === 'refused') {
            refusal = prepared.nextAction;
            throw Object.assign(new Error('Resource admission refused'), { code: 'RESOURCE_UNAVAILABLE' });
          }
          claim = prepared.claim;
          if (!await ports.resources.commit(claim) || !await ports.resources.current(claim)) throw lost();
          const current = await ports.state.transaction(tx => tx.get(key));
          if (current?.inFlight?.runId !== runId) throw lost();
        } catch (error) {
          if (claim) {
            const observed = await ports.resources.observeTree(claim);
            if (observed.state === 'dead') released = await ports.resources.release(claim);
          }
          await restore();
          throw error;
        }
      }
      return value;
    } },
    preflight: async value => {
      const environment = await ports.preflight(value);
      const { planTestRun, validateTestRunConfig } = await import('./test-runs.ts');
      plan = planTestRun(request, validateTestRunConfig(configInput, context.agentPhases, policy), context, environment);
      return environment;
    },
    spawn: async (command, onEvent) => {
      if (!claim || !await ports.resources.current(claim)) throw lost();
      const group = await ports.state.transaction(tx => tx.get(key));
      if (group?.inFlight?.runId !== runId) throw lost();
      await ports.resources.markSpawning?.(claim);
      const child = await ports.spawn(command, onEvent);
      try { await ports.resources.bindProcess(claim, child.identity); }
      catch (error) { await child.cleanup(owned!.inFlight!.deadlineMs, 'interruption'); throw error; }
      return { ...child, cleanup: async (deadline, reason) => {
        const cleanup = await child.cleanup(deadline, reason);
        const observed = await ports.resources.observeTree(claim!);
        if (observed.consumed) await ports.resources.accountUsage(claim!, observed.consumed);
        if (observed.state !== 'dead') return { ...cleanup, complete: false };
        if (cleanup.complete && !cleanup.remainingPids.length) { released = await ports.resources.release(claim!); if (!released) return { ...cleanup, complete: false }; }
        return cleanup;
      } };
    },
  };
  let result: ResourceReservedTestRunResult | undefined;
  try {
    result = { ...await runTestRun(request, configInput, policy, context, resourcePorts), admission };
    result.admission = admission;
    const original = previous as TestRunGroup | null;
    if (refusal) {
      result.outcome = 'refused'; result.failureKinds = ['refusal']; result.errorCode = 'RESOURCE_UNAVAILABLE';
      result.exitCode = null; result.timedOut = false; result.nextAction = refusal;
      result.groupState = original?.state ?? 'idle';
      result.timeoutCount = original?.timeoutCount ?? 0; result.knownRed = original?.knownRed ?? [];
      result.unexecuted = result.selection.testIds.length ? result.selection.testIds : result.selection.files.map(file => ({ file, name: '*' }));
    }
    if (claim && !released && result.cleanup.complete) {
      const observed = await ports.resources.observeTree(claim);
      if (observed.consumed) await ports.resources.accountUsage(claim, observed.consumed);
      if (observed.state === 'dead') released = await ports.resources.release(claim);
      else {
        result.cleanup.complete = false; result.outcome = 'setup-failed'; result.failureKinds = ['setup'];
        result.groupState = 'reconcile'; result.nextAction = 'reconcile';
        await ports.state.transaction(tx => {
          const group = tx.get(key);
          if (!group || group.inFlight && group.inFlight.runId !== runId) return;
          group.inFlight = owned?.inFlight ?? null; group.state = 'reconcile'; group.lastResult = result!; tx.put(group);
        });
      }
    }
    if (!refusal) await ports.state.transaction(tx => {
      const group = tx.get(key);
      if (group?.lastResult?.runId === result!.runId) { group.lastResult = result!; tx.put(group); }
    });
    result.durationMs = ports.clock.now() - started;
    return result;
  } catch (error) {
    result ??= { ...testRunFailureResult(request, context, runId, started, configInput, error), admission };
    result.admission = admission;
    result.outcome = 'setup-failed'; result.failureKinds = ['setup']; result.errorCode = 'RESOURCE_RECONCILIATION_REQUIRED';
    result.cleanup.complete = false; result.groupState = 'reconcile'; result.nextAction = 'reconcile';
    result.durationMs = ports.clock.now() - started;
    return result;
  }
}

export async function reconcileTestRunResources(
  context: TestRunContext,
  policy: UnitTestPolicy,
  ports: ResourceReservedTestRunPorts,
): Promise<TestRunResourceReconciliation> {
  const released: TestRunResourceClaim[] = [], retained: TestRunResourceClaim[] = [];
  for (const claim of await ports.resources.list(ports.machineId)) {
    const observed = await ports.resources.observeTree(claim);
    if (observed.consumed) await ports.resources.accountUsage(claim, observed.consumed);
    if (observed.state !== 'dead') { retained.push(claim); continue; }
    const group = await ports.state.transaction(tx => tx.get(claim.groupKey));
    if (group?.inFlight?.runId === claim.testRunId) {
      if (group.inFlight.processIdentity) {
        const reconciled = await reconcileTestRunGroup(claim.groupKey, policy, { ...context, workspace: claim.groupKey.workspace }, ports);
        if (reconciled?.inFlight) { retained.push(claim); continue; }
      } else {
        await ports.state.transaction(tx => {
          const current = tx.get(claim.groupKey);
          if (current?.inFlight?.runId !== claim.testRunId) return;
          current.inFlight = null; current.state = 'idle'; tx.put(current);
        });
      }
    }
    if (await ports.resources.release(claim)) released.push(claim); else retained.push(claim);
  }
  const claims = [...released, ...retained];
  const groups = await ports.state.transaction(tx => Object.keys(context.projectWorkspaces).flatMap(project => tx.list(project, context.workspace)));
  for (const group of groups) {
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
