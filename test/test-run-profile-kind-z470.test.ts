import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestRun } from '../src/test-runs.ts';
import { acknowledgeTestRunDelivery } from '../src/test-run-state-recovery.ts';
import { fixtureRequest, key, policy, RunHarness } from './helpers/test-run-fixture.ts';

const run = (h: RunHarness) => runTestRun(fixtureRequest(), h.config, policy, h.context, h.ports);
const integrationFile = 'test/auth-disclosure.integration.test.ts';
const integrationId = { file: integrationFile, name: 'discloses the auth boundary' };

function useIntegrationProfile(h: RunHarness): void {
  const { unitFiles, ...base } = h.config.projects.raf.profiles.node;
  h.config.projects.raf.profiles.integration = { ...base, testKind: 'integration', integrationFiles: [integrationFile] };
  h.config.projects.raf.groups[key.group] = { profileId: 'integration', files: [integrationFile] };
  h.environment.files[integrationFile] = { kind: 'file', realpath: `${h.context.workspace}/${integrationFile}`, unit: false, testKind: 'integration' };
  h.context.integrationTests = { timeoutMs: 5000 };
}

async function failSetupWithoutTests(h: RunHarness) {
  h.events = [{ kind: 'file-setup-failed' }];
  h.exit = { exitCode: 1, signal: null, stderr: 'FilesNotFound' };
  const setup = await run(h);
  assert.equal(setup.outcome, 'setup-failed');
  assert.equal(setup.profileId, 'node');
  assert.equal(setup.testKind, 'unit');
  assert.deepEqual(setup.passed, []);
  assert.deepEqual(setup.knownRed, []);
  assert.deepEqual(setup.unexecuted, []);
  assert.deepEqual(setup.unknown, []);
  await acknowledgeTestRunDelivery(setup, h.state);
  return setup;
}

test('Z470 setup-failed run that executed no tests does not pin the group profile', async () => {
  const h = new RunHarness();
  await failSetupWithoutTests(h);
  const group = h.state.get()!;
  assert.equal(group.testKind, undefined);
  assert.equal(group.profileId, undefined);
  assert.equal(group.lastResult?.outcome, 'setup-failed');
  assert.equal(group.lastResult?.profileId, 'node');
});

test('Z470 empty unit setup-failed does not refuse a later integration profile', async t => {
  const h = new RunHarness();
  await failSetupWithoutTests(h);
  const stuck = h.state.get()!;
  stuck.testKind = 'unit';
  stuck.profileId = 'node';
  stuck.timeoutCount = 1;
  h.state.seed(stuck);
  useIntegrationProfile(h);
  h.events = [{ kind: 'passed', test: integrationId }, { kind: 'complete', expected: [integrationId] }];
  h.exit = { exitCode: 0, signal: null, stderr: '' };
  let warnings = '';
  t.mock.method(process.stderr, 'write', chunk => { warnings += String(chunk); return true; });
  const result = await runTestRun({ project: 'raf', phase: 'hotfix', group: key.group }, h.config, policy, h.context, h.ports);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.errorCode, undefined);
  assert.equal(result.testKind, 'integration');
  assert.equal(result.profileId, 'integration');
  assert.equal(result.timeoutCount, 1);
  assert.equal(h.spawns.length, 2);
  assert.match(warnings, /Warning:.*profile.*node.*integration/);
  assert.equal(h.state.get()!.testKind, 'integration');
  assert.equal(h.state.get()!.profileId, 'integration');
});
