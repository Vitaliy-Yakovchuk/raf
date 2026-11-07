import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { iterateDatabaseTable } from './database-read-limit.ts';
import { pruneArchivedChangeTestGroups } from './prune-archived-test-groups.ts';
import { createArchiveObserver, createEventRegistry } from './event-registry.ts';
import { validateEventObjectId } from './event-catalog.ts';
import type { ArchiveSnapshot, EventCatalog } from './event-registry.ts';
import type { StateStore } from './state-store.ts';
import type { Reminder, ReminderEvent } from './reminders.ts';
import type { PendingIntent } from './session-state.ts';

type Observation = { revision: string; active: string[]; cycles: { id: string; baseline: string[] }[] };
const observationKey = 'openspec:archive-observation';

export type ArchiveEventEffects = { closeBugs?(changeId: string): Promise<void> };

async function changeDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readArchiveSnapshot(root: string, ids: ReadonlySet<string>, active: string[]): Promise<ArchiveSnapshot> {
  const directory = join(root, 'openspec', 'changes', 'archive');
  const archives = (await changeDirectories(directory)).filter(name => ids.has(name.replace(/^\d{4}-\d{2}-\d{2}-/, '')));
  const verified = await Promise.all(archives.map(async name => {
    let successful = false;
    try {
      const text = await readFile(join(directory, name, 'tasks.md'), 'utf8');
      const tasks = [...text.matchAll(/^\s*-\s+\[([ xX])\]\s+(.+)$/gm)];
      const total = text.split('\n').filter(line => /^\s*(?:[-*+]|\d{1,9}[.)])\s*\[(?:\s*([^\]\s]?)\s*\](?![([])|\s+\])\s*(.*)/.test(line)).length;
      successful = tasks.length > 0 && tasks.length === total && tasks.every(task => task[1].toLowerCase() === 'x');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { name, successful };
  }));
  return { active, archives: verified };
}

export async function settleArchiveEvents(store: StateStore, root: string, catalog: EventCatalog, effects?: ArchiveEventEffects): Promise<void> {
  const database = store.startupContextDatabase;
  const readObservation = (): PendingIntent | undefined => {
    const row = database.prepare('SELECT payload FROM pending_intents WHERE id=?').get(observationKey);
    return row ? JSON.parse(String(row.payload)) : undefined;
  };
  const reminderIds = new Set<string>();
  for (const row of iterateDatabaseTable(database, 'reminders')) {
    if (row.state !== 'pending' && row.state !== 'active') continue;
    const reminder = JSON.parse(String(row.payload)) as Reminder;
    if (reminder.binding?.kind === 'openspec.archived') reminderIds.add(reminder.binding.id);
  }
  const prior = readObservation();
  const state = prior?.payload as Observation | undefined;
  const activeIds = (await changeDirectories(join(root, 'openspec', 'changes'))).filter(name => name !== 'archive');
  if (activeIds.some(id => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))) throw new Error('Invalid OpenSpec archive observation');
  const watched = new Set<string>([...reminderIds, ...activeIds, ...(state?.active ?? []), ...(state?.cycles.map(cycle => cycle.id) ?? [])]);
  if (!watched.size) {
    if (prior) store.sessionRepository.transaction(tx => {
      if (JSON.stringify(readObservation()) === JSON.stringify(prior)) tx.deletePending(observationKey);
    });
    return;
  }
  const snapshot = await readArchiveSnapshot(root, watched, activeIds);
  const active = [...snapshot.active];
  const baselines = new Map(state?.cycles.filter(cycle => watched.has(cycle.id)).map(cycle => [cycle.id, cycle.baseline]) ?? []);
  for (const id of active) if (!state?.active.includes(id)) baselines.set(id, snapshot.archives.map(archive => archive.name));
  const events: ReminderEvent[] = [];
  const stillActive = new Set(active);
  for (const [id, baseline] of baselines) {
    if (stillActive.has(id)) continue;
    const observer = createArchiveObserver({ active: [id], archives: baseline.map(name => ({ name, successful: true })) }, {
      emit: async event => { events.push(event); },
    });
    if ((await observer.observe(snapshot)).length) baselines.delete(id);
  }
  const next: Observation = { revision: randomUUID(), active, cycles: [...baselines].map(([id, baseline]) => ({ id, baseline })) };
  const reminderEvents = events.filter(event => reminderIds.has(event.id));
  if (!events.length && state && JSON.stringify([state.active, state.cycles]) === JSON.stringify([next.active, next.cycles])) return;
  store.sessionRepository.transaction(() => {
    const current = readObservation();
    if (JSON.stringify(current) !== JSON.stringify(prior)) return;
    const registry = createEventRegistry(catalog, { validateId: validateEventObjectId, transaction: operation => store.eventRepository.transaction(operation) });
    for (const event of reminderEvents) registry.enqueue({ key: `openspec:archived:${randomUUID()}`, event });
    database.prepare(`INSERT INTO pending_intents(id, run_id, payload) VALUES (?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(observationKey,
      JSON.stringify({ id: observationKey, runId: null, event: 'openspec.archived', payload: next }));
  });
  for (const event of events) await pruneArchivedChangeTestGroups(root, event.id);
  if (effects?.closeBugs) {
    for (const event of events) await effects.closeBugs(event.id);
  }
}
