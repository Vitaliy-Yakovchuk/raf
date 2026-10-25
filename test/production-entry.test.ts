import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCatalog } from '../src/catalog.ts';
import { openStateStore } from '../src/state-store.ts';
import type { ProductionEntryOptions } from '../src/production-entry.ts';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import type { ExecutionResult } from '../src/cli.ts';

const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const projects = JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), projects);

function removeCatalogConfiguration(conf: string): void {
  for (const name of readdirSync(conf)) {
    if (!['projects.json', 'raf.json'].includes(name)) rmSync(join(conf, name), { recursive: true });
  }
}

async function fixture(t: { after(action: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-production-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'orchestrator');
  const conf = join(root, 'conf');
  const home = join(directory, 'isolated-home');
  mkdirSync(conf, { recursive: true });
  mkdirSync(home);
  for (const [name, data] of [['raf.json', settings], ['models.json', models], ['raf-constants.json', constants], ['projects.json', projects]] as const) writeFileSync(join(conf, name), JSON.stringify(data));
  const artifactPath = join(directory, 'catalog.json');
  writeFileSync(artifactPath, JSON.stringify(catalog));
  const runProductionCli = await prepareProductionQaFixture(t, { root, home });
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

test('production help uses compiled catalog without catalog source configuration or SQLite side effects', async t => {
  const f = await fixture(t);
  removeCatalogConfiguration(f.conf);
  const ordinary = success(await f.run(['help', 'runner', 'list']));
  const option = success(await f.run(['runner', 'list', '--help']));
  assert.deepEqual(ordinary, option);
  assert.ok(JSON.stringify(ordinary).includes('runner list') || JSON.stringify(ordinary).includes('"runner","list"'));
  assert.deepEqual(readdirSync(f.home), []);
});

for (const argv of [['runner', 'list', '--invalid'], ['agent', 'run'], ['unknown-command']]) {
  test(`invalid CLI arguments do not create state: ${argv.join(' ')}`, async t => {
    const f = await fixture(t);
    removeCatalogConfiguration(f.conf);
    failure(await f.run(argv));
    assert.deepEqual(readdirSync(f.home), []);
  });
}

test('runner list reads actual conf and initializes one isolated shared SQLite file', async t => {
  const f = await fixture(t);
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
  const f = await fixture(t);
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
  const f = await fixture(t);
  const store = openStateStore(f.statePath);
  try { store.recordCommandDuration('runner list', 314, 0.37); } finally { store.close(); }
  const data = success(await f.run(['command', 'stats']));
  assert.ok(JSON.stringify(data).includes('runner list'));
  assert.ok(records((data as { commands: unknown }).commands).some(row => row.averageMs === 314));
  assert.ok(!records((data as { commands: unknown }).commands).some(row => row.averageMs === 0));
  const reopened = openStateStore(f.statePath);
  try {
    assert.equal(reopened.getCommandTiming('runner list')?.averageMs, 314);
    assert.ok(reopened.getCommandTiming('command stats'));
  } finally { reopened.close(); }
});

test('fresh command stats does not fabricate measurements for commands that never ran', async t => {
  const f = await fixture(t);
  const data = success(await f.run(['command', 'stats']));
  assert.ok(!records((data as { commands: unknown }).commands).some(row => row.averageMs === 0));
  const store = openStateStore(f.statePath);
  try { assert.equal(store.getCommandTiming('agent run'), undefined); } finally { store.close(); }
});

for (const name of ['raf.json', 'models.json']) {
  test(`missing ${name} returns configuration failure before opening state`, async t => {
    const f = await fixture(t);
    rmSync(join(f.conf, name));
    const error = failure(await f.run(['runner', 'list']));
    assert.ok(JSON.stringify(error).includes(name));
    assert.ok(!existsSync(f.statePath));
  });
  test(`unsupported ${name} version is rejected without silently selecting defaults`, async t => {
    const f = await fixture(t);
    const file = join(f.conf, name);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.version = 987654;
    writeFileSync(file, JSON.stringify(data));
    failure(await f.run(['runner', 'list']));
    assert.ok(!existsSync(f.statePath));
  });
  test(`malformed ${name} does not open or recover a default database`, async t => {
    const f = await fixture(t);
    writeFileSync(join(f.conf, name), '{ broken JSON');
    failure(await f.run(['command', 'stats']));
    assert.ok(!existsSync(f.statePath));
  });
}

for (const malformed of [null, '{}', '{ broken JSON']) {
  test(`unavailable compiled catalog gives diagnostic without state: ${String(malformed)}`, async t => {
    const f = await fixture(t);
    if (malformed === null) rmSync(f.options.artifactPath);
    else writeFileSync(f.options.artifactPath, malformed);
    assert.equal(failure(await f.run(['runner', 'list'])).code, 'CATALOG_UNAVAILABLE');
    assert.deepEqual(readdirSync(f.home), []);
  });
}

test('invalid EMA config is rejected before mutation of real SQLite state', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, commandTiming: { ...settings.commandTiming, emaAlpha: 3 } }));
  failure(await f.run(['runner', 'list']));
  assert.ok(!existsSync(f.statePath));
});

test('corrupt SQLite returns structured failure and preserves the original file', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.home, '.raf'));
  const contents = 'invalid sqlite fixture';
  writeFileSync(f.statePath, contents);
  failure(await f.run(['command', 'stats']));
  assert.equal(readFileSync(f.statePath, 'utf8'), contents);
  assert.ok(!existsSync(join(f.root, 'state.sqlite')));
});

test('blocked state directory is reported without fallback', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.home, '.raf'), 'not a directory');
  failure(await f.run(['runner', 'list']));
  assert.equal(readFileSync(join(f.home, '.raf'), 'utf8'), 'not a directory');
  assert.ok(!existsSync(join(f.root, 'state.sqlite')));
});

test('resource wait uses service state preflight before starting a child or creating state', async t => {
  const f = await fixture(t);
  const childMarker = join(f.directory, 'unexpected-resource-wait-child');
  f.options.serviceHostModulePath = join(f.directory, 'unexpected-resource-wait-host.mjs');
  writeFileSync(f.options.serviceHostModulePath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(childMarker)}, 'started');`);
  writeFileSync(join(f.conf, 'projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: {} } } }));
  const error = failure(await f.run(['resource', 'wait', '--level', 'normal']));
  assert.equal(error.code, 'STATE_CONTEXT_REFUSED');
  assert.equal((error.details as Record<string, unknown>).source, 'state-store');
  assert.equal((error.details as Record<string, unknown>).stage, 'state-preflight');
  assert.ok(!existsSync(childMarker));
  assert.ok(!existsSync(f.statePath));
  assert.deepEqual(readdirSync(f.home), []);
});


test('wired empty ps uses canonical shared state without creating an agent', async t => {
  const f = await fixture(t);
  assert.deepEqual(success(await f.run(['agent', 'ps'])), []);
  assert.deepEqual(success(await f.run(['agent', 'ps'])), []);
  const bin = join(f.directory, 'version-mismatch-bin');
  const installedVersion = '0.0.0';
  mkdirSync(bin);
  for (const protocol of settings.runnerProtocols) {
    assert.notEqual(protocol.version, installedVersion);
    const versionOutput = protocol.runner === 'claude' ? `${installedVersion} (Claude Code)` : `${protocol.runner}-cli ${installedVersion}`;
    writeFileSync(join(bin, protocol.executable), `#!/bin/sh\nprintf '%s\\n' '${versionOutput}'\n`);
    chmodSync(join(bin, protocol.executable), 0o755);
  }
  const previousPath = process.env.PATH;
  const restorePath = () => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; };
  process.env.PATH = bin;
  let listed;
  try { listed = await f.run(['runner', 'list']); } finally { restorePath(); }
  const roster = records(success(listed));
  const modelRows = roster.filter(row => typeof row.model === 'string');
  assert.equal(modelRows.length, models.models.length);
  for (const model of models.models) {
    const row = modelRows.find(row => row.model === model.id);
    assert.ok(row, `Missing runner list entry for ${model.id}`);
    const runner = models.runners.find((runner: { id: string }) => runner.id === model.runner);
    const protocol = settings.runnerProtocols.find((protocol: { runner: string }) => protocol.runner === model.runner);
    assert.ok(runner);
    assert.ok(protocol);
    const hasNativeIdentity = Boolean(protocol.native?.identity);
    assert.equal(row.available, model.enabled && runner.initialEnabled && hasNativeIdentity, `Version mismatch must preserve switches and native identity requirements for ${model.id}`);
    assert.ok(Array.isArray(row.warnings), `Missing warnings for ${model.id}`);
    if (hasNativeIdentity) assert.deepEqual(row.warnings, [`версія ${installedVersion} не збігається з перевіреною ${protocol.version}, протокол не перевірено`]);
    assert.equal(row.quota, 'unknown', 'A version warning must not imply measured quota');
  }
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
    const f = await fixture(t);
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

test('default service entry refuses unproven state context before starting a child or creating state', async t => {
  const f = await fixture(t);
  const childMarker = join(f.directory, 'unexpected-service-child');
  f.options.serviceHostModulePath = join(f.directory, 'unexpected-service-host.mjs');
  writeFileSync(f.options.serviceHostModulePath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(childMarker)}, 'started');`);
  writeFileSync(join(f.conf, 'projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: {} } } }));
  const error = failure(await f.run(['service', 'start']));
  assert.equal(error.code, 'STATE_CONTEXT_REFUSED');
  assert.equal((error.details as Record<string, unknown>).source, 'state-store');
  assert.equal((error.details as Record<string, unknown>).stage, 'state-preflight');
  assert.ok(!existsSync(childMarker));
  assert.ok(!existsSync(f.statePath));
  assert.deepEqual(readdirSync(f.home), []);
});

test('invalid service operational budget fails before state or child creation', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, service: { ...settings.service, readinessTimeoutMs: 0 } }));
  const error = failure(await f.run(['service', 'start']));
  assert.equal(error.code, 'PRODUCTION_ENTRY_FAILED');
  assert.match(String((error.details as Record<string, unknown>).reason), /Invalid configured service/);
  assert.deepEqual(readdirSync(f.home), []);
});


test('configured state basename is the single location used by all read-only invocations', async t => {
  const f = await fixture(t);
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
    const f = await fixture(t);
    writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, state: { fileName } }));
    failure(await f.run(['runner', 'list']));
    assert.deepEqual(readdirSync(f.home), []);
  });
}

test('production-entry fixture refuses every entry before state creation without explicit QA context', async t => {
  const f = await fixture(t);
  delete process.env.RAF_QA_HOME;
  for (const argv of [['agent', 'ps'], ['runner', 'list'], ['runner', 'limits', '--runners', 'codex']]) {
    const error = failure(await f.run(argv));
    assert.equal(error.code, 'STATE_CONTEXT_REFUSED', argv.join(' '));
    assert.equal(existsSync(join(f.home, '.raf')), false);
    assert.deepEqual(readdirSync(f.home), []);
  }
  success(await f.run(['help']));
  failure(await f.run(['unknown-command']));
  failure(await f.run(['runner', 'limits', '--runners']));
  assert.equal(existsSync(join(f.home, '.raf')), false);
  assert.deepEqual(readdirSync(f.home), []);
});

test('production-entry fixture refuses help when code provenance configuration is missing', async t => {
  const f = await fixture(t);
  rmSync(join(f.conf, 'projects.json'));
  success(await f.run(['help']));
  const error = failure(await f.run(['agent', 'ps']));
  assert.equal(error.code, 'STATE_CONTEXT_REFUSED');
  assert.equal(existsSync(join(f.home, '.raf')), false);
  assert.deepEqual(readdirSync(f.home), []);
});
