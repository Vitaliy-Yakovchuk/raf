import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { TestRunProfile } from '../src/test-runs.ts';

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const existing = 'scripts/node-digest.test.mjs';
const excluded = 'scripts/real-process.test.mjs';
const added = 'scripts/new-unit.test.mjs';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'raf-hotfix-6310-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceHashes: Record<string, string> = {};
  const write = (file: string, source: string) => {
    fs.mkdirSync(dirname(join(root, file)), { recursive: true });
    fs.writeFileSync(join(root, file), source);
  };
  const audited = (file: string, source: string) => {
    write(file, source);
    sourceHashes[file] = digest(source);
  };
  for (const name of ['app', 'worker']) audited(`${name}/vitest.config.ts`, 'const files = testProjectFiles(root, [], {}, selectedTestFiles(root));');
  for (const name of ['assessment', 'domain', 'i18n', 'markdown', 'ui-core']) audited(`shared/${name}/vitest.config.ts`, 'export default { test: { include: ["src/**/*.test.ts"] } };');
  audited('test-support/vitest-project-files.ts', 'export const testProjectFiles = () => ({ unit: [], integration: [] });');
  write(existing, 'original unit body');
  write(excluded, 'original process body');
  const audit = {
    sourceHashes,
    nodeDecisions: [
      { file: existing, classification: 'unit', sha256: digest('original unit body') },
      { file: excluded, classification: 'excluded', sha256: digest('original process body') },
    ],
  };
  const readFile = fs.readFileSync;
  const mockedRead = t.mock.method(fs, 'readFileSync', ((file: any, ...args: any[]) => {
    if (file instanceof URL && file.pathname.endsWith('/src/test-run-etchly-audit.json')) return JSON.stringify(audit);
    return (readFile as any)(file, ...args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  let observe: typeof import('../src/test-run-etchly-inventory.ts').observeEtchlyInventory;
  try {
    ({ observeEtchlyInventory: observe } = await import(`../src/test-run-etchly-inventory.ts?fixture=${randomUUID()}`));
  } finally {
    mockedRead.mock.restore();
    syncBuiltinESMExports();
  }
  const profile = { unitFiles: [existing] } as TestRunProfile;
  return { root, write, profile, observe: () => observe(root, { 'node-root': profile }) };
}

test('registered new Node candidate passes inventory without an embedded decision', async t => {
  const f = await fixture(t);
  f.write(added, 'new unit body');
  f.profile.unitFiles!.push(added);
  const facts = await f.observe();
  assert.deepEqual(facts.find(fact => fact.file === added), { file: added, classification: 'unit', profileId: 'node-root' });
});

test('changed registered Node test passes inventory without refreshing its digest', async t => {
  const f = await fixture(t);
  f.write(existing, 'changed unit body');
  assert.equal((await f.observe()).find(fact => fact.file === existing)?.classification, 'unit');
});

test('conf registration takes precedence over an old excluded Node decision', async t => {
  const f = await fixture(t);
  f.profile.unitFiles!.push(excluded);
  assert.deepEqual((await f.observe()).find(fact => fact.file === excluded), { file: excluded, classification: 'unit', profileId: 'node-root' });
});

test('changed known excluded Node candidate remains excluded without a digest check', async t => {
  const f = await fixture(t);
  f.write(excluded, 'changed process body');
  assert.deepEqual((await f.observe()).find(fact => fact.file === excluded), { file: excluded, classification: 'excluded', profileId: null });
});

test('new unregistered Node candidate still refuses inventory with its path and conf address', async t => {
  const f = await fixture(t);
  f.write(added, 'new unit body');
  await assert.rejects(f.observe, (error: any) => {
    assert.equal(error.code, 'INVENTORY_INCOMPLETE');
    assert.ok(error.message.includes(added));
    assert.match(error.message, /conf\/test-runs\.json/);
    return true;
  });
});

test('previously registered Node unit removed from conf still refuses inventory', async t => {
  const f = await fixture(t);
  f.profile.unitFiles = [];
  await assert.rejects(f.observe, { code: 'INVENTORY_INCOMPLETE' });
});

test('changed classifier source still refuses inventory', async t => {
  const f = await fixture(t);
  f.write('app/vitest.config.ts', 'changed classification');
  await assert.rejects(f.observe, { code: 'INVENTORY_INCOMPLETE' });
});
