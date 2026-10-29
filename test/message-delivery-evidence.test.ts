import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AdapterCommand, AdapterCommandResult } from '../src/agent-adapters.ts';
import type { RuntimeConfiguration, RuntimeContext } from '../src/app-runtime.ts';
import type { PrivateDeliveryEvidence } from '../src/delivery-evidence.ts';
import { createProductionServices, rafSystemCaller } from '../src/production-runtime.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import type { SessionRecord, SessionTransaction } from '../src/session-state.ts';
import type { StateStore } from '../src/state-store.ts';

const protocols = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols as ProtocolSettings[];
const ready = '❯\u00a0\n────────────────\n  ⏵⏵ bypass permissions on';
const lstart = 'Sun Oct 25 12:00:00 2026';
const pane = '%8';
const socket = '/tmp/message-delivery-evidence.sock';
const command = '/usr/bin/claude';

for (const scenario of [
  { name: 'unrecognized composer', frames: ['unknown footer\n❯\u00a0\n'], reason: 'Recipient has no recognized empty agent composer', pastes: 0 },
  { name: 'unrelated input', frames: [ready, '❯ foreign draft\n────────────────\n  ⏵⏵ bypass permissions on'], reason: 'Recipient composer contains unrelated input', pastes: 1 },
]) test(`message refusal preserves the actual ${scenario.name} frame and references it`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'message-delivery-evidence-')));
  try {
    await mkdir(join(root, 'conf'));
    await mkdir(join(root, 'tmp'));
    const retention = 3600000;
    await writeFile(join(root, 'conf', 'flow.json'), JSON.stringify({ retention: { failedDeliveryEvidenceMs: retention } }));
    const session: SessionRecord = { runId: 'main-run', addressId: 'main', revision: 0, state: 'running', process: {
      pid: process.pid, startedAt: new Date(lstart).toISOString(), runner: 'main', runnerSessionId: pane,
      tmuxSession: 'main', evidence: { command, tmuxSocket: socket, tmuxPane: pane },
    } };
    const tx = { getSession: () => structuredClone(session), listSessions: () => [structuredClone(session)],
      listReservations: () => [], listPending: () => [], putSession: (next: SessionRecord) => Object.assign(session, next),
      applyEffects: () => {} } as unknown as SessionTransaction;
    const store = { sessionRepository: { transaction: (operation: (value: SessionTransaction) => unknown) => operation(tx) } } as unknown as StateStore;
    const context: RuntimeContext = { orchestratorRoot: root, confRoot: join(root, 'conf'), artifactPath: join(root, 'catalog.json'),
      statePath: join(root, 'state.sqlite'), tmpRoot: join(root, 'tmp'), mode: 'test', commandStartedAtMs: 0, resolveCaller: async () => undefined };
    let captures = 0, pastes = 0, enters = 0;
    const execute = async (request: AdapterCommand): Promise<AdapterCommandResult> => {
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
      if (request.executable === 'ps') return ok(`${process.pid} ${lstart} ${command}\n`);
      assert.equal(request.executable, 'tmux');
      const args = [...request.args];
      assert.deepEqual(args.splice(0, 3), ['-u', '-S', socket]);
      if (args[0] === 'display-message') return ok(args.at(-1) === '#{pane_id}\t#{pane_pid}' ? `${pane}\t${process.pid}\n` : `${pane}\n`);
      if (args[0] === 'capture-pane') {
        assert.equal(args.at(-1), pane);
        assert.ok(captures < scenario.frames.length, 'diagnostics must not recapture the pane');
        return ok(scenario.frames[captures++]);
      }
      if (args[0] === 'load-buffer') { pastes++; return ok(); }
      if (args[0] === 'send-keys') { enters++; return ok(); }
      if (args[0] === 'paste-buffer' || args[0] === 'delete-buffer') return ok();
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    const services = await createProductionServices(store, { catalog: { commands: [], reportStatuses: [] } } as unknown as RuntimeConfiguration,
      context, { execute, protocolSettings: protocols });
    const references = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      captures = 0; pastes = 0; enters = 0;
      const started = Date.now();
      let failure: Error | undefined;
      await assert.rejects(services.control.message({ to: 'main', text: 'canary' }, rafSystemCaller), error => {
        assert.ok(error instanceof Error);
        failure = error;
        return error.message.startsWith(`Message delivery failed: ${scenario.reason}; deliveryEvidence=`);
      });
      const evidence = JSON.parse(failure!.message.split('; deliveryEvidence=')[1]);
      assert.equal(evidence.availability, 'available');
      assert.equal(evidence.recipientPane, pane);
      assert.match(evidence.execId, /^exec-[0-9a-f-]+$/);
      assert.equal(evidence.path, join(context.tmpRoot, '.delivery-evidence', evidence.execId, 'frame.json'));
      const saved = JSON.parse(await readFile(evidence.path, 'utf8')) as PrivateDeliveryEvidence;
      assert.equal(saved.reference, evidence.reference);
      assert.equal(saved.runId, evidence.execId);
      assert.equal(saved.capture.execId, evidence.execId);
      assert.equal(saved.capture.recipientPane, pane);
      assert.equal(saved.capture.frame.screen, scenario.frames.at(-1));
      assert.equal(saved.capture.frame.phase, scenario.pastes ? 'awaiting_acceptance' : 'before_submission');
      assert.ok(Date.parse(saved.capture.capturedAt) >= started && Date.parse(saved.capture.capturedAt) <= Date.now());
      assert.equal(Date.parse(saved.expiresAt) - Date.parse(saved.firstFailureAt), retention);
      assert.equal((await stat(evidence.path)).mode & 0o777, 0o600);
      assert.equal(captures, scenario.frames.length);
      assert.equal(pastes, scenario.pastes);
      assert.equal(enters, scenario.pastes, 'only the original paste Enter is sent');
      assert.ok(!references.has(evidence.path), 'each refused execution retains its own frame');
      references.add(evidence.path);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
