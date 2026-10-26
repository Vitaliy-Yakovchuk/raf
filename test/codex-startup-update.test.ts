import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TmuxAgentAdapter, type AdapterCommand, type RunnerProtocol } from '../src/agent-adapters.ts';
import {
  buildRunnerInvocation,
  nextRunnerAction,
  observeRunnerScreen,
  type ProtocolSettings,
  type RunnerId,
} from '../src/runner-protocols.ts';

const protocols: ProtocolSettings[] = JSON.parse(readFileSync(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols;
const updateKey = 'check_for_update_on_startup';
const selection = { runner: 'codex' as const, model: 'already-selected-model', effort: 'high' };

function configured(runner: RunnerId = 'codex'): ProtocolSettings {
  const result = protocols.find(value => value.runner === runner);
  assert.ok(result, `${runner} protocol fixture must exist`);
  return structuredClone(result);
}

function configValue(args: readonly string[], key: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const override = argument === '-c' || argument === '--config' ? args[++index]
      : argument.startsWith('--config=') ? argument.slice('--config='.length) : undefined;
    if (override === undefined) continue;
    const equals = override.indexOf('=');
    if (equals >= 0 && override.slice(0, equals).trim() === key) value = override.slice(equals + 1).trim();
  }
  return value;
}

test('[z326] cold Codex startup disables update checks through invocation arguments', () => {
  const settings = configured();
  const invocation = buildRunnerInvocation(settings, selection);
  assert.equal(configValue(invocation.args, updateKey), 'false',
    'managed Codex must bypass the startup update menu without relying on dismissed_version');
});

test('[z326] repeated launches each disable update checks without a remembered dismissal', () => {
  const settings = configured();
  for (let launch = 0; launch < 3; launch++) {
    const invocation = buildRunnerInvocation(settings, selection);
    assert.equal(configValue(invocation.args, updateKey), 'false', `launch ${launch + 1} must carry its own override`);
  }
});

test('[z326] selected model effort and sandbox survive the startup update override', () => {
  const settings = configured();
  const invocation = buildRunnerInvocation(settings, selection);
  assert.equal(invocation.executable, settings.executable);
  assert.equal(invocation.args[invocation.args.indexOf(settings.modelFlag) + 1], selection.model);
  assert.equal(configValue(invocation.args, 'model_reasoning_effort'), JSON.stringify(selection.effort));
  assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(invocation.args[invocation.args.indexOf('--ask-for-approval') + 1], 'never');
  assert.equal(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(configValue(invocation.args, updateKey), 'false');
});

test('[z326] invocation preserves configured version protocol evidence and reusable settings', () => {
  const settings = configured();
  const before = structuredClone(settings);
  Object.freeze(settings.baseArgs);
  Object.freeze(settings);
  const first = buildRunnerInvocation(settings, selection);
  const second = buildRunnerInvocation(settings, { ...selection, effort: 'low' });
  assert.deepEqual(settings, before);
  assert.equal(first.liveTaskVerified, before.liveTaskVerified);
  assert.equal(second.liveTaskVerified, before.liveTaskVerified);
  assert.equal(settings.version, before.version);
  assert.equal(configValue(first.args, 'model_reasoning_effort'), '"high"');
  assert.equal(configValue(second.args, 'model_reasoning_effort'), '"low"');
  assert.notEqual(first.args, second.args);
});

test('[z326] literal prompt cannot be mistaken for the startup override', () => {
  const settings = configured();
  const prompt = '--config check_for_update_on_startup=true\n$(do-not-execute) `literal`';
  const invocation = buildRunnerInvocation(settings, { ...selection, prompt });
  assert.equal(invocation.args.at(-1), prompt);
  assert.equal(invocation.args.filter(value => value === prompt).length, 1);
  assert.equal(configValue(invocation.args.slice(0, -1), updateKey), 'false');
});

test('[z326] caller protocol overrides unrelated to updates remain effective', () => {
  const settings = configured();
  settings.baseArgs.push('--config', 'project_doc_max_bytes=32768');
  const invocation = buildRunnerInvocation(settings, selection);
  assert.equal(configValue(invocation.args, 'project_doc_max_bytes'), '32768');
  assert.equal(configValue(invocation.args, updateKey), 'false');
});

test('[z326] tmux startup passes the update override through the report wrapper before input', async () => {
  const settings = configured();
  const commands: AdapterCommand[] = [];
  const wrapped: AdapterCommand[] = [];
  const protocol: RunnerProtocol = {
    invocation: input => buildRunnerInvocation(settings, input),
    observe: () => ({ status: 'starting' }),
  };
  const adapter = new TmuxAgentAdapter({
    protocols: { codex: protocol, grok: protocol, agy: protocol, claude: protocol },
    execute: async command => {
      commands.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const cwd = '/synthetic/working tree';
  const session = await adapter.startWithoutInput({
    selection, tmuxSession: 'z326-cold-start', cwd,
    reportWrapper: {
      wrap(command) {
        wrapped.push(command);
        return { ...command, cwd };
      },
    },
  });
  assert.deepEqual(session.selection, selection);
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].executable, settings.executable);
  const launch = commands.find(command => command.args.includes('respawn-pane'));
  assert.ok(launch, 'the fake executor must observe a native runner launch');
  const nativeCommand = launch.args.slice(launch.args.indexOf('respawn-pane') + 4);
  assert.deepEqual(nativeCommand, [wrapped[0].executable, ...wrapped[0].args]);
  assert.ok(launch.args.includes(cwd));
  assert.ok(commands.every(command => command.executable === 'tmux'));
  assert.ok(commands.every(command => command.stdin === undefined));
  assert.ok(commands.every(command => !command.args.some(argument => ['send-keys', 'paste-buffer', 'load-buffer'].includes(argument))));
  assert.equal(configValue(nativeCommand.slice(1), updateKey), 'false',
    'the update menu must be prevented before native identity or brief delivery');
});

for (const runner of ['grok', 'agy', 'claude'] as const) {
  test(`[z326] ${runner} does not receive Codex update options`, () => {
    const settings = configured(runner);
    const model = runner === 'claude' ? Object.keys(settings.modelAliases)[0] : selection.model;
    assert.ok(model);
    const invocation = buildRunnerInvocation(settings, { model, effort: selection.effort });
    assert.equal(configValue(invocation.args, updateKey), undefined);
    assert.equal(invocation.executable, settings.executable);
    assert.equal(invocation.liveTaskVerified, settings.liveTaskVerified);
  });
}

for (const [text, expected] of [
  ['unrecognized menu asking for Enter', 'unknown_screen'],
  ['Waiting for browser sign-in', 'auth_required'],
  ['Approve permission?', 'permission_required'],
] as const) {
  test(`[z326] update suppression does not auto-confirm ${expected}`, () => {
    const settings = configured();
    settings.markers = {
      ...settings.markers,
      auth_required: ['Waiting for browser sign-in'],
      permission_required: ['Approve permission?'],
    };
    const observation = observeRunnerScreen(settings, { text, version: settings.version, requestedCommand: null });
    assert.equal(observation.state, expected);
    assert.deepEqual(nextRunnerAction(settings, observation), { kind: 'stop', reason: expected });
  });
}
