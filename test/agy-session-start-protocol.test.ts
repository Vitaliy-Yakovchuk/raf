import assert from 'node:assert/strict';
import test from 'node:test';
import { selectNativeLaunchProtocol } from '../src/agy-session-start.ts';
import { TmuxAgentAdapter } from '../src/agent-adapters.ts';
import { buildRunnerInvocation } from '../src/runner-protocols.ts';
import type { AdapterCommand, AgentRunner, RunnerProtocol } from '../src/agent-adapters.ts';
import type { LaunchOwnership } from '../src/launch-wrapper.ts';
import { pending, processIdentity, protocolSettings, wrapperRequest } from './fixtures/agy-session-start.ts';

test('I1 protocol: explicit agy session_start accepts a complete dialect without status fields', () => {
  const protocol = selectNativeLaunchProtocol(protocolSettings());
  assert.equal(protocol.nativeIdentitySource, 'session_start');
  assert.equal(protocol.observe('READY\n> ').status, 'ready');
  const invocation = protocol.invocation({ runner: 'agy', model: 'fixture-model', effort: 'fixture-effort' });
  assert.equal(invocation.executable, 'agy');
  assert.equal(invocation.args.includes('--conversation'), false);
  assert.equal(invocation.args.includes('--continue'), false);
});

test('I1 invocation: pending creates no conversation argument or manufactured native UUID', () => {
  const invocation = buildRunnerInvocation(protocolSettings() as never, { model: 'fixture-model', effort: 'fixture-effort' });
  assert.equal(invocation.args.includes('--conversation'), false);
  assert.equal(invocation.args.includes('--continue'), false);
  assert.equal(invocation.args.some(arg => /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(arg)), false);
});

const incomplete: [string, (settings: ReturnType<typeof protocolSettings>) => void][] = [
  ['native missing', settings => { delete settings.native; }],
  ['identity source missing', settings => { settings.native!.identity = {} as never; }],
  ['composer missing', settings => { delete (settings.native as Partial<NonNullable<typeof settings.native>>).composer; }],
  ['paste dialect missing', settings => { delete (settings.native as Partial<NonNullable<typeof settings.native>>).pendingPaste; }],
  ['working missing', settings => { settings.native!.working = ''; }],
  ['finished missing', settings => { delete settings.native!.finished; }],
  ['exit missing', settings => { settings.native!.exitCommand = ''; }],
  ['write scope missing', settings => { delete (settings.native as Partial<NonNullable<typeof settings.native>>).writeScope; }],
  ['invalid composer regex', settings => { settings.native!.composer = '['; }],
  ['zero startup budget', settings => { settings.timeouts.startupMs = 0; }],
  ['negative transition budget', settings => { settings.timeouts.transitionMs = -1; }],
  ['nonfinite overall budget', settings => { settings.timeouts.overallMs = Infinity; }],
  ['zero poll budget', settings => { settings.timeouts.pollMs = 0; }],
];
for (const [label, mutate] of incomplete) {
  test(`I2 protocol rejects ${label} before invoking a runner`, () => {
    const settings = protocolSettings();
    mutate(settings);
    assert.throws(() => selectNativeLaunchProtocol(settings), error => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.message, 'NotImplemented');
      assert.ok(error.message.trim());
      return true;
    });
  });
}

for (const runner of ['codex', 'claude', 'grok'] as const) {
  test(`I3 protocol: session_start is not an identity bypass for ${runner}`, () => {
    assert.throws(() => selectNativeLaunchProtocol(protocolSettings(runner)), error => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.message, 'NotImplemented');
      return true;
    });
  });
}

function transportFixture(protocol: RunnerProtocol, runner: AgentRunner = 'agy') {
  const commands: AdapterCommand[] = [];
  let screen = 'READY\n> ';
  let clock = 0;
  const adapter = new TmuxAgentAdapter({
    protocols: { codex: protocol, claude: protocol, grok: protocol, agy: protocol },
    execute: async command => {
      commands.push(structuredClone(command));
      if (command.args.includes('load-buffer') && command.stdin) screen = 'READY\n> ' + command.stdin;
      if (command.args.includes('send-keys') && command.args.includes('Enter')) screen = 'WORKING';
      return { exitCode: 0, stdout: command.args.includes('capture-pane') ? screen : '', stderr: '' };
    },
  });
  const identity = processIdentity();
  identity.runner = runner;
  let ownership: LaunchOwnership = { state: 'owned', identity, processKind: 'agent' };
  const transport = adapter.createLaunchTransport({
    reportWrapper: { wrap: command => command },
    inspectOwnership: async () => structuredClone(ownership),
    pollIntervalMs: 1,
    now: () => clock,
    delay: async milliseconds => { clock += milliseconds; },
  });
  return { commands, transport, setOwnership: (value: LaunchOwnership) => { ownership = value; } };
}

test('I1 adapter: native pending/null readiness permits exactly one normal brief', async () => {
  const { commands, transport } = transportFixture(selectNativeLaunchProtocol(protocolSettings()));
  const request = wrapperRequest('/isolated/adapter');
  await transport.startWithoutInput(request, '/isolated/adapter/report.json');
  const ready = await transport.waitReady(1000);
  assert.equal(ready.state, 'ready');
  assert.equal((ready as { runnerSessionId: unknown }).runnerSessionId, null);
  const identity = (ready as unknown as { nativeIdentity: typeof pending }).nativeIdentity;
  assert.equal(identity.state, 'pending');
  assert.equal(identity.id, null);
  assert.ok(identity.reason.trim());
  await transport.deliver(request.brief);
  const writes = commands.filter(command => command.stdin === request.brief);
  assert.equal(writes.length, 1);
  assert.equal(commands.filter(command => command.args.includes('send-keys') && command.args.includes('Enter')).length, 1);
});

for (const runner of ['codex', 'claude', 'grok'] as const) {
  test(`I3 adapter: ready ${runner} without ID never receives a brief`, async () => {
    const protocol: RunnerProtocol = {
      invocation: () => ({ executable: runner, args: [] }),
      observe: () => ({ status: 'ready' }),
    };
    const { commands, transport } = transportFixture(protocol, runner);
    const request = wrapperRequest('/isolated/adapter');
    request.selection.runner = runner;
    await transport.startWithoutInput(request, '/isolated/adapter/report.json');
    let rejected = false;
    try {
      const ready = await transport.waitReady(1);
      rejected = ready.state !== 'ready';
      if (ready.state === 'ready') {
        try { await transport.deliver(request.brief); } catch { rejected = true; }
      }
    } catch { rejected = true; }
    assert.equal(rejected, true);
    assert.equal(commands.some(command => command.stdin === request.brief), false);
  });
}

for (const state of ['unknown', 'mismatch', 'exited'] as const) {
  test(`I2 adapter: ${state} process ownership prevents typing the pending brief`, async () => {
    const f = transportFixture(selectNativeLaunchProtocol(protocolSettings()));
    const request = wrapperRequest('/isolated/adapter');
    await f.transport.startWithoutInput(request, '/isolated/adapter/report.json');
    await f.transport.waitReady(1000);
    f.setOwnership({ state, reason: `fixture ${state} owner` });
    await assert.rejects(() => f.transport.deliver(request.brief));
    assert.equal(f.commands.some(command => command.stdin === request.brief), false);
  });
}
