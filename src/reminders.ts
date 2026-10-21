export interface ReminderEvent {
  kind: string;
  id: string;
}

export interface ReminderBinding extends ReminderEvent {
  action: 'activate' | 'close';
}

export interface Reminder {
  id: string;
  createdFor: string;
  assignedTo: string;
  text: string;
  at: string;
  binding: ReminderBinding | null;
  state: 'pending' | 'active' | 'closed';
  closedAt: string | null;
  closeReason: string | null;
}

export interface ReminderTransaction {
  get(id: string): Reminder | undefined;
  list(): Reminder[];
  save(reminder: Reminder): void;
  remove(id: string): void;
  session(address: string): { active: boolean } | undefined;
  emit(event: ReminderEvent): void;
}

export interface ReminderRepository {
  transaction<T>(operation: (transaction: ReminderTransaction) => T): T;
}

export interface ReminderOptions {
  repository: ReminderRepository;
  now: () => string;
  nextId: () => string;
  approvedEventKinds: readonly string[];
}

export interface AddReminder {
  to: string;
  at: string;
  text: string;
  binding?: ReminderBinding;
}

export interface UpdateReminder {
  at?: string;
  text?: string;
  binding?: ReminderBinding | null;
}

export interface SessionCloseCheck {
  allowed: boolean;
  unfinished: Reminder[];
}

export interface SessionEnd {
  address: string;
  confirmedSucceeded: boolean;
  crashed: boolean;
}

export class ReminderService {
  private options: ReminderOptions;
  private approvedKinds: Set<string>;

  constructor(options: ReminderOptions) {
    this.options = options;
    this.approvedKinds = new Set(options.approvedEventKinds);
  }

  private required(value: string, name: string): void {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  }

  private time(value: string): number {
    this.required(value, 'at');
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error('Invalid reminder time');
    return time;
  }

  private event(event: ReminderEvent): void {
    if (!this.approvedKinds.has(event.kind)) throw new Error('Unknown event kind');
    this.required(event.id, 'event id');
  }

  private binding(binding: ReminderBinding): void {
    this.event(binding);
    if (binding.action !== 'activate' && binding.action !== 'close') throw new Error('Invalid binding action');
  }

  private get(tx: ReminderTransaction, id: string): Reminder {
    const reminder = tx.get(id);
    if (!reminder) throw new Error(`Unknown reminder: ${id}`);
    return reminder;
  }

  private activeSession(tx: ReminderTransaction, to: string): void {
    this.required(to, 'session address');
    if (!tx.session(to)?.active) throw new Error(`Session is not active: ${to}`);
  }

  private transition(tx: ReminderTransaction, reminder: Reminder, state: 'active' | 'closed', at: string, reason?: string): Reminder {
    if (reminder.state === 'closed' || reminder.state === state) return reminder;
    const changed: Reminder = { ...reminder, state,
      closedAt: state === 'closed' ? at : null,
      closeReason: state === 'closed' ? reason! : null };
    const event = { kind: state === 'closed' ? 'reminder.closed' : 'reminder.activated', id: reminder.id };
    this.event(event);
    tx.save(changed);
    tx.emit(event);
    return changed;
  }

  add(input: AddReminder): Reminder {
    this.time(input.at);
    this.required(input.text, 'text');
    if (input.binding) this.binding(input.binding);
    return this.options.repository.transaction(tx => {
      this.activeSession(tx, input.to);
      const reminder: Reminder = { id: this.options.nextId(), createdFor: input.to, assignedTo: input.to,
        text: input.text, at: input.at, binding: input.binding ? { ...input.binding } : null,
        state: 'pending', closedAt: null, closeReason: null };
      this.required(reminder.id, 'reminder id');
      if (tx.get(reminder.id)) throw new Error('Duplicate reminder id');
      tx.save(reminder);
      const now = this.options.now();
      return this.time(input.at) <= this.time(now) ? this.transition(tx, reminder, 'active', now) : reminder;
    });
  }

  list(to?: string): Reminder[] {
    return this.options.repository.transaction(tx => tx.list().filter(reminder => to === undefined || reminder.assignedTo === to));
  }

  update(id: string, input: UpdateReminder): Reminder {
    if (input.at !== undefined) this.time(input.at);
    if (input.text !== undefined) this.required(input.text, 'text');
    if (input.binding != null) this.binding(input.binding);
    return this.options.repository.transaction(tx => {
      const reminder = this.get(tx, id);
      if (reminder.state === 'closed') throw new Error('Reminder is closed');
      const changed = { ...reminder,
        at: input.at === undefined ? reminder.at : input.at,
        text: input.text === undefined ? reminder.text : input.text,
        binding: input.binding === undefined ? reminder.binding : input.binding === null ? null : { ...input.binding } };
      tx.save(changed);
      const now = this.options.now();
      return this.time(changed.at) <= this.time(now) ? this.transition(tx, changed, 'active', now) : changed;
    });
  }

  activate(id: string): Reminder {
    return this.options.repository.transaction(tx => this.transition(tx, this.get(tx, id), 'active', this.options.now()));
  }

  activateDue(): Reminder[] {
    return this.options.repository.transaction(tx => {
      const now = this.options.now();
      return tx.list().filter(reminder => reminder.state === 'pending' && this.time(reminder.at) <= this.time(now))
        .map(reminder => this.transition(tx, reminder, 'active', now));
    });
  }

  applyEvent(event: ReminderEvent): Reminder[] {
    this.event(event);
    return this.options.repository.transaction(tx => {
      const now = this.options.now();
      return tx.list().filter(reminder => reminder.state !== 'closed' && reminder.binding?.kind === event.kind && reminder.binding.id === event.id
        && (reminder.binding.action === 'close' || reminder.state === 'pending'))
        .map(reminder => this.transition(tx, reminder, reminder.binding!.action === 'close' ? 'closed' : 'active', now, `event ${event.kind}: ${event.id}`));
    });
  }

  close(id: string, reason: string): Reminder {
    this.required(reason, 'reason');
    return this.options.repository.transaction(tx => this.transition(tx, this.get(tx, id), 'closed', this.options.now(), reason));
  }

  reassign(id: string, to: string): Reminder {
    return this.options.repository.transaction(tx => {
      this.activeSession(tx, to);
      const reminder = this.get(tx, id);
      if (reminder.state === 'closed') throw new Error('Reminder is closed');
      const changed = { ...reminder, assignedTo: to };
      tx.save(changed);
      return changed;
    });
  }

  closeAll(createdFor: string, reason: string): Reminder[] {
    this.required(createdFor, 'createdFor');
    this.required(reason, 'reason');
    return this.options.repository.transaction(tx => {
      const now = this.options.now();
      return tx.list().filter(reminder => reminder.createdFor === createdFor && reminder.state !== 'closed')
        .map(reminder => this.transition(tx, reminder, 'closed', now, reason));
    });
  }

  checkSessionClose(address: string): SessionCloseCheck {
    return this.options.repository.transaction(tx => {
      const unfinished = tx.list().filter(reminder => reminder.assignedTo === address && reminder.state !== 'closed');
      return { allowed: unfinished.length === 0, unfinished };
    });
  }

  sessionEnded(input: SessionEnd): SessionCloseCheck {
    return this.options.repository.transaction(tx => {
      if (input.confirmedSucceeded) {
        const now = this.options.now();
        for (const reminder of tx.list()) {
          if (reminder.createdFor === input.address && reminder.state !== 'closed')
            this.transition(tx, reminder, 'closed', now, 'сесія закінчилась з success');
        }
        return { allowed: true, unfinished: [] };
      }
      const unfinished = tx.list().filter(reminder => reminder.assignedTo === input.address && reminder.state !== 'closed');
      if (input.crashed) {
        for (const reminder of unfinished) {
          if (reminder.assignedTo !== 'main') tx.save({ ...reminder, assignedTo: 'main' });
        }
        return { allowed: true, unfinished: [] };
      }
      return { allowed: unfinished.length === 0, unfinished };
    });
  }

  pruneClosed(): string[] {
    const retention = loadFlowPolicy().retention.closedRemindersMs;
    return this.options.repository.transaction(tx => {
      const cutoff = this.time(this.options.now()) - retention;
      const expired = tx.list().filter(reminder => reminder.state === 'closed' && reminder.closedAt !== null && this.time(reminder.closedAt) <= cutoff);
      for (const reminder of expired) tx.remove(reminder.id);
      return expired.map(reminder => reminder.id);
    });
  }
}
import { loadFlowPolicy } from './flow-policy.ts';
