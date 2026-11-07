import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createQualityRuntime } from '../src/test-run-quality-runtime.ts';
import { classifyRunnerResult, type TestRunPlan, type TestRunResult } from '../src/test-runs.ts';
import { fixtureConfig, fixtureContext } from './helpers/test-run-fixture.ts';
import { hash } from './helpers/quality-fixture.ts';

const group = 'fix-raf-quality-snapshot-shared-libs/quality-runtime';
const source = 'export function answer() { return 42; }\n';
const dependency = 'export const value = 7;\n';

function fixture(t: TestContext, options: { branch?: string; trackedLink?: boolean; localLibrary?: boolean } = {}) {
  const { branch = 'main', trackedLink = false, localLibrary = false } = options;
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
  function saveProjects() { writeFileSync(join(root, 'conf/projects.json'), JSON.stringify(projects)); }
  saveProjects();
  writeFileSync(join(workspace, '.gitignore'), 'node_modules\n' + (trackedLink ? '' : 'shared-libs\n'));
  writeFileSync(join(workspace, 'src/answer.ts'), source);
  writeFileSync(join(library, 'library/index.js'), dependency);
  if (localLibrary) {
    mkdirSync(join(workspace, 'shared-libs/library'), { recursive: true });
    writeFileSync(join(workspace, 'shared-libs/library/index.js'), dependency);
  } else symlinkSync(relative(workspace, library), join(workspace, 'shared-libs'));
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
    return { settings, manifest, quality: result.quality! };
  }
  function replaceLibraryLink(target: string) {
    rmSync(join(workspace, 'shared-libs'));
    symlinkSync(target, join(workspace, 'shared-libs'));
  }
  return { root, workspace, library, projects, saveProjects, prepare, replaceLibraryLink };
}

for (const branch of ['main', 'develop']) test(`quality snapshot accepts configured ${branch} shared-libs through node_modules and hashes dependency bytes`, async t => {
  const f = fixture(t, { branch });
  const first = await f.prepare();
  const path = 'node_modules/@fixture/library/index.js';
  assert.equal(readFileSync(join(first.settings.executionRoot, path), 'utf8'), dependency);
  assert.ok(first.manifest.some((input: any) => input.path === path && input.realpath === join(f.library, 'library/index.js') && input.sha256 === hash(dependency) && input.role === 'dependency'));
  writeFileSync(join(f.library, 'library/index.js'), 'export const value = 8;\n');
  const second = await f.prepare();
  assert.notEqual(first.quality.provenance!.dependencyDigest, second.quality.provenance!.dependencyDigest);
  assert.notEqual(first.quality.sourceSnapshotDigest, second.quality.sourceSnapshotDigest);
  assert.equal(readFileSync(join(first.settings.executionRoot, path), 'utf8'), dependency);
});

test('quality snapshot materializes the configured tracked shared-libs symlink as dependencies', async t => {
  const f = fixture(t, { trackedLink: true }), run = await f.prepare();
  assert.equal(readFileSync(join(run.settings.executionRoot, 'shared-libs/library/index.js'), 'utf8'), dependency);
  assert.ok(run.manifest.some((input: any) => input.path === 'shared-libs/library/index.js' && input.realpath === join(f.library, 'library/index.js') && input.role === 'dependency'));
});

test('quality snapshot preserves a tracked shared-libs directory within the workspace without duplicate inputs', async t => {
  const f = fixture(t, { trackedLink: true, localLibrary: true }), run = await f.prepare();
  assert.equal(readFileSync(join(run.settings.executionRoot, 'shared-libs/library/index.js'), 'utf8'), dependency);
  assert.equal(run.manifest.filter((input: any) => input.path === 'shared-libs/library/index.js').length, 1);
});

for (const route of ['foreign', 'wrong branch', 'root prefix sibling']) test(`quality snapshot refuses ${route} dependency routes`, async t => {
  const f = fixture(t);
  const targets = { foreign: join(f.root, 'foreign'), 'wrong branch': join(f.root, 'configured-libraries/develop'), 'root prefix sibling': f.library + '-foreign' };
  const target = targets[route]; mkdirSync(join(target, 'library'), { recursive: true });
  writeFileSync(join(target, 'library/index.js'), dependency);
  f.replaceLibraryLink(target);
  await assert.rejects(f.prepare(), /Dependency route escapes canonical workspace/);
});

test('quality snapshot refuses shared-libs for a project without configured shared-library use', async t => {
  const f = fixture(t); f.projects.projects.etchly.usesSharedLibs = false; f.saveProjects();
  await assert.rejects(f.prepare(), /Dependency route escapes canonical workspace/);
});

test('quality snapshot refuses a nested escape from the configured shared-libs root', async t => {
  const f = fixture(t), foreign = join(f.root, 'foreign.js'); writeFileSync(foreign, dependency);
  symlinkSync(foreign, join(f.library, 'library/escape.js'));
  await assert.rejects(f.prepare(), /Dependency route escapes canonical workspace/);
});

test('quality snapshot refuses dependency directory cycles inside the configured shared-libs root', async t => {
  const f = fixture(t); symlinkSync('.', join(f.library, 'library/cycle'));
  await assert.rejects(f.prepare(), /Cyclic dependency route/);
});

test('quality snapshot refuses self-referencing dependency symlinks', async t => {
  const f = fixture(t); symlinkSync('cycle', join(f.library, 'library/cycle'));
  await assert.rejects(f.prepare(), /Cyclic dependency route|ELOOP/);
});
