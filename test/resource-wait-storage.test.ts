import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStateStore, STATE_SCHEMA_VERSION } from '../src/state-store.ts';

const grant = { requestId: 'r1', serviceEpoch: 'e1', grantedAt: 100, monotonicAt: 1, bootIdentity: 'boot' };

test('[resource-wait/storage] malformed durable grants cannot become an empty first launch', () => {
  const store = openStateStore(':memory:');
  try {
    store.claimResourceWaitEpoch('e1');
    for (const invalid of ['null', '{}', '[]', '{']) {
      store.startupContextDatabase.prepare('UPDATE resource_wait_protocol_state SET grant_json=?').run(invalid);
      assert.throws(() => store.readResourceWaitGrant());
    }
  } finally { store.close(); }
});

test('[resource-wait/storage] grants are fenced, compare-and-swapped and bounded to one row', () => {
  const store = openStateStore(':memory:');
  try {
    assert.equal(store.readResourceWaitGrant(), null);
    store.claimResourceWaitEpoch('e1');
    assert.equal(store.commitResourceWaitGrant({ expectedEpoch: 'e1', previous: null, next: grant }), 'committed');
    assert.deepEqual(store.readResourceWaitGrant(), grant);
    assert.equal(store.commitResourceWaitGrant({ expectedEpoch: 'e1', previous: null, next: grant }), 'not-committed');
    store.claimResourceWaitEpoch('e2');
    assert.equal(store.commitResourceWaitGrant({ expectedEpoch: 'e1', previous: grant, next: grant }), 'not-committed');
    const next = { ...grant, requestId: 'r2', serviceEpoch: 'e2' };
    assert.equal(store.commitResourceWaitGrant({ expectedEpoch: 'e2', previous: grant, next }), 'committed');
    assert.deepEqual(store.readResourceWaitGrant(), next);
    assert.equal(store.startupContextDatabase.prepare('SELECT COUNT(*) AS n FROM resource_wait_protocol_state').get()!.n, 1);
    assert.equal(store.startupContextDatabase.prepare('PRAGMA user_version').get()!.user_version, STATE_SCHEMA_VERSION);
  } finally { store.close(); }
});


test('[resource-wait/storage] explicit forward migration 11 to 12 on a copy preserves legacy lastGrant and other tables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raf-wait-migration-'));
  const source = join(directory, 'source-v11.sqlite');
  const copy = join(directory, 'copy.sqlite');
  try {
    const seed = openStateStore(source);
    seed.saveResourceWaitLastGrant(1234);
    seed.startupContextDatabase.exec('DROP TABLE resource_wait_protocol_state; PRAGMA user_version=11');
    seed.close();
    copyFileSync(source, copy);
    assert.throws(() => openStateStore(copy), /STATE_MIGRATION_REQUIRED/);
    const store = openStateStore(copy, { transfer: { statePath: copy, fromVersion: 11, toVersion: 12 } });
    try {
      assert.equal(store.startupContextDatabase.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.equal(store.startupContextDatabase.prepare('PRAGMA user_version').get()!.user_version, 12);
      assert.equal(store.startupContextDatabase.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='test_run_groups'").get()!.n, 1);
      assert.equal(store.readResourceWaitGrant()!.grantedAt, 1234);
      assert.equal(store.readResourceWaitGrant()!.bootIdentity, 'legacy');
      assert.equal(store.getResourceWaitLastGrant(), 1234);
    } finally { store.close(); }
    const original = new DatabaseSync(source, { readOnly: true });
    try { assert.equal(original.prepare('PRAGMA user_version').get()!.user_version, 11); }
    finally { original.close(); }
    assert.throws(() => openStateStore(copy, { transfer: { statePath: copy, fromVersion: 12, toVersion: 11 } }), /STATE_SCHEMA_UNSUPPORTED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
