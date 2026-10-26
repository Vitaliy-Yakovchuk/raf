import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { migrateState } from '../src/state-migration.ts';
import { STATE_SCHEMA_VERSION } from '../src/state-store.ts';

const source = resolve(import.meta.dirname, '..');
const configuration = join(dirname(source), 'conf');
const schema7ClientCommit = '084ff760f7690670d30dd4d5aa9cce23da1ba7ac';
const darwinOnly = { skip: process.platform !== 'darwin' };

function bytes(path: string) {
  return Object.fromEntries(['', '-wal', '-shm'].map(suffix => [suffix || 'db', existsSync(path + suffix) ? readFileSync(path + suffix) : null]));
}

function logical(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: Number(database.prepare('PRAGMA user_version').get()!.user_version),
      schema: database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      rows: database.prepare('SELECT * FROM migration_sentinel ORDER BY id').all(),
      integrity: database.prepare('PRAGMA integrity_check').get()!.integrity_check,
    };
  } finally { database.close(); }
}

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raf-mac-migration-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'raf-main');
  const develop = join(root, 'raf-develop');
  const legacy = join(root, 'legacy-schema-7');
  const workingHome = join(root, 'working-home');
  const qaHome = join(root, 'qa-home');
  for (const path of [main, develop, legacy, workingHome, join(qaHome, '.raf')]) mkdirSync(path, { recursive: true });
  cpSync(configuration, join(root, 'conf'), { recursive: true });
  const projectsPath = join(root, 'conf/projects.json');
  const projects = JSON.parse(readFileSync(projectsPath, 'utf8'));
  projects.projects.raf.path = 'raf-main';
  projects.projects.raf.branchPaths = { main: 'raf-main', develop: 'raf-develop' };
  delete projects.projects.raf.mainCopies;
  writeFileSync(projectsPath, JSON.stringify(projects));
  for (const path of ['src', 'bin', 'scripts', 'dist', 'package.json']) cpSync(join(source, path), join(develop, path), { recursive: true });
  const environment = { ...process.env, HOME: qaHome, RAF_QA_HOME: qaHome, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
  for (const [path, branch] of [[root, 'main'], [main, 'main'], [develop, 'develop']]) execFileSync('git', ['init', '--quiet', '--initial-branch', branch, path], { env: environment });
  const archive = execFileSync('git', ['-C', source, 'archive', '--format=tar', schema7ClientCommit, 'src', 'package.json'], { env: environment, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', legacy], { input: archive, env: environment });
  const original = join(root, 'original-state.sqlite');
  const seed = `const {openStateStore}=await import(${JSON.stringify(pathToFileURL(join(legacy, 'src/state-store.ts')).href)});openStateStore(process.argv[1]).close();`;
  execFileSync(process.execPath, ['--input-type=module', '-e', seed, original], { env: environment });
  const seedDatabase = new DatabaseSync(original);
  try {
    assert.equal(Number(seedDatabase.prepare('PRAGMA user_version').get()!.user_version), 7);
    seedDatabase.exec("CREATE TABLE migration_sentinel(id TEXT PRIMARY KEY,payload TEXT NOT NULL,binary BLOB NOT NULL); INSERT INTO migration_sentinel VALUES('legacy','preserve original bytes',x'00ff010a')");
  } finally { seedDatabase.close(); }
  const context = resolveStateContext({ orchestratorRoot: root, modulePath: join(develop, 'bin/raf.ts'), homeDirectory: qaHome, operatingSystemHome: workingHome, environment: { HOME: qaHome, RAF_QA_HOME: qaHome }, entryPoint: 'cli' });
  const reader = new DatabaseSync(original, { readOnly: true });
  try { await backup(reader, context.statePath); }
  finally { reader.close(); }
  assert.ok(context.statePath.startsWith(root + '/'));
  const backupPath = join(root, 'new-canonical-backup.sqlite');
  assert.equal(realpathSync(dirname(backupPath)), dirname(backupPath));
  assert.equal(existsSync(backupPath), false);
  return { root, original, context, path: context.statePath, backupPath, request: { context, statePath: context.statePath, fromVersion: 7, toVersion: STATE_SCHEMA_VERSION, backupPath }, environment };
}

test('Darwin canonical default migration permits quiescent explicit transfer with an immutable backup and retained data', darwinOnly, async t => {
  const f = await fixture(t);
  const original = bytes(f.original);
  const before = logical(f.path);

  const result = await migrateState(f.request);

  assert.equal(result.applied, true);
  assert.equal(result.fromVersion, 7);
  assert.equal(result.toVersion, STATE_SCHEMA_VERSION);
  assert.equal(result.backupPath, f.backupPath);
  assert.equal(realpathSync(f.backupPath), f.backupPath);
  assert.deepEqual(logical(f.backupPath), before);
  const after = logical(f.path);
  assert.equal(after.version, STATE_SCHEMA_VERSION);
  assert.equal(after.integrity, 'ok');
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(bytes(f.original), original);
  const savedBackup = bytes(f.backupPath);
  const repeatBackup = join(f.root, 'unused-repeat-backup.sqlite');
  const repeated = await migrateState({ ...f.request, backupPath: repeatBackup });
  assert.equal(repeated.applied, false);
  assert.equal(existsSync(repeatBackup), false);
  assert.deepEqual(bytes(f.backupPath), savedBackup);
  assert.deepEqual(logical(f.path), after);
  assert.deepEqual(bytes(f.original), original);
});

test('Darwin canonical default migration refuses a genuine live SQLite child holding DB WAL and SHM without changing bytes', darwinOnly, async t => {
  const f = await fixture(t);
  const program = `
    import {DatabaseSync} from 'node:sqlite';
    import {statSync} from 'node:fs';
    const path=process.argv[1];
    const database=new DatabaseSync(path);
    database.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;INSERT INTO migration_sentinel VALUES('child','committed WAL bytes',x'ff00010a')");
    process.send({pid:process.pid,files:['','-wal','-shm'].map(suffix=>({suffix,size:statSync(path+suffix).size}))});
    setInterval(()=>{if(!database)process.exit(1);},1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.path], { env: f.environment, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [ready] = await Promise.race([once(child, 'message', { signal: t.signal }), exited.then(() => { throw new Error('SQLite owner exited before readiness'); })]);
    assert.equal(ready.pid, child.pid);
    assert.deepEqual(ready.files.map(file => file.suffix), ['', '-wal', '-shm']);
    assert.ok(ready.files.every(file => file.size > 0));
    const before = bytes(f.path);
    const original = bytes(f.original);

    await assert.rejects(migrateState(f.request), /client|клієнт/i);

    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.deepEqual(bytes(f.path), before);
    assert.deepEqual(bytes(f.original), original);
    assert.equal(existsSync(f.backupPath), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

for (const observation of ['unknown', 'failed'] as const) {
  test(`Darwin canonical migration preserves DB WAL SHM and creates no backup when client inspection is ${observation}`, darwinOnly, async t => {
    const f = await fixture(t);
    const before = bytes(f.path);
    const original = bytes(f.original);
    let inspections = 0;
    await assert.rejects(migrateState(f.request, {
      async inspectClients(path) {
        assert.equal(path, f.path);
        inspections += 1;
        if (observation === 'failed') throw new Error('fixture client inspection failed');
        return 'unknown';
      },
    }));
    assert.equal(inspections, 1);
    assert.deepEqual(bytes(f.path), before);
    assert.deepEqual(bytes(f.original), original);
    assert.equal(existsSync(f.backupPath), false);
  });
}
