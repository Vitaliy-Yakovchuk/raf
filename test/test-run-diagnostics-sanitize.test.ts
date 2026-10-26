import assert from 'node:assert/strict';
import test from 'node:test';
import { TestRunDiagnostics, buildDiagnosticEnvironment } from '../src/test-run-diagnostics.ts';
import type { DiagnosticAttachment, InlineDiagnostic } from '../src/test-run-diagnostics.ts';
import { runTestRun, testRunFailureResult } from '../src/test-runs.ts';
import type { TestRunResult } from '../src/test-runs.ts';
import { RunHarness, alpha, beta, fixtureConfig, fixtureContext, fixtureRequest, flushMicrotasks, policy } from './helpers/test-run-fixture.ts';

const paths = { workspace: '/work/raf-develop', qaHome: '/qa/home', fixtureRoots: ['/tmp/d3-fixture'] };
const environment = buildDiagnosticEnvironment({
  executable: 'node', runtimeVersion: process.version, adapter: 'node-test-events', isolation: 'process',
  configurationBytes: { flow: new Uint8Array(), testRuns: new Uint8Array(), projects: new Uint8Array() },
  tmpPath: '/tmp/d3-run', privateRunTmp: true,
});

function collector(): TestRunDiagnostics {
  return new TestRunDiagnostics(fixtureConfig().diagnostics, paths);
}

function attachment(diagnostics: TestRunDiagnostics): DiagnosticAttachment {
  return diagnostics.attach({
    runId: 'd3-roundtrip', outcome: 'assertions-failed', failureKinds: ['assertions'],
    knownRed: [alpha], unknown: [], unexecuted: [], timeoutCount: 0, timedOut: false,
    cleanup: { complete: true, remainingPids: [] }, evidence: [],
  }, environment);
}

function entry(overrides: Partial<InlineDiagnostic> = {}): InlineDiagnostic {
  return {
    kind: 'assertion', test: alpha, errorName: 'AssertionError', errorCode: 'ERR_ASSERTION',
    message: 'expected readiness', location: { file: alpha.file, line: 13, column: 10 },
    stack: [`at readiness (${alpha.file}:13:10)`], redacted: false, truncated: false,
    ...overrides,
  };
}

function roundtrip(input: InlineDiagnostic): DiagnosticAttachment {
  const next = collector();
  next.inline(JSON.parse(JSON.stringify(input)) as InlineDiagnostic);
  return attachment(next);
}

for (const frame of [
  'at readiness (test/x.test.ts:13:10)',
  'at async Test.run (node:internal/test_runner/test:111:9)',
  'at readiness (<fixture>/nested/h.sock:13:10)',
  'at readiness (<qa-home>/nested/helper.ts:13:10)',
  'at readiness (<external>/package/helper.js:13:10)',
]) {
  test(`D3 already safe frame survives repeated delivery: ${frame}`, () => {
    let current = entry({ stack: [frame] });
    for (let pass = 0; pass < 3; pass++) {
      const next = roundtrip(current);
      assert.deepEqual(next.diagnostics, [current]);
      assert.equal(next.diagnosticSummary.redacted, false);
      current = next.diagnostics[0];
    }
  });
}

test('D3 safe relative paths and public URL retain their syntax without redaction', () => {
  const safe = entry({ message: 'read test/x.test.ts; see https://docs.example.test/runner/help' });
  const result = roundtrip(safe);
  assert.deepEqual(result.diagnostics, [safe]);
  assert.equal(result.diagnosticSummary.redacted, false);
});

for (const state of [
  { redacted: true, truncated: false },
  { redacted: false, truncated: true },
  { redacted: true, truncated: true },
]) {
  test(`D3 delivery preserves existing redaction/truncation facts ${JSON.stringify(state)}`, () => {
    const safe = entry({ ...state, message: 'readiness <redacted>', stack: ['at readiness (test/x.test.ts:13:10)'] });
    const once = roundtrip(safe);
    assert.deepEqual(once.diagnostics, [safe]);
    assert.equal(once.diagnosticSummary.redacted, state.redacted);
    assert.equal(once.diagnosticSummary.truncated, state.truncated);
    assert.deepEqual(roundtrip(once.diagnostics[0]), once);
  });
}

test('D3 reporter cleaning followed by inline cleaning is idempotent for private paths', () => {
  const reporter = collector();
  const error = new Error('socket unavailable at /tmp/d3-fixture/nested/h.sock');
  error.stack = [
    'Error: socket unavailable',
    '    at readiness (/work/raf-develop/test/x.test.ts:13:10)',
    '    at fixture (/tmp/d3-fixture/nested/helper.ts:21:4)',
    '    at qa (/qa/home/nested/helper.ts:9:2)',
    '    at package (/opt/d3-private/package/helper.js:5:1)',
    '    at async Test.run (node:internal/test_runner/test:111:9)',
  ].join('\n');
  reporter.failure({ test: alpha, origin: 'test-body', error });
  const first = attachment(reporter);
  assert.equal(first.diagnostics.length, 1);
  const diagnostic = first.diagnostics[0];
  assert.ok(diagnostic.stack.some(frame => frame.includes('test/x.test.ts:13:10')));
  assert.ok(diagnostic.stack.some(frame => frame.includes('<fixture>/nested/helper.ts:21:4')));
  assert.ok(diagnostic.stack.some(frame => frame.includes('<qa-home>/nested/helper.ts:9:2')));
  assert.ok(diagnostic.stack.some(frame => frame.includes('<external>/')));
  assert.ok(diagnostic.stack.some(frame => frame.includes('node:internal/test_runner/test:111:9')));
  assert.doesNotMatch(JSON.stringify(first.diagnostics), /\/work\/raf-develop|\/tmp\/d3-fixture|\/qa\/home|\/opt\/d3-private/);
  assert.deepEqual(roundtrip(diagnostic), first);
});

test('D3 URL credential/query cleaning keeps URL structure and stays stable on delivery', () => {
  const reporter = collector();
  const error = new Error('request https://d3user:D3PasswordCanary42@api.example.test/runner/help?token=D3QueryCanary42');
  error.stack = 'Error: request failed\n    at request (test/x.test.ts:13:10)';
  reporter.failure({ test: alpha, origin: 'test-body', error });
  const first = attachment(reporter);
  assert.equal(first.diagnostics.length, 1);
  const diagnostic = first.diagnostics[0];
  assert.doesNotMatch(JSON.stringify(first.diagnostics), /D3PasswordCanary42|D3QueryCanary42|d3user/);
  const urlText = diagnostic.message.match(/https:\/\/\S+/)?.[0];
  assert.ok(urlText, 'cleaning must retain the URL scheme and authority delimiters');
  const url = new URL(urlText);
  assert.equal(url.hostname, 'api.example.test');
  assert.equal(url.pathname, '/runner/help');
  assert.equal(diagnostic.redacted, true);
  assert.equal(first.diagnosticSummary.redacted, true);
  assert.deepEqual(roundtrip(diagnostic), first);
});

test('D3 inline accepts untrusted secret text while preserving the test identity', () => {
  const unsafe = entry({ message: 'password=D3InlineCanary42', stack: ['at readiness (test/x.test.ts:13:10)'] });
  const result = roundtrip(unsafe);
  assert.doesNotMatch(JSON.stringify(result), /D3InlineCanary42/);
  assert.deepEqual(result.diagnostics[0].test, alpha);
  assert.equal(result.diagnostics[0].redacted, true);
  assert.equal(result.diagnosticSummary.redacted, true);
  assert.deepEqual(roundtrip(result.diagnostics[0]), result);
});

test('D3 run result and last aggregate keep the reporter diagnostic unchanged', async () => {
  const harness = new RunHarness();
  const safe = entry();
  harness.events = [
    { kind: 'assertion-failed', test: alpha, inlineDiagnostic: safe },
    { kind: 'passed', test: beta }, { kind: 'complete', expected: [alpha, beta] },
  ];
  harness.exit = { exitCode: 1, signal: null, stderr: '' };
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(result.outcome, 'assertions-failed');
  assert.deepEqual(result.knownRed, [alpha]);
  assert.deepEqual(result.diagnostics, [safe]);
  assert.equal(result.diagnosticSummary.redacted, false);
  assert.deepEqual(harness.state.get()?.lastResult?.diagnostics, [safe]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).diagnostics, [safe]);
});

function noInventedExit(result: TestRunResult): void {
  assert.deepEqual(result.diagnostics.filter(diagnostic => diagnostic.kind === 'protocol' || diagnostic.kind === 'runner'), []);
}

test('D3 unusable temporary directory is a warning and the run uses the system tmp', async () => {
  const harness = new RunHarness();
  const message = 'Configured temporary root exceeds socket pathname capacity';
  harness.ports.prepareTemporary = async () => {
    throw Object.assign(new Error(message), {
      code: 'TEMPORARY_DIRECTORY_INVALID',
      diagnostic: entry({ kind: 'setup', test: null, errorName: 'Error', errorCode: 'TEMPORARY_DIRECTORY_INVALID', message, location: null, stack: [] }),
    });
  };
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(harness.spawns.length, 1);
  assert.equal(harness.spawns[0].environment.TMPDIR, undefined);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.message.includes('Warning') && diagnostic.message.includes(message)));
});

for (const stop of ['timeout', 'interruption'] as const) {
  test(`D3 ${stop} retains partial assertions without inventing a missing protocol exit`, async () => {
    const harness = new RunHarness();
    harness.finishImmediately = false;
    harness.events = [
      { kind: 'discovered', test: alpha }, { kind: 'discovered', test: beta },
      { kind: 'assertion-failed', test: alpha, inlineDiagnostic: entry() },
    ];
    const pending = runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
    await flushMicrotasks();
    assert.equal(harness.spawns.length, 1);
    if (stop === 'timeout') harness.clock.advance(policy.timeoutMs);
    else {
      assert.ok(harness.interrupt);
      harness.interrupt('SIGINT');
    }
    const result = await pending;
    assert.equal(result.outcome, stop === 'timeout' ? 'timed-out' : 'interrupted');
    assert.equal(result.timedOut, stop === 'timeout');
    assert.deepEqual(result.knownRed, [alpha]);
    assert.ok(result.unexecuted.some(id => id.file === beta.file && id.name === beta.name));
    assert.deepEqual(result.cleanup, { complete: true, remainingPids: [] });
    assert.equal(harness.cleanupCalls.length, 1);
    assert.equal(harness.cleanupCalls[0].reason, stop);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.message === 'expected readiness'));
    noInventedExit(result);
  });
}

test('D3 an actual unexpected child exit without protocol still has protocol diagnostics', async () => {
  const harness = new RunHarness();
  harness.events = [];
  harness.exit = { exitCode: 3, signal: null, stderr: 'loader unavailable; password=D3ExitCanary42' };
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(harness.spawns.length, 1);
  assert.equal(result.outcome, 'setup-failed');
  assert.deepEqual(result.knownRed, []);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'protocol'));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'runner' && diagnostic.message.includes('loader unavailable')));
  assert.doesNotMatch(JSON.stringify(result), /D3ExitCanary42/);
});

for (const [code, message] of [
  ['INVENTORY_INCOMPLETE', 'Configured unit file is absent: test/d3-absent.test.ts'],
  ['CONFIGURATION_INVALID', 'Invalid diagnostics/maxMessageBytes: expected a positive integer'],
]) {
  test(`D3 ${code} preserves the safe reason independently of generic hints`, () => {
    const context = fixtureContext();
    const result = testRunFailureResult(
      fixtureRequest(), context, 'd3-preflight', 1_800_000_000_000, fixtureConfig(),
      Object.assign(new Error(message), { code }),
    );
    assert.equal(result.outcome, 'refused');
    assert.equal(result.errorCode, code);
    assert.equal(result.workspace, context.workspace);
    assert.deepEqual(result.knownRed, []);
    assert.ok(result.hints.length > 0);
    const diagnostic = result.diagnostics.find(value => value.kind === 'preflight');
    assert.ok(diagnostic);
    assert.equal(diagnostic.test, null);
    assert.equal(diagnostic.errorCode, code);
    assert.ok(diagnostic.message.includes(message));
    assert.notEqual(diagnostic.message, `${code}: ${code}`);
    noInventedExit(result);
  });
}

test('D3 real invalid diagnostic configuration names the field before spawn', async () => {
  const harness = new RunHarness();
  harness.config.diagnostics.maxMessageBytes = 0;
  const result = await runTestRun(fixtureRequest(), harness.config, policy, harness.context, harness.ports);
  assert.equal(harness.spawns.length, 0);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, 'CONFIGURATION_INVALID');
  const diagnostic = result.diagnostics.find(value => value.kind === 'preflight');
  assert.ok(diagnostic);
  assert.equal(diagnostic.errorCode, 'CONFIGURATION_INVALID');
  assert.match(diagnostic.message, /maxMessageBytes/);
  assert.doesNotMatch(diagnostic.message, /diagnostic configuration unavailable/);
  noInventedExit(result);
});

test('D3 stale inventory names the missing selected file before spawn', async () => {
  const harness = new RunHarness();
  const missing = harness.config.projects.raf.profiles.node.unitFiles.at(-1)!;
  delete harness.environment.files[missing];
  harness.environment.unitFiles = harness.environment.unitFiles.filter(file => file !== missing);
  const result = await runTestRun(fixtureRequest({ files: [missing] }), harness.config, policy, harness.context, harness.ports);
  assert.equal(harness.spawns.length, 0);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, 'INVENTORY_INCOMPLETE');
  assert.equal(result.workspace, harness.context.workspace);
  const diagnostic = result.diagnostics.find(value => value.kind === 'preflight');
  assert.ok(diagnostic);
  assert.equal(diagnostic.errorCode, 'INVENTORY_INCOMPLETE');
  assert.ok(diagnostic.message.includes(missing));
  assert.deepEqual(result.knownRed, []);
  noInventedExit(result);
});
