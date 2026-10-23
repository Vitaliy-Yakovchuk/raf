import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MainVersionCompatibility } from '../src/main-version-compatibility.ts';
import { clientA, contractA, exactLegacyA } from '../test/main-version-fixtures/client-a.ts';
import { clientB, contractB } from '../test/main-version-fixtures/client-b.ts';

const codeRoot = resolve(import.meta.dirname, '..');
const expansion = ["ALTER TABLE records ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'", 'CREATE INDEX records_priority ON records(priority, id)'];
const gate = new MainVersionCompatibility();
const [mode, argument] = process.argv.slice(2);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      user_version: db.prepare('PRAGMA user_version').get()!.user_version,
      schema_version: db.prepare('PRAGMA schema_version').get()!.schema_version,
      schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
      data: db.prepare('SELECT * FROM records ORDER BY id').all(),
      integrity: db.prepare('PRAGMA integrity_check').get()!.integrity_check,
    };
  } finally { db.close(); }
}

if (mode === 'worker') {
  const config = JSON.parse(argument);
  const context = { kind: 'isolated-qa' as const, home: config.home, codeRoot };
  let db: DatabaseSync | undefined;
  try {
    if (config.operation === 'client') {
      const a = config.version === 'A';
      const client = a ? await import('../test/main-version-fixtures/client-a.ts') : await import('../test/main-version-fixtures/client-b.ts');
      db = gate.openExisting({ path: config.path, context, client: a ? contractA : contractB });
      db.exec('PRAGMA busy_timeout=0');
      process.send!({ ready: true, pid: process.pid, version: config.version });
      process.on('message', (request: any) => {
        try {
          let result: unknown;
          if (request.op === 'read') result = a ? (client as any).readA(db) : (client as any).readB(db);
          if (request.op === 'write') {
            if (a) (client as any).writeA(db, request.id, request.text);
            else (client as any).writeB(db, request.id, request.text, request.priority ?? 'normal');
            result = true;
          }
          if (request.op === 'sql') { db!.exec(request.sql); result = true; }
          if (request.op === 'close') { db!.close(); db = undefined; process.send!({ ok: true }); process.disconnect(); return; }
          process.send!({ ok: true, result });
        } catch (error: any) { process.send!({ ok: false, code: error.code, message: error.message }); }
      });
    } else if (config.operation === 'gate') {
      const result = gate.checkRelease({ path: config.path, context, current: config.exact ? exactLegacyA : clientA, candidate: clientB });
      console.log(JSON.stringify(result));
      process.exitCode = result.compatible ? 0 : 1;
      process.disconnect();
    } else if (config.operation === 'open') {
      db = gate.openExisting({ path: config.path, context, client: contractA });
      db.close(); db = undefined;
      console.log(JSON.stringify({ opened: true }));
      process.disconnect();
    } else {
      const result = gate.migrateExplicitly({ path: config.path, context, fromVersion: 41, toVersion: 42,
        backupPath: config.backup, clients: [clientA, clientB], statements: expansion,
        beforeCommit() {
          if (config.fault === 'throw') throw Object.assign(new Error('QA injected failure before commit'), { code: 'QA_PRECOMMIT' });
          if (config.fault === 'hold') {
            process.send!({ boundary: true, pid: process.pid });
            const cell = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(config.resume)) Atomics.wait(cell, 0, 0, 10);
          }
        },
      });
      console.log(JSON.stringify(result));
      process.disconnect();
    }
  } catch (error: any) {
    db?.close();
    console.log(JSON.stringify({ code: error.code, message: error.message }));
    process.exitCode = 1;
    process.disconnect();
  }
} else {
  const output = resolve(mode);
  const stand = mkdtempSync('/tmp/raf-state-process-qa-');
  const home = join(stand, 'home');
  mkdirSync(join(home, '.raf'), { recursive: true });
  const path = join(home, '.raf/state.sqlite');
  const active = join(stand, 'raf-main');
  mkdirSync(join(stand, 'slot-A')); mkdirSync(join(stand, 'slot-B'));
  symlinkSync('slot-A', active);
  const owned: any[] = [];
  const evidence: any = {
    command: [process.execPath, ...process.argv.slice(1)], startedAt: new Date().toISOString(), stand,
    environment: { node: process.version, sqlite: process.versions.sqlite, os: release(), platform: process.platform, arch: process.arch },
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codeRoot, encoding: 'utf8' }).trim(),
    workspaceStatus: execFileSync('git', ['status', '--short'], { cwd: codeRoot, encoding: 'utf8' }),
    fingerprints: Object.fromEntries(['src/main-version-compatibility.ts', 'src/state-migration-guard.ts', 'src/state-schema.ts', 'test/main-version-fixtures/client-a.ts', 'test/main-version-fixtures/client-b.ts', 'scripts/qa-main-version-state.ts'].map(file => [file, hash(join(codeRoot, file))])),
    scope: 'Isolated fixture schemas 41/42 only; state compatibility gate and code-selection symlink; release provider/handover are separate tasks. bugs.sqlite is unchanged by this fixture release.',
    processes: [], scenarios: [], snapshots: {}, cleanup: { complete: false }, outcome: 'incomplete',
  };
  const record = (name: string, detail: unknown) => evidence.scenarios.push({ name, detail });
  function launch(config: any) {
    const env: Record<string, string> = { HOME: home, TMPDIR: stand, PATH: process.env.PATH ?? '' };
    const child = fork(import.meta.filename, ['worker', JSON.stringify({ home, path, ...config })], { execArgv: [], cwd: codeRoot, env, silent: true });
    const entry: any = { pid: child.pid, config, argv: [import.meta.filename, 'worker', JSON.stringify({ home, path, ...config })], stdout: '', stderr: '', exitCode: null, signal: null };
    evidence.processes.push(entry);
    const messages: any[] = [];
    let receiver: ((message: any) => void) | undefined;
    child.on('message', message => { if (receiver) { const fn = receiver; receiver = undefined; fn(message); } else messages.push(message); });
    child.stdout!.on('data', chunk => entry.stdout += chunk);
    child.stderr!.on('data', chunk => entry.stderr += chunk);
    const done = new Promise<any>(resolveDone => child.on('close', (code, signal) => { entry.exitCode = code; entry.signal = signal; resolveDone(entry); }));
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise<any>(resolveNext => { receiver = resolveNext; });
    const request = async (value: any) => { child.send(value); const result = await next(); record(`${config.version ?? config.operation}:${value.op}`, { request: value, result }); return result; };
    const item = { child, done, next, request, entry }; owned.push(item); return item;
  }
  async function once(config: any, expected = 0) {
    const worker = launch(config);
    const result = await worker.done;
    assert.equal(result.signal, null);
    assert.equal(result.exitCode, expected, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  }
  async function ok(worker: any, value: any) {
    const result = await worker.request(value);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
  }
  function snap(label: string, file = path) { const value = snapshot(file); evidence.snapshots[label] = value; return value; }
  function switchTo(slot: string) { symlinkSync(slot, active + '.next'); renameSync(active + '.next', active); record('code-selection', { target: readlinkSync(active) }); }
  const guard = setTimeout(() => { evidence.timedOut = true; for (const item of owned) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL'); }, 60000);
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(id TEXT PRIMARY KEY, body TEXT NOT NULL, format_version INTEGER NOT NULL DEFAULT 1, legacy_note TEXT NOT NULL DEFAULT ''); INSERT INTO records(id,body) VALUES ('old','old data'); PRAGMA user_version=41"); db.close();
    const source = snap('initial');
    const a = launch({ operation: 'client', version: 'A' });
    const b = launch({ operation: 'client', version: 'B' });
    assert.equal((await a.next()).ready, true); assert.equal((await b.next()).ready, true);
    assert.notEqual(a.child.pid, b.child.pid);
    assert.equal((await once({ operation: 'gate' })).compatible, true);
    assert.deepEqual(snap('after-source-gate'), source);
    switchTo('slot-B');
    await once({ operation: 'open' });
    switchTo('slot-A');
    await once({ operation: 'open' });
    assert.deepEqual(snap('source-code-only-roundtrip'), source);
    await ok(a, { op: 'write', id: 'a-before', text: 'A before' });
    await ok(b, { op: 'write', id: 'b-before', text: 'B before' });
    assert.equal((await ok(a, { op: 'read' })).length, 3);
    assert.ok((await ok(b, { op: 'read' })).every((row: any) => row.priority === 'normal'));
    const before = snap('before-migration');
    const failed = await once({ operation: 'migrate', backup: join(stand, 'throw.sqlite'), fault: 'throw' }, 1);
    assert.equal(failed.code, 'QA_PRECOMMIT');
    assert.deepEqual(snap('after-thrown-precommit'), before);
    assert.deepEqual(snap('throw-backup', join(stand, 'throw.sqlite')), before);
    const killed = launch({ operation: 'migrate', backup: join(stand, 'killed.sqlite'), fault: 'hold', resume: join(stand, 'never') });
    assert.equal((await killed.next()).boundary, true);
    assert.deepEqual(snap('during-killed-precommit'), before);
    assert.equal(readlinkSync(active), 'slot-A');
    killed.child.kill('SIGKILL'); await killed.done;
    assert.equal(killed.entry.signal, 'SIGKILL');
    assert.deepEqual(snap('after-sigkill'), before);
    await ok(a, { op: 'write', id: 'a-after-kill', text: 'A survived killed migration' });
    await ok(b, { op: 'write', id: 'b-after-kill', text: 'B survived killed migration' });
    const preimage = snap('successful-preimage');
    const backup = join(stand, 'success.sqlite');
    const resume = join(stand, 'commit-now');
    const migration = launch({ operation: 'migrate', backup, fault: 'hold', resume });
    assert.equal((await migration.next()).boundary, true);
    assert.deepEqual(snap('during-successful-precommit'), preimage);
    assert.equal((await ok(a, { op: 'read' })).length, 5);
    assert.equal((await ok(b, { op: 'read' })).length, 5);
    const busy = await b.request({ op: 'write', id: 'blocked', text: 'retry later' });
    assert.equal(busy.ok, false); assert.match(busy.message, /locked|busy/i);
    const competing = await once({ operation: 'migrate', backup: join(stand, 'competitor.sqlite') }, 1);
    assert.equal(competing.code, 'MIGRATION_BUSY');
    assert.equal(existsSync(join(stand, 'competitor.sqlite')), false);
    writeFileSync(resume, 'commit');
    const migrated = await migration.done;
    assert.equal(migrated.exitCode, 0); assert.equal(JSON.parse(migrated.stdout).migrated, true);
    assert.deepEqual(snap('successful-backup', backup), preimage);
    const expanded = snap('after-migration'); assert.equal(expanded.user_version, 42);
    assert.ok(expanded.data.every(row => row.priority === 'normal'));
    const backupHash = hash(backup);
    assert.equal((await once({ operation: 'migrate', backup })).migrated, false);
    assert.deepEqual(snap('after-repeat-migration'), expanded); assert.equal(hash(backup), backupHash);
    assert.equal((await once({ operation: 'gate' })).compatible, true);
    assert.deepEqual(snap('after-target-gate'), expanded);
    switchTo('slot-B');
    await ok(a, { op: 'write', id: 'a-expanded', text: 'A alive after expansion' });
    await ok(b, { op: 'write', id: 'b-expanded', text: 'B new format', priority: 'urgent' });
    await ok(a, { op: 'sql', sql: 'BEGIN IMMEDIATE' });
    await ok(a, { op: 'write', id: 'a-concurrent', text: 'A transaction' });
    assert.equal((await ok(b, { op: 'read' })).some((row: any) => row.id === 'a-concurrent'), false);
    const lock = await b.request({ op: 'write', id: 'b-retry', text: 'B retry', priority: 'urgent' });
    assert.equal(lock.ok, false); assert.match(lock.message, /locked|busy/i);
    await ok(a, { op: 'sql', sql: 'COMMIT' });
    await ok(b, { op: 'write', id: 'b-retry', text: 'B retry', priority: 'urgent' });
    const beforeRollback = snap('before-code-rollback');
    switchTo('slot-A');
    await once({ operation: 'open' });
    assert.deepEqual(snap('after-code-rollback'), beforeRollback);
    assert.equal(hash(backup), backupHash);
    assert.ok((await ok(a, { op: 'read' })).some((row: any) => row.id === 'b-expanded'));
    assert.equal((await ok(b, { op: 'read' })).find((row: any) => row.id === 'b-expanded').priority, 'urgent');
    await ok(a, { op: 'write', id: 'a-rollback', text: 'A after rollback' });
    const beforeRefusal = snap('before-incompatible-gate');
    const refusal = await once({ operation: 'gate', exact: true }, 1);
    assert.equal(refusal.requiresStop, true); assert.ok(refusal.reasonCodes.includes('SCHEMA_UNSUPPORTED'));
    assert.equal(readlinkSync(active), 'slot-A'); assert.deepEqual(snap('after-incompatible-gate'), beforeRefusal);
    const unknownPath = join(home, '.raf/unknown.sqlite');
    const copySource = new DatabaseSync(path, { readOnly: true });
    copySource.prepare('VACUUM main INTO ?').run(unknownPath); copySource.close();
    const unknown = new DatabaseSync(unknownPath); unknown.exec('PRAGMA user_version=999'); unknown.close();
    const unknownBefore = snap('unknown-before', unknownPath);
    assert.equal((await once({ operation: 'open', path: unknownPath }, 1)).code, 'SCHEMA_UNSUPPORTED');
    assert.deepEqual(snap('unknown-after', unknownPath), unknownBefore);
    for (const client of [a, b]) { await ok(client, { op: 'close' }); await client.done; assert.equal(client.entry.exitCode, 0); }
    assert.equal(snap('final').data.length, 10);
    record('backup-not-restored', { sha256: backupHash, finalSha256: hash(backup), finalTarget: readlinkSync(active) });
    evidence.outcome = 'passed';
  } catch (error: any) {
    evidence.outcome = 'failed'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
  } finally {
    clearTimeout(guard);
    for (const item of owned) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
    await Promise.all(owned.map(item => item.done));
    rmSync(stand, { recursive: true, force: true });
    evidence.cleanup = { complete: !existsSync(stand), remainingPids: owned.filter(item => item.child.exitCode === null && item.child.signalCode === null).map(item => item.child.pid) };
    evidence.finishedAt = new Date().toISOString();
    writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ outcome: evidence.outcome, scenarios: evidence.scenarios.length, processes: evidence.processes.length, cleanup: evidence.cleanup, error: evidence.error }));
  }
}
