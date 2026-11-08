import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, delimiter, basename } from 'node:path';
import { test } from 'node:test';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import type { RuntimeLaunch } from '../src/app-runtime.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { configuration, derivedLaunch, fixture, recordLaunchRunnerPath } from './production-fixture.ts';

const protocol = (runner: string, executable: string): ProtocolSettings => ({
  runner, executable, version: '0.133.0', baseArgs: [], modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config',
  modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null, quotaCommand: '/status', navigation: [],
  markers: { ready: ['Ask Codex to do anything'], auth_required: ['FIXTURE_AUTH_REQUIRED'], permission_required: ['FIXTURE_PERMISSION_REQUIRED'] },
  quotaParser: 'unknown', modelPools: {}, quotaReliable: false, liveTaskVerified: true,
  timeouts: { startupMs: 5000, transitionMs: 5000, overallMs: 10000, pollMs: 500 },
  collection: { intervalMs: 60000, failureBackoffMs: 60000, staleAfterMs: 60000 },
});

test('[agent-run-startup] independent runner probes start before any probe finishes, retaining ordered results', async t => {
  const f = await fixture(t);
  const runners = ['codex', 'grok', 'agy', 'claude'];
  await Promise.all(runners.map(id => writeFile(join(f.binRoot, id), '', { mode: 0o700 })));
  const configured = JSON.parse(await readFile(join(f.confRoot, 'raf.json'), 'utf8')).runnerProtocols as ProtocolSettings[];
  const pending: (() => void)[] = [];
  const started: string[] = [];
  let release = false;
  const services = await f.createProductionServices(f.store, {
    ...configuration, models: { ...configuration.models, runners: runners.map(id => ({ id, initialEnabled: true })) },
  }, f.context, {
    protocolSettings: runners.map(id => ({ ...configured.find(settings => settings.runner === id)!, executable: join(f.binRoot, id), version: '0.133.0' })),
    execute: async command => {
      if (!command.args.includes('--version')) return f.execute(command);
      const runner = basename(command.executable);
      started.push(runner);
      if (!release) await new Promise<void>(resolve => pending.push(resolve));
      return runner === 'agy'
        ? { exitCode: 1, stdout: '', stderr: 'not installed' }
        : { exitCode: 0, stdout: '0.133.0', stderr: '' };
    },
  });
  const snapshotPromise = services.routingSnapshot();
  while (started.length === 0) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 100));
  const concurrent = [...started];
  release = true;
  pending.forEach(resolve => resolve());
  const snapshot = await snapshotPromise;
  t.diagnostic(JSON.stringify({ concurrent }));
  assert.deepEqual([...concurrent].sort(), [...runners].sort(), JSON.stringify({ concurrent }));
  assert.deepEqual(Object.keys(snapshot.cliAvailable), runners);
  assert.deepEqual(snapshot.cliAvailable, { codex: true, grok: true, agy: false, claude: true });
  assert.ok(snapshot.cliReasons?.agy);
});

for (const statusDelayMs of [0, 400]) {
  test(`[agent-run-startup] native status acknowledgement (${statusDelayMs}ms) advances without extra polling or duplicate Enter`, async t => {
    const f = await fixture(t, { productionQa: true });
    const executable = join(f.binRoot, 'codex');
    const eventsPath = join(f.root, 'runner-events.jsonl');
    const runnerPidPath = join(f.root, 'runner.pid');
    f.trackPidFile(runnerPidPath);
    const synthetic = await readFile(new URL('../evidence/hotfix-1.1.6/synthetic-codex.mjs', import.meta.url), 'utf8');
    await writeFile(executable, synthetic.replace('/* fixture options */', `
const eventsPath = ${JSON.stringify(eventsPath)};
const runnerPidPath = ${JSON.stringify(runnerPidPath)};
const statusDelayMs = ${statusDelayMs};
`), { mode: 0o700 });
    const settings = protocol('codex', 'codex');
    const rafPath = join(f.confRoot, 'raf.json');
    const raf = JSON.parse(await readFile(rafPath, 'utf8'));
    await writeFile(rafPath, JSON.stringify({ ...raf, runnerProtocols: [settings] }));
    const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute });
    const runId = 'startup-regression';
    const launch: RuntimeLaunch = {
      runId, addressId: f.params.id, tmuxSession: runId,
      activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd },
      assignment: f.assignment, selection: { status: 'selected', runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reason: 'synthetic fixture', quota: 'unknown' },
      statePath: f.statePath, tmpRoot: f.tmpRoot,
    };
    const { task, launch: derived } = await derivedLaunch(services, f, launch);
    const prepared = await services.prepareReport(derived);
    const admission = await services.reserve({ ...derived, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
    assert.equal(admission.admitted, true);
    await recordLaunchRunnerPath(f.tmpRoot, runId, executable);
    const reserved = f.store.sessionRepository.transaction(tx => tx.getSession(runId));
    assert.ok(reserved?.launchContext);
    const brief = 'Only a synthetic startup regression. BRIEF_END';
    await writeFile(reserved.launchContext.briefPath, brief);
    const started = await launchPersistentWrapper({
      tmpRoot: f.tmpRoot, runId, address: f.params.id, assignment: f.assignment, statePath: f.statePath, cwd: f.cwd,
      tmuxSession: runId, selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, brief,
      reportedCommits: reserved.launchContext.reportedCommits, readinessTimeoutMs: 5000,
    }, { timeoutMs: 10000, workerCommand: { executable: process.execPath, args: ['--input-type=module', '-e', `
      import { runProductionWorker } from ${JSON.stringify(f.runtimeUrl)};
      process.env.PATH = ${JSON.stringify(f.binRoot + delimiter)} + (process.env.PATH ?? '');
      process.env.HOME = ${JSON.stringify(f.home)};
      await runProductionWorker();
    `] } });
    f.trackProcess(started.wrapperPid);
    f.trackProcess(started.identity.pid);
    assert.equal(started.identity.runnerSessionId, '3dbaae4a-e4cc-477f-b36c-3669d71ad68a');
    const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const typed = events.find(event => event.name === 'status-typed');
    const submitted = events.filter(event => event.name === 'status-submit');
    const shown = events.find(event => event.name === 'status-shown');
    const pasted = events.find(event => event.name === 'brief-pasted');
    t.diagnostic(JSON.stringify({ statusDelayMs, events }));
    assert.equal(submitted.length, 1, JSON.stringify(events));
    assert.ok(submitted[0].at - typed.at < 500, `status submission waited a poll: ${JSON.stringify(events)}`);
    assert.ok(pasted.at >= shown.at, `brief pasted before native identity: ${JSON.stringify(events)}`);
  });
}
