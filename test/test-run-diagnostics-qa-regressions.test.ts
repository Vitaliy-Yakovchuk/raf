import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
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
  const driver = join(directory, 'runner.mjs');
  const reporter = new URL('../src/test-run-reporter.ts', import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    signal.throwIfAborted();
    assert.equal(isAbsolute(file), false, 'the real runner must receive a relative filename');
    await writeFile(absoluteFile, source);
    await writeFile(driver, `
import { resolve } from 'node:path';
import { run } from 'node:test';
const { default: report } = await import(process.argv[3]);
const file = process.argv[2];
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
const observed = { context: process.env.NODE_TEST_CONTEXT ?? null, stderrFiles: [], fileFailureFiles: [] };
const stream = run({ files: [file], isolation: 'process', execArgv: [], signal: controller.signal });
async function* observe() {
  for await (const event of stream) {
    if (event.data.file && resolve(event.data.file) === resolve(file)) {
      if (event.type === 'test:stderr') observed.stderrFiles.push(event.data.file);
      if (event.type === 'test:fail') observed.fileFailureFiles.push(event.data.file);
    }
    yield event;
  }
}
const events = [];
for await (const line of report(observe())) events.push(JSON.parse(line));
process.stdout.write(JSON.stringify({ observed, events }));
`);
    const stdout = await new Promise<string>((resolveOutput, reject) => {
      const child = execFile(process.execPath, [driver, file, reporter], { cwd: workspace, env }, (error, output) => {
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolveOutput(output);
      });
      const abort = (): void => { child.kill('SIGTERM'); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    const { observed, events } = JSON.parse(stdout) as {
      observed: { context: string | null; stderrFiles: string[]; fileFailureFiles: string[] };
      events: RunnerEvent[];
    };
    assert.equal(observed.context, null, 'fixture runner must start outside node:test context');
    assert.ok(observed.stderrFiles.length > 0, 'fixture must produce real node:test stderr');
    for (const stderrFile of observed.stderrFiles) {
      assert.equal(isAbsolute(stderrFile), false, 'real stderr must retain its relative filename');
      assert.equal(stderrFile, file);
    }
    assert.ok(observed.fileFailureFiles.length > 0, 'fixture must produce a real node:test file failure');
    for (const failureFile of observed.fileFailureFiles) {
      assert.equal(isAbsolute(failureFile), true, 'real file failure must retain its absolute filename');
      assert.equal(failureFile, absoluteFile);
    }
    assert.ok(events.some(event => event.kind === 'complete'), 'reporter must finish its protocol');
    const classification = classifyRunnerResult(events, { exitCode: 1, signal: null, stderr: '' });
    assert.equal(classification.outcome, 'setup-failed');
    assert.deepEqual(classification.knownRed, [], 'fixture setup is not an assertion red');
    return events;
  } finally {
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
