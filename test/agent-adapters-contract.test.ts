import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TmuxAgentAdapter } from '../src/agent-adapters.ts';
import type {
  AdapterCommand, AdapterCommandExecutor, AdapterObservation, AdapterSelection,
  AdapterSession, AdapterStartRequest, RunnerProtocol,
} from '../src/agent-adapters.ts';
import { runLaunchWrapper } from '../src/launch-wrapper.ts';
import type { LaunchOwnership, LaunchWrapperPorts, LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProcessIdentity } from '../src/session-state.ts';

const selection: AdapterSelection = { runner: 'codex', model: 'selected-model', effort: 'high' };
const brief = 'Завдання 🧪\n"quotes" \'literal\' `no execution` $(no execution); --model other\nlast line';
const identity: ProcessIdentity = {
  pid: 4321, startedAt: '2026-10-25T10:00:00Z', runner: 'codex',
  runnerSessionId: 'native-a', tmuxSession: 'owned-a',
  evidence: { runId: 'run-a', machineId: 'machine-a', bootId: 'boot-a',
    tmuxSocket: '/fixture/tmux-a.sock', tmuxPane: '%1', command: '/fixture/codex' },
};
const request = {
  runId: 'run-a', address: 'reusable-address', tmpRoot: '/fixture/run-a',
  statePath: '/fixture/state.sqlite', cwd: '/fixture/робота',
  tmuxSession: 'owned-a', selection, brief, readinessTimeoutMs: 100,
  assignment: { changes: [] },
} as unknown as LaunchWrapperRequest;
const reportWrapper = { wrap: (command: AdapterCommand): AdapterCommand => command };
const success = { exitCode: 0, stdout: '', stderr: '' };
const protocol: RunnerProtocol = {
  invocation: value => ({ executable: '/fixture/codex', args: ['--model', value.model, '--effort', value.effort] }),
  observe: () => ({ status: 'starting' }),
};
const protocols = { codex: protocol, grok: protocol, agy: protocol, claude: protocol };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(run: LaunchWrapperRequest = request, owner: ProcessIdentity = identity) {
  const session: AdapterSession = { tmuxSession: run.tmuxSession, selection: { ...run.selection } };
  const events: string[] = [];
  const deliveries: string[] = [];
  const starts: Omit<AdapterStartRequest, 'brief'>[] = [];
  let clock = 0;
  let observation: AdapterObservation = { status: 'ready', cliSessionId: owner.runnerSessionId };
  let ownership: LaunchOwnership = { state: 'owned', identity: owner, processKind: 'agent' };
  let delivery: (() => Promise<void>) | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let inspect: (() => Promise<AdapterObservation>) | undefined;
  const processExit = deferred<{ code: number | null; signal: string | null }>();
  class BoundaryAdapter extends TmuxAgentAdapter {
    async startWithoutInput(value: Omit<AdapterStartRequest, 'brief'>): Promise<AdapterSession> {
      starts.push(value); events.push('start'); return session;
    }
    async inspect(value: AdapterSession): Promise<AdapterObservation> {
      assert.deepEqual(value, session); events.push('inspect');
      return inspect ? inspect() : observation;
    }
    async deliver(value: AdapterSession, text: string): Promise<void> {
      assert.deepEqual(value, session); events.push('deliver'); deliveries.push(text);
      await delivery?.();
    }
    async stop(value: AdapterSession): Promise<void> {
      assert.deepEqual(value, session); events.push('stop'); await cleanup?.();
    }
  }
  const adapter = new BoundaryAdapter({
    execute: async () => { throw new Error('Boundary harness must not execute commands'); }, protocols,
  });
  const transport = adapter.createLaunchTransport({
    reportWrapper, pollIntervalMs: 5, now: () => clock,
    delay: async ms => { clock += ms; },
    inspectOwnership: async value => { assert.deepEqual(value, session); events.push('ownership'); return ownership; },
    waitForExit: async value => {
      assert.deepEqual(value, session); events.push('verify-process-exit'); return processExit.promise;
    },
  });
  return {
    adapter, transport, events, deliveries, starts, session, processExit,
    observe(value: AdapterObservation) { observation = value; },
    own(value: LaunchOwnership) { ownership = value; },
    onDeliver(value: () => Promise<void>) { delivery = value; },
    onStop(value: () => Promise<void>) { cleanup = value; },
    onInspect(value: () => Promise<AdapterObservation>) { inspect = value; },
    async ready() {
      await transport.startWithoutInput(run, '/fixture/run-a/report.json');
      assert.equal((await transport.waitReady(100)).state, 'ready');
    },
  };
}

test('U1 successful initial delivery remains single after repeated readiness and caller retry', async () => {
  const h = harness();
  await h.ready();
  await h.transport.deliver(brief);
  await h.transport.waitReady(100);
  await assert.rejects(h.transport.deliver(brief));
  assert.deepEqual(h.deliveries, [brief]);
  assert.equal(h.starts.length, 1);
});

test('U1 failed insertion consumes initial delivery without an automatic retry or new runner', async () => {
  const h = harness();
  const insertion = new Error('insertion failed after paste');
  h.onDeliver(async () => { throw insertion; });
  await h.ready();
  await assert.rejects(h.transport.deliver(brief), /insertion failed after paste/);
  await assert.rejects(h.transport.deliver(brief));
  assert.deepEqual(h.deliveries, [brief]);
  assert.equal(h.starts.length, 1);
});

test('U1 concurrent initial delivery cannot insert while the first insertion is pending', async () => {
  const h = harness();
  const inserted = deferred<void>();
  const finish = deferred<void>();
  h.onDeliver(async () => { inserted.resolve(); await finish.promise; });
  await h.ready();
  const first = h.transport.deliver(brief);
  await inserted.promise;
  try { await assert.rejects(h.transport.deliver(brief)); }
  finally { finish.resolve(); await first; }
  assert.deepEqual(h.deliveries, [brief]);
});

test('U1 stop invalidates prior readiness and prevents a first or repeated insertion', async () => {
  const h = harness();
  await h.ready();
  await h.transport.stop(identity);
  await assert.rejects(h.transport.deliver(brief));
  assert.deepEqual(h.deliveries, []);
  assert.equal(h.starts.length, 1);
});

test('U1 verified exit invalidates prior readiness without needing another readiness poll', async () => {
  const h = harness();
  await h.ready();
  h.processExit.resolve({ code: 0, signal: null });
  await h.transport.waitExit();
  await assert.rejects(h.transport.deliver(brief));
  assert.deepEqual(h.deliveries, []);
});

test('U2 transport preserves selected invocation, cwd, wrapper and the complete literal brief', async () => {
  const h = harness();
  const chosen = structuredClone(request.selection);
  await h.ready();
  await h.transport.deliver(brief);
  assert.equal(h.starts[0].cwd, request.cwd);
  assert.deepEqual(h.starts[0].selection, chosen);
  assert.equal(h.starts[0].reportWrapper, reportWrapper);
  assert.equal('brief' in h.starts[0], false);
  assert.deepEqual(h.deliveries, [brief]);
  assert.deepEqual(request.selection, chosen);
});

test('U2 selected command is wrapped once without replacing model effort cwd or report arguments', async () => {
  const commands: AdapterCommand[] = [];
  const selections: AdapterSelection[] = [];
  const wrapped: AdapterCommand[] = [];
  const reportPath = '/fixture/run-a/звіт.json';
  const native: RunnerProtocol = {
    invocation: value => { selections.push(structuredClone(value)); return {
      executable: '/fixture/codex', args: ['--model', value.model, '--effort', value.effort],
      environment: { FIXTURE: 'unchanged' },
    }; },
    observe: protocol.observe,
  };
  const adapter = new TmuxAgentAdapter({
    execute: async command => { commands.push(command); return success; },
    protocols: { ...protocols, codex: native },
  });
  await adapter.startWithoutInput({ selection: { ...selection }, tmuxSession: 'owned-a', cwd: request.cwd,
    reportWrapper: { wrap: command => { wrapped.push(structuredClone(command)); return {
      ...command, executable: '/fixture/report-wrapper', args: ['--report', reportPath, '--', command.executable, ...command.args],
    }; } },
  });
  assert.deepEqual(selections, [selection]);
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].executable, '/fixture/codex');
  assert.deepEqual(wrapped[0].args, ['--model', selection.model, '--effort', selection.effort]);
  assert.deepEqual(wrapped[0].environment, { FIXTURE: 'unchanged' });
  const launch = commands.find(command => command.args.includes('new-session'));
  if (!launch) throw new Error('Expected a tmux launch command');
  assert.ok(launch.cwd === request.cwd || launch.args.includes(request.cwd) ||
    launch.args.some(arg => arg.includes(request.cwd)), JSON.stringify(launch));
  assert.ok(launch.args.some(arg => arg.includes('/fixture/report-wrapper') && arg.includes(reportPath)), JSON.stringify(launch));
  assert.ok(commands.every(command => command.stdin !== brief && !command.args.includes(brief)));
});

test('U2 launch command failure cannot send a stale buffer or initial Enter', async () => {
  const commands: AdapterCommand[] = [];
  const execute: AdapterCommandExecutor = async command => {
    commands.push(command);
    return command.args.includes('new-session') ? { exitCode: 7, stdout: '', stderr: 'fixture launch refused' } : success;
  };
  const adapter = new TmuxAgentAdapter({ execute, protocols });
  await assert.rejects(adapter.start({ ...request, reportWrapper }), /fixture launch refused/);
  assert.equal(commands.filter(command => command.args.includes('new-session')).length, 1);
  assert.ok(commands.every(command => !command.args.some(arg => ['load-buffer', 'paste-buffer', 'send-keys'].includes(arg))));
});

test('U2 buffer load failure never pastes a previous buffer or sends Enter', async () => {
  const commands: AdapterCommand[] = [];
  const adapter = new TmuxAgentAdapter({ protocols, execute: async command => {
    commands.push(command);
    return command.args.includes('load-buffer') ? { exitCode: 8, stdout: '', stderr: 'fixture buffer load failed' } : success;
  } });
  await assert.rejects(adapter.deliver({ tmuxSession: 'owned-a', selection }, brief), /fixture buffer load failed/);
  assert.equal(commands.filter(command => command.args.includes('load-buffer')).length, 1);
  assert.ok(commands.every(command => !command.args.some(arg => ['paste-buffer', 'send-keys'].includes(arg))));
});

for (const fact of [
  { status: 'starting' },
  { status: 'limited', reason: 'pool exhausted', retryAt: '2026-10-25T11:00:00Z' },
  { status: 'limited', reason: 'limit with unknown pool' },
  { status: 'failed', reason: 'authentication required' },
  { status: 'failed', reason: 'unknown screen' },
] as const) {
  test(`U3 observation preserves only known facts: ${JSON.stringify(fact)}`, async () => {
    const commands: AdapterCommand[] = [];
    const native: RunnerProtocol = { invocation: protocol.invocation, observe: () => structuredClone(fact) };
    const adapter = new TmuxAgentAdapter({ protocols: { ...protocols, codex: native },
      execute: async command => {
        commands.push(command);
        return { ...success, stdout: command.args.includes('display-message') ? '0|\n' : 'fixture pane' };
      },
    });
    const session = { tmuxSession: 'owned-a', selection };
    assert.deepEqual(await adapter.inspect(session), fact);
    assert.deepEqual(await adapter.inspect(session), fact);
    assert.ok(commands.every(command => !command.args.some(arg => ['new-session', 'kill-session', 'send-keys', 'paste-buffer'].includes(arg))));
  });
}

for (const code of [null, 0]) {
  test(`U3 low-level exited/${code} waits for the process verification port`, async () => {
    const h = harness();
    await h.ready();
    h.observe({ status: 'exited', exitCode: code });
    h.own({ state: 'unknown', reason: 'process scan unavailable despite missing pane' });
    let completed = false;
    const waiting = h.transport.waitExit().then(exit => { completed = true; return exit; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const beforeVerification = completed;
    h.processExit.resolve({ code: 23, signal: null });
    const verified = await waiting;
    assert.equal(beforeVerification, false, 'pane observation must not finalize a live or unknown process');
    assert.ok(h.events.includes('verify-process-exit'));
    assert.deepEqual(verified, { code: 23, signal: null });
    assert.deepEqual(h.deliveries, []);
    assert.equal(h.starts.length, 1);
  });
}

test('U4 delayed readiness from run A cannot unlock run B at the same address', async () => {
  const a = harness();
  const bRequest = { ...request, runId: 'run-b', tmpRoot: '/fixture/run-b', tmuxSession: 'owned-b' };
  const bIdentity = { ...identity, pid: 5678, tmuxSession: 'owned-b', runnerSessionId: 'native-b',
    evidence: { ...identity.evidence, runId: 'run-b', tmuxPane: '%2' } };
  const b = harness(bRequest, bIdentity);
  const oldObservation = deferred<AdapterObservation>();
  a.onInspect(() => oldObservation.promise);
  await a.transport.startWithoutInput(request, '/fixture/run-a/report.json');
  const oldReady = a.transport.waitReady(100);
  await b.transport.startWithoutInput(bRequest, '/fixture/run-b/report.json');
  b.observe({ status: 'failed', reason: 'run-b authentication required' });
  oldObservation.resolve({ status: 'ready', cliSessionId: 'native-a' });
  await oldReady;
  assert.notEqual((await b.transport.waitReady(100)).state, 'ready');
  await assert.rejects(b.transport.deliver(brief));
  assert.deepEqual(b.deliveries, []);
  assert.equal(b.starts.length, 1);
  assert.equal(b.events.includes('stop'), false);
});

const replacements: [string, ProcessIdentity][] = [
  ['PID', { ...identity, pid: 9876 }],
  ['machine', { ...identity, evidence: { ...identity.evidence, machineId: 'machine-b' } }],
  ['boot', { ...identity, evidence: { ...identity.evidence, bootId: 'boot-b' } }],
  ['pane', { ...identity, evidence: { ...identity.evidence, tmuxPane: '%9' } }],
  ['socket', { ...identity, evidence: { ...identity.evidence, tmuxSocket: '/fixture/tmux-b.sock' } }],
  ['runId', { ...identity, evidence: { ...identity.evidence, runId: 'run-b' } }],
];

for (const [part, replaced] of replacements) {
  test(`U4 changed ${part} after readiness prevents both delivery and stop`, async () => {
    const h = harness();
    await h.ready();
    assert.equal((await h.transport.ownership()).state, 'owned');
    h.own({ state: 'owned', identity: replaced, processKind: 'agent' });
    await assert.rejects(h.transport.deliver(brief));
    await assert.rejects(h.transport.stop(identity));
    assert.deepEqual(h.deliveries, []);
    assert.equal(h.events.includes('stop'), false);
  });
}

test('U4 unknown ownership after readiness cannot deliver kill or manufacture process exit', async () => {
  const h = harness();
  await h.ready();
  h.own({ state: 'unknown', reason: 'ambiguous process scan' });
  await assert.rejects(h.transport.deliver(brief));
  await assert.rejects(h.transport.stop(identity));
  assert.deepEqual(await h.transport.ownership(), { state: 'unknown', reason: 'ambiguous process scan' });
  assert.deepEqual(h.deliveries, []);
  assert.equal(h.events.includes('stop'), false);
});

test('U5 launch failure retains delivery reason before a secondary cleanup failure', async () => {
  const h = harness();
  h.onDeliver(async () => { throw new Error('PRIMARY: delivery unknown screen'); });
  h.onStop(async () => { throw new Error('SECONDARY: cleanup unavailable'); });
  const failures: string[] = [];
  const ports: LaunchWrapperPorts = {
    transport: { ...h.transport, waitExit: async () => { throw new Error('PROCESS: exit not verified'); } },
    report: {
      fs: { mkdir: async () => {}, readText: async () => null, removeTree: async () => {} },
      watch: () => () => {}, now: () => '2026-10-25T10:00:00Z',
      verifyAssignmentCompletion: async () => { throw new Error('No report exists to verify'); },
      diagnostic: async () => {},
    },
    handshake: async () => {},
    lifecycle: {
      started: async handshake => { assert.equal(handshake.runId, request.runId); },
      acceptReport: async () => { assert.fail('Delivery failure is not an accepted report'); },
      finish: async () => { assert.fail('Unverified process must not finalize or release'); },
      failed: async (runId, reason) => { assert.equal(runId, request.runId); failures.push(reason); },
    },
  };
  let failure: unknown;
  try { await runLaunchWrapper(request, ports); } catch (error) { failure = error; }
  if (!(failure instanceof Error)) throw new Error('Expected launch failure', { cause: failure });
  const reason = failure.message;
  assert.ok(reason.includes('PRIMARY: delivery unknown screen'), reason);
  assert.ok(reason.includes('SECONDARY: cleanup unavailable'), reason);
  assert.ok(reason.indexOf('PRIMARY:') < reason.indexOf('SECONDARY:'), reason);
  assert.ok(failures.some(value => value.includes('PRIMARY: delivery unknown screen')));
  await assert.rejects(h.transport.deliver(brief));
  assert.deepEqual(h.deliveries, [brief]);
  assert.equal(h.starts.length, 1);
});
