import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compileCatalog } from '../src/catalog.ts';
import type { ProductionEntryOptions } from '../src/production-entry.ts';
import { openSecretsStore } from '../src/secrets-store.ts';
import { openStateStore } from '../src/state-store.ts';
import type { ExecutionResult } from '../src/cli.ts';

const execute = promisify(execFile);
const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8')));
const secretValue = 'SYNTHETIC_PRIVATE_PAYLOAD_7f4e\nsecond line';
const fileValue = 'SYNTHETIC_FILE_PAYLOAD_8a9b\nтест';

async function fixture(t: { after(action: () => void): void }, realCli = false) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-production-command-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'orchestrator');
  const home = join(directory, 'isolated-home');
  const conf = join(root, 'conf');
  const checkout = join(root, 'raf-develop');
  mkdirSync(conf, { recursive: true });
  mkdirSync(home);
  for (const [name, value] of [['raf.json', settings], ['models.json', models], ['raf-constants.json', constants]] as const) writeFileSync(join(conf, name), JSON.stringify(value));
  const artifactPath = join(directory, 'catalog.json');
  writeFileSync(artifactPath, JSON.stringify(catalog));
  writeFileSync(join(conf, 'projects.json'), JSON.stringify(JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8'))));
  if (realCli) {
    mkdirSync(join(checkout, 'bin'), { recursive: true });
    mkdirSync(join(checkout, 'dist'));
    cpSync(new URL('../src', import.meta.url), join(checkout, 'src'), { recursive: true });
    cpSync(new URL('../bin/raf.ts', import.meta.url), join(checkout, 'bin/raf.ts'));
    writeFileSync(join(checkout, 'package.json'), '{"type":"module"}');
    writeFileSync(join(checkout, 'dist/catalog.json'), JSON.stringify(catalog));
  }
  const runProductionCli = await prepareProductionQaFixture(t, { root, home });
  const options: ProductionEntryOptions = { orchestratorRoot: root, homeDirectory: home, artifactPath };
  return { runProductionCli, directory, root, conf, home, checkout, options, target: join(home, '.raf', 'secrets.json'), statePath: join(home, '.raf', settings.state.fileName), run: (args: string[] = ['runner', 'list']) => runProductionCli(args, options) };
}

function noLeaks(result: ExecutionResult) {
  for (const forbidden of [secretValue, fileValue, 'SYNTHETIC_PRIVATE_PAYLOAD_7f4e', 'SYNTHETIC_FILE_PAYLOAD_8a9b', Buffer.from(fileValue).toString('base64')]) assert.ok(!(result.stdout + result.stderr).includes(forbidden));
}

function success(result: ExecutionResult): unknown {
  noLeaks(result);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function failure(result: ExecutionResult, sourceCode?: string) {
  noLeaks(result);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(typeof error.code, 'string');
  assert.notEqual(error.code, 'COMMAND_UNAVAILABLE');
  assert.equal(typeof error.message, 'string');
  assert.ok(error.details && typeof error.details === 'object');
  assert.ok(error.remediation);
  if (sourceCode) assert.ok(error.code === sourceCode || error.details.sourceCode === sourceCode, `Missing original source code ${sourceCode}`);
  return error;
}

test('missing runner argument remains a parser error without destination state', async t => {
  const f = await fixture(t);
  assert.equal(failure(await f.run(['runner', 'enable'])).code, 'MISSING_REQUIRED');
  assert.ok(!existsSync(join(f.home, '.raf')));
});

for (const invalid of ['missing', 'malformed', 'unsupported-version']) {
  test(`invalid runtime config ${invalid} fails before secrets or SQLite creation`, async t => {
    const f = await fixture(t);
    const path = join(f.conf, 'raf.json');
    if (invalid === 'missing') rmSync(path);
    if (invalid === 'malformed') writeFileSync(path, '{broken JSON');
    if (invalid === 'unsupported-version') writeFileSync(path, JSON.stringify({ ...settings, version: 987654 }));
    failure(await f.run(), 'CONFIGURATION_INVALID');
    assert.ok(!existsSync(f.statePath));
    assert.ok(!existsSync(f.target));
  });
}

test('runner help needs neither runtime config nor destination state', async t => {
  const f = await fixture(t);
  for (const name of ['models.json', 'raf-constants.json', 'flow.json']) rmSync(join(f.conf, name));
  writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ state: settings.state }));
  f.options.now = () => { throw new Error('help must not request the statistics clock'); };
  const result = await f.run(['runner', 'enable', '--help']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.includes('--runner'));
  assert.ok(!existsSync(join(f.home, '.raf')));
});

for (const outcome of ['success', 'handler-error'] as const) {
  test(`command ${outcome} records one EMA measurement in configured shared SQLite`, async t => {
    const f = await fixture(t);
    const fileName = 'configured-command-timing.sqlite';
    const alpha = 0.25;
    const argv = ['reminder', 'list', '--to', 'missing'];
    const canonical = argv.slice(0, 2).join(' ');
    writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, state: { ...settings.state, fileName }, commandTiming: { ...settings.commandTiming, emaAlpha: alpha } }));
    const path = join(f.home, '.raf', fileName);
    const store = openStateStore(path);
    try { store.recordCommandDuration(canonical, 100, alpha); } finally { store.close(); }
    if (outcome === 'handler-error') {
      const connection = new DatabaseSync(path);
      try {
        // Fail the handler's read, leaving shared-state initialization and timing usable.
        connection.exec('ALTER TABLE reminders RENAME TO fixture_reminders; CREATE VIEW reminders AS SELECT * FROM fixture_missing_reminders');
      } finally { connection.close(); }
    }
    let reads = 0;
    f.options.now = () => reads++ === 0 ? 100 : 140;
    const result = await f.run(argv);
    if (outcome === 'success') success(result);
    else {
      const diagnostic = failure(result, 'HANDLER_FAILED');
      assert.equal(diagnostic.details.stage, 'handler');
      assert.equal(diagnostic.details.sourceCode, 'ERR_SQLITE_ERROR');
    }
    assert.equal(reads, 2, 'one completed invocation has exactly one start and end clock read');
    const reopened = openStateStore(path);
    try {
      assert.equal(reopened.getCommandTiming(canonical)?.averageMs, 85);
      if (argv.length > 2) assert.equal(reopened.getCommandTiming(argv.join(' ')), undefined);
    } finally { reopened.close(); }
    assert.ok(!existsSync(f.statePath));
    assert.ok(!existsSync(f.target));
  });
}

for (const secrets of [{ lockWaitTimeoutMs: 0, pollIntervalMs: 1 }, { lockWaitTimeoutMs: 5, pollIntervalMs: 6 }]) {
  test(`secrets lock config is validated from explicit orchestrator root: ${JSON.stringify(secrets)}`, async t => {
    const f = await fixture(t);
    const configPath = join(f.conf, 'raf.json');
    writeFileSync(configPath, JSON.stringify({ ...settings, secrets }));
    const store = await openSecretsStore({ home: f.home, configPath });
    await assert.rejects(store.merge([
      { name: 'SYNTHETIC_KEY', kind: 'env', value: secretValue, source: 'synthetic-test', updatedAt: '2026-10-21T10:00:00.000Z' },
    ]), /secrets|lockWaitTimeoutMs|pollIntervalMs/i);
    // A persistent private store directory is allowed; failed writes must leave no resources.
    const storeDirectory = join(f.home, '.raf');
    if (existsSync(storeDirectory)) {
      assert.equal(statSync(storeDirectory).mode & 0o777, 0o700);
      assert.deepEqual(readdirSync(storeDirectory), []);
    }
    assert.ok(!existsSync(f.statePath));
    assert.ok(!existsSync(f.target));
  });
}

test('real command stats CLI records configured shared EMA without secret payloads', { timeout: 35_000 }, async t => {
  const f = await fixture(t, true);
  const fileName = 'shared-cli-qa.sqlite';
  const alpha = 0.25;
  writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, state: { ...settings.state, fileName }, commandTiming: { ...settings.commandTiming, emaAlpha: alpha } }));
  const path = join(f.home, '.raf', fileName);
  const secrets = await openSecretsStore({ home: f.home });
  await secrets.merge([
    { name: 'SYNTHETIC_KEY', kind: 'env', value: secretValue, source: 'synthetic-test', updatedAt: '2026-10-21T10:00:00.000Z' },
    { name: 'SYNTHETIC_FILE', kind: 'file', contentBase64: Buffer.from(fileValue).toString('base64'), source: 'synthetic-test', updatedAt: '2026-10-21T10:00:00.000Z' },
  ]);
  const before = readFileSync(f.target);
  const store = openStateStore(path);
  try { store.recordCommandDuration('command stats', 1_000_000, alpha); } finally { store.close(); }
  for (let sample = 0; sample < 2; sample++) {
    const output = await execute(process.execPath, [join(f.checkout, 'bin/raf.ts'), 'command', 'stats'], {
      cwd: f.directory, env: { HOME: f.home, RAF_QA_HOME: f.home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1' }, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576,
    });
    success({ ...output, exitCode: 0 });
  }
  const reopened = openStateStore(path);
  try {
    const timing = reopened.getCommandTiming('command stats')!;
    assert.ok(timing.averageMs >= 562_500 && timing.averageMs < 570_000, 'Two subprocess samples must update the seeded EMA with configured alpha');
  } finally { reopened.close(); }
  assert.ok(!existsSync(f.statePath));
  assert.deepEqual(readFileSync(f.target), before);
  for (const value of [secretValue, fileValue, Buffer.from(fileValue).toString('base64')]) assert.ok(!readFileSync(path).includes(Buffer.from(value)));
});
