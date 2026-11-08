import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadEventCatalog } from '../src/event-catalog.ts';
import { closeArchivedBugsAfterWorkerSession, settleCommandState } from '../src/reminder-cli.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';

const commandSettleBudgetMs = 400;
const largeCheckedTaskCount = 2_000_000;
const archiveName = '2026-11-08-sample-change';

function unseenArchiveFixture(checkedTaskCount: number): { root: string; home: string; store: StateStore; memoryPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'raf-settle-bugs-'));
  const home = mkdtempSync(join(tmpdir(), 'raf-settle-home-'));
  const memoryPath = join(home, '.raf', 'archived-bug-close.json');
  mkdirSync(join(root, 'conf'), { recursive: true });
  writeFileSync(join(root, 'conf/raf.json'), JSON.stringify({
    state: { contention: { busyTimeoutMs: 250, timeoutMs: 10000, retryDelayMs: 100 } },
    health: { summaryIntervalMs: 3600000, cpuWindowMs: 600000, cpuThresholdCores: 1 },
  }));
  const archive = join(root, 'openspec/changes/archive', archiveName);
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, 'proposal.md'), '# sample\n');
  writeFileSync(join(archive, 'tasks.md'), '- [x] done\n'.repeat(checkedTaskCount));
  mkdirSync(join(home, '.raf'), { recursive: true });
  writeFileSync(memoryPath, '{"active":[],"archives":[]}\n');
  return { root, home, memoryPath, store: openStateStore(join(root, 'state.sqlite')) };
}

async function settleFixture(fixture: { root: string; home: string; store: StateStore }): Promise<void> {
  await settleCommandState({
    store: fixture.store,
    orchestratorRoot: fixture.root,
    homeDirectory: fixture.home,
    now: Date.now,
    nextReminderId: () => 'unused',
    catalog: loadEventCatalog(fixture.root),
    deliver: async () => ({ accepted: true, receiptId: 'fixture' }),
  });
}

function removeFixture(fixture: { root: string; home: string; store: StateStore }): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(fixture.home, { recursive: true, force: true });
}

test('command settle stays within budget while an unseen archived change has a large successful task list', async () => {
  const fixture = unseenArchiveFixture(largeCheckedTaskCount);
  try {
    assert.notEqual(fixture.home, process.env.RAF_QA_HOME);
    const started = performance.now();
    await settleFixture(fixture);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < commandSettleBudgetMs, `command-settle read the archived task list for ${elapsedMs} ms; budget is ${commandSettleBudgetMs} ms`);
  } finally {
    removeFixture(fixture);
  }
});

test('worker session end records a successful archive that command settle no longer observes', async () => {
  const fixture = unseenArchiveFixture(1);
  try {
    await settleFixture(fixture);
    assert.deepEqual(JSON.parse(readFileSync(fixture.memoryPath, 'utf8')).archives, []);
    await closeArchivedBugsAfterWorkerSession(fixture.root, fixture.home);
    assert.ok(JSON.parse(readFileSync(fixture.memoryPath, 'utf8')).archives.includes(archiveName));
  } finally {
    removeFixture(fixture);
  }
});
