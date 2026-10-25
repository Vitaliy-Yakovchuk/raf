import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeCommand } from './os-runtime.ts';
import { createArchiveObserver, createEventRegistry } from './event-registry.ts';
import { validateEventObjectId } from './event-catalog.ts';
import type { ArchiveSnapshot, EventCatalog } from './event-registry.ts';
import type { StateStore } from './state-store.ts';
import type { Reminder, ReminderEvent } from './reminders.ts';
import type { PendingIntent } from './session-state.ts';

type Observation = { revision: string; active: string[]; cycles: { id: string; baseline: string[] }[] };
const observationKey = 'openspec:archive-observation';

async function readArchiveSnapshot(root: string, ids: ReadonlySet<string>): Promise<ArchiveSnapshot> {
  const list = async (archived: boolean): Promise<{ name: string; completedTasks: number; totalTasks: number }[]> => {
    const result = await executeCommand({ executable: 'openspec', args: ['list', ...(archived ? ['--archived'] : []), '--json'], cwd: root });
    if (result.exitCode !== 0) throw new Error(`OpenSpec archive observation failed: ${result.stderr || result.stdout}`);
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data.changes) || data.changes.some((row: any) => !row || typeof row.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(row.name) ||
        !Number.isSafeInteger(row.totalTasks) || !Number.isSafeInteger(row.completedTasks) || row.completedTasks < 0 || row.totalTasks < row.completedTasks) ||
        new Set(data.changes.map((row: any) => row.name)).size !== data.changes.length) throw new Error('Invalid OpenSpec archive observation');
    return data.changes;
  };
  const archives = (await list(true)).filter(row => ids.has(row.name.replace(/^\d{4}-\d{2}-\d{2}-/, '')));
  const verified = await Promise.all(archives.map(async row => {
    let successful = row.totalTasks > 0 && row.completedTasks === row.totalTasks;
    if (successful) {
      try {
        const text = await readFile(join(root, 'openspec', 'changes', 'archive', row.name, 'tasks.md'), 'utf8');
        const tasks = [...text.matchAll(/^\s*-\s+\[([ xX])\]\s+(.+)$/gm)];
        successful = tasks.length === row.totalTasks && tasks.every(task => task[1].toLowerCase() === 'x');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        successful = false;
      }
    }
    return { name: row.name, successful };
  }));
  const active = await list(false);
  return { active: active.map(row => row.name).filter(id => ids.has(id)), archives: verified };
}

export async function settleArchiveEvents(store: StateStore, root: string, catalog: EventCatalog): Promise<void> {
  const database = store.startupContextDatabase;
  const readObservation = (): PendingIntent | undefined => {
    const row = database.prepare('SELECT payload FROM pending_intents WHERE id=?').get(observationKey);
    return row ? JSON.parse(String(row.payload)) : undefined;
  };
  const ids = new Set(database.prepare("SELECT payload FROM reminders WHERE state IN ('pending', 'active')").all().flatMap(row => {
    const reminder = JSON.parse(String(row.payload)) as Reminder;
    return reminder.binding?.kind === 'openspec.archived' ? [reminder.binding.id] : [];
  }));
  const prior = readObservation();
  if (!ids.size) {
    if (prior) store.sessionRepository.transaction(tx => {
      if (JSON.stringify(readObservation()) === JSON.stringify(prior)) tx.deletePending(observationKey);
    });
    return;
  }
  const snapshot = await readArchiveSnapshot(root, ids);
  const state = prior?.payload as Observation | undefined;
  const active = [...snapshot.active];
  const baselines = new Map(state?.cycles.filter(cycle => ids.has(cycle.id)).map(cycle => [cycle.id, cycle.baseline]) ?? []);
  for (const id of active) if (!state?.active.includes(id)) baselines.set(id, snapshot.archives.map(archive => archive.name));
  const events: ReminderEvent[] = [];
  for (const [id, baseline] of baselines) {
    const observer = createArchiveObserver({ active: [id], archives: baseline.map(name => ({ name, successful: true })) }, {
      emit: async event => { events.push(event); },
    });
    if ((await observer.observe(snapshot)).length) baselines.delete(id);
  }
  const next: Observation = { revision: randomUUID(), active, cycles: [...baselines].map(([id, baseline]) => ({ id, baseline })) };
  if (!events.length && state && JSON.stringify([state.active, state.cycles]) === JSON.stringify([next.active, next.cycles])) return;
  store.sessionRepository.transaction(() => {
    const current = readObservation();
    if (JSON.stringify(current) !== JSON.stringify(prior)) return;
    const registry = createEventRegistry(catalog, { validateId: validateEventObjectId, transaction: operation => store.eventRepository.transaction(operation) });
    for (const event of events) registry.enqueue({ key: `openspec:archived:${randomUUID()}`, event });
    database.prepare(`INSERT INTO pending_intents(id, run_id, payload) VALUES (?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(observationKey,
      JSON.stringify({ id: observationKey, runId: null, event: 'openspec.archived', payload: next }));
  });
}
