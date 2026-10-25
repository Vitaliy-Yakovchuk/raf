import type { ReminderEvent } from './reminders.ts';

export interface EventCatalog {
  readonly events: readonly { readonly id: string; readonly idKind: string; readonly description: string }[];
  readonly eventIdKinds: Readonly<Record<string, string>>;
}

export interface PendingEvent {
  readonly key: string;
  readonly event: ReminderEvent;
  readonly data?: unknown;
}

export interface EventTransaction {
  listPending(): readonly PendingEvent[];
  savePending(fact: PendingEvent): void;
  deletePending(key: string): void;
  applyReminderEvent(event: ReminderEvent, at?: string): 'delivered' | 'unresolved';
}

export interface EventRegistryPorts {
  validateId(kind: string, id: string): boolean;
  transaction<T>(operation: (transaction: EventTransaction) => T): T;
}

export interface EventRegistry {
  validate(event: ReminderEvent): void;
  enqueue(fact: PendingEvent): void;
  dispatch(): { readonly delivered: readonly string[]; readonly unresolved: readonly string[] };
}

export interface ArchiveSnapshot {
  readonly active: readonly string[];
  readonly archives: readonly { readonly name: string; readonly successful: boolean }[];
}

export interface ArchiveObserverPorts {
  emit(event: ReminderEvent): Promise<void>;
}

export interface ArchiveObserver {
  observe(snapshot: ArchiveSnapshot): Promise<readonly ReminderEvent[]>;
}

export function createEventRegistry(catalog: EventCatalog, ports: EventRegistryPorts): EventRegistry {
  const kinds = new Map(catalog.events.map(event => [event.id, event.idKind]));
  const validate = (event: ReminderEvent): void => {
    const idKind = kinds.get(event.kind);
    if (!idKind || !Object.hasOwn(catalog.eventIdKinds, idKind)) throw new Error(`Unknown event kind: ${event.kind}`);
    if (typeof event.id !== 'string' || !event.id.trim() || !ports.validateId(idKind, event.id)) {
      throw new Error(`Invalid ${idKind} event ID: ${event.id}`);
    }
  };
  return {
    validate,
    enqueue(fact) {
      validate(fact.event);
      if (typeof fact.key !== 'string' || !fact.key.trim()) throw new Error('Event key is required');
      ports.transaction(tx => {
        const existing = tx.listPending().find(item => item.key === fact.key);
        if (existing) {
          if (existing.event.kind !== fact.event.kind || existing.event.id !== fact.event.id) {
            throw new Error(`Conflicting pending event key: ${fact.key}`);
          }
          return;
        }
        tx.savePending({ ...fact, event: { ...fact.event } });
      });
    },
    dispatch() {
      return ports.transaction(tx => {
        const delivered: string[] = [];
        const unresolved: string[] = [];
        for (const fact of [...tx.listPending()]) {
          validate(fact.event);
          if (tx.applyReminderEvent(fact.event) === 'delivered') {
            tx.deletePending(fact.key);
            delivered.push(fact.key);
          } else {
            unresolved.push(fact.key);
          }
        }
        return { delivered, unresolved };
      });
    },
  };
}

export function createArchiveObserver(initial: ArchiveSnapshot, ports: ArchiveObserverPorts): ArchiveObserver {
  const successfulNames = (snapshot: ArchiveSnapshot): Set<string> => new Set(
    snapshot.archives.filter(archive => archive.successful).map(archive => archive.name),
  );
  const changeId = (name: string): string => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name.replace(/^\d{4}-\d{2}-\d{2}-/, '') : '';
  const cycles = new Map(initial.active.map(id => [id, new Set(initial.archives.map(archive => archive.name))]));
  let previousActive = new Set(initial.active);
  let tail: Promise<unknown> = Promise.resolve();
  return {
    observe(snapshot) {
      const captured = structuredClone(snapshot);
      const operation = tail.then(async () => {
        const active = new Set(captured.active);
        const successful = successfulNames(captured);
        for (const id of active) {
          if (!previousActive.has(id)) cycles.set(id, new Set(captured.archives.map(archive => archive.name)));
        }
        previousActive = active;
        const emitted: ReminderEvent[] = [];
        for (const [id, baseline] of cycles) {
          if (active.has(id)) continue;
          if (![...successful].some(name => !baseline.has(name) && changeId(name) === id)) continue;
          const event = { kind: 'openspec.archived', id };
          await ports.emit(event);
          cycles.delete(id);
          emitted.push(event);
        }
        return emitted;
      });
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
}
