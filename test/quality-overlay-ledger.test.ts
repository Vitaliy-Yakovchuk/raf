import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQualityRuntime } from '../src/test-run-quality-runtime.ts';
import { qualitySnapshotDigest, recordQualityObservation } from '../src/test-run-quality.ts';
import type { QualityGroup, QualityInput, QualityObservation, QualityRequest } from '../src/test-run-quality.ts';
import { reconcileTestRunGroup, runTestRun } from '../src/test-runs.ts';
import type { TestRunPlan } from '../src/test-runs.ts';
import { hash, testId, workspace as qualityWorkspace } from './helpers/quality-fixture.ts';
import {
  alpha, fixtureConfig, fixtureContext, fixtureGroup, fixtureRequest, flushMicrotasks, key, policy, RunHarness,
} from './helpers/test-run-fixture.ts';

const source = 'export function answer() { return 42; }\n';
const library = 'export const library = 1;\n';
const groupKey = { project: 'raf', workspace: qualityWorkspace, group: 'adopt-ub-mode-quality-gates/quality-transport' };

function ledgerGroup(): QualityGroup {
  return { aggregate: fixtureGroup({ key: groupKey, timeoutCount: 1, state: 'optimize', knownRed: [testId], unknown: [], inFlight: null }), observations: [] };
}

function observation(overrides: Partial<QualityObservation> = {}): QualityObservation {
  return {
    runId: 'mutant-01', agentId: 'author-a', phase: 'implement', mode: 'mutant',
    sourceSnapshotDigest: hash('source'), executionSnapshotDigest: hash('mutant-01'),
    classification: { outcome: 'timed-out', failureKinds: ['timeout'], knownRed: [], mutationDisposition: 'timed-out', reason: null, nextAction: 'retry' },
    ...overrides,
  };
}

test('mutant timeout does not change the stable group ledger and a verified baseline keeps the count', () => {
  const initial = ledgerGroup();
  const before = structuredClone(initial);
  const timedOut = recordQualityObservation(initial, groupKey, observation(), policy);
  assert.equal(timedOut.aggregate.timeoutCount, before.aggregate.timeoutCount);
  assert.deepEqual(timedOut.aggregate.knownRed, before.aggregate.knownRed);
  assert.equal(timedOut.observations[0].classification.mutationDisposition, 'timed-out');
  const verified = observation({
    runId: 'baseline-verified', mode: 'baseline', executionSnapshotDigest: hash('source'),
    classification: { outcome: 'passed', failureKinds: [], knownRed: [], mutationDisposition: 'not-applicable', reason: null, nextAction: 'complete' },
  });
  const baseline = recordQualityObservation(timedOut, groupKey, verified, policy);
  assert.equal(baseline.aggregate.timeoutCount, before.aggregate.timeoutCount);
});

test('baseline timeout still counts once on the stable group', () => {
  const initial = ledgerGroup();
  const timedOut = recordQualityObservation(initial, groupKey, observation({ mode: 'baseline', runId: 'baseline-timeout' }), policy);
  assert.equal(timedOut.aggregate.timeoutCount, initial.aggregate.timeoutCount + 1);
});

function qualityCommand(mode: 'baseline' | 'mutant') {
  return {
    request: { mode } as QualityRequest,
    command: { executable: process.execPath, argv: ['--test'], cwd: key.workspace, shell: false, environment: {} },
    finish: async (result: { quality?: unknown }) => {
      result.quality = {
        mode, baselineRunId: mode === 'mutant' ? 'baseline-1' : null,
        sourceSnapshotDigest: null, executionSnapshotDigest: null, mutant: null, loadedSources: [],
        coverage: { unavailableReason: 'fixture' }, mutationDisposition: mode === 'mutant' ? 'timed-out' : 'not-applicable', reason: null,
      };
    },
    cleanup: async () => {},
  };
}

test('mutant overlay timeout does not increment the stable group timeout count', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  harness.state.seed(fixtureGroup({ timeoutCount: 1, state: 'optimize', knownRed: [alpha], profileId: 'node', testKind: 'unit' }));
  harness.ports.prepareQuality = async () => qualityCommand('mutant');
  const pending = runTestRun(fixtureRequest({ qualityRequest: 'request.json' }), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  harness.clock.advance(policy.timeoutMs);
  const result = await pending;
  const stored = harness.state.get();
  assert.equal(result.timedOut, true);
  assert.equal(result.quality?.mutationDisposition, 'timed-out');
  assert.equal(result.timeoutCount, 1);
  assert.equal(stored?.timeoutCount, 1);
  assert.equal(stored?.state, 'optimize');
  assert.deepEqual(stored?.knownRed, [alpha]);
});

test('verified baseline run keeps the existing group timeout count', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({ timeoutCount: 1, state: 'optimize', knownRed: [], profileId: 'node', testKind: 'unit' }));
  harness.ports.prepareQuality = async () => qualityCommand('baseline');
  const result = await runTestRun(fixtureRequest({ qualityRequest: 'request.json' }), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.timedOut, false);
  assert.equal(harness.state.get()?.timeoutCount, 1);
});

test('baseline timeout still increments the stable group count', async () => {
  const harness = new RunHarness();
  harness.finishImmediately = false;
  harness.events = [];
  harness.state.seed(fixtureGroup({ timeoutCount: 1, state: 'optimize', knownRed: [], profileId: 'node', testKind: 'unit' }));
  harness.ports.prepareQuality = async () => qualityCommand('baseline');
  const pending = runTestRun(fixtureRequest({ qualityRequest: 'request.json' }), harness.config, policy, harness.context, harness.ports);
  await flushMicrotasks();
  harness.clock.advance(policy.timeoutMs);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(harness.state.get()?.timeoutCount, 2);
});

test('recovery of an unrecorded mutant timeout does not increment the stable group count', async () => {
  const harness = new RunHarness();
  harness.state.seed(fixtureGroup({
    timeoutCount: 1, state: 'running', profileId: 'node', testKind: 'unit', lastResult: null,
    inFlight: {
      runId: 'mutant-01', deadlineMs: harness.clock.time - 1, startedAtMs: harness.clock.time - policy.timeoutMs,
      processIdentity: 'mutant-process', phase: 'implement', qualityMode: 'mutant', finishedAtMs: null, deadlineObservedAtMs: null,
    },
  }));
  harness.recovered = { alive: false, deadlineReached: true, cleanup: { complete: true, remainingPids: [] } };
  const recovered = await reconcileTestRunGroup(key, policy, harness.context, harness.ports);
  assert.equal(recovered?.timeoutCount, 1);
  assert.equal(recovered?.lastResult?.timedOut, true);
  assert.equal(recovered?.lastResult?.outcome, 'timed-out');
});

const bundle = 'node_modules/@etchly/app/dist/local/bundle.js';
const viteCache = 'node_modules/@etchly/app/node_modules/.vite/deps/chunk.js';
const wranglerState = 'node_modules/@etchly/worker/.wrangler/local-stack.json';
const packageSource = 'node_modules/@etchly/app/src/library.ts';
const thirdParty = 'node_modules/left-pad/dist/index.js';

function snapshotFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-quality-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(root, 'qa');
  const temporary = join(root, 'run');
  for (const dir of [
    join(workspace, 'src'), join(workspace, 'app/src'), join(workspace, 'app/dist/local'),
    join(workspace, 'app/node_modules/.vite/deps'), join(workspace, 'worker/.wrangler'),
    join(workspace, 'node_modules/left-pad/dist'), join(workspace, 'node_modules/@etchly'), home, temporary,
  ]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, 'src/answer.ts'), source);
  writeFileSync(join(workspace, 'app/src/library.ts'), library);
  writeFileSync(join(workspace, 'app/dist/local/bundle.js'), 'bundle-v1');
  writeFileSync(join(workspace, 'app/node_modules/.vite/deps/chunk.js'), 'vite-v1');
  writeFileSync(join(workspace, 'worker/.wrangler/local-stack.json'), '{"generation":1}');
  writeFileSync(join(workspace, 'node_modules/left-pad/dist/index.js'), 'module.exports = 1;\n');
  writeFileSync(join(workspace, '.gitignore'), 'node_modules/\napp/dist/\napp/node_modules/\nworker/.wrangler/\n');
  symlinkSync('../../app', join(workspace, 'node_modules/@etchly/app'));
  symlinkSync('../../worker', join(workspace, 'node_modules/@etchly/worker'));
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Quality Fixture', '-c', 'user.email=fixture@invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const config = fixtureConfig();
  config.projects.raf.profiles.node.quality = {
    sourceAdapter: { id: 'node-source', version: process.version }, siteSelector: { id: 'typescript-function', version: '1' },
    coverage: { producer: 'node-v8', adapter: 'v8', version: process.version, format: 'v8', argv: [] },
  };
  const context = { ...fixtureContext(), workspace, cwd: workspace, home, tmpPath: join(home, '.raf/tmp'), sha: revision };
  mkdirSync(context.tmpPath, { recursive: true, mode: 0o700 });
  const start = source.indexOf('42');
  const request = (mode: 'baseline' | 'mutant'): QualityRequest => ({
    version: 1, mode,
    source: { baseRevision: revision, revision, files: [{ path: 'src/answer.ts', sha256: hash(source) }] },
    changedFunctions: [{ id: 'answer', path: 'src/answer.ts', startByte: 0, endByte: source.trimEnd().length }],
    ...(mode === 'mutant' ? {
      baselineRunId: 'baseline-ledger',
      mutant: {
        siteId: 'answer/42', functionId: 'answer', path: 'src/answer.ts', startByte: start, endByte: start + 2,
        beforeBase64: Buffer.from('42').toString('base64'), afterBase64: Buffer.from('0').toString('base64'),
      },
    } : {}),
  });
  const plan: TestRunPlan = {
    request: { project: 'raf', phase: 'hotfix', group: 'adopt-ub-mode-quality-gates/quality-overlay-ledger' },
    workspace, profileId: 'node', selection: { files: ['test/answer.test.ts'], testIds: [] },
    command: { executable: process.execPath, argv: ['--test'], cwd: workspace, shell: false, environment: { HOME: home, statePath: context.statePath, tmpPath: context.tmpPath, TMPDIR: temporary } },
  };
  const baselineDirectory = join(context.tmpPath, 'quality-baselines', hash(JSON.stringify([plan.request.project, context.workspace, plan.request.group])));
  async function prepare(mode: 'baseline' | 'mutant', runId: string) {
    const runTmp = join(temporary, runId);
    mkdirSync(runTmp, { recursive: true, mode: 0o700 });
    plan.command.environment.TMPDIR = runTmp;
    const descriptor = join(runTmp, `${runId}.json`);
    writeFileSync(descriptor, JSON.stringify(request(mode)));
    const prepared = await createQualityRuntime(config)(descriptor, plan, context, runId);
    t.after(() => prepared.cleanup(true));
    const settings = JSON.parse(readFileSync(prepared.command.environment.qualitySettings!, 'utf8')) as { executionRoot: string };
    return { prepared, executionRoot: settings.executionRoot };
  }
  async function sealBaseline() {
    const sealed = await prepare('baseline', 'baseline-ledger');
    await sealed.prepared.finish({
      outcome: 'passed', exitCode: 0, timedOut: false, cleanup: { complete: true, remainingPids: [] },
      unknown: [], unexecuted: [], startedAt: new Date().toISOString(), failureKinds: [],
    } as never, []);
    const manifest = JSON.parse(readFileSync(join(baselineDirectory, 'baseline-ledger.manifest.json'), 'utf8')) as { path: string; sha256: string; role: QualityInput['role'] }[];
    const inputs = manifest.map(item => ({ path: item.path, sha256: item.sha256, bytes: new Uint8Array(), realpath: item.path, role: item.role }));
    const dependency = inputs.filter(input => input.role === 'dependency' || /(^|\/)(?:package(?:-lock)?\.json|[^/]*lock[^/]*)$/.test(input.path));
    const baseline = {
      runId: 'baseline-ledger', owner: context.home,
      sourceSnapshotDigest: qualitySnapshotDigest(inputs),
      selectionDigest: hash(JSON.stringify(plan.selection)),
      configDigest: hash(JSON.stringify([config.projects.raf.profiles.node, null])),
      dependencyDigest: qualitySnapshotDigest(dependency),
      producer: { id: 'node-v8', version: process.version },
      result: { outcome: 'passed', exitCode: 0, timedOut: false, cleanup: { complete: true, remainingPids: [] }, unknown: [], unexecuted: [] },
    };
    writeFileSync(join(baselineDirectory, 'baseline-ledger.json'), JSON.stringify(baseline), { mode: 0o600 });
    return { ...sealed, manifest };
  }
  return { workspace, prepare, sealBaseline };
}

test('sealed snapshot omits generated build outputs behind workspace package symlinks', async t => {
  const fixture = snapshotFixture(t);
  const sealed = await fixture.sealBaseline();
  for (const generated of [bundle, viteCache, wranglerState]) {
    assert.equal(existsSync(join(sealed.executionRoot, generated)), false, generated);
    assert.equal(sealed.manifest.some(item => item.path === generated), false, generated);
  }
  for (const input of [packageSource, thirdParty, 'app/src/library.ts', 'src/answer.ts']) {
    assert.equal(existsSync(join(sealed.executionRoot, input)), true, input);
  }
});

test('generated build output changes do not break baseline provenance', async t => {
  const fixture = snapshotFixture(t);
  await fixture.sealBaseline();
  writeFileSync(join(fixture.workspace, 'app/dist/local/bundle.js'), 'bundle-v2');
  writeFileSync(join(fixture.workspace, 'app/node_modules/.vite/deps/chunk.js'), 'vite-v2');
  writeFileSync(join(fixture.workspace, 'worker/.wrangler/local-stack.json'), '{"generation":2}');
  writeFileSync(join(fixture.workspace, 'worker/.wrangler/extra.json'), '{"added":true}');
  await fixture.prepare('mutant', 'mutant-generated');
});

test('sealed source and dependency changes still break baseline provenance', async t => {
  const fixture = snapshotFixture(t);
  await fixture.sealBaseline();
  writeFileSync(join(fixture.workspace, 'app/src/library.ts'), 'export const library = 2;\n');
  await assert.rejects(() => fixture.prepare('mutant', 'mutant-source'), /Baseline provenance mismatch/);
  writeFileSync(join(fixture.workspace, 'app/src/library.ts'), library);
  writeFileSync(join(fixture.workspace, 'node_modules/left-pad/dist/index.js'), 'module.exports = 2;\n');
  await assert.rejects(() => fixture.prepare('mutant', 'mutant-dependency'), /Baseline provenance mismatch/);
});
