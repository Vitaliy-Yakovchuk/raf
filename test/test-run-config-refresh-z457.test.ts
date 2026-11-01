import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTestRunConfigurationUnchanged, captureTestRunConfiguration, type TestRunConfigurationReader } from '../src/test-run-config-dependencies.ts';
import { runResourceReservedTestRun } from '../src/test-run-reservations.ts';
import { validateTestRunConfig } from '../src/test-runs.ts';
import { config, context, copy, expectWaiting, file, fixture, oldRed, policy, request } from './helpers/test-run-reservations-fixture.ts';

function configuration() {
  let document = copy(config);
  let flow = copy(policy);
  const reader: TestRunConfigurationReader = {
    async read(path) { const text = JSON.stringify(path === 'conf/test-runs.json' ? document : { unitTests: flow }); return { text, revision: text }; },
    async revision(path) { return (await this.read(path)).revision; },
  };
  return { reader, get document() { return document; }, set document(value) { document = value; }, set flow(value) { flow = value; } };
}

const dependencies = [
  { file: 'conf/test-runs.json' as const, pointer: '/projects/raf/profiles/node' },
  { file: 'conf/test-runs.json' as const, pointer: '/projects/raf/groups/fix-raf-load-admission~1test-reservations' },
  { file: 'conf/flow.json' as const, pointer: '/unitTests' },
];

test('Z457 recheck accepts current test-runs document even when the old profile was replaced', async () => {
  const c = configuration();
  const snapshot = await captureTestRunConfiguration(dependencies, c.reader);
  c.document.projects.raf.profiles.corrected = c.document.projects.raf.profiles.node;
  delete c.document.projects.raf.profiles.node;
  c.document.projects.raf.groups[request.group].profileId = 'corrected';
  let refreshed: unknown;
  let configurationText: string | undefined;
  await assertTestRunConfigurationUnchanged(snapshot, c.reader, { refreshTestRuns: (value, text) => { refreshed = value; configurationText = text; } });
  assert.deepEqual(refreshed, c.document);
  assert.equal(configurationText, JSON.stringify(c.document));
});

test('Z457 refreshing test-runs still rejects changed flow policy', async () => {
  const c = configuration();
  const snapshot = await captureTestRunConfiguration(dependencies, c.reader);
  c.flow = { ...policy, timeoutMs: policy.timeoutMs + 1 };
  let refreshed = false;
  await assert.rejects(assertTestRunConfigurationUnchanged(snapshot, c.reader, { refreshTestRuns: () => { refreshed = true; } }), /conf\/flow.json#\/unitTests\/timeoutMs/);
  assert.equal(refreshed, false);
});

test('Z457 unreadable current test-runs is a setup error rather than a stale fallback', async () => {
  const c = configuration();
  const snapshot = await captureTestRunConfiguration(dependencies, c.reader);
  const reader = { ...c.reader, read: async (path: Parameters<TestRunConfigurationReader['read']>[0]) => {
    if (path === 'conf/test-runs.json') throw new Error('unreadable');
    return c.reader.read(path);
  } };
  let refreshed = false;
  await assert.rejects(assertTestRunConfigurationUnchanged(snapshot, reader, { refreshTestRuns: () => { refreshed = true; } }), /unreadableFiles.*conf\/test-runs.json/);
  assert.equal(refreshed, false);
});

for (const replaceProfile of [false, true]) {
  test(`Z457 queue resumes with current profile command and preserves group ledger (replace=${replaceProfile})`, async () => {
    const f = fixture();
    f.seed();
    const outstanding = { ...oldRed, file: 'test/unrelated-fixture.test.ts' };
    await f.ports.state.transaction(tx => { const group = tx.get({ project: request.project, workspace: context.workspace, group: request.group })!; group.knownRed = [outstanding]; tx.put(group); });
    const c = configuration();
    let current = copy(config);
    f.ports.configurationDependencies = {
      capture: () => captureTestRunConfiguration(dependencies, c.reader),
      recheck: snapshot => assertTestRunConfigurationUnchanged(snapshot, c.reader, {
        refreshTestRuns: value => { current = validateTestRunConfig(value, context.agentPhases, policy); },
      }),
      current: () => current,
    };
    f.shared.setRefusal('unavailable');
    const running = runResourceReservedTestRun(request, current, policy, context, f.ports);
    await expectWaiting(f, running);
    c.document.projects.raf.profiles.node.argv = ['./scripts/corrected-test-run-node.ts'];
    c.document.projects.raf.profiles.node.unitFiles.push('test/registered-by-another-agent.test.ts');
    if (replaceProfile) {
      c.document.projects.raf.profiles.corrected = c.document.projects.raf.profiles.node;
      delete c.document.projects.raf.profiles.node;
      c.document.projects.raf.groups[request.group].profileId = 'corrected';
    }
    f.advance(policy.timeoutMs * 5);
    f.shared.setRefusal(null); f.testQueue.grant();
    const result = await running;
    assert.equal(result.errorCode, undefined);
    assert.equal(result.outcome, 'assertions-failed', 'old red remains outstanding');
    assert.equal(result.timeoutCount, 1);
    assert.deepEqual(result.knownRed, [outstanding]);
    assert.deepEqual(result.selection.files, [file]);
    assert.equal(result.profileId, replaceProfile ? 'corrected' : 'node');
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0].argv[0], './scripts/corrected-test-run-node.ts');
    assert.deepEqual(result.command, f.spawned[0]);
    assert.equal(f.group()!.profileId, result.profileId);
    assert.equal(result.timedOut, false);
    assert.equal(result.cleanup.complete, true);
    assert.equal(f.shared.claims.size, 0);
    assert.equal(f.testQueue.records.length, 1);
    assert.equal(f.testQueue.starts.length, 1);
  });
}
