import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRun } from '../src/test-runs.ts';
import { acknowledgeTestRunDelivery } from '../src/test-run-state-recovery.ts';
import { alpha, beta, gamma, files, fixtureGroup, fixtureRequest, policy, RunHarness } from './helpers/test-run-fixture.ts';

const run = (h: RunHarness) => runTestRun(fixtureRequest(), h.config, policy, h.context, h.ports);

function changeProfile(h: RunHarness): void {
  h.config.projects.raf.profiles.corrected = h.config.projects.raf.profiles.node;
  delete h.config.projects.raf.profiles.node;
  h.config.projects.raf.groups[fixtureRequest().group].profileId = 'corrected';
}

for (const legacy of [false, true]) {
  test(`Z452 empty setup-failed aggregate permits corrected profile (legacy=${legacy})`, async t => {
    const h = new RunHarness();
    h.events = [{ kind: 'file-setup-failed' }];
    h.exit = { exitCode: 1, signal: null, stderr: 'No test files found' };
    const setup = await run(h);
    assert.equal(setup.outcome, 'setup-failed');
    assert.deepEqual(setup.passed, []);
    assert.deepEqual(setup.knownRed, []);
    await acknowledgeTestRunDelivery(setup, h.state);
    if (legacy) {
      const group = h.state.get()!;
      delete group.profileId;
      h.state.seed(group);
    }
    changeProfile(h);
    h.events = [{ kind: 'passed', test: alpha }, { kind: 'passed', test: beta }, { kind: 'complete', expected: [alpha, beta] }];
    h.exit = { exitCode: 0, signal: null, stderr: '' };
    let warnings = '';
    t.mock.method(process.stderr, 'write', chunk => { warnings += String(chunk); return true; });
    const result = await run(h);
    assert.equal(result.outcome, 'passed');
    assert.equal(h.spawns.length, 2);
    assert.equal(result.profileId, 'corrected');
    assert.equal(result.timeoutCount, 0);
    assert.equal(result.groupState, 'complete');
    assert.equal(h.state.get()!.profileId, 'corrected');
    assert.match(warnings, /Warning:.*profile.*node.*corrected/);
  });
}

test('Z452 a new profile aggregate retains the stable timeout and outstanding test ledger', async t => {
  const h = new RunHarness();
  h.events = [{ kind: 'assertion-failed', test: gamma }, { kind: 'complete', expected: [gamma] }];
  h.exit = { exitCode: 1, signal: null, stderr: '' };
  const old = await runTestRun(fixtureRequest({ files: [files[2]] }), h.config, policy, h.context, h.ports);
  await acknowledgeTestRunDelivery(old, h.state);
  const group = h.state.get()!;
  group.timeoutCount = policy.maxGroupTimeouts;
  group.unexecuted = [beta];
  h.state.seed(group);
  changeProfile(h);
  h.context.sha = 'sha-after';
  h.context.agentId = 'another-author';
  let warnings = '';
  t.mock.method(process.stderr, 'write', chunk => { warnings += String(chunk); return true; });
  const spawn = h.ports.spawn;
  h.ports.spawn = async (...args) => {
    const current = h.state.get()!;
    assert.equal(current.lastResult, null);
    assert.equal(current.delivery, undefined);
    assert.equal(current.profileId, 'corrected');
    assert.equal(current.timeoutCount, policy.maxGroupTimeouts);
    assert.deepEqual(current.knownRed, [gamma]);
    assert.deepEqual(current.unexecuted, [beta]);
    return spawn(...args);
  };
  h.events = [{ kind: 'passed', test: alpha }, { kind: 'complete', expected: [alpha] }];
  h.exit = { exitCode: 0, signal: null, stderr: '' };
  const result = await run(h);
  assert.equal(result.outcome, 'assertions-failed');
  assert.equal(h.spawns.length, 2);
  assert.equal(result.timeoutCount, policy.maxGroupTimeouts);
  assert.deepEqual(result.knownRed, [gamma]);
  assert.equal(result.nextAction, 'confirm-known-red');
  assert.match(warnings, /Warning:.*profile.*node.*corrected/);
});

test('Z452 profile change delivers a pending result before starting another aggregate', async () => {
  const h = new RunHarness();
  const first = await run(h);
  const before = structuredClone(h.state.get());
  changeProfile(h);
  const result = await run(h);
  assert.deepEqual(result, first);
  assert.deepEqual(h.state.get(), before);
  assert.equal(h.spawns.length, 1);
});

test('Z452 profile change cannot replace an in-flight aggregate', async () => {
  const h = new RunHarness();
  h.state.seed(fixtureGroup({ profileId: 'node', inFlight: { runId: 'active-run', deadlineMs: h.clock.now() + policy.timeoutMs, processIdentity: 'alive' } }));
  h.ports.recoverGroup = async () => null;
  const before = structuredClone(h.state.get());
  changeProfile(h);
  const result = await run(h);
  assert.equal(result.errorCode, 'GROUP_IN_FLIGHT');
  assert.deepEqual(h.state.get(), before);
  assert.equal(h.spawns.length, 0);
});

test('Z452 unchanged profile preserves the aggregate without a warning', async t => {
  const h = new RunHarness();
  const first = await run(h);
  await acknowledgeTestRunDelivery(first, h.state);
  let warnings = '';
  t.mock.method(process.stderr, 'write', chunk => { warnings += String(chunk); return true; });
  const second = await run(h);
  assert.equal(second.outcome, 'passed');
  assert.equal(h.spawns.length, 2);
  assert.equal(warnings, '');
  assert.deepEqual(second.selection.files, files.slice(0, 2));
});
