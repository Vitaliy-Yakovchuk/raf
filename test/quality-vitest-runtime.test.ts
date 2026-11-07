import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQualityRuntime } from '../src/test-run-quality-runtime.ts';
import { classifyRunnerResult, type RunnerEvent, type TestRunPlan, type TestRunResult } from '../src/test-runs.ts';
import type { QualityRequest } from '../src/test-run-quality.ts';
import { fixtureConfig, fixtureContext } from './helpers/test-run-fixture.ts';
import { hash } from './helpers/quality-fixture.ts';

const group = 'adopt-ub-mode-quality-gates/quality-vitest-runtime';
const file = 'worker/src/answer.ts';
const id = { file: 'worker/test/answer.test.ts', name: 'required answer' };
const source = 'export function answer(): number { return 42; }\nexport function neighbor(): number { return 7; }\n';
const fn = { id: `${file}/answer/0`, path: file, startByte: 0, endByte: Buffer.byteLength(source.slice(0, source.indexOf('\n'))) };
const pin = '4.1.12';

type Prepared = Awaited<ReturnType<ReturnType<typeof createQualityRuntime>>>;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-vitest-quality-'));
  const workspace = join(root, 'workspace'), temporary = join(root, 'run'), home = join(root, 'qa');
  for (const dir of [join(workspace, 'worker/src'), join(workspace, 'worker/test'), temporary, home]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(workspace, file), source);
  writeFileSync(join(workspace, id.file), "import { answer } from '../src/answer'; test('required answer', () => expect(answer()).toBe(42));\n");
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vitest: pin, '@vitest/coverage-v8': pin } }));
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '--', 'worker', 'package.json');
  git('-c', 'user.name=Quality Fixture', '-c', 'user.email=fixture@invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const config = fixtureConfig();
  config.projects.raf.profiles = { vitest: {
    cwd: 'worker', executable: process.execPath, argv: ['node_modules/vitest/vitest.mjs', 'run'],
    unitFiles: [id.file], exactIds: 'vitest-test-name', resultAdapter: 'vitest-events',
    environment: { isolatedHome: true, stateOrigin: true }, checks: [],
    quality: { sourceAdapter: { id: 'vitest-source', version: pin }, siteSelector: { id: 'typescript-function', version: '1' },
      coverage: { producer: '@vitest/coverage-v8', version: pin, adapter: 'istanbul', argv: [], format: 'lcov' } },
  } };
  const context = { ...fixtureContext(), workspace, cwd: workspace, home, tmpPath: join(home, '.raf/tmp'), statePath: join(home, '.raf/state.sqlite'), sha: revision };
  const plan: TestRunPlan = { request: { project: 'raf', phase: 'red', group }, workspace, profileId: 'vitest',
    selection: { files: [id.file], testIds: [id] }, command: { executable: process.execPath, argv: ['node_modules/vitest/vitest.mjs', 'run', 'test/answer.test.ts'], cwd: join(workspace, 'worker'), shell: false,
      environment: { HOME: home, statePath: context.statePath, tmpPath: context.tmpPath, TMPDIR: temporary, testIds: [id] } } };
  const request: QualityRequest = { version: 1, mode: 'baseline', source: { baseRevision: revision, revision, files: [{ path: file, sha256: hash(source) }] }, changedFunctions: [fn] };
  let sequence = 0;
  async function prepare(value = request) {
    const runId = `vitest-${++sequence}`;
    const runTmp = join(temporary, runId); mkdirSync(runTmp, { mode: 0o700 });
    const descriptor = join(root, `${runId}.json`); writeFileSync(descriptor, JSON.stringify(value));
    let prepared!: Prepared;
    await assert.doesNotReject(async () => {
      prepared = await createQualityRuntime(config)(descriptor, { ...plan, command: { ...plan.command, environment: { ...plan.command.environment, TMPDIR: runTmp } } }, context, runId);
    }, 'a pinned Vitest profile must prepare quality without substituting a Node result adapter');
    t.after(async () => { await prepared?.cleanup(true); });
    return { prepared, runId, settings: JSON.parse(readFileSync(prepared.command.environment.qualitySettings!, 'utf8')) };
  }
  function observe(run: Awaited<ReturnType<typeof prepare>>, bytes = source, overrides: Record<string, unknown> = {}) {
    const transformed = bytes.replaceAll(': number', '');
    const event = { runId: run.runId, kind: 'load', source: { path: file, resolvedPath: join(run.settings.executionRoot, file), inputSha256: hash(bytes), transformedSha256: hash(transformed), mapping: hash('fixture-vite-source-map'), loaded: true, stage: 'load', runId: run.runId, ...overrides } };
    appendFileSync(run.settings.evidencePath, JSON.stringify(event) + '\n');
    return event.source;
  }
  async function finish(run: Awaited<ReturnType<typeof prepare>>, kind: 'passed' | 'assertion-failed' | 'setup-failed' = 'passed', complete = true) {
    const events: RunnerEvent[] = [{ kind: 'discovered', test: id }, { kind, test: id }, ...(complete ? [{ kind: 'complete' as const, expected: [id], adapter: 'vitest-events' as const }] : [])];
    const result = { ...classifyRunnerResult(events, { exitCode: kind === 'passed' ? 0 : 1, signal: null, stderr: 'AssertionError compile killed (untrusted text)' }),
      runId: run.runId, startedAt: new Date().toISOString(), exitCode: kind === 'passed' ? 0 : 1, timedOut: false, cleanup: { complete: true, remainingPids: [] } } as TestRunResult;
    await run.prepared.finish(result, events);
    assert.ok(result.quality, 'Vitest result must carry quality evidence');
    return result;
  }
  function lcov(run: Awaited<ReturnType<typeof prepare>>, hits = 1) {
    const bytes = `TN:\nSF:${join(run.settings.executionRoot, file)}\nFN:1,1,answer\nFNDA:${hits},answer\nFNF:1\nFNH:${hits ? 1 : 0}\nDA:1,${hits}\nLF:1\nLH:${hits ? 1 : 0}\nend_of_record\n`;
    writeFileSync(join(run.settings.coverageRoot, 'lcov.info'), bytes);
    return bytes;
  }
  return { workspace, config, plan, request, prepare, observe, finish, lcov };
}

test('Vitest quality preserves pinned profile, exact selection and private nested execution cwd', async t => {
  const f = fixture(t), run = await f.prepare();
  assert.equal(f.config.projects.raf.profiles.vitest.resultAdapter, 'vitest-events');
  assert.notEqual(run.prepared.command.cwd, f.plan.command.cwd);
  assert.equal(run.prepared.command.cwd, join(run.settings.executionRoot, 'worker'));
  assert.deepEqual(run.prepared.command.environment.testIds, [id]);
  assert.equal(readFileSync(join(run.settings.executionRoot, file), 'utf8'), source);
  assert.equal(readFileSync(join(f.workspace, file), 'utf8'), source);
});

for (const hits of [0, 1]) test(`Vitest V8-provider LCOV maps changed function with ${hits} hits and fresh provenance`, async t => {
  const f = fixture(t), run = await f.prepare();
  const observed = f.observe(run), artifact = f.lcov(run, hits);
  const result = await f.finish(run), q = result.quality!;
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(q.loadedSources, [observed]);
  assert.notEqual(observed.inputSha256, observed.transformedSha256);
  const c = q.coverage;
  assert.ok('functions' in c, JSON.stringify(c));
  assert.equal(c.runId, result.runId);
  assert.equal(c.sourceSnapshotDigest, q.sourceSnapshotDigest);
  assert.equal(c.selectionDigest, q.provenance!.selectionDigest);
  assert.equal(c.configDigest, q.provenance!.configDigest);
  assert.equal(c.dependencyDigest, q.provenance!.dependencyDigest);
  assert.deepEqual(c.producer, { id: '@vitest/coverage-v8', version: pin, complete: true, exitCode: 0 });
  assert.deepEqual(c.functions, [{ id: fn.id, unit: 'function', hits, denominator: 1, sourceSha256: hash(source), mapped: true }]);
  assert.equal(c.artifact!.createdByRunId, result.runId);
  assert.equal(c.artifact!.sha256, hash(readFileSync(c.artifact!.path)));
  assert.ok(artifact.includes('FNDA:'));
});

test('Vitest missing coverage remains unavailable rather than numerical zero', async t => {
  const f = fixture(t), run = await f.prepare(); f.observe(run);
  const result = await f.finish(run), coverage = result.quality!.coverage;
  if ('functions' in coverage) {
    assert.deepEqual(coverage.functions, []);
    assert.equal(coverage.producer.complete, false);
    assert.ok(coverage.omissions.length, 'missing provider output must explain omission');
  } else assert.ok(coverage.unavailableReason);
});

for (const failure of ['assertion-failed', 'setup-failed'] as const) test(`Vitest ${failure} baseline cannot authorize a mutant`, async t => {
  const f = fixture(t), run = await f.prepare(); f.observe(run); f.lcov(run);
  await f.finish(run, failure);
  const offset = source.indexOf('42');
  await assert.rejects(f.prepare({ ...f.request, mode: 'mutant', baselineRunId: run.runId, mutant: { siteId: 'answer/42', functionId: fn.id, path: file, startByte: offset, endByte: offset + 2, beforeBase64: Buffer.from('42').toString('base64'), afterBase64: Buffer.from('41').toString('base64') } }));
});

for (const kind of ['passed', 'assertion-failed', 'setup-failed'] as const) test(`Vitest structured ${kind} classifies actual overlay, preserving canonical bytes`, async t => {
  const f = fixture(t), base = await f.prepare(); f.observe(base); f.lcov(base); await f.finish(base);
  const offset = source.indexOf('42');
  const run = await f.prepare({ ...f.request, mode: 'mutant', baselineRunId: base.runId, mutant: { siteId: 'answer/42', functionId: fn.id, path: file, startByte: offset, endByte: offset + 2, beforeBase64: Buffer.from('42').toString('base64'), afterBase64: Buffer.from('41').toString('base64') } });
  const mutant = source.replace('42', '41');
  assert.equal(readFileSync(join(run.settings.executionRoot, file), 'utf8'), mutant);
  const observation = f.observe(run, mutant), result = await f.finish(run, kind);
  assert.equal(result.outcome, kind === 'passed' ? 'passed' : kind === 'assertion-failed' ? 'assertions-failed' : 'setup-failed');
  assert.equal(result.quality!.mutationDisposition, kind === 'passed' ? 'survived' : kind === 'assertion-failed' ? 'assertion-killed' : 'setup-failed');
  assert.ok(result.quality!.loadedSources.some(value => value.loaded && value.inputSha256 === observation.inputSha256 && value.transformedSha256 === observation.transformedSha256));
  assert.deepEqual(result.knownRed, kind === 'assertion-failed' ? [id] : []);
  assert.equal(readFileSync(join(f.workspace, file), 'utf8'), source);
});

for (const fault of ['not loaded', 'canonical bytes', 'no transformed hash', 'no mapping', 'incomplete protocol'] as const) test(`Vitest ${fault} cannot certify an overlay survivor or kill`, async t => {
  const f = fixture(t), base = await f.prepare(); f.observe(base); f.lcov(base); await f.finish(base);
  const offset = source.indexOf('42');
  const run = await f.prepare({ ...f.request, mode: 'mutant', baselineRunId: base.runId, mutant: { siteId: 'answer/42', functionId: fn.id, path: file, startByte: offset, endByte: offset + 2, beforeBase64: Buffer.from('42').toString('base64'), afterBase64: Buffer.from('41').toString('base64') } });
  f.observe(run, fault === 'canonical bytes' ? source : source.replace('42', '41'), fault === 'not loaded' ? { loaded: false, stage: 'transform' } : fault === 'no transformed hash' ? { transformedSha256: null } : fault === 'no mapping' ? { mapping: null } : {});
  const result = await f.finish(run, 'assertion-failed', fault !== 'incomplete protocol');
  assert.notEqual(result.quality!.mutationDisposition, 'assertion-killed');
  assert.notEqual(result.quality!.mutationDisposition, 'survived');
  assert.ok(result.quality!.reason);
});
