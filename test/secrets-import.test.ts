import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test, { type TestContext } from 'node:test';
import { importConductorSecrets, parseConductorSecrets, SecretsImportError, type ImportedSecretRecord, type SecretsImportErrorCode } from '../src/secrets-import.ts';
import { openSecretsStore, SecretsStoreError } from '../src/secrets-store.ts';

const synthetic = 'SYNTHETIC_IMPORT_ONLY_альфа\nsecond line';
const entry = { kind: 'env', value: synthetic, source: 'synthetic-origin', updated: '2026-10-22T12:00:00+00:00' };
const source = {
  version: 1,
  secrets: {
    API_TOKEN: { ...entry },
    PROD_TOKEN: { ...entry, path: 'worker/env/prod.vars', root: 'orchestrator', key: 'ORIGINAL_TOKEN', expires: '2028-02-29' },
    'token.file': { kind: 'file', value: 'SYNTHETIC_FILE_ONLY_ї\r\n', path: '.config/tool/token', mode: '640', source: 'synthetic-file', updated: '2026-10-22T12:01:00Z' },
    PROJECT_FILE: { kind: 'file', value: 'SYNTHETIC_PROJECT_FILE\n', path: 'worker/env/stage.vars', root: 'orchestrator', key: 'FILE_SOURCE', mode: '600', source: 'synthetic-project', updated: '2026-10-22T12:02:00Z', expires: '2026-12-31' },
    ABSOLUTE_FILE: { kind: 'file', value: 'SYNTHETIC_ABSOLUTE_FILE', path: '/synthetic-only/not-materialized/token', source: '$(synthetic-never-executed)', updated: '2026-10-22T12:03:00Z' },
  },
};

const expected: readonly ImportedSecretRecord[] = [
  { name: 'API_TOKEN', kind: 'env', value: synthetic, source: entry.source, updatedAt: entry.updated },
  { name: 'PROD_TOKEN', kind: 'env', value: synthetic, source: entry.source, updatedAt: entry.updated, expiresAt: '2028-02-29T23:59:59.001Z', conductor: { path: 'worker/env/prod.vars', root: 'orchestrator', key: 'ORIGINAL_TOKEN', expires: '2028-02-29' } },
  { name: 'token.file', kind: 'file', contentBase64: Buffer.from(source.secrets['token.file'].value, 'utf8').toString('base64'), source: 'synthetic-file', updatedAt: '2026-10-22T12:01:00Z', conductor: { path: '.config/tool/token', mode: '640' } },
  { name: 'PROJECT_FILE', kind: 'file', contentBase64: Buffer.from(source.secrets.PROJECT_FILE.value, 'utf8').toString('base64'), source: 'synthetic-project', updatedAt: '2026-10-22T12:02:00Z', expiresAt: '2026-12-31T23:59:59.001Z', conductor: { path: 'worker/env/stage.vars', root: 'orchestrator', key: 'FILE_SOURCE', mode: '600', expires: '2026-12-31' } },
  { name: 'ABSOLUTE_FILE', kind: 'file', contentBase64: Buffer.from(source.secrets.ABSOLUTE_FILE.value, 'utf8').toString('base64'), source: '$(synthetic-never-executed)', updatedAt: '2026-10-22T12:03:00Z', conductor: { path: '/synthetic-only/not-materialized/token' } },
];

function byName(records: readonly ImportedSecretRecord[]) {
  return [...records].sort((a, b) => a.name.localeCompare(b.name));
}

function assertSafe(error: unknown, code: SecretsImportErrorCode) {
  assert.ok(error instanceof SecretsImportError);
  assert.equal(error.code, code);
  assert.ok(error.message.trim());
  assert.ok(error.remediation.trim());
  const rendered = `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 5 })}`;
  assert.doesNotMatch(rendered, /SYNTHETIC_IMPORT_ONLY|SYNTHETIC_FILE_ONLY|SYNTHETIC_UNKNOWN_FIELD/);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-secrets-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const incoming = join(root, 'synthetic-conductor.json');
  const directory = join(root, 'raf');
  mkdirSync(directory, { mode: 0o700 });
  const target = join(directory, 'secrets.json');
  writeFileSync(incoming, JSON.stringify(source), { mode: 0o600 });
  return { incoming, target };
}

test('complete conductor env and file metadata maps without losing fields or changing payload text', () => {
  assert.deepEqual(byName(parseConductorSecrets(JSON.stringify(source))), byName(expected));
});

test('conductor dotted and hyphenated names are preserved rather than silently renamed', () => {
  const records = parseConductorSecrets(JSON.stringify({ version: 1, secrets: { 'legacy.name': entry, 'legacy-name': entry } }));
  assert.deepEqual(records.map(record => record.name).sort(), ['legacy-name', 'legacy.name']);
});

test('expiry conversion exactly preserves the original UTC millisecond cutoff', () => {
  const record = parseConductorSecrets(JSON.stringify({ version: 1, secrets: { TOKEN: { ...entry, expires: '2028-02-29' } } }))[0];
  const oldBoundary = Date.parse('2028-02-29T23:59:59Z');
  const newBoundary = Date.parse(record.expiresAt!);
  for (const delta of [-1, 0, 1, 999, 1000]) assert.equal(oldBoundary + delta > oldBoundary, oldBoundary + delta >= newBoundary);
  assert.equal(record.conductor?.expires, '2028-02-29');
});

test('import reads one explicitly requested source and submits exactly one complete merge', async () => {
  const reads: string[] = [];
  const batches: (readonly ImportedSecretRecord[])[] = [];
  const result = await importConductorSecrets({ file: '/synthetic-only/input.json' }, {
    readText: async path => { reads.push(path); return JSON.stringify(source); },
    store: { merge: async records => { batches.push(records); return { added: records.map(record => record.name), unchanged: [] }; } },
  });
  assert.deepEqual(reads, ['/synthetic-only/input.json']);
  assert.equal(batches.length, 1);
  assert.deepEqual(byName(batches[0]), byName(expected));
  assert.deepEqual([...result.added].sort(), expected.map(record => record.name).sort());
  assert.deepEqual(result.unchanged, []);
  assert.deepEqual(Object.keys(result).sort(), ['added', 'unchanged']);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_/);
});

test('repeated import leaves source target bytes and original update times unchanged', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.target });
  const ports = { readText: async (path: string) => readFileSync(path, 'utf8'), store };
  const sourceBefore = readFileSync(f.incoming);
  await importConductorSecrets({ file: f.incoming }, ports);
  const targetBefore = readFileSync(f.target);
  const repeated = await importConductorSecrets({ file: f.incoming }, ports);
  assert.deepEqual(repeated.added, []);
  assert.deepEqual([...repeated.unchanged].sort(), expected.map(record => record.name).sort());
  assert.deepEqual(readFileSync(f.target), targetBefore);
  assert.deepEqual(readFileSync(f.incoming), sourceBefore);
  assert.deepEqual(byName(JSON.parse(targetBefore.toString()).records), byName(expected));
});

for (const conflict of [{ value: 'SYNTHETIC_CONFLICT' }, { source: 'different-source' }, { updated: '2026-10-23T12:00:00Z' }]) {
  test(`existing record conflict in ${Object.keys(conflict)[0]} rejects all additions`, async t => {
    const f = fixture(t);
    const store = await openSecretsStore({ path: f.target });
    await store.merge([expected[0]]);
    const before = readFileSync(f.target);
    const document = { version: 1, secrets: { NEW: entry, API_TOKEN: { ...entry, ...conflict } } };
    await assert.rejects(importConductorSecrets({ file: f.incoming }, { readText: async () => JSON.stringify(document), store }), error => {
      assert.ok(error instanceof SecretsStoreError);
      assert.equal(error.code, 'conflict');
      assert.doesNotMatch(inspect(error), /SYNTHETIC_/);
      return true;
    });
    assert.deepEqual(readFileSync(f.target), before);
  });
}

test('conflicting legacy file mode is metadata conflict rather than silent overwrite', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ path: f.target });
  await importConductorSecrets({ file: f.incoming }, { readText: async () => JSON.stringify(source), store });
  const before = readFileSync(f.target);
  const modified = structuredClone(source);
  modified.secrets['token.file'].mode = '600';
  await assert.rejects(importConductorSecrets({ file: f.incoming }, { readText: async () => JSON.stringify(modified), store }), error => error instanceof SecretsStoreError && error.code === 'conflict');
  assert.deepEqual(readFileSync(f.target), before);
});

const invalidSources: { label: string; content: string; code: SecretsImportErrorCode }[] = [
  { label: 'malformed JSON', content: `{"SYNTHETIC_IMPORT_ONLY":`, code: 'malformed-source' },
  { label: 'array root', content: '[]', code: 'malformed-source' },
  { label: 'missing secrets', content: '{"version":1}', code: 'malformed-source' },
  { label: 'array secrets', content: '{"version":1,"secrets":[]}', code: 'malformed-source' },
  { label: 'unknown version', content: JSON.stringify({ ...source, version: 2 }), code: 'unsupported-version' },
  { label: 'string version', content: JSON.stringify({ ...source, version: '1' }), code: 'unsupported-version' },
  { label: 'unknown root field', content: JSON.stringify({ ...source, SYNTHETIC_UNKNOWN_FIELD: synthetic }), code: 'unsupported-metadata' },
  { label: 'unknown entry field', content: JSON.stringify({ version: 1, secrets: { VALID: entry, BAD: { ...entry, SYNTHETIC_UNKNOWN_FIELD: synthetic } } }), code: 'unsupported-metadata' },
];

for (const invalid of invalidSources) {
  test(`${invalid.label} rejects before merge with no source values in diagnostics`, async () => {
    let calls = 0;
    await assert.rejects(importConductorSecrets({ file: '/synthetic-only/input.json' }, {
      readText: async () => invalid.content,
      store: { merge: async () => { calls++; return { added: [], unchanged: [] }; } },
    }), error => assertSafe(error, invalid.code));
    assert.equal(calls, 0);
  });
}

const invalidEntries = [
  { ...entry, kind: 'command' },
  { ...entry, value: '' },
  { ...entry, value: `${synthetic}\u0000` },
  { ...entry, source: '' },
  { ...entry, updated: 'invalid' },
  { ...entry, expires: '2027-02-29' },
  { ...entry, expires: '2026-13-01' },
  { ...entry, expires: '2026-10-22T00:00:00Z' },
  { ...entry, path: 'worker/env/prod.vars' },
  { ...entry, path: 'worker/env/prod.vars', root: 'other-root', key: 'TOKEN' },
  { ...source.secrets['token.file'], mode: '888' },
  { ...source.secrets['token.file'], path: '../outside' },
  { ...source.secrets['token.file'], path: '/synthetic/../outside' },
  { ...source.secrets['token.file'], path: 'C:\\synthetic\\token' },
  { ...source.secrets['token.file'], value: '\ud800' },
  { ...source.secrets['token.file'], root: 'orchestrator', path: '/absolute' },
];

for (const [index, invalid] of invalidEntries.entries()) {
  test(`invalid trailing record ${index} prevents partial merge of preceding valid entries`, async () => {
    let calls = 0;
    await assert.rejects(importConductorSecrets({ file: '/synthetic-only/input.json' }, {
      readText: async () => JSON.stringify({ version: 1, secrets: { VALID_FIRST: entry, INVALID_LAST: invalid } }),
      store: { merge: async () => { calls++; return { added: [], unchanged: [] }; } },
    }), error => assertSafe(error, 'invalid-record'));
    assert.equal(calls, 0);
  });
}

test('read failure is sanitized and never triggers another source or merge', async () => {
  const reads: string[] = [];
  let calls = 0;
  await assert.rejects(importConductorSecrets({ file: '/synthetic-only/input.json' }, {
    readText: async path => { reads.push(path); throw new Error(synthetic); },
    store: { merge: async () => { calls++; return { added: [], unchanged: [] }; } },
  }), error => assertSafe(error, 'source-unavailable'));
  assert.deepEqual(reads, ['/synthetic-only/input.json']);
  assert.equal(calls, 0);
});

test('empty legacy store imports an empty batch without inventing metadata or credentials', async () => {
  const batches: (readonly ImportedSecretRecord[])[] = [];
  const result = await importConductorSecrets({ file: 'synthetic-relative-source.json' }, {
    readText: async () => '{"version":1,"secrets":{}}',
    store: { merge: async records => { batches.push(records); return { added: [], unchanged: [] }; } },
  });
  assert.deepEqual(batches, [[]]);
  assert.deepEqual(result, { added: [], unchanged: [] });
});
