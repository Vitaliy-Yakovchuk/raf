import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { openSessionRepository } from '../src/session-repository.ts';
import { openStateStore } from '../src/state-store.ts';
import type { SessionRecord } from '../src/session-state.ts';

const moduleUrl = new URL('../src/session-repository.ts', import.meta.url).href;
const session: SessionRecord = {
  runId: 'run-1', addressId: 'worker', revision: 1, state: 'running',
  activity: { type: 'implement', project: 'raf', features: ['sessions'], phase: 'implementation', cwd: '/fixture/raf' },
  process: { pid: 501, startedAt: '2026-10-21T09:00:00Z', runner: 'fixture', runnerSessionId: 'internal-1', tmuxSession: 'tmux-1', evidence: { startTicks: '98765' } },
};
const reservation = { runId: 'run-1', resource: 'fixture-pool', amount: 1 };
const pending = { id: 'event-1', runId: 'run-1', event: 'fixture.observed', payload: { state: 'exited' } };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'raf-session-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'state.sqlite') };
}

function inspect<T>(path: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function metadata(path: string) {
  return inspect(path, db => ({
    version: db.prepare('PRAGMA user_version').get(),
    schemaVersion: db.prepare('PRAGMA schema_version').get(),
    schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
  }));
}

function count(path: string, table: 'sessions' | 'admission_reservations' | 'pending_intents'): number {
  return inspect(path, db => Number(db.prepare(`SELECT count(*) AS amount FROM ${table}`).get()!.amount));
}

function child(path: string, body: string) {
  const script = `import { openSessionRepository } from ${JSON.stringify(moduleUrl)};\nconst path = process.argv[1];\n${body}`;
  const processHandle = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  processHandle.stdout.on('data', chunk => { stdout += chunk; });
  processHandle.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { process: processHandle, done };
}

test('integration: repository persists sessions, admission and pending intents in the state-store database', async t => {
  const f = await fixture(t);
  const state = openStateStore(f.path);
  state.initializeRunners([{ id: 'fixture', initialEnabled: true }]);
  state.close();
  const first = openSessionRepository(f.path);
  try {
    first.repository.transaction(tx => {
      tx.putSession(session);
      tx.putReservation(reservation);
      tx.putPending(pending);
    });
  } finally {
    first.close();
  }
  const next = openSessionRepository(f.path);
  try {
    assert.deepEqual(next.repository.transaction(tx => tx.getSession('run-1')), session);
    assert.deepEqual(next.repository.transaction(tx => tx.listPending()), [pending]);
    assert.equal(count(f.path, 'admission_reservations'), 1);
  } finally {
    next.close();
  }
  const stateAgain = openStateStore(f.path);
  try {
    assert.equal(stateAgain.getRunnerEnabled('fixture'), true);
  } finally {
    stateAgain.close();
  }
  const files = await readdir(f.directory);
  assert.deepEqual(files.filter(name => !name.endsWith('-wal') && !name.endsWith('-shm')), ['state.sqlite']);
});

test('integration: caller exception rolls back all writes and leaves the original error intact', async t => {
  const f = await fixture(t);
  const handle = openSessionRepository(f.path);
  const failure = new Error('injected transaction failure');
  try {
    assert.throws(() => handle.repository.transaction(tx => {
      tx.putSession(session);
      tx.putReservation(reservation);
      tx.putPending(pending);
      throw failure;
    }), error => error === failure);
    assert.equal(handle.repository.transaction(tx => tx.getSession('run-1')), undefined);
    assert.deepEqual(handle.repository.transaction(tx => tx.listPending()), []);
    assert.equal(count(f.path, 'admission_reservations'), 0);
    handle.repository.transaction(tx => tx.putSession(session));
    assert.deepEqual(handle.repository.transaction(tx => tx.getSession('run-1')), session);
  } finally {
    handle.close();
  }
});

test('integration: unsupported domain effects fail atomically instead of silently logging or dropping reminder work', async t => {
  const f = await fixture(t);
  const handle = openSessionRepository(f.path);
  try {
    assert.throws(() => handle.repository.transaction(tx => {
      tx.putSession(session);
      tx.putReservation(reservation);
      tx.putPending(pending);
      tx.applyEffects([{ id: 'effect-1', domain: 'unregistered-fixture-domain', payload: { action: 'required' } }]);
    }));
    assert.equal(count(f.path, 'sessions'), 0);
    assert.equal(count(f.path, 'admission_reservations'), 0);
    assert.equal(count(f.path, 'pending_intents'), 0);
  } finally {
    handle.close();
  }
});

test('integration: process interruption after commit retains delivery, and acknowledging removes the stored intent', async t => {
  const f = await fixture(t);
  const handle = openSessionRepository(f.path);
  handle.close();
  const writer = child(f.path, `const handle = openSessionRepository(path);
handle.repository.transaction(tx => { tx.putSession(${JSON.stringify(session)}); tx.putPending(${JSON.stringify(pending)}); });
process.exit(0);`);
  const outcome = await writer.done;
  assert.equal(outcome.code, 0, outcome.stderr);
  const reopened = openSessionRepository(f.path);
  try {
    assert.deepEqual(reopened.repository.transaction(tx => tx.listPending()), [pending]);
    reopened.repository.transaction(tx => tx.deletePending(pending.id));
    assert.equal(count(f.path, 'pending_intents'), 0);
    assert.equal(count(f.path, 'sessions'), 1);
  } finally {
    reopened.close();
  }
});

test('integration: two processes serialize competing active-address reservations without partial writes', async t => {
  const f = await fixture(t);
  const initialized = openSessionRepository(f.path);
  initialized.close();
  const contenders = ['race-1', 'race-2'].map(runId => child(f.path, `const handle = openSessionRepository(path);
try {
  handle.repository.transaction(tx => {
    if (tx.listSessions().some(row => row.addressId === 'worker' && row.state !== 'finished')) throw new Error('address already active');
    tx.putSession({ runId: ${JSON.stringify(runId)}, addressId: 'worker', revision: 0, state: 'reserved' });
    tx.putReservation({ runId: ${JSON.stringify(runId)}, resource: 'fixture-pool', amount: 1 });
  });
  console.log('committed');
} catch (error) { console.log('rejected'); }
finally { handle.close(); }`));
  const outcomes = await Promise.all(contenders.map(candidate => candidate.done));
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.stderr);
  assert.deepEqual(outcomes.map(outcome => outcome.stdout.trim()).sort(), ['committed', 'rejected']);
  assert.equal(count(f.path, 'sessions'), 1);
  assert.equal(count(f.path, 'admission_reservations'), 1);
});

test('integration: concurrent first opens apply one versioned migration and preserve both committed rows', async t => {
  const f = await fixture(t);
  inspect(f.path, () => undefined);
  const contenders = ['first-1', 'first-2'].map(runId => child(f.path, `const handle = openSessionRepository(path);
try { handle.repository.transaction(tx => tx.putSession({ runId: ${JSON.stringify(runId)}, addressId: ${JSON.stringify(runId)}, revision: 0, state: 'reserved' })); }
finally { handle.close(); }`));
  const outcomes = await Promise.all(contenders.map(candidate => candidate.done));
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(count(f.path, 'sessions'), 2);
  const stable = metadata(f.path);
  assert.ok(Number(stable.version!.user_version) > 0);
  const reopened = openSessionRepository(f.path);
  reopened.close();
  assert.deepEqual(metadata(f.path), stable);
});

test('integration: migration failure preserves schema and version atomically', async t => {
  const f = await fixture(t);
  inspect(f.path, db => db.exec('CREATE VIEW sessions AS SELECT 1 AS incompatible'));
  const before = metadata(f.path);
  assert.throws(() => {
    const handle = openSessionRepository(f.path);
    handle.close();
  });
  assert.deepEqual(metadata(f.path), before);
});

test('integration: opening and reading current schema works while another connection owns a write reservation', async t => {
  const f = await fixture(t);
  const initialized = openSessionRepository(f.path);
  initialized.repository.transaction(tx => tx.putSession(session));
  initialized.close();
  const before = metadata(f.path);
  const writer = new DatabaseSync(f.path);
  writer.exec('BEGIN IMMEDIATE');
  try {
    const reader = child(f.path, `const handle = openSessionRepository(path);
try { console.log(JSON.stringify(handle.repository.transaction(tx => tx.listSessions(), 'read'))); }
finally { handle.close(); }`);
    const outcome = await reader.done;
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(JSON.parse(outcome.stdout), [session]);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
  assert.deepEqual(metadata(f.path), before);
});

test('integration: finished-session retention can use an index and deleting expired rows preserves pending work', async t => {
  const f = await fixture(t);
  const handle = openSessionRepository(f.path);
  try {
    handle.repository.transaction(tx => {
      for (let i = 0; i < 1000; i++) tx.putSession({ runId: `done-${i}`, addressId: `worker-${i}`, revision: 3, state: 'finished', finishedAt: '2026-10-20T09:59:59.000Z' });
      tx.putSession(session);
      tx.putPending({ ...pending, runId: 'done-0' });
    });
    inspect(f.path, db => {
      const query = "SELECT run_id FROM sessions WHERE state = 'finished' AND finished_at < ?";
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all('2026-10-20T10:00:00.000Z');
      assert.match(plan.map(row => String(row.detail)).join('\n'), /SEARCH .* USING (?:COVERING )?INDEX/i);
      assert.equal(db.prepare(query).all('2026-10-20T10:00:00.000Z').length, 1000);
    });
    handle.repository.transaction(tx => tx.deleteSession('done-0'));
    assert.deepEqual(handle.repository.transaction(tx => tx.listPending()), [{ ...pending, runId: 'done-0' }]);
    assert.deepEqual(handle.repository.transaction(tx => tx.getSession('run-1')), session);
  } finally {
    handle.close();
  }
});
