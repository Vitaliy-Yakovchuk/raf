import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { createQualityRuntime } from '../src/test-run-quality-runtime.ts';
import { classifyRunnerResult, type TestRunPlan, type TestRunResult } from '../src/test-runs.ts';
import { fixtureConfig, fixtureContext } from './helpers/test-run-fixture.ts';
import { hash } from './helpers/quality-fixture.ts';

const group = 'adopt-ub-mode-quality-gates/quality-branch-materialization';
const source = 'export function answer() { return 42; }\n';
const dependency = 'export const value = 7;\n';

function fixture(t: TestContext, branch: string) {
  const root = mkdtempSync(join(tmpdir(), 'raf-quality-shared-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, `product-${branch}`);
  const library = join(root, 'configured-libraries', branch);
  const home = join(root, 'qa');
  for (const path of [join(root, 'conf'), join(workspace, 'src'), join(workspace, 'node_modules/@fixture'), join(library, 'library'), home]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const projects = { projects: {
    etchly: { usesSharedLibs: true, branchPaths: { main: 'product-main', develop: 'product-develop' } },
    'shared-libs': { branchPaths: { main: 'configured-libraries/main', develop: 'configured-libraries/develop' } },
  }, layout: { sharedLibrariesLink: 'shared-libs', sharedLibrariesTarget: '../shared-libs-{branch}' } };
  writeFileSync(join(root, 'conf/projects.json'), JSON.stringify(projects));
  writeFileSync(join(workspace, '.gitignore'), 'node_modules\n');
  writeFileSync(join(workspace, 'src/answer.ts'), source);
  writeFileSync(join(library, 'library/index.js'), dependency);
  symlinkSync(relative(workspace, library), join(workspace, 'shared-libs'));
  symlinkSync('../../shared-libs/library', join(workspace, 'node_modules/@fixture/library'));
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Quality Fixture', '-c', 'user.email=fixture@invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const config = fixtureConfig();
  config.projects.etchly = config.projects.raf;
  config.projects.etchly.profiles.node.quality = {
    sourceAdapter: { id: 'node-source', version: process.version }, siteSelector: { id: 'typescript-function', version: '1' },
    coverage: { producer: 'node-v8', adapter: 'v8', version: process.version, format: 'v8', argv: [] },
  };
  const context = { ...fixtureContext(), workspace, cwd: workspace, home, tmpPath: join(home, '.raf/tmp'), sha: revision };
  let sequence = 0;
  async function prepare() {
    const runId = `shared-${++sequence}`;
    const temporary = join(root, runId); mkdirSync(temporary, { mode: 0o700 });
    const descriptor = join(temporary, 'request.json');
    writeFileSync(descriptor, JSON.stringify({ version: 1, mode: 'baseline', source: { baseRevision: revision, revision, files: [{ path: 'src/answer.ts', sha256: hash(source) }] }, changedFunctions: [{ id: 'answer', path: 'src/answer.ts', startByte: 0, endByte: source.trimEnd().length }] }));
    const plan: TestRunPlan = { request: { project: 'etchly', phase: 'hotfix', group }, workspace, profileId: 'node', selection: { files: ['test/answer.test.ts'], testIds: [] },
      command: { executable: process.execPath, argv: ['--test'], cwd: workspace, shell: false, environment: { HOME: home, statePath: context.statePath, tmpPath: context.tmpPath, TMPDIR: temporary } } };
    const prepared = await createQualityRuntime(config)(descriptor, plan, context, runId);
    t.after(() => prepared.cleanup(true));
    const settings = JSON.parse(readFileSync(prepared.command.environment.qualitySettings!, 'utf8'));
    const result = { ...classifyRunnerResult([], { exitCode: 0, signal: null, stderr: '' }), runId, exitCode: 0, timedOut: false, cleanup: { complete: true, remainingPids: [] } } as TestRunResult;
    await prepared.finish(result, []);
    const manifest = JSON.parse(readFileSync(result.quality!.provenance!.manifest.path, 'utf8'));
    return { settings, manifest, prepared, quality: result.quality! };
  }
  return { root, workspace, library, prepare };
}


for (const branch of ['main', 'develop']) test(`private copy preserves configured ${branch} repository topology without live reads`, async t => {
  const f = fixture(t, branch);
  execFileSync('git', ['init', '-q', f.library]);
  const run = await f.prepare();
  const product = run.settings.executionRoot;
  const library = join(dirname(product), `shared-libs-${branch}`);
  const container = dirname(product);
  assert.equal(basename(product), `etchly-${branch}`);
  assert.equal(lstatSync(join(product, 'shared-libs')).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(product, 'shared-libs')), `../shared-libs-${branch}`);
  assert.equal(realpathSync(join(product, 'shared-libs')), library);
  for (const repository of [product, library]) {
    assert.equal(execFileSync('git', ['-C', repository, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), repository);
    assert.equal(execFileSync('git', ['-C', repository, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), branch);
  }
  assert.equal(run.manifest.some((input: any) => input.path.includes('/.git/')), false);
  rmSync(f.workspace, { recursive: true });
  rmSync(f.library, { recursive: true });
  writeFileSync(join(product, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    import { value } from './shared-libs/library/index.js';
    import { value as alias } from './node_modules/@fixture/library/index.js';
    assert.equal(value, 7); assert.equal(alias, 7);
  `);
  execFileSync(process.execPath, ['--import', new URL('../src/test-run-quality-loader.ts', import.meta.url).pathname, join(product, 'verify.mjs')], {
    env: { ...process.env, RAF_TEST_RUN_QUALITY_SETTINGS: run.prepared.command.environment.qualitySettings! }, cwd: product,
  });
  const foreign = join(f.root, 'foreign.mjs');
  writeFileSync(foreign, 'export const foreign = true;');
  writeFileSync(join(library, 'escape.mjs'), `import ${JSON.stringify(foreign)};`);
  assert.throws(() => execFileSync(process.execPath, ['--import', new URL('../src/test-run-quality-loader.ts', import.meta.url).pathname, join(library, 'escape.mjs')], {
    env: { ...process.env, RAF_TEST_RUN_QUALITY_SETTINGS: run.prepared.command.environment.qualitySettings! }, cwd: product, stdio: 'pipe',
  }), /Quality import escaped execution copy/);
  await run.prepared.cleanup(false);
  assert.equal(existsSync(product), true);
  await run.prepared.cleanup(true);
  assert.equal(existsSync(container), false);
});
