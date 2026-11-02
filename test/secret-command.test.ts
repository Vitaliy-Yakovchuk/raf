import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { openSecretsStore } from '../src/secrets-store.ts';
import { execute } from '../src/cli.ts';
import { CatalogGenerator } from '../src/catalog-generator.ts';
import { productionBindings } from '../src/production-bindings.ts';

const value = 'SYNTHETIC_arsc_private_value_123';
const second = 'SYNTHETIC_arsc_replacement_456';
const record = (value: string) => ({ name: 'API_TOKEN', kind: 'env' as const, value, source: 'owner', updatedAt: '2026-11-02T12:00:00Z' });
function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'raf-secret-command-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, path: join(home, '.raf/secrets.json') };
}
async function commandModule() {
  assert.ok(existsSync(new URL('../src/secret-cli.ts', import.meta.url)), 'secret CLI handler must exist');
  return import('../src/secret-cli.ts');
}
function catalog() {
  const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  return new CatalogGenerator().compile({ constants, models: JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8')), projects: JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8')) }, productionBindings());
}

test('set adds, refuses existing names, replaces and preserves identical values without rewriting', async t => {
  const f = fixture(t);
  const store = await openSecretsStore({ home: f.home });
  assert.equal(typeof store.set, 'function', 'store must support locked set');
  assert.deepEqual(await store.set(record(value)), { name: 'API_TOKEN', action: 'added' });
  const before = readFileSync(f.path, 'utf8');
  await assert.rejects(store.set(record(value)), { code: 'conflict' });
  await assert.rejects(store.set(record(second)), { code: 'conflict' });
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.deepEqual(await store.set(record(second), true), { name: 'API_TOKEN', action: 'replaced' });
  const unchanged = readFileSync(f.path, 'utf8');
  assert.deepEqual(await store.set({ ...record(second), updatedAt: '2026-11-02T13:00:00Z' }, true), { name: 'API_TOKEN', action: 'unchanged' });
  assert.equal(readFileSync(f.path, 'utf8'), unchanged);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(f.home, '.raf')), ['secrets.json']);
});

test('independent writers serialize conflict checks and preserve unrelated records', async t => {
  const f = fixture(t);
  const a = await openSecretsStore({ home: f.home });
  const b = await openSecretsStore({ home: f.home });
  assert.equal(typeof a.set, 'function');
  const outcomes = await Promise.allSettled([a.set(record(value)), b.set(record(second))]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected')?.reason.code, 'conflict');
  await b.merge([{ ...record(value), name: 'OTHER_TOKEN' }]);
  await a.set(record(second), true);
  assert.deepEqual((await b.list()).map(r => r.name).sort(), ['API_TOKEN', 'OTHER_TOKEN']);
});

test('failed atomic replacement keeps original bytes and sanitizes diagnostics', async t => {
  const f = fixture(t);
  const a = await openSecretsStore({ home: f.home });
  await a.merge([record(value)]);
  const before = readFileSync(f.path, 'utf8');
  const b = await openSecretsStore({ home: f.home, beforeReplace: async () => { throw new Error(second); } });
  assert.equal(typeof b.set, 'function');
  await assert.rejects(b.set(record(second), true), error => {
    assert.equal(error.code, 'io-error');
    assert.ok(!String(error).includes(second));
    assert.ok(!JSON.stringify(error).includes(second));
    return true;
  });
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.deepEqual(readdirSync(join(f.home, '.raf')), ['secrets.json']);
});

test('CLI reads stdin, prints only actions and metadata, and never discloses values on conflict or invalid input', async t => {
  const f = fixture(t);
  const { createSecretHandlers } = await commandModule();
  const c = catalog();
  const run = (args: string[], input = value + '\n') => execute(args, c, createSecretHandlers({ home: f.home, input: Readable.from([input]) }));
  let r = await run(['secret', 'set', '--name', 'API_TOKEN', '--source', 'owner']);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { name: 'API_TOKEN', action: 'added' });
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).records[0].value, value);
  for (const [args, input, action] of [
    [['secret', 'set', '--name', 'API_TOKEN'], second, 'conflict'],
    [['secret', 'set', '--name', 'API_TOKEN', '--replace'], second + '\r\n', 'replaced'],
    [['secret', 'set', '--name', 'API_TOKEN', '--replace'], second, 'unchanged'],
    [['secret', 'set', '--name', 'BAD NAME'], value, 'invalid-record'],
    [['secret', 'set', '--name', 'EMPTY'], '', 'invalid-record'],
    [['secret', 'set', '--name', 'NULL'], value + '\0', 'invalid-record'],
  ] as const) {
    r = await run([...args], input);
    if (['replaced', 'unchanged'].includes(action)) { assert.equal(r.exitCode, 0, r.stderr); assert.equal(JSON.parse(r.stdout).action, action); }
    else { assert.notEqual(r.exitCode, 0); assert.equal(JSON.parse(r.stderr).details.sourceCode, action); }
    for (const secret of [value, second]) assert.ok(!(r.stdout + r.stderr).includes(secret));
  }
  const store = await openSecretsStore({ home: f.home });
  await store.merge([{ name: 'FILE', kind: 'file', contentBase64: Buffer.from(value).toString('base64'), source: 'fixture', updatedAt: record(value).updatedAt }]);
  r = await run(['secret', 'list']);
  assert.equal(r.exitCode, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['kind', 'name', 'source', 'updatedAt']);
  for (const secret of [value, second, Buffer.from(value).toString('base64')]) assert.ok(!(r.stdout + r.stderr).includes(secret));
  r = await run(['secret', 'set', '--name', 'X', '--value', value]);
  assert.notEqual(r.exitCode, 0);
  assert.ok(!(r.stdout + r.stderr).includes(value));
});

test('TTY input is hidden and raw mode is restored on completion and cancellation', async () => {
  const { readSecretValue } = await commandModule();
  for (const cancelled of [false, true]) {
    const input = new Readable({ read() {} });
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (raw: boolean) => { input.isRaw = raw; return input; };
    const captured: string[] = [];
    const output = new Writable({ write(chunk, encoding, done) { captured.push(chunk.toString()); done(); } });
    const pending = readSecretValue(input, output);
    const checked = cancelled ? assert.rejects(pending) : pending;
    input.push(cancelled ? value + '\u0003' : value + '\r');
    if (!cancelled) assert.equal(await checked, value); else await checked;
    assert.ok(!captured.join('').includes(value));
    assert.equal(input.isRaw, false);
    input.destroy();
  }
});

test('catalog and help expose secret commands with no value argument', async () => {
  const c = catalog();
  for (const verb of ['set', 'list']) {
    const command = c.commands.find(row => row.handlerName === `secret ${verb}`);
    assert.ok(command, `secret ${verb} is in conf catalog`);
    const help = await execute(['help', 'secret', verb], c, {});
    assert.equal(help.exitCode, 0, help.stderr);
    assert.equal(JSON.parse(help.stdout).commands.length, 1);
    assert.ok(!command.parameters.some(p => p.name === 'value'));
  }
});

test('production CLI dispatch stores stdin in its isolated home and lists no values without starting the service', async t => {
  const { cliFixture } = await import('./reminder-fixture.ts');
  const f = await cliFixture(t);
  t.mock.method(process.stdin, Symbol.asyncIterator, async function* () { yield value + '\n'; });
  const added = await f.run(['secret', 'set', '--name', 'PRODUCTION_TOKEN']);
  assert.equal(added.exitCode, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout), { name: 'PRODUCTION_TOKEN', action: 'added' });
  assert.equal(JSON.parse(readFileSync(join(f.home, '.raf/secrets.json'), 'utf8')).records[0].value, value);
  const listed = await f.run(['secret', 'list']);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout)[0].name, 'PRODUCTION_TOKEN');
  assert.ok(!(added.stdout + added.stderr + listed.stdout + listed.stderr).includes(value));
  assert.equal(f.serviceTouched(), false);
});
