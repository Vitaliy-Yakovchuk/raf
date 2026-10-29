import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AdapterCommand, AdapterCommandResult } from '../src/agent-adapters.ts';
import type { RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';
import { createProductionServices, rafSystemCaller } from '../src/production-runtime.ts';
import { observeRunnerScreen, readNativeComposer, type ProtocolSettings } from '../src/runner-protocols.ts';
import type { SessionRecord, SessionTransaction } from '../src/session-state.ts';
import type { StateStore } from '../src/state-store.ts';

const frame = await readFile(new URL('./fixtures/mac-handler-failed-r4/main-20261029T025904.txt', import.meta.url), 'utf8');
const protocols: ProtocolSettings[] = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols;
const claude = protocols.find(row => row.runner === 'claude')!;
const codex = protocols.find(row => row.runner === 'codex')!;
const lstart = 'Wed Oct 28 16:42:05 2026';
const pane = '%0';
const socket = '/tmp/mac-handler-failed-r4.sock';

test('the captured empty composer is Claude; removing sidebar, status or done never makes it Codex', () => {
  assert.deepEqual(readNativeComposer(claude, frame), { line: 62, input: '' });
  assert.equal(observeRunnerScreen(claude, { text: frame, version: claude.version, requestedCommand: null }).state, 'ready');
  for (const text of [frame,
    frame.split('\n').map(line => line.split('│')[0].trimEnd()).join('\n'),
    frame.split('\n').filter(line => !line.includes('⏵⏵')).join('\n'),
    frame.split('\n').filter(line => !line.includes('Sautéed')).join('\n'),
  ]) {
    assert.equal(readNativeComposer(claude, text)?.input, '');
    assert.equal(readNativeComposer(codex, text), null);
  }
});

async function deliver(options: { command?: string; runner?: 'main' | 'codex'; screen?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mac-handler-failed-r4-'));
  const command = options.command ?? '-fish';
  const session: SessionRecord = { runId: 'main-run', addressId: 'main', revision: 0, state: 'running', process: {
    pid: process.pid, startedAt: new Date(lstart).toISOString(), runner: options.runner ?? 'main', runnerSessionId: pane,
    tmuxSession: 'main', evidence: { command, tmuxSocket: socket, tmuxPane: pane },
  } };
  const tx = { getSession: () => structuredClone(session), listSessions: () => [structuredClone(session)],
    listReservations: () => [], listPending: () => [], putSession: (next: SessionRecord) => Object.assign(session, next),
    applyEffects: () => {} } as unknown as SessionTransaction;
  const store = { sessionRepository: { transaction: (operation: (value: SessionTransaction) => unknown) => operation(tx) } } as unknown as StateStore;
  const context: RuntimeContext = { orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'),
    statePath: join(root, 'state.sqlite'), tmpRoot: join(root, 'tmp'), mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined };
  let pasted = '', captures = 0, enters = 0;
  const screen = options.screen ?? frame;
  const execute = async (request: AdapterCommand): Promise<AdapterCommandResult> => {
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (request.executable === 'ps') {
      if (request.args.includes('pid=,ppid=,lstart=,command=')) return ok([
        `${process.pid} 1 ${lstart} ${command}`,
        `41001 ${process.pid} ${lstart} 2.1.312`,
        `41002 41001 ${lstart} /opt/homebrew/bin/codex app-server --listen stdio://`,
      ].join('\n') + '\n');
      return ok(`${process.pid} ${lstart} ${command}\n`);
    }
    assert.equal(request.executable, 'tmux');
    const args = [...request.args];
    assert.deepEqual(args.splice(0, 3), ['-u', '-S', socket]);
    if (args[0] === 'display-message') return ok(args.at(-1) === '#{pane_id}\t#{pane_pid}' ? `${pane}\t${process.pid}\n` : args.at(-1) === '#{pane_pid}' ? `${process.pid}\n` : `${pane}\n`);
    if (args[0] === 'capture-pane') {
      captures++;
      return ok(pasted ? `${pasted}\n${screen}` : screen);
    }
    if (args[0] === 'load-buffer') { pasted = request.stdin ?? ''; return ok(); }
    if (args[0] === 'send-keys') { enters++; return ok(); }
    if (args[0] === 'paste-buffer' || args[0] === 'delete-buffer') return ok();
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  try {
    const services = await createProductionServices(store, { catalog: { commands: [], reportStatuses: [] } } as unknown as RuntimeConfiguration,
      context, { execute, protocolSettings: protocols });
    const receipt = await services.control.message({ to: 'main', text: 'r4 fixture canary' }, rafSystemCaller);
    assert.equal(receipt.accepted, true);
    assert.equal(pasted, '[raf] r4 fixture canary');
    assert.equal(captures, 2, 'reuse the first captured frame under the delivery lease');
    assert.equal(enters, 1, 'only the original paste Enter is sent');
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('main delivery recognizes the verbatim Claude frame despite an inferred Codex descendant', async () => {
  await deliver();
});

test('main delivery retains an explicitly recorded Codex protocol', async () => {
  await assert.rejects(deliver({ command: '/opt/homebrew/bin/codex' }), /Recipient has no recognized empty agent composer/);
});

test('a worker retains its recorded Codex protocol', async () => {
  await assert.rejects(deliver({ command: '/opt/homebrew/bin/codex', runner: 'codex' }), /Recipient has no recognized empty agent composer/);
});

test('an unrecognized Claude footer does not override inferred Codex', async () => {
  await assert.rejects(deliver({ screen: '❯\u00a0\nunknown footer\n' }), /Recipient has no recognized empty agent composer/);
});
