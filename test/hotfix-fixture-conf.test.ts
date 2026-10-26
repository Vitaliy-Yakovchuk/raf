import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CatalogGenerator } from '../src/catalog-generator.ts';
import { productionBindings } from '../src/production-bindings.ts';
import { fixture, timeoutMs } from './hotfix-fixture.ts';

const confSource = process.env.HOTFIX_FIXTURE_CONF ?? join(dirname(resolve(dirname(fileURLToPath(import.meta.url)), '..')), 'conf');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('[5.11.2] hotfix fixture builds the catalog from the current conf with every registered project', { timeout: timeoutMs }, async t => {
  const source = json(join(confSource, 'projects.json'));
  const isolated = await fixture(t);
  assert.ok(existsSync(join(isolated.main, 'dist', 'catalog.json')), 'fixture build must produce dist/catalog.json');
  const projects = json(join(isolated.root, 'conf', 'projects.json'));
  assert.deepEqual(Object.keys(projects.projects).sort(), Object.keys(source.projects).sort());
  assert.deepEqual(projects.projects.raf.branchPaths, { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' });
  const catalog = json(join(isolated.main, 'dist', 'catalog.json'));
  assert.deepEqual(catalog.commands.find((command: { path: string[] }) => command.path.join(' ') === 'test run').metadata.examples,
    json(join(confSource, 'raf-constants.json')).commands.find((command: { path: string[] }) => command.path.join(' ') === 'test run').examples);
});

test('[5.11.2] catalog still refuses an example with an unregistered project', { timeout: timeoutMs }, t => {
  const root = mkdtempSync(join(tmpdir(), 'hf-conf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const conf = join(root, 'conf');
  cpSync(confSource, conf, { recursive: true });
  const constantsPath = join(conf, 'raf-constants.json');
  const constants = json(constantsPath);
  const testRun = constants.commands.find((command: { path: string[] }) => command.path.join(' ') === 'test run');
  testRun.examples = [...testRun.examples, 'raf test run --project unregistered-5112 --phase main --group profile-raf-performance/module-origin-cost'];
  writeFileSync(constantsPath, JSON.stringify(constants));
  assert.throws(() => new CatalogGenerator().build({ confDirectory: conf, outputPath: join(root, 'catalog.json'), bindings: productionBindings() }), /examples\/\d+: INVALID_VALUE/);
  assert.equal(existsSync(join(root, 'catalog.json')), false);
});
