import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyQualityRun } from '../src/test-run-quality.ts';
import { RunnerProtocol } from '../src/test-run-protocol.ts';
import { formatSandboxTestRunEvidence } from '../src/sandbox-test-run.ts';
import { facts, hash, mutated, targetPath, testId } from './helpers/quality-fixture.ts';
import { RunHarness, fixtureRequest, policy } from './helpers/test-run-fixture.ts';
import { classifyRunnerResult, runTestRun } from '../src/test-runs.ts';

const body = { origin: 'test-body' as const, test: testId, message: 'compile mentioned by product exception' };
const compile = { origin: 'transform' as const, path: targetPath, inputSha256: hash(mutated), message: 'Syntax error' };

for (const [name, overrides, outcome, disposition, kinds] of [
  ['survivor', {}, 'passed', 'survived', []],
  ['assertion body', { events: [body], exitCode: 1 }, 'assertions-failed', 'assertion-killed', ['assertions']],
  ['structured transform', { events: [compile], exitCode: 1 }, 'compile-failed', 'compile-failed', ['compile']],
  ['missing dependency', { events: [{ origin: 'import', message: 'Module not found' }], exitCode: 1 }, 'setup-failed', 'setup-failed', ['setup']],
  ['hook AssertionError', { events: [{ origin: 'hook', message: 'AssertionError' }], exitCode: 1 }, 'setup-failed', 'setup-failed', ['setup']],
  ['unknown origin compile text', { events: [{ origin: 'unknown', message: 'SyntaxError compile' }], exitCode: 1 }, 'setup-failed', 'setup-failed', ['setup']],
  ['timeout', { timedOut: true, exitCode: null }, 'timed-out', 'timed-out', ['timeout']],
  ['broker refusal', { events: [{ origin: 'broker', message: 'source path escape' }], exitCode: null }, 'refused', 'refused', ['refusal']],
] as const) {
  test(`T08 ${name} retains its structured origin`, () => {
    const result = classifyQualityRun(facts(structuredClone(overrides) as any));
    assert.equal(result.outcome, outcome);
    assert.equal(result.mutationDisposition, disposition);
    assert.deepEqual([...result.failureKinds].sort(), [...kinds].sort());
    assert.deepEqual(result.knownRed, name === 'assertion body' ? [testId] : []);
    if (outcome === 'compile-failed') assert.equal(result.nextAction, 'fix-setup');
  });
}

test('T08 compile provenance can prove transform input without claiming successful load', () => {
  const input = facts({ events: [compile], exitCode: 1 });
  input.loadedSources[0].loaded = false; input.loadedSources[0].stage = 'transform';
  const result = classifyQualityRun(input);
  assert.equal(result.mutationDisposition, 'compile-failed');
  assert.notEqual(result.mutationDisposition, 'assertion-killed');
});

for (const [name, overrides] of [
  ['failed baseline', { baselineGreen: false }],
  ['no sites', { siteCount: 0 }],
  ['no loaded target', { loadedSources: [] }],
  ['incomplete protocol', { protocolComplete: false }],
  ['incomplete cleanup', { cleanup: { complete: false, remainingPids: [123] } }],
  ['interruption', { interrupted: true }],
] as const) {
  test(`T09/T12 ${name} is unverified even if upstream says killed`, () => {
    const result = classifyQualityRun(facts({ ...structuredClone(overrides), events: [body], exitCode: 1, rawUpstreamOutcome: 'killed' } as any));
    assert.equal(result.mutationDisposition, 'unverified');
    assert.ok(result.reason);
    assert.equal(result.rawUpstreamOutcome, 'killed');
    assert.notEqual(result.outcome, 'passed');
  });
}

for (const field of ['runId', 'inputSha256', 'path'] as const) {
  test(`T12 target load ${field} mismatch cannot prove kill or survivor`, () => {
    for (const events of [[], [body]]) {
      const input = facts({ events, exitCode: events.length ? 1 : 0 }); input.loadedSources[0][field] = 'foreign';
      const result = classifyQualityRun(input);
      assert.equal(result.mutationDisposition, 'unverified');
      assert.ok(result.reason);
    }
  });
}

test('T09 mixed assertion, compile, setup and timeout retain every fact', () => {
  const result = classifyQualityRun(facts({ events: [body, compile, { origin: 'hook', message: 'setup' }], timedOut: true, exitCode: null }));
  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.mutationDisposition, 'timed-out');
  assert.deepEqual([...result.failureKinds].sort(), ['assertions', 'compile', 'setup', 'timeout']);
  assert.deepEqual(result.knownRed, [testId]);
});

test('T09 setup takes priority over compile which takes priority over assertions', () => {
  const input = facts({ events: [body, compile], exitCode: 1 });
  assert.equal(classifyQualityRun(input).outcome, 'compile-failed');
  input.events.push({ origin: 'hook', message: 'hook failure' });
  const result = classifyQualityRun(input);
  assert.equal(result.outcome, 'setup-failed');
  assert.deepEqual(result.knownRed, [testId]);
});

test('T09 runner protocol accepts structured transform stage without parsing stderr', () => {
  const protocol = new RunnerProtocol();
  const event = { kind: 'compile-failed', stage: 'transform', path: targetPath, inputSha256: hash(mutated), diagnostic: 'Syntax error' };
  assert.deepEqual(protocol.accept(event), event);
  assert.throws(() => new RunnerProtocol().accept({ kind: 'compile-failed', diagnostic: 'compile' }));
});

test('T09 compile result passes sandbox formatter with quality evidence intact', async () => {
  const h = new RunHarness();
  const result = await runTestRun(fixtureRequest(), h.config, policy, h.context, h.ports);
  const quality = { mode: 'mutant', baselineRunId: 'baseline-1', mutationDisposition: 'compile-failed', loadedSources: facts().loadedSources };
  const reply = { code: 1, stderr: '', stdout: JSON.stringify({ ...result, outcome: 'compile-failed', failureKinds: ['compile'], quality }) };
  const text = formatSandboxTestRunEvidence({ command: 'raf test run', workspace: h.context.workspace, sha: 'fixture', dirtyPaths: [], artifact: '/fixture/evidence.json', reply });
  assert.doesNotMatch(text, /missing, malformed or truncated/);
  assert.match(text, /compile-failed/);
  assert.match(text, /mutant-1/);
  assert.match(text, new RegExp(hash(mutated)));
});


test('T08 production runner classifier distinguishes compile from assertions and preserves IDs', () => {
  const events = [
    { kind: 'assertion-failed', test: testId },
    { kind: 'compile-failed', stage: 'transform', path: targetPath, inputSha256: hash(mutated), diagnostic: 'invalid token' },
    { kind: 'complete', expected: [testId] },
  ];
  const result = classifyRunnerResult(events as any, { exitCode: 1, signal: null, stderr: 'arbitrary text' });
  assert.equal(result.outcome, 'compile-failed');
  assert.deepEqual([...result.failureKinds].sort(), ['assertions', 'compile']);
  assert.deepEqual(result.knownRed, [testId]);
});
