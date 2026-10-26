import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AdapterCommand } from '../src/agent-adapters.ts';
import type { RuntimeConfiguration } from '../src/app-runtime.ts';
import type { ProcessIdentity, ProcessObservation, SessionRecord } from '../src/session-state.ts';
import { openStateStore } from '../src/state-store.ts';
import { closeSessionInTransaction } from '../src/session-state.ts';
import { agentRunFixture as fixture, alive, exists, runnerScript, until } from './agent-run-fixture.ts';

const key = Symbol.for('raf.z437.close-worker');
const runtimeUrl = new URL('../src/production-runtime.ts?z437-close-worker', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && specifier === './os-runtime.ts') return { url: 'z437:os-runtime', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'z437:os-runtime') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(new URL('../src/os-runtime.ts', import.meta.url).href)};
      export const observeKnownProcesses = async identities => identities.map(identity => globalThis[Symbol.for('raf.z437.close-worker')].observe(identity));
    ` };
    return next(url, context);
  },
});
const { createProductionServices } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
test.after(() => hooks.deregister());

async function workerFixture(t: TestContext, state: 'running' | 'exited' | 'finished', runnerAlive: boolean, workerState: 'alive' | 'unknown' | 'replaced' = 'alive', finishDuringClose = false, recordedSocket?: string, ownerAction?: 'stopped', terminalResult: false | 'succeeded' | 'failed' = 'succeeded', generation?: string) {
  const root = await mkdtemp(join(tmpdir(), 'raf-z437-'));
  const store = openStateStore(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
  settings.timeouts = { startupMs: 100, transitionMs: 100, overallMs: 300, pollMs: 1 };
  const startedAt = '2026-10-26T00:00:00.000Z';
  const identity: ProcessIdentity = { pid: 437001, startedAt, runner: 'codex', runnerSessionId: 'native-z437', tmuxSession: 'z437', evidence: { command: generation ? `node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/${generation}/raf-main/bin/raf.ts` : 'unit codex', ...(generation ? { generation } : {}), ...(recordedSocket ? { tmuxSocket: recordedSocket, tmuxPane: '%439' } : {}) } };
  const wrapper: ProcessIdentity = { pid: 437002, startedAt, runner: 'raf', runnerSessionId: 'run-z437', tmuxSession: 'z437', evidence: { command: 'unit worker', runId: 'run-z437' } };
  const runDirectory = join(root, 'run-z437');
  await mkdir(runDirectory);
  await writeFile(join(runDirectory, 'brief.txt'), 'unit close worker');
  const session: SessionRecord = { runId: 'run-z437', addressId: 'worker', revision: 1, state: state === 'finished' ? 'exited' : state, ...(ownerAction ? { ownerAction } : {}), process: identity,
    ...(state === 'exited' ? { observation: { state: 'exited', observedAt: startedAt, exitCode: 0, evidence: 'runner exit recorded' } as ProcessObservation } : {}),
    ...(terminalResult ? {
      result: { status: terminalResult, response: 'accepted result', proof: { runId: 'run-z437' } },
      reportAcceptance: { runId: 'run-z437', status: terminalResult, event: `agent.${terminalResult}` },
    } : {}),
    launchContext: { wrapper, assignment: { root, changes: [] }, selection: { runner: 'codex', model: 'unit', effort: 'high', reason: 'unit' }, briefPath: join(runDirectory, 'brief.txt'), reportPath: join(runDirectory, 'worker.json') },
  };
  const main = { ...identity, pid: process.pid, runner: 'main', runnerSessionId: 'main' };
  store.sessionRepository.transaction(tx => { tx.putSession(session); if (state === 'finished') closeSessionInTransaction(tx, session, startedAt); tx.putSession({ runId: 'main-run', addressId: 'main', revision: 1, state: 'running', process: main }); if (state !== 'finished') tx.putReservation({ runId: session.runId, resource: 'unit', amount: 1 }); });
  let workerAlive = true;
  let tmuxAlive = true;
  let paneLive = runnerAlive;
  let paneId = '%439';
  const calls: AdapterCommand[] = [];
  const globals = globalThis as Record<symbol, unknown>;
  globals[key] = { observe(target: ProcessIdentity): ProcessObservation {
    const observedAt = new Date().toISOString();
    if (target.pid === wrapper.pid && workerState === 'unknown') return { state: 'unknown', observedAt, error: 'unit observation unavailable' };
    const alive = target.pid === process.pid || (target.pid === wrapper.pid ? workerAlive && workerState !== 'replaced' : runnerAlive);
    return alive ? { state: 'alive', observedAt, identity: target } : { state: 'exited', observedAt, exitCode: 0, evidence: 'unit process absent or replaced' };
  } };
  t.after(() => { delete globals[key]; });
  const constants = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  const configuration = { catalog: { commands: [], constants, reportStatuses: [{ id: 'succeeded', event: 'agent.succeeded' }, { id: 'failed', event: 'agent.failed' }] } } as unknown as RuntimeConfiguration;
  const services = await createProductionServices(store, configuration, { orchestratorRoot: root, confRoot: new URL('../../conf/', import.meta.url).pathname, artifactPath: join(root, 'catalog.json'), statePath: join(root, 'state.sqlite'), tmpRoot: root, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined }, {
    protocolSettings: [settings], execute: async command => {
      calls.push(structuredClone(command));
      if (command.executable === 'ps') return { exitCode: 0, stdout: `${process.pid} 1 Mon Oct 26 00:00:00 2026 unit codex\n`, stderr: '' };
      if (command.executable === 'kill') { assert.equal(command.args.at(-1), String(wrapper.pid)); workerAlive = false; }
      else if (command.executable === 'tmux' && !tmuxAlive) return { exitCode: 1, stdout: '', stderr: "can't find session" };
      else if (command.executable === 'tmux' && command.args.includes('list-panes')) return { exitCode: 0, stdout: `${identity.pid}\n`, stderr: '' };
      else if (command.executable === 'tmux' && command.args.includes('display-message')) return { exitCode: 0, stdout: command.args.at(-1) === '#{pane_id}\t#{pane_dead}' ? `${paneId}\t${paneLive ? 0 : 1}\n` : command.args.at(-1) === '#{pane_id}' ? `${paneId}\n` : `${identity.pid}\n`, stderr: '' };
      else if (command.executable === 'tmux' && command.args.includes('kill-session')) {
        runnerAlive = false;
        tmuxAlive = false;
        paneLive = false;
        if (finishDuringClose) store.sessionRepository.transaction(tx => closeSessionInTransaction(tx, tx.getSession(session.runId)!, startedAt));
      }
      else assert.fail(`Unexpected operation: ${JSON.stringify(command)}`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  return { services, store, calls, session, runDirectory, workerAlive: () => workerAlive, runnerAlive: () => runnerAlive, tmuxAlive: () => tmuxAlive, setPaneLive: (value: boolean) => { paneLive = value; }, setPaneId: (value: string) => { paneId = value; } };
}

for (const state of ['running', 'exited'] as const) for (const runnerAlive of [false, true]) {
  test(`Z437 close stops the worker of a ${state} session with runnerAlive=${runnerAlive}`, async t => {
    const f = await workerFixture(t, state, runnerAlive);
    const result = await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' });
    assert.equal(result.closed, true);
    assert.equal(result.result, 'succeeded', 'preserve the accepted result');
    assert.equal(f.workerAlive(), false, 'close must stop the lingering worker');
    assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId))?.state, 'finished');
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
    assert.equal(f.calls.filter(call => call.executable === 'tmux' && call.args.includes('kill-session')).length, runnerAlive ? 1 : 0);
    await assert.rejects(readFile(join(f.runDirectory, 'brief.txt')), { code: 'ENOENT' });
  });
}

test('Z437 close stops the worker when runner shutdown concurrently finishes the session', async t => {
  const f = await workerFixture(t, 'exited', true, 'alive', true);
  assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' })).closed, true);
  assert.equal(f.workerAlive(), false);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId))?.state, 'finished');
});

test('Z437 close preserves a worker whose process observation is unknown', async t => {
  const f = await workerFixture(t, 'exited', false, 'unknown');
  await assert.rejects(f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' }));
  assert.equal(f.workerAlive(), true);
  assert.equal(f.calls.some(call => call.executable === 'kill'), false);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId))?.state, 'exited');
});

test('Z437 close never signals a replacement PID belonging to another worker', async t => {
  const f = await workerFixture(t, 'exited', false, 'replaced');
  assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' })).closed, true);
  assert.equal(f.calls.some(call => call.executable === 'kill'), false);
});

test('Z437 close accepts a finished session and stops its lingering worker without repeating result events', async t => {
  const f = await workerFixture(t, 'finished', false);
  const before = f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId));
  assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' })).closed, true);
  assert.equal(f.workerAlive(), false);
  assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'repeat recovery' })).closed, true);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId)), before);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listPending()), []);
});

test('[agent-close-exit] agent close waits for the runner process that outlives its tmux pane (t4-06: ≈750 ms after SIGHUP)', async t => {
  const f = await fixture(t, 'close', { startupMs: 20000, transitionMs: 5000, overallMs: 30000 }, 'codex', { productionQa: true });
  const lingering = runnerScript.replace('setInterval(() => {}, 1000);', "setInterval(() => {}, 1000);\nprocess.on('SIGHUP', () => setTimeout(() => process.exit(129), 750));");
  assert.notEqual(lingering, runnerScript);
  await fs.writeFile(join(f.directory, 'bin', 'codex'), `#!${process.execPath}\n${lingering}`, { mode: 0o700 });
  const launched = await f.run('linger-agent');
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const runId = JSON.parse(launched.result.stdout).runId;
  await until(() => exists(join(f.control, 'linger-agent.brief')), Boolean, 'runner received brief');
  const reason = 'Verify process exit after forced closure of the reportless lingering fixture';
  await fs.writeFile(join(f.control, 'linger-agent.close'), JSON.stringify(['--force', '--reason', reason]));
  const code = await until(async () => await exists(join(f.control, 'linger-agent.close.code')) ? (await fs.readFile(join(f.control, 'linger-agent.close.code'), 'utf8')).trim() : null, value => value !== null, 'agent close finished');
  const printed = await fs.readFile(join(f.control, 'linger-agent.close.out'), 'utf8');
  assert.equal(code, '0', printed);
  const output = JSON.parse(JSON.parse(printed).stdout);
  assert.equal(output.closed, true, printed);
  assert.deepEqual(output.forcedClose, { reason });
  assert.deepEqual((await f.runners()).filter(alive), []);
  const snapshot = f.inspect();
  assert.equal(snapshot.sessions.find(row => row.runId === runId)?.state, 'finished');
  assert.deepEqual(snapshot.sessions.find(row => row.runId === runId)?.result?.forcedClose, { reason });
  assert.deepEqual(snapshot.claims, []);
  assert.deepEqual(snapshot.admission, []);
  assert.deepEqual(await f.runDirectories(), []);
});

test('Z439 close stops a verified live runner even when its session is already finished', async t => {
  const f = await workerFixture(t, 'finished', true);
  const before = f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId));
  assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' })).closed, true);
  assert.equal(f.runnerAlive(), false, 'finished metadata must not leave the runner and tmux session alive');
  assert.equal(f.workerAlive(), false);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId)), before);
  assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listPending()), []);
});

test('Z439 close uses the runner recorded tmux socket for verification and removal', async t => {
  const socket = '/tmp/z439-unit-owned-server.sock';
  const f = await workerFixture(t, 'exited', true, 'alive', false, socket);
  assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' })).closed, true);
  const operations = f.calls.filter(call => call.executable === 'tmux');
  assert.ok(operations.some(call => call.args.includes('kill-session')));
  for (const call of operations) assert.equal(call.args[call.args.indexOf('-S') + 1], socket, JSON.stringify(call.args));
  assert.equal(f.runnerAlive(), false);
});

test('Z439 close removes the recorded dead pane left after runner exit', async t => {
  const f = await workerFixture(t, 'exited', false, 'alive', false, '/tmp/z439-unit-owned-server.sock');
  assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' })).closed, true);
  assert.equal(f.tmuxAlive(), false, 'a dead runner can leave a live tmux session with remain-on-exit');
  assert.equal(f.workerAlive(), false);
});

test('Z439 close removes its still-live pane after the recorded runner has exited', async t => {
  const f = await workerFixture(t, 'finished', false, 'alive', false, '/tmp/z439-unit-owned-server.sock');
  f.setPaneLive(true);
  assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' })).closed, true);
  assert.equal(f.tmuxAlive(), false, 'close must remove the owned pane even when a process outlives the recorded runner');
  assert.equal(f.workerAlive(), false);
});

test('Z439 close preserves a replacement pane and refuses removal while the session is not finished', async t => {
  const f = await workerFixture(t, 'exited', false, 'alive', false, '/tmp/z439-unit-owned-server.sock', undefined, false);
  f.setPaneId('%440');
  await assert.rejects(f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' }), /Exited runner pane was replaced/);
  assert.equal(f.tmuxAlive(), true);
  assert.equal(f.workerAlive(), true);
  assert.equal(f.calls.some(call => call.args.includes('kill-session')), false);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId))?.state, 'exited');
});

test('Z466 close of a finished stopped agent warns and completes when its exited runner pane was replaced', async t => {
  const f = await workerFixture(t, 'finished', false, 'alive', false, '/tmp/z466-unit-owned-server.sock', 'stopped');
  f.setPaneId('%440');
  const before = f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId));
  assert.equal(before?.state, 'finished');
  assert.equal(before?.ownerAction, 'stopped');
  const warnings: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    warnings.push(String(chunk));
    return write(chunk, encoding as BufferEncoding, callback);
  }) as typeof process.stderr.write;
  try {
    const result = await f.services.control.close('worker', undefined, { force: true, reason: 'owner recovery' });
    assert.equal(result.closed, true);
    assert.equal(result.result, 'succeeded');
    assert.match(warnings.join(''), /Warning:.*Exited runner pane was replaced; preserve its tmux session/);
    assert.equal(f.tmuxAlive(), true);
    assert.equal(f.calls.some(call => call.args.includes('kill-session')), false);
    assert.equal(f.workerAlive(), false, 'close completes by stopping the lingering worker');
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId)), before);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listPending()), []);
    warnings.length = 0;
    assert.equal((await f.services.control.close('worker', undefined, { force: true, reason: 'repeat recovery' })).closed, true);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId)), before);
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listPending()), []);
  } finally {
    process.stderr.write = write;
  }
});

async function expectReplacedPaneWarning(close: () => Promise<{ closed: boolean; result?: string }>, tmuxAlive: () => boolean, calls: { args: string[] }[]) {
  const warnings: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    warnings.push(String(chunk));
    return write(chunk, encoding as BufferEncoding, callback);
  }) as typeof process.stderr.write;
  try {
    const result = await close();
    assert.equal(result.closed, true);
    assert.match(warnings.join(''), /Warning:.*Exited runner pane was replaced; preserve its tmux session/);
    assert.equal(tmuxAlive(), true);
    assert.equal(calls.some(call => call.args.includes('kill-session')), false);
    return result;
  } finally {
    process.stderr.write = write;
  }
}

for (const state of ['exited', 'running'] as const) for (const status of ['succeeded', 'failed'] as const) {
  test(`Z472 close of a ${state} agent with accepted result ${status} warns when its exited runner pane was replaced`, async t => {
    const f = await workerFixture(t, state, false, 'alive', false, '/tmp/z472-unit-owned-server.sock', undefined, status);
    f.setPaneId('%440');
    const result = await expectReplacedPaneWarning(() => f.services.control.close('worker'), f.tmuxAlive, f.calls);
    assert.equal(result.result, status);
    assert.equal(f.workerAlive(), false, 'close completes by stopping the lingering worker');
    assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId))?.state, 'finished');
    assert.deepEqual(f.store.sessionRepository.transaction(tx => tx.listReservations()), []);
  });
}

test('Z472 close of a completed agent launched on a previous generation warns when its pane was replaced', async t => {
  const generation = 'abbd688f-previous-generation';
  const f = await workerFixture(t, 'exited', false, 'alive', false, '/tmp/z472-previous-generation.sock', undefined, 'succeeded', generation);
  f.setPaneId('%440');
  assert.equal(f.session.process?.evidence.generation, generation);
  const before = f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId));
  assert.notEqual(before?.state, 'finished');
  assert.equal(before?.result?.status, 'succeeded');
  const result = await expectReplacedPaneWarning(() => f.services.control.close('worker'), f.tmuxAlive, f.calls);
  assert.equal(result.result, 'succeeded');
  assert.equal(f.workerAlive(), false);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId))?.state, 'finished');
  assert.equal(f.calls.some(call => call.args.includes('kill-session')), false);
});
