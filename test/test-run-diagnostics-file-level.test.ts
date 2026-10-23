import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  TestRunDiagnostics,
  buildDiagnosticEnvironment,
  diagnosticFailureFromNodeEvent,
} from '../src/test-run-diagnostics.ts';
import type { NodeDiagnosticEvent } from '../src/test-run-diagnostics.ts';
import report from '../src/test-run-reporter.ts';
import { classifyRunnerResult, runTestRun } from '../src/test-runs.ts';
import type {
  RunnerEvent, TestId, TestRunConfig, TestRunContext, TestRunGroup,
  TestRunPorts, TestRunResult, UnitTestPolicy,
} from '../src/test-runs.ts';

const workspace = process.cwd();
const file = 'test/d2-file-level-fixture.test.ts';
const absoluteFile = resolve(workspace, file);
const fileId = { file, name: file };
const bodyId = { file, name: 'product exception inside test body' };
const configurationBytes = readFileSync(new URL('../../conf/test-runs.json', import.meta.url));
const configuration: TestRunConfig = JSON.parse(configurationBytes.toString());
const policy: UnitTestPolicy = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8')).unitTests;
const environment = buildDiagnosticEnvironment({
  executable: process.execPath, runtimeVersion: process.version,
  adapter: 'node-test-events', isolation: 'mock-node-events',
  configurationBytes: { flow: new Uint8Array(), testRuns: configurationBytes, projects: new Uint8Array() },
  tmpPath: '/tmp/d2-unit-tmp', privateRunTmp: true,
});

function collector(): TestRunDiagnostics {
  return new TestRunDiagnostics(configuration.diagnostics, {
    workspace, qaHome: '/tmp/d2-unit-home', fixtureRoots: [],
  });
}

function fileFailure(name: string = file, cause?: unknown): NodeDiagnosticEvent {
  return {
    type: 'test:fail',
    data: {
      file: absoluteFile, name, line: 1, column: 1,
      details: {
        error: Object.assign(new Error('test failed'), {
          code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', exitCode: 1,
          ...(cause === undefined ? {} : { cause }),
        }),
      },
    },
  };
}

type SourceEvent = { type: string; data: Record<string, unknown> };

async function reporterEvents(source: readonly SourceEvent[]): Promise<RunnerEvent[]> {
  async function* input(): AsyncGenerator<SourceEvent> {
    yield* source;
  }
  const events: RunnerEvent[] = [];
  for await (const chunk of report(input())) {
    for (const line of chunk.split('\n').filter(Boolean)) events.push(JSON.parse(line));
  }
  return events;
}

function sourceFailure(stderr: string, name: string = file): SourceEvent[] {
  const failed = fileFailure(name);
  return [
    { type: 'test:stderr', data: { file: absoluteFile, message: stderr } },
    { type: failed.type, data: { ...failed.data, nesting: 0 } },
  ];
}

async function runWithEvents(events: RunnerEvent[]): Promise<{ result: TestRunResult; saved: TestRunGroup }> {
  const config = structuredClone(configuration);
  config.projects.raf.profiles.node.unitFiles = [file, 'test/d2-unselected.test.ts'];
  config.projects.raf.groups = {
    'add-raf-test-run/diagnostics-file-level': { profileId: 'node', files: [file] },
  };
  const context: TestRunContext = {
    cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] },
    agentPhases: Object.keys(config.phases), activeChanges: ['add-raf-test-run'],
    agentId: 'd2-unit-coordinator', sha: 'a'.repeat(40), home: '/tmp/d2-unit-home',
    statePath: '/tmp/d2-unit-home/.raf/state.sqlite', tmpPath: '/tmp/d2-unit-home/.raf/tmp',
    operationalHome: '/tmp/d2-working-home',
  };
  const groups = new Map<string, TestRunGroup>();
  const ports: TestRunPorts = {
    diagnosticEnvironment: () => environment,
    preflight: async () => ({
      canonicalWorkspace: workspace, canonicalCwd: workspace, gitIdentityMatches: true,
      runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true,
      resultAdapterAvailable: true, artifactsWritable: true, treeControlSupported: true,
      isolatedHome: true, stateOriginAllowed: true, stateAliasesOperational: false,
      tmpAliasesOperational: false, inheritedOperationalChannel: false,
      unitFiles: [file, 'test/d2-unselected.test.ts'],
      files: Object.fromEntries([file, 'test/d2-unselected.test.ts'].map(path => [path, {
        kind: 'file' as const, realpath: resolve(workspace, path), unit: true,
      }])),
    }),
    state: {
      transaction: async operation => operation({
        get: key => groups.get(JSON.stringify(key)) ?? null,
        list: (project, path) => [...groups.values()].filter(group => group.key.project === project && group.key.workspace === path),
        put: group => { groups.set(JSON.stringify(group.key), structuredClone(group)); },
        delete: key => { groups.delete(JSON.stringify(key)); },
      }),
    },
    clock: { now: () => 1000, schedule: () => () => {} },
    newRunId: () => 'd2-file-level-unit-run',
    spawn: async (_command, onEvent) => {
      events.forEach(onEvent);
      return {
        identity: 'mock-d2-process',
        wait: async () => ({ exitCode: 1, signal: null, stderr: '' }),
        cleanup: async () => ({ complete: true, remainingPids: [] }),
      };
    },
    subscribeInterruption: () => () => {},
    reconcile: async () => ({ alive: false, deadlineReached: false, cleanup: { complete: true, remainingPids: [] } }),
  };
  const result = await runTestRun({
    project: 'raf', phase: 'red', group: 'add-raf-test-run/diagnostics-file-level', files: [file],
  }, config, policy, context, ports);
  const saved = [...groups.values()][0];
  assert.ok(saved, 'run must persist the active group');
  return { result, saved };
}

for (const name of [file, absoluteFile]) {
  test(`D2 file-level testCodeFailure (${name === file ? 'relative' : 'absolute'} name) has setup origin`, () => {
    const failure = diagnosticFailureFromNodeEvent(fileFailure(name));
    assert.ok(failure, 'a file-level failure must retain a diagnostic');
    assert.notEqual(failure.origin, 'test-body', 'testCodeFailure alone does not establish test-body provenance');
    const disposition = collector().failure(failure);
    assert.equal(disposition.failureKind, 'setup');
    assert.equal(disposition.knownRed, null, 'a file placeholder cannot confirm red');
  });
}

for (const [label, error] of [
  ['missing import', Object.assign(new Error('Cannot find package d2-missing-module'), { code: 'ERR_MODULE_NOT_FOUND' })],
  ['top-level throw', new Error('D2 top-level initialization failed')],
  ['top-level AssertionError', Object.assign(new Error('D2 top-level assertion failed'), { name: 'AssertionError', code: 'ERR_ASSERTION' })],
] as const) {
  test(`D2 structured cause for ${label} remains setup and keeps the real message`, () => {
    const failure = diagnosticFailureFromNodeEvent(fileFailure(file, error));
    assert.ok(failure);
    const diagnostics = collector();
    const disposition = diagnostics.failure(failure);
    assert.equal(disposition.failureKind, 'setup');
    assert.equal(disposition.knownRed, null);
    const attached = diagnostics.attach({
      runId: 'd2-cause', outcome: 'setup-failed', failureKinds: ['setup'],
      knownRed: [], unknown: [fileId], unexecuted: [], timeoutCount: 0, timedOut: false,
      cleanup: { complete: true, remainingPids: [] }, evidence: [],
    }, environment);
    assert.ok(attached.diagnostics.some(entry => entry.kind === 'setup' && entry.message.includes(error.message)));
  });
}

const failures = [
  { label: 'missing import', reason: 'Cannot find package d2-missing-module', stderr: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package d2-missing-module\n    at load (node:internal/modules/esm/resolve:10:2)\n' },
  { label: 'top-level throw', reason: 'D2 initialization exploded', stderr: `Error: D2 initialization exploded\n    at ${absoluteFile}:4:7\n` },
  { label: 'top-level assertion', reason: 'D2 initialization assertion', stderr: `AssertionError [ERR_ASSERTION]: D2 initialization assertion\n    at ${absoluteFile}:5:3\n` },
  { label: 'syntax error before collection', reason: 'Unexpected token D2', stderr: `SyntaxError: Unexpected token D2\n    at ${absoluteFile}:2:1\n` },
];

for (const fixture of failures) {
  test(`D2 reporter classifies ${fixture.label} as setup with its stderr cause`, async () => {
    const events = await reporterEvents(sourceFailure(fixture.stderr));
    assert.equal(events.some(event => event.kind === 'assertion-failed'), false);
    const setup = events.find(event => event.kind === 'setup-failed');
    assert.ok(setup && setup.kind === 'setup-failed', 'file failure must be a setup event');
    assert.ok(setup.inlineDiagnostic, 'reporter must preserve the setup diagnostic');
    assert.equal(setup.inlineDiagnostic.kind, 'setup');
    assert.ok(setup.inlineDiagnostic.message.includes(fixture.reason), 'generic test failed cannot replace the real cause');
    if (fixture.label === 'missing import') assert.equal(setup.inlineDiagnostic.errorCode, 'ERR_MODULE_NOT_FOUND');
    const classified = classifyRunnerResult(events, { exitCode: 1, signal: null, stderr: fixture.stderr });
    assert.equal(classified.outcome, 'setup-failed');
    assert.deepEqual(classified.knownRed, []);
    assert.ok(classified.unknown.some(id => id.file === file), 'the file must remain unknown');
    assert.deepEqual(classified.passed, []);
  });

  test(`D2 initial red from ${fixture.label} requests fix-setup and persists no knownRed`, async () => {
    const { result, saved } = await runWithEvents(await reporterEvents(sourceFailure(fixture.stderr)));
    assert.equal(result.outcome, 'setup-failed');
    assert.ok(result.failureKinds.includes('setup'));
    assert.equal(result.failureKinds.includes('assertions'), false);
    assert.equal(result.nextAction, 'fix-setup');
    assert.deepEqual(result.knownRed, []);
    assert.ok(result.unknown.some(id => id.file === file));
    assert.ok(result.hintIds.includes(configuration.phases.red.hints.setup));
    assert.equal(result.hintIds.includes(configuration.phases.red.hints.assertions), false);
    assert.ok(result.diagnostics.some(entry => entry.kind === 'setup' && entry.message.includes(fixture.reason)));
    assert.equal(result.timedOut, false);
    assert.equal(result.timeoutCount, 0);
    assert.equal(result.cleanup.complete, true);
    assert.deepEqual(saved.knownRed, []);
    assert.equal(saved.lastResult?.outcome, 'setup-failed');
    assert.equal(saved.lastResult?.nextAction, 'fix-setup');
    assert.deepEqual(saved.lastResult?.diagnostics, result.diagnostics);
  });
}

test('D2 split stderr retains the real file-level cause', async () => {
  const source = sourceFailure('');
  source.splice(0, 1,
    { type: 'test:stderr', data: { file: absoluteFile, message: 'Error [ERR_MODULE_' } },
    { type: 'test:stderr', data: { file: absoluteFile, message: 'NOT_FOUND]: Cannot find package d2-split-import\n' } },
  );
  const events = await reporterEvents(source);
  assert.ok(events.some(event => event.kind === 'setup-failed' && event.inlineDiagnostic?.message.includes('d2-split-import')));
  assert.equal(events.some(event => event.kind === 'assertion-failed'), false);
});

test('D2 missing cause stays setup with explicit diagnostic unavailability', async () => {
  const events = await reporterEvents(sourceFailure(''));
  const setup = events.find(event => event.kind === 'setup-failed');
  assert.ok(setup && setup.kind === 'setup-failed');
  assert.equal(setup.inlineDiagnostic?.kind, 'setup');
  assert.ok(setup.inlineDiagnostic?.unavailableReason, 'missing underlying cause must be explicit');
  assert.deepEqual(classifyRunnerResult(events, { exitCode: 1, signal: null, stderr: '' }).knownRed, []);
});

test('D2 product Error in a confirmed test body still confirms assertion red', async () => {
  const cause = Object.assign(new Error('D2 product rejected argument'), { code: 'D2_PRODUCT_ERROR' });
  const data = { file: absoluteFile, name: bodyId.name, line: 12, column: 1, nesting: 0, type: 'test', testId: 1 };
  const events = await reporterEvents([
    { type: 'test:enqueue', data }, { type: 'test:dequeue', data }, { type: 'test:start', data },
    { type: 'test:fail', data: { ...data, details: { error: Object.assign(new Error('test failed'), {
      code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause,
    }) } } },
  ]);
  assert.ok(events.some(event => event.kind === 'assertion-failed' && event.inlineDiagnostic?.kind === 'test-failure'));
  const { result } = await runWithEvents(events);
  assert.equal(result.outcome, 'assertions-failed');
  assert.deepEqual(result.knownRed, [bodyId]);
  assert.equal(result.nextAction, 'implement');
  assert.ok(result.diagnostics.some(entry => entry.kind === 'test-failure' && entry.message.includes(cause.message)));
});

test('D2 mixed body red and another file import failure retains both facts and fixes setup first', async () => {
  const other = 'test/d2-other-file.test.ts';
  const events: RunnerEvent[] = [
    { kind: 'discovered', test: bodyId },
    { kind: 'assertion-failed', test: bodyId, diagnostic: 'D2 real body failure' },
    ...await reporterEvents([
      { type: 'test:stderr', data: { file: resolve(workspace, other), message: 'Error [ERR_MODULE_NOT_FOUND]: d2-other-missing\n' } },
      { type: 'test:fail', data: { ...fileFailure(other).data, file: resolve(workspace, other), nesting: 0 } },
    ]),
  ];
  const classified = classifyRunnerResult(events, { exitCode: 1, signal: null, stderr: '' });
  assert.equal(classified.outcome, 'setup-failed');
  assert.deepEqual(classified.knownRed, [bodyId]);
  assert.ok(classified.unknown.some(id => id.file === other));
});

test('D2 file-level failure without numeric location remains setup', () => {
  const event = fileFailure();
  delete event.data.line;
  delete event.data.column;
  const failure = diagnosticFailureFromNodeEvent(event);
  assert.ok(failure);
  const disposition = collector().failure(failure);
  assert.equal(disposition.failureKind, 'setup');
  assert.equal(disposition.knownRed, null);
});

test('D2 explicit test-body origin wins over a test name resembling its file', () => {
  const event = fileFailure(file, new Error('D2 named body failure'));
  event.data.line = 21;
  event.data.details.diagnosticOrigin = 'test-body';
  const failure = diagnosticFailureFromNodeEvent(event);
  assert.ok(failure);
  assert.equal(failure.origin, 'test-body');
  const disposition = collector().failure(failure);
  assert.equal(disposition.failureKind, 'assertions');
  assert.ok(disposition.knownRed);
});

test('D2 abrupt file exit cannot confirm initial red', async () => {
  const failed = fileFailure();
  Object.assign(failed.data.details.error as object, { exitCode: 7 });
  const events = await reporterEvents([{ type: failed.type, data: { ...failed.data, nesting: 0 } }]);
  const classified = classifyRunnerResult(events, { exitCode: 7, signal: null, stderr: '' });
  assert.equal(classified.outcome, 'setup-failed');
  assert.deepEqual(classified.knownRed, []);
  assert.ok(classified.unknown.some(id => id.file === file));
});
