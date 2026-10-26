import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AdapterCommand } from '../src/agent-adapters.ts';
import type { RuntimeConfiguration } from '../src/app-runtime.ts';
import type { DeliveryClaimOwner } from '../src/state-store.ts';
import type { ProcessIdentity, ProcessObservation, SessionRecord } from '../src/session-state.ts';
import { openStateStore } from '../src/state-store.ts';
import { closeSessionInTransaction, createSessionState, type WorkResult } from '../src/session-state.ts';
import { resultNoticeViews, settleResultNotices } from '../src/reminder-cli.ts';
import { commandFixture, type CommandFixture } from './reminder-fixture.ts';

const pastedReason = 'Message delivery failed: Agent acceptance is unconfirmed after bounded delivery verification';

function launched(f: CommandFixture, address: string): SessionRecord & { reportPath: string } {
  const base = f.session(address);
  const reportPath = join(dirname(f.statePath), 'tmp', base.runId, `${address}.json`);
  const record: SessionRecord = {
    ...base,
    revision: base.revision + 1,
    launchContext: {
      assignment: { root: f.root, changes: [{ id: 'z474', items: [{ id: 'Z.474', description: 'Close once' }] }], baselineArchives: [] },
      selection: { runner: 'codex', model: 'fixture', effort: 'high', reason: 'fixture' },
      briefPath: join(dirname(f.statePath), 'tmp', base.runId, 'brief.txt'),
      reportPath,
    },
  };
  f.store.sessionRepository.transaction(tx => tx.putSession(record));
  return { ...record, reportPath };
}

function accept(f: CommandFixture, session: SessionRecord & { reportPath: string }, answer: string) {
  const state = createSessionState({ repository: f.store.sessionRepository, verifyMainAuthority: () => true, verifyWorkResult: () => true });
  const result: WorkResult = { status: 'succeeded', response: answer, proof: { reportPath: session.reportPath } };
  assert.equal(state.acceptWorkResult(session.runId, result, { pending: [], domain: [], reportAccepted: true }), true);
}

function markPasted(store: CommandFixture['store'], runId: string) {
  const notice = store.resultNotices.list().find(row => row.runId === runId);
  assert.ok(notice, `result notice for ${runId}`);
  const owner: DeliveryClaimOwner = { token: randomUUID(), pid: process.pid, processStart: null };
  assert.ok(store.resultNotices.claim(notice.id, owner, '2026-10-26T19:25:53.000Z', () => false));
  store.resultNotices.complete(notice.id, owner.token, pastedReason);
  const saved = store.resultNotices.list().find(row => row.runId === runId);
  assert.equal(saved?.state, 'pending');
  assert.ok((saved?.attempts ?? 0) >= 1);
  assert.match(saved?.lastError ?? '', /unconfirmed after bounded delivery verification/);
}

test('[Z.474] a finished agent whose succeeded event was already pasted leaves agent ps and is not sent again', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const worker = launched(f, 'etchly-goq26-impl');
  accept(f, worker, 'Звіт вже показано main');
  markPasted(f.store, worker.runId);
  f.finish(f.getSession(worker.runId)!);
  assert.equal(f.getSession(worker.runId)?.state, 'finished');
  assert.equal(resultNoticeViews(f.store, []).some(row => row.runId === worker.runId), false, 'first successful close must drop the agent from agent ps');
  f.accept(() => true);
  await f.settle();
  assert.equal(f.deliveries.filter(row => row.text.includes('agent.succeeded')).length, 0, 'first successful close must stop another agent.succeeded');
});

test('[Z.474] a finished agent whose result was never pasted stays in agent ps until the one delivery', async t => {
  const f = await commandFixture(t);
  f.session('main', { project: 'orchestrator' });
  const worker = launched(f, 'worker');
  accept(f, worker, 'Ще не надіслано');
  f.accept(() => false);
  await f.settle();
  f.finish(f.getSession(worker.runId)!);
  const view = resultNoticeViews(f.store, []).find(row => row.runId === worker.runId);
  assert.equal(view?.state, 'finished');
  assert.equal(view?.resultNotice?.state, 'pending');
  assert.equal((view?.resultNotice?.lastError ?? '').includes('unconfirmed after bounded delivery verification'), false);
  f.accept(() => true);
  await f.settle();
  assert.equal(f.deliveries.filter(row => row.accepted && row.text.includes('agent.succeeded')).length, 1);
});

const key = Symbol.for('raf.z474.close-ps');
const runtimeUrl = new URL('../src/production-runtime.ts?z474-close-ps', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && specifier === './os-runtime.ts') return { url: 'z474:os-runtime', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'z474:os-runtime') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(new URL('../src/os-runtime.ts', import.meta.url).href)};
      export const observeKnownProcesses = async identities => identities.map(identity => globalThis[Symbol.for('raf.z474.close-ps')].observe(identity));
    ` };
    return next(url, context);
  },
});
const { createProductionServices } = await import(runtimeUrl) as typeof import('../src/production-runtime.ts');
test.after(() => hooks.deregister());

async function closeFixture(t: TestContext, state: 'exited' | 'finished') {
  const root = await mkdtemp(join(tmpdir(), 'raf-z474-'));
  const store = openStateStore(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((row: { runner: string }) => row.runner === 'codex');
  settings.timeouts = { startupMs: 100, transitionMs: 100, overallMs: 300, pollMs: 1 };
  const startedAt = '2026-10-26T00:00:00.000Z';
  const identity: ProcessIdentity = { pid: 474001, startedAt, runner: 'codex', runnerSessionId: 'native-z474', tmuxSession: 'z474', evidence: { command: 'unit codex' } };
  const wrapper: ProcessIdentity = { pid: 474002, startedAt, runner: 'raf', runnerSessionId: 'run-z474', tmuxSession: 'z474', evidence: { command: 'unit worker', runId: 'run-z474' } };
  const runDirectory = join(root, 'run-z474');
  await mkdir(runDirectory);
  await writeFile(join(runDirectory, 'brief.txt'), 'unit close ps');
  const session: SessionRecord = {
    runId: 'run-z474', addressId: 'worker', revision: 1, state: state === 'finished' ? 'exited' : state, process: identity,
    ...(state === 'exited' ? { observation: { state: 'exited', observedAt: startedAt, exitCode: 0, evidence: 'runner exit recorded' } as ProcessObservation } : {}),
    result: { status: 'succeeded', response: 'accepted result', proof: { runId: 'run-z474' } },
    reportAcceptance: { runId: 'run-z474', status: 'succeeded', event: 'agent.succeeded' },
    launchContext: { wrapper, assignment: { root, changes: [] }, selection: { runner: 'codex', model: 'unit', effort: 'high', reason: 'unit' }, briefPath: join(runDirectory, 'brief.txt'), reportPath: join(runDirectory, 'worker.json') },
  };
  const main = { ...identity, pid: process.pid, runner: 'main', runnerSessionId: 'main' };
  store.sessionRepository.transaction(tx => {
    tx.putSession(session);
    if (state === 'finished') closeSessionInTransaction(tx, session, startedAt);
    tx.putSession({ runId: 'main-run', addressId: 'main', revision: 1, state: 'running', process: main });
    if (state !== 'finished') tx.putReservation({ runId: session.runId, resource: 'unit', amount: 1 });
  });
  let workerAlive = true;
  const globals = globalThis as Record<symbol, unknown>;
  globals[key] = { observe(target: ProcessIdentity): ProcessObservation {
    const observedAt = new Date().toISOString();
    const alive = target.pid === process.pid || (target.pid === wrapper.pid && workerAlive);
    return alive ? { state: 'alive', observedAt, identity: target } : { state: 'exited', observedAt, exitCode: 0, evidence: 'unit process absent' };
  } };
  t.after(() => { delete globals[key]; });
  const constants = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  const configuration = { catalog: { commands: [], constants, reportStatuses: [{ id: 'succeeded', event: 'agent.succeeded' }, { id: 'failed', event: 'agent.failed' }] } } as unknown as RuntimeConfiguration;
  const calls: AdapterCommand[] = [];
  const services = await createProductionServices(store, configuration, { orchestratorRoot: root, confRoot: new URL('../../conf/', import.meta.url).pathname, artifactPath: join(root, 'catalog.json'), statePath: join(root, 'state.sqlite'), tmpRoot: root, mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined }, {
    protocolSettings: [settings], execute: async command => {
      calls.push(structuredClone(command));
      if (command.executable === 'ps') return { exitCode: 0, stdout: `${process.pid} 1 Mon Oct 26 00:00:00 2026 unit codex\n`, stderr: '' };
      if (command.executable === 'kill') { assert.equal(command.args.at(-1), String(wrapper.pid)); workerAlive = false; return { exitCode: 0, stdout: '', stderr: '' }; }
      assert.fail(`Unexpected operation: ${JSON.stringify(command)}`);
    },
  });
  return { services, store, session };
}

test('[Z.474] the first close of an already-finished agent omits forcedClose and drops the pasted succeeded event', async t => {
  const f = await closeFixture(t, 'finished');
  markPasted(f.store, f.session.runId);
  const result = await f.services.control.close('worker', undefined, { force: true, reason: 'Z.471 succeeded' });
  assert.equal(result.closed, true);
  assert.equal(result.result, 'succeeded');
  assert.equal(result.forcedClose, undefined, 'already-finished close ignores --force and does not invent forcedClose');
  assert.equal(resultNoticeViews(f.store, []).some(row => row.addressId === 'worker'), false, 'one close must remove the agent from agent ps');
  const sent: string[] = [];
  await settleResultNotices({ store: f.store, now: () => Date.parse('2026-10-26T19:36:36.000Z'), deliver: async request => { sent.push(request.text); return { accepted: true, receiptId: 'should-not-send' }; } });
  assert.deepEqual(sent, [], 'one close must not send agent.succeeded again');
});

test('[Z.474] the first close of an exited agent with an already-pasted result removes it from agent ps', async t => {
  const f = await closeFixture(t, 'exited');
  markPasted(f.store, f.session.runId);
  const before = f.store.resultNotices.list().find(row => row.runId === f.session.runId);
  assert.equal(before?.state, 'pending');
  const attempts = before?.attempts ?? 0;
  const result = await f.services.control.close('worker');
  assert.equal(result.closed, true);
  assert.equal(result.result, 'succeeded');
  assert.equal(result.forcedClose, undefined);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(f.session.runId))?.state, 'finished');
  assert.equal(resultNoticeViews(f.store, []).some(row => row.runId === f.session.runId), false, 'the first close must drop the agent; a second close is not required');
  const notice = f.store.resultNotices.list().find(row => row.runId === f.session.runId);
  assert.equal(notice?.attempts, attempts, 'close must not claim the already-pasted result again');
  const sent: string[] = [];
  await settleResultNotices({ store: f.store, now: () => Date.parse('2026-10-26T19:43:18.000Z'), deliver: async request => { sent.push(request.text); return { accepted: true, receiptId: 'should-not-send' }; } });
  assert.deepEqual(sent.filter(text => text.includes('agent.succeeded')), []);
});
