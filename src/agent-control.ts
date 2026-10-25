import { sameProcessOwnership } from './process-identity.ts';
import { stripVTControlCharacters } from 'node:util';
import { failureContext } from './cli-contract.ts';
import type { ProcessIdentity, ProcessObservation, SessionActivity, SessionRecord, SessionRepository, WorkResult } from './session-state.ts';
import type { SessionCloseCheck, SessionEnd } from './reminders.ts';

export type ActivityUpdate = Pick<SessionActivity, 'project' | 'features' | 'phase'>;
export type ActivityEvent = {
  kind: 'started' | 'updated' | 'ended';
  session: SessionRecord;
  project: string;
};
export type VerifiedSender = { kind: 'agent'; runId: string } | { kind: 'system' };
export type DeliveryReceipt = { accepted: true; receiptId: string } | { accepted: false; reason: string };
export interface AgentControlCoordinator {
  prepareClose(session: SessionRecord, options: { force?: boolean; reason?: string }): Promise<SessionRecord>;
  observe(session: SessionRecord, observation: ProcessObservation): Promise<SessionRecord>;
  updateActivity(session: SessionRecord, update: ActivityUpdate, events: readonly ActivityEvent[]): Promise<SessionRecord>;
  finalize(session: SessionRecord, events: readonly ActivityEvent[]): Promise<SessionRecord>;
  publish(events: readonly ActivityEvent[]): Promise<void>;
  acceptPendingReport(session: SessionRecord): Promise<SessionRecord>;
}
export interface AgentControlDependencies {
  repository: SessionRepository;
  coordinator: AgentControlCoordinator;
  scanner: {
    inspect(identity: ProcessIdentity): Promise<ProcessObservation>;
    inspectMany?(identities: readonly ProcessIdentity[]): Promise<ProcessObservation[]>;
  };
  authority: { resolve(caller: unknown): Promise<VerifiedSender> };
  transport: {
    deliver(target: ProcessIdentity, text: string): Promise<DeliveryReceipt>;
    close(target: ProcessIdentity): Promise<void>;
    interrupt(target: ProcessIdentity): Promise<void>;
  };
  reminders: { sessionEnded(input: SessionEnd): SessionCloseCheck };
  projects: readonly string[];
  agentTypes: readonly string[];
  agentPhases?: readonly string[];
}
export type MessageRequest = { to: string; text: string; runId?: string };
export type MainAttachment = {
  id: 'main';
  runId: string;
  tmuxSocket: string;
  tmuxSession: string;
  tmuxPane: string;
  pid: number;
  startedAt: string;
  machineId: string;
  bootId: string;
};
export class MainAttachedElsewhereError extends Error {
  readonly session: SessionRecord;

  constructor(session: SessionRecord) {
    super('Main is already attached from another live pane');
    this.name = 'MainAttachedElsewhereError';
    this.session = session;
  }
}
export type CloseOptions = { force?: boolean; reason?: string };
export type CloseResult = { forcedClose?: { reason: string }; closed: boolean; unfinished: SessionCloseCheck['unfinished']; result?: WorkResult['status'] };
export type AgentPsSession = SessionRecord & { reconciliation?: { code: 'WORKER_RESULT_PENDING'; reason: string } };

export class AgentControlService {
  private dependencies: AgentControlDependencies;
  private closing = new Map<string, Promise<CloseResult>>();

  constructor(dependencies: AgentControlDependencies) {
    this.dependencies = dependencies;
  }

  private sessions(): SessionRecord[] {
    return this.dependencies.repository.transaction(tx => structuredClone(tx.listSessions()), 'read');
  }

  private sameProcess(expected: ProcessIdentity, actual: ProcessIdentity): boolean {
    return sameProcessOwnership(expected, actual);
  }

  private events(session: SessionRecord, kind: ActivityEvent['kind']): ActivityEvent[] {
    return session.activity ? [{ kind, session: structuredClone(session), project: session.activity.project }] : [];
  }

  private async inspect(identity: ProcessIdentity, requireOwnership = false): Promise<ProcessObservation> {
    let observation: ProcessObservation;
    try {
      observation = await this.dependencies.scanner.inspect(identity);
    } catch (error) {
      observation = { state: 'unknown', observedAt: new Date().toISOString(), error: String(error) };
    }
    return this.checkedObservation(identity, observation, requireOwnership);
  }

  private checkedObservation(identity: ProcessIdentity, observation: ProcessObservation, requireOwnership = false): ProcessObservation {
    if (observation.state === 'alive' && !this.sameProcess(identity, observation.identity)) {
      if (requireOwnership) throw new Error('Session is not confirmed alive: process ownership changed');
      observation = { state: 'exited', observedAt: observation.observedAt, exitCode: null, evidence: 'Process identity no longer belongs to this run' };
    }
    return observation;
  }

  private async reconcile(session: SessionRecord, observed?: ProcessObservation): Promise<SessionRecord> {
    const process = session.process;
    if (!session.result && session.launchContext?.reportPath && (session.state === 'running' || session.state === 'exited')) {
      session = await this.dependencies.coordinator.acceptPendingReport(session);
    }
    if (session.state === 'running' && session.process) {
      const observation = observed && process && this.sameProcess(process, session.process)
        ? this.checkedObservation(session.process, observed)
        : await this.inspect(session.process);
      session = await this.dependencies.coordinator.observe(session, observation);
    }
    if (session.state === 'exited') {
      session = await this.dependencies.coordinator.finalize(session, this.events(session, 'ended'));
    }
    return session;
  }

  private async live(id: string): Promise<SessionRecord> {
    const candidates = this.sessions().filter(session => session.addressId === id && session.state !== 'finished');
    if (candidates.length !== 1) throw new Error(`Unknown or ambiguous session: ${id}`);
    const session = await this.reconcile(candidates[0]);
    if (session.state !== 'running' || !session.process || session.observation?.state !== 'alive') {
      throw new Error(`Session is not confirmed alive: ${id}`);
    }
    return session;
  }

  async ps(): Promise<AgentPsSession[]> {
    const sessions: AgentPsSession[] = [];
    const candidates = this.sessions().filter(session => session.state !== 'finished');
    const observations = new Map<string, ProcessObservation>();
    if (this.dependencies.scanner.inspectMany) {
      const running = candidates.filter(session => session.state === 'running' && session.process);
      if (running.length) {
        let batch: ProcessObservation[];
        try {
          batch = await this.dependencies.scanner.inspectMany(running.map(session => session.process!));
          if (batch.length !== running.length) throw new Error('Incomplete process scan');
        } catch (error) {
          const observedAt = new Date().toISOString();
          batch = running.map(() => ({ state: 'unknown', observedAt, error: String(error) }));
        }
        running.forEach((session, index) => observations.set(session.runId, batch[index]));
      }
    }
    for (const candidate of candidates) {
      try {
        const session = await this.reconcile(candidate, observations.get(candidate.runId));
        if (session.state === 'running') sessions.push(session);
      } catch (error) {
        const failure = failureContext(error);
        if (failure?.code !== 'WORKER_RESULT_PENDING') throw error;
        const current = this.sessions().find(row => row.runId === candidate.runId) ?? candidate;
        sessions.push({ ...current, ...(current.process ? { observation: await this.inspect(current.process) } : {}), reconciliation: { code: 'WORKER_RESULT_PENDING', reason: failure.reason ?? failure.message } });
      }
    }
    return sessions;
  }

  async message(input: MessageRequest, caller: unknown): Promise<DeliveryReceipt> {
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('Message text is required');
    const sender = await this.dependencies.authority.resolve(caller);
    let address = 'raf';
    if (sender.kind === 'agent') {
      const registered = this.sessions().find(session => session.runId === sender.runId);
      if (!registered || registered.addressId === 'raf') throw new Error('Unverified sender');
      const session = await this.live(registered.addressId);
      if (session.runId !== sender.runId) throw new Error('Sender run is no longer active');
      address = session.addressId;
    } else if (sender.kind !== 'system') {
      throw new Error('Unverified sender');
    }
    const target = await this.live(input.to);
    if (input.runId !== undefined && target.runId !== input.runId) throw new Error(`Recipient run is no longer active: ${input.to}`);
    const text = stripVTControlCharacters(input.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
    if (!text.trim()) throw new Error('Message text is required');
    const receipt = await this.dependencies.transport.deliver(target.process!, `[${address}] ${text}`);
    if (!receipt.accepted) throw new Error(`Message delivery failed: ${receipt.reason}`);
    return receipt;
  }

  private async confirmMessageRecipient(target: SessionRecord): Promise<void> {
    throw new Error('NotImplemented');
  }

  async update(id: string, update: ActivityUpdate): Promise<SessionRecord> {
    if (!this.dependencies.projects.includes(update.project)) throw new Error('Unknown project');
    if (!Array.isArray(update.features) || !update.features.length || update.features.some(feature => typeof feature !== 'string' || !feature.trim())) {
      throw new Error('Nonempty features are required');
    }
    if (!(this.dependencies.agentPhases ?? this.dependencies.agentTypes).includes(update.phase)) throw new Error('Unknown phase');
    const session = await this.live(id);
    if (!session.activity) throw new Error('Session activity is missing');
    const activity = { project: update.project, features: [...update.features], phase: update.phase };
    const changed = { ...session, activity: { ...session.activity, ...activity } };
    const events = session.activity.project !== update.project
      ? [...this.events(session, 'ended'), ...this.events(changed, 'started')]
      : this.events(changed, 'updated');
    return this.dependencies.coordinator.updateActivity(session, activity, events);
  }

  async close(id: string, options: CloseOptions = {}): Promise<CloseResult> {
    if ((options.force !== undefined && typeof options.force !== 'boolean') || (options.force === true ? typeof options.reason !== 'string' || !options.reason.trim() : options.reason !== undefined)) throw new Error('Force requires a nonempty reason; reason requires force');
    options = options.force ? { force: true, reason: options.reason!.trim() } : {};
    if (id === 'main') throw new Error('Main cannot be closed');
    const candidates = this.sessions().filter(row => row.addressId === id && row.state !== 'finished');
    if (candidates.length !== 1) throw new Error(`Unknown or ambiguous session: ${id}`);
    const session = candidates[0];
    const pending = this.closing.get(session.runId);
    if (pending) return pending;
    const closing = this.closeSelected(session, options);
    this.closing.set(session.runId, closing);
    try { return await closing; }
    finally { if (this.closing.get(session.runId) === closing) this.closing.delete(session.runId); }
  }

  private async closeSelected(session: SessionRecord, options: CloseOptions): Promise<CloseResult> {
    const id = session.addressId;
    const closeExited = async (observation?: ProcessObservation): Promise<CloseResult> => {
      const final = await this.reconcile(session, observation);
      return { closed: final.state === 'finished', unfinished: [], ...(final.result ? { result: final.result.status, ...(final.result.forcedClose ? { forcedClose: final.result.forcedClose } : {}) } : {}) };
    };
    if (session.state === 'exited') return closeExited();
    if (session.state !== 'running' || !session.process) {
      throw new Error(`Session is not confirmed alive: ${id}`);
    }
    const observation = await this.inspect(session.process, true);
    if (observation.state !== 'alive') {
      if (observation.state === 'exited') return closeExited(observation);
      throw new Error(`Session is not confirmed alive: ${id}`);
    }
    const selected = session;
    if (!options.force) session = await this.dependencies.coordinator.acceptPendingReport(session);
    if (session.runId !== selected.runId || session.state !== 'running' || !session.process || !this.sameProcess(selected.process!, session.process)) throw new Error('Selected run changed during report acceptance');
    if (!options.force) session = await this.dependencies.coordinator.prepareClose(session, {});
    const check = this.dependencies.reminders.sessionEnded({ address: session.addressId, confirmedSucceeded: session.result?.status === 'succeeded', crashed: false });
    if (!check.allowed) {
      const receipt = await this.dependencies.transport.deliver(session.process!, `[raf] Unfinished reminders:\n${check.unfinished.map(reminder => `${reminder.id}: ${reminder.text}`).join('\n')}`);
      if (!receipt.accepted) throw new Error(`Reminder delivery failed: ${receipt.reason}`);
      return { closed: false, unfinished: check.unfinished };
    }
    session = await this.dependencies.coordinator.prepareClose(session, options);
    const current = this.sessions().find(row => row.runId === session.runId);
    if (!current || current.state !== 'running' || !current.process || !this.sameProcess(session.process!, current.process) || current.revision !== session.revision) throw new Error('Session changed before close transport');
    await this.dependencies.transport.close(session.process!);
    const exited = await this.dependencies.coordinator.observe(session, { state: 'exited', observedAt: new Date().toISOString(), exitCode: null, evidence: 'Transport confirmed orderly session closure' });
    const final = exited.state === 'finished' ? exited : await this.dependencies.coordinator.finalize(exited, this.events(exited, 'ended'));
    return { closed: final.state === 'finished', unfinished: [], ...(final.result ? { result: final.result.status, ...(final.result.forcedClose ? { forcedClose: final.result.forcedClose } : {}) } : {}) };
  }

  async interrupt(id: string): Promise<void> {
    if (id === 'main') throw new Error('Main cannot be interrupted');
    const session = await this.live(id);
    await this.dependencies.transport.interrupt(session.process!);
  }

  async attachMain(identity: ProcessIdentity, register: () => SessionRecord): Promise<SessionRecord> {
    for (const candidate of this.sessions()) {
      if (candidate.addressId !== 'main' || candidate.state === 'finished') continue;
      const observation = candidate.state === 'running' && candidate.process ? await this.inspect(candidate.process) : undefined;
      if (observation?.state === 'alive' && this.sameProcess(candidate.process!, identity) && this.sameProcess(identity, candidate.process!)) return candidate;
      if (observation?.state === 'alive' || observation?.state === 'unknown') throw new MainAttachedElsewhereError(candidate);
      const session = await this.reconcile(candidate, observation);
      if (session.state !== 'finished') throw new MainAttachedElsewhereError(session);
    }
    return register();
  }

  async started(runId: string): Promise<void> {
    const registered = this.sessions().find(session => session.runId === runId);
    if (!registered) throw new Error('Unknown run');
    const session = await this.live(registered.addressId);
    if (session.runId !== runId) throw new Error('Run is no longer active');
    await this.dependencies.coordinator.publish(this.events(session, 'started'));
  }
}
