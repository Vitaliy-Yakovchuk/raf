import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCatalog } from '../src/catalog.ts';
import { openStateStore } from '../src/state-store.ts';

const execute = promisify(execFile);
const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8')));
const payload = 'QA_PRIVATE_ENV_f470b8';
const filePayload = 'QA_PRIVATE_FILE_c324ca\nключ';
const conflictPayload = 'QA_PRIVATE_CONFLICT_a315b3';
const updated = '2026-10-21T10:00:00.000Z';
const entry = (value: string) => ({ kind: 'env', value, source: 'synthetic-cli-qa', updated });

function fixture(t: { after(action: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-secrets-cli-qa-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'orchestrator');
  const checkout = join(root, 'raf-develop');
  const home = join(directory, 'home');
  mkdirSync(join(root, 'conf'), { recursive: true });
  mkdirSync(join(checkout, 'bin'), { recursive: true });
  mkdirSync(join(checkout, 'dist'));
  mkdirSync(home);
  cpSync(new URL('../src', import.meta.url), join(checkout, 'src'), { recursive: true });
  cpSync(new URL('../bin/raf.ts', import.meta.url), join(checkout, 'bin/raf.ts'));
  writeFileSync(join(checkout, 'package.json'), '{"type":"module"}');
  const configured = { ...settings, state: { ...settings.state, fileName: 'shared-cli-qa.sqlite' }, commandTiming: { ...settings.commandTiming, emaAlpha: 0.25 } };
  for (const [name, value] of [['raf.json', configured], ['models.json', models], ['raf-constants.json', constants]] as const) writeFileSync(join(root, 'conf', name), JSON.stringify(value));
  writeFileSync(join(checkout, 'dist/catalog.json'), JSON.stringify(catalog));
  const binding = join(directory, 'must-not-restore');
  const source = join(directory, 'synthetic-conductor.json');
  writeFileSync(source, JSON.stringify({ version: 1, secrets: { QA_ENV: entry(payload), QA_FILE: { ...entry(filePayload), kind: 'file', path: binding, mode: '600' } } }));
  const target = join(home, '.raf/secrets.json');
  const state = join(home, '.raf', configured.state.fileName);
  async function run(args = ['secrets', 'import-conductor', '--file', source]) {
    let result: { stdout: string; stderr: string; code: number };
    try {
      const output = await execute(process.execPath, [join(checkout, 'bin/raf.ts'), ...args], {
        cwd: directory, env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576,
      });
      result = { ...output, code: 0 };
    } catch (error) {
      const failure = error as Error & { code: number; signal: string | null; killed: boolean; stdout: string; stderr: string };
      assert.equal(failure.killed, false, 'CLI must finish before the explicit subprocess deadline');
      assert.equal(failure.signal, null);
      assert.equal(typeof failure.code, 'number');
      result = { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
    }
    for (const value of [payload, filePayload, 'QA_PRIVATE_FILE_c324ca', conflictPayload, Buffer.from(filePayload).toString('base64')]) assert.ok(!(result.stdout + result.stderr).includes(value), 'CLI output must omit secret payloads');
    return result;
  }
  return { directory, root, home, source, target, state, binding, run };
}

function success(result: { code: number; stdout: string; stderr: string }) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function failure(result: { code: number; stdout: string; stderr: string }, code: string) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1)!);
  assert.equal(error.details.sourceCode, code);
  assert.ok(error.remediation);
}

test('real CLI imports, preserves identical bytes, repairs permissions and records configured shared EMA without payloads', { timeout: 35_000 }, async t => {
  const f = fixture(t);
  const sourceBefore = readFileSync(f.source);
  const store = openStateStore(f.state);
  store.recordCommandDuration('secrets import-conductor', 1_000_000, 0.25);
  store.close();
  assert.deepEqual(success(await f.run()), { added: ['QA_ENV', 'QA_FILE'], unchanged: [] });
  const before = readFileSync(f.target);
  const modifiedAt = statSync(f.target).mtimeMs;
  const records = JSON.parse(before.toString()).records;
  assert.equal(records.find((record: any) => record.name === 'QA_ENV').value, payload);
  assert.equal(records.find((record: any) => record.name === 'QA_FILE').contentBase64, Buffer.from(filePayload).toString('base64'));
  chmodSync(join(f.home, '.raf'), 0o755);
  chmodSync(f.target, 0o644);
  assert.deepEqual(success(await f.run()), { added: [], unchanged: ['QA_ENV', 'QA_FILE'] });
  assert.deepEqual(readFileSync(f.target), before);
  assert.equal(statSync(f.target).mtimeMs, modifiedAt);
  assert.equal(statSync(join(f.home, '.raf')).mode & 0o777, 0o700);
  assert.equal(statSync(f.target).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(f.source), sourceBefore);
  assert.ok(!existsSync(f.binding));
  success(await f.run(['command', 'stats']));
  const reopened = openStateStore(f.state);
  try {
    const timing = reopened.getCommandTiming('secrets import-conductor')!;
    assert.ok(timing.averageMs >= 562_500 && timing.averageMs < 570_000, 'Two subprocess samples must update the seeded EMA with configured alpha');
    assert.ok(reopened.getCommandTiming('command stats'));
    assert.equal(reopened.getCommandTiming('secrets import-conductor --file ' + f.source), undefined);
  } finally { reopened.close(); }
  assert.ok(!existsSync(join(f.home, '.raf', settings.state.fileName)));
  for (const value of [payload, filePayload, Buffer.from(filePayload).toString('base64')]) assert.ok(!readFileSync(f.state).includes(Buffer.from(value)));
});

test('real CLI conflict and malformed JSON fail without partial writes or changing source', { timeout: 35_000 }, async t => {
  const f = fixture(t);
  success(await f.run());
  const before = readFileSync(f.target);
  for (const [source, code] of [
    [JSON.stringify({ version: 1, secrets: { NEW_KEY: entry('synthetic-new'), QA_ENV: entry(conflictPayload) } }), 'conflict'],
    ['{"secret":"' + payload, 'malformed-source'],
  ]) {
    writeFileSync(f.source, source);
    failure(await f.run(), code);
    assert.equal(readFileSync(f.source, 'utf8'), source);
    assert.deepEqual(readFileSync(f.target), before);
  }
});

test('real concurrent CLI imports preserve both independent additions', { timeout: 25_000 }, async t => {
  const f = fixture(t);
  const second = join(f.directory, 'second-synthetic.json');
  writeFileSync(second, JSON.stringify({ version: 1, secrets: { SECOND_KEY: entry('synthetic-second') } }));
  const results = await Promise.all([f.run(), f.run(['secrets', 'import-conductor', '--file', second])]);
  results.forEach(success);
  assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')).records.map((record: any) => record.name).sort(), ['QA_ENV', 'QA_FILE', 'SECOND_KEY']);
});
