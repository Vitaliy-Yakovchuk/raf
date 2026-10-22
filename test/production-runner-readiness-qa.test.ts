import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createProductionServices } from '../src/production-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import { buildRunnerInvocation } from '../src/runner-protocols.ts';
import type { RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const configuration: RuntimeConfiguration = {
  catalog: { commands: [], reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }] },
  models: {
    version: 1,
    runners: [{ id: 'codex', initialEnabled: true }],
    models: [{ id: 'gpt-6.1-sol', version: '6.1', runner: 'codex', effort: 'high', complexity: 'decision', enabled: true }],
    routing: { complexityOrder: ['decision'], taskClassification: {}, runnerPreferences: [], modelTransitions: [], roleModelBindings: {} },
  },
  commandTiming: { emaAlpha: 0.1 },
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-runner-readiness-qa-'));
  const confRoot = join(root, 'conf');
  await mkdir(confRoot);
  const executable = join(root, 'synthetic-codex');
  const callsPath = join(root, 'calls.jsonl');
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args.length !== 1 || args[0] !== '--version') process.exit(90);
console.log('codex-cli 0.160.0');
`, { mode: 0o700 });
  const settings: ProtocolSettings = {
    runner: 'codex', executable, version: '0.160.0', baseArgs: ['--no-daemon', '--no-alt-screen'],
    modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config', modelAliases: {},
    promptTransport: 'positional', sessionIdFlag: null, quotaCommand: '/status', navigation: [],
    markers: { ready: ['Ask Codex to do anything'], auth_required: ['FIXTURE_AUTH_REQUIRED'], permission_required: ['FIXTURE_PERMISSION_REQUIRED'] },
    quotaParser: 'codex_status', modelPools: {}, quotaReliable: false, liveTaskVerified: false,
    timeouts: { startupMs: 5000, transitionMs: 5000, overallMs: 10000, pollMs: 30 },
    collection: { intervalMs: 60000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  };
  const statePath = join(root, 'isolated.sqlite');
  const store = openStateStore(statePath);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.initializeRunners(configuration.models.runners);
  const context: RuntimeContext = {
    orchestratorRoot: root, confRoot, artifactPath: join(root, 'catalog.json'), statePath,
    tmpRoot: join(root, 'tmp'), mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  };
  const configure = (runnerProtocols: unknown) => writeFile(join(confRoot, 'raf.json'), JSON.stringify({ version: 1, runnerProtocols }));
  const services = await createProductionServices(store, configuration, context);
  const calls = async () => (await readFile(callsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { settings, confRoot, configure, services, calls, store };
}

test('[production-runner-readiness-qa] first Codex task is eligible with false observation metadata and unknown quota', async t => {
  const f = await fixture(t);
  await f.configure([f.settings]);
  const snapshot = await f.services.routingSnapshot();
  assert.equal(snapshot.cliAvailable.codex, true);
  assert.equal(snapshot.runnerEnabled.codex, true);
  assert.deepEqual(snapshot.quotas, []);
  const selection = f.services.selectModel(configuration.models, snapshot, { complexity: 'decision', role: 'implement' });
  assert.equal(selection.status, 'selected');
  assert.equal(selection.quota, 'unknown');
  assert.equal(selection.model, 'gpt-6.1-sol');
  assert.equal(selection.effort, 'high');
  const invocation = buildRunnerInvocation(f.settings, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(invocation.liveTaskVerified, false);
  assert.equal(f.settings.liveTaskVerified, false);
  const persisted = JSON.parse(await readFile(join(f.confRoot, 'raf.json'), 'utf8'));
  assert.equal(persisted.runnerProtocols[0].liveTaskVerified, false);
  assert.deepEqual(await f.calls(), [['--version']]);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listSessions()), []);
});

test('[production-runner-readiness-qa] true observation metadata retains version eligibility', async t => {
  const f = await fixture(t);
  await f.configure([{ ...f.settings, liveTaskVerified: true }]);
  assert.equal((await f.services.routingSnapshot()).cliAvailable.codex, true);
  assert.deepEqual(await f.calls(), [['--version']]);
});

for (const [name, change] of [
  ['missing protocol', () => []],
  ['unsupported runner', (settings: ProtocolSettings) => [{ ...settings, runner: 'agy' }]],
  ['duplicate protocol', (settings: ProtocolSettings) => [settings, settings]],
  ['missing metadata', (settings: ProtocolSettings) => [{ ...settings, liveTaskVerified: undefined }]],
  ['string metadata', (settings: ProtocolSettings) => [{ ...settings, liveTaskVerified: 'false' }]],
  ['null metadata', (settings: ProtocolSettings) => [{ ...settings, liveTaskVerified: null }]],
  ['numeric metadata', (settings: ProtocolSettings) => [{ ...settings, liveTaskVerified: 0 }]],
  ['missing readiness', (settings: ProtocolSettings) => [{ ...settings, markers: {} }]],
  ['unsupported effort format', (settings: ProtocolSettings) => [{ ...settings, effortFormat: 'unknown' }]],
  ['invalid deadline', (settings: ProtocolSettings) => [{ ...settings, timeouts: { ...settings.timeouts, startupMs: 0 } }]],
] as const) {
  test(`[production-runner-readiness-qa] ${name} remains unavailable`, async t => {
    const f = await fixture(t);
    await f.configure(change(f.settings));
    const snapshot = await f.services.routingSnapshot();
    assert.equal(snapshot.cliAvailable.codex, false);
    assert.equal(f.services.selectModel(configuration.models, snapshot, { complexity: 'decision', role: 'implement' }).status, 'waiting');
    assert.deepEqual(await f.calls(), []);
  });
}

test('[production-runner-readiness-qa] mismatched installed version remains unavailable', async t => {
  const f = await fixture(t);
  await f.configure([{ ...f.settings, version: '0.161.0', liveTaskVerified: true }]);
  const snapshot = await f.services.routingSnapshot();
  assert.equal(snapshot.cliAvailable.codex, false);
  assert.equal(f.services.selectModel(configuration.models, snapshot, { complexity: 'decision', role: 'implement' }).status, 'waiting');
  assert.deepEqual(await f.calls(), [['--version']]);
});
