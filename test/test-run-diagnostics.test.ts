import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  TestRunDiagnostics,
  buildDiagnosticEnvironment,
  cleanupRunTemporaryDirectory,
  deliverDiagnosticResult,
  diagnosticFailureFromNodeEvent,
  prepareRunTemporaryDirectory,
  validateDiagnosticLimits,
  validateRunTemporaryConfiguration,
} from '../src/test-run-diagnostics.ts';
import type {
  DiagnosticEnvironmentInput,
  DiagnosticFailure,
  DiagnosticLimits,
  DiagnosticOrigin,
  DiagnosticRunFacts,
  InlineDiagnostic,
  NodeDiagnosticEvent,
  RunTemporaryContext,
  RunTemporaryIdentity,
  RunTemporaryPorts,
} from '../src/test-run-diagnostics.ts';

const id = { file: 'test/behavior.test.ts', name: 'keeps [exact] identity' };
const otherId = { file: 'test/behavior.test.ts', name: 'unfinished parent' };
const paths = { workspace: '/workspace/raf', qaHome: '/private/qa/home', fixtureRoots: ['/private/fixture'] };
const limits: DiagnosticLimits = {
  maxEntries: 8,
  maxMessageBytes: 256,
  maxStackFrames: 4,
  maxStackBytes: 512,
  maxTotalBytes: 4096,
  maxProtocolLineBytes: 1024,
  maxStderrBytes: 128,
  redactionPatterns: ['CANARY_[A-Z0-9_]+'],
};
const environmentInput: DiagnosticEnvironmentInput = {
  executable: '/opt/node/bin/node', runtimeVersion: 'v-test', adapter: 'node-test-events', isolation: 'process',
  configurationBytes: {
    flow: Buffer.from('{"unitTests":{"timeoutMs":123}}'),
    testRuns: Buffer.from('{"configured":"runner"}'), projects: Buffer.from('{"raf":"develop"}'),
  },
  tmpPath: '/tmp/r/one', privateRunTmp: true,
};

function facts(overrides: Partial<DiagnosticRunFacts> = {}): DiagnosticRunFacts {
  return {
    runId: 'current-run', outcome: 'assertions-failed', failureKinds: ['assertions'], knownRed: [id],
    unexecuted: [otherId], unknown: [], timeoutCount: 1, timedOut: false, cleanup: 'complete', evidence: [],
    ...overrides,
  };
}

function collector(overrides: Partial<DiagnosticLimits> = {}): TestRunDiagnostics {
  return new TestRunDiagnostics({ ...limits, ...overrides }, paths);
}

function attached(value: TestRunDiagnostics, input = facts()) {
  return value.attach(input, buildDiagnosticEnvironment(environmentInput));
}

function assertion(message = 'expected the completed state'): DiagnosticFailure {
  return {
    test: id, origin: 'test-body',
    error: {
      name: 'AssertionError', code: 'ERR_ASSERTION', message, generatedMessage: false,
      stack: `AssertionError: ${message}\n    at verify (/workspace/raf/test/behavior.test.ts:42:7)\n    at fixture (/private/fixture/check.ts:3:2)`,
    },
  };
}

function nodeFailure(error: unknown, origin?: DiagnosticOrigin): NodeDiagnosticEvent {
  return {
    type: 'test:fail', data: {
      file: id.file, name: id.name, line: 42, column: 7,
      details: { error, ...(origin ? { diagnosticOrigin: origin } : {}) },
    },
  };
}

function onlyDiagnostic(value: TestRunDiagnostics): InlineDiagnostic {
  const result = attached(value);
  assert.equal(result.diagnostics.length, 1);
  return result.diagnostics[0]!;
}

function validUtf8(value: string): void {
  assert.equal(Buffer.from(value).toString('utf8'), value);
  assert.ok(!value.includes('\ufffd'));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)));
}

test('diagnostics: testCodeFailure unwraps cause, explicit assertion message and numeric location', () => {
  const cause = (assertion().error as Record<string, unknown>);
  const input = diagnosticFailureFromNodeEvent(nodeFailure({
    name: 'Error', code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure',
    message: 'test failed', cause,
  }));
  assert.ok(input);
  assert.deepEqual(input.test, id);
  assert.equal(input.origin, 'test-body');
  const value = collector();
  assert.deepEqual(value.failure(input), { failureKind: 'assertions', knownRed: id });
  const result = attached(value);
  const entry = result.diagnostics[0]!;
  assert.equal(entry.kind, 'assertion');
  assert.deepEqual(entry.test, result.knownRed[0]);
  assert.equal(entry.errorName, 'AssertionError');
  assert.equal(entry.errorCode, 'ERR_ASSERTION');
  assert.equal(entry.message, 'expected the completed state');
  assert.deepEqual(entry.location, { file: id.file, line: 42, column: 7 });
  assert.ok(entry.stack.some(frame => frame.includes('test/behavior.test.ts:42:7')));
  assert.deepEqual(result.evidence, []);
});

test('diagnostics: nested causes select inner assertion frame rather than wrapper location', () => {
  const value = collector();
  value.failure({ ...assertion(), location: { file: '/workspace/raf/src/wrapper.ts', line: 99, column: 1 },
    error: { name: 'Error', message: 'outer', cause: { name: 'Error', cause: assertion().error } } });
  assert.deepEqual(onlyDiagnostic(value).location, { file: id.file, line: 42, column: 7 });
});

test('diagnostics: missing location and stack remain explicit without invented frames', () => {
  const value = collector();
  value.failure({ test: id, origin: 'test-body', error: { name: 'AssertionError', message: 'safe explicit', generatedMessage: false } });
  const entry = onlyDiagnostic(value);
  assert.equal(entry.message, 'safe explicit');
  assert.equal(entry.location, null);
  assert.deepEqual(entry.stack, []);
  assert.ok(entry.unavailableReason);
});

test('diagnostics: explicit line and column survive absent stack', () => {
  const value = collector();
  value.failure({ test: id, origin: 'test-body', error: { name: 'AssertionError', message: 'safe' },
    location: { file: '/workspace/raf/test/behavior.test.ts', line: 12, column: 9 } });
  assert.deepEqual(onlyDiagnostic(value).location, { file: id.file, line: 12, column: 9 });
});

test('diagnostics: subtestsFailed container creates no duplicate assertion', () => {
  const output = diagnosticFailureFromNodeEvent(nodeFailure({ failureType: 'subtestsFailed', message: '1 subtest failed' }));
  assert.equal(output, null);
});

for (const code of ['DUPLICATE_ARGUMENT', 'ARBITRARY_PRODUCT_ERROR', undefined]) {
  test(`diagnostics: structured body throw ${code ?? 'without code'} is test-failure and knownRed`, () => {
    const value = collector();
    const input = diagnosticFailureFromNodeEvent(nodeFailure({
      name: 'Error', failureType: 'testCodeFailure', cause: { name: 'TypeError', code, message: 'product rejected input' },
    }));
    assert.ok(input);
    assert.deepEqual(value.failure(input), { failureKind: 'assertions', knownRed: id });
    const entry = onlyDiagnostic(value);
    assert.equal(entry.kind, 'test-failure');
    assert.equal(entry.errorName, 'TypeError');
    assert.equal(entry.errorCode, code);
    assert.equal(entry.message, 'product rejected input');
  });
}

for (const origin of ['import', 'collection', 'hook', 'fixture-setup', 'unknown'] as const) {
  test(`diagnostics: AssertionError from ${origin} stays setup and cannot establish red`, () => {
    const value = collector();
    assert.deepEqual(value.failure({ ...assertion('FAIL assertion in setup'), origin }), { failureKind: 'setup', knownRed: null });
    assert.equal(onlyDiagnostic(value).kind, 'setup');
  });
  test(`diagnostics: explicit ${origin} marker overrides testCodeFailure name`, () => {
    const input = diagnosticFailureFromNodeEvent(nodeFailure({ failureType: 'testCodeFailure', cause: assertion().error }, origin));
    assert.ok(input);
    assert.equal(input.origin, origin);
  });
}

test('diagnostics: unknown origin is not inferred from AssertionError or failure text', () => {
  const value = collector();
  const input = diagnosticFailureFromNodeEvent(nodeFailure({ name: 'AssertionError', message: 'testCodeFailure DUPLICATE_ARGUMENT FAIL' }));
  assert.ok(input);
  assert.equal(input.origin, 'unknown');
  assert.deepEqual(value.failure(input), { failureKind: 'setup', knownRed: null });
  assert.ok(onlyDiagnostic(value).unavailableReason);
});

test('diagnostics: preflight preserves errorCode/message and checked workspace independently of hint', () => {
  const value = collector();
  value.preflight({ code: 'INVENTORY_INCOMPLETE', message: 'inventory differs at /workspace/raf/test/absent.test.ts' });
  const result = value.attach({ ...facts({ outcome: 'refused', knownRed: [], failureKinds: ['refusal'] }),
    command: { cwd: '/workspace/raf' }, workspace: '/workspace/raf', hints: ['generic hint'] }, buildDiagnosticEnvironment(environmentInput));
  assert.equal(result.diagnostics[0]!.kind, 'preflight');
  assert.equal(result.diagnostics[0]!.test, null);
  assert.equal(result.diagnostics[0]!.errorCode, 'INVENTORY_INCOMPLETE');
  assert.match(result.diagnostics[0]!.message, /inventory differs/);
  assert.equal(result.command.cwd, '/workspace/raf');
  assert.equal(result.workspace, '/workspace/raf');
  assert.deepEqual(result.hints, ['generic hint']);
});

test('diagnostics: missing error has safe placeholder and explicit unavailability', () => {
  const value = collector();
  value.failure({ test: null, origin: 'import', error: undefined });
  const entry = onlyDiagnostic(value);
  assert.equal(entry.test, null);
  assert.equal(entry.kind, 'setup');
  assert.ok(entry.message.length > 0);
  assert.ok(entry.unavailableReason);
  assert.equal(entry.location, null);
});

test('diagnostics: received assertion/setup facts remain ordered in mixed result', () => {
  const value = collector();
  value.failure(assertion('first body assertion'));
  value.failure({ test: null, origin: 'import', error: { name: 'SyntaxError', message: 'module unavailable' } });
  value.failure({ ...assertion('second body assertion'), test: otherId });
  const input = facts({ outcome: 'setup-failed', failureKinds: ['assertions', 'setup'], knownRed: [id, otherId] });
  const result = attached(value, input);
  assert.deepEqual(result.diagnostics.map(entry => entry.kind), ['assertion', 'setup', 'assertion']);
  assert.deepEqual(result.diagnostics.map(entry => entry.message), ['first body assertion', 'module unavailable', 'second body assertion']);
  for (const key of Object.keys(input) as (keyof DiagnosticRunFacts)[]) assert.deepEqual(result[key], input[key]);
});

for (const outcome of ['timed-out', 'interrupted'] as const) {
  test(`diagnostics: ${outcome} retains current facts and preserves timeout/cleanup accounting`, () => {
    const value = collector();
    value.failure(assertion());
    const input = facts({ outcome, failureKinds: ['assertions', outcome === 'timed-out' ? 'timeout' : 'interruption'],
      timedOut: outcome === 'timed-out', timeoutCount: outcome === 'timed-out' ? 2 : 1, cleanup: 'incomplete' });
    const result = attached(value, input);
    assert.equal(result.diagnostics[0]!.message, 'expected the completed state');
    for (const key of Object.keys(input) as (keyof DiagnosticRunFacts)[]) assert.deepEqual(result[key], input[key]);
  });
}

test('diagnostics: only confirmation keeps unexecuted knownRed without copying previous run messages', () => {
  const previous = collector();
  previous.failure(assertion('OLD MESSAGE MUST NOT BECOME CURRENT'));
  const before = attached(previous);
  const current = collector();
  current.failure({ ...assertion('current failure'), test: otherId });
  const result = attached(current, facts({ runId: 'confirmation', knownRed: [id, otherId], timedOut: true, outcome: 'timed-out' }));
  assert.deepEqual(result.knownRed, [id, otherId]);
  assert.equal(result.runId, 'confirmation');
  assert.ok(!JSON.stringify(result).includes('OLD MESSAGE'));
  assert.deepEqual(result.diagnostics.map(entry => entry.test), [otherId]);
  assert.equal(before.runId, 'current-run');
});

test('diagnostics: recovery explains lost details without inventing historical assertions or pass', () => {
  const value = collector();
  value.recoveredDetailsUnavailable('wrapper ended before diagnostics were committed');
  const result = attached(value, facts({ runId: 'recovered-run', outcome: 'timed-out', timedOut: true, cleanup: 'incomplete' }));
  assert.equal(result.outcome, 'timed-out');
  assert.deepEqual(result.knownRed, [id]);
  assert.equal(result.timeoutCount, 1);
  assert.ok(result.diagnostics.some(entry => entry.unavailableReason));
  assert.ok(result.diagnostics.every(entry => entry.kind !== 'assertion'));
  assert.equal(result.cleanup, 'incomplete');
});

test('diagnostics: child exit without protocol retains bounded stderr, never infers red from FAIL', () => {
  const value = collector();
  value.stderrChunk(Buffer.from('FAIL AssertionError safe startup reason'));
  value.childExit({ exitCode: 1, signal: null, validProtocol: false });
  const result = attached(value, facts({ outcome: 'setup-failed', knownRed: [], failureKinds: ['setup'] }));
  assert.ok(result.diagnostics.some(entry => entry.kind === 'protocol' && entry.unavailableReason));
  assert.ok(result.diagnostics.some(entry => entry.kind === 'runner' && entry.message.includes('safe startup reason')));
  assert.deepEqual(result.knownRed, []);
  assert.equal(result.outcome, 'setup-failed');
});

test('diagnostics: exit zero and raw stdout do not turn absent protocol into passed', () => {
  const value = collector();
  value.protocolChunk(Buffer.from('PASS all tests passed\n'));
  value.childExit({ exitCode: 0, signal: null, validProtocol: false });
  const result = attached(value, facts({ outcome: 'setup-failed', failureKinds: ['setup'], knownRed: [] }));
  assert.ok(result.diagnostics.some(entry => entry.kind === 'protocol'));
  assert.equal(result.outcome, 'setup-failed');
  assert.deepEqual(result.knownRed, []);
});

test('diagnostics: stderr quota does not change a valid passed outcome', () => {
  const value = collector();
  for (let index = 0; index < 100; index++) value.stderrChunk(Buffer.from('noise'.repeat(100)));
  value.childExit({ exitCode: 0, signal: null, validProtocol: true });
  const result = attached(value, facts({ outcome: 'passed', failureKinds: [], knownRed: [], unexecuted: [], timeoutCount: 0 }));
  assert.equal(result.outcome, 'passed');
  assert.equal(result.diagnosticSummary.truncated, true);
});

const canaries = [
  ['authorization', 'Authorization: Bearer synthBearerSecret384', 'synthBearerSecret384'],
  ['cookie', 'Cookie: session=synthCookieSecret384', 'synthCookieSecret384'],
  ['password', 'password=synthPasswordSecret384', 'synthPasswordSecret384'],
  ['token', 'token=synthTokenSecret384', 'synthTokenSecret384'],
  ['private-key', '-----BEGIN PRIVATE KEY-----\nsynthPrivateKeySecret384\n-----END PRIVATE KEY-----', 'synthPrivateKeySecret384'],
  ['URL credentials/query', 'https://synthUrlUser384:synthUrlPassword384@example.invalid/path?access=synthUrlQuerySecret384', 'synthUrlQuerySecret384'],
  ['configured pattern', 'custom CANARY_CUSTOM_384', 'CANARY_CUSTOM_384'],
] as const;

for (const [label, text, secret] of canaries) {
  test(`diagnostics: ${label} is redacted in message/stack/cause/stderr before transport and last aggregate`, async () => {
    const value = collector({ maxMessageBytes: 1024, maxStackBytes: 1024, maxTotalBytes: 8192 });
    value.failure({ test: id, origin: 'test-body', error: {
      failureType: 'testCodeFailure', cause: {
        name: 'AssertionError', message: `safe context ${text}`, generatedMessage: false,
        stack: `AssertionError: ${text}\n    at check (/workspace/raf/test/behavior.test.ts:42:7)\n    at ${text} (/private/fixture/check.ts:1:2)`,
      },
    } });
    value.stderrChunk(Buffer.from(text));
    value.childExit({ exitCode: 1, signal: null, validProtocol: false });
    const result = attached(value);
    const transported: unknown[] = [];
    const aggregate: unknown[] = [];
    await deliverDiagnosticResult(result, {
      emitTransport: async output => { transported.push(JSON.parse(JSON.stringify(output))); },
      replaceLastAggregateResult: async output => { aggregate.push(JSON.parse(JSON.stringify(output))); },
    });
    for (const output of [result, ...transported, ...aggregate]) {
      const serialized = JSON.stringify(output);
      assert.ok(!serialized.includes(secret));
      assert.ok(!serialized.includes('synthUrlUser384'));
      assert.ok(!serialized.includes('synthUrlPassword384'));
      assert.ok(!serialized.includes('/private/fixture'));
    }
    assert.equal(result.diagnostics[0]!.redacted, true);
    assert.equal(result.diagnosticSummary.redacted, true);
    assert.match(result.diagnostics[0]!.message, /safe context/);
    assert.deepEqual(transported, [result]);
    assert.deepEqual(aggregate, [result]);
  });
}

test('diagnostics: actual/expected, generated diff and arbitrary error properties never serialize', () => {
  const value = collector();
  value.failure({ test: id, origin: 'test-body', error: {
    name: 'AssertionError', code: 'ERR_ASSERTION', generatedMessage: true, operator: 'deepStrictEqual',
    message: '+ ACTUAL_CANARY_DIFF\n- EXPECTED_CANARY_DIFF', actual: { secret: 'ACTUAL_CANARY_DIFF' },
    expected: 'EXPECTED_CANARY_DIFF', report: 'REPORT_CANARY', brief: 'BRIEF_CANARY',
    env: { SECRET: 'ENV_CANARY' }, buffer: Buffer.from('BUFFER_CANARY'),
    stack: 'AssertionError: + ACTUAL_CANARY_DIFF\n    at verify (/workspace/raf/test/behavior.test.ts:42:7)',
  } });
  const result = attached(value);
  const serialized = JSON.stringify(result);
  for (const secret of ['ACTUAL_CANARY_DIFF', 'EXPECTED_CANARY_DIFF', 'REPORT_CANARY', 'BRIEF_CANARY', 'ENV_CANARY', 'BUFFER_CANARY']) {
    assert.ok(!serialized.includes(secret));
  }
  assert.match(result.diagnostics[0]!.message, /deepStrictEqual|assertion/i);
  assert.equal(result.diagnostics[0]!.redacted, true);
  assert.equal(result.diagnostics[0]!.location!.line, 42);
});

test('diagnostics: opaque/cyclic errors use safe placeholders without toString or property getters', () => {
  let accessed = 0;
  const error: Record<string, unknown> = { name: 'Error' };
  error.cause = error;
  Object.defineProperty(error, 'message', { get() { accessed++; throw new Error('GETTER_CANARY'); } });
  error.toString = () => { accessed++; throw new Error('TOSTRING_CANARY'); };
  const value = collector();
  assert.doesNotThrow(() => value.failure({ test: id, origin: 'unknown', error }));
  const entry = onlyDiagnostic(value);
  assert.equal(accessed, 0);
  assert.ok(entry.unavailableReason);
  assert.ok(!JSON.stringify(entry).includes('GETTER_CANARY'));
});

test('diagnostics: ANSI/control characters and private path prefixes are removed without executing shell text', () => {
  const value = collector({ maxMessageBytes: 1024 });
  value.failure(assertion('\u001b[31msafe\u001b[0m\u0000\u0007 $(touch /tmp/DIAG_DO_NOT_EXECUTE) /private/qa/home/file /private/fixture/check.ts /outside/private/file'));
  const entry = onlyDiagnostic(value);
  assert.ok(!/[\u0000\u0007\u001b]/u.test(entry.message));
  assert.match(entry.message, /safe/);
  assert.ok(!entry.message.includes('/private/qa/home'));
  assert.ok(!entry.message.includes('/private/fixture'));
  assert.ok(!entry.message.includes('/outside/private'));
  assert.match(entry.message, /<qa-home>/);
  assert.match(entry.message, /<fixture>/);
  assert.match(entry.message, /<external>/);
  assert.equal(entry.redacted, true);
});

test('diagnostics: prefix lookalikes are external rather than workspace-relative', () => {
  const value = collector();
  value.failure({ ...assertion(), error: { name: 'AssertionError', message: 'explicit', stack: 'at check (/workspace/raf-other/private.ts:3:4)' } });
  const entry = onlyDiagnostic(value);
  assert.ok(!JSON.stringify(entry).includes('/workspace/raf-other'));
  assert.ok(entry.stack.some(frame => frame.includes('<external>/')));
});

test('diagnostics: truncation uses UTF-8 byte limits, leaves valid JSON and preserves IDs/accounting', () => {
  const value = collector({ maxMessageBytes: 31, maxStackFrames: 2, maxStackBytes: 96 });
  value.failure(assertion('Ж🙂漢'.repeat(1000)));
  const result = attached(value);
  const entry = result.diagnostics[0]!;
  validUtf8(entry.message);
  assert.ok(Buffer.byteLength(entry.message) <= 31);
  assert.ok(entry.stack.length <= 2);
  assert.ok(Buffer.byteLength(JSON.stringify(entry.stack)) <= 96);
  assert.equal(entry.truncated, true);
  assert.equal(result.diagnosticSummary.truncated, true);
  assert.deepEqual(result.knownRed, [id]);
  assert.equal(result.timeoutCount, 1);
  assert.equal(result.cleanup, 'complete');
});

test('diagnostics: redaction precedes truncation and does not expose a secret prefix', () => {
  const value = collector({ maxMessageBytes: 24 });
  value.failure(assertion('token=CANARY_SECRET_'.padEnd(10000, 'Z')));
  const entry = onlyDiagnostic(value);
  assert.ok(!entry.message.includes('CANARY'));
  assert.equal(entry.redacted, true);
  validUtf8(entry.message);
});

test('diagnostics: entry cap has accurate summary even when omitted details contain secrets', () => {
  const value = collector({ maxEntries: 2 });
  for (let index = 0; index < 20; index++) value.failure(assertion(index < 2 ? `failure ${index}` : 'token=CANARY_OMITTED'));
  const result = attached(value);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnosticSummary.totalEntries, 20);
  assert.equal(result.diagnosticSummary.retainedEntries, 2);
  assert.equal(result.diagnosticSummary.omittedEntries, 18);
  assert.equal(result.diagnosticSummary.truncated, true);
  assert.ok(!JSON.stringify(result).includes('CANARY_OMITTED'));
  assert.equal(result.diagnosticSummary.redacted, true);
  assert.deepEqual(result.knownRed, [id]);
});

test('diagnostics: serialized diagnostics and summary together obey total byte budget', () => {
  const value = collector({ maxTotalBytes: 640, maxMessageBytes: 128 });
  for (let index = 0; index < 100; index++) value.failure(assertion('Ж🙂'.repeat(1000)));
  const result = attached(value);
  const block = JSON.stringify({ diagnostics: result.diagnostics, diagnosticSummary: result.diagnosticSummary });
  assert.ok(Buffer.byteLength(block) <= 640);
  assert.equal(result.diagnosticSummary.totalEntries, 100);
  assert.equal(result.diagnosticSummary.omittedEntries, 100 - result.diagnostics.length);
  assert.equal(result.diagnosticSummary.retainedEntries, result.diagnostics.length);
  assert.equal(result.diagnosticSummary.truncated, true);
  validUtf8(block);
});

for (const format of ['no-newline', 'newline-in-one-chunk', 'many-chunks'] as const) {
  test(`diagnostics: oversized protocol ${format} is bounded while reading and remains invalid after drain`, () => {
    const value = collector();
    value.failure(assertion());
    const huge = Buffer.from('Ж'.repeat(1024 * 1024));
    if (format === 'no-newline') value.protocolChunk(huge);
    if (format === 'newline-in-one-chunk') value.protocolChunk(Buffer.concat([huge, Buffer.from('\n')]));
    if (format === 'many-chunks') for (let index = 0; index < 64; index++) value.protocolChunk(huge.subarray(0, 32768));
    assert.ok(value.readState().protocolBufferedBytes <= limits.maxProtocolLineBytes);
    assert.equal(value.readState().protocolRejected, true);
    for (let index = 0; index < 8; index++) {
      value.protocolChunk(huge);
      assert.ok(value.readState().protocolBufferedBytes <= limits.maxProtocolLineBytes);
    }
    value.childExit({ exitCode: 0, signal: null, validProtocol: false });
    const result = attached(value, facts({ outcome: 'setup-failed', failureKinds: ['assertions', 'setup'] }));
    assert.ok(result.diagnostics.some(entry => entry.kind === 'protocol'));
    assert.deepEqual(result.knownRed, [id]);
    assert.equal(result.outcome, 'setup-failed');
  });
}

test('diagnostics: multimegabyte stderr is bounded before exit and after every chunk', () => {
  const value = collector();
  const chunk = Buffer.from('Ж🙂'.repeat(20000));
  for (let index = 0; index < 32; index++) {
    value.stderrChunk(chunk);
    assert.ok(value.readState().stderrBufferedBytes <= limits.maxStderrBytes);
  }
  assert.equal(value.readState().stderrTruncated, true);
  value.childExit({ exitCode: 1, signal: null, validProtocol: false });
  const result = attached(value, facts({ outcome: 'setup-failed', knownRed: [] }));
  assert.equal(result.diagnosticSummary.truncated, true);
  for (const entry of result.diagnostics) validUtf8(entry.message);
});

test('diagnostics: UTF-8 and redaction tokens split between stream chunks remain safe', () => {
  const value = collector();
  const bytes = Buffer.from('safe Ж🙂 token=CANARY_STREAM_SECRET');
  for (const byte of bytes) value.stderrChunk(Uint8Array.of(byte));
  value.childExit({ exitCode: 1, signal: null, validProtocol: false });
  const result = attached(value);
  assert.ok(!JSON.stringify(result).includes('CANARY_STREAM_SECRET'));
  for (const entry of result.diagnostics) validUtf8(entry.message);
  assert.ok(result.diagnostics.some(entry => entry.kind === 'runner' && entry.message.includes('Ж🙂')));
});

for (const key of ['maxEntries', 'maxMessageBytes', 'maxStackFrames', 'maxStackBytes', 'maxTotalBytes', 'maxProtocolLineBytes', 'maxStderrBytes'] as const) {
  for (const invalid of [undefined, 0, -1, 1.5, NaN, Infinity, '128']) {
    test(`diagnostics: invalid ${key}=${String(invalid)} refuses configuration without fallback`, () => {
      assert.throws(() => validateDiagnosticLimits({ ...limits, [key]: invalid }), { code: 'CONFIGURATION_INVALID' });
    });
  }
}

test('diagnostics: invalid patterns and incompatible summary budget refuse configuration', () => {
  for (const redactionPatterns of [undefined, ['['], [7], 'token']) {
    assert.throws(() => validateDiagnosticLimits({ ...limits, redactionPatterns }), { code: 'CONFIGURATION_INVALID' });
  }
  assert.throws(() => validateDiagnosticLimits({ ...limits, maxTotalBytes: 1 }), { code: 'CONFIGURATION_INVALID' });
  assert.deepEqual(validateDiagnosticLimits(limits), limits);
});

test('diagnostics: environment reports actual runtime/isolation and hashes read conf bytes without dumping them', () => {
  const result = buildDiagnosticEnvironment(environmentInput);
  assert.equal(result.executable, environmentInput.executable);
  assert.equal(result.runtimeVersion, 'v-test');
  assert.equal(result.adapter, 'node-test-events');
  assert.equal(result.isolation, 'process');
  for (const key of ['flow', 'testRuns', 'projects'] as const) {
    assert.equal(result.configurationFingerprints[key], createHash('sha256').update(environmentInput.configurationBytes[key]).digest('hex'));
  }
  assert.equal(result.tmpPathBytes, Buffer.byteLength(environmentInput.tmpPath));
  assert.equal(result.privateRunTmp, true);
  assert.ok(!JSON.stringify(result).includes('timeoutMs'));
  assert.ok(!JSON.stringify(result).includes(environmentInput.tmpPath));
  const changed = buildDiagnosticEnvironment({ ...environmentInput, configurationBytes: { ...environmentInput.configurationBytes, flow: Buffer.from('changed') } });
  assert.notEqual(changed.configurationFingerprints.flow, result.configurationFingerprints.flow);
  assert.equal(changed.configurationFingerprints.projects, result.configurationFingerprints.projects);
});

test('diagnostics: delivery replaces last aggregate result and propagates failed transport without success', async () => {
  const value = collector();
  value.failure(assertion());
  const result = attached(value);
  let last: unknown;
  const transports: unknown[] = [];
  const ports = {
    emitTransport: async (output: unknown) => { transports.push(output); },
    replaceLastAggregateResult: async (output: unknown) => { last = output; },
  };
  await deliverDiagnosticResult(result, ports);
  const nextValue = collector();
  nextValue.failure(assertion('next run'));
  const next = attached(nextValue, facts({ runId: 'next-run' }));
  await deliverDiagnosticResult(next, ports);
  assert.deepEqual(last, next);
  assert.deepEqual(transports, [result, next]);
  await assert.rejects(deliverDiagnosticResult(next, { ...ports, emitTransport: async () => { throw new Error('transport unavailable'); } }), /transport unavailable/);
});

function temporaryHarness() {
  const root: RunTemporaryIdentity = { path: '/tmp/r', realpath: '/tmp/r', device: '1', inode: 'root', uid: 1234, mode: 0o700, symlink: false };
  const owned: RunTemporaryIdentity = { ...root, path: '/tmp/r/x', realpath: '/tmp/r/x', inode: 'run', runId: 'run-a' };
  const entries = new Map<string, RunTemporaryIdentity>([[root.path, root]]);
  const calls: string[] = [];
  const reservations: unknown[] = [];
  const context: RunTemporaryContext = {
    runId: 'run-a', uid: 1234, qaHome: '/private/qa/' + 'long/'.repeat(30), statePath: '/private/qa/state.sqlite',
    stateTmpPath: '/private/qa/.raf/tmp', workspace: '/workspace/raf', workingStatePath: '/private/working/.raf',
  };
  const ports: RunTemporaryPorts = {
    socketPathCapacityBytes: () => 108,
    inspect: async path => { calls.push(`inspect:${path}`); return entries.get(path) ?? null; },
    createPrivateDirectory: async (path, runId) => { calls.push(`create:${path}:${runId}`); entries.set(owned.path, owned); return { ...owned }; },
    saveReservation: async reservation => { calls.push('reserve'); reservations.push(reservation); },
    removeOwnedDirectory: async identity => { calls.push(`remove:${identity.path}`); entries.delete(identity.path); },
  };
  return { root, owned, entries, calls, reservations, context, ports, configuration: { root: root.path, minimumNestedSocketPathBytes: 80 } };
}

test('diagnostics tmp: compact private run directory changes TMPDIR while retaining QA HOME/state/aggregate context', async () => {
  const h = temporaryHarness();
  const result = await prepareRunTemporaryDirectory(h.configuration, h.context, h.ports);
  assert.equal(result.environment.TMPDIR, h.owned.path);
  assert.equal(result.environment.HOME, h.context.qaHome);
  assert.equal(result.environment.RAF_QA_HOME, h.context.qaHome);
  assert.equal(result.statePath, h.context.statePath);
  assert.equal(result.stateTmpPath, h.context.stateTmpPath);
  assert.notEqual(result.environment.TMPDIR, result.stateTmpPath);
  assert.ok(Buffer.byteLength(result.environment.TMPDIR) + h.configuration.minimumNestedSocketPathBytes < h.ports.socketPathCapacityBytes());
  assert.deepEqual(result.reservation, { runId: h.context.runId, temporary: h.owned });
  assert.deepEqual(h.reservations, [result.reservation]);
  assert.ok(!h.calls.some(call => call.includes(h.context.workingStatePath)));
});

test('diagnostics tmp: owner-private mode and realpath are checked after directory creation', async () => {
  const h = temporaryHarness();
  await prepareRunTemporaryDirectory(h.configuration, h.context, h.ports);
  assert.ok(h.calls.includes(`inspect:${h.owned.path}`));
  assert.ok(h.calls.indexOf(`inspect:${h.owned.path}`) < h.calls.indexOf('reserve'));
});

for (const mutation of ['long-root', 'foreign-owner', 'symlink', 'realpath-alias', 'nonprivate', 'workspace', 'working-state', 'qa-state'] as const) {
  test(`diagnostics tmp: ${mutation} refuses setup before creating run artifacts with no fallback`, async () => {
    const h = temporaryHarness();
    if (mutation === 'long-root') h.configuration.root = '/tmp/' + 'long'.repeat(30);
    if (mutation === 'foreign-owner') h.root.uid = 4321;
    if (mutation === 'symlink') h.root.symlink = true;
    if (mutation === 'realpath-alias') h.root.realpath = '/other/private/root';
    if (mutation === 'nonprivate') h.root.mode = 0o777;
    if (mutation === 'workspace') h.context.workspace = '/tmp/r';
    if (mutation === 'working-state') h.context.workingStatePath = '/tmp/r';
    if (mutation === 'qa-state') h.context.stateTmpPath = '/tmp/r';
    await assert.rejects(prepareRunTemporaryDirectory(h.configuration, h.context, h.ports), (error: unknown) => {
      const failure = error as { diagnostic?: InlineDiagnostic };
      assert.equal(failure.diagnostic?.kind, 'setup');
      assert.ok(failure.diagnostic?.message);
      return true;
    });
    assert.ok(!h.calls.some(call => call.startsWith('create:')));
    assert.deepEqual(h.reservations, []);
    assert.ok(!h.calls.some(call => call.includes('/private/working/.raf')));
  });
}

test('diagnostics tmp: expanded candidate that exhausts nested socket capacity is refused before reservation', async () => {
  const h = temporaryHarness();
  h.owned.path = '/tmp/r/' + 'x'.repeat(70);
  h.owned.realpath = h.owned.path;
  await assert.rejects(prepareRunTemporaryDirectory(h.configuration, h.context, h.ports));
  assert.deepEqual(h.reservations, []);
});

for (const key of ['uid', 'symlink', 'realpath', 'mode'] as const) {
  test(`diagnostics tmp: unsafe created directory ${key} never becomes a reservation`, async () => {
    const h = temporaryHarness();
    if (key === 'uid') h.owned.uid = 4321;
    if (key === 'symlink') h.owned.symlink = true;
    if (key === 'realpath') h.owned.realpath = '/private/other';
    if (key === 'mode') h.owned.mode = 0o777;
    await assert.rejects(prepareRunTemporaryDirectory(h.configuration, h.context, h.ports));
    assert.deepEqual(h.reservations, []);
    assert.ok(!h.calls.some(call => call.startsWith('remove:')));
  });
}

for (const point of ['create', 'reserve'] as const) {
  test(`diagnostics tmp: ${point} failure propagates without returning a usable TMPDIR`, async () => {
    const h = temporaryHarness();
    if (point === 'create') h.ports.createPrivateDirectory = async () => { throw new Error('disk unavailable'); };
    if (point === 'reserve') h.ports.saveReservation = async () => { throw new Error('reservation unavailable'); };
    await assert.rejects(prepareRunTemporaryDirectory(h.configuration, h.context, h.ports), /unavailable/);
    assert.deepEqual(h.reservations, []);
  });
}

test('diagnostics tmp: cleanup removes only confirmed owned directory after tree termination', async () => {
    const h = temporaryHarness();
    h.entries.set(h.owned.path, { ...h.owned });
    const reservation = { runId: 'run-a', temporary: { ...h.owned } };
    const result = await cleanupRunTemporaryDirectory(reservation, true, h.ports);
    assert.equal(result.cleanup, 'complete');
    assert.equal(result.diagnostic, null);
    assert.deepEqual(h.calls.filter(call => call.startsWith('remove:')), [`remove:${h.owned.path}`]);
    assert.ok(!h.entries.has(h.owned.path));
    assert.ok(h.entries.has(h.root.path));
});

for (const mismatch of ['inode', 'device', 'uid', 'realpath', 'symlink', 'mode', 'run-id', 'missing-run-id', 'live-tree'] as const) {
  test(`diagnostics tmp: ${mismatch} blocks removal and exposes incomplete cleanup`, async () => {
    const h = temporaryHarness();
    const reservation = { runId: 'run-a', temporary: { ...h.owned } };
    const current = { ...h.owned };
    if (mismatch === 'inode') current.inode = 'reused';
    if (mismatch === 'device') current.device = 'another';
    if (mismatch === 'uid') current.uid = 4321;
    if (mismatch === 'realpath') current.realpath = '/foreign';
    if (mismatch === 'symlink') current.symlink = true;
    if (mismatch === 'mode') current.mode = 0o777;
    if (mismatch === 'run-id') current.runId = 'other-run';
    if (mismatch === 'missing-run-id') delete current.runId;
    h.entries.set(current.path, current);
    const result = await cleanupRunTemporaryDirectory(reservation, mismatch !== 'live-tree', h.ports);
    assert.equal(result.cleanup, 'incomplete');
    assert.ok(result.diagnostic?.message);
    assert.ok(!h.calls.some(call => call.startsWith('remove:')));
    assert.ok(h.entries.has(current.path));
  });
}

test('diagnostics tmp: already absent owned directory is idempotently complete without removing parent', async () => {
  const h = temporaryHarness();
  const result = await cleanupRunTemporaryDirectory({ runId: 'run-a', temporary: h.owned }, true, h.ports);
  assert.equal(result.cleanup, 'complete');
  assert.ok(!h.calls.some(call => call.startsWith('remove:')));
});

test('diagnostics tmp: deletion error remains incomplete and never removes another path', async () => {
  const h = temporaryHarness();
  h.entries.set(h.owned.path, h.owned);
  h.ports.removeOwnedDirectory = async () => { throw new Error('filesystem refused cleanup'); };
  const result = await cleanupRunTemporaryDirectory({ runId: 'run-a', temporary: h.owned }, true, h.ports);
  assert.equal(result.cleanup, 'incomplete');
  assert.ok(result.diagnostic?.message);
  assert.ok(h.entries.has(h.owned.path));
});

test('diagnostics tmp: configuration requires explicit canonical root and valid nested socket reserve', () => {
  for (const invalid of [undefined, {}, { root: 'relative', minimumNestedSocketPathBytes: 80 },
    { root: '/tmp/r', minimumNestedSocketPathBytes: 0 }, { root: '/tmp/r', minimumNestedSocketPathBytes: NaN },
    { root: '/tmp/r', minimumNestedSocketPathBytes: 1.5 }]) {
    assert.throws(() => validateRunTemporaryConfiguration(invalid), { code: 'CONFIGURATION_INVALID' });
  }
  const valid = { root: '/tmp/r', minimumNestedSocketPathBytes: 80 };
  assert.deepEqual(validateRunTemporaryConfiguration(valid), valid);
});

for (const data of [Buffer.from('{invalid-json}\n'), Uint8Array.of(0xff, 0xfe, 0x0a)]) {
  test(`diagnostics: malformed protocol ${Buffer.from(data).toString('hex')} is explicit without losing known facts`, () => {
    const value = collector();
    value.failure(assertion());
    value.protocolChunk(data);
    value.childExit({ exitCode: 0, signal: null, validProtocol: false });
    const result = attached(value, facts({ outcome: 'setup-failed', failureKinds: ['assertions', 'setup'] }));
    assert.ok(result.diagnostics.some(entry => entry.kind === 'protocol'));
    assert.deepEqual(result.knownRed, [id]);
    assert.equal(result.outcome, 'setup-failed');
    validUtf8(JSON.stringify(result));
  });
}

test('diagnostics: delivered result is safe before either output port sees it', async () => {
  const value = collector();
  value.failure(assertion('Authorization: Bearer synthUnsharedSecret578'));
  const result = attached(value);
  const check = async (output: unknown): Promise<void> => {
    assert.ok(!JSON.stringify(output).includes('synthUnsharedSecret578'));
  };
  await deliverDiagnosticResult(result, { emitTransport: check, replaceLastAggregateResult: check });
});

test('diagnostics tmp: candidate outside configured root is not trusted despite matching owner and mode', async () => {
  const h = temporaryHarness();
  h.owned.path = '/tmp/foreign/candidate';
  h.owned.realpath = h.owned.path;
  await assert.rejects(prepareRunTemporaryDirectory(h.configuration, h.context, h.ports));
  assert.deepEqual(h.reservations, []);
  assert.ok(!h.calls.some(call => call.startsWith('remove:')));
});

test('diagnostics: stack frame and byte caps drop source snippets and locals', () => {
  const value = collector({ maxStackFrames: 2, maxStackBytes: 128 });
  value.failure({ ...assertion(), error: {
    name: 'AssertionError', message: 'explicit safe explanation', generatedMessage: false,
    stack: 'AssertionError: safe\n' + Array.from({ length: 40 }, (_, index) => `    at check${index} (/workspace/raf/test/behavior.test.ts:${index + 1}:7)`).join('\n')
      + '\n  sourceSnippet = SNIPPET_VALUE_319\n  locals: LOCAL_VALUE_319',
  } });
  const entry = onlyDiagnostic(value);
  assert.ok(entry.stack.length <= 2);
  assert.ok(Buffer.byteLength(JSON.stringify(entry.stack)) <= 128);
  assert.ok(entry.stack.length > 0);
  assert.ok(!JSON.stringify(entry).includes('SNIPPET_VALUE_319'));
  assert.ok(!JSON.stringify(entry).includes('LOCAL_VALUE_319'));
  assert.equal(entry.truncated, true);
});
