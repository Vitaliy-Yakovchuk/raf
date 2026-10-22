import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Handler } from './cli.ts';
import type { StateStore, DeliveryClaimOwner } from './state-store.ts';
import { reminderDeliveryKey } from './state-store.ts';
import type { EventCatalog } from './event-registry.ts';
import type { DeliveryReceipt, MessageRequest, VerifiedSender } from './agent-control.ts';
import { ReminderError, ReminderService, type Reminder, type ReminderBinding, type UpdateReminder } from './reminders.ts';
import { validateEventId } from './event-catalog.ts';
import { commandFailure } from './cli-contract.ts';

export type ReminderCommand =
  | 'reminder add'
  | 'reminder list'
  | 'reminder update'
  | 'reminder activate'
  | 'reminder close'
  | 'reminder reassign'
  | 'reminder close-all';

export interface CommandStatePorts {
  store: StateStore;
  now: () => number;
  nextReminderId: () => string;
  catalog: EventCatalog;
  deliver: (request: MessageRequest, sender: VerifiedSender) => Promise<DeliveryReceipt>;
}

export interface CommandSettleReport {
  activated: string[];
  delivered: string[];
  undelivered: { id: string; reason: string }[];
  notices: string[];
  pruned: string[];
}

const remediation: Record<string, string> = {
  MISSING_REQUIRED: 'Передайте всі обов’язкові параметри команди.',
  INVALID_VALUE: 'Передайте значення з дозволеного переліку conf/raf-constants.json.',
  REMINDER_INVALID_TIME: 'Передайте час ISO 8601 з явним зсувом або Z, наприклад 2026-10-22T18:00:00+03:00.',
  REMINDER_BINDING_INCOMPLETE: 'Задайте --event, --event-id та --event-action разом або не задавайте жодного.',
  REMINDER_UPDATE_EMPTY: 'Передайте хоча б одне з --at, --text або повну трійку прив’язки події.',
  EVENT_ID_INVALID: 'Передайте ID об’єкта, сумісний з idKind обраної події.',
  SESSION_NOT_ACTIVE: 'Оберіть адресата з активних сесій raf agent ps, включно з main.',
  REMINDER_NOT_FOUND: 'Перевірте ID за raf reminder list.',
  REMINDER_CLOSED: 'Закрите нагадування не змінюється; створіть нове через raf reminder add.',
  REMINDER_DUPLICATE: 'Повторіть команду: ID нагадування згенеровано повторно.',
};

function reminderFailure(code: string, message: string, received: unknown = null): Error {
  return Object.assign(commandFailure({ code, message, stage: 'reminder', source: 'reminder-cli', sourceCode: code, reason: message,
    received, expected: null, found: null, completed: [], pending: [], retrySafe: true,
    remediation: [remediation[code] ?? 'Виправте причину та повторіть команду.'] }), { code });
}

function translated<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof ReminderError) throw reminderFailure(error.code, error.message);
    throw error;
  }
}

function isoClock(ports: Pick<CommandStatePorts, 'now'>): () => string {
  return () => {
    const value = ports.now();
    if (!Number.isFinite(value)) throw new Error('Command clock is unavailable');
    return new Date(value).toISOString();
  };
}

function reminderService(ports: CommandStatePorts): ReminderService {
  return new ReminderService({ repository: ports.store.reminderRepository, now: isoClock(ports), nextId: ports.nextReminderId,
    approvedEventKinds: ports.catalog.events.map(event => event.id) });
}

function parameter(params: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (params[name] !== undefined && params[name] !== null) return params[name];
  return undefined;
}

function requiredText(params: Record<string, unknown>, option: string, ...names: string[]): string {
  const value = parameter(params, ...names);
  if (value === undefined) throw reminderFailure('MISSING_REQUIRED', `${option} is required`);
  if (typeof value !== 'string') throw reminderFailure('INVALID_VALUE', `${option} must be a string`, value);
  return value;
}

function optionalText(params: Record<string, unknown>, option: string, ...names: string[]): string | undefined {
  const value = parameter(params, ...names);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw reminderFailure('INVALID_VALUE', `${option} must be a string`, value);
  return value;
}

function bindingFrom(params: Record<string, unknown>, catalog: EventCatalog): ReminderBinding | undefined {
  const kind = optionalText(params, '--event', 'event');
  const id = optionalText(params, '--event-id', 'event-id', 'eventId');
  const action = optionalText(params, '--event-action', 'event-action', 'eventAction');
  const given = [kind, id, action].filter(value => value !== undefined).length;
  if (given === 0) return undefined;
  if (given !== 3) throw reminderFailure('REMINDER_BINDING_INCOMPLETE', 'Event binding requires --event, --event-id and --event-action together', { event: kind ?? null, eventId: id ?? null, eventAction: action ?? null });
  if (!catalog.events.some(event => event.id === kind)) throw reminderFailure('INVALID_VALUE', `Unknown event kind: ${kind}`, kind);
  if (action !== 'activate' && action !== 'close') throw reminderFailure('INVALID_VALUE', `Invalid binding action: ${action}`, action);
  if (!validateEventId(catalog, kind!, id!)) throw reminderFailure('EVENT_ID_INVALID', `Invalid ${catalog.events.find(event => event.id === kind)!.idKind} event ID: ${id}`, id);
  return { kind: kind!, id: id!, action };
}

export function createReminderHandlers(ports: CommandStatePorts): Record<ReminderCommand, Handler> {
  const service = () => reminderService(ports);
  return {
    'reminder add': async params => {
      const to = requiredText(params, '--to', 'to');
      const at = requiredText(params, '--at', 'at');
      const text = requiredText(params, '--text', 'text');
      const binding = bindingFrom(params, ports.catalog);
      return translated(() => service().add({ to, at, text, ...(binding ? { binding } : {}) }));
    },
    'reminder list': async params => {
      const to = optionalText(params, '--to', 'to');
      const reminders = service();
      return translated(() => { reminders.activateDue(); return reminders.list(to); });
    },
    'reminder update': async params => {
      const id = requiredText(params, '--id', 'id');
      const at = optionalText(params, '--at', 'at');
      const text = optionalText(params, '--text', 'text');
      const binding = bindingFrom(params, ports.catalog);
      const patch: UpdateReminder = { ...(at !== undefined ? { at } : {}), ...(text !== undefined ? { text } : {}), ...(binding ? { binding } : {}) };
      if (!Object.keys(patch).length) throw reminderFailure('REMINDER_UPDATE_EMPTY', 'Update requires --at, --text or a complete event binding');
      return translated(() => service().update(id, patch));
    },
    'reminder activate': async params => {
      const id = requiredText(params, '--id', 'id');
      return translated(() => service().activate(id));
    },
    'reminder close': async params => {
      const id = requiredText(params, '--id', 'id');
      const reason = requiredText(params, '--reason', 'reason');
      if (!reason.trim()) throw reminderFailure('INVALID_VALUE', '--reason must not be blank');
      return translated(() => service().close(id, reason));
    },
    'reminder reassign': async params => {
      const id = requiredText(params, '--id', 'id');
      const to = requiredText(params, '--to', 'to');
      return translated(() => service().reassign(id, to));
    },
    'reminder close-all': async params => {
      const createdFor = requiredText(params, '--created-for', 'created-for', 'createdFor');
      const reason = requiredText(params, '--reason', 'reason');
      if (!createdFor.trim()) throw reminderFailure('INVALID_VALUE', '--created-for must not be blank');
      if (!reason.trim()) throw reminderFailure('INVALID_VALUE', '--reason must not be blank');
      return translated(() => service().closeAll(createdFor, reason));
    },
  };
}

function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}

function ownerAlive(owner: DeliveryClaimOwner): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  if (owner.processStart === null) return true;
  const current = processStart(owner.pid);
  return current === null || current === owner.processStart;
}

export function reminderDeliveryText(reminder: Pick<Reminder, 'id' | 'text' | 'createdFor' | 'assignedTo'>): string {
  return reminder.createdFor === reminder.assignedTo
    ? `Reminder ${reminder.id}: ${reminder.text}`
    : `Reminder ${reminder.id} (created for ${reminder.createdFor}, assigned to ${reminder.assignedTo}): ${reminder.text}`;
}

async function send(ports: CommandStatePorts, request: MessageRequest): Promise<DeliveryReceipt> {
  try {
    const receipt = await ports.deliver(request, { kind: 'system' });
    if (receipt && receipt.accepted === true && typeof receipt.receiptId === 'string' && receipt.receiptId) return receipt;
    return { accepted: false, reason: receipt && receipt.accepted === false && typeof receipt.reason === 'string' ? receipt.reason : 'Delivery receipt was not accepted' };
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function applyPendingFacts(ports: CommandStatePorts, at: string): void {
  const kinds = new Set(ports.catalog.events.map(event => event.id));
  const applicable = (fact: { event: { kind: string; id: string } }) => kinds.has(fact.event.kind) && validateEventId(ports.catalog, fact.event.kind, fact.event.id);
  for (let pass = 0; pass < 32; pass++) {
    const keys = ports.store.eventRepository.transaction(tx => tx.listPending().filter(applicable).map(fact => fact.key));
    let applied = 0;
    for (const key of keys) {
      const done = ports.store.eventRepository.transaction(tx => {
        const fact = tx.listPending().find(item => item.key === key);
        if (!fact || !applicable(fact)) return false;
        tx.applyReminderEvent(fact.event, at);
        tx.deletePending(fact.key);
        return true;
      });
      if (done) applied++;
    }
    if (!applied) return;
  }
}

export async function settleCommandState(ports: CommandStatePorts): Promise<CommandSettleReport> {
  const report: CommandSettleReport = { activated: [], delivered: [], undelivered: [], notices: [], pruned: [] };
  const clock = isoClock(ports);
  const reminders = reminderService(ports);
  report.activated.push(...reminders.activateDue().map(reminder => reminder.id));
  ports.store.closureNotices.stage();
  applyPendingFacts(ports, clock());
  report.pruned.push(...reminders.pruneClosed());
  const owner: DeliveryClaimOwner = { token: randomUUID(), pid: process.pid, processStart: processStart(process.pid) };
  const active = (address: string) => ports.store.reminderRepository.transaction(tx => tx.session(address)?.active === true);
  for (const reminder of reminders.list().filter(item => item.state === 'active')) {
    const key = reminderDeliveryKey(reminder);
    if (ports.store.reminderDeliveries.get(reminder.id)?.key === key) continue;
    if (!active(reminder.assignedTo)) {
      report.undelivered.push({ id: reminder.id, reason: `Recipient session is not active: ${reminder.assignedTo}` });
      continue;
    }
    const claimed = ports.store.reminderDeliveries.claim(reminder.id, owner, clock(), ownerAlive);
    if (!claimed) continue;
    const receipt = await send(ports, { to: claimed.reminder.assignedTo, text: reminderDeliveryText(claimed.reminder) });
    if (receipt.accepted) {
      ports.store.reminderDeliveries.confirm({ reminderId: reminder.id, key: claimed.key, receiptId: receipt.receiptId, deliveredAt: clock() }, owner.token);
      report.delivered.push(reminder.id);
    } else {
      ports.store.reminderDeliveries.release(reminder.id, owner.token);
      report.undelivered.push({ id: reminder.id, reason: receipt.reason });
    }
  }
  for (const notice of ports.store.closureNotices.listUndelivered()) {
    if (!active(notice.recipient)) { ports.store.closureNotices.discard(notice.id); continue; }
    const claimed = ports.store.closureNotices.claim(notice.id, owner, clock(), ownerAlive);
    if (!claimed) continue;
    const receipt = await send(ports, { to: claimed.recipient, text: claimed.text });
    if (receipt.accepted) {
      ports.store.closureNotices.markDelivered(notice.id, receipt.receiptId, clock(), owner.token);
      report.notices.push(notice.id);
    } else ports.store.closureNotices.release(notice.id, owner.token);
  }
  return report;
}
