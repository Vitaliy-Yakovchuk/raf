import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const fingerprint = async (path: string) => {
  const value = await fs.lstat(path);
  return { path, dev: value.dev, ino: value.ino, mode: value.mode, size: value.size,
    kind: value.isSocket() ? 'socket' : value.isFile() ? 'file' : 'other' };
};
const connect = (path: string) => new Promise<string>((resolve, reject) => {
  const socket = net.connect(path);
  let value = '';
  socket.setTimeout(3000, () => socket.destroy(Error('Host control connection timed out')));
  socket.on('data', data => value += data);
  socket.on('error', reject);
  socket.on('end', () => resolve(value));
});

export async function adapterSandboxControls(f: any, cfg: any, cleanup: Array<() => any>) {
  const servers: net.Server[] = [];
  cleanup.push(async () => { for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); });
  const db = new DatabaseSync(cfg.statePath);
  cleanup.push(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; BEGIN;');
  db.prepare('SELECT count(*) FROM sqlite_schema').get();
  const resources: any[] = [];
  const file = async (id: string, path: string, create = false) => {
    if (create) {
      await fs.mkdir(join(path, '..'), { recursive: true });
      await fs.writeFile(path, 'PRIVATE QA NONSECRET CANARY ' + id + '\n', { flag: 'wx' });
    }
    const before = await fingerprint(path);
    assert.equal(before.kind, 'file', 'Host file control must exist before native launch');
    resources.push({ id, path, kind: 'file', before, immutable: create,
      ...(create ? { sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex') } : {}) });
  };
  await file('state', cfg.statePath);
  await file('state-wal', cfg.statePath + '-wal');
  await file('state-shm', cfg.statePath + '-shm');
  await file('private-secret-canary', join(cfg.home, '.raf', 'secrets', 'cfc24-canary'), true);
  await file('neighbor-questions', join(cfg.root, 'questions', 'projects', 'cfc24-unassigned', 'questions.md'), true);
  for (const id of ['bus', 'ssh-agent', 'host-unregistered']) {
    const path = id === 'host-unregistered' ? join(cfg.home, '.raf', 'cfc24-host-unregistered.sock') : join(f.directory, 'cfc24-' + id + '.sock');
    const payload = 'HOST CONTROL ' + id;
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.end(payload); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    servers.push(server);
    assert.equal(await connect(path), payload);
    resources.push({ id, path, kind: 'socket', before: await fingerprint(path), payload });
  }
  const main = f.inspect().sessions.find((session: any) => session.process?.runner === 'main');
  const registered = main?.process?.evidence?.tmuxSocket;
  assert.ok(registered, 'Public main must have a registered real tmux socket');
  const before = await fingerprint(registered);
  assert.equal(before.kind, 'socket');
  const registeredControl = async () => {
    const args = ['-S', registered, 'display-message', '-p', '-t', 'adapter-main', '#{session_name}:#{pane_pid}'];
    const result = await exec(cfg.tmux, args, { timeout: 3000 });
    assert.equal(result.stdout.trim(), 'adapter-main:' + main.process.pid);
    return { command: [cfg.tmux, ...args], cliCode: 0, stdout: result.stdout, stderr: result.stderr };
  };
  resources.push({ id: 'registered-main-tmux', kind: 'socket', path: registered, before,
    hostCommandBefore: await registeredControl(), registered: { runId: main.runId, pid: main.process.pid, startedAt: main.process.startedAt } });
  const manifest = { schema: 'cfc24-private-sandbox-controls-v1', tmuxExecutable: cfg.tmux, createdAt: new Date().toISOString(),
    boundary: 'All controls belong to this private stand. No operational host services, credentials, or neighboring real questions are read.', resources };
  const manifestPath = join(cfg.sourceRoot, 'scripts', 'cfc24-private-controls.json');
  const body = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(manifestPath, body, { flag: 'wx' });
  return { manifestPath, manifest, verify: async () => {
    assert.equal(await fs.readFile(manifestPath, 'utf8'), body, 'Native must not change the host control manifest');
    const after = [];
    for (const resource of resources) {
      const current = await fingerprint(resource.path);
      assert.equal(current.dev, resource.before.dev);
      assert.equal(current.ino, resource.before.ino);
      assert.equal(current.kind, resource.kind);
      if (resource.immutable) assert.equal(createHash('sha256').update(await fs.readFile(resource.path)).digest('hex'), resource.sha256);
      if (resource.payload) assert.equal(await connect(resource.path), resource.payload);
      after.push({ id: resource.id, ...current, ...(resource.payload ? { hostConnection: 'passed' } : {}) });
    }
    const currentMain = f.inspect().sessions.find((session: any) => session.runId === main.runId);
    assert.equal(currentMain?.state, 'running');
    assert.equal(currentMain?.process?.evidence?.tmuxSocket, registered);
    return { after, registeredHostCommandAfter: await registeredControl(), manifestUnchanged: true, registeredMainUnchanged: true };
  } };
}
