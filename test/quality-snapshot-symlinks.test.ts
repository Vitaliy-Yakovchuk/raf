import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQualityRuntime } from '../src/test-run-quality-runtime.ts';
import type { TestRunPlan } from '../src/test-runs.ts';
import { fixtureConfig, fixtureContext } from './helpers/test-run-fixture.ts';
import { hash } from './helpers/quality-fixture.ts';

const source = 'export function answer() { return 42; }\n';
const instructions = 'Repository instructions\n';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-quality-symlinks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(root, 'qa');
  const temporary = join(root, 'run');
  for (const dir of [join(workspace, 'src'), home, temporary]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, 'src/answer.ts'), source);
  writeFileSync(join(workspace, 'AGENTS.md'), instructions);
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Quality Fixture', '-c', 'user.email=fixture@invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const config = fixtureConfig();
  config.projects.raf.profiles.node.quality = {
    sourceAdapter: { id: 'node-source', version: process.version }, siteSelector: { id: 'typescript-function', version: '1' },
    coverage: { producer: 'node-v8', adapter: 'v8', version: process.version, format: 'v8', argv: [] },
  };
  const context = { ...fixtureContext(), workspace, cwd: workspace, home, tmpPath: join(home, '.raf/tmp'), sha: revision };
  const descriptor = join(temporary, 'request.json');
  writeFileSync(descriptor, JSON.stringify({ version: 1, mode: 'baseline', source: { baseRevision: revision, revision, files: [{ path: 'src/answer.ts', sha256: hash(source) }] }, changedFunctions: [{ id: 'answer', path: 'src/answer.ts', startByte: 0, endByte: source.trimEnd().length }] }));
  const plan: TestRunPlan = {
    request: { project: 'raf', phase: 'red', group: 'adopt-ub-mode-quality-gates/quality-snapshot-symlinks' }, workspace, profileId: 'node', selection: { files: ['test/answer.test.ts'], testIds: [] },
    command: { executable: process.execPath, argv: ['--test'], cwd: workspace, shell: false, environment: { HOME: home, statePath: context.statePath, tmpPath: context.tmpPath, TMPDIR: temporary } },
  };
  async function prepare() {
    git('add', '.');
    git('-c', 'user.name=Quality Fixture', '-c', 'user.email=fixture@invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'committed runtime fixture');
    const committed = git('rev-parse', 'HEAD');
    const request = JSON.parse(readFileSync(descriptor, 'utf8'));
    request.source.revision = committed;
    writeFileSync(descriptor, JSON.stringify(request));
    const prepared = await createQualityRuntime(config)(descriptor, plan, context, 'symlink-fixture');
    t.after(() => prepared.cleanup(true));
    const settings = JSON.parse(readFileSync(prepared.command.environment.qualitySettings!, 'utf8'));
    return settings.executionRoot as string;
  }
  return { root, workspace, git, prepare };
}

test('quality materializes committed internal instruction symlinks in a separate snapshot', async t => {
  const f = fixture(t);
  for (const name of ['CLAUDE.md', 'GEMINI.md', 'GROK.md']) symlinkSync('AGENTS.md', join(f.workspace, name));
  const copy = await f.prepare();
  assert.notEqual(copy, f.workspace);
  for (const name of ['CLAUDE.md', 'GEMINI.md', 'GROK.md']) {
    assert.equal(readFileSync(join(copy, name), 'utf8'), instructions);
    assert.equal(lstatSync(join(copy, name)).isFile(), true);
    assert.equal(lstatSync(join(f.workspace, name)).isSymbolicLink(), true);
  }
  writeFileSync(join(f.workspace, 'AGENTS.md'), 'changed after sealing');
  assert.equal(readFileSync(join(copy, 'CLAUDE.md'), 'utf8'), instructions);
});

test('quality materializes an absolute internal link and a chain of internal links', async t => {
  const f = fixture(t);
  symlinkSync(join(f.workspace, 'AGENTS.md'), join(f.workspace, 'GEMINI.md'));
  symlinkSync('GEMINI.md', join(f.workspace, 'CLAUDE.md'));
  const copy = await f.prepare();
  assert.equal(readFileSync(join(copy, 'CLAUDE.md'), 'utf8'), instructions);
});

test('quality materializes an internal directory link', async t => {
  const f = fixture(t);
  symlinkSync('src', join(f.workspace, 'linked-src'));
  const copy = await f.prepare();
  assert.equal(readFileSync(join(copy, 'linked-src/answer.ts'), 'utf8'), source);
});

for (const route of ['relative', 'absolute', 'prefix sibling', 'nested directory']) test(`quality refuses an external ${route} symlink before returning an execution command`, async t => {
  const f = fixture(t);
  const outside = route === 'prefix sibling' ? f.workspace + '-other' : join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.md'), 'outside workspace');
  if (route === 'nested directory') {
    symlinkSync('src', join(f.workspace, 'linked-src'));
    symlinkSync(join(outside, 'secret.md'), join(f.workspace, 'src/escape.md'));
  } else {
    const target = route === 'relative' ? '../outside/secret.md' : join(outside, 'secret.md');
    symlinkSync(target, join(f.workspace, 'CLAUDE.md'));
  }
  await assert.rejects(f.prepare(), error => (error as any).code === 'QUALITY_UNSUPPORTED');
});

test('quality refuses cyclic directory links', async t => {
  const f = fixture(t);
  symlinkSync('.', join(f.workspace, 'cycle'));
  await assert.rejects(f.prepare(), error => (error as any).code === 'QUALITY_UNSUPPORTED');
});

test('quality refuses a dangling external symlink rather than silently omitting it', async t => {
  const f = fixture(t);
  symlinkSync('../missing.md', join(f.workspace, 'CLAUDE.md'));
  await assert.rejects(f.prepare(), error => (error as any).code === 'QUALITY_UNSUPPORTED');
});

test('quality seals committed evidence names as literal snapshot data', async t => {
  const f = fixture(t);
  const paths = [
    'docs/qa/raw-2026-10-28T18:08:06.303Z.json',
    'docs/verification/public/-.png',
    'docs/verification/public/-about.png',
    'docs/qa/[report]*?{raw}.json',
  ];
  for (const path of paths) {
    mkdirSync(join(f.workspace, path, '..'), { recursive: true });
    writeFileSync(join(f.workspace, path), `evidence ${path}`);
  }
  mkdirSync(join(f.workspace, 'test'), { recursive: true });
  writeFileSync(join(f.workspace, 'test/answer.test.ts'), paths.map(path => `readFileSync(${JSON.stringify(path)})`).join('\n'));
  const copy = await f.prepare();
  for (const path of paths) {
    assert.equal(readFileSync(join(copy, path), 'utf8'), `evidence ${path}`);
    writeFileSync(join(f.workspace, path), 'changed after sealing');
    assert.equal(readFileSync(join(copy, path), 'utf8'), `evidence ${path}`);
  }
});
