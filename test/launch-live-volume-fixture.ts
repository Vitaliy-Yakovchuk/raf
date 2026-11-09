import { cp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ProductionFixture } from './production-fixture.ts';
import { verifyLiveStateBudget } from './launch-live-state-fixture.ts';

export async function verifyLiveVolumeBudget(t: TestContext, activeAgents = 5): Promise<void> {
  await verifyLiveStateBudget(t, f => seedLivePlanningVolume(f, activeAgents), activeAgents);
}

async function seedLivePlanningVolume(f: ProductionFixture, activeAgents: number) {
  seedAdditionalState(f);
  const source = new URL('../../openspec/changes/', import.meta.url);
  const changes = (await readdir(source, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name !== 'archive');
  let tasksBytes = 0;
  for (const change of changes) {
    const sourcePath = new URL(change.name + '/', source);
    const target = join(f.root, 'openspec', 'changes', change.name);
    await cp(sourcePath, target, { recursive: true });
    try { tasksBytes += (await stat(join(target, 'tasks.md'))).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const selected = join(f.changeRoot, 'tasks.md');
  const tasks = await readFile(new URL('limit-db-rows-read-per-query/tasks.md', source), 'utf8');
  let index = 0;
  const numbered = tasks.replace(/^(\s*-\s+\[[ xX]\]\s+)\S+/gm, (match, prefix) => prefix + '9.' + ++index);
  await writeFile(selected, (await readFile(selected, 'utf8')) + '\n' + numbered);
  const telemetry = join(f.home, '.config', 'openspec');
  await mkdir(telemetry, { recursive: true });
  await writeFile(join(telemetry, 'config.json'), JSON.stringify({ telemetry: { noticeSeen: true, anonymousId: '00000000-0000-4000-8000-000000000011' }, completionTipSeen: true }));
  return { activeChanges: changes.length + 1, tasksBytes, selectedTasksBytes: (await stat(selected)).size, telemetryNoticeSeen: true, state: { historicalSessions: 406, activeSessions: activeAgents, notices: 486, reminders: 416, intents: 335 } };
}

function seedAdditionalState(f: ProductionFixture): void {
  const db = f.store.startupContextDatabase;
  const reminder = db.prepare('INSERT INTO reminders(id,created_for,assigned_to,at,state,closed_at,payload) VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 189; i++) {
    const row = { id: `volume-reminder-${i}`, createdFor: 'main', assignedTo: 'main', text: 'x'.repeat(700), at: '2099-01-01T00:00:00.000Z', binding: null, state: 'pending', closedAt: null, closeReason: null };
    reminder.run(row.id, row.createdFor, row.assignedTo, row.at, row.state, null, JSON.stringify(row));
  }
  reminder.close();
  const intent = db.prepare('INSERT INTO pending_intents(id,run_id,payload) VALUES(?,?,?)');
  for (let i = 0; i < 35; i++) {
    const row = { id: `volume-intent-${i}`, runId: null, event: 'fixture.unknown', payload: { history: 'x'.repeat(19000) } };
    intent.run(row.id, null, JSON.stringify(row));
  }
  intent.close();
}
