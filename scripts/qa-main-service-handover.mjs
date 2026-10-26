import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export function prepareStandService({ generation, root, home, environment, evidencePath }) {
  const program = `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';
    const generation = ${JSON.stringify(generation)};
    const { retainHotfixGeneration } = await import(pathToFileURL(path.join(generation, 'src/hotfix-activation.ts')).href);
    const lease = await retainHotfixGeneration({ orchestratorRoot: ${JSON.stringify(root)}, qaHome: ${JSON.stringify(home)}, environment: {}, sandboxExecutable: 'codex' }, generation);
    const { runServiceEntry } = await import(pathToFileURL(path.join(generation, 'src/service-entry.ts')).href);
    try {
      const host = await runServiceEntry({ loadPorts: async (modulePath, context) => {
        const { createServicePorts } = await import(pathToFileURL(modulePath).href);
        let store;
        const ports = await createServicePorts(context, { onStore: value => { store = value; } });
        assert.ok(store, 'Standby must open the real production store');
        const grant = store.readResourceWaitGrant();
        const sessions = store.sessionRepository.transaction(tx => tx.listSessions(), 'read');
        process.send({ kind: 'prepared', mainPath: generation, pid: process.pid, restored: true,
          lastGrant: grant, sessions: sessions.map(s => ({ runId: s.runId, addressId: s.addressId, state: s.state })) });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Standby activation deadline exhausted')), 120000);
          process.once('message', message => { clearTimeout(timer); message?.kind === 'activate' ? resolve() : reject(Error('Unknown standby control')); });
        }).catch(async error => { await ports.shutdown(); throw error; });
        return ports;
      } });
      process.send({ kind: 'activated', pid: process.pid });
      await host.closed;
    } finally { await lease?.release(); }
  `;
  const log = fs.openSync(evidencePath + '.log', 'ax', 0o600);
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    cwd: generation, detached: true, stdio: ['ignore', log, log, 'ipc'], env: {
      ...environment, RAF_ORCHESTRATOR_ROOT: root, RAF_HOME_DIRECTORY: home,
      RAF_STATE_DIRECTORY: path.join(home, '.raf'), RAF_SOCKET_PATH: path.join(home, '.raf/service.sock'),
      RAF_MAIN_PATH: generation, RAF_SERVICE_HOST_MODULE_PATH: path.join(generation, 'src/production-service-ports.ts'),
    },
  });
  fs.closeSync(log);
  const pending = new Map();
  let failure;
  const receive = kind => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const timer = setTimeout(() => { pending.delete(kind); reject(Error('Standby did not confirm ' + kind)); }, 120000);
    pending.set(kind, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
  child.on('message', message => {
    fs.appendFileSync(evidencePath + '.jsonl', JSON.stringify({ ...message, at: new Date().toISOString() }) + '\n');
    pending.get(message.kind)?.resolve(message); pending.delete(message.kind);
  });
  const failed = error => { failure = error; for (const value of pending.values()) value.reject(error); pending.clear(); };
  child.on('error', failed);
  child.on('exit', (code, signal) => failed(Error('Standby exited: ' + code + '/' + signal)));
  const prepared = receive('prepared');
  return {
    async prepare() { const proof = await prepared; assert.equal(proof.pid, child.pid); return proof; },
    async activate() { const activated = receive('activated'); child.send({ kind: 'activate' }); await activated; child.disconnect(); child.unref(); },
  };
}
