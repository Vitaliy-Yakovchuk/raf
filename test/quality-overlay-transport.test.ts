import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTestRunArgs, planTestRun } from '../src/test-runs.ts';
import { parseQualityRequest, prepareQualityExecution, recoverQualityCopies } from '../src/test-run-quality.ts';
import { fixtureConfig, fixtureContext, fixtureEnvironment, fixtureRequest } from './helpers/test-run-fixture.ts';
import { context, hash, mutated, mutation, request, selected, source, targetPath, transport, workspace } from './helpers/quality-fixture.ts';

const refused = (error: unknown) => error instanceof Error && error.message !== 'NotImplemented' && /path|escape|hash|before|baseline|snapshot|selector|function|source|control|field|mode|version|selection|config|dependency|owner|changed/i.test(error.message);

test('T01 ordinary planning keeps canonical routing, selection and isolated HOME', () => {
  const config = fixtureConfig(), ctx = fixtureContext();
  const plan = planTestRun(fixtureRequest(), config, ctx, fixtureEnvironment());
  assert.equal(plan.command.cwd, ctx.workspace);
  assert.equal(plan.command.environment.HOME, ctx.home);
  assert.deepEqual(plan.selection.files, fixtureRequest().files);
  assert.ok(!('executionRoot' in plan));
});

test('T01 quality-request is one data argument and does not replace exact test selection', () => {
  const argv = ['--project', 'raf', '--phase', 'red', '--group', 'adopt-ub-mode-quality-gates/quality-transport', '--files', 'test/a.test.ts', '--quality-request', '/private/request.json'];
  assert.deepEqual(parseTestRunArgs(argv), { project: 'raf', phase: 'red', group: argv[5], files: ['test/a.test.ts'], qualityRequest: '/private/request.json' });
  assert.throws(() => parseTestRunArgs([...argv, '--quality-request', '/other.json']));
});

test('T02 descriptor baseline and mutant preserve byte spans without caller execution options', () => {
  assert.deepEqual(parseQualityRequest(request()), request());
  assert.deepEqual(parseQualityRequest(request('baseline')), request('baseline'));
});

for (const [name, change] of [
  ['escape', (r: any) => { r.mutant.path = '../outside.ts'; }],
  ['option path', (r: any) => { r.source.files[0].path = '--import'; }],
  ['cwd', (r: any) => { r.cwd = '/other'; }],
  ['env', (r: any) => { r.env = { HOME: '/operational' }; }],
  ['argv', (r: any) => { r.argv = ['untrusted']; }],
  ['baseline with mutant', (r: any) => { r.mode = 'baseline'; }],
] as const) {
  test(`T04 rejects descriptor ${name} as data before any execution`, () => {
    const value = request(); change(value);
    assert.throws(() => parseQualityRequest(value), refused);
  });
}

test('T02 host snapshot patches only selected bytes in a private copy', async () => {
  const f = transport(), before = structuredClone(f.snapshot);
  const plan = await prepareQualityExecution(request(), context(), f.ports);
  assert.equal(plan.canonicalWorkspace, workspace);
  assert.equal(plan.executionRoot, '/fixture/private/run-1');
  assert.equal(plan.cwd, plan.executionRoot);
  assert.equal(plan.sourceSnapshotDigest, f.snapshot.digest);
  assert.notEqual(plan.executionSnapshotDigest, plan.sourceSnapshotDigest);
  assert.equal(Buffer.from(plan.inputs.find(input => input.path === targetPath)!.bytes).toString(), mutated);
  assert.deepEqual(plan.selection, context().selection);
  assert.deepEqual(structuredClone(f.snapshot), before);
  assert.deepEqual(plan.selectedSites, [mutation]);
  assert.deepEqual(f.calls.selected, [selected.id]);
});

for (const [name, change] of [
  ['source hash', (r: any) => { r.source.files[0].sha256 = hash('wrong'); }],
  ['before bytes', (r: any) => { r.mutant.beforeBase64 = Buffer.from('99').toString('base64'); }],
  ['neighbor on same line', (r: any) => { r.mutant.startByte = source.indexOf('7'); r.mutant.endByte = source.indexOf('7') + 1; r.mutant.beforeBase64 = Buffer.from('7').toString('base64'); }],
  ['spoofed function ID', (r: any) => { r.mutant.functionId = 'neighbor'; }],
  ['test replacement', (r: any) => { r.mutant.path = 'test/answer.test.ts'; }],
  ['config replacement', (r: any) => { r.mutant.path = 'runner.config.ts'; }],
] as const) {
  test(`T04/T05/T06 rejects ${name} before making an execution copy`, async () => {
    const f = transport(), value = request(); change(value);
    await assert.rejects(prepareQualityExecution(value, context(), f.ports), refused);
    assert.equal(f.calls.copies, 0);
    assert.equal(Buffer.from(f.snapshot.inputs[0].bytes).toString(), source);
  });
}

for (const field of ['sourceSnapshotDigest', 'selectionDigest', 'configDigest', 'dependencyDigest', 'owner'] as const) {
  test(`T05 mutant refuses baseline ${field} mismatch`, async () => {
    const f = transport(); f.saved[field] = 'different';
    await assert.rejects(prepareQualityExecution(request(), context(), f.ports), refused);
    assert.equal(f.calls.copies, 0);
  });
}

test('T04 caller cannot supply a foreign baseline artifact as trusted evidence', async () => {
  const f = transport(), value = request(); value.baselineRunId = '/foreign/baseline.json';
  await assert.rejects(prepareQualityExecution(value, context(), f.ports), refused);
  assert.equal(f.calls.copies, 0);
});

test('T04 symlink escape is refused before scheduling', async () => {
  const f = transport(); f.snapshot.inputs[0].realpath = '/foreign/answer.ts';
  await assert.rejects(prepareQualityExecution(request(), context(), f.ports), refused);
  assert.equal(f.calls.copies, 0);
});

test('T05 input changed while sealing cannot certify the requested source', async () => {
  const f = transport(); f.ports.readCurrent = async () => Buffer.from('changed during snapshot');
  await assert.rejects(prepareQualityExecution(request(), context(), f.ports), refused);
  assert.equal(f.calls.copies, 0);
});

test('T06 unsupported function selector leaves same-line neighbors unscheduled', async () => {
  const f = transport(); f.ports.selectSites = async () => ({ supported: false, reason: 'ambiguous overload', sites: [] });
  await assert.rejects(prepareQualityExecution(request(), context(), f.ports), refused);
  assert.equal(f.calls.copies, 0);
});

test('T11 recovery removes only owned terminated copies', async () => {
  const f = transport();
  const copies = ['terminated', 'active', 'unknown'].map(tree => ({ root: `/private/${tree}`, owner: context().owner, runId: tree, tree: tree as 'terminated' | 'active' | 'unknown' }));
  copies.push({ root: '/private/foreign', owner: 'another-wrapper', runId: 'foreign', tree: 'terminated' });
  const removed = await recoverQualityCopies(copies, context().owner, f.ports);
  assert.deepEqual(removed, ['/private/terminated']);
  assert.deepEqual(f.calls.removed, removed);
});
