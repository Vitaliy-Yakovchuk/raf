import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { run, test } from 'node:test';
import report from '../src/test-run-reporter.ts';
import {
  buildDiagnosticEnvironment,
  TestRunDiagnostics,
  type DiagnosticLimits,
  type DiagnosticRunFacts,
} from '../src/test-run-diagnostics.ts';
import {
  classifyRunnerResult,
  testRunFailureResult,
  validateTestRunConfig,
  type RunnerEvent,
  type TestRunConfig,
  type TestRunContext,
  type TestRunRequest,
  type UnitTestPolicy,
} from '../src/test-runs.ts';

const configured = JSON.parse(readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8')) as TestRunConfig;
const policy = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8')).unitTests as UnitTestPolicy;
const group = 'add-raf-test-run/diagnostics-qa-regressions';
const workspace = resolve(process.cwd());
const limits: DiagnosticLimits = structuredClone(configured.diagnostics);
const environment = buildDiagnosticEnvironment({
  executable: process.execPath,
  runtimeVersion: process.version,
  adapter: 'node-test-events',
  isolation: 'process',
  configurationBytes: { flow: new Uint8Array(), testRuns: new Uint8Array(), projects: new Uint8Array() },
  tmpPath: '/tmp/diagnostics-qa-regressions',
  privateRunTmp: true,
});

async function reportRelativeFixture(source: string, signal: AbortSignal): Promise<RunnerEvent[]> {
  const directory = await mkdtemp(join(workspace, '.raf-diagnostics-qa-'));
  const absoluteFile = join(directory, 'file-level.test.mjs');
  const file = relative(workspace, absoluteFile);
  const observed: { stderr: boolean; fileFailure: boolean } = { stderr: false, fileFailure: false };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    assert.equal(isAbsolute(file), false, 'the real runner must receive a relative filename');
    await writeFile(absoluteFile, source);
    const stream = run({ files: [file], isolation: 'process', execArgv: [], signal: controller.signal });
    async function* observe(): AsyncGenerator<unknown> {
      for await (const event of stream) {
        if (event.type === 'test:stderr' && event.data.file && resolve(event.data.file) === absoluteFile) observed.stderr = true;
        if (event.type === 'test:fail' && event.data.file && resolve(event.data.file) === absoluteFile) observed.fileFailure = true;
        yield event;
      }
    }
    const events: RunnerEvent[] = [];
    for await (const line of report(observe())) events.push(JSON.parse(line) as RunnerEvent);
    assert.equal(observed.stderr, true, 'fixture must produce real node:test stderr');
    assert.equal(observed.fileFailure, true, 'fixture must produce a real node:test file failure');
    assert.ok(events.some(event => event.kind === 'complete'), 'reporter must finish its protocol');
    const classification = classifyRunnerResult(events, { exitCode: 1, signal: null, stderr: '' });
    assert.equal(classification.outcome, 'setup-failed');
    assert.deepEqual(classification.knownRed, [], 'fixture setup is not an assertion red');
    return events;
  } finally {
    signal.removeEventListener('abort', abort);
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
}

test('D2a: real node:test relative-file missing import retains ERR_MODULE_NOT_FOUND', async t => {
  const events = await reportRelativeFixture("import './missing-d2a-dependency.mjs';\n", t.signal);
  const diagnostics = events.flatMap(event => event.kind === 'setup-failed' && event.inlineDiagnostic ? [event.inlineDiagnostic] : []);
  assert.ok(diagnostics.length > 0, 'file setup failure must include inline diagnostic');
  assert.ok(diagnostics.some(entry => entry.kind === 'setup' && /ERR_MODULE_NOT_FOUND/.test(`${entry.errorCode ?? ''} ${entry.message}`)), 'setup diagnostic must preserve the actual import cause');
});

test('D2a: real node:test relative-file top-level throw retains safe cause and masks password', async t => {
  const canary = 'D2A_PASSWORD_CANARY_762f9b';
  const events = await reportRelativeFixture(`throw new Error('D2a top-level fixture failure password=${canary}');\n`, t.signal);
  const diagnostics = events.flatMap(event => event.kind === 'setup-failed' && event.inlineDiagnostic ? [event.inlineDiagnostic] : []);
  assert.ok(diagnostics.some(entry => entry.kind === 'setup' && entry.message.includes('D2a top-level fixture failure')), 'setup diagnostic must preserve the actual top-level error message');
  assert.equal(JSON.stringify(events).includes(canary), false, 'reporter JSON must mask the synthetic password');
  assert.ok(diagnostics.some(entry => entry.redacted), 'secret masking must be explicit');
});

function stackDiagnostic(secret: boolean): ReturnType<TestRunDiagnostics['attach']> {
  const collector = new TestRunDiagnostics(limits, { workspace, qaHome: '/tmp/qa-diagnostics-home', fixtureRoots: [] });
  const error = new Error('safe stack failure');
  error.stack = `Error: safe stack failure\n    at check (${join(workspace, 'test/stack-only.test.ts')}:12:7)${secret ? `\n    at password=D3A_STACK_CANARY_504f8a (${join(workspace, 'test/stack-only.test.ts')}:15:2)` : ''}`;
  collector.failure({ test: { file: 'test/stack-only.test.ts', name: 'stack case' }, origin: 'test-body', error });
  const facts: DiagnosticRunFacts = {
    runId: 'd3a-stack', outcome: 'assertions-failed', failureKinds: ['assertions'],
    knownRed: [{ file: 'test/stack-only.test.ts', name: 'stack case' }],
    unexecuted: [], unknown: [], timeoutCount: 0, timedOut: false,
    cleanup: { complete: true, remainingPids: [] }, evidence: [],
  };
  return collector.attach(facts, environment);
}

test('D3a: making an absolute workspace stack relative does not mark it redacted', () => {
  const result = stackDiagnostic(false);
  assert.equal(result.diagnostics.length, 1);
  const entry = result.diagnostics[0];
  assert.ok(entry.stack.some(frame => frame.includes('test/stack-only.test.ts:12:7')), 'safe workspace frame must survive normalization');
  assert.equal(JSON.stringify(entry).includes(workspace), false, 'workspace prefix must be removed');
  assert.equal(entry.redacted, false, 'workspace path normalization alone is not secret redaction');
  assert.equal(result.diagnosticSummary.redacted, false);
});

test('D3a: the same workspace stack with a password is redacted', () => {
  const result = stackDiagnostic(true);
  assert.equal(result.diagnostics.length, 1);
  const entry = result.diagnostics[0];
  assert.ok(entry.stack.some(frame => frame.includes('test/stack-only.test.ts:12:7')));
  assert.equal(JSON.stringify(result).includes('D3A_STACK_CANARY_504f8a'), false);
  assert.equal(entry.redacted, true);
  assert.equal(result.diagnosticSummary.redacted, true);
});

function groupConfiguration(outsideInventory: boolean): TestRunConfig {
  const file = outsideInventory ? 'test/outside-unit-inventory.test.ts' : 'test/allowed-unit.test.ts';
  return {
    ...structuredClone(configured),
    projects: {
      raf: {
        profiles: { node: { ...structuredClone(configured.projects.raf.profiles.node), unitFiles: ['test/allowed-unit.test.ts', 'test/control-unit.test.ts'] } },
        groups: { [group]: { profileId: 'node', files: [file] } },
      },
    },
  };
}

function invalidGroupError(config: TestRunConfig): unknown {
  try {
    validateTestRunConfig(config, Object.keys(configured.phases), policy);
  } catch (error) {
    assert.equal((error as { code?: string }).code, 'CONFIGURATION_INVALID');
    return error;
  }
  assert.fail('a group file outside profile unitFiles must be rejected');
}

test('D3b control: otherwise identical group inside unitFiles is valid', () => {
  assert.doesNotThrow(() => validateTestRunConfig(groupConfiguration(false), Object.keys(configured.phases), policy));
});

test('D3b: invalid group response retains the configuration address and reason', () => {
  const config = groupConfiguration(true);
  const error = invalidGroupError(config);
  const request: TestRunRequest = { project: 'raf', phase: 'red', group, files: ['test/allowed-unit.test.ts'] };
  const context: TestRunContext = {
    cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] },
    agentPhases: Object.keys(configured.phases), activeChanges: ['add-raf-test-run'],
    agentId: 'diagnostics-qa-regression-fixture', sha: 'fixture-sha',
    home: '/tmp/qa-diagnostics-home', statePath: '/tmp/qa-diagnostics-home/.raf/state.sqlite',
    tmpPath: '/tmp/qa-diagnostics-home/.raf/tmp', operationalHome: '/tmp/operational-diagnostics-home',
  };
  const result = testRunFailureResult(request, context, 'd3b-invalid-group', 0, config, error);
  assert.equal(result.errorCode, 'CONFIGURATION_INVALID');
  const entry = result.diagnostics.find(diagnostic => diagnostic.kind === 'preflight');
  assert.ok(entry, 'configuration refusal must expose a preflight diagnostic');
  assert.equal(entry.test, null);
  assert.equal(entry.errorCode, 'CONFIGURATION_INVALID');
  assert.ok(entry.message.includes(`projects/raf/groups/${group}`), 'safe configuration address must be present in the response diagnostic');
  assert.match(entry.message, /unitFiles|unit[ -](?:file|inventory)|інвентар/iu, 'diagnostic must explain the group inventory violation');
  assert.doesNotMatch(entry.message, /diagnostic configuration unavailable/i);
  assert.equal(result.command, null, 'configuration refusal occurs before spawn');
  assert.equal(result.timedOut, false);
});
