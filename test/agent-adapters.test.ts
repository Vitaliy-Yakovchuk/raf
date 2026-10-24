import childProcess from 'node:child_process';
import nodeFs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as productionRuntime from '../src/production-runtime.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
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

test('agent-adapters: agent delivery uses bracketed paste so the CLI receives one paste, not keystrokes', async () => {
  const f = fixture('codex');
  const brief = 'line one\nline two\n' + 'x'.repeat(4000);
  await f.adapter.deliver(f.session, brief);
  const paste = f.commands.find(command => command.args[0] === 'paste-buffer');
  assert.ok(paste);
  assert.ok(paste.args.includes('-p'), 'codex 0.163.0 splits unbracketed tmux paste into keystroke bursts and shows a wrong [Pasted Content N chars]');
  assert.ok(paste.args.includes(`=${f.session.tmuxSession}:0.0`));
  const order = f.commands.map(command => command.args[0]);
  assert.ok(order.indexOf('paste-buffer') < order.lastIndexOf('send-keys'));
});

for (const pollIntervalMs of [1, 10, 100]) {
  test(`worker-idle: exit observation has a bounded process count at startup poll ${pollIntervalMs} ms`, async () => {
    const f = fixture();
    let clock = 0;
    f.respond(command => {
      if (command.args[0] === 'wait-for') clock = 5000;
      return command.args[0] === 'display-message' ? ok(clock >= 5000 ? '1|23' : '0|') : ok('working');
    });
    const transport = f.adapter.createLaunchTransport({
      reportWrapper: f.request.reportWrapper,
      inspectOwnership: async () => ({ state: 'unknown', reason: 'not needed for exit observation' }),
      pollIntervalMs,
      waitForExit: session => f.adapter.waitForExit(session),
      now: () => clock,
      delay: async milliseconds => { clock += milliseconds; },
    });
    await transport.startWithoutInput({ selection: f.request.selection, tmuxSession: f.request.tmuxSession, cwd: f.request.cwd });
    f.commands.length = 0;
    assert.deepEqual(await transport.waitExit(), { code: 23, signal: null });
    assert.ok(f.commands.length <= 12, `five seconds must spawn at most twelve commands, got ${f.commands.length}`);
    assert.equal(f.commands.filter(command => command.args[0] === 'capture-pane').length, 0, 'waiting for exit does not need the screen');
    assert.equal(clock, 5000);
  });
}

test('worker-idle: verified worker environment is resolved once across repeated child commands', async t => {
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'worker-environment-'));
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  for (const path of ['conf', 'raf-main/src', 'raf-develop/src', 'qa-home', 'account-home']) nodeFs.mkdirSync(join(root, path), { recursive: true });
  const projectsPath = join(root, 'conf/projects.json');
  nodeFs.writeFileSync(projectsPath, JSON.stringify({ version: 1, projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' } } }, profiles: { raf: { production: 'main', environments: { runtime: 'main' } } } }));
  nodeFs.writeFileSync(join(root, 'conf/raf.json'), JSON.stringify({ version: 1, state: { fileName: 'state.sqlite' } }));
  const modulePath = join(root, 'raf-develop/src/worker.ts');
  nodeFs.writeFileSync(modulePath, '');
  const qaHome = join(root, 'qa-home');
  const stateContext = resolveStateContext({ orchestratorRoot: root, modulePath, homeDirectory: qaHome, operatingSystemHome: join(root, 'account-home'), environment: { HOME: qaHome, RAF_QA_HOME: qaHome }, entryPoint: 'worker' });
  const readFileSync = nodeFs.readFileSync;
  let validations = 0;
  t.mock.method(nodeFs, 'readFileSync', (...args) => {
    if (args[0] === projectsPath) validations++;
    return Reflect.apply(readFileSync, nodeFs, args);
  });
  const environments: Record<string, string>[] = [];
  t.mock.method(childProcess, 'spawn', (_executable, _args, options) => {
    environments.push(options.env);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runtimeExecution = (productionRuntime as Record<string, any>).runtimeExecution;
  assert.equal(typeof runtimeExecution, 'function', 'worker executor must support a verified environment snapshot');
  const execute = runtimeExecution({ tmpRoot: stateContext.tmpRoot, stateContext }, undefined, true);
  for (let i = 0; i < 20; i++) await execute({ executable: 'fixture-child', args: [] });
  assert.equal(validations, 1, 'worker child commands must reuse the verified environment rather than revalidate Git origin and generation inventory');
  assert.equal(environments.length, 20);
  assert.ok(environments.every(env => env.HOME === qaHome && env.RAF_QA_HOME === qaHome));
  nodeFs.writeFileSync(projectsPath, '{}');
  assert.throws(() => runtimeExecution({ tmpRoot: stateContext.tmpRoot, stateContext }, undefined, true), /STATE_CONTEXT_REFUSED/);
  await assert.rejects(runtimeExecution({ tmpRoot: stateContext.tmpRoot, stateContext })({ executable: 'fixture-child', args: [] }), /STATE_CONTEXT_REFUSED/);
});

for (const initial of ['1|0', '1|17', 'missing']) {
  test(`worker-idle: subscribes before inspecting an already exited or missing pane (${initial})`, async () => {
    const f = fixture();
    f.respond(command => command.args[0] === 'display-message' ? initial === 'missing' ? { exitCode: 1, stdout: '', stderr: 'missing pane' } : ok(initial) : ok());
    assert.deepEqual(await f.adapter.waitForExit(f.session), { code: initial === 'missing' ? null : Number(initial.split('|')[1]), signal: null });
    assert.equal(f.commands[0].args[0], 'set-hook');
    assert.ok(f.commands[0].args.some(arg => arg.startsWith('pane-died[')));
    assert.ok(f.commands[0].args.some(arg => arg.startsWith('session-closed[')));
    assert.equal(f.commands.filter(command => command.args[0] === 'wait-for' && command.args.length === 2).length, 0);
    assert.equal(f.commands.filter(command => command.args[0] === 'set-hook' && command.args.includes('-u')).length, 3);
    assert.ok(f.commands.every(command => command.args[0] !== 'capture-pane'));
  });
}

test('worker-idle: unrelated pane notifications rearm the event wait without screen polling', async () => {
  const f = fixture();
  let notifications = 0;
  f.respond(command => {
    if (command.args[0] === 'wait-for' && command.args.length === 2) notifications++;
    return command.args[0] === 'display-message' ? ok(notifications >= 2 ? '1|29' : '0|') : ok();
  });
  assert.deepEqual(await f.adapter.waitForExit(f.session), { code: 29, signal: null });
  assert.equal(notifications, 2);
  assert.ok(f.commands.every(command => command.args[0] !== 'capture-pane'));
});

for (const failed of ['subscribe', 'notification']) {
  test(`worker-idle: ${failed} failure for a live pane is explicit and removes owned hooks`, async () => {
    const f = fixture();
    f.respond(command => command.args[0] === 'display-message' ? ok('0|') :
      (failed === 'subscribe' && command.args[0] === 'set-hook' && !command.args.includes('-u') || failed === 'notification' && command.args[0] === 'wait-for' && command.args.length === 2) ? { exitCode: 1, stdout: '', stderr: 'fixture failure' } : ok());
    await assert.rejects(f.adapter.waitForExit(f.session), /tmux exit (subscription|notification) failed: fixture failure/);
    assert.equal(f.commands.filter(command => command.args[0] === 'set-hook' && command.args.includes('-u')).length, 3);
  });
}

test('worker-idle: concurrent transport exit waiters share one event subscription', async () => {
  const f = fixture();
  let resolveExit!: (value: { code: number; signal: null }) => void;
  const exit = new Promise<{ code: number; signal: null }>(resolve => resolveExit = resolve);
  let subscriptions = 0;
  const transport = f.adapter.createLaunchTransport({ reportWrapper: f.request.reportWrapper, inspectOwnership: async () => ({ state: 'unknown', reason: 'not needed' }), pollIntervalMs: 1, waitForExit: async () => { subscriptions++; return exit; } });
  await transport.startWithoutInput({ selection: f.request.selection, tmuxSession: f.request.tmuxSession, cwd: f.request.cwd });
  const first = transport.waitExit();
  const second = transport.waitExit();
  assert.equal(subscriptions, 1);
  resolveExit({ code: 0, signal: null });
  assert.deepEqual(await Promise.all([first, second]), [{ code: 0, signal: null }, { code: 0, signal: null }]);
});
