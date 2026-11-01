import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/bootstrap.ts';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-missing-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const conf = join(root, 'conf');
  mkdirSync(home);
  mkdirSync(conf);
  for (const name of ['projects', 'raf-constants', 'models', 'raf']) {
    cpSync(new URL(`../../conf/${name}.json`, import.meta.url), join(conf, `${name}.json`));
  }
  await prepareProductionQaFixture(t, { root, home });
  const projects = JSON.parse(readFileSync(join(conf, 'projects.json'), 'utf8'));
  const app = join(root, projects.projects.raf.branchPaths.develop);
  const artifactPath = join(app, 'dist/catalog.json');
  const environment = { ...process.env, HOME: home, RAF_QA_HOME: home, RAF_ORCHESTRATOR_ROOT: root, NODE_NO_WARNINGS: '1' };
  const build = spawnSync(process.execPath, [join(app, 'scripts/build.ts')], { cwd: app, env: environment, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const builtCatalog = readFileSync(artifactPath, 'utf8');
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [join(app, 'bin/raf.ts'), ...args], { cwd: app, env: environment, encoding: 'utf8' });
    assert.ifError(result.error);
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { app, conf, artifactPath, builtCatalog, run };
}

for (const args of [['help'], ['agent', 'ps']]) {
  test(`missing dist catalog: ${args.join(' ')} matches a built copy and regenerates the same artifact`, async t => {
    const f = await fixture(t);
    const built = f.run(args);
    assert.equal(built.code, 0, built.stderr);
    rmSync(join(f.app, 'dist'), { recursive: true });
    const unbuilt = f.run(args);
    assert.equal(unbuilt.code, 0, unbuilt.stderr);
    assert.equal(unbuilt.stdout, built.stdout);
    assert.equal(unbuilt.stderr, built.stderr);
    assert.equal(readFileSync(f.artifactPath, 'utf8'), f.builtCatalog);
  });
}

test('bootstrap with missing catalog runs its handler using the same generated build artifact', async t => {
  const f = await fixture(t);
  const handlers = { 'agent ps': () => [] };
  const built = await runCli(['agent', 'ps'], f.artifactPath, handlers);
  assert.equal(built.exitCode, 0, built.stderr);
  rmSync(join(f.app, 'dist'), { recursive: true });
  assert.deepEqual(await runCli(['agent', 'ps'], f.artifactPath, handlers), built);
  assert.equal(readFileSync(f.artifactPath, 'utf8'), f.builtCatalog);
});

test('existing compiled catalog stays authoritative and malformed artifacts are not replaced', async t => {
  const f = await fixture(t);
  rmSync(f.conf, { recursive: true });
  const built = f.run(['help']);
  assert.equal(built.code, 0, built.stderr);
  assert.equal(readFileSync(f.artifactPath, 'utf8'), f.builtCatalog);
  writeFileSync(f.artifactPath, '{invalid catalog');
  const malformed = f.run(['help']);
  assert.equal(malformed.code, 1);
  assert.equal(JSON.parse(malformed.stderr).code, 'CATALOG_UNAVAILABLE');
  assert.equal(readFileSync(f.artifactPath, 'utf8'), '{invalid catalog');
});
