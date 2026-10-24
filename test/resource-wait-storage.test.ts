import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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


test('[resource-wait/storage] explicit forward migration from schema 11 to current on a copy preserves legacy lastGrant and other tables', () => {
  const legacySchemaVersion = 11;
  const directory = mkdtempSync(join(tmpdir(), 'raf-wait-migration-'));
  const source = join(directory, 'source-v11.sqlite');
  const copy = join(directory, 'copy.sqlite');
  try {
    const schema11ClientCommit = '350e78f3b7a720a74effe12deb57ba8c21ad09cd';
    const archive = join(directory, 'schema-11-client.tar');
    const archived = spawnSync('git', ['archive', '--format=tar', '--output', archive, schema11ClientCommit, 'src', 'package.json'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8',
    });
    assert.equal(archived.error, undefined);
    assert.equal(archived.status, 0, archived.stderr);
    const extracted = spawnSync('tar', ['-xf', archive, '-C', directory], { encoding: 'utf8' });
    assert.equal(extracted.error, undefined);
    assert.equal(extracted.status, 0, extracted.stderr);
    const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { openStateStore, STATE_SCHEMA_VERSION } from ${JSON.stringify(pathToFileURL(join(directory, 'src/state-store.ts')).href)};
      assert.equal(STATE_SCHEMA_VERSION, ${legacySchemaVersion});
      const seed = openStateStore(process.argv[1]);
      try { seed.saveResourceWaitLastGrant(1234); } finally { seed.close(); }
    `, source], { encoding: 'utf8' });
    assert.equal(seeded.error, undefined);
    assert.equal(seeded.status, 0, seeded.stderr);
    const originalBytes = readFileSync(source);
    copyFileSync(source, copy);
    assert.throws(() => openStateStore(copy), /STATE_MIGRATION_REQUIRED/);
    assert.deepEqual(readFileSync(copy), originalBytes, 'ordinary open cannot rewrite the older schema');
    const steps: number[] = [];
    const store = openStateStore(copy, {
      transfer: { statePath: copy, fromVersion: legacySchemaVersion, toVersion: STATE_SCHEMA_VERSION },
      afterMigrationStep: version => { steps.push(version); },
    });
    try {
      assert.deepEqual(steps, Array.from({ length: STATE_SCHEMA_VERSION - legacySchemaVersion }, (_, index) => legacySchemaVersion + index + 1));
      assert.equal(store.startupContextDatabase.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.equal(store.startupContextDatabase.prepare('PRAGMA user_version').get()!.user_version, STATE_SCHEMA_VERSION);
      assert.equal(store.startupContextDatabase.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='test_run_groups'").get()!.n, 1);
      assert.equal(store.readResourceWaitGrant()!.grantedAt, 1234);
      assert.equal(store.readResourceWaitGrant()!.bootIdentity, 'legacy');
      assert.equal(store.getResourceWaitLastGrant(), 1234);
    } finally { store.close(); }
    const original = new DatabaseSync(source, { readOnly: true });
    try { assert.equal(original.prepare('PRAGMA user_version').get()!.user_version, legacySchemaVersion); }
    finally { original.close(); }
    assert.deepEqual(readFileSync(source), originalBytes, 'migration changes only the copy');
    const migratedBytes = readFileSync(copy);
    assert.throws(() => openStateStore(copy, { transfer: { statePath: copy, fromVersion: STATE_SCHEMA_VERSION, toVersion: legacySchemaVersion } }), /STATE_SCHEMA_UNSUPPORTED/);
    assert.deepEqual(readFileSync(copy), migratedBytes, 'a rejected downgrade cannot rewrite the migrated schema');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
