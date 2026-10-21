import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TmuxAgentAdapter,
  type AdapterCommand,
  type AdapterCommandResult,
  type AdapterSelection,
  type AgentRunner,
  type RunnerObservation,
  type RunnerProtocol,
} from '../src/agent-adapters.ts';

const runners: AgentRunner[] = ['codex', 'grok', 'agy', 'claude'];
const ok = (stdout = ''): AdapterCommandResult => ({ exitCode: 0, stdout, stderr: '' });
function fixture(runner: AgentRunner = 'codex') {
  const commands: AdapterCommand[] = [];
  const selections: AdapterSelection[] = [];
  const wrapped: AdapterCommand[] = [];
  let observation: RunnerObservation = { status: 'ready', cliSessionId: 'provider-session-42' };
  let executeResult: (command: AdapterCommand) => AdapterCommandResult = () => ok();
  const protocol: RunnerProtocol = {
    invocation(selection) {
      selections.push(selection);
      return { executable: selection.runner, args: ['fixture-model', selection.model, 'fixture-effort', selection.effort] };
    },
    observe() { return observation; },
  };
  const adapter = new TmuxAgentAdapter({
    execute: async command => { commands.push(command); return executeResult(command); },
    protocols: Object.fromEntries(runners.map(id => [id, protocol])) as Record<AgentRunner, RunnerProtocol>,
  });
  const selection = { runner, model: 'already-selected-model', effort: 'high' };
  const request = {
    selection, tmuxSession: `raf-${runner}-42`, cwd: '/tmp/working tree',
    brief: 'Composed runner + stage + assigned OpenSpec tasks; report_path=/tmp/report.json',
    reportWrapper: { wrap(command: AdapterCommand): AdapterCommand {
      wrapped.push(command);
      return { executable: '/fixture/report-wrapper', args: ['--', command.executable, ...command.args] };
    } },
  };
  return {
    adapter, commands, selections, wrapped, request,
    session: { tmuxSession: request.tmuxSession, selection },
    observe(value: RunnerObservation) { observation = value; },
    respond(value: (command: AdapterCommand) => AdapterCommandResult) { executeResult = value; },
  };
}

for (const runner of runners) {
  test(`agent-adapters: ${runner} launches selected CLI through report wrapper in detached tmux`, async () => {
    const f = fixture(runner);
    const session = await f.adapter.start(f.request);
    assert.deepEqual(session, f.session);
    assert.deepEqual(f.selections, [f.request.selection]);
    assert.equal(f.wrapped.length, 1);
    assert.equal(f.wrapped[0].executable, runner);
    const start = f.commands.find(command => command.executable === 'tmux' && command.args[0] === 'new-session');
    assert.ok(start);
    assert.ok(start.args.includes('-d'));
    assert.ok(start.args.includes(f.request.tmuxSession));
    assert.ok(start.args.includes('/fixture/report-wrapper'));
    assert.ok(f.commands.some(command => command.executable === 'tmux' && command.args[0] === 'load-buffer' && command.stdin === f.request.brief));
  });
}

test('agent-adapters: literal multiline brief and subsequent message cannot become shell commands', async () => {
  const f = fixture();
  const malicious = 'one\n$(touch /tmp/injected); `echo injected` " \' \\ $HOME\n--help';
  await f.adapter.start({ ...f.request, brief: malicious });
  await f.adapter.deliver(f.session, malicious);
  const buffers = f.commands.filter(command => command.args[0] === 'load-buffer');
  assert.equal(buffers.length, 2);
  for (const command of buffers) {
    assert.equal(command.executable, 'tmux');
    assert.equal(command.stdin, malicious);
  }
  assert.ok(f.commands.every(command => !command.args.some(arg => arg.includes(malicious))));
  assert.equal(f.commands.filter(command => command.args[0] === 'paste-buffer').length, 2);
  assert.equal(f.commands.filter(command => command.args[0] === 'send-keys' && command.args.includes('Enter')).length, 2);
});

for (const observation of [
  { status: 'starting' },
  { status: 'ready', cliSessionId: 'internal-999' },
  { status: 'limited', reason: 'provider quota', retryAt: '2026-10-22T00:00:00Z' },
  { status: 'failed', reason: 'authentication rejected' },
] satisfies RunnerObservation[]) {
  test(`agent-adapters: forwards ${observation.status} observation without selecting another model or resuming`, async () => {
    const f = fixture();
    f.observe(observation);
    f.respond(command => command.args[0] === 'display-message' ? ok('0\t') : ok('provider pane output'));
    assert.deepEqual(await f.adapter.inspect(f.session), observation);
    assert.equal(f.selections.length, 0);
    assert.ok(f.commands.every(command => !['new-session', 'send-keys', 'paste-buffer'].includes(command.args[0])));
  });
}

test('agent-adapters: dead pane exit zero is an exit fact, never a succeeded report', async () => {
  const f = fixture();
  f.respond(() => ok('1\t0\n'));
  assert.deepEqual(await f.adapter.inspect(f.session), { status: 'exited', exitCode: 0 });
  assert.ok(f.commands.every(command => command.args[0] !== 'new-session'));
});

test('agent-adapters: missing tmux session is reported to supervisor without recreation', async () => {
  const f = fixture();
  f.respond(() => ({ exitCode: 1, stdout: '', stderr: "can't find session: raf-codex-42" }));
  assert.deepEqual(await f.adapter.inspect(f.session), { status: 'exited', exitCode: null });
  assert.ok(f.commands.every(command => command.args[0] !== 'new-session'));
});

test('agent-adapters: failed launch rejects and does not deliver the brief', async () => {
  const f = fixture();
  f.respond(() => ({ exitCode: 1, stdout: '', stderr: 'tmux launch failed' }));
  await assert.rejects(f.adapter.start(f.request), /tmux launch failed/);
  assert.ok(f.commands.every(command => !['load-buffer', 'paste-buffer', 'send-keys'].includes(command.args[0])));
});

test('agent-adapters: failed buffer loading does not paste or submit stale contents', async () => {
  const f = fixture();
  f.respond(command => command.args[0] === 'load-buffer' ? { exitCode: 1, stdout: '', stderr: 'buffer failed' } : ok());
  await assert.rejects(f.adapter.deliver(f.session, 'new work'), /buffer failed/);
  assert.ok(f.commands.every(command => !['paste-buffer', 'send-keys'].includes(command.args[0])));
});

test('agent-adapters: stop targets exactly the requested tmux session', async () => {
  const f = fixture();
  await f.adapter.stop(f.session);
  assert.deepEqual(f.commands, [{ executable: 'tmux', args: ['kill-session', '-t', `=${f.session.tmuxSession}`] }]);
});
