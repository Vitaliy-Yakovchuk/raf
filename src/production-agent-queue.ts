import { sameQueueNativeIdentity } from './agent-run-queue.ts';
import { promises as fs, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeServices, RuntimeContext, RuntimeReservationInput, RuntimeConfiguration } from './app-runtime.ts';
import { createAgentQueueState } from './agent-queue-state.ts';
import { reconcileAgentQueue, type AgentQueueRecord, type AgentRunQueuePorts } from './agent-run-queue.ts';
import type { StateStore } from './state-store.ts';
import type { SessionRecord, ProcessIdentity, ProcessObservation } from './session-state.ts';
import { assignmentFingerprint } from './task-context.ts';
import { waitForResources } from './resource-wait-command.ts';
import { readWaitIdentity, observeWaitIdentity } from './resource-wait-identity.ts';
import { failureContext } from './cli-contract.ts';
import { validateHotfixTrust } from './hotfix-worktree.ts';
import { reconcilePendingTestQueues } from './test-run-queue-runtime.ts';

export async function reconcileFinishedAgentQueues(dependencies: {
  store: StateStore;
  current(runId: string): SessionRecord | undefined;
  observe(identity: ProcessIdentity): Promise<ProcessObservation>;
  cleanReport(runId: string): Promise<void>;
}): Promise<void> {
  reconcilePendingTestQueues(dependencies.store);
  const state = createAgentQueueState(dependencies.store);
  for (const entry of state.transaction(() => state.list())) {
    const session = dependencies.current(entry.record.owner.runId);
    if (entry.ready) {
      if (session?.state === 'finished' || session?.state === 'running' && session.process &&
          (await dependencies.observe(session.process)).state === 'alive') state.transaction(() => state.remove(entry.record));
      continue;
    }
    if (session && session.state !== 'finished') continue;
    const client = await observeWaitIdentity(entry.record.clientIdentity);
    if (client.state !== 'dead') continue;
    await dependencies.cleanReport(entry.record.owner.runId);
    state.transaction(() => state.remove(entry.record, 'client-died'));
  }
}

export async function createProductionAgentQueue(input: RuntimeReservationInput, dependencies: {
  store: StateStore;
  context: RuntimeContext;
  api: RuntimeServices;
  configuration: RuntimeConfiguration;
  current(runId: string): SessionRecord | undefined;
  caller(): Promise<string | undefined>;
  observe(identity: ProcessIdentity): Promise<ProcessObservation>;
  reconcile(): Promise<void>;
  cleanReport(runId: string): Promise<void>;
}) {
  const { store, context, api, current } = dependencies;
  const state = createAgentQueueState(store);
  const clientIdentity = await readWaitIdentity();
  const owner = { runId: input.runId, fence: randomUUID() };
  const caller = await dependencies.caller();
  const coordinator = store.taskReservationRepository.transaction(tx => {
    const parent = caller && tx.listTaskReservations().find(set => set.lease.owner.runId === caller && set.stage === 'running' && tx.getSession(caller)?.activity?.type === 'coordinator');
    return parent ? { runId: parent.lease.owner.runId, fence: parent.lease.owner.fence } : null;
  });
  const queueId = state.queueId(realpathSync(context.statePath), clientIdentity.machineId);
  const request = { orchestratorRoot: context.orchestratorRoot, homeDirectory: context.stateContext?.homeDirectory ?? process.env.HOME!,
    developmentDirectory: input.activity.cwd, project: input.activity.project, agentId: input.addressId,
    agentType: input.activity.type, owner, clientIdentity,
    selections: input.assignment.changes.map(change => ({ change: change.id, items: change.items.map(item => item.id) })), coordinator };
  const record: AgentQueueRecord = { queueId, requestId: randomUUID(), agentId: input.addressId, owner, clientIdentity, coordinator, eventHandle: null };
  const ownsLaunch = (session: SessionRecord | undefined, record: AgentQueueRecord): boolean => {
    const queued = session?.launchContext?.agentQueue;
    return session?.state === 'running' && session.runId === input.runId && session.runId === record.owner.runId &&
      session.addressId === input.addressId && session.addressId === record.agentId && !!queued &&
      queued.queueId === record.queueId && queued.requestId === record.requestId && queued.agentId === record.agentId &&
      queued.owner.runId === record.owner.runId && queued.owner.fence === record.owner.fence &&
      isDeepStrictEqual(queued.clientIdentity, record.clientIdentity) && isDeepStrictEqual(queued.coordinator, record.coordinator);
  };
  const failure = (code: string, reason: string) => ({ code, message: reason, reason, stage: 'queue', source: 'production-agent-queue', sourceCode: null,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: false,
    remediation: ['Перевірте актуальність доручення, власника й стан запуску.'] });
  const ports: Omit<AgentRunQueuePorts, 'start' | 'verifyReady'> = {
    validate: async (_request, previous) => {
      try {
        const result = await api.assignment.validate({ root: input.assignment.root, selections: input.assignment.changes.map(change => ({ change: change.id,
          items: change.items.map(item => ({ id: item.id, expectedDescription: item.description })) })) });
        if (!result.ok) return { ok: false, failure: failure('INVALID_ASSIGNMENT', result.issues.map(issue => issue.reason).join('; ')) };
        const fingerprint = assignmentFingerprint(result.snapshot);
        if (fingerprint !== assignmentFingerprint(input.assignment) || previous && previous.fingerprint !== fingerprint) return { ok: false, failure: failure('INVALID_ASSIGNMENT', 'Assignment changed while waiting') };
        const task = await api.resolveTask(input.taskContext!.parameters, result.snapshot);
        const stable = ({ estimate: _estimate, requested: _requested, requiredFileSystemIds: _volumes, hotfix: _hotfix, ...rest }: typeof task) => input.taskContext?.context.hotfix ? { ...rest, writeBoundaries: [] } : rest;
        if (!isDeepStrictEqual(stable(task), stable(input.taskContext!.context))) return { ok: false, failure: failure('TASK_CONTEXT_CHANGED', 'Launch task context changed while waiting') };
        const route = await api.route({ root: context.orchestratorRoot, project: input.activity.project, branch: task.branch });
        if (!route.ok || route.cwd !== input.activity.cwd) return { ok: false, failure: failure('WORKSPACE_UNAVAILABLE', 'Workspace route changed while waiting') };
        const hotfix = input.taskContext?.context.hotfix;
        if (input.activity.type === 'hotfix' && input.activity.project === 'raf') {
          if (!hotfix || hotfix.runId !== input.runId || task.branch !== 'hotfix' ||
              !await validateHotfixTrust(context.orchestratorRoot, route.cwd, hotfix) ||
              await fs.realpath(hotfix.ownershipPath) !== hotfix.ownershipPath ||
              !isDeepStrictEqual(JSON.parse(await fs.readFile(hotfix.ownershipPath, 'utf8')), hotfix)) {
            return { ok: false, failure: failure('WORKSPACE_UNAVAILABLE', 'Hotfix workspace ownership changed while waiting') };
          }
        }
        const catalog = dependencies.configuration.models;
        const policy = input.handoff ? { ...catalog, models: catalog.models.filter(model => model.id !== input.handoff!.causeModel) } : catalog;
        const selection = api.selectModel(policy, await api.routingSnapshot(), {
          role: input.activity.type, complexity: input.taskContext!.parameters.complexity, ...(input.handoff ? { previousModel: input.handoff.causeModel } : {}) });
        if (selection.status !== 'selected' || !isDeepStrictEqual({ runner: selection.runner, model: selection.model, effort: selection.effort },
          { runner: input.selection.runner, model: input.selection.model, effort: input.selection.effort })) return { ok: false, failure: failure('RUNNER_UNAVAILABLE', 'Selected runner/model is no longer available') };
        return { ok: true, validation: { assignment: result.snapshot, fingerprint, requested: task.requested, requiredFileSystemIds: task.requiredFileSystemIds } };
      } catch (error) { return { ok: false, failure: failureContext(error) ?? failure('LAUNCH_PRECONDITION_FAILED', error instanceof Error ? error.message : String(error)) }; }
    },
    claimAndAdmit: async ({ validation }) => {
      const result = await api.reserve({ ...input, queueClaim: { record, validation, rechecking: false } });
      if (!result.admission) return { kind: 'refused', failure: failure('RESOURCE_UNAVAILABLE', 'Missing admission snapshot'), admission: null };
      if (!result.admitted && !result.waiting) return { kind: 'refused', failure: failure('RESOURCE_UNAVAILABLE', result.reason), admission: result.admission };
      return { kind: result.admitted ? 'reserved' : 'waiting', record, admission: result.admission };
    },
    waitForResources,
    transition: async (record, phase) => state.transaction(() => {
      const entry = state.get(record);
      if (!entry) return false;
      state.save({ ...entry, phase });
      return true;
    }),
    recheckAndReserve: async ({ record, validation, permit }) => {
      if (!permit.requestId || !permit.serviceEpoch || !Number.isFinite(permit.grantedAt)) return { kind: 'refused', failure: failure('RESOURCE_WAIT_FAILED', 'Invalid resource permit'), admission: null };
      const result = await api.reserve({ ...input, queueClaim: { record, validation, rechecking: true } });
      if (!result.admission) return { kind: 'refused', failure: failure('RESOURCE_UNAVAILABLE', 'Missing admission snapshot'), admission: null };
      if (!result.admitted && !result.waiting) return { kind: 'refused', failure: failure('RESOURCE_UNAVAILABLE', result.reason), admission: result.admission };
      return { kind: result.admitted ? 'reserved' : 'waiting', record, admission: result.admission };
    },
    commitReady: async (record, process) => {
      const ownsProcess = (session: SessionRecord | undefined): session is SessionRecord & { process: ProcessIdentity } => {
        return ownsLaunch(session, record) &&
          !!session?.process && session.process.pid === process.pid && session.process.startedAt === process.startedAt &&
          sameQueueNativeIdentity({ ...session.process, machineId: session.process.evidence.machineId, bootId: session.process.evidence.bootId, ...(process.runner === undefined ? { runner: undefined } : {}) }, process) &&
          session.process.evidence.machineId === process.machineId && session.process.evidence.bootId === process.bootId;
      };
      const session = state.transaction(tx => tx.getSession(record.owner.runId));
      if (!ownsProcess(session) || (await dependencies.observe(session.process)).state !== 'alive') return false;
      if (!await api.commitStarted(record.owner.runId, session.process)) return false;
      return state.transaction(tx => {
        const entry = state.get(record);
        const session = tx.getSession(record.owner.runId);
        if (!ownsProcess(session)) return false;
        if (!entry) return true;
        if (entry.phase !== 'starting' || !entry.ready || entry.record.agentId !== record.agentId) return false;
        return state.remove(record);
      });
    },
    cleanup: async (record, reason, detail) => {
      const failedOwnLaunch = reason === 'launch-failed' && ownsLaunch(current(record.owner.runId), record);
      if (!state.transaction(() => state.get(record)) && !failedOwnLaunch) return { state: 'retained', reason: 'Launch fence is no longer owned by this client', completed: [], pending: [] };
      state.transaction(() => {
        const entry = state.get(record);
        if (entry && !entry.ready) state.save({ ...entry, terminalReason: entry.terminalReason ?? reason });
      });
      const session = current(record.owner.runId);
      if (session?.state === 'running' && (failedOwnLaunch || state.transaction(() => state.get(record))?.ready)) {
        if (!session.process) return { state: 'unknown', reason: 'Running agent identity is missing', completed: [], pending: ['agent reconciliation'] };
        const observation = await dependencies.observe(session.process);
        if (observation.state !== 'exited' && !failedOwnLaunch) return { state: observation.state === 'alive' ? 'retained' : 'unknown', reason: 'Agent owns the launched process and reservation', completed: [], pending: [] };
      }
      if (session && session.state !== 'finished' && record.owner.runId !== input.runId) return { state: 'unknown', reason: 'Existing worker lifecycle must reconcile this launch', completed: [], pending: ['launch reconciliation'] };
      if (session && session.state !== 'finished') {
        const stopped = await api.compensate({ ...input, runId: record.owner.runId }, detail);
        if (!stopped.stopped) return { state: 'unknown', reason: stopped.reason, completed: [], pending: ['process termination'] };
        await api.abortLaunch(record.owner.runId, detail);
        const remaining = current(record.owner.runId);
        if (remaining && remaining.state !== 'finished') return { state: 'unknown', reason: 'Launch cleanup is incomplete', completed: [], pending: ['launch cleanup'] };
      }
      await dependencies.cleanReport(record.owner.runId);
      const removed = state.transaction(() => state.remove(record, reason) || failedOwnLaunch && !state.get(record) && current(record.owner.runId)?.state === 'finished');
      return { state: removed ? 'released' : 'retained', reason: detail, completed: removed ? ['launch claims', 'resource reservation', 'report cleanup'] : [], pending: [] };
    },
    observe: async record => {
      if (!state.transaction(() => state.get(record))) return { owner: 'other', client: 'unknown', agent: 'unknown', reason: 'Launch fence changed' };
      const session = current(record.owner.runId);
      if (session?.state === 'running' && session.process && state.transaction(() => state.get(record))?.ready) {
        const observation = await dependencies.observe(session.process);
        if (observation.state === 'alive') return { owner: 'agent', client: 'unknown', agent: 'alive', reason: 'Confirmed agent retains ownership' };
        if (observation.state === 'unknown') return { owner: 'client', client: 'unknown', agent: 'unknown', reason: observation.error };
      }
      if (session && session.state !== 'finished' && session.state !== 'running') return { owner: 'client', client: 'unknown', agent: 'unknown', reason: 'Worker launch needs existing reservation reconciliation' };
      const client = await observeWaitIdentity(record.clientIdentity);
      return { owner: 'client', client: client.state === 'dead' ? 'dead' : client.state === 'alive' ? 'alive' : 'unknown', agent: 'dead', reason: client.state === 'alive' ? 'Launch client is alive' : client.reason };
    },
    writeStderr: line => process.stderr.write(line),
  };
  if (state.transaction(() => state.list()).some(entry => current(entry.record.owner.runId)?.state !== 'finished' && current(entry.record.owner.runId))) await dependencies.reconcile();
  for (const entry of state.transaction(() => state.list())) {
    const reconciled = await reconcileAgentQueue(entry.record, ports as AgentRunQueuePorts);
    if (reconciled.state === 'retained' && entry.ready && current(entry.record.owner.runId)?.state === 'running') {
      const observation = await ports.observe(entry.record);
      if (observation.owner === 'agent' && observation.agent === 'alive') state.transaction(() => state.remove(entry.record));
    }
  }
  return { request, ports };
}
