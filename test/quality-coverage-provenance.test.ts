import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyQualityCoverage } from '../src/test-run-quality.ts';
import { baseline, coverage, hash, selected, source, targetPath } from './helpers/quality-fixture.ts';

const check = (report = coverage(), green = baseline()) => verifyQualityCoverage(report, green, [selected], { [targetPath]: hash(source) });

test('T07 fresh complete baseline coverage binds producer, run, source and selection', () => {
  assert.deepEqual(check(), { accepted: true, reason: null, functions: [{ id: selected.id, status: 'covered', hits: 1, denominator: 1 }] });
});

for (const field of ['runId', 'sourceSnapshotDigest', 'selectionDigest', 'configDigest', 'dependencyDigest'] as const) {
  test(`T07 stale coverage ${field} is unavailable, never zero coverage`, () => {
    const report = coverage(); report[field] = 'another-run-or-input';
    const result = check(report);
    assert.equal(result.accepted, false);
    assert.ok(result.reason);
    assert.ok(result.functions.every(fn => fn.status !== 'covered' && fn.status !== 'uncovered'));
  });
}

for (const [name, change] of [
  ['old artifact with fresh mtime', (r: any) => { r.artifact.createdByRunId = 'old-run'; r.artifact.mtime = Date.now(); }],
  ['artifact hash differs from observed bytes', (r: any) => { r.artifact.actualSha256 = hash('stale lcov'); }],
  ['missing report', (r: any) => { r.artifact = null; }],
  ['provider failed', (r: any) => { r.producer.exitCode = 1; }],
  ['provider incomplete', (r: any) => { r.producer.complete = false; }],
  ['provider version changed', (r: any) => { r.producer.version = 'different'; }],
  ['dirty function bytes', (r: any) => { r.functions[0].sourceSha256 = hash('dirty'); }],
] as const) {
  test(`T07 ${name} cannot certify coverage`, () => {
    const report = coverage(); change(report);
    const decision = check(report);
    assert.equal(decision.accepted, false);
    assert.ok(decision.reason);
  });
}

for (const [name, change] of [
  ['failed baseline', (b: any) => { b.result.outcome = 'assertions-failed'; b.result.exitCode = 1; }],
  ['partial protocol', (b: any) => { b.result.unknown = [{ file: 'test/a.ts', name: 'unknown' }]; }],
  ['unexecuted test', (b: any) => { b.result.unexecuted = [{ file: 'test/a.ts', name: 'pending' }]; }],
  ['timeout', (b: any) => { b.result.timedOut = true; }],
  ['incomplete cleanup', (b: any) => { b.result.cleanup = { complete: false, remainingPids: [123] }; }],
] as const) {
  test(`T07/T12 ${name} does not produce usable baseline coverage`, () => {
    const green = baseline(); change(green);
    const decision = check(coverage(), green);
    assert.equal(decision.accepted, false);
    assert.ok(decision.reason);
  });
}

test('T07 a missing function is missing, not covered or uncovered', () => {
  const report = coverage(); report.functions = [];
  const decision = check(report);
  assert.deepEqual(decision.functions, [{ id: selected.id, status: 'missing', hits: null, denominator: null }]);
});

test('T07 mapped nonzero denominator with zero hits is real uncovered', () => {
  const report = coverage(); report.functions[0].hits = 0;
  const decision = check(report);
  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.functions, [{ id: selected.id, status: 'uncovered', hits: 0, denominator: 1 }]);
});

test('T07 unsupported mapping never invents numerical coverage', () => {
  const report = coverage(); report.functions[0].mapped = false; report.omissions = ['callback mapping unsupported'];
  const decision = check(report);
  assert.deepEqual(decision.functions, [{ id: selected.id, status: 'unsupported', hits: null, denominator: null }]);
});
