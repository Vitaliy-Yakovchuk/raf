import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore, retryStateOperation } from '../src/state-store.ts';
import { createSessionState } from '../src/session-state.ts';

for (const commitPeer of [false, true]) {
  test(`[Z.125] start transition survives a competing ${commitPeer ? 'committed' : 'uncommitted'} writer after its read`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'raf-contention-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.sqlite');
    const store = openStateStore(path);
    t.after(() => store.close());
    store.sessionRepository.transaction(tx => tx.putSession({ runId: 'launch', addressId: 'agent', revision: 0, state: 'reserved' }));
    const shared = new SharedArrayBuffer(8);
    const barrier = new Int32Array(shared);
    const peer = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.path, { timeout: 0 });
      const barrier = new Int32Array(workerData.shared);
      parentPort.postMessage('ready');
      Atomics.wait(barrier, 0, 0);
      let locked = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare("INSERT INTO runners(id, enabled) VALUES ('peer', 1)").run();
        if (workerData.commitPeer) db.exec('COMMIT');
        else locked = true;
      } catch (error) {
        if ((error.errcode & 255) !== 5) throw error;
      }
      Atomics.store(barrier, 1, 1); Atomics.notify(barrier, 1);
      Atomics.wait(barrier, 0, 1);
      if (locked) db.exec('COMMIT');
      db.close();
    `, { eval: true, workerData: { path, shared, commitPeer } });
    t.after(() => peer.terminate());
    await once(peer, 'message');
    const done = once(peer, 'exit');
    let signalled = false;
    const repository = {
      transaction: (action, mode) => store.sessionRepository.transaction(tx => action({ ...tx, getSession: runId => {
        const row = tx.getSession(runId);
        if (!signalled) {
          signalled = true;
          Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
          assert.notEqual(Atomics.wait(barrier, 1, 0, 5000), 'timed-out', 'peer attempted its competing write');
        }
        return row;
      } }), mode),
    };
    const state = createSessionState({ repository, verifyMainAuthority: () => false, verifyWorkResult: () => true });
    try {
      assert.equal(state.commitStarted('launch', { pid: process.pid, startedAt: new Date().toISOString(), runner: 'codex', runnerSessionId: 'native', tmuxSession: 'own', evidence: { runId: 'launch' } }), true);
    } finally {
      Atomics.store(barrier, 0, 2); Atomics.notify(barrier, 0);
    }
    assert.deepEqual(await done, [0]);
    assert.equal(store.sessionRepository.transaction(tx => tx.getSession('launch'))?.state, 'running');
  });
}

test('[Z.125] explicit read transactions work under a writer and reject writes without poisoning the connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'raf-contention-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = openStateStore(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  assert.throws(() => store.sessionRepository.transaction(tx => tx.putSession({ runId: 'forbidden', addressId: 'agent', revision: 0, state: 'reserved' }), 'read'));
  assert.deepEqual(store.sessionRepository.transaction(tx => tx.listSessions(), 'read'), []);
  store.sessionRepository.transaction(tx => tx.putSession({ runId: 'allowed', addressId: 'agent', revision: 0, state: 'reserved' }));
  assert.equal(store.sessionRepository.transaction(tx => tx.listSessions(), 'read').length, 1);
});

test('[Z.125] transient SQLite contention yields before retry; non-contention and exhaustion preserve the original error', async () => {
  for (const errcode of [5, 6, 517]) {
    const busy = Object.assign(new Error('session transition busy'), { code: 'ERR_SQLITE_ERROR', errcode, operation: 'sessionTransaction' });
    let released = false;
    const timer = setTimeout(() => { released = true; }, 0);
    try {
      assert.equal(await retryStateOperation(() => { if (!released) throw busy; return 'committed'; }, { transitionMs: 1000, pollMs: 5 }), 'committed');
    } finally { clearTimeout(timer); }
    await assert.rejects(retryStateOperation(() => { throw busy; }, { transitionMs: 10, pollMs: 2 }), error => error === busy);
  }
  const invalid = Object.assign(new Error('SQL error'), { code: 'ERR_SQLITE_ERROR', errcode: 1 });
  let attempts = 0;
  await assert.rejects(retryStateOperation(() => { attempts++; throw invalid; }, { transitionMs: 1000, pollMs: 5 }), error => error === invalid);
  assert.equal(attempts, 1);
});
