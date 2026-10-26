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
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
import { nativeSandboxArgs, type ProtocolSettings } from '../src/runner-protocols.ts';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLiveAdapter, prepareLiveNativeEnvironment } from '../scripts/qa-agent-adapters-live-config.ts';
import { commandFailure } from '../src/cli.ts';
import { runnerQuestionReadDenials } from '../src/runner-question-scope.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('live Claude fixture preserves default host HOME for native CLI and isolated QA HOME for raf', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'cfc24-native-home-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ownerHome = join(directory, 'existing-owner-home');
  const qaHome = join(directory, 'isolated-qa-home');
  await fs.mkdir(ownerHome);
  await fs.mkdir(qaHome);
  await fs.mkdir(join(directory, 'bin'));
  const executable = join(directory, 'actual-native');
  await fs.writeFile(executable, '#!' + process.execPath + '\nconsole.log(JSON.stringify({home:process.env.HOME,qa:process.env.RAF_QA_HOME,selector:process.env.CLAUDE_CONFIG_DIR,args:process.argv.slice(2)}));\n', { mode: 0o700 });
  const selection = ['--model', 'assigned-model', '--effort', 'high'];
  const selectors = { HOME: ownerHome, RAF_QA_HOME: qaHome };
  const result = await prepareLiveNativeEnvironment(directory, 'claude', selectors, executable);
  const child = await promisify(execFile)(join(directory, 'bin/claude'), selection, { env: { ...process.env, HOME: qaHome, RAF_QA_HOME: qaHome, CLAUDE_CONFIG_DIR: undefined } });
  assert.deepEqual(JSON.parse(child.stdout), { home: ownerHome, qa: qaHome, args: selection });
  assert.equal(result.selector, 'HOME');
  assert.deepEqual(selectors, { HOME: ownerHome, RAF_QA_HOME: qaHome });
  assert.deepEqual(await fs.readdir(ownerHome), [], 'No credentials or config may be copied into the owner HOME');
});

test('live adapter fixture prepares the selected Claude runner brief before launch', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'cfc24-brief-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configRoot = new URL('../../conf/', import.meta.url).pathname;
  await fs.mkdir(join(root, 'conf/briefs/runners'), { recursive: true });
  await fs.writeFile(join(root, 'conf/briefs/runners/codex.md'), 'Synthetic codex fixture');
  const raf = JSON.parse(await fs.readFile(join(configRoot, 'raf.json'), 'utf8'));
  await configureLiveAdapter({ root }, configRoot, 'claude', raf);
  const brief = join(root, 'conf/briefs/runners/claude.md');
  assert.equal(await fs.stat(brief).then(value => value.isFile(), () => false), true, 'Selected actual runner brief must be prepared before public agent run');
  assert.equal(await fs.readFile(brief, 'utf8'), await fs.readFile(join(configRoot, 'briefs/runners/claude.md'), 'utf8'));
  const settings = JSON.parse(await fs.readFile(join(root, 'conf/raf.json'), 'utf8'));
  assert.deepEqual(settings.runnerProtocols.map((value: any) => value.runner), ['claude']);
  assert.equal(await fs.readFile(join(root, 'conf/flow.json'), 'utf8'), await fs.readFile(join(configRoot, 'flow.json'), 'utf8'));
});

const messageSettings = {
  runner: 'claude', version: 'fixture', navigation: [], markers: { ready: ['agent ready'] },
  native: { composer: '^\\$(?:\\s|$)', pendingPaste: { pattern: '\\[Pasted text #\\d+ \\+(\\d+) lines\\]', unit: 'newlines' }, working: '^Working', identity: { source: 'session_start' } },
  timeouts: { transitionMs: 20, pollMs: 5 },
} as unknown as ProtocolSettings;

function messageHarness(frames: string[], owned = true) {
  let clock = 0;
  const pasted: string[] = [];
  let enters = 0;
  const ports: MessageDeliveryPorts = {
    settings: messageSettings, verify: async () => owned,
    capture: async () => frames.length > 1 ? frames.shift()! : frames[0],
    paste: async text => { pasted.push(text); }, enter: async () => { enters++; },
    now: () => clock, delay: async ms => { clock += ms; },
  };
  return { ports, pasted, enters: () => enters };
}

test('message receipt refuses text left in composer after bounded Enter retry', async () => {
  const h = messageHarness(['agent ready\n$ ', 'agent ready\n$ [sender] hello']);
  assert.equal((await deliverCheckedMessage(h.ports, '[sender] hello')).accepted, false);
  assert.deepEqual(h.pasted, ['[sender] hello']);
  assert.ok(h.enters() <= 1);
});

test('message receipt leaves foreign composer and shell untouched', async () => {
  for (const screen of ['agent ready\n$ other draft', '$ ']) {
    const h = messageHarness([screen]);
    assert.equal((await deliverCheckedMessage(h.ports, '$(touch should-not-exist)')).accepted, false);
    assert.deepEqual(h.pasted, []);
  }
});

test('message receipt requires live ownership before delivery', async () => {
  const h = messageHarness(['agent ready\n$ '], false);
  assert.equal((await deliverCheckedMessage(h.ports, 'hello')).accepted, false);
  assert.deepEqual(h.pasted, []);
});

test('message receipt accepts cleared native composer without semantic answer', async () => {
  const h = messageHarness(['agent ready\n$ ', '[sender] hello\nagent ready\n$ ']);
  assert.equal((await deliverCheckedMessage(h.ports, '[sender] hello')).accepted, true);
  assert.deepEqual(h.pasted, ['[sender] hello']);
});

test('message receipt cannot accept unchanged screen or lost identity', async () => {
  const unchanged = messageHarness(['agent ready\n$ ']);
  assert.equal((await deliverCheckedMessage(unchanged.ports, 'hello')).accepted, false);
  const changed = messageHarness(['agent ready\n$ ', 'hello\nagent ready\n$ ']);
  let checks = 0;
  changed.ports.verify = async () => ++checks < 4;
  assert.equal((await deliverCheckedMessage(changed.ports, 'hello')).accepted, false);
});

test('message receipt accepts cleared busy queue but refuses permission screen', async () => {
  const queued = messageHarness(['Working\n$ ', 'Working\nqueued hello\n$ ']);
  assert.equal((await deliverCheckedMessage(queued.ports, 'hello')).accepted, true);
  const blocked = messageHarness(['Permission required\nWorking\n$ ']);
  blocked.ports.settings = { ...messageSettings, markers: { permission_required: ['Permission required'] } };
  assert.equal((await deliverCheckedMessage(blocked.ports, 'hello')).accepted, false);
  assert.deepEqual(blocked.pasted, []);
});

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
  assert.ok(launch.cwd === request.cwd || launch.args.includes(request.cwd), JSON.stringify(launch));
  assert.ok(launch.args.some(arg => arg.includes('/fixture/report-wrapper')), JSON.stringify(launch));
  assert.ok(launch.args.some(arg => arg.includes(reportPath)), JSON.stringify(launch));
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

for (const stale of [
  { status: 'limited', reason: 'run-a limit', retryAt: '2026-10-25T11:00:00Z' },
  { status: 'exited', exitCode: null },
  { status: 'exited', exitCode: 0 },
] as const) {
  test(`U4 delayed ${JSON.stringify(stale)} from A cannot affect ready run B`, async () => {
    const a = harness();
    const bRequest = { ...request, runId: 'run-b', tmpRoot: '/fixture/run-b', tmuxSession: 'owned-b' };
    const bIdentity = { ...identity, pid: 5678, tmuxSession: 'owned-b', runnerSessionId: 'native-b',
      evidence: { ...identity.evidence, runId: 'run-b', tmuxPane: '%2' } };
    const b = harness(bRequest, bIdentity);
    const late = deferred<AdapterObservation>();
    a.onInspect(() => late.promise);
    await a.transport.startWithoutInput(request, '/fixture/run-a/report.json');
    const oldReady = a.transport.waitReady(100);
    await b.ready();
    late.resolve(stale);
    assert.notEqual((await oldReady).state, 'ready');
    assert.deepEqual(await b.transport.waitReady(100), { state: 'ready', runnerSessionId: 'native-b' });
    assert.deepEqual(await b.transport.ownership(), { state: 'owned', identity: bIdentity, processKind: 'agent' });
    await b.transport.deliver(brief);
    assert.deepEqual(b.deliveries, [brief]);
    assert.equal(b.starts.length, 1);
    assert.equal(b.events.includes('stop'), false);
    assert.equal(b.events.includes('verify-process-exit'), false);
  });
}

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

for (const coded of [false, true]) test(coded ? 'U5 launch failure retains recoverable cleanup code after primary delivery reason' : 'U5 launch failure retains delivery reason before a secondary cleanup failure', async () => {
  const h = harness();
  h.onDeliver(async () => { throw new Error('PRIMARY: delivery unknown screen'); });
  h.onStop(async () => { throw coded ? commandFailure({ code: 'LAUNCH_RECOVERABLE', message: 'SECONDARY: cleanup unavailable', stage: 'cleanup', source: 'fixture', sourceCode: null, reason: 'unconfirmed exit', received: null, expected: null, found: null, completed: [], pending: ['process termination'], retrySafe: false, remediation: [] }) : new Error('SECONDARY: cleanup unavailable'); });
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
  assert.ok(h.events.includes('stop'), 'The injected secondary failure must reach adapter cleanup');
  const reason = failure.message;
  assert.ok(reason.includes('PRIMARY: delivery unknown screen'), reason);
  assert.ok(reason.includes('SECONDARY: cleanup unavailable'), JSON.stringify({ reason, events: h.events, failures }));
  assert.ok(reason.indexOf('PRIMARY:') < reason.indexOf('SECONDARY:'), reason);
  if (coded) assert.match(reason, /accompanying cleanup failure: LAUNCH_RECOVERABLE: SECONDARY:/);
  assert.ok(failures.some(value => value.includes('PRIMARY: delivery unknown screen')));
  await assert.rejects(h.transport.deliver(brief));
  assert.deepEqual(h.deliveries, [brief]);
  assert.equal(h.starts.length, 1);
});

test('message receipt treats the runner ready placeholder as an empty composer', async () => {
  const settings = { ...messageSettings, markers: { ready: ['Ask Codex to do anything'] } } as unknown as ProtocolSettings;
  const busy = messageHarness(['Working\n$ Ask Codex to do anything', 'Working\nqueued hello\n$ Ask Codex to do anything']);
  busy.ports.settings = settings;
  assert.equal((await deliverCheckedMessage(busy.ports, 'hello')).accepted, true);
  assert.deepEqual(busy.pasted, ['hello']);
  const idle = messageHarness(['agent ready\n$ Ask Codex to do anything', '[sender] hello\n$ Ask Codex to do anything']);
  idle.ports.settings = settings;
  assert.equal((await deliverCheckedMessage(idle.ports, '[sender] hello')).accepted, true);
  const draft = messageHarness(['Working\n$ my own draft']);
  draft.ports.settings = settings;
  assert.equal((await deliverCheckedMessage(draft.ports, 'hello')).accepted, false);
  assert.deepEqual(draft.pasted, []);
});

test('L3 question read scope hides neighbors while preserving exact assigned files', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'cfc24-question-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const questions = join(root, 'questions');
  const assigned = join(questions, 'projects', 'raf', 'questions.md');
  const sibling = join(questions, 'projects', 'raf', 'private.md');
  const neighbor = join(questions, 'projects', 'other', 'questions.md');
  for (const file of [assigned, sibling, neighbor]) {
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, 'NONSECRET PRIVATE QA');
  }
  const hidden = await runnerQuestionReadDenials(root, [assigned]);
  const contains = (directory: string, file: string) => file === directory || file.startsWith(directory + '/');
  assert.ok(hidden.some(path => contains(path, neighbor)), 'Unassigned project questions must be hidden from reads');
  assert.ok(hidden.some(path => contains(path, sibling)), 'An exact assigned file must not expose its sibling');
  assert.equal(hidden.some(path => contains(path, assigned)), false, 'The exact assigned file remains available for its authorized in-place write');
  assert.deepEqual(await fs.readFile(assigned, 'utf8'), 'NONSECRET PRIVATE QA');
  const documentScope = await runnerQuestionReadDenials(root, [assigned], root);
  assert.ok(documentScope.includes(neighbor));
  assert.ok(documentScope.includes(sibling));
  assert.ok((await Promise.all(documentScope.map(path => fs.lstat(path)))).every(info => !info.isDirectory()), 'A document workspace must not overlap a hidden state directory');
  assert.equal(documentScope.includes(assigned), false);
  assert.deepEqual(await runnerQuestionReadDenials(root, [questions]), []);
  const absent = join(root, 'without-questions');
  await fs.mkdir(absent);
  assert.deepEqual(await runnerQuestionReadDenials(absent, []), []);
});

test('L3 Claude sandbox hides inherited host endpoints before allowing own unix IPC', () => {
  const settings = { runner: 'claude' } as ProtocolSettings;
  const args = ['--model', 'assigned-model', '--settings', JSON.stringify({ sandbox: {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
    filesystem: { denyRead: ['/protected/state'], allowRead: ['/authorized/file'] },
  } })];
  const before = structuredClone(args);
  const environment = {
    TMUX: '/nonstandard/main.sock,123,0', SSH_AUTH_SOCK: '/nonstandard/ssh.sock',
    XDG_RUNTIME_DIR: '/nonstandard/runtime',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonstandard/bus%20socket,guid=nonsecret;unix:dir=/nonstandard/bus-dir',
  };
  const scope = { hidden: ['/protected/registered.sock'], readable: ['/owned/report'], tmuxDirectory: '/owned/report', excludedCommands: [], environment };
  const result = nativeSandboxArgs(settings, args, scope);
  const value = JSON.parse(result[result.indexOf('--settings') + 1]);
  for (const target of ['/nonstandard/main.sock', '/nonstandard/ssh.sock', '/nonstandard/runtime', '/nonstandard/bus socket', '/nonstandard/bus-dir']) {
    assert.ok(value.sandbox.filesystem.denyRead.includes(target), 'Inherited host endpoint must be unreadable: ' + target);
  }
  assert.ok(value.sandbox.filesystem.denyRead.includes('/protected/state'));
  assert.ok(value.sandbox.filesystem.denyRead.includes('/protected/registered.sock'));
  assert.deepEqual(value.sandbox.filesystem.allowRead, ['/authorized/file', '/owned/report']);
  assert.equal(value.sandbox.network.allowAllUnixSockets, true);
  assert.equal(value.env.TMUX_TMPDIR, '/owned/report');
  assert.equal(value.env.TMUX, '');
  assert.deepEqual(args, before);
  assert.equal(environment.SSH_AUTH_SOCK, '/nonstandard/ssh.sock');
  for (const address of ['unix:abstract=host-bus', 'tcp:host=127.0.0.1,port=123', 'unknown:path=/host', 'unix:path=relative', 'unix:path=/host%00bus']) {
    assert.throws(() => nativeSandboxArgs(settings, args, { ...scope, environment: { DBUS_SESSION_BUS_ADDRESS: address } }), /host endpoint|session bus/);
  }
  assert.throws(() => nativeSandboxArgs(settings, args, { ...scope, environment: { SSH_AUTH_SOCK: 'relative' } }), /host endpoint/);
});
