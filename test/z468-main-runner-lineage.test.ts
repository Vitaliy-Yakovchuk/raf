import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AdapterCommand, AdapterCommandResult } from '../src/agent-adapters.ts';
import type { RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';
import { createProductionServices, rafSystemCaller } from '../src/production-runtime.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { ProcessIdentity, SessionRecord, SessionTransaction } from '../src/session-state.ts';
import type { StateStore } from '../src/state-store.ts';

const configured = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')) as { runnerProtocols: ProtocolSettings[] };
const protocols = configured.runnerProtocols.map(row => ({ ...structuredClone(row), timeouts: { startupMs: 1000, transitionMs: 400, overallMs: 1000, pollMs: 5 } }));
const protocol = (runner: string) => {
  const settings = protocols.find(row => row.runner === runner);
  assert.ok(settings?.native, `${runner} native protocol`);
  return settings;
};

const lstart = 'Sun Oct 25 12:00:00 2026';
const startedAt = new Date(lstart).toISOString();
const pane = '%8';
const socket = '/tmp/z468-main-runner.sock';
const launcher = '/bin/zsh /Users/val/.raf/mac-start/20261026/coordinator-private-launch.zsh';
const nodeCodex = 'node /opt/homebrew/bin/codex app-server --listen unix:///tmp/coordinator-app-server.sock';
const vendorCodex = '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex app-server --listen unix:///tmp/coordinator-app-server.sock';

type ProcessRow = { pid: number; ppid: number; command: string };

function screen(runner: 'codex' | 'claude', message?: string): string {
  const settings = protocol(runner);
  const ready = settings.markers.ready![0];
  const prompt = runner === 'codex' ? '›' : '$';
  const composer = message ? `${prompt} ` : runner === 'codex' ? `${prompt} ${ready}` : `${prompt} `;
  return [`${runner} main`, ready, ...(message ? [message] : []), composer].join('\n');
}

async function deliver(command: string, runner: 'codex' | 'claude', text: string, descendants: readonly ProcessRow[]) {
  assert.ok(descendants.every(row => row.pid !== process.pid && row.ppid !== 0));
  const root = await mkdtemp(join(tmpdir(), 'z468-main-runner-'));
  const sessions = new Map<string, SessionRecord>();
  const tx = {
    getSession: (id: string) => structuredClone(sessions.get(id)),
    listSessions: () => structuredClone([...sessions.values()]),
    putSession: (session: SessionRecord) => { sessions.set(session.runId, structuredClone(session)); },
    deleteSession: (id: string) => { sessions.delete(id); },
    listReservations: () => [],
    putReservation: () => {},
    deleteReservation: () => {},
    putPending: () => {},
    deletePending: () => {},
    listPending: () => [],
    applyEffects: () => {},
  } as unknown as SessionTransaction;
  const store = { sessionRepository: { transaction: (operation: (value: SessionTransaction) => unknown) => operation(tx) } } as unknown as StateStore;
  const context: RuntimeContext = {
    orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'),
    statePath: join(root, 'state.sqlite'), tmpRoot: join(root, 'tmp'),
    mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined,
  };
  const identity: ProcessIdentity = {
    pid: process.pid, startedAt, runner: 'main', runnerSessionId: pane, tmuxSession: 'main',
    evidence: { command, tmuxSocket: socket, tmuxPane: pane },
  };
  sessions.set('main-run', { runId: 'main-run', addressId: 'main', revision: 0, state: 'running', process: identity });
  let pasted = '';
  const calls: AdapterCommand[] = [];
  const listing = [`${process.pid} 1 ${lstart} ${command}`, ...descendants.map(row => `${row.pid} ${row.ppid} ${lstart} ${row.command}`)].join('\n') + '\n';
  const execute = async (commandLine: AdapterCommand): Promise<AdapterCommandResult> => {
    calls.push(structuredClone(commandLine));
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (commandLine.executable === 'ps') {
      if (commandLine.args.includes('pid=,ppid=,lstart=,command=')) return ok(listing);
      assert.ok(commandLine.args.includes(String(process.pid)), commandLine.args.join(' '));
      return ok(`${process.pid} ${lstart} ${command}\n`);
    }
    assert.equal(commandLine.executable, 'tmux', commandLine.executable);
    const args = [...commandLine.args];
    assert.deepEqual(args.splice(0, 3), ['-u', '-S', socket]);
    const action = args[0];
    if (action === 'display-message') return ok(args.at(-1) === '#{pane_id}\t#{pane_pid}' ? `${pane}\t${process.pid}\n` : `${pane}\n`);
    if (action === 'capture-pane') return ok(pasted ? screen(runner, pasted) : screen(runner));
    if (action === 'load-buffer') { pasted = commandLine.stdin ?? ''; return ok(); }
    if (action === 'paste-buffer') return ok();
    if (action === 'send-keys' || action === 'delete-buffer') return ok();
    throw new Error(`Unexpected tmux command: ${args.join(' ')}`);
  };
  try {
    const services = await createProductionServices(store, { catalog: { commands: [], reportStatuses: [] } } as unknown as RuntimeConfiguration, context, { execute, protocolSettings: protocols });
    const receipt = await services.control.message({ to: 'main', text }, rafSystemCaller);
    assert.equal(receipt.accepted, true, command);
    assert.equal(pasted, `[raf] ${text}`);
    assert.ok(calls.some(call => call.args.includes('paste-buffer') && call.args.includes(pane)));
    assert.equal(sessions.get('main-run')?.process?.evidence.command, command);
    return receipt;
  } finally {
    assert.equal(sessions.get('main-run')?.process?.evidence.command, command);
    await rm(root, { recursive: true, force: true });
  }
}

test('Z.468 message to main uses the Codex composer when the pane command is the Mac shell launcher and Codex is its descendant', async () => {
  await deliver(launcher, 'codex', 'codex descendant ready', [
    { pid: 41001, ppid: process.pid, command: nodeCodex },
    { pid: 41002, ppid: 41001, command: vendorCodex },
    { pid: 41003, ppid: 1, command: '/usr/bin/claude' },
  ]);
});

test('Z.468 message to main follows the lineage past a wrapper that does not name the protocol executable', async () => {
  await deliver(launcher, 'codex', 'codex grandchild ready', [
    { pid: 41011, ppid: process.pid, command: '/usr/bin/sleep 1000' },
    { pid: 41012, ppid: 41011, command: vendorCodex },
  ]);
});

test('Z.468 message to main keeps Claude when the shell launcher has no protocol-executable descendant', async () => {
  await deliver(launcher, 'claude', 'shell without runner', [
    { pid: 41021, ppid: process.pid, command: '/usr/bin/python3 -' },
  ]);
});

test('Z.468 message to main does not infer Codex from a prompt word or an environment assignment', async () => {
  await assert.rejects(
    deliver(launcher, 'codex', 'prompt is not a process', [
      { pid: 41031, ppid: process.pid, command: 'echo Ask Codex to do anything' },
      { pid: 41032, ppid: process.pid, command: 'env CODEX_HOME=/tmp /bin/zsh' },
    ]),
    /Recipient has no recognized empty agent composer/,
  );
});

test('Z.468 message to main keeps the runner named by the pane command when a descendant names another executable', async () => {
  await deliver('/opt/homebrew/bin/codex --no-alt-screen', 'codex', 'pane command wins', [
    { pid: 41041, ppid: process.pid, command: '/usr/bin/claude' },
  ]);
});
