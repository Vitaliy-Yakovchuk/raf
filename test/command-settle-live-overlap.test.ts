import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadEventCatalog } from '../src/event-catalog.ts';
import { pruneArchivedGroupsAfterWorkerSession, settleCommandState } from '../src/reminder-cli.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';

const commandSettleBudgetMs = 400;
const overlappingKey = 'ab/c';
const activeReferenceBytes = 48 * 1024 * 1024;

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Settle fixture',
    GIT_AUTHOR_EMAIL: 'settle-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Settle fixture',
    GIT_COMMITTER_EMAIL: 'settle-fixture@example.invalid',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  return env;
}

function git(root: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function liveSettleRepository(changeId: string, group: string, activeReference: string | undefined): { root: string; store: StateStore; key: string } {
  const root = mkdtempSync(join(tmpdir(), 'raf-command-settle-'));
  const env = gitEnvironment();
  const key = `${changeId}/${group}`;
  mkdirSync(join(root, 'conf'), { recursive: true });
  writeFileSync(join(root, 'conf/raf.json'), JSON.stringify({
    state: { contention: { busyTimeoutMs: 250, timeoutMs: 10000, retryDelayMs: 100 } },
    health: { summaryIntervalMs: 3600000, cpuWindowMs: 600000, cpuThresholdCores: 1 },
  }));
  writeFileSync(join(root, 'conf/test-runs.json'), `${JSON.stringify({ projects: { raf: { groups: { [key]: { files: ['fixture.test.ts'] } } } } }, null, 2)}\n`);
  git(root, env, 'init', '-q', '-b', 'main');
  git(root, env, 'config', 'user.name', 'Settle fixture');
  git(root, env, 'config', 'user.email', 'settle-fixture@example.invalid');
  git(root, env, 'add', '--', 'conf/test-runs.json');
  git(root, env, 'commit', '-qm', 'baseline');
  const archive = join(root, 'openspec/changes/archive', `2026-11-01-${changeId}`);
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, 'tasks.md'), '- [x] done\n');
  if (activeReference !== undefined) {
    const active = join(root, 'openspec/changes/active-live');
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, 'reference.txt'), activeReference);
  }
  return { root, store: openStateStore(join(root, 'state.sqlite')), key };
}

async function settleLikeWorkerHandshake(root: string, store: StateStore): Promise<number> {
  const started = performance.now();
  await settleCommandState({
    store,
    orchestratorRoot: root,
    now: Date.now,
    nextReminderId: () => 'unused',
    catalog: loadEventCatalog(root),
    deliver: async () => ({ accepted: true, receiptId: 'fixture' }),
  });
  return performance.now() - started;
}

function registeredGroups(root: string): string[] {
  const doc = JSON.parse(readFileSync(join(root, 'conf/test-runs.json'), 'utf8'));
  return Object.keys(doc.projects.raf.groups);
}

test('worker handshake settle stays within the command-settle budget on a large active-change reference', async () => {
  const reference = overlappingKey.repeat(activeReferenceBytes / overlappingKey.length);
  const fixture = liveSettleRepository('ab', 'c', reference);
  try {
    const elapsedMs = await settleLikeWorkerHandshake(fixture.root, fixture.store);
    assert.ok(elapsedMs < commandSettleBudgetMs, `command-settle overlap took ${elapsedMs} ms; budget is ${commandSettleBudgetMs} ms`);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('command settle leaves an archived unreferenced group until the worker session ends', async () => {
  const fixture = liveSettleRepository('cd', 'e', undefined);
  try {
    await settleLikeWorkerHandshake(fixture.root, fixture.store);
    assert.deepEqual(registeredGroups(fixture.root), [fixture.key]);
    await pruneArchivedGroupsAfterWorkerSession(fixture.root);
    assert.deepEqual(registeredGroups(fixture.root), []);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
