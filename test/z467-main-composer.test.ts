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
const pane = '%7';
const socket = '/tmp/z467-main-composer.sock';

function screen(runner: 'codex' | 'claude', message?: string): string {
  const settings = protocol(runner);
  const ready = settings.markers.ready![0];
  const prompt = runner === 'codex' ? '›' : '$';
  const composer = message ? `${prompt} ` : runner === 'codex' ? `${prompt} ${ready}` : `${prompt} `;
  return [`${runner} main`, ready, ...(message ? [message] : []), composer].join('\n');
}

async function deliver(command: string, runner: 'codex' | 'claude', text: string) {
  const root = await mkdtemp(join(tmpdir(), 'z467-main-composer-'));
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
  const execute = async (commandLine: AdapterCommand): Promise<AdapterCommandResult> => {
    calls.push(structuredClone(commandLine));
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (commandLine.executable === 'ps') {
      if (commandLine.args.includes('pid=,ppid=,lstart=,command=')) return ok(`${process.pid} 1 ${lstart} ${command}\n`);
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
    return receipt;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Z.467 message to main uses the Codex composer when main attach recorded a Codex process', async () => {
  for (const command of ['/opt/homebrew/bin/codex --no-alt-screen', '/Applications/Codex.app/Contents/MacOS/codex', 'Codex']) {
    await deliver(command, 'codex', 'codex main ready');
  }
});

test('Z.467 message to main keeps Claude composer recognition when main attach recorded Claude', async () => {
  await deliver('/usr/local/bin/claude', 'claude', 'claude main ready');
});

test('Z.467 message to main keeps Claude composer recognition when the recorded process is not a runner', async () => {
  await deliver('-bash', 'claude', 'shell main ready');
});
