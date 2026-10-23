import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  authorizeRegressionRun,
  executeRegressionRun,
  normalizeRegressionGroups,
  resumeRegressionAssignment,
  snapshotRegressionAssignment,
} from '../src/test-regression-groups.ts';
import type {
  RegressionAuthorization,
  RegressionControlSnapshot,
  RegressionExecutionPorts,
  RegressionGrant,
  RegressionLaunchInput,
  RegressionTestAssignment,
} from '../src/test-regression-groups.ts';
import type { SandboxCommandReply, SandboxUnitContext } from '../src/sandbox-test-run.ts';
import type { TestRunConfig, TestRunGroupKey, TestRunRequest } from '../src/test-runs.ts';
import { cleanupClosedTestRunGroups, runTestRun } from '../src/test-runs.ts';
import type {
  TestRunContext, TestRunGroup, TestRunPorts, TestRunResult, TestRunTransaction, UnitTestPolicy,
} from '../src/test-runs.ts';

const source = 'add-raf-test-run';
const target = 'fix-raf-load-admission';
const group = `${target}/estimates-legacy`;
const secondGroup = `${target}/estimates`;
const workspace = '/workspace/raf-develop';
const files = ['test/task-context.test.ts', 'test/production-runtime.test.ts'];
const otherFile = 'test/resource-estimates.test.ts';
const ownFile = 'test/sandbox-test-regression-groups.test.ts';
const marker = '; regressionGroups=';
const entrypoint = ['node', '/trusted/raf/bin/raf.ts'];

function configuration(): Pick<TestRunConfig, 'projects' | 'phases'> {
  const phases: TestRunConfig['phases'] = {};
  for (const phase of ['implement', 'qa', 'hotfix', 'red', 'main', 'coordinator', 'spec', 'design', 'test-scaffold']) {
    phases[phase] = {
      allowed: ['implement', 'qa', 'hotfix', 'red'].includes(phase),
      purpose: phase === 'red' ? 'initial-red' : 'verification',
      hints: { refusal: 'refusal', setup: 'setup', assertions: 'assertions', timeout: 'timeout', interruption: 'interruption' },
    };
  }
  return {
    phases,
    projects: {
      raf: {
        profiles: {
          node: {
            cwd: '.', executable: 'node', argv: ['./scripts/test-run-node.ts'],
            unitFiles: [...files, otherFile, ownFile, 'test/unrelated.test.ts'],
            exactIds: 'node-test-name', resultAdapter: 'node-test-events',
            environment: { isolatedHome: true, stateOrigin: true }, checks: [],
          },
        },
        groups: {
          [group]: { profileId: 'node', files: [...files] },
          [secondGroup]: { profileId: 'node', files: [otherFile] },
          [`${target}/sibling`]: { profileId: 'node', files: [ownFile] },
          [`${source}/foreign-regressions`]: { profileId: 'node', files: [ownFile] },
        },
      },
    },
  };
}

function assignment(overrides: Partial<RegressionTestAssignment> = {}): RegressionTestAssignment {
  return {
    runId: 'source-run', agentId: 'source-agent', type: 'implement', phase: 'implement',
    project: 'raf', workspace, branch: 'develop', changes: [source],
    ...overrides,
  };
}

function grant(overrides: Partial<RegressionGrant> = {}): RegressionGrant {
  return { sourceChange: source, sourceItem: '5.8.3', group, profileId: 'node', files: [...files], ...overrides };
}

function launch(description = `Implement source${marker}${JSON.stringify([group, secondGroup])}`) {
  return {
    assignment: assignment(),
    selectedItems: [{ change: source, item: '5.8.3' }],
    verifiedChanges: [{ id: source, items: [{ id: '5.8.3', description }] }],
    catalog: {
      config: configuration(), activeChanges: [source, target],
      workspaces: [{ project: 'raf', workspace, branch: 'develop', actualBranch: 'develop' }],
    },
  } satisfies RegressionLaunchInput;
}

function control(a = assignment({ regressionGroups: [grant()] })): RegressionControlSnapshot {
  return {
    ancestors: [{ pid: 501, startedAt: 'caller-start' }, { pid: 500, startedAt: 'parent-start' }],
    sessions: [{ process: { pid: 500, startedAt: 'parent-start' }, state: 'running', assignment: a }],
    workspaces: [{ project: 'raf', workspace, branch: 'develop', actualBranch: 'develop' }],
    activeChanges: [source, target], groups: [], config: configuration(),
  };
}

function request(overrides: Partial<TestRunRequest> = {}): TestRunRequest {
  return { project: 'raf', phase: 'implement', group, ...overrides };
}

function authorize(r = request(), a = assignment({ regressionGroups: [grant()] }), c = control(a)) {
  return authorizeRegressionRun(r, a, c);
}

function assignmentFailure(action: () => unknown, pattern: RegExp): void {
  assert.throws(action, error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /NotImplemented/);
    assert.match(error.message, pattern);
    const detail = error as Error & { remediation?: unknown };
    assert.match(`${error.message} ${detail.remediation ?? ''}`, /fix|correct|select|configure|remove|new|relaunch|виправ|обер|налаш|видал|нов|повтор/i);
    return true;
  });
}

function unauthorized(action: () => unknown, pattern: RegExp): void {
  assert.throws(action, error => {
    assert.ok(error instanceof Error);
    const detail = error as Error & { code?: string; errorCode?: string };
    assert.equal(detail.code ?? detail.errorCode, 'CALLER_UNAUTHORIZED');
    assert.match(error.message, pattern);
    return true;
  });
}

test('R01 launcher normalizes only verified selected items, with complete provenance and preset snapshots', () => {
  const input = launch();
  input.verifiedChanges[0].items.push({ id: 'unselected', description: `Unselected${marker}["unknown/no-preset"]` });
  assert.deepEqual(normalizeRegressionGroups(input), [grant(), grant({ group: secondGroup, files: [otherFile] })]);
  assert.deepEqual(input.assignment.changes, [source]);
});

test('R01 the same target from two selected items keeps both provenance records without widening files', () => {
  const input = launch(`Implement${marker}["${group}"]`);
  input.selectedItems.push({ change: source, item: '5.8.4' });
  input.verifiedChanges[0].items.push({ id: '5.8.4', description: `QA${marker}["${group}"]` });
  assert.deepEqual(normalizeRegressionGroups(input), [grant(), grant({ sourceItem: '5.8.4' })]);
});

test('R02 sources and unselected changes do not participate in launch normalization', () => {
  const input = launch('Implement source without an explicit declaration');
  input.verifiedChanges.push({ id: target, items: [{ id: '1.1', description: `Other change${marker}["${group}"]` }] });
  Object.assign(input, { sources: [`regressionGroups=["${group}"]`], brief: `Brief${marker}["${group}"]` });
  assert.deepEqual(normalizeRegressionGroups(input), []);
});

for (const description of [
  'Implement without a declaration',
  `Run ${group} and ${secondGroup}`,
  `Example: \`regressionGroups=["${group}"]\``,
  `[regressions](https://example.test/${group})`,
  `regressionGroups=["${group}"]`,
  `Implement${marker}[]`,
]) {
  test(`R02 informal mention or empty declaration grants nothing: ${description}`, () => {
    assert.deepEqual(normalizeRegressionGroups(launch(description)), []);
  });
}

test('R02 normal JSON whitespace at the end of the selected description is accepted', () => {
  assert.deepEqual(normalizeRegressionGroups(launch(`Implement${marker} [ "${group}" , "${secondGroup}" ]  `)), [
    grant(), grant({ group: secondGroup, files: [otherFile] }),
  ]);
});

for (const value of [
  '', '[', '{}', 'null', '"group"', '[1]', '[null]', '[{}]', '[""]', '[" "]',
  `["${group}","${group}"]`, '["estimates"]', '["fix-raf-load-admission/*"]',
  '["https://example.test/fix-raf-load-admission/estimates"]',
  `["${group}"] trailing prose`, `["${group}"]${marker}["${secondGroup}"]`,
  `["${group}","unknown/no-preset"]`,
]) {
  test(`R02 malformed declaration rejects the entire launch with remediation: ${value}`, () => {
    assignmentFailure(() => normalizeRegressionGroups(launch(`Implement${marker}${value}`)), /declar|regression|preset|group|груп|деклар/i);
  });
}

for (const [name, mutate] of [
  ['inactive target', (input: ReturnType<typeof launch>) => { input.catalog.activeChanges = [source]; }],
  ['unknown profile', (input: ReturnType<typeof launch>) => { input.catalog.config.projects.raf.groups[group].profileId = 'absent'; }],
  ['file outside inventory', (input: ReturnType<typeof launch>) => { input.catalog.config.projects.raf.groups[group].files.push('test/not-unit.test.ts'); }],
  ['empty preset', (input: ReturnType<typeof launch>) => { input.catalog.config.projects.raf.groups[group].files = []; }],
  ['other project', (input: ReturnType<typeof launch>) => {
    input.catalog.config.projects.etchly = input.catalog.config.projects.raf;
    input.catalog.config.projects.raf = { profiles: {}, groups: {} };
  }],
  ['other workspace', (input: ReturnType<typeof launch>) => { input.catalog.workspaces[0].workspace = '/workspace/other'; }],
  ['other branch', (input: ReturnType<typeof launch>) => { input.catalog.workspaces[0].actualBranch = 'main'; }],
  ['unknown selected item', (input: ReturnType<typeof launch>) => { input.selectedItems[0].item = 'absent'; }],
  ['source outside assignment', (input: ReturnType<typeof launch>) => { input.assignment = assignment({ changes: ['other-source'] }); }],
] as const) {
  test(`R02 trusted launch validation is atomic: ${name}`, () => {
    const input = launch();
    mutate(input);
    const before = structuredClone(input);
    assignmentFailure(() => snapshotRegressionAssignment(input), /target|active|profile|file|inventory|preset|project|workspace|branch|item|assignment|source|груп/i);
    assert.deepEqual(input, before);
  });
}

for (const path of ['../escape.test.ts', '/outside.test.ts', 'test/*.ts', 'test', '--import=evil', 'test/../escape.test.ts']) {
  test(`R02 launch never snapshots a noncanonical preset path: ${path}`, () => {
    const input = launch(`Implement${marker}["${group}"]`);
    input.catalog.config.projects.raf.groups[group].files = [path];
    input.catalog.config.projects.raf.profiles.node.unitFiles.push(path);
    assignmentFailure(() => normalizeRegressionGroups(input), /file|path|preset|unit|шлях/i);
  });
}

test('R03 snapshot is deeply immutable and detached from descriptions, selection, assignment and conf', () => {
  const input = launch();
  const snapshot = snapshotRegressionAssignment(input);
  const before = structuredClone(snapshot);
  input.verifiedChanges[0].items[0].description = `Changed${marker}["${target}/sibling"]`;
  input.selectedItems[0].item = 'changed';
  input.catalog.config.projects.raf.groups[group].files.push(otherFile);
  (input.assignment.changes as string[]).push(target);
  assert.deepEqual(snapshot, before);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.changes));
  assert.ok(Object.isFrozen(snapshot.regressionGroups));
  assert.ok(Object.isFrozen(snapshot.regressionGroups![0]));
  assert.ok(Object.isFrozen(snapshot.regressionGroups![0].files));
  assert.throws(() => { (snapshot.regressionGroups![0].files as string[]).push(otherFile); }, TypeError);
  assert.deepEqual(snapshot.changes, [source]);
});

test('R03 launch does not trust preattached grants; verified selected descriptions are the sole source', () => {
  const input = launch('No explicit declaration');
  input.assignment = assignment({ regressionGroups: [grant({ group: `${target}/sibling`, files: [ownFile] })] });
  assert.deepEqual(snapshotRegressionAssignment(input).regressionGroups ?? [], []);
});

test('R03 resume restores the original stored snapshot rather than granting from current text', () => {
  const stored = structuredClone(assignment({ regressionGroups: [grant()] }));
  const resumed = resumeRegressionAssignment(stored);
  assert.deepEqual(resumed, stored);
  assert.ok(Object.isFrozen(resumed));
  assert.ok(Object.isFrozen(resumed.regressionGroups![0].files));
  (stored.regressionGroups![0].files as string[]).push(otherFile);
  assert.deepEqual(resumed.regressionGroups![0].files, files);
  unauthorized(() => authorize(request({ group: secondGroup }), resumed), /group|grant|assignment|груп/i);
});

for (const legacy of [assignment(), assignment({ regressionGroups: [] })]) {
  test(`R02 legacy assignment has no foreign rights (${legacy.regressionGroups === undefined ? 'absent' : 'empty'})`, () => {
    const resumed = resumeRegressionAssignment(legacy);
    assert.deepEqual(resumed.regressionGroups ?? [], []);
    unauthorized(() => authorize(request(), resumed), /group|grant|assignment|груп/i);
    assert.deepEqual(authorize(request({ group: `${source}/foreign-regressions`, files: [ownFile] }), resumed).key,
      { project: 'raf', workspace, group: `${source}/foreign-regressions` });
  });
}

for (const phase of ['implement', 'qa', 'hotfix']) {
  test(`R01 exact foreign preset is authorized in its own ${phase} phase without assigning target tasks`, () => {
    const a = assignment({ type: phase, phase, regressionGroups: [grant()] });
    const before = structuredClone(a);
    const result = authorize(request({ phase }), a);
    assert.deepEqual(result, {
      key: { project: 'raf', workspace, group }, profileId: 'node', files,
      provenance: [{ sourceChange: source, sourceItem: '5.8.3', group }],
    });
    assert.deepEqual(a, before);
  });
}

test('R01 duplicate provenance is reported without duplicating the target selection', () => {
  const a = assignment({ regressionGroups: [grant(), grant({ sourceItem: '5.8.4' })] });
  const result = authorize(request(), a);
  assert.deepEqual(result.files, files);
  assert.deepEqual(result.provenance, [
    { sourceChange: source, sourceItem: '5.8.3', group }, { sourceChange: source, sourceItem: '5.8.4', group },
  ]);
});

test('R05 explicit nonempty preset subset stays exact and does not include other unit files', () => {
  const result = authorize(request({ files: [files[1]] }));
  assert.deepEqual(result.files, [files[1]]);
});

test('R05 --only files are checked against the target preset without opening knownRed', () => {
  const only = [{ file: files[0], name: 'literal (target) [assertion]' }];
  assert.deepEqual(authorize(request({ only })).files, [files[0]]);
  unauthorized(() => authorize(request({ only: [{ file: otherFile, name: 'red in source or other target group' }] })), /file|preset|selection|файл/i);
});

for (const requestedGroup of [secondGroup, `${target}/sibling`, `${target}/estimates-legacy-extra`, 'estimates-legacy', `${target}/*`]) {
  test(`R05 foreign authorization matches the whole group key: ${requestedGroup}`, () => {
    unauthorized(() => authorize(request({ group: requestedGroup })), /group|grant|assignment|груп/i);
  });
}

for (const selected of [[], [files[0], otherFile], [otherFile], ['test'], ['test/*.ts'], ['../escape.ts'], ['/outside.ts'], ['--import=evil']]) {
  test(`R05 invalid foreign files never gain authorization: ${JSON.stringify(selected)}`, () => {
    unauthorized(() => authorize(request({ files: selected })), /file|selection|preset|path|unit|файл|шлях/i);
  });
}

for (const [name, mutate] of [
  ['profile changes', (c: RegressionControlSnapshot) => {
    c.config.projects.raf.profiles.replacement = structuredClone(c.config.projects.raf.profiles.node);
    c.config.projects.raf.groups[group].profileId = 'replacement';
  }],
  ['preset gains a file', (c: RegressionControlSnapshot) => { c.config.projects.raf.groups[group].files.push(otherFile); }],
  ['preset loses a file', (c: RegressionControlSnapshot) => { c.config.projects.raf.groups[group].files = [files[0]]; }],
  ['preset removed', (c: RegressionControlSnapshot) => { delete c.config.projects.raf.groups[group]; }],
  ['inventory loses a file', (c: RegressionControlSnapshot) => {
    c.config.projects.raf.profiles.node.unitFiles = c.config.projects.raf.profiles.node.unitFiles.filter(file => file !== files[0]);
  }],
  ['target closes', (c: RegressionControlSnapshot) => { (c.activeChanges as string[]).splice(1, 1); }],
] as const) {
  test(`R05 drift refuses even a still-valid explicit subset and requires a new assignment: ${name}`, () => {
    const a = assignment({ regressionGroups: [grant()] });
    const c = control(a);
    mutate(c);
    unauthorized(() => authorize(request({ files: [files[1]] }), a, c), /profile|preset|snapshot|drift|inventory|active|closed|file|груп/i);
  });
}

for (const corrupt of [
  { sourceChange: 'unassigned-source' }, { sourceItem: '' }, { profileId: 'unknown' },
  { files: [] }, { files: [otherFile] },
]) {
  test(`R03 malformed persisted grant is fail-closed: ${JSON.stringify(corrupt)}`, () => {
    unauthorized(() => authorize(request(), assignment({ regressionGroups: [grant(corrupt)] })), /source|item|grant|preset|profile|file|snapshot|assignment/i);
  });
}

function harness(a = assignment({ regressionGroups: [grant()] })) {
  const c = control(a);
  const calls: string[] = [];
  const keys: TestRunGroupKey[] = [];
  const forwarded: TestRunRequest[] = [];
  const evidence: { authorization: RegressionAuthorization; reply: SandboxCommandReply }[] = [];
  const context = Object.freeze({ marker: 'stable isolated target QA context' }) as unknown as SandboxUnitContext;
  let reply: SandboxCommandReply = { code: 0, stdout: '{"outcome":"passed"}\n', stderr: '' };
  const ports: RegressionExecutionPorts = {
    caller: { pid: 501, startedAt: 'caller-start' }, entrypoint,
    async control(caller) { assert.deepEqual(caller, ports.caller); calls.push('control'); return c; },
    async unitContext(key) { calls.push('unitContext'); keys.push(structuredClone(key)); return context; },
    async communicate() { calls.push('communicate'); return { code: 0, stdout: 'communication reply', stderr: '' }; },
    async wrapper(r, unit) {
      calls.push('wrapper'); assert.equal(unit, context); forwarded.push(structuredClone(r)); return reply;
    },
    async evidence(authorization, result) { calls.push('evidence'); evidence.push({ authorization, reply: result }); },
  };
  function command(tail = `test run --project raf --phase ${a.phase} --group ${group}`) {
    return { command: `${entrypoint.join(' ')} ${tail}`, cwd: workspace };
  }
  return { c, calls, keys, forwarded, evidence, context, ports, command, setReply(value: SandboxCommandReply) { reply = value; } };
}

async function refused(h: ReturnType<typeof harness>, command = h.command(), pattern = /caller|phase|assignment|group|grant|workspace|branch|project|entrypoint|command|file|preset|source|item|snapshot|active|profile|inventory|selection|unit|path|ancestor|live|registered|closed|shell/i) {
  const before = structuredClone(h.c);
  const reply = await executeRegressionRun(command, h.ports);
  assert.notEqual(reply.code, 0);
  assert.match(`${reply.stdout}\n${reply.stderr}`, /CALLER_UNAUTHORIZED/);
  assert.match(`${reply.stdout}\n${reply.stderr}`, pattern);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(h.forwarded, []);
  assert.deepEqual(h.evidence, []);
  assert.ok(h.calls.every(call => call === 'control'));
  assert.deepEqual(h.c, before);
}

for (const phase of ['spec', 'design', 'test-scaffold', 'unknown']) {
  for (const requestedPhase of ['implement', 'qa', 'hotfix', 'red', phase]) {
    test(`R04 grants never promote ${phase} to ${requestedPhase}`, async () => {
      const h = harness(assignment({ type: phase, phase, regressionGroups: [grant()] }));
      await refused(h, h.command(`test run --project raf --phase ${requestedPhase} --group ${group}`));
    });
  }
}

for (const phase of ['qa', 'hotfix', 'red']) {
  test(`R04 implement cannot substitute phase ${phase}`, async () => {
    const h = harness();
    await refused(h, h.command(`test run --project raf --phase ${phase} --group ${group}`));
  });
}

for (const [name, mutate] of [
  ['unknown caller', (h: ReturnType<typeof harness>) => { (h.c.sessions as unknown[]).length = 0; }],
  ['closed caller', (h: ReturnType<typeof harness>) => { Object.assign(h.c.sessions[0], { state: 'finished' }); }],
  ['reused PID', (h: ReturnType<typeof harness>) => { Object.assign(h.c.sessions[0].process, { startedAt: 'reused-pid' }); }],
  ['caller outside ancestor chain', (h: ReturnType<typeof harness>) => { Object.assign(h.c.ancestors[1], { pid: 999 }); }],
  ['branch drift', (h: ReturnType<typeof harness>) => { Object.assign(h.c.workspaces[0], { actualBranch: 'main' }); }],
  ['workspace drift', (h: ReturnType<typeof harness>) => { Object.assign(h.c.workspaces[0], { workspace: '/workspace/other' }); }],
  ['project drift', (h: ReturnType<typeof harness>) => { Object.assign(h.c.workspaces[0], { project: 'etchly' }); }],
  ['configured phase disabled', (h: ReturnType<typeof harness>) => { h.c.config.phases.implement.allowed = false; }],
  ['closed source assignment', (h: ReturnType<typeof harness>) => { (h.c.activeChanges as string[]).splice(0, 1); }],
  ['closed target', (h: ReturnType<typeof harness>) => { (h.c.activeChanges as string[]).splice(1, 1); }],
  ['preset drift', (h: ReturnType<typeof harness>) => { h.c.config.projects.raf.groups[group].files.push(otherFile); }],
] as const) {
  test(`R04/R05 refusal precedes unitContext, test state, reservation, recovery and spawn: ${name}`, async () => {
    const h = harness();
    mutate(h);
    await refused(h);
  });
}

test('R04 nearest registered caller cannot borrow its authorized ancestor grant', async () => {
  const h = harness();
  (h.c.sessions as RegressionControlSnapshot['sessions'][number][]).unshift({
    process: { pid: 501, startedAt: 'caller-start' }, state: 'running', assignment: assignment(),
  });
  await refused(h);
});

for (const command of [
  `HOME=/tmp/forged ${entrypoint.join(' ')} test run --project raf --phase implement --group ${group}`,
  `${entrypoint.join(' ')} test run --project raf --phase implement --group ${group} | cat`,
  `${entrypoint.join(' ')} test run --project raf --phase implement --group ${group}; true`,
  `cd ${workspace} && ${entrypoint.join(' ')} test run --project raf --phase implement --group ${group}`,
  `node /editable/raf.ts test run --project raf --phase implement --group ${group}`,
  `${entrypoint.join(' ')} test run --project raf --phase implement --group ${group} --command arbitrary`,
  `${entrypoint.join(' ')} test run --project raf --phase implement --group ${group} --regressionGroups '["${secondGroup}"]'`,
  `${entrypoint.join(' ')} test run --project raf --phase implement --group $(whoami)`,
]) {
  test(`R03/R04 no caller command can supply grants or control code: ${command}`, async () => {
    const h = harness();
    await refused(h, { command, cwd: workspace });
  });
}

test('R03 caller-supplied request fields do not replace immutable grants', async () => {
  const h = harness(assignment());
  const forged = Object.assign(h.command(), {
    regressionGroups: [grant()], env: { regressionGroups: JSON.stringify([grant()]) },
    brief: `Edited${marker}["${group}"]`,
    tasks: `Edited${marker}["${group}"]`,
    message: { regressionGroups: [grant()] }, result: { regressionGroups: [grant()] },
  });
  await refused(h, forged);
});

test('R04 explicit other project and cwd refuse before any unit context', async () => {
  const h = harness();
  await refused(h, h.command(`test run --project etchly --phase implement --group ${group}`));
  await refused(h, { ...h.command(), cwd: '/workspace/other' });
});

test('R05 --only out-of-grant file is refused without reading even target knownRed', async () => {
  const h = harness();
  await refused(h, h.command(`test run --project raf --phase implement --group ${group} --only '${JSON.stringify({ file: otherFile, name: 'source red' })}'`));
});

test('R05 unknown ID inside the preset is left to the authorized wrapper, with UNKNOWN_RED_TEST intact', async () => {
  const h = harness();
  const only = { file: files[0], name: 'unknown literal target test' };
  const reply = { code: 1, stdout: '{"outcome":"refused","errorCode":"UNKNOWN_RED_TEST"}\n', stderr: 'unknown target knownRed' };
  h.setReply(reply);
  assert.deepEqual(await executeRegressionRun(h.command(`test run --project raf --phase implement --group ${group} --only '${JSON.stringify(only)}'`), h.ports), reply);
  assert.deepEqual(h.forwarded, [request({ only: [only] })]);
  assert.deepEqual(h.keys, [{ project: 'raf', workspace, group }]);
  assert.deepEqual(h.calls, ['control', 'unitContext', 'wrapper', 'evidence']);
});

test('R01/R05 preset and explicit subset forward exact ordinary wrapper requests, without granting the sibling', async () => {
  const h = harness(assignment({ regressionGroups: [grant(), grant({ group: secondGroup, files: [otherFile] })] }));
  await executeRegressionRun(h.command(), h.ports);
  await executeRegressionRun(h.command(`test run --project raf --phase implement --group ${group} --files ${files[1]}`), h.ports);
  await executeRegressionRun(h.command(`test run --project raf --phase implement --group ${secondGroup}`), h.ports);
  assert.deepEqual(h.forwarded, [request(), request({ files: [files[1]] }), request({ group: secondGroup })]);
  assert.deepEqual(h.keys, [
    { project: 'raf', workspace, group }, { project: 'raf', workspace, group },
    { project: 'raf', workspace, group: secondGroup },
  ]);
  unauthorized(() => authorize(request({ group: `${target}/sibling` }), h.c.sessions[0].assignment, h.c), /group|grant|assignment/i);
});

test('R06 own and foreign callers across agent, phase, SHA and source-item use the same target aggregate key', async () => {
  const variants = [
    assignment({ changes: [target], agentId: 'target-owner' }),
    assignment({ regressionGroups: [grant()] }),
    assignment({ type: 'qa', phase: 'qa', agentId: 'another-agent', runId: 'new-run', regressionGroups: [grant({ sourceItem: '5.8.4' })] }),
    assignment({ type: 'hotfix', phase: 'hotfix', regressionGroups: [grant()] }),
  ];
  const keys: TestRunGroupKey[] = [];
  for (const a of variants) {
    const h = harness(a);
    Object.assign(h.ports, { sha: `sha-${a.runId}`, sourceChange: source, sourceItem: 'caller-cannot-key-state' });
    await executeRegressionRun(h.command(), h.ports);
    assert.equal(h.forwarded.length, 1);
    keys.push(...h.keys);
    assert.deepEqual(h.forwarded[0], request({ phase: a.phase }));
  }
  assert.deepEqual(keys, variants.map(() => ({ project: 'raf', workspace, group })));
});

for (const outcome of [
  { outcome: 'timed-out', timeoutCount: 7, nextAction: 'confirm-known-red', timedOut: true, cleanup: { complete: false, remainingPids: [99] } },
  { outcome: 'unverified-remainder', timeoutCount: 7, nextAction: 'review-remainder', timedOut: false, cleanup: { complete: true, remainingPids: [] } },
  { outcome: 'refused', errorCode: 'GROUP_IN_FLIGHT', timeoutCount: 1, nextAction: 'reconcile' },
  { outcome: 'refused', errorCode: 'GROUP_TIMEOUT_LIMIT', timeoutCount: 7, nextAction: 'confirm-known-red' },
  { outcome: 'interrupted', timeoutCount: 1, nextAction: 'reconcile', timedOut: false },
  { outcome: 'assertions-failed', timeoutCount: 1, nextAction: 'fix-implementation' },
  { outcome: 'setup-failed', errorCode: 'INVENTORY_INCOMPLETE', timeoutCount: 1, nextAction: 'fix-setup' },
]) {
  test(`R06/R07 wrapper owns limits/recovery/remainder; broker preserves ${outcome.outcome}/${outcome.nextAction} without retry or reset`, async () => {
    const h = harness();
    const result = {
      ...outcome, runId: 'target-run', project: 'raf', workspace, group, phase: 'implement',
      knownRed: [{ file: files[0], name: 'target-red' }],
      removed: [{ file: files[1], name: 'removed target test' }],
      unexecuted: [{ file: files[1], name: 'unverified target test' }], unknown: [],
      diagnostics: [{ message: 'bounded target diagnostic' }], evidence: ['existing wrapper evidence'],
      exitCode: 42,
    };
    const reply = { code: 1, stdout: `${JSON.stringify(result)}\n`, stderr: 'literal stderr $(not-executed)\n' };
    h.setReply(reply);
    assert.deepEqual(await executeRegressionRun(h.command(), h.ports), reply);
    assert.deepEqual(h.calls, ['control', 'unitContext', 'wrapper', 'evidence']);
    assert.deepEqual(h.evidence[0].reply, reply);
    assert.deepEqual(h.evidence[0].authorization.provenance, [{ sourceChange: source, sourceItem: '5.8.3', group }]);
    assert.deepEqual(h.keys, [{ project: 'raf', workspace, group }]);
  });
}

test('R07 concurrent own and regression execution delegates both to the identical reservation context', async () => {
  const h = harness();
  const owner = assignment({ changes: [target] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const contexts: SandboxUnitContext[] = [];
  h.ports.wrapper = async (_request, context) => {
    contexts.push(context);
    if (contexts.length === 1) { await gate; return { code: 0, stdout: 'owner complete', stderr: '' }; }
    return { code: 1, stdout: '{"outcome":"refused","errorCode":"GROUP_IN_FLIGHT"}', stderr: '' };
  };
  const foreign = executeRegressionRun(h.command(), h.ports);
  void foreign.catch(() => {});
  const ownerPorts: RegressionExecutionPorts = { ...h.ports, async control() { return control(owner); } };
  const own = executeRegressionRun(h.command(), ownerPorts);
  try {
    assert.equal((await own).code, 1);
    assert.deepEqual(contexts, [h.context, h.context]);
    assert.deepEqual(h.keys, [{ project: 'raf', workspace, group }, { project: 'raf', workspace, group }]);
  } finally { release(); await foreign.catch(() => {}); }
  assert.equal((await foreign).code, 0);
});

test('R07 transport failure is not retried and never reported as pass', async () => {
  const h = harness();
  let attempts = 0;
  h.ports.wrapper = async () => { attempts++; throw new Error('wrapper transport unavailable'); };
  await assert.rejects(executeRegressionRun(h.command(), h.ports), /transport unavailable/);
  assert.equal(attempts, 1);
  assert.deepEqual(h.evidence, []);
});

test('R09 source grant neither extends own changes/report items/file boundaries nor cleans target state', async () => {
  const a = Object.assign(assignment({ regressionGroups: [grant()] }), {
    reportItems: [{ change: source, item: '5.8.3' }], writeBoundaries: ['/workspace/raf-develop/test'],
  });
  const h = harness(a);
  const before = structuredClone(a);
  await executeRegressionRun(h.command(), h.ports);
  assert.deepEqual(a, before);
  assert.deepEqual(a.changes, [source]);
  assert.deepEqual(a.reportItems, [{ change: source, item: '5.8.3' }]);
  assert.deepEqual(a.writeBoundaries, ['/workspace/raf-develop/test']);
  assert.deepEqual(h.keys, [{ project: 'raf', workspace, group }]);
  assert.ok(h.calls.every(call => ['control', 'unitContext', 'wrapper', 'evidence'].includes(call)));
});

test('R09 own active custom group with exact unit files keeps existing authorization without a foreign declaration', () => {
  const a = assignment();
  const result = authorize(request({ group: `${source}/custom`, files: [otherFile] }), a);
  assert.deepEqual(result.key, { project: 'raf', workspace, group: `${source}/custom` });
  assert.deepEqual(result.files, [otherFile]);
  assert.deepEqual(result.provenance, []);
});

for (const a of [
  assignment({ type: 'main', phase: 'main' }),
  assignment({ type: 'coordinator', phase: 'main', delegatedByMain: true }),
]) {
  test(`R09 existing ${a.type} red authority remains scoped to its own assignment`, async () => {
    const h = harness(a);
    const ownGroup = `${source}/foreign-regressions`;
    const reply = await executeRegressionRun(h.command(`test run --project raf --phase red --group ${ownGroup} --files ${ownFile}`), h.ports);
    assert.equal(reply.code, 0);
    assert.deepEqual(h.forwarded, [request({ phase: 'red', group: ownGroup, files: [ownFile] })]);
  });
}

for (const subcommand of ['agent ps', 'agent message --to main --text literal']) {
  test(`R09 regression hook preserves the communication port for ${subcommand}`, async () => {
    const h = harness();
    const result = await executeRegressionRun(h.command(subcommand), h.ports);
    assert.deepEqual(result, { code: 0, stdout: 'communication reply', stderr: '' });
    assert.ok(h.calls.includes('communicate'));
    assert.deepEqual(h.keys, []);
    assert.deepEqual(h.forwarded, []);
  });
}

function sharedWrapper() {
  const configured = JSON.parse(readFileSync(new URL('../../conf/test-runs.json', import.meta.url), 'utf8')) as TestRunConfig;
  const policy = (JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8')) as { unitTests: UnitTestPolicy }).unitTests;
  const config: TestRunConfig = { ...configured, ...configuration(), phases: configured.phases };
  const groups = new Map<string, TestRunGroup>();
  const keyOf = (key: TestRunGroupKey) => JSON.stringify([key.project, key.workspace, key.group]);
  const context: TestRunContext = {
    cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] },
    agentPhases: Object.keys(config.phases), activeChanges: [source, target],
    agentId: 'initial-owner', sha: 'initial-sha', home: '/qa/stable-target',
    statePath: '/qa/stable-target/state.sqlite', tmpPath: '/qa/stable-target/tmp',
    operationalHome: '/operational/home',
  };
  const facts = config.projects.raf.profiles.node.unitFiles;
  let now = 0;
  let sequence = 0;
  let spawned = 0;
  let recoveries = 0;
  let deadline: { at: number; callback: () => void } | null = null;
  let mode: 'timeout' | 'pass' = 'timeout';
  const ports: TestRunPorts = {
    state: {
      async transaction<T>(operation: (transaction: TestRunTransaction) => T): Promise<T> {
        return operation({
          get(key) { return structuredClone(groups.get(keyOf(key)) ?? null); },
          list(project, selectedWorkspace) {
            return structuredClone([...groups.values()].filter(g => g.key.project === project && g.key.workspace === selectedWorkspace));
          },
          put(g) { groups.set(keyOf(g.key), structuredClone(g)); },
          delete(key) { groups.delete(keyOf(key)); },
        });
      },
    },
    clock: {
      now() { return now; },
      schedule(at, callback) {
        const scheduled = { at, callback };
        deadline = scheduled;
        return () => { if (deadline === scheduled) deadline = null; };
      },
    },
    newRunId() { sequence++; return `wrapper-run-${sequence}`; },
    async preflight() {
      return {
        canonicalWorkspace: workspace, canonicalCwd: workspace, gitIdentityMatches: true,
        runtimeAvailable: true, localRunnerAvailable: true, dependenciesAvailable: true,
        resultAdapterAvailable: true, artifactsWritable: true, treeControlSupported: true,
        isolatedHome: true, stateOriginAllowed: true, stateAliasesOperational: false,
        tmpAliasesOperational: false, inheritedOperationalChannel: false,
        unitFiles: [...facts],
        files: Object.fromEntries(facts.map(file => [file, { kind: 'file' as const, realpath: `${workspace}/${file}`, unit: true }])),
      };
    },
    async spawn(command, onEvent) {
      spawned++;
      const red = { file: files[0], name: 'target red' };
      const pending = { file: files[1], name: 'target pending' };
      onEvent({ kind: 'discovered', test: red });
      onEvent({ kind: 'discovered', test: pending });
      if (mode === 'timeout') {
        onEvent({ kind: 'assertion-failed', test: red, diagnostic: 'assertion from target group' });
        let resolveWait!: (result: { exitCode: number; signal: string | null; stderr: string }) => void;
        const waitResult = new Promise<{ exitCode: number; signal: string | null; stderr: string }>(resolve => {
          resolveWait = resolve;
        });
        return {
          identity: `fake-tree-${spawned}`,
          wait() {
            queueMicrotask(() => {
              assert.ok(deadline, 'the existing wrapper must install its configured deadline');
              const active = deadline;
              now = active.at;
              active.callback();
            });
            return waitResult;
          },
          async cleanup() {
            resolveWait({ exitCode: 1, signal: null, stderr: '' });
            return { complete: true, remainingPids: [] };
          },
        };
      }
      const selected = command.environment.testIds ?? [red, pending];
      for (const id of selected) onEvent({ kind: 'passed', test: id });
      onEvent({ kind: 'complete', expected: selected });
      return {
        identity: `fake-tree-${spawned}`,
        async wait() { return { exitCode: 0, signal: null, stderr: '' }; },
        async cleanup() { return { complete: true, remainingPids: [] }; },
      };
    },
    subscribeInterruption() { return () => {}; },
    async reconcile() { recoveries++; return { alive: false, deadlineReached: true, cleanup: { complete: true, remainingPids: [] } }; },
  };
  function connect(h: ReturnType<typeof harness>) {
    h.ports.wrapper = async (r, unit) => {
      assert.equal(unit, h.context);
      const result = await runTestRun(r, config, policy, context, ports);
      return { code: result.outcome === 'passed' ? 0 : 1, stdout: JSON.stringify(result), stderr: '' };
    };
  }
  return {
    policy, context, ports, groups, keyOf, connect,
    counts() { return { spawned, recoveries }; },
    pass() { mode = 'pass'; },
  };
}

test('R06 real injected wrapper accumulates owner and foreign timeouts without resetting group or QA HOME', async () => {
  const shared = sharedWrapper();
  const key = { project: 'raf', workspace, group };
  for (let count = 1; count <= shared.policy.maxGroupTimeouts; count++) {
    const owner = count === 1;
    const a = owner ? assignment({ changes: [target] }) : assignment({
      agentId: `regression-agent-${count}`, runId: `source-run-${count}`, type: 'qa', phase: 'qa', regressionGroups: [grant()],
    });
    const h = harness(a);
    shared.connect(h);
    shared.context.agentId = a.agentId;
    shared.context.sha = `changed-sha-${count}`;
    const result = JSON.parse((await executeRegressionRun(h.command(), h.ports)).stdout) as TestRunResult;
    assert.equal(result.outcome, 'timed-out');
    assert.equal(result.timeoutCount, count);
    assert.deepEqual(result.knownRed, [{ file: files[0], name: 'target red' }]);
    assert.ok(result.unexecuted.some(id => id.file === files[1] && id.name === 'target pending'));
    assert.equal(shared.groups.size, 1);
    assert.deepEqual(h.keys, [key]);
    assert.equal(shared.context.home, '/qa/stable-target');
  }
  const foreign = harness();
  shared.connect(foreign);
  const before = shared.counts().spawned;
  const blocked = await executeRegressionRun(foreign.command(), foreign.ports);
  assert.notEqual(blocked.code, 0);
  assert.equal(shared.counts().spawned, before);
  assert.equal(shared.groups.get(shared.keyOf(key))!.timeoutCount, shared.policy.maxGroupTimeouts);
  shared.pass();
  const red = { file: files[0], name: 'target red' };
  const confirmed = JSON.parse((await executeRegressionRun(foreign.command(`test run --project raf --phase implement --group ${group} --only '${JSON.stringify(red)}'`), foreign.ports)).stdout) as TestRunResult;
  assert.equal(confirmed.knownRed.length, 0);
  assert.equal(confirmed.timeoutCount, shared.policy.maxGroupTimeouts);
  assert.ok(confirmed.unexecuted.some(id => id.name === 'target pending'));
  assert.equal(shared.counts().spawned, before + 1);
});

test('R07 real wrapper recovers the existing target reservation once and source closure cannot clean its aggregate', async () => {
  const shared = sharedWrapper();
  const h = harness();
  shared.connect(h);
  const key = { project: 'raf', workspace, group };
  const first = JSON.parse((await executeRegressionRun(h.command(), h.ports)).stdout) as TestRunResult;
  const stored = shared.groups.get(shared.keyOf(key))!;
  const initialTimeouts = stored.timeoutCount;
  stored.inFlight = { runId: first.runId, deadlineMs: 0, processIdentity: 'already-accounted-dead-tree' };
  stored.state = 'reconcile';
  shared.groups.set(shared.keyOf(key), stored);
  shared.pass();
  const red = { file: files[0], name: 'target red' };
  await executeRegressionRun(h.command(`test run --project raf --phase implement --group ${group} --only '${JSON.stringify(red)}'`), h.ports);
  assert.equal(shared.counts().recoveries, 1);
  assert.equal(shared.groups.get(shared.keyOf(key))!.timeoutCount, initialTimeouts);
  const before = structuredClone(shared.groups.get(shared.keyOf(key)));
  await cleanupClosedTestRunGroups([target], shared.context, shared.ports);
  assert.deepEqual(shared.groups.get(shared.keyOf(key)), before);
  await cleanupClosedTestRunGroups([], shared.context, shared.ports);
  assert.equal(shared.groups.size, 0);
});
