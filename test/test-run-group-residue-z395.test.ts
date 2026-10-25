import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileTestRunGroup } from '../src/test-runs.ts';
import type { RunnerEvent, TestId, TestRunGroupKey, TestRunRequest, TestRunResult } from '../src/test-runs.ts';
import { runTestRunCli } from '../src/test-run-cli.ts';
import {
  alpha, beta, files, fixtureGroup, fixtureRequest, flushMicrotasks, key, policy, RunHarness,
} from './helpers/test-run-fixture.ts';

const a = alpha;
const b: TestId = { file: beta.file, name: alpha.name };
const sibling: TestId = { file: a.file, name: `${a.name} neighbor` };
const pending: TestId = { file: a.file, name: 'previously unexecuted' };
const clone = <T>(value: T): T => structuredClone(value);
const green = (...ids: TestId[]): RunnerEvent[] => [
  ...ids.map(test => ({ kind: 'passed' as const, test })), { kind: 'complete', expected: ids },
];

async function execute(h: RunHarness, overrides: Partial<TestRunRequest> = {}): Promise<{ result: TestRunResult; code: number }> {
  const request = fixtureRequest({ phase: 'implement', ...overrides });
  const output: string[] = [];
  const argv = ['--project', request.project, '--phase', request.phase, '--group', request.group];
  if (request.files) argv.push('--files', ...request.files);
  if (request.only) argv.push('--only', ...request.only.map(id => JSON.stringify(id)));
  const code = await runTestRunCli(argv, {
    config: h.config, policy, context: h.context, runtime: h.ports,
    stdout: text => output.push(text), stderr: () => {},
  });
  return { result: JSON.parse(output.join('')) as TestRunResult, code };
}

function residue(timeoutCount = 0): RunHarness {
  const h = new RunHarness();
  h.state.seed(fixtureGroup({
    timeoutCount, state: timeoutCount >= policy.maxGroupTimeouts ? 'confirm-known-red' : 'idle',
    selection: { files: [b.file], testIds: [] }, knownRed: [a, sibling], unexecuted: [pending],
  }));
  return h;
}

test('Z395 U1 accepted A red then B green preserves off-selection debt and gives exact confirmation guidance', async () => {
  const h = new RunHarness();
  h.events = [
    { kind: 'assertion-failed', test: a, diagnostic: 'historical assertion marker Z395' },
    { kind: 'passed', test: b }, { kind: 'complete', expected: [a, b] },
  ];
  h.exit.exitCode = 1;
  const initial = await execute(h, { phase: 'red' });
  assert.equal(initial.result.outcome, 'assertions-failed');
  assert.deepEqual(initial.result.knownRed, [a]);
  h.config.projects.raf.groups[key.group].files = [b.file];
  h.context.agentId = 'next-author';
  h.context.sha = 'b'.repeat(40);
  h.events = green(b);
  h.exit.exitCode = 0;
  const { result, code } = await execute(h, { files: [b.file], phase: 'qa' });
  assert.equal(result.exitCode, 0);
  assert.notEqual(code, 0);
  assert.equal(result.outcome, 'assertions-failed');
  assert.deepEqual(result.selection, { files: [b.file], testIds: [] });
  assert.deepEqual(result.passed, [b]);
  assert.deepEqual(result.knownRed, [a]);
  assert.deepEqual(result.removed, []);
  assert.equal(result.timeoutCount, initial.result.timeoutCount);
  assert.deepEqual(h.state.get()?.knownRed, [a]);
  assert.equal(h.spawns.length, 2);
  assert.ok(h.spawns[1].argv.includes(b.file));
  assert.ok(!h.spawns[1].argv.includes(a.file));
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.nextAction, 'confirm-known-red');
  const guidance = JSON.stringify({ diagnostics: result.diagnostics, hints: result.hints });
  assert.ok(guidance.includes(key.group), 'guidance identifies the stable group');
  assert.ok(guidance.includes(a.file) && guidance.includes(a.name), 'guidance identifies exact residual file/name');
  assert.match(guidance, /authoriz|permiss|grant|дозвіл|дозвол|повноваж/iu);
  assert.ok(!JSON.stringify(result.diagnostics).includes('historical assertion marker Z395'));
});

test('Z395 U1 off-selection unexecuted IDs survive a valid green subset with the same budget', async () => {
  const h = residue(policy.optimizeAfterTimeouts);
  h.events = green(b);
  const { result, code } = await execute(h, { files: [b.file] });
  assert.deepEqual(result.unexecuted, [pending]);
  assert.deepEqual(result.knownRed, [a, sibling]);
  assert.deepEqual(result.passed, [b]);
  assert.deepEqual(result.removed, []);
  assert.equal(result.timeoutCount, policy.optimizeAfterTimeouts);
  assert.notEqual(code, 0);
});

for (const dimension of ['project', 'workspace', 'group'] as const) {
  test(`Z395 U2 reads and recovery isolate the full key: ${dimension}`, async () => {
    const h = residue();
    const foreignKey: TestRunGroupKey = { ...key, [dimension]: `${key[dimension]}-foreign` };
    const foreignId = { ...b, name: 'foreign debt' };
    const foreign = fixtureGroup({ key: foreignKey, selection: { files: [files[2]], testIds: [] }, knownRed: [foreignId], timeoutCount: policy.maxGroupTimeouts });
    h.state.seed(foreign);
    h.events = green(b);
    const { result } = await execute(h, { files: [b.file] });
    assert.deepEqual(result.knownRed, [a, sibling]);
    assert.deepEqual(result.passed, [b]);
    assert.deepEqual(h.state.get(foreignKey), foreign);
    const current = clone(h.state.get()!);
    current.inFlight = { runId: 'target-recovery', processIdentity: 'target-process', deadlineMs: h.clock.now() + policy.timeoutMs };
    h.state.seed(current);
    foreign.inFlight = { runId: 'foreign-recovery', processIdentity: 'foreign-process', deadlineMs: h.clock.now() - 1 };
    h.state.seed(foreign);
    h.recovered = { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [101] } };
    const identities: (string | null)[] = [];
    h.ports.reconcile = async identity => { identities.push(identity); return clone(h.recovered); };
    const recovered = await reconcileTestRunGroup(key, policy, h.context, h.ports);
    assert.deepEqual(identities, ['target-process']);
    assert.deepEqual(recovered?.knownRed, [a, sibling]);
    assert.equal(recovered?.timeoutCount, 0);
    assert.deepEqual(h.state.get(foreignKey), foreign);
  });
}

for (const kind of ['discovered', 'passed', 'assertion-failed', 'complete'] as const) {
  for (const exact of [false, true]) {
    test(`Z395 U3 rejects off-selection ${kind} IDs in ${exact ? 'exact-name' : 'file'} selection`, async () => {
      const h = residue();
      const selected = exact ? a : b;
      const outsider = exact ? sibling : a;
      const event: RunnerEvent = kind === 'complete' ? { kind, expected: [selected, outsider] } : { kind, test: outsider };
      h.events = kind === 'complete' ? [{ kind: 'passed', test: selected }, event] : [{ kind: 'passed', test: selected }, event, { kind: 'complete', expected: [selected] }];
      const { result, code } = await execute(h, exact ? { files: undefined, only: [a] } : { files: [b.file] });
      assert.equal(result.outcome, 'setup-failed');
      assert.equal(result.nextAction, 'fix-setup');
      assert.ok(result.failureKinds.includes('setup'));
      assert.ok(!result.failureKinds.includes('assertions'), 'invalid runner IDs are not assertion-red');
      assert.ok(!result.passed.some(id => id.file === outsider.file && id.name === outsider.name));
      assert.deepEqual(result.knownRed, [a, sibling]);
      assert.deepEqual(h.state.get()?.knownRed, [a, sibling]);
      assert.deepEqual(result.removed, []);
      assert.equal(result.timeoutCount, 0);
      assert.notEqual(code, 0);
    });
  }
}

for (const failure of ['timeout', 'setup', 'interruption', 'missing-complete', 'protocol-error', 'cleanup'] as const) {
  test(`Z395 U4 a provisional exact pass followed by ${failure} cannot clear inherited knownRed`, async () => {
    const h = residue(policy.maxGroupTimeouts);
    h.events = failure === 'missing-complete' ? [{ kind: 'passed', test: a }] : green(a);
    if (failure === 'setup') h.events.push({ kind: 'file-setup-failed' });
    if (failure === 'protocol-error') h.events.push({ kind: 'protocol-error', diagnostic: 'truncated frame' });
    if (failure === 'cleanup') h.cleanupResult = { complete: false, remainingPids: [103] };
    if (failure === 'timeout' || failure === 'interruption') h.finishImmediately = false;
    const running = execute(h, { files: undefined, only: [a] });
    if (!h.finishImmediately) {
      await flushMicrotasks();
      assert.equal(h.spawns.length, 1);
      if (failure === 'timeout') h.clock.advance(policy.timeoutMs);
      else { assert.ok(h.interrupt); h.interrupt('SIGINT'); }
    }
    const { result, code } = await running;
    assert.deepEqual(result.knownRed, [a, sibling]);
    assert.deepEqual(h.state.get()?.knownRed, [a, sibling]);
    assert.deepEqual(result.removed, []);
    assert.ok(result.unexecuted.some(id => id.name === pending.name));
    assert.equal(result.timeoutCount, policy.maxGroupTimeouts + Number(failure === 'timeout'));
    assert.notEqual(code, 0);
  });
}

test('Z395 U4 exact confirmation after a narrowed selection preserves other debt and refuses a full run at the limit', async () => {
  const h = residue(policy.maxGroupTimeouts);
  h.events = green(a);
  const { result } = await execute(h, { files: undefined, only: [a] });
  assert.deepEqual(result.selection, { files: [a.file], testIds: [a] });
  assert.deepEqual(result.passed, [a]);
  assert.deepEqual(result.knownRed, [sibling]);
  assert.deepEqual(result.unexecuted, [pending]);
  assert.deepEqual(result.removed, []);
  assert.equal(result.timeoutCount, policy.maxGroupTimeouts);
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.spawns[0].environment.testIds, [a]);
  const refused = await execute(h, { files: [b.file] });
  assert.equal(refused.result.outcome, 'refused');
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.state.get()?.knownRed, [sibling]);
  assert.equal(h.state.get()?.timeoutCount, policy.maxGroupTimeouts);
});

for (const failure of ['interruption', 'cleanup', 'file-missing'] as const) {
  test(`Z395 U5 ${failure} cannot prove removal even with a replacement test in the selected file`, async () => {
    const h = residue();
    h.events = green(sibling);
    if (failure === 'file-missing') delete h.environment.files[a.file];
    if (failure === 'cleanup') h.cleanupResult = { complete: false, remainingPids: [103] };
    if (failure === 'interruption') h.finishImmediately = false;
    const running = execute(h, { files: [a.file] });
    if (failure === 'interruption') {
      await flushMicrotasks();
      assert.equal(h.spawns.length, 1);
      assert.ok(h.interrupt);
      h.interrupt('SIGINT');
    }
    const { result, code } = await running;
    assert.deepEqual(result.removed, []);
    assert.ok(h.state.get()?.knownRed.some(id => id.file === a.file && id.name === a.name));
    assert.ok(h.state.get()?.unexecuted.some(id => id.name === pending.name));
    assert.notEqual(code, 0);
    assert.equal(result.timeoutCount ?? h.state.get()?.timeoutCount, 0);
    if (failure === 'file-missing') assert.equal(h.spawns.length, 0);
  });
}

for (const guard of ['inventory', 'overlap', 'in-flight'] as const) {
  test(`Z395 U6 inherited residue does not bypass the existing ${guard} guard`, async () => {
    const h = residue(policy.maxGroupTimeouts);
    if (guard === 'inventory') {
      h.config.projects.raf.profiles.node.unitFiles = files.filter(file => file !== a.file);
      h.environment.unitFiles = files.filter(file => file !== a.file);
    }
    if (guard === 'overlap') h.state.seed(fixtureGroup({
      key: { ...key, group: 'add-raf-test-run/accepted-owner' },
      selection: { files: [a.file], testIds: [] }, knownRed: [a], timeoutCount: 1,
    }));
    if (guard === 'in-flight') {
      const current = clone(h.state.get()!);
      current.inFlight = { runId: 'already-running', processIdentity: 'active-process', deadlineMs: h.clock.now() + policy.timeoutMs };
      h.state.seed(current);
      h.recovered = { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [101] } };
    }
    const before = clone([...h.state.records]);
    const { result, code } = await execute(h, { files: undefined, only: [a] });
    assert.equal(result.outcome, 'refused');
    assert.equal(h.spawns.length, 0);
    assert.deepEqual([...h.state.records], before);
    assert.notEqual(code, 0);
  });
}
