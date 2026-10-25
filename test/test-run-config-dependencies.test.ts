import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTestRunConfigurationUnchanged, captureTestRunConfiguration, testRunConfigurationManifest,
  type ConfigurationValue, type TestRunConfigurationDependency, type TestRunConfigurationFailure,
  type TestRunConfigurationFile, type TestRunConfigurationReader, type TestRunConfigurationScope,
  type TestRunConfigurationSnapshot,
} from '../src/test-run-config-dependencies.ts';
import { runResourceReservedTestRun, type ResourceReservedTestRunResult } from '../src/test-run-reservations.ts';
import {
  config, context, copy, expectWaiting, file, fixture, key, machine, policy, request,
} from './helpers/test-run-reservations-fixture.ts';

const scope: TestRunConfigurationScope = {
  project: 'raf', profileId: 'node', group: request.group, phase: 'red', testKind: 'unit',
  resourceLevel: 'normal', projectProfileId: 'raf', agentPhaseIndex: 0, commandIndex: 0, runner: 'codex',
};
const dep = (file: TestRunConfigurationFile, pointer: string): TestRunConfigurationDependency => ({ file, pointer });
const address = (dependency: TestRunConfigurationDependency) => `${dependency.file}#${dependency.pointer}`;
const presetPointer = '/projects/raf/groups/fix-raf-load-admission~1test-reservations';
const unitManifest: TestRunConfigurationDependency[] = [
  dep('conf/test-runs.json', '/projects/raf/profiles/node'),
  dep('conf/test-runs.json', presetPointer),
  dep('conf/test-runs.json', '/phases/red'),
  dep('conf/test-runs.json', '/diagnostics'),
  dep('conf/test-runs.json', '/temporaryArtifacts'),
  dep('conf/projects.json', '/projects/raf/path'),
  dep('conf/projects.json', '/projects/raf/profile'),
  dep('conf/projects.json', '/projects/raf/branchPaths'),
  dep('conf/projects.json', '/profiles/raf'),
  dep('conf/flow.json', '/unitTests'),
  dep('conf/flow.json', '/resources/normal'),
  dep('conf/flow.json', '/resources/home'),
  dep('conf/raf-constants.json', '/agentPhases/0'),
  dep('conf/raf-constants.json', '/commands/0'),
  dep('conf/raf.json', '/resourceWait'),
  dep('conf/raf.json', '/runnerProtocols/codex'),
];

function documents(): Record<TestRunConfigurationFile, ConfigurationValue> {
  return {
    'conf/test-runs.json': copy(config) as unknown as ConfigurationValue,
    'conf/projects.json': {
      projects: {
        raf: { path: '/qa/workspace', profile: 'raf', branchPaths: { develop: '/qa/workspace', hotfix: '/qa/hotfix' } },
        etchly: { path: '/qa/etchly', profile: 'product', branchPaths: { develop: '/qa/etchly' } },
      },
      profiles: { raf: { runtime: 'node' }, product: { runtime: 'vitest' } },
    },
    'conf/flow.json': {
      unitTests: { ...policy }, integrationTests: { timeoutMs: 3000 },
      resources: { normal: { minRamBytes: 100 }, hotfix: { minRamBytes: 50 }, home: { minDiskBytes: 200 } },
      resourceEstimates: { agentTypes: { qa: { ramBytes: 100 } } },
      retention: { finishedSessionsMs: 4000 },
    },
    'conf/raf-constants.json': {
      agentPhases: [{ id: 'red' }, { id: 'qa' }],
      commands: [{ path: ['test', 'run'], permissions: ['red'] }, { path: ['stats'] }],
      events: [{ type: 'reminder' }],
    },
    'conf/raf.json': {
      resourceWait: { grantIntervalMs: 10 }, runnerProtocols: { codex: { timeouts: { pollMs: 20 } } },
      reminders: { enabled: true }, health: { summaryIntervalMs: 5000 },
    },
  };
}

function source() {
  const docs = documents();
  const texts = new Map<TestRunConfigurationFile, string>();
  const reads: TestRunConfigurationFile[] = [];
  const revisions = new Map<TestRunConfigurationFile, number>();
  const unreadable = new Set<TestRunConfigurationFile>();
  let onRevision: ((file: TestRunConfigurationFile) => void) | undefined;
  const reader: TestRunConfigurationReader = {
    async read(file) {
      reads.push(file);
      if (unreadable.has(file)) throw new Error('fixture read unavailable');
      return { text: texts.get(file) ?? JSON.stringify(docs[file]), revision: String(revisions.get(file) ?? 0) };
    },
    async revision(file) { onRevision?.(file); return String(revisions.get(file) ?? 0); },
  };
  return {
    docs, texts, reads, unreadable, reader,
    change(file: TestRunConfigurationFile, path: string[], value: ConfigurationValue | undefined) {
      let target = docs[file] as Record<string, ConfigurationValue>;
      for (const part of path.slice(0, -1)) target = target[part] as Record<string, ConfigurationValue>;
      if (value === undefined) delete target[path.at(-1)!]; else target[path.at(-1)!] = value;
      revisions.set(file, (revisions.get(file) ?? 0) + 1);
    },
    race(hook: (file: TestRunConfigurationFile) => void) { onRevision = hook; },
    bump(file: TestRunConfigurationFile) { revisions.set(file, (revisions.get(file) ?? 0) + 1); },
  };
}

async function configurationFailure(operation: () => Promise<unknown>): Promise<TestRunConfigurationFailure> {
  try { await operation(); }
  catch (error) {
    const failure = error as TestRunConfigurationFailure;
    assert.equal(failure.code, 'CONFIGURATION_INVALID');
    assert.ok(Array.isArray(failure.changedPointers));
    assert.ok(Array.isArray(failure.unreadableFiles));
    assert.ok(Array.isArray(failure.missingPointers));
    assert.ok(Array.isArray(failure.inconsistentFiles));
    return failure;
  }
  assert.fail('configuration change must refuse explicitly');
}

test('config-dependencies manifest declares only the selected command, route, unit budget and admission inputs', () => {
  const actual = testRunConfigurationManifest(scope).map(address).sort();
  assert.deepEqual(actual, unitManifest.map(address).sort());
  assert.equal(new Set(actual).size, actual.length);
});

test('config-dependencies integration manifest replaces every unit policy dependency with integration timeout', () => {
  const actual = testRunConfigurationManifest({ ...scope, testKind: 'integration', phase: 'integration' }).map(address);
  assert.ok(actual.includes('conf/flow.json#/integrationTests/timeoutMs'));
  assert.ok(actual.includes('conf/test-runs.json#/phases/integration'));
  assert.ok(!actual.some(pointer => pointer.startsWith('conf/flow.json#/unitTests')));
});

test('config-dependencies hotfix uses its admission level and unrequested runner policy is absent', () => {
  const actual = testRunConfigurationManifest({ ...scope, resourceLevel: 'hotfix', runner: undefined }).map(address);
  assert.ok(actual.includes('conf/flow.json#/resources/hotfix'));
  assert.ok(!actual.includes('conf/flow.json#/resources/normal'));
  assert.ok(!actual.some(pointer => pointer.startsWith('conf/raf.json#/runnerProtocols')));
});

test('config-dependencies manifest escapes project, profile and group JSON pointer tokens', () => {
  const actual = testRunConfigurationManifest({ ...scope, project: 'p~q', profileId: 'node/alt', group: 'change/group~x' }).map(address);
  assert.ok(actual.includes('conf/test-runs.json#/projects/p~0q/profiles/node~1alt'));
  assert.ok(actual.includes('conf/test-runs.json#/projects/p~0q/groups/change~1group~0x'));
});

test('config-dependencies snapshot stores detached normalized values and version with exact pointers', async () => {
  const s = source();
  const dependencies = [dep('conf/flow.json', '/unitTests'), dep('conf/test-runs.json', presetPointer)];
  const snapshot = await captureTestRunConfiguration(dependencies, s.reader);
  assert.deepEqual(snapshot, { version: 1, dependencies: [
    { ...dependencies[0], value: policy },
    { ...dependencies[1], value: { profileId: 'node', files: [file] } },
  ] });
  s.change('conf/flow.json', ['unitTests', 'timeoutMs'], 2000);
  assert.deepEqual(snapshot.dependencies[0].value, policy);
  assert.deepEqual(dependencies, [dep('conf/flow.json', '/unitTests'), dep('conf/test-runs.json', presetPointer)]);
});

const unrelated: { name: string; file: TestRunConfigurationFile; path: string[]; value: ConfigurationValue }[] = [
  { name: 'another project', file: 'conf/projects.json', path: ['projects', 'etchly', 'path'], value: '/qa/new-etchly' },
  { name: 'another referenced project profile', file: 'conf/projects.json', path: ['profiles', 'product', 'runtime'], value: 'node' },
  { name: 'another test profile', file: 'conf/test-runs.json', path: ['projects', 'raf', 'profiles', 'unselected'], value: { argv: ['other'] } },
  { name: 'another phase', file: 'conf/test-runs.json', path: ['phases', 'qa', 'allowed'], value: false },
  { name: 'reminders', file: 'conf/raf.json', path: ['reminders', 'enabled'], value: false },
  { name: 'events', file: 'conf/raf-constants.json', path: ['events'], value: [{ type: 'another' }] },
  { name: 'retention', file: 'conf/flow.json', path: ['retention', 'finishedSessionsMs'], value: 8000 },
  { name: 'other resource tier', file: 'conf/flow.json', path: ['resources', 'hotfix', 'minRamBytes'], value: 60 },
  { name: 'unused agent estimate', file: 'conf/flow.json', path: ['resourceEstimates', 'agentTypes', 'qa', 'ramBytes'], value: 101 },
  { name: 'integration budget for unit', file: 'conf/flow.json', path: ['integrationTests', 'timeoutMs'], value: 9000 },
];
for (const change of unrelated) {
  test(`config-dependencies ignores ${change.name}`, async () => {
    const s = source();
    const snapshot = await captureTestRunConfiguration(unitManifest, s.reader);
    s.change(change.file, change.path, change.value);
    await assertTestRunConfigurationUnchanged(snapshot, s.reader);
  });
}

test('config-dependencies object order and whitespace never invalidate while argv array order matters', async () => {
  const s = source();
  s.change('conf/test-runs.json', ['projects', 'raf', 'profiles', 'node', 'argv'], ['a', 'b']);
  const snapshot = await captureTestRunConfiguration(unitManifest, s.reader);
  for (const file of Object.keys(s.docs) as TestRunConfigurationFile[]) {
    s.texts.set(file, JSON.stringify(s.docs[file], (_, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value, 4));
  }
  await assertTestRunConfigurationUnchanged(snapshot, s.reader);
  s.texts.clear();
  s.change('conf/test-runs.json', ['projects', 'raf', 'profiles', 'node', 'argv'], ['b', 'a']);
  const failure = await configurationFailure(() => assertTestRunConfigurationUnchanged(snapshot, s.reader));
  assert.ok(failure.changedPointers.some(pointer => pointer.startsWith('conf/test-runs.json#/projects/raf/profiles/node/argv')));
});

const applicable: { name: string; file: TestRunConfigurationFile; path: string[]; pointer: string; value: ConfigurationValue }[] = [
  { name: 'selected argv', file: 'conf/test-runs.json', path: ['projects', 'raf', 'profiles', 'node', 'argv'], pointer: '/projects/raf/profiles/node/argv', value: ['changed'] },
  { name: 'selected files', file: 'conf/test-runs.json', path: ['projects', 'raf', 'groups', request.group, 'files'], pointer: `${presetPointer}/files`, value: ['test/other.test.ts'] },
  { name: 'isolation', file: 'conf/test-runs.json', path: ['projects', 'raf', 'profiles', 'node', 'environment', 'isolatedHome'], pointer: '/projects/raf/profiles/node/environment/isolatedHome', value: false },
  { name: 'allowed phase', file: 'conf/test-runs.json', path: ['phases', 'red', 'allowed'], pointer: '/phases/red/allowed', value: false },
  { name: 'diagnostics', file: 'conf/test-runs.json', path: ['diagnostics', 'maxEntries'], pointer: '/diagnostics/maxEntries', value: 65 },
  { name: 'temporary artifacts', file: 'conf/test-runs.json', path: ['temporaryArtifacts', 'root'], pointer: '/temporaryArtifacts/root', value: '/tmp/other' },
  { name: 'workspace route', file: 'conf/projects.json', path: ['projects', 'raf', 'branchPaths', 'develop'], pointer: '/projects/raf/branchPaths/develop', value: '/qa/changed' },
  { name: 'referenced project profile', file: 'conf/projects.json', path: ['profiles', 'raf', 'runtime'], pointer: '/profiles/raf/runtime', value: 'changed' },
  { name: 'unit budget', file: 'conf/flow.json', path: ['unitTests', 'timeoutMs'], pointer: '/unitTests/timeoutMs', value: 2000 },
  { name: 'unit optimization', file: 'conf/flow.json', path: ['unitTests', 'optimizeAfterTimeouts'], pointer: '/unitTests/optimizeAfterTimeouts', value: 2 },
  { name: 'unit timeout limit', file: 'conf/flow.json', path: ['unitTests', 'maxGroupTimeouts'], pointer: '/unitTests/maxGroupTimeouts', value: 3 },
  { name: 'admission tier', file: 'conf/flow.json', path: ['resources', 'normal', 'minRamBytes'], pointer: '/resources/normal/minRamBytes', value: 101 },
  { name: 'home disk admission', file: 'conf/flow.json', path: ['resources', 'home', 'minDiskBytes'], pointer: '/resources/home/minDiskBytes', value: 201 },
  { name: 'command permission', file: 'conf/raf-constants.json', path: ['commands', '0', 'permissions'], pointer: '/commands/0/permissions', value: ['qa'] },
  { name: 'agent phase', file: 'conf/raf-constants.json', path: ['agentPhases', '0', 'id'], pointer: '/agentPhases/0/id', value: 'qa' },
  { name: 'resource wait policy', file: 'conf/raf.json', path: ['resourceWait', 'grantIntervalMs'], pointer: '/resourceWait/grantIntervalMs', value: 11 },
  { name: 'runner policy', file: 'conf/raf.json', path: ['runnerProtocols', 'codex', 'timeouts', 'pollMs'], pointer: '/runnerProtocols/codex/timeouts/pollMs', value: 21 },
];
for (const change of applicable) {
  test(`config-dependencies refuses changed ${change.name} with precise address`, async () => {
    const s = source();
    const snapshot = await captureTestRunConfiguration(unitManifest, s.reader);
    const before = copy(snapshot);
    s.change(change.file, change.path, change.value);
    const failure = await configurationFailure(() => assertTestRunConfigurationUnchanged(snapshot, s.reader));
    const exact = `${change.file}#${change.pointer}`;
    assert.ok(failure.changedPointers.length > 0);
    assert.ok(failure.changedPointers.every(pointer => pointer === exact || pointer.startsWith(`${exact}/`)), failure.changedPointers.join(','));
    assert.deepEqual(failure.unreadableFiles, []);
    assert.deepEqual(failure.missingPointers, []);
    assert.deepEqual(failure.inconsistentFiles, []);
    assert.deepEqual(snapshot, before, 'recheck cannot silently rebase a pending request');
  });
}

test('config-dependencies collects all changed keys across files rather than one global hash', async () => {
  const s = source();
  const snapshot = await captureTestRunConfiguration(unitManifest, s.reader);
  s.change('conf/flow.json', ['unitTests', 'timeoutMs'], 2000);
  s.change('conf/projects.json', ['projects', 'raf', 'path'], '/qa/other');
  const failure = await configurationFailure(() => assertTestRunConfigurationUnchanged(snapshot, s.reader));
  assert.deepEqual(failure.changedPointers.sort(), ['conf/flow.json#/unitTests/timeoutMs', 'conf/projects.json#/projects/raf/path'].sort());
});

test('config-dependencies integration ignores unit counters but refuses its own timeout', async () => {
  const s = source();
  const dependencies = unitManifest.filter(item => item.pointer !== '/unitTests').concat(dep('conf/flow.json', '/integrationTests/timeoutMs'));
  const snapshot = await captureTestRunConfiguration(dependencies, s.reader);
  s.change('conf/flow.json', ['unitTests', 'timeoutMs'], 9000);
  s.change('conf/flow.json', ['unitTests', 'maxGroupTimeouts'], 9);
  await assertTestRunConfigurationUnchanged(snapshot, s.reader);
  s.change('conf/flow.json', ['integrationTests', 'timeoutMs'], 3001);
  const failure = await configurationFailure(() => assertTestRunConfigurationUnchanged(snapshot, s.reader));
  assert.deepEqual(failure.changedPointers, ['conf/flow.json#/integrationTests/timeoutMs']);
});

for (const at of ['capture', 'recheck'] as const) {
  for (const fault of ['malformed', 'unreadable', 'missing', 'inconsistent'] as const) {
    test(`config-dependencies ${at} refuses ${fault} with distinct evidence and no fallback`, async () => {
      const s = source();
      const dependencies = [dep('conf/flow.json', '/unitTests')];
      const snapshot = at === 'recheck' ? await captureTestRunConfiguration(dependencies, s.reader) : null;
      if (fault === 'malformed') s.texts.set('conf/flow.json', '{"unitTests":');
      if (fault === 'unreadable') s.unreadable.add('conf/flow.json');
      if (fault === 'missing') s.change('conf/flow.json', ['unitTests'], undefined);
      if (fault === 'inconsistent') s.race(file => s.bump(file));
      const failure = await configurationFailure(() => snapshot
        ? assertTestRunConfigurationUnchanged(snapshot, s.reader)
        : captureTestRunConfiguration(dependencies, s.reader));
      assert.deepEqual(failure.changedPointers, [], 'unknown bytes do not prove a changed value');
      assert.deepEqual(failure.missingPointers, fault === 'missing' ? ['conf/flow.json#/unitTests'] : []);
      assert.deepEqual(failure.unreadableFiles, ['malformed', 'unreadable'].includes(fault) ? ['conf/flow.json'] : []);
      assert.deepEqual(failure.inconsistentFiles, fault === 'inconsistent' ? ['conf/flow.json'] : []);
    });
  }
}

test('config-dependencies validates syntax of an entire depended-on file even when broken text is outside selected section', async () => {
  const s = source();
  const snapshot = await captureTestRunConfiguration([dep('conf/flow.json', '/unitTests')], s.reader);
  s.texts.set('conf/flow.json', `{"unitTests":${JSON.stringify(policy)},"unrelated":BROKEN}`);
  const failure = await configurationFailure(() => assertTestRunConfigurationUnchanged(snapshot, s.reader));
  assert.deepEqual(failure.unreadableFiles, ['conf/flow.json']);
  assert.deepEqual(failure.changedPointers, []);
});

test('config-dependencies reports a deleted required budget leaf instead of adopting a fallback', async () => {
  const s = source();
  const snapshot = await captureTestRunConfiguration(unitManifest, s.reader);
  s.change('conf/flow.json', ['unitTests', 'timeoutMs'], undefined);
  const failure = await configurationFailure(() => assertTestRunConfigurationUnchanged(snapshot, s.reader));
  assert.deepEqual(failure.missingPointers, ['conf/flow.json#/unitTests/timeoutMs']);
  assert.deepEqual(failure.changedPointers, []);
  assert.deepEqual(failure.unreadableFiles, []);
});

test('config-dependencies multi-file capture detects an earlier file changing during a later read', async () => {
  const s = source();
  const read = s.reader.read;
  s.reader.read = async file => {
    const value = await read(file);
    if (file === 'conf/projects.json') s.bump('conf/flow.json');
    return value;
  };
  const failure = await configurationFailure(() => captureTestRunConfiguration([
    dep('conf/flow.json', '/unitTests'), dep('conf/projects.json', '/projects/raf/path'),
  ], s.reader));
  assert.deepEqual(failure.inconsistentFiles, ['conf/flow.json']);
  assert.deepEqual(failure.changedPointers, []);
});

const changedAddress = 'conf/flow.json#/unitTests/timeoutMs';
const fixedSnapshot: TestRunConfigurationSnapshot = {
  version: 1, dependencies: [{ ...dep('conf/flow.json', '/unitTests'), value: copy(policy) as unknown as ConfigurationValue }],
};
function dependencyPort(f: ReturnType<typeof fixture>) {
  let invalid = false;
  const calls: { operation: string; at?: string; snapshot?: TestRunConfigurationSnapshot }[] = [];
  const failure = () => Object.assign(new Error(`Configuration changed: ${changedAddress}`), {
    code: 'CONFIGURATION_INVALID', changedPointers: [changedAddress], unreadableFiles: [], missingPointers: [], inconsistentFiles: [],
  });
  f.ports.configurationDependencies = {
    async capture() { calls.push({ operation: 'capture' }); f.timeline.push('config:capture'); return copy(fixedSnapshot); },
    async recheck(snapshot, at) {
      calls.push({ operation: 'recheck', at, snapshot: copy(snapshot) }); f.timeline.push(`config:${at}`);
      if (invalid) throw failure();
    },
  };
  return { calls, invalidate() { invalid = true; } };
}

function assertRefusal(f: ReturnType<typeof fixture>, before: ReturnType<ReturnType<typeof fixture>['seed']>, result: ResourceReservedTestRunResult, code = 'CONFIGURATION_INVALID') {
  assert.equal(result.outcome, 'refused');
  assert.equal(result.errorCode, code);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.failureKinds, ['refusal']);
  assert.equal(result.timeoutCount, before.timeoutCount);
  assert.deepEqual(result.knownRed, before.knownRed);
  assert.deepEqual(f.group(), before, 'refusal preserves the whole aggregate including lastResult and selection');
  assert.equal(f.spawned.length, 0);
  assert.equal(f.shared.claims.size, 0);
  assert.equal(f.testQueue.starts.length, 0);
  assert.equal(f.testQueue.finishes.length, 1);
  assert.deepEqual(f.testQueue.finishes[0].record, f.testQueue.records[0]);
  assert.equal(result.cleanup.complete, true);
  if (code === 'CONFIGURATION_INVALID') assert.ok(JSON.stringify(result.diagnostics).includes(changedAddress));
}

test('config-dependencies queue captures once, preserves identity through unrelated edits and rechecks both launch boundaries', async () => {
  const f = fixture(); const before = f.seed(); const port = dependencyPort(f);
  f.shared.setRefusal('unavailable');
  const running = f.run();
  await expectWaiting(f, running);
  assert.deepEqual(f.group(), before);
  f.advance(policy.timeoutMs * 4);
  f.shared.setRefusal(null); f.testQueue.grant();
  const result = await running;
  assert.equal(result.outcome, 'passed');
  assert.equal(port.calls.filter(call => call.operation === 'capture').length, 1);
  assert.ok(port.calls.some(call => call.at === 'reservation'));
  assert.ok(port.calls.some(call => call.at === 'spawn'));
  for (const call of port.calls.filter(call => call.operation === 'recheck')) assert.deepEqual(call.snapshot, fixedSnapshot);
  assert.equal(f.testQueue.records.length, 1);
  assert.equal(f.spawned.length, 1);
  assert.equal(result.runId, f.testQueue.records[0].testRunId);
  assert.equal(result.timedOut, false);
  assert.ok(f.deadlines.every(deadline => deadline === f.now() + policy.timeoutMs));
  assert.ok(f.timeline.indexOf('config:capture') < f.timeline.indexOf('config:reservation'));
  assert.ok(f.timeline.indexOf('config:spawn') < f.timeline.indexOf('spawn'));
});

test('config-dependencies capture failure leaves the ledger untouched before queue or resource reservation', async () => {
  const f = fixture(); const before = f.seed();
  const port = dependencyPort(f);
  f.ports.configurationDependencies!.capture = async () => {
    throw Object.assign(new Error('Cannot read conf/flow.json'), { code: 'CONFIGURATION_INVALID',
      changedPointers: [], unreadableFiles: ['conf/flow.json'], missingPointers: [], inconsistentFiles: [] });
  };
  const result = await f.run();
  assert.equal(result.errorCode, 'CONFIGURATION_INVALID');
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.timeoutCount, before.timeoutCount);
  assert.deepEqual(result.knownRed, before.knownRed);
  assert.deepEqual(f.group(), before);
  assert.equal(f.testQueue.records.length, 0);
  assert.equal(f.shared.calls.filter(call => call.operation === 'prepare').length, 0);
  assert.equal(f.spawned.length, 0);
  assert.equal(port.calls.length, 0);
});

test('config-dependencies unchanged recheck preserves queue fence and snapshot after resource loss and a second permit', async () => {
  const f = fixture(); const before = f.seed(); const port = dependencyPort(f);
  f.shared.setRefusal('unavailable');
  const running = f.run(); await expectWaiting(f, running);
  let reentered!: () => void;
  const secondWait = new Promise<void>(resolve => { reentered = resolve; });
  const wait = f.testQueue.port.waitForResources;
  f.testQueue.port.waitForResources = input => { const result = wait(input); reentered(); return result; };
  f.testQueue.grant();
  const state = await Promise.race([secondWait.then(() => 'waiting'), running.then(() => 'completed')]);
  const interimLedger = copy(f.group());
  f.shared.setRefusal(null);
  if (state === 'waiting') f.testQueue.grant(1);
  const result = await running;
  assert.equal(state, 'waiting');
  assert.deepEqual(interimLedger, before);
  assert.equal(result.outcome, 'passed');
  assert.equal(f.testQueue.records.length, 1);
  assert.deepEqual(f.testQueue.waits[0].input.record, f.testQueue.waits[1].input.record);
  assert.equal(port.calls.filter(call => call.operation === 'capture').length, 1);
  assert.ok(port.calls.filter(call => call.at === 'reservation').length >= 2);
  assert.equal(f.spawned.length, 1);
});

for (const boundary of ['permit', 'prepare', 'commit', 'beforeSpawn', 'markSpawning'] as const) {
  test(`config-dependencies change at ${boundary} cannot cross spawn or reset ledger`, async () => {
    const f = fixture(); const before = f.seed(); const port = dependencyPort(f);
    const foreignKey = { ...before.key, group: 'fix-raf-load-admission/unrelated-active' };
    const foreign = { ...copy(before), key: foreignKey, state: 'running' as const,
      inFlight: { runId: 'foreign-live-run', deadlineMs: 9999, processIdentity: 'foreign-process' } };
    f.groups.set(key(foreignKey), copy(foreign));
    f.shared.setRefusal('unavailable');
    const running = f.run();
    await expectWaiting(f, running);
    if (boundary === 'permit') port.invalidate();
    if (boundary === 'prepare') f.shared.onPrepare(() => port.invalidate());
    if (boundary === 'commit') {
      const commit = f.ports.resources.commit;
      f.ports.resources.commit = async claim => { const result = await commit(claim); port.invalidate(); return result; };
    }
    if (boundary === 'beforeSpawn') f.ports.resources.beforeSpawn = async () => { port.invalidate(); };
    if (boundary === 'markSpawning') f.ports.resources.markSpawning = async () => { port.invalidate(); };
    f.shared.setRefusal(null); f.testQueue.grant();
    assertRefusal(f, before, await running);
    assert.deepEqual(f.groups.get(key(foreignKey)), foreign, 'unrelated inFlight and ledger remain unchanged');
    assert.equal(f.testQueue.records.length, 1);
    if (boundary === 'permit') assert.equal(f.shared.calls.filter(call => call.operation === 'commit').length, 0);
  });
}

test('config-dependencies revoked caller stays CALLER_UNAUTHORIZED even when configuration is also changed', async () => {
  const f = fixture(); const before = f.seed(); const port = dependencyPort(f);
  let authorized = true;
  const preflight = f.ports.preflight;
  f.ports.preflight = async value => {
    if (!authorized) throw Object.assign(new Error('caller authorization revoked'), { code: 'CALLER_UNAUTHORIZED' });
    return preflight(value);
  };
  f.shared.setRefusal('unavailable');
  const running = f.run();
  await expectWaiting(f, running);
  authorized = false; port.invalidate();
  f.shared.setRefusal(null); f.testQueue.grant();
  assertRefusal(f, before, await running, 'CALLER_UNAUTHORIZED');
});

test('config-dependencies unchanged snapshot does not authorize a caller revoked after commit', async () => {
  const f = fixture(); const before = f.seed(); dependencyPort(f);
  let authorized = true;
  const preflight = f.ports.preflight;
  f.ports.preflight = async value => {
    if (!authorized) throw Object.assign(new Error('caller authorization revoked'), { code: 'CALLER_UNAUTHORIZED' });
    return preflight(value);
  };
  const commit = f.ports.resources.commit;
  f.ports.resources.commit = async claim => { const result = await commit(claim); authorized = false; return result; };
  f.shared.setRefusal('unavailable');
  const running = f.run();
  await expectWaiting(f, running);
  f.shared.setRefusal(null); f.testQueue.grant();
  assertRefusal(f, before, await running, 'CALLER_UNAUTHORIZED');
});

test('config-dependencies two queued projects and profiles keep FIFO identity; only the dependent waiter refuses', async () => {
  const shared = machine(); shared.setRefusal('unavailable');
  const first = fixture(shared); const firstBefore = first.seed(); const firstPort = dependencyPort(first);
  const secondContext = { ...context, agentId: 'other-project', home: '/qa/other-home',
    statePath: '/qa/other-home/state.sqlite', tmpPath: '/qa/other-home/tmp', projectWorkspaces: { raf: [context.workspace], etchly: [context.workspace] } };
  const second = fixture(shared, secondContext); const secondPort = dependencyPort(second);
  const secondConfig = copy(config);
  secondConfig.projects.etchly = { profiles: { other: copy(config.projects.raf.profiles.node) },
    groups: { [request.group]: { profileId: 'other', files: [file] } } };
  const secondRequest = { ...request, project: 'etchly' };
  const otherKey = { project: 'etchly', workspace: context.workspace, group: request.group };
  const secondBefore = { ...second.seed(), key: otherKey };
  second.groups.clear(); second.groups.set(key(otherKey), copy(secondBefore));
  const one = first.run();
  await expectWaiting(first, one);
  const two = runResourceReservedTestRun(secondRequest, secondConfig, policy, secondContext, second.ports);
  await expectWaiting(second, two);
  const identities = [copy(first.testQueue.records[0]), copy(second.testQueue.records[0])];
  assert.equal(shared.claims.size, 0);
  firstPort.invalidate();
  shared.setRefusal(null);
  first.testQueue.grant();
  const refused = await one;
  const pendingLedger = copy(second.groups.get(key(otherKey)));
  const prematureSpawns = second.spawned.length;
  second.testQueue.grant();
  const survivor = await two;
  assertRefusal(first, firstBefore, refused);
  assert.deepEqual(pendingLedger, secondBefore);
  assert.equal(prematureSpawns, 0, 'a surviving waiter cannot bypass its existing permit');
  assert.equal(survivor.outcome, 'passed');
  assert.equal(second.spawned.length, 1);
  assert.equal(second.testQueue.records.length, 1);
  assert.deepEqual([first.testQueue.records[0], second.testQueue.records[0]], identities);
  assert.ok(secondPort.calls.some(call => call.at === 'spawn'));
  assert.ok(shared.calls.some(call => call.operation === 'estimate' && JSON.stringify(call.value) === JSON.stringify(['etchly', 'other'])));
});

test('config-dependencies a shared dependency can refuse both waiters without either child', async () => {
  const shared = machine(); shared.setRefusal('unavailable');
  const one = fixture(shared); const two = fixture(shared, { ...context, agentId: 'second' });
  const firstBefore = one.seed(); const secondBefore = two.seed();
  const firstPort = dependencyPort(one); const secondPort = dependencyPort(two);
  const firstRun = one.run(); await expectWaiting(one, firstRun);
  const secondRun = two.run(); await expectWaiting(two, secondRun);
  firstPort.invalidate(); secondPort.invalidate();
  shared.setRefusal(null);
  one.testQueue.grant(); const firstResult = await firstRun;
  two.testQueue.grant(); const secondResult = await secondRun;
  assertRefusal(one, firstBefore, firstResult);
  assertRefusal(two, secondBefore, secondResult);
});
