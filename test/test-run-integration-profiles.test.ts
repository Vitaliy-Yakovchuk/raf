import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareTestRunProfile,
  authorizeTestRunProfile,
  reserveTestRunProfile,
  completeTestRunProfile,
  testRunTransportDeadline,
  relayTestRunProfileResult,
  type ActiveTestGroup,
  type CallerContext,
  type ExecutionFacts,
  type InventoryFact,
  type PreparedTestRun,
  type SelectionRequest,
  type TestRunReservation,
} from '../src/test-run-integration-profiles.ts';

const integrationFile = 'test/resource-wait-service-stop-host.test.ts';
const integrationGroup = 'complete-raf-flow-contracts/resource-wait-service-stop-host';
const unitFile = 'test/unit-a.test.ts';
const unitGroup = 'add-raf-test-run/integration-profiles';
const workspace = '/qa/raf-develop';
const budgetPointer = 'conf/flow.json#/integrationTests/timeoutMs';
const profilePointer = 'conf/test-runs.json#/projects/raf/profiles/node-integration';
const redId = { file: integrationFile, name: 'service stop reaches client' };
const pendingId = { file: integrationFile, name: 'cleanup confirms runtime exit' };

type FixtureConfiguration = {
  phases: Record<string, { allowed: boolean; purpose: string; hints: Record<string, string> }>;
  hints: Record<string, string>;
  projects: Record<string, {
    profiles: Record<string, Record<string, unknown>>;
    groups: Record<string, { profileId: string; files: string[] }>;
  }>;
};

function fixture() {
  const node = {
    cwd: '.', executable: 'node', argv: ['./scripts/test-run-node.ts'],
    exactIds: 'node-test-name', resultAdapter: 'node-test-events',
    environment: { isolatedHome: true, stateOrigin: true },
    checks: ['node_modules/typescript/package.json', 'src/test-run-reporter.ts', 'scripts/test-run-node.ts'],
  };
  const hints = { refusal: 'fix selection', setup: 'fix setup', assertions: 'fix behavior', timeout: 'complete scenario', interruption: 'reconcile cleanup' };
  const configuration: FixtureConfiguration = {
    phases: Object.fromEntries(['red', 'implement', 'qa', 'hotfix', 'integration'].map(phase => [phase, {
      allowed: true, purpose: phase === 'red' ? 'initial-red' : 'verification', hints: Object.fromEntries(Object.keys(hints).map(key => [key, key])),
    }])),
    hints,
    projects: { raf: {
      profiles: {
        node: { ...node, unitFiles: [unitFile, 'test/unit-b.test.ts'] },
        'node-integration': { ...node, testKind: 'integration', integrationFiles: [integrationFile] },
      },
      groups: {
        [unitGroup]: { profileId: 'node', files: [unitFile] },
        [integrationGroup]: { profileId: 'node-integration', files: [integrationFile] },
      },
    } },
  };
  const flow: Record<string, unknown> = {
    unitTests: { timeoutMs: 31, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 },
    integrationTests: { timeoutMs: 211 },
  };
  const request: SelectionRequest = { project: 'raf', workspace, branch: 'develop', phase: 'integration', group: integrationGroup };
  const inventory: InventoryFact[] = [
    { file: unitFile, exists: true, canonicalInsideWorkspace: true, kind: 'unit' },
    { file: 'test/unit-b.test.ts', exists: true, canonicalInsideWorkspace: true, kind: 'unit' },
    { file: integrationFile, exists: true, canonicalInsideWorkspace: true, kind: 'integration' },
  ];
  return { configuration, flow, request, inventory };
}

function prepare(input = fixture()): PreparedTestRun {
  return prepareTestRunProfile(input.configuration, input.flow, input.request, input.inventory);
}

function caller(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    trusted: true, live: true, role: 'qa', phase: 'qa', project: 'raf', workspace, branch: 'develop',
    activeChanges: ['complete-raf-flow-contracts'], coordinatorAuthorized: false,
    sourceChange: 'complete-raf-flow-contracts', sourceItem: '13.5.1.2', regressionGroups: [],
    ...overrides,
  };
}

function plan(overrides: Partial<PreparedTestRun> = {}): PreparedTestRun {
  return {
    request: fixture().request, testKind: 'integration', profileId: 'node-integration',
    selection: { files: [integrationFile], testIds: [] },
    command: { executable: 'node', argv: ['./scripts/test-run-node.ts', integrationFile], cwd: workspace },
    timeoutPolicy: { source: budgetPointer, timeoutMs: 211 },
    unitPolicy: { optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 },
    ...overrides,
  };
}

function aggregate(overrides: Partial<ActiveTestGroup> = {}): ActiveTestGroup {
  return {
    key: { project: 'raf', workspace, group: integrationGroup },
    profileId: 'node-integration', testKind: 'integration', timeoutCount: 0,
    knownRed: [], unexecuted: [], unknown: [], inFlight: null, ...overrides,
  };
}

function reservation(overrides: Partial<TestRunReservation> = {}): TestRunReservation {
  const run = { runId: 'run-1', startedAtMs: 1000, deadlineMs: 1211, timeoutPolicy: { source: budgetPointer, timeoutMs: 211 } };
  return {
    plan: plan(), authorization: { callerPhase: 'qa', sourceChange: 'complete-raf-flow-contracts', sourceItem: '13.5.1.2' },
    run, disposition: 'spawn', aggregate: aggregate({ inFlight: run }), ...overrides,
  };
}

function execution(overrides: Partial<ExecutionFacts> = {}): ExecutionFacts {
  return {
    outcome: 'passed', exitCode: 0, signal: null, timedOut: false, protocolComplete: true,
    cleanup: { complete: true, remaining: [] }, passed: [redId, pendingId], knownRed: [], unexecuted: [], unknown: [],
    failureKinds: [], diagnostics: [], diagnosticSummary: {}, environmentSummary: { isolatedHome: true }, ...overrides,
  };
}

function refusal(action: () => unknown, code?: string, pointer?: string, file?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    const detail = error as Error & { code?: string; pointer?: string; file?: string };
    assert.notEqual(detail.message, 'NotImplemented');
    if (code) assert.equal(detail.code, code);
    if (pointer) assert.equal(detail.pointer, pointer);
    if (file) assert.ok(detail.file === file || detail.message.includes(file));
    return true;
  });
}

test('I01 legacy unit-only configuration needs neither kind nor integration budget', () => {
  const input = fixture();
  delete input.configuration.projects.raf.profiles['node-integration'];
  delete input.configuration.projects.raf.groups[integrationGroup];
  delete input.flow.integrationTests;
  input.request = { ...input.request, phase: 'qa', group: unitGroup };
  const resolved = prepare(input);
  assert.equal(resolved.testKind, 'unit');
  assert.deepEqual(resolved.timeoutPolicy, { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: 31 });
  assert.deepEqual(resolved.selection.files, [unitFile]);
});

test('I01 explicit unit is equivalent to omitted kind', () => {
  const input = fixture();
  input.request = { ...input.request, phase: 'qa', group: unitGroup };
  const legacy = prepare(input);
  input.configuration.projects.raf.profiles.node.testKind = 'unit';
  assert.deepEqual(prepare(input), legacy);
});

test('I01 full unit inventory is refused even when integration remains unselected', () => {
  const input = fixture();
  input.request = { ...input.request, phase: 'qa', group: unitGroup, files: [unitFile, 'test/unit-b.test.ts'] };
  refusal(() => prepare(input));
});

for (const [label, value] of [['missing', undefined], ['zero', 0], ['negative', -1], ['fractional', 1.5], ['string', '211'], ['null', null], ['boolean', true], ['infinite', Infinity], ['NaN', NaN]] as const) {
  test(`I02 integration budget ${label} refuses with exact pointer, no unit fallback`, () => {
    const input = fixture();
    if (value === undefined) delete input.flow.integrationTests;
    else input.flow.integrationTests = { timeoutMs: value };
    refusal(() => prepare(input), 'CONFIGURATION_INVALID', budgetPointer);
  });
}

for (const [label, mutate, pointer] of [
  ['missing kind with integration inventory', (p: Record<string, unknown>) => { delete p.testKind; }, `${profilePointer}/integrationFiles`],
  ['unknown kind', (p: Record<string, unknown>) => { p.testKind = 'stand'; }, `${profilePointer}/testKind`],
  ['both inventories', (p: Record<string, unknown>) => { p.unitFiles = [unitFile]; }, `${profilePointer}/unitFiles`],
  ['empty inventory', (p: Record<string, unknown>) => { p.integrationFiles = []; }, `${profilePointer}/integrationFiles`],
  ['missing inventory', (p: Record<string, unknown>) => { delete p.integrationFiles; }, `${profilePointer}/integrationFiles`],
  ['duplicate inventory', (p: Record<string, unknown>) => { p.integrationFiles = [integrationFile, integrationFile]; }, `${profilePointer}/integrationFiles`],
  ['unsupported adapter', (p: Record<string, unknown>) => { p.resultAdapter = 'vitest-events'; }, `${profilePointer}/resultAdapter`],
  ['unsupported exact IDs', (p: Record<string, unknown>) => { p.exactIds = 'vitest-test-name'; }, `${profilePointer}/exactIds`],
] as const) {
  test(`I02 ${label} is configuration failure before any reservation`, () => {
    const input = fixture();
    mutate(input.configuration.projects.raf.profiles['node-integration']);
    refusal(() => prepare(input), 'CONFIGURATION_INVALID', pointer);
  });
}

test('I02 explicit unit cannot contain an integration inventory', () => {
  const input = fixture();
  input.configuration.projects.raf.profiles.node.testKind = 'unit';
  input.configuration.projects.raf.profiles.node.integrationFiles = [integrationFile];
  refusal(() => prepare(input), 'CONFIGURATION_INVALID', 'conf/test-runs.json#/projects/raf/profiles/node/integrationFiles');
});

for (const crossKind of [false, true]) {
  test(`I02 repeated membership across ${crossKind ? 'kinds' : 'profiles'} is rejected`, () => {
    const input = fixture();
    if (crossKind) input.configuration.projects.raf.profiles.node.unitFiles = [unitFile, integrationFile];
    else input.configuration.projects.raf.profiles['second-integration'] = { ...input.configuration.projects.raf.profiles['node-integration'] };
    refusal(() => prepare(input), 'CONFIGURATION_INVALID', undefined, integrationFile);
  });
}

test('I02 inventory kind cannot be disguised as unit for a unit-phase bypass', () => {
  const input = fixture();
  input.configuration.projects.raf.profiles.node.unitFiles = [unitFile, integrationFile];
  delete input.configuration.projects.raf.profiles['node-integration'];
  delete input.configuration.projects.raf.groups[integrationGroup];
  input.request = { ...input.request, phase: 'qa', group: unitGroup, files: [integrationFile] };
  refusal(() => prepare(input), 'CONFIGURATION_INVALID', undefined, integrationFile);
});

for (const explicit of [false, true]) {
  test(`I03 singleton preset ${explicit ? 'with exact files' : 'without files'} is allowed`, () => {
    const input = fixture();
    if (explicit) input.request.files = [integrationFile];
    const resolved = prepare(input);
    assert.equal(resolved.testKind, 'integration');
    assert.equal(resolved.profileId, 'node-integration');
    assert.deepEqual(resolved.selection, { files: [integrationFile], testIds: [] });
    assert.deepEqual(resolved.command, { executable: 'node', argv: ['./scripts/test-run-node.ts', integrationFile], cwd: workspace });
    assert.deepEqual(resolved.timeoutPolicy, { source: budgetPointer, timeoutMs: 211 });
    assert.ok(!resolved.command.argv.includes('test/helpers/resource-wait-stop-host-fixture.ts'));
  });
}

for (const [label, files] of [
  ['empty', []], ['duplicate', [integrationFile, integrationFile]], ['extra', [integrationFile, unitFile]],
  ['directory', ['test']], ['glob', ['test/*.test.ts']], ['escape', ['../outside.test.ts']],
  ['option injection', ['--test-name-pattern=.*']], ['helper', ['test/helpers/resource-wait-stop-host-fixture.ts']],
] as const) {
  test(`I03 ${label} selection is refused`, () => {
    const input = fixture();
    input.request.files = [...files];
    refusal(() => prepare(input));
  });
}

test('I03 exact preset comparison is set equality, with no partial selection', () => {
  const input = fixture();
  const second = 'test/second-integration.test.ts';
  input.configuration.projects.raf.profiles['node-integration'].integrationFiles = [integrationFile, second];
  input.configuration.projects.raf.groups[integrationGroup].files.push(second);
  input.inventory.push({ file: second, exists: true, canonicalInsideWorkspace: true, kind: 'integration' });
  input.request.files = [second, integrationFile];
  assert.deepEqual(new Set(prepare(input).selection.files), new Set([integrationFile, second]));
  input.request.files = [integrationFile];
  refusal(() => prepare(input));
});

test('I03 no integration --only and no unknown preset', () => {
  const input = fixture();
  input.request.only = [redId];
  refusal(() => prepare(input));
  delete input.request.only;
  input.request.group = 'complete-raf-flow-contracts/unknown';
  refusal(() => prepare(input));
});

test('I03 mixed integration profiles cannot be selected together', () => {
  const input = fixture();
  const second = 'test/other-profile.test.ts';
  input.configuration.projects.raf.profiles.other = { ...input.configuration.projects.raf.profiles['node-integration'], integrationFiles: [second] };
  input.inventory.push({ file: second, exists: true, canonicalInsideWorkspace: true, kind: 'integration' });
  input.configuration.projects.raf.groups[integrationGroup].files.push(second);
  refusal(() => prepare(input));
});

for (const phase of ['red', 'implement', 'qa', 'hotfix']) {
  test(`I04 ${phase} never reclassifies an integration file as unit`, () => {
    const input = fixture();
    input.request.phase = phase;
    refusal(() => prepare(input));
  });
}

test('I04 integration phase never reclassifies unit profile', () => {
  const input = fixture();
  input.request.group = unitGroup;
  refusal(() => prepare(input));
});

for (const phase of ['implement', 'qa', 'hotfix']) {
  test(`I04 live trusted ${phase} may run own integration while preserving callerPhase`, () => {
    assert.equal(authorizeTestRunProfile(plan(), caller({ role: phase, phase })).callerPhase, phase);
  });
}

for (const role of ['main', 'coordinator']) {
  test(`I04 ${role} needs established coordinating authority`, () => {
    const context = caller({ role, phase: role, activeChanges: [], coordinatorAuthorized: true });
    assert.equal(authorizeTestRunProfile(plan(), context).callerPhase, role);
    refusal(() => authorizeTestRunProfile(plan(), { ...context, coordinatorAuthorized: false }), 'CALLER_UNAUTHORIZED');
  });
}

for (const role of ['spec', 'design', 'context-review', 'test-scaffold', 'integration', 'unknown']) {
  test(`I04 ${role} gets no integration permission from allowed=true or role text`, () => {
    refusal(() => authorizeTestRunProfile(plan(), caller({ role, phase: role, coordinatorAuthorized: true })), 'CALLER_UNAUTHORIZED');
  });
}

for (const [label, context] of [
  ['closed', { live: false }], ['untrusted', { trusted: false }], ['workspace mismatch', { workspace: '/qa/other' }],
  ['branch mismatch', { branch: 'main' }], ['project mismatch', { project: 'etchly' }], ['inactive change', { activeChanges: [] }],
  ['forged phase', { role: 'qa', phase: 'implement' }],
] satisfies [string, Partial<CallerContext>][]) {
  test(`I04 ${label} is rejected by the broker policy before state access`, () => {
    refusal(() => authorizeTestRunProfile(plan(), caller(context)), 'CALLER_UNAUTHORIZED');
  });
}

for (const grant of [false, true]) {
  test(`I05 foreign integration is forbidden ${grant ? 'even with exact unit grant 5.8' : 'despite a prose reference'}`, () => {
    refusal(() => authorizeTestRunProfile(plan(), caller({
      activeChanges: ['add-raf-test-run'], sourceChange: 'add-raf-test-run', sourceItem: '6.2.3',
      regressionGroups: grant ? [{ group: integrationGroup, profileId: 'node-integration', files: [integrationFile] }] : [],
    })), 'CALLER_UNAUTHORIZED');
  });
}

test('I05 own unit and exact foreign unit grant keep their existing phase rights', () => {
  const input = fixture();
  input.request = { ...input.request, phase: 'qa', group: unitGroup };
  const unit = prepare(input);
  assert.equal(authorizeTestRunProfile(unit, caller({ activeChanges: ['add-raf-test-run'], sourceChange: 'add-raf-test-run' })).callerPhase, 'qa');
  assert.equal(authorizeTestRunProfile(unit, caller({ regressionGroups: [{ group: unitGroup, profileId: 'node', files: [unitFile] }] })).callerPhase, 'qa');
  refusal(() => authorizeTestRunProfile({ ...unit, request: { ...unit.request, phase: 'hotfix' } }, caller()), 'CALLER_UNAUTHORIZED');
});

test('I06 changing unit budget leaves integration budget unchanged; next reservation reads new integration budget', () => {
  const input = fixture();
  const before = prepare(input);
  input.flow.unitTests = { timeoutMs: 999, optimizeAfterTimeouts: 1, maxGroupTimeouts: 2 };
  assert.deepEqual(prepare(input).timeoutPolicy, before.timeoutPolicy);
  input.flow.integrationTests = { timeoutMs: 307 };
  const next = reserveTestRunProfile(prepare(input), reservation().authorization, null, { runId: 'new', nowMs: 2000, agentId: 'qa-2', sha: 'new-sha' });
  assert.equal(next.run.deadlineMs, 2307);
  assert.deepEqual(next.run.timeoutPolicy, { source: budgetPointer, timeoutMs: 307 });
});

test('I06 in-flight recovery keeps persisted deadline and policy after conf and agent/SHA change', () => {
  const prior = reservation();
  const next = reserveTestRunProfile(plan({ timeoutPolicy: { source: budgetPointer, timeoutMs: 9999 } }), prior.authorization, prior.aggregate,
    { runId: 'retry', nowMs: 1100, agentId: 'another-agent', sha: 'another-sha' });
  assert.equal(next.disposition, 'reconcile');
  assert.deepEqual(next.run, prior.run);
  assert.deepEqual(next.aggregate.key, prior.aggregate.key);
  assert.deepEqual(completeTestRunProfile(next, execution()).result.timeoutPolicy, prior.run.timeoutPolicy);
});

test('I06 transport waits for the stored deadline even past readiness; cleanup gets no second budget', async () => {
  const current = reservation();
  assert.equal(testRunTransportDeadline(current, 7), current.run.deadlineMs);
  const decision = completeTestRunProfile(current, execution());
  let exchanges = 0;
  const envelope = { result: decision.result, stderr: 'sanitized stderr\n', cliCode: decision.cliCode };
  const returned = await relayTestRunProfileResult(current, async deadline => {
    exchanges++;
    assert.equal(deadline, current.run.deadlineMs);
    return structuredClone(envelope);
  });
  assert.equal(exchanges, 1);
  assert.deepEqual(returned, envelope);
});

test('I07 integration retries full preset beyond unit limits without reset or --only', () => {
  const prior = aggregate({ timeoutCount: 8, knownRed: [redId], unexecuted: [pendingId] });
  const next = reserveTestRunProfile(plan(), reservation().authorization, prior,
    { runId: 'run-9', nowMs: 2000, agentId: 'other-agent', sha: 'other-sha' });
  assert.equal(next.disposition, 'spawn');
  assert.equal(next.aggregate.timeoutCount, 8);
  assert.deepEqual(next.aggregate.key, prior.key);
  assert.deepEqual(next.aggregate.knownRed, [redId]);
  assert.deepEqual(next.aggregate.unexecuted, [pendingId]);
  assert.deepEqual(next.plan.selection, { files: [integrationFile], testIds: [] });
});

for (const legacy of [false, true]) {
  test(`I07 ${legacy ? 'legacy aggregate without kind is unit' : 'explicit unit aggregate'} cannot drift to integration`, () => {
    const prior = aggregate({ testKind: legacy ? undefined : 'unit' });
    refusal(() => reserveTestRunProfile(plan(), reservation().authorization, prior, { runId: 'drift', nowMs: 2000, agentId: 'qa', sha: 'sha' }));
  });
}

test('I07 integration cannot drift to unit or change its pinned profile', () => {
  const current = reservation();
  for (const changed of [plan({ testKind: 'unit' }), plan({ profileId: 'other-profile' })]) {
    refusal(() => reserveTestRunProfile(changed, current.authorization, aggregate(), { runId: 'drift', nowMs: 2000, agentId: 'qa', sha: 'sha' }));
  }
});

test('I07 legacy unit aggregate stays unit and retains known-red confirmation after the unit cap', () => {
  const current = reservation();
  const unit = plan({ testKind: 'unit', profileId: 'node', request: { ...fixture().request, phase: 'qa', group: unitGroup }, selection: { files: [unitFile], testIds: [{ file: unitFile, name: 'known red' }] }, timeoutPolicy: { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: 31 } });
  unit.request.only = unit.selection.testIds;
  const prior = aggregate({ key: { project: 'raf', workspace, group: unitGroup }, profileId: 'node', testKind: undefined, timeoutCount: 2, knownRed: unit.selection.testIds });
  const next = reserveTestRunProfile(unit, current.authorization, prior, { runId: 'unit-confirm', nowMs: 2000, agentId: 'qa', sha: 'sha' });
  assert.equal(next.aggregate.testKind, 'unit');
  assert.equal(next.aggregate.timeoutCount, 2);
  assert.deepEqual(next.plan.selection.testIds, prior.knownRed);
  assert.equal(next.run.deadlineMs, 2031);
  const unknownOnly = { ...unit, selection: { files: [unitFile], testIds: [{ file: unitFile, name: 'never observed red' }] }, request: { ...unit.request, only: [{ file: unitFile, name: 'never observed red' }] } };
  refusal(() => reserveTestRunProfile(unknownOnly, current.authorization, prior, { runId: 'unit-unknown', nowMs: 2000, agentId: 'qa', sha: 'sha' }), 'UNKNOWN_RED_TEST');
  const whole = { ...unit, request: { ...unit.request, only: undefined }, selection: { files: [unitFile], testIds: [] } };
  refusal(() => reserveTestRunProfile(whole, current.authorization, prior, { runId: 'unit-full', nowMs: 2000, agentId: 'qa', sha: 'sha' }));
});

test('I08 only fully confirmed integration completion is passed/complete with CLI zero', () => {
  const current = reservation();
  const decision = completeTestRunProfile(current, execution());
  assert.equal(decision.result.outcome, 'passed');
  assert.equal(decision.result.groupState, 'complete');
  assert.equal(decision.cliCode, 0);
  assert.equal(decision.result.phase, 'integration');
  assert.equal(decision.result.callerPhase, 'qa');
  assert.equal(decision.result.testKind, 'integration');
  assert.deepEqual(decision.result.timeoutPolicy, current.run.timeoutPolicy);
  assert.deepEqual(decision.result.command, current.plan.command);
  assert.deepEqual(decision.result.selection, current.plan.selection);
  assert.equal(decision.aggregate.inFlight, null);
});

for (const [label, facts] of [
  ['assertions', { outcome: 'assertions-failed', exitCode: 1, knownRed: [redId], failureKinds: ['assertions'] }],
  ['import', { outcome: 'setup-failed', exitCode: 1, protocolComplete: false, failureKinds: ['setup'] }],
  ['hook', { outcome: 'setup-failed', exitCode: 1, failureKinds: ['setup'], diagnostics: [{ kind: 'setup', message: 'hook failed', origin: 'hook' }] }],
  ['interrupted', { outcome: 'interrupted', exitCode: null, signal: 'SIGTERM', failureKinds: ['interruption'] }],
  ['refused', { outcome: 'refused', exitCode: null, failureKinds: ['refusal'] }],
  ['skipped', { unexecuted: [pendingId] }], ['unknown', { unknown: [pendingId] }],
  ['truncated protocol', { protocolComplete: false }], ['no confirmed tests', { passed: [], protocolComplete: true }],
  ['cleanup incomplete', { cleanup: { complete: false, remaining: ['owned-detached-child'] } }],
  ['inconsistent cleanup proof', { cleanup: { complete: true, remaining: ['owned-detached-child'] } }],
] satisfies [string, Partial<ExecutionFacts>][]) {
  test(`I08 ${label} never becomes pass or a unit-policy remainder`, () => {
    const decision = completeTestRunProfile(reservation(), execution(facts));
    assert.notEqual(decision.result.outcome, 'passed');
    assert.equal(decision.result.groupState, 'incomplete');
    assert.equal(decision.result.nextAction, 'complete-integration');
    assert.notEqual(decision.cliCode, 0);
    assert.equal(decision.result.timeoutCount, 0);
    assert.equal(decision.result.exitCode, facts.exitCode ?? (facts.exitCode === null ? null : 0));
  });
}

test('I08 timeout keeps knownRed and unfinished IDs, counts once, never opens unit exception', () => {
  const current = reservation({ aggregate: aggregate({ timeoutCount: 8, knownRed: [redId], unexecuted: [pendingId], inFlight: reservation().run }) });
  const facts = execution({ outcome: 'timed-out', timedOut: true, exitCode: null, signal: 'SIGKILL', passed: [], unexecuted: [pendingId], failureKinds: ['timeout'] });
  const first = completeTestRunProfile(current, facts);
  assert.equal(first.result.timeoutCount, 9);
  assert.equal(first.result.groupState, 'incomplete');
  assert.equal(first.result.nextAction, 'complete-integration');
  assert.deepEqual(first.result.knownRed, [redId]);
  assert.deepEqual(first.result.unexecuted, [pendingId]);
  assert.notEqual(first.cliCode, 0);
  const recovered = completeTestRunProfile({ ...current, aggregate: first.aggregate }, facts);
  assert.equal(recovered.aggregate.timeoutCount, 9);
  assert.deepEqual(recovered.aggregate.knownRed, [redId]);
});

test('I08 only actual confirmation clears knownRed; mixed failures preserve diagnostics', () => {
  const current = reservation({ aggregate: aggregate({ knownRed: [redId], inFlight: reservation().run }) });
  const partial = completeTestRunProfile(current, execution({ passed: [pendingId], protocolComplete: false }));
  assert.deepEqual(partial.result.knownRed, [redId]);
  assert.notEqual(partial.cliCode, 0);
  const confirmed = completeTestRunProfile(current, execution());
  assert.deepEqual(confirmed.result.knownRed, []);
  assert.equal(confirmed.cliCode, 0);
  const mixed = execution({ outcome: 'setup-failed', exitCode: 1, passed: [], knownRed: [redId], failureKinds: ['assertions', 'setup'], diagnostics: [
    { kind: 'assertions', message: 'service result mismatch', origin: 'test-body' },
    { kind: 'setup', message: 'import unavailable', origin: 'import' },
  ] });
  const result = completeTestRunProfile(reservation(), mixed).result;
  assert.deepEqual(result.failureKinds, mixed.failureKinds);
  assert.deepEqual(result.diagnostics, mixed.diagnostics);
  assert.deepEqual(result.knownRed, [redId]);
});

for (const [label, mutation] of [
  ['missing file', (i: InventoryFact) => { i.exists = false; }],
  ['symlink escape', (i: InventoryFact) => { i.canonicalInsideWorkspace = false; }],
] as const) {
  test(`I10 static preflight ${label} identifies file without discovery`, () => {
    const input = fixture();
    mutation(input.inventory.find(i => i.file === integrationFile)!);
    refusal(() => prepare(input), undefined, undefined, integrationFile);
  });
}

test('I10 absent nonselected raf integration registration does not block the exact preset', () => {
  const input = fixture();
  const stale = 'test/stale-integration.test.ts';
  input.configuration.projects.raf.profiles['node-integration'].integrationFiles = [integrationFile, stale];
  input.inventory.push({ file: stale, exists: false, canonicalInsideWorkspace: true, kind: 'integration' });
  const before = structuredClone(input.configuration);
  const resolved = prepare(input);
  assert.deepEqual(resolved.selection.files, [integrationFile]);
  assert.equal(resolved.profileId, 'node-integration');
  assert.deepEqual(input.configuration, before);
});

test('I12 relay preserves failure JSON, stderr, child code, diagnostics and policy independently of CLI code', async () => {
  const decision = completeTestRunProfile(reservation(), execution({ outcome: 'assertions-failed', exitCode: 17, knownRed: [redId], failureKinds: ['assertions'], diagnosticSummary: { assertions: 1 } }));
  const envelope = { result: decision.result, stderr: 'safe failure\n', cliCode: decision.cliCode };
  const received = await relayTestRunProfileResult(reservation(), async () => structuredClone(envelope));
  assert.deepEqual(received, envelope);
  assert.equal(received.result.exitCode, 17);
  assert.notEqual(received.cliCode, 0);
  for (const key of ['testKind', 'timeoutPolicy', 'callerPhase', 'diagnostics', 'environmentSummary', 'selection', 'cleanup', 'knownRed', 'unknown'] as const) {
    assert.deepEqual(received.result[key], envelope.result[key]);
  }
});

test('I12 transport loss is surfaced, never retried as a second spawn or replaced with pass', async () => {
  let calls = 0;
  await assert.rejects(() => relayTestRunProfileResult(reservation(), async () => {
    calls++;
    throw new Error('trusted channel unavailable');
  }), /trusted channel unavailable/);
  assert.equal(calls, 1);
});


test('I02 integration budget is validated even if the requested group is unit', () => {
  const input = fixture();
  delete input.flow.integrationTests;
  input.request = { ...input.request, phase: 'qa', group: unitGroup };
  refusal(() => prepare(input), 'CONFIGURATION_INVALID', budgetPointer);
});

test('I02 preset membership points to the exact stale configuration entry', () => {
  const input = fixture();
  input.configuration.projects.raf.groups[integrationGroup].files = ['test/unregistered.test.ts'];
  refusal(() => prepare(input), 'CONFIGURATION_INVALID', 'conf/test-runs.json#/projects/raf/groups/complete-raf-flow-contracts~1resource-wait-service-stop-host/files', 'test/unregistered.test.ts');
});

test('I01 legacy unit timeout still increments once and requests optimization', () => {
  const base = reservation();
  const unitPlan = plan({ testKind: 'unit', profileId: 'node', request: { ...fixture().request, phase: 'qa', group: unitGroup }, selection: { files: [unitFile], testIds: [] }, timeoutPolicy: { source: 'conf/flow.json#/unitTests/timeoutMs', timeoutMs: 31 } });
  const run = { ...base.run, deadlineMs: 1031, timeoutPolicy: unitPlan.timeoutPolicy };
  const current = { ...base, plan: unitPlan, run, aggregate: aggregate({ key: { project: 'raf', workspace, group: unitGroup }, profileId: 'node', testKind: undefined, inFlight: run }) };
  const decision = completeTestRunProfile(current, execution({ outcome: 'timed-out', exitCode: null, timedOut: true, passed: [], unexecuted: [{ file: unitFile, name: 'pending' }] }));
  assert.equal(decision.result.testKind, 'unit');
  assert.deepEqual(decision.result.timeoutPolicy, unitPlan.timeoutPolicy);
  assert.equal(decision.result.timeoutCount, 1);
  assert.equal(decision.result.nextAction, 'optimize');
  assert.notEqual(decision.cliCode, 0);
});


test('I06 changing integration budget leaves the unit budget unchanged', () => {
  const input = fixture();
  input.request = { ...input.request, phase: 'qa', group: unitGroup };
  const before = prepare(input).timeoutPolicy;
  input.flow.integrationTests = { timeoutMs: 997 };
  assert.deepEqual(prepare(input).timeoutPolicy, before);
});
