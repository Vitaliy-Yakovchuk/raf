import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import {
  compatibleMainCanOpen, directoryFiles, files, fixture, logical, nodeProcess, quietWal, seedMain7,
} from './state-migration-fixture.ts';
import type { MigrationFixture } from './state-migration-fixture.ts';

type Entry = 'public CLI' | 'runProductionCli';
type Result = { exitCode: number | null; stdout: string; stderr: string };
const entries: readonly Entry[] = ['public CLI', 'runProductionCli'];

async function run(
  f: MigrationFixture, entry: Entry, argv: readonly string[],
  environment: Record<string, string | undefined> = {}, lazyClock = false,
): Promise<Result> {
  const env = { NODE_NO_WARNINGS: '1', ...environment };
  if (entry === 'public CLI') {
    const result = await nodeProcess(f, { file: join(f.developTree, 'bin', 'raf.ts') }, [...argv], env);
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  }
  const options = {
    orchestratorRoot: f.root,
    homeDirectory: environment.HOME ?? f.workingHome,
    artifactPath: join(f.developTree, 'dist', 'catalog.json'),
  };
  const program = `import { runProductionCli } from ${JSON.stringify(new URL('file://' + join(f.developTree, 'src', 'production-entry.ts')).href)};
const options = ${JSON.stringify(options)};
${lazyClock ? "options.now = () => { throw new Error('Z311: lazy invocation requested the runtime statistics clock'); };" : ''}
const result = await runProductionCli(${JSON.stringify(argv)}, options);
process.stdout.write(JSON.stringify(result));`;
  const child = await nodeProcess(f, program, [], env);
  assert.equal(child.code, 0, `API fixture must return ExecutionResult: ${child.stderr}`);
  const result: Result = JSON.parse(child.stdout);
  assert.equal(typeof result.exitCode, 'number');
  return result;
}

function failure(result: Result, code: string, source?: string): void {
  assert.equal(result.exitCode, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  const diagnostic = JSON.parse(result.stderr);
  assert.equal(diagnostic.code, code, result.stderr);
  if (source) assert.ok(result.stderr.includes(source), `diagnostic identifies ${source}: ${result.stderr}`);
}

async function lazyCommands(
  f: MigrationFixture, entry: Entry, environment: Record<string, string | undefined> = {},
): Promise<void> {
  for (const command of [['runner', 'list'], ['runner', 'enable']]) {
    const help = await run(f, entry, ['help', ...command], environment, true);
    assert.equal(help.exitCode, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.match(help.stdout, /raf/);
    if (command[1] === 'enable') assert.match(help.stdout, /--runner/);
    const flag = await run(f, entry, [...command, '--help'], environment, true);
    assert.deepEqual(flag, help, 'help and --help use the same compiled catalog');
  }
  failure(await run(f, entry, ['no-such-command'], environment, true), 'UNKNOWN_COMMAND');
  failure(await run(f, entry, ['runner', 'list', '--not-a-valid-flag'], environment, true), 'UNKNOWN_ARGUMENT');
  failure(await run(f, entry, ['runner', 'enable', '--runner', 'codex', '--not-a-valid-flag'], environment, true), 'UNKNOWN_ARGUMENT');
  failure(await run(f, entry, ['runner', 'enable'], environment, true), 'MISSING_REQUIRED');
}

function snapshot(f: MigrationFixture) {
  return {
    working: files(f.statePath), qa: files(f.qaStatePath),
    workingFiles: directoryFiles(f.workingHome), qaFiles: directoryFiles(f.qaHome),
    rootFiles: directoryFiles(f.root),
  };
}

function invalidateConfiguration(f: MigrationFixture, kind: 'missing' | 'partial' | 'malformed'): void {
  if (kind === 'missing') {
    rmSync(join(f.root, 'conf'), { recursive: true });
    return;
  }
  for (const name of ['models.json', 'flow.json', 'projects.json', 'raf-constants.json']) rmSync(join(f.root, 'conf', name));
  writeFileSync(join(f.root, 'conf', 'raf.json'), kind === 'partial' ? '{"state":{}}' : '{broken JSON');
}

function accessTripwire(f: MigrationFixture): { environment: Record<string, string>; log: string } {
  const path = join(f.root, 'lazy-access-tripwire.mjs');
  const log = join(f.root, 'forbidden-lazy-access.jsonl');
  const roots = [join(f.root, 'conf'), f.workingHome, f.qaHome];
  writeFileSync(path, `import fs from 'node:fs';
import promises from 'node:fs/promises';
import processes from 'node:child_process';
import sqlite from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
const roots = ${JSON.stringify(roots)};
const append = fs.appendFileSync;
function forbidden(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return false;
  const path = resolve(value);
  return roots.some(root => path === root || path.startsWith(root + '/'));
}
function record(operation, paths = []) {
  append(${JSON.stringify(log)}, JSON.stringify({ operation, paths, argv: process.argv, stack: new Error().stack }) + '\\n');
  throw new Error('Z311 forbidden lazy access: ' + operation);
}
for (const target of [fs, promises]) {
  for (const name of ['readFile', 'open', 'stat', 'lstat', 'access', 'realpath', 'readdir', 'mkdir', 'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'copyFile', 'link', 'symlink', 'readlink', 'createReadStream', 'createWriteStream', 'existsSync', 'readFileSync', 'openSync', 'statSync', 'lstatSync', 'accessSync', 'realpathSync', 'readdirSync', 'mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync', 'linkSync', 'symlinkSync', 'readlinkSync']) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    function guarded(...args) {
      if (forbidden(args[0]) || (/rename|copyFile|link|symlink/.test(name) && forbidden(args[1]))) record(name, args.slice(0, 2).filter(forbidden).map(String));
      return Reflect.apply(original, this, args);
    }
    if (typeof original.native === 'function') guarded.native = (...args) => {
      if (forbidden(args[0])) record(name + '.native', [String(args[0])]);
      return original.native(...args);
    };
    target[name] = guarded;
  }
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  processes[name] = () => record('child_process.' + name);
}
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, { construct() { return record('DatabaseSync'); } });
syncBuiltinESMExports();
`);
  return { log, environment: { NODE_OPTIONS: f.env.NODE_OPTIONS + ' --import=' + path } };
}

for (const entry of entries) {
  for (const kind of ['missing', 'partial', 'malformed'] as const) {
    test(`${entry}: help and parse errors need neither ${kind} runtime config nor a state context`, async t => {
      const f = fixture(t);
      invalidateConfiguration(f, kind);
      const before = snapshot(f);
      await lazyCommands(f, entry);
      assert.deepEqual(snapshot(f), before, 'no runtime, finally/statistics, secrets destination or fallback files');
      assert.equal(existsSync(join(f.workingHome, '.raf')), false);
      assert.equal(existsSync(join(f.qaHome, '.raf')), false);
    });
  }

  test(`${entry}: lazy commands do not even attempt runtime/state reads or child processes`, async t => {
    const f = fixture(t);
    invalidateConfiguration(f, 'malformed');
    const observer = accessTripwire(f);
    const before = snapshot(f);
    try {
      await lazyCommands(f, entry, observer.environment);
    } finally {
      assert.equal(existsSync(observer.log), false,
        existsSync(observer.log) ? readFileSync(observer.log, 'utf8') : 'no forbidden operations');
      assert.deepEqual(snapshot(f), before);
    }
  });
}

async function seedCurrent(f: MigrationFixture): Promise<void> {
  const program = `import { resolveStateContext } from ${JSON.stringify(new URL('file://' + join(f.developTree, 'src', 'state-migration-guard.ts')).href)};
import { openStateStore } from ${JSON.stringify(new URL('file://' + join(f.developTree, 'src', 'state-store.ts')).href)};
const context = resolveStateContext(${JSON.stringify(f.request())});
openStateStore(context.statePath, { context }).close();`;
  const result = await nodeProcess(f, program, [], { HOME: f.qaHome, RAF_QA_HOME: f.qaHome });
  assert.equal(result.code, 0, `authentic current-schema fixture must initialize in allowed QA: ${result.stderr}`);
  const db = await import('node:sqlite');
  const connection = new db.DatabaseSync(f.qaStatePath);
  try {
    connection.exec("CREATE TABLE migration_sentinel(id TEXT PRIMARY KEY, payload TEXT NOT NULL); INSERT INTO migration_sentinel VALUES ('main', 'preserve-fixture-payload')");
  } finally { connection.close(); }
  assert.equal(logical(f.qaStatePath).version, STATE_SCHEMA_VERSION, 'current fixture comes from real migrations, never relabelled schema 7');
  mkdirSync(join(f.workingHome, '.raf'));
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(f.qaStatePath + suffix)) {
      writeFileSync(f.statePath + suffix, readFileSync(f.qaStatePath + suffix));
      rmSync(f.qaStatePath + suffix);
    }
  }
}

for (const entry of entries) {
  for (const version of [7, STATE_SCHEMA_VERSION, 'missing'] as const) {
    for (const withWal of version === 'missing' ? [false] : [false, true]) {
      test(`${entry}: lazy commands leave working schema ${version} ${withWal ? 'with WAL/SHM' : 'without sidecars'} unchanged`, async t => {
        const f = fixture(t);
        if (version === 7) seedMain7(f);
        if (version === STATE_SCHEMA_VERSION) await seedCurrent(f);
        if (withWal) quietWal(t, f.statePath);
        const beforeLogical = version === 'missing' ? null : logical(f.statePath);
        const before = snapshot(f);
        if (!withWal) {
          assert.equal(before.working['-wal'], null);
          assert.equal(before.working['-shm'], null);
        }
        await lazyCommands(f, entry);
        assert.deepEqual(snapshot(f), before);
        if (version === 'missing') assert.equal(existsSync(join(f.workingHome, '.raf')), false);
        else assert.deepEqual(logical(f.statePath), beforeLogical, 'version, sqlite_master, sentinel rows and integrity remain unchanged');
        if (version === 7) compatibleMainCanOpen(f);
      });
    }
  }
}

type InvalidConfiguration = { name: string; file: string; value?: unknown; raw?: string; remove?: boolean };
const invalidConfigurations: readonly InvalidConfiguration[] = [
  { name: 'missing raf.json', file: 'raf.json', remove: true },
  { name: 'malformed raf.json', file: 'raf.json', raw: '{broken JSON' },
  { name: 'partial raf.json', file: 'raf.json', value: { state: {} } },
  { name: 'unsupported version', file: 'raf.json', value: { version: 987654 } },
  { name: 'non-numeric version', file: 'raf.json', value: { version: '1' } },
  { name: 'missing version', file: 'raf.json', value: { version: undefined } },
  { name: 'missing state.fileName', file: 'raf.json', value: { state: {} } },
  { name: 'empty state.fileName', file: 'raf.json', value: { state: { fileName: '' } } },
  { name: 'non-string state.fileName', file: 'raf.json', value: { state: { fileName: 42 } } },
  { name: 'absolute state.fileName', file: 'raf.json' },
  { name: 'traversing state.fileName', file: 'raf.json', value: { state: { fileName: '../outside.sqlite' } } },
  { name: 'missing models.json', file: 'models.json', remove: true },
  { name: 'malformed models.json', file: 'models.json', raw: '{broken JSON' },
];

for (const entry of entries) {
  for (const invalid of invalidConfigurations) {
    test(`${entry}: ${invalid.name} is CONFIGURATION_INVALID in a registered isolated QA context`, async t => {
      const f = fixture(t);
      const path = join(f.root, 'conf', invalid.file);
      const original = JSON.parse(readFileSync(path, 'utf8'));
      if (invalid.remove) rmSync(path);
      else {
        const value = invalid.name === 'absolute state.fileName'
          ? { state: { fileName: join(f.root, 'forbidden-absolute.sqlite') } }
          : invalid.value;
        writeFileSync(path, invalid.raw ?? JSON.stringify({ ...original, ...value as object }));
      }
      const before = snapshot(f);
      const env = { HOME: f.qaHome, RAF_QA_HOME: f.qaHome };
      const result = await run(f, entry, ['runner', 'list'], env);
      failure(result, 'CONFIGURATION_INVALID', invalid.file);
      assert.deepEqual(snapshot(f), before, 'no .raf, sidecars, fallback or statistics on configuration failure');
      assert.equal(existsSync(join(f.qaHome, '.raf')), false);
      assert.equal(existsSync(join(f.workingHome, '.raf')), false);
    });
  }

  test(`${entry}: ordinary .raf blocker in registered QA is HANDLER_FAILED, preserving its bytes and all paths`, async t => {
    const f = fixture(t);
    const blocker = join(f.qaHome, '.raf');
    writeFileSync(blocker, 'z311-blocker-sentinel');
    const beforeFiles = directoryFiles(f.root);
    const before = readFileSync(blocker);
    const result = await run(f, entry, ['command', 'stats'], { HOME: f.qaHome, RAF_QA_HOME: f.qaHome });
    failure(result, 'HANDLER_FAILED');
    assert.match(result.stderr, /ENOTDIR|not a directory|\.raf|каталог/i);
    assert.deepEqual(readFileSync(blocker), before);
    assert.deepEqual(directoryFiles(f.root), beforeFiles);
    assert.equal(existsSync(join(f.workingHome, '.raf')), false);
  });
}
