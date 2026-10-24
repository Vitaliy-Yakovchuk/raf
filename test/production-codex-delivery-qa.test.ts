import assert from 'node:assert/strict';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { launchPersistentWrapper } from '../src/launch-wrapper.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import type { RuntimeLaunch } from '../src/app-runtime.ts';
import type { LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { configuration, derivedLaunch, eventually, recordLaunchRunnerPath } from './production-fixture.ts';
import { productionCodexQaFixture as fixture } from './production-codex-qa-fixture.ts';
import { agentRunFixture, assertFailedLaunchCleaned, exists, until } from './agent-run-fixture.ts';
import { codexPastedBriefFixture } from './codex-pasted-brief-fixture.ts';

async function workerFixture(t: TestContext, prepareInFixture = true) {
  const f = await fixture(t);
  const runId = 'fixture-run-1';
  const address = f.params.id;
  const tmuxSession = 'raf-production-fixture';
  const reportPath = join(f.tmpRoot, runId, `${address}.json`);
  const releasePath = join(f.root, 'release.json');
  const exitGatePath = join(f.root, 'exit-gate');
  const deliveredPath = join(f.root, 'delivered.txt');
  const pidPath = join(f.root, 'agent.pid');
  const wrapperPidPath = join(f.root, 'wrapper.pid');
  f.trackPidFile(pidPath);
  f.trackPidFile(wrapperPidPath);
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const executable = join(f.binRoot, 'codex');
  await writeFile(executable, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0'); process.exit(0); }
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
console.log('OpenAI Codex (v0.0.0)\\nAsk Codex to do anything');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  input += text;
  if (input.includes('/status')) { console.log('Session: ${nativeId}\\nAsk Codex to do anything'); input = input.replace('/status', ''); }
  if (input.includes('BRIEF_END')) writeFileSync(${JSON.stringify(deliveredPath)}, input);
});
const watchdog = setTimeout(() => process.exit(91), 20000);
let release;
const timer = setInterval(() => {
  if (!release && existsSync(${JSON.stringify(releasePath)})) {
    release = JSON.parse(readFileSync(${JSON.stringify(releasePath)}, 'utf8'));
    if (release.report) writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(release.report));
  }
  if (!release || !existsSync(${JSON.stringify(exitGatePath)})) return;
  clearInterval(timer); clearTimeout(watchdog);
  process.exit(release.exitCode);
}, 30);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const settings: ProtocolSettings = {
    runner: 'codex', executable: 'codex', version: '0.0.0', baseArgs: [], modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config',
    modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null, quotaCommand: '/status', navigation: [],
    markers: { ready: ['Ask Codex to do anything'], auth_required: ['FIXTURE_AUTH_REQUIRED'], permission_required: ['FIXTURE_PERMISSION_REQUIRED'] },
    quotaParser: 'unknown', modelPools: {}, quotaReliable: false, liveTaskVerified: true,
    timeouts: { startupMs: 5000, transitionMs: 5000, overallMs: 10000, pollMs: 30 },
    collection: { intervalMs: 60000, failureBackoffMs: 60000, staleAfterMs: 60000 },
  };
  const rafPath = join(f.confRoot, 'raf.json');
  const raf = JSON.parse(await readFile(rafPath, 'utf8'));
  await writeFile(rafPath, JSON.stringify({ ...raf, runnerProtocols: [settings] }));
  const request: LaunchWrapperRequest = { tmpRoot: f.tmpRoot, runId, address, assignment: f.assignment, statePath: f.statePath, cwd: f.cwd, tmuxSession, selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, brief: 'DELIVERY_QA\n' + 'Я'.repeat(6579 - [...'DELIVERY_QA\n\nBRIEF_END'].length) + '\nBRIEF_END', readinessTimeoutMs: 5000 };
  const session = () => f.store.sessionRepository.transaction(tx => tx.getSession(runId));
  const runtimeLaunch: RuntimeLaunch = { runId, addressId: address, tmuxSession, activity: { type: 'implement', project: 'raf', features: f.params.features, phase: 'implement', cwd: f.cwd }, assignment: f.assignment, selection: { status: 'selected', ...request.selection, reason: 'synthetic fixture only', quota: 'unknown' }, statePath: f.statePath, tmpRoot: f.tmpRoot };
  if (prepareInFixture) {
    const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute });
    const { task: descriptor, launch: derived } = await derivedLaunch(services, f, runtimeLaunch);
    const prepared = await services.prepareReport(derived);
    assert.equal(prepared.reportPath, reportPath);
    const reservation = await services.reserve({ ...derived, reportPath: prepared.reportPath, requested: descriptor.requested, requiredFileSystemIds: [...descriptor.requiredFileSystemIds] });
    assert.equal(reservation.admitted, true, 'reason' in reservation ? reservation.reason : 'admitted');
    await recordLaunchRunnerPath(f.tmpRoot, runId, executable);
    const reserved = session();
    assert.ok(reserved?.launchContext);
    assert.equal(reserved.launchContext.reportPath, prepared.reportPath);
    await writeFile(reserved.launchContext.briefPath, request.brief);
    const claims = listTaskReservations(f.store);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].lease.owner.runId, runId);
    assert.ok(claims[0].lease.owner.fence.length > 0);
    assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  }
  const launch = async () => {
    const started = await launchPersistentWrapper({ ...request, reportedCommits: session()?.launchContext?.reportedCommits }, { timeoutMs: settings.timeouts.overallMs, workerCommand: { executable: process.execPath, args: ['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; import { runProductionWorker } from ${JSON.stringify(f.runtimeUrl)}; writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid)); process.env.PATH = ${JSON.stringify(f.binRoot + delimiter)} + (process.env.PATH ?? ''); process.env.HOME = ${JSON.stringify(f.home)}; await runProductionWorker();`] } });
    f.trackProcess(started.wrapperPid);
    f.trackProcess(started.identity.pid);
    assert.equal(Number(await readFile(wrapperPidPath, 'utf8')), started.wrapperPid);
    return started;
  };
  const report = { status: 'succeeded', answer: 'Виконано лише доручену fixture.', changes: [{ id: 'fixture-launch', items: [{ id: '2.1', status: 'succeeded' }] }] };
  return { ...f, runId, address, reportPath, releasePath, exitGatePath, deliveredPath, pidPath, nativeId, executable, settings, request, runtimeLaunch, launch, session, report };
}

async function deliveryFixture(t: TestContext, mode = 'race') {
  const f = await workerFixture(t, false);
  const pastedFrame = mode.startsWith('brief-fragment') || mode.startsWith('queue-footer') ? codexPastedBriefFixture(mode.startsWith('queue-footer') ? 19146 : 20177, mode.startsWith('queue-footer')) : undefined;
  if (pastedFrame) f.request.brief = pastedFrame.brief;
  f.settings.version = '0.160.0';
  f.settings.liveTaskVerified = false;
  f.settings.timeouts.transitionMs = 5000;
  f.settings.timeouts.pollMs = 30;
  f.settings.timeouts.overallMs = 30000;
  const rafPath = join(f.confRoot, 'raf.json');
  const raf = JSON.parse(await readFile(rafPath, 'utf8'));
  const completeRaf = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  await writeFile(rafPath, JSON.stringify({ ...completeRaf, ...raf, runnerProtocols: [f.settings] }));
  const services = await f.createProductionServices(f.store, configuration, f.context, { execute: f.execute, loadAverage1m: () => 0 });
  const { task: descriptor, launch: derived } = await derivedLaunch(services, f, f.runtimeLaunch);
  const prepared = await services.prepareReport(derived);
  const reservation = await services.reserve({ ...derived, reportPath: prepared.reportPath, requested: descriptor.requested, requiredFileSystemIds: [...descriptor.requiredFileSystemIds] });
  assert.equal(reservation.admitted, true, 'reason' in reservation ? reservation.reason : 'admitted');
  await recordLaunchRunnerPath(f.tmpRoot, f.runId, f.executable);
  await writeFile(f.session()!.launchContext!.briefPath, f.request.brief);
  const acceptedPath = join(f.root, 'native-accepted.json');
  const inputLog = join(f.root, 'native-input.jsonl');
  await writeFile(f.executable, String.raw`#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
writeFileSync(${JSON.stringify(f.pidPath)}, String(process.pid));
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
const mode = ${JSON.stringify(mode)};
const brief = ${JSON.stringify(f.request.brief)};
const nativeId = ${JSON.stringify(f.nativeId)};
const render = text => process.stdout.write('\x1b[2J\x1b[H' + text);
const header = ${JSON.stringify(pastedFrame?.header ?? 'OpenAI Codex (v0.160.0)')};
const footer = ${JSON.stringify(pastedFrame?.footer ?? 'GPT-6.1-Sol high fast · ~/Documents/orchestrator/raf-develop')};
const pastedFrame = ${JSON.stringify(pastedFrame ? { header: pastedFrame.pendingHeader, footer: pastedFrame.pendingFooter } : null)};
const nativeScreen = (input, extra = '') => header + (hasStatus ? '\r\nSession: ' + nativeId : '') + extra + '\r\n› ' + input + '\r\n' + footer;
const ready = () => render(header + '\r\n› Ask Codex to do anything\r\n' + footer);
ready();
let buffer = '';
let pending = false;
let absorbed = false;
let enters = 0;
let hasStatus = false;
const renderPending = () => {
  const count = [...brief].length + (absorbed ? 1 : 0) + (mode === 'wrong-count' ? 7 : 0);
  const id = mode === 'native-mismatch' ? '22222222-2222-4222-8222-222222222222' : nativeId;
  const heading = mode === 'auth' ? '\r\nFIXTURE_AUTH_REQUIRED' : mode === 'permission' ? '\r\nFIXTURE_PERMISSION_REQUIRED' : mode === 'unknown' || mode === 'menu-above-same-footer' ? '\r\nChoose an unknown action\r\nEnter to approve' : '';
  const nativeHeader = header + '\r\nSession: ' + id;
  if (pastedFrame) { render(pastedFrame.header.replaceAll('\n', '\r\n') + (mode.endsWith('-menu') ? '\r\nChoose an unknown action\r\nEnter to approve' : '') + '\r\n› [Pasted Content ' + count + ' chars]\r\n\r\n  ' + pastedFrame.footer); return; }
  if (mode === 'scrolled-paste') { render(brief.slice(-400) + '\r\n\r\n› [Pasted Content ' + count + ' chars]\r\n' + footer); return; }
  render(nativeHeader + heading + '\r\n› [Pasted Content ' + count + ' chars]' + (mode === 'stale-ready-menu' ? '\r\nAsk Codex to do anything\r\nChoose an unknown action\r\nEnter to approve' : '') + '\r\n' + footer);
};
const submit = () => {
  enters++;
  if (!absorbed) {
    absorbed = true;
    if (mode === 'repainting-paste') { render(brief.slice(-400)); setTimeout(renderPending, 400); return; }
    if (mode !== 'immediate') { renderPending(); return; }
  } else {
    if (mode === 'pending-forever') return;
    if (mode === 'vanished-unknown') { render('Session: ' + nativeId + '\r\nUnknown native transition'); return; }
  }
  writeFileSync(${JSON.stringify(acceptedPath)}, JSON.stringify({ brief, enters }));
  render('Session: ' + nativeId + '\r\n• Working (0s • esc to interrupt)\r\n› ');
};
process.stdin.on('data', data => {
  appendFileSync(${JSON.stringify(inputLog)}, JSON.stringify({ data, pending, absorbed }) + '\n');
  if (!hasStatus) {
    buffer += data;
    if (buffer.includes('/status') && /[\r\n]/.test(buffer)) {
      hasStatus = true;
      buffer = '';
      render(nativeScreen(mode === 'readiness-unknown' ? 'Approve unknown action' : 'Ask Codex to do anything'));
    } else if (buffer.includes('/status')) render(nativeScreen('/status'));
    return;
  }
  if (!pending) {
    buffer += data;
    const end = buffer.indexOf('BRIEF_END');
    if (end < 0) return;
    pending = true;
    renderPending();
    if (/[\r\n]/.test(buffer.slice(end + 'BRIEF_END'.length))) submit();
    return;
  }
  if (/[\r\n]/.test(data)) submit();
});
const watchdog = setTimeout(() => process.exit(91), 20000);
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(f.releasePath)}) || !existsSync(${JSON.stringify(f.exitGatePath)})) return;
  clearInterval(timer); clearTimeout(watchdog);
  process.exit(JSON.parse(readFileSync(${JSON.stringify(f.releasePath)}, 'utf8')).exitCode);
}, 30);
`, { mode: 0o700 });
  const release = async () => {
    await writeFile(f.releasePath, JSON.stringify({ exitCode: 0 }));
    await writeFile(f.exitGatePath, 'exit');
    await eventually(f.session, row => row?.state === 'finished', 'owned synthetic runner finalized');
  };
  const launch = async () => {
    try { return await f.launch(); }
    catch (error) {
      const accepted = await readFile(acceptedPath, 'utf8').catch(() => null);
      const rows = (await readFile(inputLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      t.diagnostic(JSON.stringify({ mode, accepted: accepted !== null, input: rows.map(row => ({ chars: [...row.data].length, pending: row.pending, absorbed: row.absorbed })) }));
      throw error;
    }
  };
  return { ...f, acceptedPath, inputLog, release, launch };
}

for (const mode of ['native-placeholder-replaced', 'race', 'immediate', 'scrolled-paste', 'repainting-paste', 'brief-fragment', 'queue-footer']) {
  test(`[production-codex-delivery-qa] ${mode}: parent handshake follows native acceptance`, async t => {
    const f = await deliveryFixture(t, mode);
    if (mode === 'native-placeholder-replaced') assert.equal([...f.request.brief].length, 6579);
    const started = await f.launch();
    const accepted = JSON.parse(await readFile(f.acceptedPath, 'utf8').catch(() => 'null'));
    assert.ok(accepted, 'parent reported running before native CLI accepted the initial brief');
    assert.equal(accepted.brief, f.request.brief);
    assert.equal(accepted.enters, mode === 'immediate' ? 1 : 2);
    assert.equal(started.identity.runnerSessionId, f.nativeId);
    assert.equal(started.identity.pid, Number(await readFile(f.pidPath, 'utf8')));
    assert.equal(f.session()?.state, 'running');
    assert.equal(f.settings.liveTaskVerified, false);
    await f.release();
  });
}

for (const mode of ['unknown', 'menu-above-same-footer', 'stale-ready-menu', 'auth', 'permission', 'wrong-count', 'native-mismatch', 'vanished-unknown', 'pending-forever', 'brief-fragment-menu', 'queue-footer-menu']) {
  test(`[production-codex-delivery-qa] ${mode}: no false handshake or blind submission`, async t => {
    const f = await deliveryFixture(t, mode);
    await assert.rejects(f.launch(), mode === 'pending-forever' ? /Native initial brief acceptance timed out/ : /delivery|accept|submission|identity|screen|protocol/i);
    const accepted = await readFile(f.acceptedPath, 'utf8').catch(() => null);
    assert.equal(accepted, null);
    const rows = (await readFile(f.inputLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const retries = rows.filter(row => row.pending && row.absorbed && /[\r\n]/.test(row.data));
    assert.equal(retries.length, ['vanished-unknown', 'pending-forever'].includes(mode) ? 1 : 0);
    assert.notEqual(f.session()?.state, 'reserved');
  });
}

test('[production-codex-delivery-qa] readiness-unknown: agent run leaves no claims after unknown native readiness and the same task can be launched again', async t => {
  const f = await agentRunFixture(t, 'readiness-unknown', { startupMs: 5000, transitionMs: 5000, overallMs: 30000 }, 'codex', { productionQa: true });
  const failed = await f.run('readiness-agent');
  await assertFailedLaunchCleaned(f, failed, 'readiness-unknown');
  const inputs = (await fs.readdir(f.control)).filter(name => name.startsWith('input-'));
  assert.equal(inputs.length, 1, 'the runner was asked for its native status');
  const typed = await fs.readFile(join(f.control, inputs[0]), 'utf8');
  assert.ok(typed.includes('/status'));
  assert.equal(/project|report_path|assignments/.test(typed), false, 'no brief after unknown readiness');
  await fs.writeFile(join(f.control, 'mode'), 'close');
  const retried = await f.run('readiness-agent');
  assert.equal(retried.exitCode, 0, JSON.stringify(retried));
  await until(() => exists(join(f.control, 'readiness-agent.brief')), Boolean, 'retried launch delivered the brief');
  const retry = f.inspect();
  assert.equal(retry.claims.length, 1, 'the retried launch holds the claim');
  assert.deepEqual(retry.sessions.map(session => session.state).sort(), ['finished', 'running']);
  await fs.writeFile(join(f.control, 'readiness-agent.close'), 'close');
  await until(async () => await exists(join(f.control, 'readiness-agent.close.code')) ? (await fs.readFile(join(f.control, 'readiness-agent.close.code'), 'utf8')).trim() : null, value => value === '0', 'retried agent closed');
  await until(f.owned, pids => pids.length === 0, 'no fixture process remains after close', 5000);
});
