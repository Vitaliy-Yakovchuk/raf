import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TmuxAgentAdapter } from '../src/agent-adapters.ts';
import type { AdapterCommand, AdapterObservation, AdapterSession, AdapterStartRequest, RunnerProtocol } from '../src/agent-adapters.ts';
import type { LaunchOwnership, LaunchWrapperRequest } from '../src/launch-wrapper.ts';
import type { ProcessIdentity } from '../src/session-state.ts';

const selection = { runner: 'codex', model: 'model-a', effort: 'high' } as const;
const session: AdapterSession = { tmuxSession: 'owned-a', selection };
const identity: ProcessIdentity = {
  pid: 4321, startedAt: 'Thu Oct 22 10:00:00 2026', runner: 'codex',
  runnerSessionId: 'native-a', tmuxSession: 'owned-a', evidence: { command: '/bin/codex', runId: 'run-a' },
};
const protocol: RunnerProtocol = {
  invocation: () => ({ executable: '/bin/codex', args: ['--model', 'model-a'] }),
  observe: () => ({ status: 'starting' }),
};
const reportWrapper = { wrap: (command: AdapterCommand) => command };
const request = {
  runId: 'run-a', address: 'agent-a', statePath: '/tmp/isolated-state.sqlite', cwd: '/work',
  tmuxSession: 'owned-a', selection, brief: 'task $(literal)\nsecond line', readinessTimeoutMs: 100,
} as LaunchWrapperRequest;

function harness() {
  const events: string[] = [];
  const delivered: string[] = [];
  let clock = 0;
  let observation: AdapterObservation = { status: 'starting' };
  let ownership: LaunchOwnership = { state: 'owned', identity, processKind: 'agent' };
  class BoundaryAdapter extends TmuxAgentAdapter {
    async startWithoutInput(value: Omit<AdapterStartRequest, 'brief'>): Promise<AdapterSession> {
      events.push('start');
      assert.equal('brief' in value, false);
      return session;
    }
    async inspect(_session: AdapterSession): Promise<AdapterObservation> { events.push('inspect'); return observation; }
    async deliver(_session: AdapterSession, text: string): Promise<void> { events.push('deliver'); delivered.push(text); }
    async stop(_session: AdapterSession): Promise<void> { events.push('stop'); }
  }
  const adapter = new BoundaryAdapter({ execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    protocols: { codex: protocol, grok: protocol, agy: protocol, claude: protocol } });
  const transport = adapter.createLaunchTransport({
    reportWrapper, pollIntervalMs: 10, now: () => clock, delay: async ms => { clock += ms; },
    inspectOwnership: async value => { assert.deepEqual(value, session); events.push('ownership'); return ownership; },
  });
  return { adapter, transport, events, delivered,
    observe(value: AdapterObservation) { observation = value; },
    own(value: LaunchOwnership) { ownership = value; } };
}

test('split startup creates the runner without passing brief through argv or stdin', async () => {
  const commands: AdapterCommand[] = [];
  const adapter = new TmuxAgentAdapter({
    execute: async command => { commands.push(command); return { exitCode: 0, stdout: '', stderr: '' }; },
    protocols: { codex: protocol, grok: protocol, agy: protocol, claude: protocol },
  });
  const result = await adapter.startWithoutInput({ selection, tmuxSession: 'owned-a', cwd: '/work', reportWrapper });
  assert.deepEqual(result, session);
  assert.ok(commands.some(command => command.args.includes('new-session')));
  assert.ok(commands.every(command => !command.args.some(arg => ['load-buffer', 'paste-buffer', 'send-keys'].includes(arg))));
});

test('transport cannot deliver before startup and confirmed readiness', async () => {
  const h = harness();
  await assert.rejects(h.transport.deliver(request.brief));
  await h.transport.startWithoutInput(request, '/tmp/owned-report.json');
  await assert.rejects(h.transport.deliver(request.brief));
  assert.deepEqual(h.delivered, []);
  h.observe({ status: 'ready', cliSessionId: 'native-a' });
  assert.deepEqual(await h.transport.waitReady(100), { state: 'ready', runnerSessionId: 'native-a' });
  await h.transport.deliver(request.brief);
  assert.deepEqual(h.delivered, [request.brief]);
});

test('ready screen without native session identity cannot unlock delivery', async () => {
  const h = harness();
  await h.transport.startWithoutInput(request, '/tmp/owned-report.json');
  h.observe({ status: 'ready' });
  assert.notEqual((await h.transport.waitReady(100)).state, 'ready');
  await assert.rejects(h.transport.deliver(request.brief));
});

for (const reason of ['authentication required', 'permission required', 'unknown screen']) {
  test(`${reason} returns failure without input or automatic confirmation`, async () => {
    const h = harness();
    await h.transport.startWithoutInput(request, '/tmp/owned-report.json');
    h.observe({ status: 'failed', reason });
    assert.notEqual((await h.transport.waitReady(100)).state, 'ready');
    await assert.rejects(h.transport.deliver(request.brief));
    assert.deepEqual(h.delivered, []);
    assert.equal(h.events.includes('stop'), false);
  });
}

test('fast exit remains an exit with its code for readiness and the exit waiter', async () => {
  const h = harness();
  await h.transport.startWithoutInput(request, '/tmp/owned-report.json');
  h.observe({ status: 'exited', exitCode: 17 });
  assert.equal((await h.transport.waitReady(100)).state, 'exited');
  const exit = await h.transport.waitExit();
  assert.equal(exit.code, 17);
  await assert.rejects(h.transport.deliver(request.brief));
  assert.deepEqual(h.delivered, []);
});

for (const ownership of [
  { state: 'unknown', reason: 'scan failed' },
  { state: 'mismatch', reason: 'PID reused' },
  { state: 'owned', identity: { ...identity, startedAt: 'different start' }, processKind: 'agent' },
  { state: 'owned', identity: { ...identity, runnerSessionId: 'another session' }, processKind: 'agent' },
] as LaunchOwnership[]) {
  test('stop refuses unverified or replaced ownership before touching tmux', async () => {
    const h = harness();
    await h.transport.startWithoutInput(request, '/tmp/owned-report.json');
    h.own(ownership);
    await assert.rejects(h.transport.stop(identity));
    assert.equal(h.events.includes('stop'), false);
  });
}

test('stop rechecks matching live identity immediately before the adapter stop', async () => {
  const h = harness();
  await h.transport.startWithoutInput(request, '/tmp/owned-report.json');
  assert.deepEqual(await h.transport.ownership(), { state: 'owned', identity, processKind: 'agent' });
  h.events.length = 0;
  await h.transport.stop(identity);
  assert.deepEqual(h.events, ['ownership', 'stop']);
});

test('existing start request and return contract remain available', () => {
  const adapter = harness().adapter;
  const start: (request: AdapterStartRequest) => Promise<AdapterSession> = adapter.start.bind(adapter);
  assert.equal(typeof start, 'function');
});

test('adapter delivery carries multiline shell-looking text as literal input', async () => {
  const commands: AdapterCommand[] = [];
  const adapter = new TmuxAgentAdapter({
    execute: async command => { commands.push(command); return { exitCode: 0, stdout: '', stderr: '' }; },
    protocols: { codex: protocol, grok: protocol, agy: protocol, claude: protocol },
  });
  const brief = 'line one $(do-not-execute)\n`literal` ; \"quoted\"';
  await adapter.deliver(session, brief);
  assert.ok(commands.some(command => command.stdin === brief ||
    (command.args.includes('-l') && command.args.includes(brief))));
  assert.ok(commands.every(command => command.executable.split('/').at(-1) === 'tmux'));
});
