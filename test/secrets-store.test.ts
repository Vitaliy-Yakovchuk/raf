import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test, { type TestContext } from 'node:test';
import { openSecretsStore, SecretsStoreError, type SecretRecord, type SecretsStoreErrorCode } from '../src/secrets-store.ts';

const payload = 'SYNTHETIC_ONLY_ALPHA_payload_for_contract_fixture';
const fileBytes = Buffer.from([0, 255, 42, 10, 128, 65]);
const envRecord: SecretRecord = { kind: 'env', name: 'API_TOKEN', value: payload, source: 'synthetic-fixture', updatedAt: '2026-10-22T12:00:00Z' };
const fileRecord: SecretRecord = {
  kind: 'file', name: 'TOKEN_FILE', contentBase64: fileBytes.toString('base64'), source: 'synthetic-file-fixture', updatedAt: '2026-10-22T12:01:00Z',
  bindings: [{ projectPath: 'projects/raf', relativePath: '.local/token.bin', dotenvKey: 'ORIGINAL_TOKEN_PATH' }],
};

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'raf-secrets-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const directory = join(home, '.raf');
  const path = join(directory, 'secrets.json');
  return { root, home, directory, path };
}

function writeDocument(path: string, directory: string, document: unknown) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(document), { mode: 0o600 });
}

async function rejectsSafe(operation: () => Promise<unknown>, code: SecretsStoreErrorCode, forbidden = [payload, 'SYNTHETIC_ONLY_ALPHA', fileRecord.contentBase64]) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof SecretsStoreError);
    assert.equal(error.code, code);
    assert.ok(error.message.trim());
    assert.ok(error.remediation.trim());
    const diagnostic = `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 8 })}`;
    for (const secret of forbidden) assert.ok(!diagnostic.includes(secret), 'Diagnostic disclosed synthetic secret content');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const key of ['value', 'contentBase64', 'length', 'valueLength', 'payload']) assert.equal(Object.hasOwn(error, key), false);
    return true;
  });
}

test('explicit temporary home contains the only store and preserves env/file metadata and bytes', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ home: f.home });
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.merge([envRecord, fileRecord]), { added: ['API_TOKEN', 'TOKEN_FILE'], unchanged: [] });
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), { version: 1, records: [envRecord, fileRecord] });
  const reopened = await openSecretsStore({ path: f.path });
  assert.deepEqual(await reopened.list(), [
    { name: envRecord.name, kind: envRecord.kind, source: envRecord.source, updatedAt: envRecord.updatedAt },
    { name: fileRecord.name, kind: fileRecord.kind, source: fileRecord.source, updatedAt: fileRecord.updatedAt, bindings: fileRecord.bindings },
  ]);
  const selected = await reopened.select(['TOKEN_FILE']);
  assert.deepEqual(selected, { env: {}, files: [{ name: 'TOKEN_FILE', contentBase64: fileRecord.contentBase64, bindings: fileRecord.bindings }] });
  assert.deepEqual(Buffer.from(selected.files[0].contentBase64, 'base64'), fileBytes);
  assert.equal(existsSync(join(f.home, 'projects')), false);
});

test('explicit paths override home and separate stores never share records', async t => {
  const first = fixture(t);
  const second = fixture(t);
  const store = await openSecretsStore({ home: first.home, path: second.path });
  await store.merge([envRecord]);
  assert.equal(existsSync(first.directory), false);
  assert.equal(existsSync(second.path), true);
  const isolated = await openSecretsStore({ home: first.home });
  assert.deepEqual(await isolated.list(), []);
  assert.deepEqual(await isolated.select([]), { env: {}, files: [] });
});

test('directory target and temporary file have private permissions before atomic replacement', async t => {
  const f = fixture(t);
  const temporaryPaths: string[] = [];
  const store = await openSecretsStore({ path: f.path, beforeReplace: async ({ temporaryPath, targetPath }) => {
    assert.equal(targetPath, f.path);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(statSync(temporaryPath).mode & 0o777, 0o600);
    temporaryPaths.push(temporaryPath);
  } });
  await store.merge([envRecord]);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(temporaryPaths.length, 1);
  assert.equal(existsSync(temporaryPaths[0]), false);
  assert.deepEqual(readdirSync(f.directory), ['secrets.json']);
});

test('existing valid store permissions are tightened without changing secret records', async t => {
  const f = fixture(t);
  writeDocument(f.path, f.directory, { version: 1, records: [envRecord] });
  chmodSync(f.directory, 0o755);
  chmodSync(f.path, 0o644);
  const store = await openSecretsStore({ path: f.path });
  await store.merge([fileRecord]);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(await store.select(['API_TOKEN']), { env: { API_TOKEN: payload }, files: [] });
});

test('identical merge preserves bytes timestamps and does not invoke a replacement', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.path });
  await store.merge([envRecord]);
  const before = readFileSync(f.path);
  const mtime = statSync(f.path).mtimeMs;
  const repeated = await openSecretsStore({ path: f.path, beforeReplace: async () => { assert.fail('Identical merge must not replace file'); } });
  assert.deepEqual(await repeated.merge([{ ...envRecord }]), { added: [], unchanged: ['API_TOKEN'] });
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(statSync(f.path).mtimeMs, mtime);
});

test('conflicting payload or metadata rejects the whole merge without adding unrelated records', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.path });
  await store.merge([envRecord]);
  const before = readFileSync(f.path);
  for (const conflicting of [{ ...envRecord, value: 'SYNTHETIC_CONFLICT' }, { ...envRecord, source: 'another-source' }, { ...envRecord, updatedAt: '2026-10-23T12:00:00Z' }]) {
    await rejectsSafe(() => store.merge([fileRecord, conflicting]), 'conflict', [payload, 'SYNTHETIC_CONFLICT']);
    assert.deepEqual(readFileSync(f.path), before);
  }
});

test('fault before atomic rename preserves old bytes and cleans own temporary and lock resources', async t => {
  const f = fixture(t);
  const first = await openSecretsStore({ path: f.path });
  await first.merge([envRecord]);
  const before = readFileSync(f.path);
  writeFileSync(join(f.directory, 'unrelated-marker'), 'fixture marker', { mode: 0o600 });
  const broken = await openSecretsStore({ path: f.path, beforeReplace: async () => { throw new Error(payload); } });
  await rejectsSafe(() => broken.merge([fileRecord]), 'io-error');
  assert.deepEqual(readFileSync(f.path), before);
  assert.deepEqual(readdirSync(f.directory).sort(), ['secrets.json', 'unrelated-marker']);
  await first.merge([fileRecord]);
  assert.equal((await first.list()).length, 2);
});

test('concurrent handles serialize read-modify-write without losing either record', async t => {
  const f = fixture(t);
  const a = await openSecretsStore({ path: f.path });
  const b = await openSecretsStore({ path: f.path });
  await Promise.all([a.merge([envRecord]), b.merge([fileRecord])]);
  assert.deepEqual((await a.list()).map(row => row.name).sort(), ['API_TOKEN', 'TOKEN_FILE']);
  assert.deepEqual(readdirSync(f.directory), ['secrets.json']);
});

function childWriter(t: TestContext, script: string, path: string, name: string) {
  const child = spawn(process.execPath, [script, path, name], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  let stderr = '';
  const ready = Promise.withResolvers<void>();
  child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.includes('READY\n')) ready.resolve(); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', error => { ready.reject(error); reject(error); });
    child.once('exit', code => {
      if (code !== 0) { const error = new Error(`Synthetic writer exited ${code}: ${stderr}`); ready.reject(error); reject(error); }
      else resolve();
    });
  });
  void done.catch(() => {});
  return { ready: ready.promise, go: () => child.stdin.end('GO\n'), done, output: () => stdout + stderr };
}

test('independent processes hold a shared lock while merging different records', async t => {
  const f = fixture(t);
  const script = join(f.root, 'writer.mts');
  const moduleUrl = new URL('../src/secrets-store.ts', import.meta.url).href;
  writeFileSync(script, `import { openSecretsStore } from ${JSON.stringify(moduleUrl)};\nconst [path, name] = process.argv.slice(2);\nconst store = await openSecretsStore({ path });\nprocess.stdout.write('READY\\n');\nawait new Promise(resolve => process.stdin.once('data', resolve));\nawait store.merge([{kind:'env',name,value:'SYNTHETIC_PROCESS_'+name,source:'synthetic-process',updatedAt:'2026-10-22T12:00:00Z'}]);\nprocess.stdout.write('DONE\\n');\n`);
  const a = childWriter(t, script, f.path, 'FIRST');
  const b = childWriter(t, script, f.path, 'SECOND');
  await Promise.all([a.ready, b.ready]);
  a.go();
  b.go();
  await Promise.all([a.done, b.done]);
  const store = await openSecretsStore({ path: f.path });
  assert.deepEqual((await store.list()).map(row => row.name).sort(), ['FIRST', 'SECOND']);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory), ['secrets.json']);
  assert.doesNotMatch(a.output() + b.output(), /SYNTHETIC_PROCESS_/);
});

const invalidDocuments: { name: string; content: string; code: SecretsStoreErrorCode }[] = [
  { name: 'malformed JSON', content: `{"payload":"${payload}",`, code: 'invalid-store' },
  { name: 'unknown version', content: JSON.stringify({ version: 2, records: [envRecord] }), code: 'unsupported-version' },
  { name: 'unknown document field', content: JSON.stringify({ version: 1, records: [], secret: payload }), code: 'invalid-store' },
  { name: 'missing records', content: '{"version":1}', code: 'invalid-store' },
  { name: 'duplicate names', content: JSON.stringify({ version: 1, records: [envRecord, envRecord] }), code: 'invalid-store' },
  { name: 'unknown metadata', content: JSON.stringify({ version: 1, records: [{ ...envRecord, hidden: payload }] }), code: 'invalid-store' },
];

for (const invalid of invalidDocuments) {
  test(`${invalid.name} refuses open without fallback overwrite or payload diagnostics`, async t => {
    const f = fixture(t);
    mkdirSync(f.directory, { mode: 0o700 });
    writeFileSync(f.path, invalid.content, { mode: 0o600 });
    await rejectsSafe(() => openSecretsStore({ path: f.path }), invalid.code);
    assert.equal(readFileSync(f.path, 'utf8'), invalid.content);
    assert.deepEqual(readdirSync(f.directory), ['secrets.json']);
  });
}

const invalidRecords = [
  { ...envRecord, value: '' },
  { ...envRecord, value: `${payload}\u0000` },
  { ...envRecord, name: '' },
  { ...envRecord, source: '' },
  { ...envRecord, updatedAt: 'not-a-date' },
  { ...envRecord, expiresAt: '2026-10-22T12:00:00' },
  { ...envRecord, contentBase64: fileRecord.contentBase64 },
  { ...fileRecord, contentBase64: '' },
  { ...fileRecord, contentBase64: 'invalid-base64!' },
  { ...fileRecord, bindings: [{ projectPath: 'projects/raf', relativePath: '../escape' }] },
  { ...fileRecord, bindings: [{ projectPath: '/absolute', relativePath: 'token' }] },
  { ...fileRecord, bindings: [{ projectPath: 'projects/raf', relativePath: 'C:\\escape' }] },
  { ...fileRecord, bindings: [{ projectPath: 'projects/raf', relativePath: 'token', unknown: payload }] },
];

for (const [index, invalid] of invalidRecords.entries()) {
  test(`invalid synthetic record ${index} rejects the full batch before writing`, async t => {
    const f = fixture(t);
    const store = await openSecretsStore({ path: f.path });
    await store.merge([envRecord]);
    const before = readFileSync(f.path);
    await rejectsSafe(() => store.merge([{ ...envRecord, name: 'OTHER' }, invalid as SecretRecord]), 'invalid-record');
    assert.deepEqual(readFileSync(f.path), before);
  });
}

test('a target symlink refuses both open and later merge without touching its external referent', async t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside.json');
  writeFileSync(outside, 'synthetic outside sentinel', { mode: 0o600 });
  mkdirSync(f.directory, { mode: 0o700 });
  symlinkSync(outside, f.path);
  await rejectsSafe(() => openSecretsStore({ path: f.path }), 'unsafe-path');
  assert.equal(readFileSync(outside, 'utf8'), 'synthetic outside sentinel');
  rmSync(f.path);
  const store = await openSecretsStore({ path: f.path });
  await store.merge([envRecord]);
  rmSync(f.path);
  symlinkSync(outside, f.path);
  await rejectsSafe(() => store.merge([fileRecord]), 'unsafe-path');
  await rejectsSafe(() => store.select(['API_TOKEN']), 'unsafe-path');
  assert.equal(readFileSync(outside, 'utf8'), 'synthetic outside sentinel');
});

test('symlink in place of the private store directory is rejected', async t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside-directory');
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, f.directory);
  await rejectsSafe(() => openSecretsStore({ home: f.home }), 'unsafe-path');
  assert.deepEqual(readdirSync(outside), []);
});

test('selection is an explicit allowlist and never modifies global environment or creates bound files', async t => {
  const f = fixture(t);
  const beforeEnv = { ...process.env };
  const store = await openSecretsStore({ path: f.path });
  await store.merge([envRecord, fileRecord, { ...envRecord, name: 'UNRELATED', value: 'SYNTHETIC_UNRELATED' }]);
  assert.deepEqual(await store.select([]), { env: {}, files: [] });
  assert.deepEqual(await store.select(['API_TOKEN']), { env: { API_TOKEN: payload }, files: [] });
  const selection = await store.select(['TOKEN_FILE']);
  assert.deepEqual(selection.env, {});
  assert.deepEqual(selection.files.map(file => file.name), ['TOKEN_FILE']);
  const afterEnv = { ...process.env };
  const changedEnvKeys = [...new Set([...Object.keys(beforeEnv), ...Object.keys(afterEnv)])]
    .filter(key => Object.hasOwn(beforeEnv, key) !== Object.hasOwn(afterEnv, key) || beforeEnv[key] !== afterEnv[key])
    .sort();
  assert.deepEqual(changedEnvKeys, [], 'Global environment keys changed');
  assert.equal(existsSync(join(f.root, 'projects')), false);
  assert.equal(existsSync(join(f.home, 'projects')), false);
  await rejectsSafe(() => store.select(['API_TOKEN', 'ABSENT']), 'missing-secret');
});

test('expiry uses the supplied clock and unrelated expired credentials do not enter a selection', async t => {
  const f = fixture(t);
  let now = '2026-10-23T11:59:59Z';
  const store = await openSecretsStore({ path: f.path, now: () => now });
  const expiring = { ...envRecord, expiresAt: '2026-10-23T12:00:00Z' };
  await store.merge([expiring, fileRecord]);
  assert.deepEqual(await store.select(['API_TOKEN']), { env: { API_TOKEN: payload }, files: [] });
  now = '2026-10-23T12:00:00Z';
  await rejectsSafe(() => store.select(['API_TOKEN']), 'expired-secret');
  assert.equal((await store.select(['TOKEN_FILE'])).files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).records[0], expiring);
});

test('duplicate incoming names are rejected before any partial addition', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.path });
  await store.merge([fileRecord]);
  const before = readFileSync(f.path);
  await rejectsSafe(() => store.merge([envRecord, { ...envRecord }]), 'invalid-record');
  assert.deepEqual(readFileSync(f.path), before);
});

test('an existing handle revalidates a corrupted file instead of serving cached secrets', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.path });
  await store.merge([envRecord]);
  const malformed = `{"version":1,"value":"${payload}"`;
  writeFileSync(f.path, malformed, { mode: 0o600 });
  await rejectsSafe(() => store.select(['API_TOKEN']), 'invalid-store');
  await rejectsSafe(() => store.merge([fileRecord]), 'invalid-store');
  assert.equal(readFileSync(f.path, 'utf8'), malformed);
});

test('conductor metadata is preserved for env and file records without materializing legacy paths', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.path });
  const env = { ...envRecord, conductor: { path: 'worker/env/prod.vars', root: 'orchestrator' as const, key: 'ORIGINAL_TOKEN', expires: '2028-02-29' }, expiresAt: '2028-02-29T23:59:59.001Z' };
  const file = { ...fileRecord, name: 'legacy.file-token', conductor: { path: '/synthetic-only/no-materialization/token', mode: '640' } };
  await store.merge([env, file]);
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).records, [env, file]);
  const metadata = await store.list();
  assert.deepEqual((metadata.find(row => row.name === env.name) as unknown as { conductor: unknown }).conductor, env.conductor);
  assert.deepEqual((metadata.find(row => row.name === file.name) as unknown as { conductor: unknown }).conductor, file.conductor);
  assert.equal((await store.select(['legacy.file-token'])).files[0].name, 'legacy.file-token');
  assert.equal(existsSync(join(f.home, 'worker')), false);
});

test('conductor dotted env names are stored losslessly but selection refuses invalid environment names', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.path });
  const records = [{ ...envRecord, name: 'legacy.name' }, { ...envRecord, name: 'legacy-name' }];
  await store.merge([envRecord, ...records]);
  assert.deepEqual((await store.list()).map(row => row.name).sort(), ['API_TOKEN', 'legacy-name', 'legacy.name']);
  const beforeEnv = { ...process.env };
  for (const record of records) await rejectsSafe(() => store.select(['API_TOKEN', record.name]), 'invalid-record');
  const afterEnv = { ...process.env };
  const changedKeys = [...new Set([...Object.keys(beforeEnv), ...Object.keys(afterEnv)])]
    .filter(key => Object.hasOwn(beforeEnv, key) !== Object.hasOwn(afterEnv, key) || beforeEnv[key] !== afterEnv[key]).sort();
  assert.deepEqual(changedKeys, [], 'Global environment keys changed');
});

test('conductor unknown metadata is rejected without retaining a partial record', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.path });
  await store.merge([fileRecord]);
  const before = readFileSync(f.path);
  const invalid = { ...envRecord, conductor: { unknown: payload } };
  await rejectsSafe(() => store.merge([invalid]), 'invalid-record');
  assert.deepEqual(readFileSync(f.path), before);
});
