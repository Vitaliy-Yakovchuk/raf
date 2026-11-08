import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTestRunCli } from '../src/test-run-cli.ts';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import type { StateContext } from '../src/state-migration-guard.ts';
import { fixtureConfig, fixtureContext, policy } from './helpers/test-run-fixture.ts';
import { hash } from './helpers/quality-fixture.ts';
import type { QualityRequest } from '../src/test-run-quality.ts';

const codeRoot = fileURLToPath(new URL('..', import.meta.url));
const change = 'adopt-ub-mode-quality-gates';
const group = `${change}/quality-transport-runtime`;

async function stand(t: import('node:test').TestContext, route: 'relative' | 'alias' | 'dynamic') {
  const root = await mkdtemp(join(tmpdir(), 'raf-quality-'));
  const workspace = join(root, 'workspace'), home = join(root, 'qa'), operational = join(root, 'operational');
  for (const path of [workspace, home, operational, join(workspace, 'src'), join(workspace, 'test'), join(root, 'runs')]) await mkdir(path, { recursive: true, mode: 0o700 });
  const source = 'export function answer() { return 42; }\n';
  await writeFile(join(workspace, 'src/answer.ts'), source);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module', imports: { '#answer': './src/answer.ts' } }));
  const importer = route === 'relative' ? "import { answer } from '../src/answer.ts';" : route === 'alias' ? "import { answer } from '#answer';" : "const { answer } = await import('../src/answer.ts');";
  await writeFile(join(workspace, 'test/answer.test.ts'), `import assert from 'node:assert/strict'; import test from 'node:test'; ${importer}\ntest('required answer', () => assert.equal(answer(), 42));\n`);
  await writeFile(join(operational, 'state.sqlite'), 'operational sentinel');
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '--', 'src/answer.ts', 'test/answer.test.ts', 'package.json');
  git('-c', 'user.name=Quality Stand', '-c', 'user.email=quality@invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'quality stand');
  const revision = git('rev-parse', 'HEAD');
  const config = fixtureConfig();
  config.temporaryArtifacts = { root: join(root, 'runs'), minimumNestedSocketPathBytes: 1 };
  config.projects = { raf: { profiles: { node: {
    cwd: '.', executable: process.execPath, argv: [join(codeRoot, 'scripts/test-run-node.ts')], unitFiles: ['test/answer.test.ts'], exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [],
    quality: { sourceAdapter: { id: 'node-source', version: process.version }, siteSelector: { id: 'typescript-function', version: '1' }, coverage: { producer: 'node-v8', version: process.version, adapter: 'v8', argv: [], format: 'v8' } },
  } as any }, groups: { [group]: { profileId: 'node', files: ['test/answer.test.ts'] } } } };
  const context = { ...fixtureContext(), cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] }, activeChanges: [change], sha: revision, home, statePath: join(home, '.raf/state.sqlite'), tmpPath: join(home, '.raf/tmp'), operationalHome: operational };
  const stateContext: StateContext = { mode: 'qa', orchestratorRoot: root, codeRoot, homeDirectory: home, statePath: context.statePath, tmpRoot: context.tmpPath, tmuxSocketPath: join(home, '.raf/tmux/server.sock') };
  const store = openStateStore(context.statePath, { context: stateContext });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const request: QualityRequest = { version: 1, mode: 'baseline', source: { baseRevision: revision, revision, files: [{ path: 'src/answer.ts', sha256: hash(source) }] }, changedFunctions: [{ id: 'src/answer.ts/answer/0', path: 'src/answer.ts', startByte: 0, endByte: Buffer.byteLength(source) }] };
  const baselinePath = join(root, 'baseline.json'); await writeFile(baselinePath, JSON.stringify(request));
  const configurationBytes = { flow: Buffer.from(JSON.stringify({ unitTests: policy })), projects: Buffer.from(JSON.stringify({ projects: { raf: { path: workspace } } })), testRuns: Buffer.from(JSON.stringify(config)) };
  const invoke = async (path: string, failure?: 'spawn' | 'interruption') => {
    let stdout = '', stderr = '';
    const args = ['--project', 'raf', '--phase', 'qa', '--group', group, '--quality-request', path];
    const runtime = createTestRunPorts(config, stateContext, () => store, { PATH: process.env.PATH }, configurationBytes, { project: 'raf', phase: 'qa', group });
    if (failure === 'spawn') runtime.spawn = async () => { throw Object.assign(new Error('fixture spawn unavailable'), { code: 'ENOENT' }); };
    if (failure === 'interruption') {
      let interrupt: ((signal: string) => void) | undefined;
      const subscribe = runtime.subscribeInterruption, spawn = runtime.spawn;
      runtime.subscribeInterruption = callback => { interrupt = callback; return subscribe(callback); };
      runtime.spawn = async (...args) => { const child = await spawn(...args); queueMicrotask(() => interrupt!('SIGTERM')); return child; };
    }
    const code = await runTestRunCli(args, { config, policy, context, runtime, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
    assert.ok(stdout.trim(), stderr);
    return { code, stderr, result: JSON.parse(stdout) };
  };
  const mutant = async (baselineRunId: string, after = '41') => {
    const offset = source.indexOf('42');
    const value: QualityRequest = { ...request, mode: 'mutant', baselineRunId, mutant: { siteId: 'answer/42', functionId: request.changedFunctions[0].id, path: 'src/answer.ts', startByte: offset, endByte: offset + 2, beforeBase64: Buffer.from('42').toString('base64'), afterBase64: Buffer.from(after).toString('base64') } };
    const path = join(root, `mutant-${hash(after)}.json`); await writeFile(path, JSON.stringify(value));
    return invoke(path);
  };
  return { root, workspace, operational, source, baselinePath, invoke, mutant, git, request };
}

for (const route of ['relative', 'alias', 'dynamic'] as const) {
  test(`T02/T03/T07/T11 actual ${route} load executes private mutant through test run CLI`, async t => {
    const f = await stand(t, route);
    const canonical = join(f.workspace, 'src/answer.ts');
    const before = await readFile(canonical);
    const base = await f.invoke(f.baselinePath);
    assert.equal(base.code, 0, JSON.stringify(base));
    assert.equal(base.result.outcome, 'passed');
    assert.equal(base.result.quality.mode, 'baseline');
    const coverage = base.result.quality.coverage;
    assert.equal(coverage.runId, base.result.runId);
    assert.equal(coverage.producer.complete, true);
    assert.equal(coverage.producer.exitCode, 0);
    assert.equal(coverage.artifact.sha256, hash(await readFile(coverage.artifact.path)));
    assert.equal(coverage.sourceSnapshotDigest, base.result.quality.sourceSnapshotDigest);
    const mutant = await f.mutant(base.result.runId);
    assert.notEqual(mutant.code, 0);
    assert.equal(mutant.result.outcome, 'assertions-failed');
    assert.equal(mutant.result.quality.mutationDisposition, 'assertion-killed');
    assert.deepEqual(mutant.result.knownRed, [{ file: 'test/answer.test.ts', name: 'required answer' }]);
    const load = mutant.result.quality.loadedSources.find((entry: any) => entry.path === 'src/answer.ts');
    assert.ok(load?.loaded);
    assert.equal(load.runId, mutant.result.runId);
    assert.equal(load.inputSha256, hash(f.source.replace('42', '41')));
    assert.notEqual(load.resolvedPath, canonical);
    assert.notEqual(mutant.result.quality.executionSnapshotDigest, base.result.quality.executionSnapshotDigest);
    assert.equal(mutant.result.quality.sourceSnapshotDigest, base.result.quality.sourceSnapshotDigest);
    assert.deepEqual(await readFile(canonical), before);
    assert.equal(await readFile(join(f.operational, 'state.sqlite'), 'utf8'), 'operational sentinel');
    assert.equal(mutant.result.cleanup.complete, true);
    assert.deepEqual(mutant.result.cleanup.remainingPids, []);
    await assert.rejects(stat(dirname(load.resolvedPath)), { code: 'ENOENT' });
    const repeated = await f.invoke(f.baselinePath);
    assert.equal(repeated.code, 0);
    assert.deepEqual(repeated.result.knownRed, []);
    assert.deepEqual(await readFile(canonical), before);
  });
}

test('T08 real invalid mutant is compile-failed, never behavioral kill', async t => {
  const f = await stand(t, 'relative');
  const base = await f.invoke(f.baselinePath); assert.equal(base.code, 0, JSON.stringify(base));
  const invalid = await f.mutant(base.result.runId, ')');
  assert.notEqual(invalid.code, 0);
  assert.equal(invalid.result.outcome, 'compile-failed');
  assert.equal(invalid.result.quality.mutationDisposition, 'compile-failed');
  assert.ok(invalid.result.failureKinds.includes('compile'));
  assert.deepEqual(invalid.result.knownRed, []);
  assert.ok(invalid.result.quality.loadedSources.some((entry: any) => entry.stage === 'transform' && entry.loaded === false));
  assert.equal(await readFile(join(f.workspace, 'src/answer.ts'), 'utf8'), f.source);
  assert.equal(invalid.result.cleanup.complete, true);
});

test('dirty test bytes and a parallel branch commit preserve the requested baseline and overlay', async t => {
  const f = await stand(t, 'relative');
  const base = await f.invoke(f.baselinePath); assert.equal(base.code, 0, JSON.stringify(base));
  const dirtySource = f.source.replace('42', '99');
  await writeFile(join(f.workspace, 'src/answer.ts'), dirtySource);
  await writeFile(join(f.workspace, 'test/answer.test.ts'), "throw new Error('changed test inputs');\n");
  await writeFile(join(f.workspace, 'parallel.txt'), 'another agent commit');
  f.git('add', 'parallel.txt');
  f.git('-c', 'user.name=Quality Stand', '-c', 'user.email=quality@invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'parallel work');
  const result = await f.mutant(base.result.runId);
  assert.equal(result.result.outcome, 'assertions-failed');
  assert.equal(result.result.quality.mutationDisposition, 'assertion-killed');
  assert.equal(result.result.quality.sourceSnapshotDigest, base.result.quality.sourceSnapshotDigest);
  assert.match(await readFile(join(f.workspace, 'test/answer.test.ts'), 'utf8'), /changed test inputs/);
  assert.equal(await readFile(join(f.workspace, 'src/answer.ts'), 'utf8'), dirtySource);
  assert.deepEqual(result.result.cleanup.remainingPids, []);
});


for (const failure of ['spawn', 'interruption'] as const) {
  test(`T11 actual private run ${failure} preserves canonical and foreign artifacts`, async t => {
    const f = await stand(t, 'relative');
    const canonical = join(f.workspace, 'src/answer.ts');
    const before = await readFile(canonical);
    const foreign = join(f.root, 'foreign-tmp'); await mkdir(foreign); await writeFile(join(foreign, 'keep'), 'another owner');
    const result = await f.invoke(f.baselinePath, failure);
    assert.notEqual(result.code, 0);
    assert.equal(result.result.outcome, failure === 'spawn' ? 'setup-failed' : 'interrupted');
    assert.notEqual(result.result.quality.mutationDisposition, 'assertion-killed');
    assert.equal(result.result.cleanup.complete, true);
    assert.deepEqual(result.result.cleanup.remainingPids, []);
    assert.deepEqual(await readFile(canonical), before);
    assert.equal(await readFile(join(foreign, 'keep'), 'utf8'), 'another owner');
    assert.equal(await readFile(join(f.operational, 'state.sqlite'), 'utf8'), 'operational sentinel');
    assert.deepEqual(await readdir(join(f.root, 'runs')), []);
  });
}


test('committed test changes invalidate a baseline when requesting the newer commit', async t => {
  const f = await stand(t, 'relative');
  const base = await f.invoke(f.baselinePath); assert.equal(base.code, 0, JSON.stringify(base));
  await writeFile(join(f.workspace, 'test/answer.test.ts'), "throw new Error('changed committed tests');\n");
  f.git('add', 'test/answer.test.ts');
  f.git('-c', 'user.name=Quality Stand', '-c', 'user.email=quality@invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'changed tests');
  f.request.source.revision = f.git('rev-parse', 'HEAD');
  const result = await f.mutant(base.result.runId);
  assert.notEqual(result.code, 0);
  assert.notEqual(result.result.quality.mutationDisposition, 'assertion-killed');
  assert.notEqual(result.result.quality.mutationDisposition, 'survived');
  assert.match(JSON.stringify(result.result), /Baseline provenance mismatch/);
  assert.deepEqual(result.result.cleanup.remainingPids, []);
});
