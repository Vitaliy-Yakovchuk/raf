import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { createProductionServices } from '../src/production-runtime.ts';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import type { RuntimeConfiguration, RuntimeLaunch } from '../src/app-runtime.ts';
import type { LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { configuration as codexConfiguration, derivedLaunch, eventually, fixture, recordLaunchRunnerPath } from './production-fixture.ts';

const runtimeUrl = pathToFileURL(fileURLToPath(new URL('../src/production-runtime.ts', import.meta.url))).href;
const conf = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const configured: ProtocolSettings | undefined = conf.runnerProtocols.find((row: ProtocolSettings) => row.runner === 'claude');
const configuration: RuntimeConfiguration = {
  ...codexConfiguration,
  models: {
    ...codexConfiguration.models,
    runners: [...codexConfiguration.models.runners, { id: 'claude', initialEnabled: true }],
    models: [...codexConfiguration.models.models, { id: 'claude-opus', version: 'cli', runner: 'claude', effort: 'high', complexity: 'decision', enabled: true }],
  },
};

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function claudeFixture(t: TestContext, mode: 'accepted' | 'trust' | 'status-mismatch' | 'startup-banner' | 'startup-stuck' | 'startup-unknown') {
  assert.ok(configured, 'conf/raf.json#/runnerProtocols must define the claude protocol');
  const f = await fixture(t);
  const runId = 'claude-fixture-run';
  const address = f.params.id;
  const tmuxSession = 'raf-claude-fixture';
  let cwd = f.cwd;
  if (mode === 'trust') {
    cwd = join(f.root, 'unregistered-develop');
    assert.equal(spawnSync('git', ['init', '--quiet', '--initial-branch=develop', cwd], { encoding: 'utf8' }).status, 0);
  }
  const pidPath = join(f.root, 'claude.pid');
  const argvPath = join(f.root, 'claude-argv.json');
  const acceptedPath = join(f.root, 'claude-accepted.json');
  const inputLog = join(f.root, 'claude-input.jsonl');
  f.trackPidFile(pidPath);
  const settings: ProtocolSettings = structuredClone({ ...configured, timeouts: { ...configured.timeouts, startupMs: 5000, transitionMs: 5000, overallMs: 15000, pollMs: 30 } });
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify({ version: 1, state: { fileName: 'isolated.sqlite' }, commandTiming: configuration.commandTiming, runnerProtocols: [settings] }));
  await writeFile(join(f.confRoot, 'models.json'), JSON.stringify(configuration.models));
  f.store.initializeRunners(configuration.models.runners);
  const executable = join(f.binRoot, 'claude');
  await writeFile(executable, String.raw`#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log(${JSON.stringify(`${configured.version} (Claude Code)`)}); process.exit(0); }
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv));
const mode = ${JSON.stringify(mode)};
const sessionFlag = argv.indexOf('--session-id');
const assigned = sessionFlag < 0 ? 'missing' : argv[sessionFlag + 1];
const shown = mode === 'status-mismatch' ? '22222222-2222-4222-8222-222222222222' : assigned;
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
const render = text => process.stdout.write('\x1b[2J\x1b[H\x1b[?2004h' + text.replaceAll('\n', '\r\n'));
const header = '[Screen Reader Mode: on via flag]\nClaude Code v${configured.version}\nOpus 5.5 with high effort · Claude Max\n' + process.cwd();
const footer = "don't ask on (shift+tab to cycle)";
const ready = (extra = '') => render(header + extra + '\n' + footer + '\n$');
const banner = '[Screen Reader Mode: on via flag]';
if (mode === 'startup-banner') { render(banner); setTimeout(() => ready(), 800); }
else if (mode === 'startup-stuck') render(banner);
else if (mode === 'startup-unknown') render(banner + '\nUnexpected startup notice');
else if (mode === 'trust') render('[Screen Reader Mode: on via flag]\nPermission Required: Accessing workspace:\n' + process.cwd() + '\ny. Yes, I trust this folder\nn. No, exit\nEnter y/n:\nEnter to confirm · Esc to cancel');
else ready();
let typed = '';
let paste = null;
let pasted = null;
let enters = 0;
let panel = false;
process.stdin.on('data', data => {
  appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify({ data }) + '\n');
  if (mode === 'trust') return;
  let rest = data;
  while (rest.length) {
    if (paste !== null) {
      const end = rest.indexOf('\x1b[201~');
      if (end < 0) { paste += rest; rest = ''; break; }
      paste += rest.slice(0, end);
      rest = rest.slice(end + 6);
      pasted = paste;
      paste = null;
      const lines = (pasted.match(/[\r\n]/g) ?? []).length;
      render(header + '\npaste again to expand\n' + footer + '\n$\u00a0[Pasted text #1 +' + lines + ' lines]');
      continue;
    }
    if (rest.startsWith('\x1b[200~')) { paste = ''; rest = rest.slice(6); continue; }
    if (rest.startsWith('\x1b')) {
      rest = rest.slice(1);
      if (panel) { panel = false; ready('\nSettings dialog dismissed'); }
      continue;
    }
    const key = rest[0];
    rest = rest.slice(1);
    if (key !== '\r' && key !== '\n') { typed += key; if (!pasted) render(header + '\n' + footer + '\n$\u00a0' + typed); continue; }
    if (pasted !== null) {
      enters++;
      writeFileSync(${JSON.stringify(acceptedPath)}, JSON.stringify({ brief: pasted.replaceAll('\r', '\n'), enters }));
      render(header + '\nyou: ' + pasted.split(/[\r\n]/)[0] + '\nZigzagging…\n' + footer + '  ·  esc to interrupt\n$');
      pasted = null;
      continue;
    }
    if (typed === '/status') { panel = true; typed = ''; render(header + '\nyou: /status\nSettings  Status   Config   Usage   Stats\nVersion: ${configured.version}\nSession ID: ' + shown + '\nSession kind: interactive\nEsc to cancel'); continue; }
    if (typed === '/exit') process.exit(0);
    typed = '';
  }
});
setTimeout(() => process.exit(91), 20000);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const brief = ['CLAUDE_DELIVERY_QA', ...Array.from({ length: 40 }, (_, index) => `Рядок доручення ${index}`), 'BRIEF_END'].join('\n');
  const selection = { runner: 'claude' as const, model: 'claude-opus', effort: 'high' };
  const request: LaunchWrapperRequest = { tmpRoot: f.tmpRoot, runId, address, assignment: f.assignment, statePath: f.statePath, cwd, tmuxSession, selection, brief, readinessTimeoutMs: settings.timeouts.startupMs };
  const runtimeLaunch: RuntimeLaunch = { runId, addressId: address, tmuxSession, activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd }, assignment: f.assignment, selection: { status: 'selected', ...selection, reason: 'synthetic claude fixture only', quota: 'unknown' }, statePath: f.statePath, tmpRoot: f.tmpRoot };
  const services = await createProductionServices(f.store, configuration, f.context, { execute: f.execute });
  const { task, launch: derived } = await derivedLaunch(services, f, runtimeLaunch);
  const prepared = await services.prepareReport(derived);
  const reservation = await services.reserve({ ...derived, reportPath: prepared.reportPath, requested: task.requested, requiredFileSystemIds: [...task.requiredFileSystemIds] });
  assert.equal(reservation.admitted, true, 'reason' in reservation ? reservation.reason : 'admitted');
  await recordLaunchRunnerPath(f.tmpRoot, runId, executable);
  const session = () => f.store.sessionRepository.transaction(tx => tx.getSession(runId));
  await writeFile(session()!.launchContext!.briefPath, brief);
  const wrapperPidPath = join(f.root, 'wrapper.pid');
  f.trackPidFile(wrapperPidPath);
  const launch = async () => {
    const started = await launchPersistentWrapper(request, { timeoutMs: settings.timeouts.overallMs, workerCommand: { executable: process.execPath, args: ['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; import { runProductionWorker } from ${JSON.stringify(runtimeUrl)}; writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid)); process.env.PATH = ${JSON.stringify(f.binRoot + delimiter)} + (process.env.PATH ?? ''); process.env.HOME = ${JSON.stringify(f.home)}; await runProductionWorker();`] } });
    f.trackProcess(started.wrapperPid);
    f.trackProcess(started.identity.pid);
    return started;
  };
  const inputs = async () => (await readFile(inputLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).data as string);
  return { ...f, runId, settings, request, runtimeLaunch, services, session, launch, argvPath, acceptedPath, pidPath, wrapperPidPath, inputs, reportDirectory: join(f.tmpRoot, runId) };
}

test('[claude-delivery-qa] native claude protocol launches with assigned session id, scoped writes and verified brief acceptance', async t => {
  const f = await claudeFixture(t, 'accepted');
  const started = await f.launch();
  const argv: string[] = JSON.parse(await readFile(f.argvPath, 'utf8'));
  for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions']) assert.equal(argv.includes(forbidden), false, forbidden);
  assert.equal(argv[argv.indexOf('--model') + 1], 'opus');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  const assigned = argv[argv.indexOf('--session-id') + 1];
  assert.match(assigned, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(started.identity.runnerSessionId, assigned);
  assert.equal(started.identity.pid, Number(await readFile(f.pidPath, 'utf8')));
  const grants = argv.flatMap((value, index) => value === '--add-dir' ? [argv[index + 1]] : []);
  assert.ok(grants.includes(f.reportDirectory), `report directory must be granted: ${JSON.stringify(grants)}`);
  assert.ok(argv.includes(`Edit(/${f.reportDirectory}/**)`), `edit rule must be scoped to the report directory: ${JSON.stringify(argv)}`);
  assert.equal(argv.some(value => /^Edit$|^Write$|^Edit\(\/\/\*\*\)$/.test(value)), false, 'unscoped edit permission is forbidden');
  const accepted = JSON.parse(await readFile(f.acceptedPath, 'utf8'));
  assert.equal(accepted.brief, f.request.brief);
  assert.equal(accepted.enters, 1);
  assert.equal(f.session()?.state, 'running');
});

test('[claude-delivery-qa] native status with a foreign session id never receives the brief', async t => {
  const f = await claudeFixture(t, 'status-mismatch');
  await assert.rejects(f.launch(), /session identity|Session ID/i);
  assert.ok((await f.inputs()).join('').includes('/status'), 'the assigned identity must be checked on the native status screen');
  assert.equal(await readFile(f.acceptedPath, 'utf8').catch(() => null), null);
  assert.equal((await f.inputs()).some(data => data.includes('BRIEF_END')), false);
});

test('[claude-delivery-qa] workspace trust prompt outside registered branch directories fails fast without answering it and the starter releases the handed-off launch', async t => {
  const f = await claudeFixture(t, 'trust');
  const begun = Date.now();
  const failure = await f.launch().then(() => assert.fail('launch must fail on the workspace trust prompt'), (error: unknown) => error as Error);
  assert.match(String(failure.message), /RUNNER_WORKSPACE_UNTRUSTED/);
  assert.ok(Date.now() - begun < f.settings.timeouts.startupMs, 'trust prompt must be recognized before the readiness deadline');
  assert.deepEqual(await f.inputs(), [], 'raf must never answer the runner trust dialog');
  const runnerPid = Number(await readFile(f.pidPath, 'utf8'));
  await eventually(() => alive(runnerPid), value => value === false, 'runner on the trust prompt stopped');
  await f.services.compensate(f.runtimeLaunch, failure);
  await f.services.abortLaunch(f.runId, failure.message);
  assert.equal(f.session()?.state, 'finished');
  assert.deepEqual(listTaskReservations(f.store), []);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
});

test('[claude-delivery-qa] startup screen with only native startup lines is not ready yet and the launch proceeds once claude is ready', async t => {
  const f = await claudeFixture(t, 'startup-banner');
  assert.ok(f.settings.native?.startup?.includes('[Screen Reader Mode: on via flag]'), 'conf/raf.json#/runnerProtocols/claude/native/startup must list the screen reader startup line');
  const started = await f.launch();
  const argv: string[] = JSON.parse(await readFile(f.argvPath, 'utf8'));
  assert.equal(started.identity.runnerSessionId, argv[argv.indexOf('--session-id') + 1]);
  const accepted = JSON.parse(await readFile(f.acceptedPath, 'utf8'));
  assert.equal(accepted.brief, f.request.brief);
  assert.equal(f.session()?.state, 'running');
});

test('[claude-delivery-qa] startup screen that never becomes ready ends as a readiness timeout at startupMs, not as an unknown screen', async t => {
  const f = await claudeFixture(t, 'startup-stuck');
  const begun = Date.now();
  const failure = await f.launch().then(() => assert.fail('launch must not become ready on the startup screen'), (error: unknown) => error as Error);
  assert.match(String(failure.message), /readiness timed out/i);
  assert.doesNotMatch(String(failure.message), /unknown_screen|Runner readiness unknown/i);
  assert.ok(Date.now() - begun >= f.settings.timeouts.startupMs, 'the startup screen waits for the configured startup deadline');
  assert.deepEqual(await f.inputs(), [], 'nothing is typed while claude is starting');
});

test('[claude-delivery-qa] startup line together with an unknown line stays an unknown screen without input', async t => {
  const f = await claudeFixture(t, 'startup-unknown');
  const begun = Date.now();
  const failure = await f.launch().then(() => assert.fail('unknown startup screen must fail'), (error: unknown) => error as Error);
  assert.match(String(failure.message), /unknown_screen|Runner readiness unknown/i);
  assert.ok(Date.now() - begun < f.settings.timeouts.startupMs, 'an unknown screen is not waited out');
  assert.deepEqual(await f.inputs(), []);
});
