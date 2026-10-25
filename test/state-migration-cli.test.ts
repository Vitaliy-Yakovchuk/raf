import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveStateContext, stateContextEnvironment } from '../src/state-migration-guard.ts';
import { STATE_SCHEMA_VERSION } from '../src/state-store.ts';
import { command, compatibleMainCanOpen, copyMain7, directoryFiles, files, fixture, logical, nodeProcess, quietWal, seedMain7, seedMain10, seedVersion } from './state-migration-fixture.ts';

const commands = [
  ['help'],
  ['agent', 'ps'],
  ['runner', 'list'],
  ['runner', 'limits', '--runners', 'codex'],
  ['no-such-command'],
  ['agent', 'ps', '--not-a-valid-flag'],
];

function lazyResult(argv: readonly string[], result: ReturnType<typeof command>): boolean {
  if (argv[0] === 'help') {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /raf/);
    return true;
  }
  if (argv[0] === 'no-such-command' || argv.includes('--not-a-valid-flag')) {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, argv[0] === 'no-such-command' ? /UNKNOWN_COMMAND/ : /UNKNOWN_ARGUMENT/);
    assert.doesNotMatch(result.stdout + result.stderr, /STATE_CONTEXT_REFUSED|CONFIGURATION_INVALID|HANDLER_FAILED/);
    return true;
  }
  return false;
}

function refused(result: ReturnType<typeof command>, f: ReturnType<typeof fixture>, path = f.statePath): void {
  assert.equal(result.error, undefined, 'Node and the fixture entry must start successfully');
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  const output = result.stdout + result.stderr;
  assert.match(output, /STATE_CONTEXT_REFUSED/);
  assert.ok(output.includes(f.developTree), 'diagnostic identifies the actual code tree');
  assert.ok(output.includes(path), 'diagnostic identifies the refused state path');
  assert.match(output, /RAF_QA_HOME|ізольован|isolat/i, 'diagnostic gives a QA remediation');
}

for (const argv of commands) {
  for (const withWal of [false, true]) {
    test(`develop ${argv.join(' ')} preserves working schema 7 ${withWal ? 'with WAL/SHM' : 'without sidecars'} byte-for-byte`, t => {
      const f = fixture(t);
      seedMain7(f);
      if (withWal) quietWal(t, f.statePath);
      const beforeLogical = logical(f.statePath);
      const before = files(f.statePath);
      const beforeFiles = directoryFiles(join(f.workingHome, '.raf'));
      if (!withWal) {
        assert.equal(before['-wal'], null);
        assert.equal(before['-shm'], null);
      }
      const result = command(f, argv);
      if (!lazyResult(argv, result)) refused(result, f);
      assert.deepEqual(files(f.statePath), before, 'DB and existing sidecars retain their bytes; absent sidecars stay absent');
      assert.deepEqual(directoryFiles(join(f.workingHome, '.raf')), beforeFiles, 'no statistics, maintenance or runtime artifacts');
      assert.deepEqual(logical(f.statePath), beforeLogical);
      compatibleMainCanOpen(f);
    });
  }
}

for (const version of [10, 'missing'] as const) {
  for (const argv of commands) {
    test(`develop ${argv.join(' ')} leaves ${version} state untouched`, t => {
      const f = fixture(t);
      if (version === 10) seedMain10(f);
      const before = files(f.statePath);
      const beforeHome = directoryFiles(f.workingHome);
      const result = command(f, argv);
      if (!lazyResult(argv, result)) refused(result, f);
      assert.deepEqual(files(f.statePath), before);
      assert.deepEqual(directoryFiles(f.workingHome), beforeHome);
      if (version === 'missing') assert.equal(existsSync(join(f.workingHome, '.raf')), false);
    });
  }
}

test('cwd main, a symlink executable and claimed branch=main cannot change develop code provenance', t => {
  const f = fixture(t);
  seedMain7(f);
  const alias = join(f.mainTree, 'bin', 'develop-alias.ts');
  symlinkSync(join(f.developTree, 'bin', 'raf.ts'), alias);
  const before = files(f.statePath);
  for (const executable of [join(f.developTree, 'bin', 'raf.ts'), alias]) {
    const result = command(f, ['agent', 'ps'], { cwd: f.mainTree, executable, env: { branch: 'main', RAF_BRANCH: 'main' } });
    refused(result, f);
    assert.deepEqual(files(f.statePath), before);
  }
});

test('a hardlinked entry under the main tree does not prove main module provenance', t => {
  const f = fixture(t);
  seedMain7(f);
  const entry = join(f.developTree, 'bin', 'develop-hardlink.ts');
  writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(join(f.developTree, 'bin', 'raf.ts')).href)};\n`);
  const alias = join(f.mainTree, 'bin', 'develop-hardlink.ts');
  linkSync(entry, alias);
  assert.equal(statSync(alias).dev, statSync(entry).dev);
  assert.equal(statSync(alias).ino, statSync(entry).ino);
  assert.equal(statSync(alias).nlink, 2);
  const before = files(f.statePath);
  const result = command(f, ['agent', 'ps'], { cwd: f.mainTree, executable: alias });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /STATE_CONTEXT_REFUSED/);
  assert.doesNotMatch(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.deepEqual(files(f.statePath), before);
});

test('changing HOME alone does not authorize QA or make the account HOME a different working state', t => {
  const f = fixture(t);
  seedMain7(f);
  const before = files(f.statePath);
  const result = command(f, ['agent', 'ps'], { env: { HOME: f.qaHome } });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /STATE_CONTEXT_REFUSED/);
  assert.deepEqual(files(f.statePath), before);
  assert.equal(existsSync(f.qaStatePath), false);
});

for (const aliasKind of ['HOME', '.raf', 'sqlite', 'wal', 'shm', 'tmp', 'hardlink-sqlite', 'hardlink-wal', 'hardlink-shm'] as const) {
  test(`public CLI refuses a QA ${aliasKind} alias to the working state`, t => {
    const f = fixture(t);
    seedMain7(f);
    quietWal(t, f.statePath);
    let home = f.qaHome;
    if (aliasKind === 'HOME') {
      home = join(f.root, 'alias-home');
      symlinkSync(f.workingHome, home);
    } else if (aliasKind === '.raf') {
      symlinkSync(join(f.workingHome, '.raf'), join(f.qaHome, '.raf'));
    } else {
      mkdirSync(join(f.qaHome, '.raf'));
      const suffix = aliasKind.endsWith('wal') ? '-wal' : aliasKind.endsWith('shm') ? '-shm' : '';
      if (aliasKind === 'tmp') symlinkSync(join(f.workingHome, '.raf'), join(f.qaHome, '.raf', 'tmp'));
      else if (aliasKind.startsWith('hardlink')) linkSync(f.statePath + suffix, f.qaStatePath + suffix);
      else symlinkSync(f.statePath + suffix, f.qaStatePath + suffix);
    }
    const before = files(f.statePath);
    const result = command(f, ['agent', 'ps'], { env: { HOME: home, RAF_QA_HOME: home } });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /STATE_CONTEXT_REFUSED/);
    assert.deepEqual(files(f.statePath), before);
  });
}

test('refusal happens before runner discovery, tmux, fallback commands or statistics', t => {
  const f = fixture(t);
  seedMain7(f);
  const bin = join(f.root, 'sentinel-bin');
  mkdirSync(bin);
  const log = join(f.root, 'forbidden-process.log');
  for (const name of ['tmux', 'codex', 'claude', 'grok', 'agy', 'raf']) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${log}'\nexit 91\n`);
    chmodSync(path, 0o755);
  }
  const before = files(f.statePath);
  const mainEntry = join(f.mainTree, 'bin', 'raf.ts');
  writeFileSync(mainEntry, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, 'main-fallback'); process.exitCode = 91;`);
  refused(command(f, ['runner', 'limits', '--runners', 'codex'], { env: { PATH: bin + ':' + f.env.PATH } }), f);
  assert.equal(existsSync(log), false);
  assert.deepEqual(files(f.statePath), before);
});

test('an explicit empty QA HOME works and a separate child CLI stays on the QA state and tmux socket', async t => {
  const f = fixture(t);
  seedMain7(f);
  const before = files(f.statePath);
  const context = resolveStateContext(f.request());
  const env = stateContextEnvironment(context, f.env);
  const first = command(f, ['runner', 'list'], { env });
  assert.equal(first.error, undefined);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(existsSync(f.qaStatePath), true);
  const program = `import { resolveStateContext } from ${JSON.stringify(new URL('../src/state-migration-guard.ts', import.meta.url).href)};
import { openStateStore } from ${JSON.stringify(new URL('../src/state-store.ts', import.meta.url).href)};
import os from 'node:os';
const context = resolveStateContext({ orchestratorRoot: process.argv[1], modulePath: process.argv[2], homeDirectory: os.homedir(), operatingSystemHome: os.userInfo().homedir, environment: process.env, entryPoint: 'worker' });
openStateStore(context.statePath, { context }).close();
console.log(JSON.stringify(context));`;
  const child = await nodeProcess(f, program, [f.root, join(f.developTree, 'src', 'production-runtime.ts')], env);
  assert.equal(child.code, 0, child.stderr);
  const selected = JSON.parse(child.stdout.trim());
  assert.equal(selected.homeDirectory, f.qaHome);
  assert.equal(selected.statePath, f.qaStatePath);
  assert.equal(selected.tmpRoot, context.tmpRoot);
  assert.equal(selected.tmuxSocketPath, context.tmuxSocketPath);
  assert.deepEqual(files(f.statePath), before);
});

for (const entry of ['worker', 'production-service-ports', 'service-host'] as const) {
  test(`actual ${entry} child refuses working HOME without touching SQLite`, async t => {
    const f = fixture(t);
    seedMain7(f);
    const before = files(f.statePath);
    const module = entry === 'worker' ? 'production-runtime' : entry;
    const invocation = entry === 'worker'
      ? 'await implementation.runProductionWorker()'
      : `await implementation.createServicePorts({ orchestratorRoot: process.argv[1], homeDirectory: process.env.HOME, stateDirectory: process.env.HOME + '/.raf', socketPath: process.env.HOME + '/.raf/service.sock' })`;
    const program = `import * as implementation from ${JSON.stringify(new URL('file://' + join(f.developTree, 'src', module + '.ts')).href)};
try { ${invocation}; process.exit(90); }
catch (error) { console.error(JSON.stringify({ code: error.code, message: error.message })); process.exit(23); }`;
    const result = await nodeProcess(f, program, [f.root]);
    assert.equal(result.code, 23, result.stderr);
    assert.match(result.stderr, /STATE_CONTEXT_REFUSED/);
    assert.deepEqual(files(f.statePath), before);
    compatibleMainCanOpen(f);
  });
}

for (const argv of [['agent', 'ps'], ['runner', 'list'], ['runner', 'limits', '--runners', 'codex']]) {
  test(`allowed QA ${argv.join(' ')} on older state requires explicit transfer even with a global environment flag`, t => {
    const f = fixture(t);
    seedMain7(f, f.qaStatePath);
    const before = files(f.qaStatePath);
    const result = command(f, argv, { env: { HOME: f.qaHome, RAF_QA_HOME: f.qaHome, ALLOW_MIGRATIONS: '1' } });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /STATE_MIGRATION_REQUIRED/);
    assert.match(output, /7/);
    assert.ok(output.includes(`explicit migration to ${STATE_SCHEMA_VERSION} required`));
    assert.deepEqual(files(f.qaStatePath), before);
    assert.equal(existsSync(f.statePath), false);
  });
}

test('maintenance CLI is explicit, path-bound and does not grant migration to subsequent ordinary commands', async t => {
  const f = fixture(t);
  seedMain7(f);
  await copyMain7(f);
  const source = files(f.statePath);
  const before = logical(f.qaStatePath);
  const backupPath = join(f.root, 'maintenance-backup.sqlite');
  const program = (clients: 'unknown' | 'quiescent') => `import assert from 'node:assert/strict';
import { runStateMigration } from ${JSON.stringify(pathToFileURL(join(f.developTree, 'src', 'state-migration.ts')).href)};
let inspections = 0;
process.exitCode = await runStateMigration(process.argv.slice(1), {
  async inspectClients(path) {
    assert.equal(path, ${JSON.stringify(f.qaStatePath)});
    inspections++;
    return ${JSON.stringify(clients)};
  }
});
assert.equal(inspections, ${clients === 'unknown' ? 1 : 2});`;
  const env = { HOME: f.qaHome, RAF_QA_HOME: f.qaHome };
  const args = ['--state', f.qaStatePath, '--from', '7', '--to', String(STATE_SCHEMA_VERSION), '--backup', backupPath];
  const unverified = await nodeProcess(f, program('unknown'), ['--', ...args], env);
  assert.equal(unverified.code, 1, unverified.stderr);
  assert.equal(JSON.parse(unverified.stderr.trim()).code, 'STATE_MIGRATION_CONFLICT');
  assert.match(unverified.stderr, /unknown client/);
  assert.equal(existsSync(backupPath), false);
  assert.deepEqual(logical(f.qaStatePath), before);
  assert.deepEqual(files(f.statePath), source);
  const result = await nodeProcess(f, program('quiescent'), ['--', ...args], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(logical(backupPath), before);
  assert.equal(logical(f.qaStatePath).version, STATE_SCHEMA_VERSION);
  assert.deepEqual(logical(f.qaStatePath).rows, before.rows);
  assert.ok(result.stdout.includes(f.qaStatePath));
  assert.match(result.stdout, /7/);
  assert.equal(JSON.parse(result.stdout).toVersion, STATE_SCHEMA_VERSION);
  assert.ok(!result.stdout.includes('preserve-fixture-payload'));
  const next = command(f, ['runner', 'list'], { env });
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.deepEqual(files(f.statePath), source);
});

test('develop maintenance cannot transfer the working state even with exact path and versions', async t => {
  const f = fixture(t);
  seedMain7(f);
  const before = files(f.statePath);
  const backupPath = join(f.root, 'must-not-exist.sqlite');
  const program = { file: join(f.developTree, 'scripts', 'migrate-state.ts') };
  const result = await nodeProcess(f, program, ['--state', f.statePath, '--from', '7', '--to', String(STATE_SCHEMA_VERSION), '--backup', backupPath]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /STATE_CONTEXT_REFUSED/);
  assert.deepEqual(files(f.statePath), before);
  assert.equal(existsSync(backupPath), false);
});

for (const version of [0, STATE_SCHEMA_VERSION + 1, STATE_SCHEMA_VERSION + 1000]) {
  test(`public QA CLI refuses nonempty unknown schema ${version} without downgrade`, t => {
    const f = fixture(t);
    seedVersion(f, version, f.qaStatePath);
    const before = files(f.qaStatePath);
    const result = command(f, ['runner', 'list'], { env: { HOME: f.qaHome, RAF_QA_HOME: f.qaHome } });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /STATE_SCHEMA_UNSUPPORTED/);
    assert.deepEqual(files(f.qaStatePath), before);
  });
}
