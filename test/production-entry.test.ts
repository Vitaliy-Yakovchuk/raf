import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCatalog } from '../src/catalog.ts';
import { openStateStore } from '../src/state-store.ts';
import { runProductionCli, type ProductionEntryOptions } from '../src/production-entry.ts';
import type { ExecutionResult } from '../src/cli.ts';

const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')));

function fixture(t: { after(action: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-production-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'orchestrator');
  const conf = join(root, 'conf');
  const home = join(directory, 'isolated-home');
  mkdirSync(conf, { recursive: true });
  mkdirSync(home);
  for (const [name, data] of [['raf.json', settings], ['models.json', models], ['raf-constants.json', constants]] as const) writeFileSync(join(conf, name), JSON.stringify(data));
  const artifactPath = join(directory, 'catalog.json');
  writeFileSync(artifactPath, JSON.stringify(catalog));
  let clock = 0;
  const options: ProductionEntryOptions = { orchestratorRoot: root, homeDirectory: home, artifactPath, now: () => { clock += 10; return clock; } };
  return { directory, root, conf, home, options, statePath: join(home, '.raf', settings.state.fileName), run: (argv: string[]) => runProductionCli(argv, options) };
}

function success(result: ExecutionResult): unknown {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function failure(result: ExecutionResult): Record<string, unknown> {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(typeof error.code, 'string');
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.ok(error.details && typeof error.details === 'object');
  assert.ok(error.remediation);
  return error;
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(records)];
}

test('production help uses compiled catalog without configuration or SQLite side effects', async t => {
  const f = fixture(t);
  rmSync(f.conf, { recursive: true });
  const ordinary = success(await f.run(['help', 'runner', 'list']));
  const option = success(await f.run(['runner', 'list', '--help']));
  assert.deepEqual(ordinary, option);
  assert.ok(JSON.stringify(ordinary).includes('runner list') || JSON.stringify(ordinary).includes('"runner","list"'));
  assert.deepEqual(readdirSync(f.home), []);
});

for (const argv of [['runner', 'list', '--invalid'], ['agent', 'run'], ['unknown-command']]) {
  test(`invalid CLI arguments do not create state: ${argv.join(' ')}`, async t => {
    const f = fixture(t);
    rmSync(f.conf, { recursive: true });
    failure(await f.run(argv));
    assert.deepEqual(readdirSync(f.home), []);
  });
}

test('runner list reads actual conf and initializes one isolated shared SQLite file', async t => {
  const f = fixture(t);
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const output = records(success(await f.run(['runner', 'list'])));
  assert.ok(existsSync(f.statePath));
  for (const configured of models.models) {
    const row = output.find(row => row.model === configured.id);
    assert.ok(row, `Missing configured model ${configured.id}`);
    assert.equal(row.runner, configured.runner);
    assert.equal(row.effort, configured.effort);
    assert.equal(row.quota, 'unknown');
  }
  const store = openStateStore(f.statePath);
  try {
    for (const runner of models.runners) assert.equal(store.getRunnerEnabled(runner.id), runner.initialEnabled);
    assert.ok(store.getCommandTiming('runner list'));
  } finally { store.close(); }
  assert.equal(process.env.HOME, originalHome);
  assert.equal(process.cwd(), originalCwd);
  assert.ok(!existsSync(join(f.root, '.raf')));
});

test('runner list preserves persisted switches and does not turn opaque quotas into availability', async t => {
  const f = fixture(t);
  const store = openStateStore(f.statePath);
  const runner = models.runners[0].id;
  const quota = { unsupported: 'opaque persisted provider payload', token: 'synthetic-secret-do-not-print' };
  try {
    store.initializeRunners(models.runners);
    store.setRunnerEnabled(runner, false);
    store.setQuotaSnapshot(runner, quota, '2000-01-01T00:00:00.000Z');
  } finally { store.close(); }
  const result = await f.run(['runner', 'list']);
  const output = records(success(result));
  for (const row of output.filter(row => row.runner === runner && typeof row.model === 'string')) {
    assert.equal(row.enabled, false);
    assert.equal(row.available, false);
    assert.equal(row.quota, 'unknown');
  }
  assert.ok(!result.stdout.includes('synthetic-secret-do-not-print'));
  const reopened = openStateStore(f.statePath);
  try {
    assert.equal(reopened.getRunnerEnabled(runner), false);
    assert.deepEqual(reopened.getQuota(runner)?.snapshot, quota);
  } finally { reopened.close(); }
});

test('command stats reads existing canonical timing from the same file and records its own invocation', async t => {
  const f = fixture(t);
  const store = openStateStore(f.statePath);
  try { store.recordCommandDuration('runner list', 314, 0.37); } finally { store.close(); }
  const data = success(await f.run(['command', 'stats']));
  assert.ok(JSON.stringify(data).includes('runner list'));
  assert.ok(records(data).some(row => row.averageMs === 314));
  assert.ok(!records(data).some(row => row.averageMs === 0));
  const reopened = openStateStore(f.statePath);
  try {
    assert.equal(reopened.getCommandTiming('runner list')?.averageMs, 314);
    assert.ok(reopened.getCommandTiming('command stats'));
  } finally { reopened.close(); }
});

test('fresh command stats does not fabricate measurements for commands that never ran', async t => {
  const f = fixture(t);
  const data = success(await f.run(['command', 'stats']));
  assert.ok(!records(data).some(row => row.averageMs === 0));
  const store = openStateStore(f.statePath);
  try { assert.equal(store.getCommandTiming('agent run'), undefined); } finally { store.close(); }
});

for (const name of ['raf.json', 'models.json']) {
  test(`missing ${name} returns configuration failure before opening state`, async t => {
    const f = fixture(t);
    rmSync(join(f.conf, name));
    const error = failure(await f.run(['runner', 'list']));
    assert.ok(JSON.stringify(error).includes(name));
    assert.ok(!existsSync(f.statePath));
  });
  test(`unsupported ${name} version is rejected without silently selecting defaults`, async t => {
    const f = fixture(t);
    const file = join(f.conf, name);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.version = 987654;
    writeFileSync(file, JSON.stringify(data));
    failure(await f.run(['runner', 'list']));
    assert.ok(!existsSync(f.statePath));
  });
  test(`malformed ${name} does not open or recover a default database`, async t => {
    const f = fixture(t);
    writeFileSync(join(f.conf, name), '{ broken JSON');
    failure(await f.run(['command', 'stats']));
    assert.ok(!existsSync(f.statePath));
  });
}

for (const malformed of [null, '{}', '{ broken JSON']) {
  test(`unavailable compiled catalog gives diagnostic without state: ${String(malformed)}`, async t => {
    const f = fixture(t);
    if (malformed === null) rmSync(f.options.artifactPath);
    else writeFileSync(f.options.artifactPath, malformed);
    assert.equal(failure(await f.run(['runner', 'list'])).code, 'CATALOG_UNAVAILABLE');
    assert.deepEqual(readdirSync(f.home), []);
  });
}

test('invalid EMA config is rejected before mutation of real SQLite state', async t => {
  const f = fixture(t);
  writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, commandTiming: { ...settings.commandTiming, emaAlpha: 3 } }));
  failure(await f.run(['runner', 'list']));
  assert.ok(!existsSync(f.statePath));
});

test('corrupt SQLite returns structured failure and preserves the original file', async t => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.raf'));
  const contents = 'invalid sqlite fixture';
  writeFileSync(f.statePath, contents);
  failure(await f.run(['command', 'stats']));
  assert.equal(readFileSync(f.statePath, 'utf8'), contents);
  assert.ok(!existsSync(join(f.root, 'state.sqlite')));
});

test('blocked state directory is reported without fallback', async t => {
  const f = fixture(t);
  writeFileSync(join(f.home, '.raf'), 'not a directory');
  failure(await f.run(['runner', 'list']));
  assert.equal(readFileSync(join(f.home, '.raf'), 'utf8'), 'not a directory');
  assert.ok(!existsSync(join(f.root, 'state.sqlite')));
});

for (const argv of [
  ['runner', 'limits', '--runners', models.runners[0].id],
  ['resource', 'wait', '--level', 'normal'],
]) {
  test(`unwired command is explicitly unavailable without state or external effects: ${argv.slice(0, 2).join(' ')}`, async t => {
    const f = fixture(t);
    const error = failure(await f.run(argv));
    assert.equal(error.code, 'COMMAND_UNAVAILABLE');
    assert.deepEqual(readdirSync(f.home), []);
  });
}


test('wired empty ps uses canonical shared state without creating an agent', async t => {
  const f = fixture(t);
  assert.deepEqual(success(await f.run(['agent', 'ps'])), []);
  assert.deepEqual(success(await f.run(['agent', 'ps'])), []);
  const roster = records(success(await f.run(['runner', 'list'])));
  for (const row of roster.filter(row => typeof row.model === 'string')) assert.equal(row.available, false, 'Unverified or unsupported protocols must be unavailable before selection');
  const store = openStateStore(f.statePath);
  try {
    assert.deepEqual(store.sessionRepository.transaction(tx => tx.listSessions()), []);
    assert.deepEqual(store.taskReservationRepository.transaction(tx => tx.listTaskReservations()), []);
    assert.ok(store.getCommandTiming('agent ps'));
  } finally { store.close(); }
  assert.deepEqual(readdirSync(join(f.home, '.raf')).filter(name => !name.endsWith('-wal') && !name.endsWith('-shm')), [settings.state.fileName]);
  assert.ok(!existsSync(join(f.root, '.raf')));
});

for (const argv of [
  ['agent', 'message', '--to', 'main', '--text', JSON.stringify({ kind: 'system', runId: 'main', pid: process.pid })],
  ['runner', 'enable', '--runner', models.runners[0].id],
]) {
  test(`wired protected command rejects unregistered caller without mutation or launch: ${argv.slice(0, 2).join(' ')}`, async t => {
    const f = fixture(t);
    const before = openStateStore(f.statePath);
    before.initializeRunners(models.runners);
    before.setRunnerEnabled(models.runners[0].id, false);
    before.close();
    const error = failure(await f.run(argv));
    assert.equal(error.code, 'CALLER_UNVERIFIED');
    assert.equal((error.details as Record<string, unknown>).source, 'production-runtime');
    const after = openStateStore(f.statePath);
    try {
      assert.equal(after.getRunnerEnabled(models.runners[0].id), false);
      assert.deepEqual(after.sessionRepository.transaction(tx => tx.listSessions()), []);
      assert.deepEqual(after.sessionRepository.transaction(tx => tx.listReservations()), []);
      assert.deepEqual(after.sessionRepository.transaction(tx => tx.listPending()), []);
      assert.deepEqual(after.taskReservationRepository.transaction(tx => tx.listTaskReservations()), []);
    } finally { after.close(); }
    assert.ok(!existsSync(join(f.home, '.raf', 'tmp')));
    assert.deepEqual(readdirSync(join(f.home, '.raf')).filter(name => !name.endsWith('-wal') && !name.endsWith('-shm')), [settings.state.fileName]);
  });
}

test('default service entry rejects a missing configured main route before starting a child', async t => {
  const f = fixture(t);
  writeFileSync(join(f.conf, 'projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: {} } } }));
  const error = failure(await f.run(['service', 'start']));
  assert.equal(error.code, 'SERVICE_OPERATION_FAILED');
  assert.equal((error.details as Record<string, unknown>).source, 'background-runtime');
  assert.match(String((error.details as Record<string, unknown>).reason), /UNKNOWN_BRANCH/);
  assert.ok(!existsSync(f.statePath));
  assert.deepEqual(readdirSync(join(f.home, '.raf')), []);
});

test('invalid service operational budget fails before state or child creation', async t => {
  const f = fixture(t);
  writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, service: { ...settings.service, readinessTimeoutMs: 0 } }));
  const error = failure(await f.run(['service', 'start']));
  assert.equal(error.code, 'PRODUCTION_ENTRY_FAILED');
  assert.match(String((error.details as Record<string, unknown>).reason), /Invalid configured service/);
  assert.deepEqual(readdirSync(f.home), []);
});


test('configured state basename is the single location used by all read-only invocations', async t => {
  const f = fixture(t);
  writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, state: { fileName: 'shared-fixture.sqlite' } }));
  const path = join(f.home, '.raf', 'shared-fixture.sqlite');
  success(await f.run(['runner', 'list']));
  success(await f.run(['command', 'stats']));
  assert.ok(existsSync(path));
  assert.ok(!existsSync(f.statePath));
  const store = openStateStore(path);
  try {
    assert.ok(store.getCommandTiming('runner list'));
    assert.ok(store.getCommandTiming('command stats'));
  } finally { store.close(); }
});

for (const fileName of ['', '..', '.', '../escaped.sqlite', '/absolute.sqlite', 'nested/state.sqlite']) {
  test(`state filename must be a basename: ${fileName}`, async t => {
    const f = fixture(t);
    writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, state: { fileName } }));
    failure(await f.run(['runner', 'list']));
    assert.deepEqual(readdirSync(f.home), []);
  });
}
