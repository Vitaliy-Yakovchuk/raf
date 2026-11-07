import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { settleArchiveEvents } from '../src/archive-events-runtime.ts';
import { openStateStore } from '../src/state-store.ts';

test('archive observation retains bindings beyond the first reminder page across all reminder pages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'raf-archive-pages-'));
  const store = openStateStore(join(root, 'state.sqlite'));
  const catalog = {
    events: [{ id: 'openspec.archived', idKind: 'changeId', description: 'Change archived' }],
    eventIdKinds: { changeId: 'OpenSpec change id' },
  };
  try {
    store.reminderRepository.transaction(tx => {
      for (let i = 0; i < 186; i++) tx.save({
        id: `rem-${i}`, createdFor: 'main', assignedTo: 'main', text: 'retained reminder',
        at: '2099-01-01T00:00:00.000Z',
        binding: i === 185 ? { kind: 'openspec.archived', id: 'watched-change', action: 'close' } : null,
        state: i < 121 ? 'closed' : i % 2 ? 'pending' : 'active',
        closedAt: i < 121 ? '2026-11-01T00:00:00.000Z' : null, closeReason: null,
      });
    });
    const active = join(root, 'openspec', 'changes', 'watched-change');
    mkdirSync(active, { recursive: true });
    await settleArchiveEvents(store, root, catalog);
    rmSync(active, { recursive: true });
    const archive = join(root, 'openspec', 'changes', 'archive', '2026-11-07-watched-change');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'tasks.md'), '- [x] done\n');
    await settleArchiveEvents(store, root, catalog);
    await settleArchiveEvents(store, root, catalog);
    assert.deepEqual(store.eventRepository.transaction(tx => tx.listPending().map(row => row.event)),
      [{ kind: 'openspec.archived', id: 'watched-change' }]);
    assert.equal(store.reminderRepository.transaction(tx => tx.list()).length, 186);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
