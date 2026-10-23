import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCatalog } from '../src/catalog.ts';
import type { ProductionEntryOptions } from '../src/production-entry.ts';
import { openSecretsStore } from '../src/secrets-store.ts';
import { openStateStore } from '../src/state-store.ts';
import type { ExecutionResult } from '../src/cli.ts';

const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8')));
const secretValue = 'SYNTHETIC_PRIVATE_PAYLOAD_7f4e\nsecond line';
const fileValue = 'SYNTHETIC_FILE_PAYLOAD_8a9b\nтест';
const updated = '2026-10-21T10:00:00.000Z';

async function fixture(t: { after(action: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-production-secrets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'orchestrator');
  const home = join(directory, 'isolated-home');
  const conf = join(root, 'conf');
  mkdirSync(conf, { recursive: true });
  mkdirSync(home);
  for (const [name, value] of [['raf.json', settings], ['models.json', models], ['raf-constants.json', constants]] as const) writeFileSync(join(conf, name), JSON.stringify(value));
  const artifactPath = join(directory, 'catalog.json');
  writeFileSync(artifactPath, JSON.stringify(catalog));
  const sourcePath = join(directory, 'synthetic-source.json');
  const bindingPath = join(directory, 'must-not-be-restored');
  const source = { version: 1, secrets: {
    SYNTHETIC_KEY: { kind: 'env', value: secretValue, source: 'synthetic-test', updated },
    SYNTHETIC_FILE: { kind: 'file', value: fileValue, source: 'synthetic-test', updated, path: bindingPath, mode: '600' },
  } };
  writeFileSync(sourcePath, JSON.stringify(source));
  writeFileSync(join(conf, 'projects.json'), JSON.stringify(JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8'))));
  const runProductionCli = await prepareProductionQaFixture(t, { root, home });
  const options: ProductionEntryOptions = { orchestratorRoot: root, homeDirectory: home, artifactPath };
  return { runProductionCli, directory, root, conf, home, source, sourcePath, bindingPath, options, target: join(home, '.raf', 'secrets.json'), statePath: join(home, '.raf', settings.state.fileName), run: (path = sourcePath) => runProductionCli(['secrets', 'import-conductor', '--file', path], options) };
}

function noLeaks(result: ExecutionResult) {
  for (const forbidden of [secretValue, fileValue, 'SYNTHETIC_PRIVATE_PAYLOAD_7f4e', 'SYNTHETIC_FILE_PAYLOAD_8a9b', Buffer.from(fileValue).toString('base64')]) assert.ok(!(result.stdout + result.stderr).includes(forbidden));
}

function success(result: ExecutionResult): { added: string[]; unchanged: string[] } {
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

test('production secrets import writes synthetic env and file records to explicit home only', async t => {
  const f = await fixture(t);
  const original = readFileSync(f.sourcePath);
  const environment = { ...process.env };
  const result = success(await f.run());
  assert.deepEqual([...result.added].sort(), ['SYNTHETIC_FILE', 'SYNTHETIC_KEY']);
  assert.deepEqual(result.unchanged, []);
  assert.deepEqual(readFileSync(f.sourcePath), original);
  assert.ok(!existsSync(f.bindingPath));
  assert.ok(!existsSync(join(f.root, '.raf')));
  assert.deepEqual({ ...process.env }, environment);
  assert.equal(statSync(join(f.home, '.raf')).mode & 0o777, 0o700);
  assert.equal(statSync(f.target).mode & 0o777, 0o600);
  const store = await openSecretsStore({ home: f.home });
  const selected = await store.select(['SYNTHETIC_KEY', 'SYNTHETIC_FILE']);
  assert.equal(selected.env.SYNTHETIC_KEY, secretValue);
  assert.equal(selected.files[0].contentBase64, Buffer.from(fileValue).toString('base64'));
});

test('production repeat import reports unchanged names without rewriting records', async t => {
  const f = await fixture(t);
  success(await f.run());
  const original = readFileSync(f.target);
  const modifiedAt = statSync(f.target).mtimeMs;
  const result = success(await f.run());
  assert.deepEqual(result.added, []);
  assert.deepEqual([...result.unchanged].sort(), ['SYNTHETIC_FILE', 'SYNTHETIC_KEY']);
  assert.deepEqual(readFileSync(f.target), original);
  assert.equal(statSync(f.target).mtimeMs, modifiedAt);
});

test('production conflict preserves entire destination and original source without partial additions', async t => {
  const f = await fixture(t);
  success(await f.run());
  const targetBefore = readFileSync(f.target);
  const source = { version: 1, secrets: {
    SYNTHETIC_NEW: { kind: 'env', value: 'synthetic-new', source: 'synthetic-test', updated },
    SYNTHETIC_KEY: { ...f.source.secrets.SYNTHETIC_KEY, value: 'synthetic-conflicting-value' },
  } };
  writeFileSync(f.sourcePath, JSON.stringify(source));
  const sourceBefore = readFileSync(f.sourcePath);
  const result = await f.run();
  failure(result, 'conflict');
  assert.ok(!(result.stdout + result.stderr).includes('synthetic-conflicting-value'));
  assert.deepEqual(readFileSync(f.target), targetBefore);
  assert.deepEqual(readFileSync(f.sourcePath), sourceBefore);
});

test('missing import argument remains a parser error with no destination state', async t => {
  const f = await fixture(t);
  const result = await f.runProductionCli(['secrets', 'import-conductor'], f.options);
  assert.equal(failure(result).code, 'MISSING_REQUIRED');
  assert.ok(!existsSync(join(f.home, '.raf')));
});

test('missing source returns source-unavailable and never creates secrets document', async t => {
  const f = await fixture(t);
  failure(await f.run(join(f.directory, 'missing.json')), 'source-unavailable');
  assert.ok(!existsSync(f.target));
});

test('directory source returns source-unavailable without a secrets document', async t => {
  const f = await fixture(t);
  failure(await f.run(f.directory), 'source-unavailable');
  assert.ok(!existsSync(f.target));
});

test('malformed source diagnostics omit raw JSON payload', async t => {
  const f = await fixture(t);
  writeFileSync(f.sourcePath, '{"secret": "' + secretValue);
  failure(await f.run(), 'malformed-source');
  assert.ok(!existsSync(f.target));
});

test('unsupported source version is explicit and leaves source unchanged', async t => {
  const f = await fixture(t);
  writeFileSync(f.sourcePath, JSON.stringify({ ...f.source, version: 987654 }));
  const before = readFileSync(f.sourcePath);
  failure(await f.run(), 'unsupported-version');
  assert.deepEqual(readFileSync(f.sourcePath), before);
  assert.ok(!existsSync(f.target));
});

test('invalid source tail prevents importing valid earlier entries', async t => {
  const f = await fixture(t);
  writeFileSync(f.sourcePath, JSON.stringify({ version: 1, secrets: { ...f.source.secrets, INVALID_TAIL: { kind: 'env', value: '', source: 'synthetic-test', updated } } }));
  failure(await f.run(), 'invalid-record');
  assert.ok(!existsSync(f.target));
});

for (const invalid of ['missing', 'malformed', 'unsupported-version']) {
  test(`invalid runtime config ${invalid} fails before secrets or SQLite creation`, async t => {
    const f = await fixture(t);
    const path = join(f.conf, 'raf.json');
    if (invalid === 'missing') rmSync(path);
    if (invalid === 'malformed') writeFileSync(path, '{broken JSON');
    if (invalid === 'unsupported-version') writeFileSync(path, JSON.stringify({ ...settings, version: 987654 }));
    failure(await f.run());
    assert.ok(!existsSync(f.statePath));
    assert.ok(!existsSync(f.target));
  });
}

test('secrets help needs neither runtime config nor source nor destination state', async t => {
  const f = await fixture(t);
  for (const name of ['models.json', 'raf-constants.json', 'flow.json']) rmSync(join(f.conf, name));
  writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ state: settings.state }));
  rmSync(f.sourcePath);
  const result = await f.runProductionCli(['secrets', 'import-conductor', '--help'], f.options);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.stdout.includes('--file'));
  assert.ok(!existsSync(join(f.home, '.raf')));
});


for (const outcome of ['success', 'source-error'] as const) {
  test(`secrets ${outcome} records one EMA measurement in configured shared SQLite`, async t => {
    const f = await fixture(t);
    const fileName = 'secrets-command-timing.sqlite';
    const alpha = 0.25;
    writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, state: { ...settings.state, fileName }, commandTiming: { ...settings.commandTiming, emaAlpha: alpha } }));
    const path = join(f.home, '.raf', fileName);
    const store = openStateStore(path);
    try { store.recordCommandDuration('secrets import-conductor', 100, alpha); } finally { store.close(); }
    let reads = 0;
    f.options.now = () => reads++ === 0 ? 100 : 140;
    const result = await f.run(outcome === 'success' ? f.sourcePath : join(f.directory, 'missing-source.json'));
    if (outcome === 'success') success(result);
    else failure(result, 'source-unavailable');
    const reopened = openStateStore(path);
    try {
      assert.equal(reopened.getCommandTiming('secrets import-conductor')?.averageMs, 85);
      assert.equal(reopened.getCommandTiming('secrets import-conductor --file ' + f.sourcePath), undefined);
    } finally { reopened.close(); }
    assert.ok(!existsSync(f.statePath));
    if (outcome === 'source-error') assert.ok(!existsSync(f.target));
  });
}

for (const secrets of [{ lockWaitTimeoutMs: 0, pollIntervalMs: 1 }, { lockWaitTimeoutMs: 5, pollIntervalMs: 6 }]) {
  test(`secrets lock config is validated from explicit orchestrator root: ${JSON.stringify(secrets)}`, async t => {
    const f = await fixture(t);
    writeFileSync(join(f.conf, 'raf.json'), JSON.stringify({ ...settings, secrets }));
    failure(await f.run());
    assert.ok(!existsSync(f.target));
  });
}

test('production lock contention uses the explicit root budget before a foreign lock is released', async t => {
  const f = await fixture(t);
  const configPath = join(f.conf, 'raf.json');
  writeFileSync(configPath, JSON.stringify({ ...settings, secrets: { lockWaitTimeoutMs: 30, pollIntervalMs: 5 } }));
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const store = await openSecretsStore({ home: f.home, configPath, beforeReplace: async () => { entered(); await held; } });
  const writer = store.merge([{ name: 'LOCK_OWNER', kind: 'env', value: 'synthetic-holder', source: 'synthetic-test', updatedAt: updated }]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let attempt: Promise<ExecutionResult> | undefined;
  let observed: ExecutionResult | null = null;
  try {
    await Promise.race([reached, writer.then(() => { throw new Error('Writer completed without reaching the held critical section'); })]);
    attempt = f.run();
    observed = await Promise.race([attempt, new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 500); })]);
  } finally {
    if (deadline) clearTimeout(deadline);
    release();
    await writer;
    if (attempt) await attempt;
  }
  assert.ok(observed, 'Configured lock budget must expire while the foreign writer is held; module-root default must not override it');
  failure(observed, 'io-error');
  const inventory = await (await openSecretsStore({ home: f.home, configPath })).list();
  assert.deepEqual(inventory.map(record => record.name), ['LOCK_OWNER']);
});
