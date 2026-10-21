import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSecretsStore } from '../src/secrets-store.ts';

const moduleUrl = new URL('../src/secrets-store.ts', import.meta.url).href;
const record = (name: string) => ({ name, kind: 'env' as const, value: `synthetic-private-${name}`, source: 'qa-fixture', updatedAt: '2026-10-22T00:00:00.000Z' });

for (const lockContents of ['original', 'empty', 'corrupt']) test(`QA: SIGKILL before replacement preserves private data and next writer fails explicitly (${lockContents} lock)`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'raf-secrets-kill-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'private', 'secrets.json');
  const store = await openSecretsStore({ path });
  await store.merge([record('COMMITTED')]);
  const before = await readFile(path, 'utf8');
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
import { openSecretsStore } from ${JSON.stringify(moduleUrl)};
const store = await openSecretsStore({ path: ${JSON.stringify(path)}, beforeReplace: async () => { process.send('ready'); await new Promise(() => { setInterval(() => {}, 1000); }); } });
await store.merge([${JSON.stringify(record('INTERRUPTED'))}]);
`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL'); });
  const [message] = await once(writer, 'message');
  assert.equal(message, 'ready');
  const exited = once(writer, 'exit');
  writer.kill('SIGKILL');
  await exited;
  if (lockContents !== 'original') await writeFile(`${path}.lock`, lockContents === 'empty' ? '' : 'synthetic-corrupt-lock');
  assert.equal(await readFile(path, 'utf8'), before);
  const privateDirectory = join(root, 'private');
  assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
  for (const name of await readdir(privateDirectory)) assert.equal((await stat(join(privateDirectory, name))).mode & 0o777, 0o600);
  const successor = spawn(process.execPath, ['--input-type=module', '-e', `
import { openSecretsStore } from ${JSON.stringify(moduleUrl)};
try { const store = await openSecretsStore({ path: ${JSON.stringify(path)} }); await store.merge([${JSON.stringify(record('NEXT'))}]); console.log(JSON.stringify({ accepted: true })); }
catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message, remediation: error.remediation })); }
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  successor.stdout.on('data', data => output += data);
  successor.stderr.on('data', data => errors += data);
  const timer = setTimeout(() => successor.kill('SIGKILL'), 1500);
  const [code, signal] = await once(successor, 'exit');
  clearTimeout(timer);
  assert.equal(signal, null, 'successor must report blocked stale lock before external deadline');
  assert.equal(code, 0, errors);
  assert.equal(JSON.parse(output).code, 'io-error');
  assert.match(JSON.parse(output).message, /lock wait expired/);
  for (const name of ['COMMITTED', 'INTERRUPTED', 'NEXT']) assert.equal((output + errors).includes(record(name).value), false);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual((await store.list()).map(row => row.name), ['COMMITTED']);
});
