import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const input = JSON.parse(process.argv[2]);
const deniedCodes = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS'];
const observations = [];

function progress(marker, details = {}) {
  const identity = { pid: process.pid, ppid: process.ppid, role: input.child ? 'child' : 'parent' };
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    Object.assign(identity, { state: fields[0], processGroup: Number(fields[2]), session: Number(fields[3]), startTicks: fields[19] });
  } catch (error) { identity.diagnosticError = error.code ?? error.message; }
  writeSync(2, 'Z404_PROGRESS ' + JSON.stringify({ marker, observedAt: new Date().toISOString(), identity, ...details }) + '\n');
}
progress('probe:begin');
process.once('exit', code => progress('probe:exit', { code }));

async function denied(action, label, codes = deniedCodes) {
  progress('deny:before', { label });
  let failure;
  try { await action(); } catch (error) { failure = error; }
  assert.ok(failure, `${label}: unexpectedly permitted`);
  assert.ok(codes.includes(failure.code), `${label}: ${failure.code} is not isolation`);
  observations.push({ label, code: failure.code });
  progress('deny:after', { label, code: failure.code });
}

async function connectOnce(address) {
  return await new Promise((done, reject) => {
    const socket = connect(address);
    socket.setTimeout(input.transitionMs, () => socket.destroy(new Error('probe transport deadline')));
    socket.on('error', reject);
    socket.on('connect', () => { socket.destroy(); done(); });
  });
}

for (const path of input.denyReads) await denied(() => fs.readFile(path), `read:${path}`);
for (const path of input.denyWrites) await denied(() => fs.writeFile(path, 'forbidden'), `write:${path}`);
for (const path of input.denyDirectories) await denied(() => fs.readdir(path), `directory:${path}`);
await denied(() => fs.rename(input.questions, join(dirname(input.questions), 'moved.md')), 'questions-rename', [...deniedCodes, 'EBUSY']);
await denied(() => fs.unlink(input.questions), 'questions-unlink', [...deniedCodes, 'EBUSY']);
for (const path of input.endpoints) await denied(() => connectOnce(path), `unix:${path}`);
for (const address of input.ports) await denied(() => connectOnce(address), `tcp:${address.host}`, ['EACCES', 'EPERM', 'ENETUNREACH', 'EHOSTUNREACH']);

async function unixPayload() {
  const ownIpc = [];
  for (const directory of [input.workspace, input.runDirectory]) {
    const location = directory === input.workspace ? 'workspace' : 'run';
    progress(`unix:${location}:before`);
    const original = process.cwd();
    process.chdir(directory);
    const path = input.child ? 'z404-child.sock' : 'z404-own.sock';
    const server = createServer(connection => connection.end(input.payload));
    try {
      await new Promise((done, reject) => { server.once('error', reject); server.listen(path, done); });
      const address = server.address();
      assert.equal(typeof address, 'string');
      assert.ok(Buffer.byteLength(address) < 108, 'actual listen pathname must fit Linux sun_path');
      const payload = await new Promise((done, reject) => {
        let data = ''; const client = connect(path);
        client.on('error', reject); client.on('data', chunk => { data += chunk; }); client.on('end', () => done(data));
      });
      assert.equal(payload, input.payload);
      ownIpc.push({ directory, address, payload });
    } finally {
      if (server.listening) await new Promise(done => server.close(done));
      await fs.rm(path, { force: true }); process.chdir(original);
      progress(`unix:${location}:after`);
    }
  }
  return ownIpc;
}

if (input.child) {
  process.stdout.write(JSON.stringify({ observations, ownIpc: await unixPayload() }));
} else {
  progress('child:before');
  const child = spawnSync(process.execPath, [process.argv[1], JSON.stringify({ ...input, child: true })], { env: process.env, encoding: 'utf8', timeout: input.transitionMs });
  writeSync(2, child.stderr ?? '');
  progress('child:after', { pid: child.pid, status: child.status, signal: child.signal, errorCode: child.error?.code ?? null });
  assert.equal(child.error, undefined, 'child must execute; startup failure is not denial');
  assert.equal(child.status, 0, child.stderr);
  const childOutput = JSON.parse(child.stdout);
  assert.deepEqual(childOutput.observations, observations, 'child retains every deny boundary');
  assert.deepEqual(childOutput.ownIpc.map(item => item.directory), [input.workspace, input.runDirectory]);
  assert.ok(childOutput.ownIpc.every(item => item.payload === input.payload));
  const ownIpc = await unixPayload();
  assert.ok(!process.env.TMUX && !process.env.TMUX_PANE, 'tool must not inherit host pane selection');
  const tmux = [];
  const literal = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const kind of ['default', 'named']) {
    const args = kind === 'named' ? ['-L', `z404-${input.token}`] : [];
    const execute = (more, timeoutMs = input.transitionMs) => {
      progress(`tmux:${kind}:command:before`, { command: more[0] === '-f' ? 'new-session' : more[0] });
      const result = spawnSync('tmux', [...args, ...more], { env: process.env, encoding: 'utf8', timeout: timeoutMs });
      progress(`tmux:${kind}:command:after`, { command: more[0] === '-f' ? 'new-session' : more[0], pid: result.pid,
        status: result.status, signal: result.signal, errorCode: result.error?.code ?? null });
      return result;
    };
    const good = result => { assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    const output = join(input.runDirectory, `tmux-${kind}.payload`);
    let started = false, address, socketIdentity, directoryIdentity;
    try {
      good(execute(['-f', '/dev/null', 'new-session', '-d', '-s', 'probe', '/bin/sh']));
      started = true;
      address = good(execute(['display-message', '-p', '#{socket_path}']));
      assert.ok(Buffer.byteLength(address) < 108, 'actual default/named tmux address fits sun_path');
      const socketName = kind === 'named' ? `z404-${input.token}` : 'default';
      assert.equal(address, resolve(address), 'own tmux socket path is absolute and normalized');
      assert.equal(address, join(dirname(address), socketName), 'own tmux socket path matches its selection');
      socketIdentity = await fs.lstat(address);
      assert.ok(socketIdentity.isSocket(), 'own tmux endpoint is a socket, never a symlink');
      assert.equal(socketIdentity.uid, process.getuid(), 'own tmux socket owner');
      directoryIdentity = await fs.lstat(dirname(address));
      assert.ok(directoryIdentity.isDirectory(), 'own tmux socket parent is a directory, never a symlink');
      assert.equal(directoryIdentity.uid, process.getuid(), 'own tmux socket directory owner');
      assert.equal(directoryIdentity.mode & 0o022, 0, 'own tmux socket directory is not writable by other users');
      progress(`tmux:${kind}:payload:before`);
      const command = [process.execPath, '-e', `require('node:fs').writeFileSync(process.argv[1],process.argv[2])`, output, input.payload].map(literal).join(' ');
      good(execute(['send-keys', '-t', 'probe', '-l', command])); good(execute(['send-keys', '-t', 'probe', 'Enter']));
      const deadline = Date.now() + input.transitionMs;
      while (true) {
        try { assert.equal(await fs.readFile(output, 'utf8'), input.payload); break; }
        catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; await delay(input.pollMs); }
      }
      tmux.push({ kind, address, payload: await fs.readFile(output, 'utf8') });
      progress(`tmux:${kind}:payload:after`);
    } finally {
      progress(`tmux:${kind}:cleanup:before`);
      if (started) {
        const killed = execute(['kill-server']);
        assert.equal(killed.error, undefined); assert.equal(killed.status, 0, killed.stderr);
      }
    }
    const cleanupDeadline = Date.now() + input.transitionMs;
    progress(`tmux:${kind}:server-exit:before`);
    while (true) {
      const remainingMs = cleanupDeadline - Date.now();
      assert.ok(remainingMs > 0, 'own tmux server must exit before cleanup deadline');
      const listed = execute(['list-sessions'], remainingMs);
      assert.equal(listed.error, undefined, 'own tmux server exit check must execute');
      assert.equal(listed.signal, null, 'own tmux server exit check must complete');
      if (listed.status === 1) {
        assert.equal(listed.stdout.trim(), '', 'no server produces no sessions');
        const diagnostic = listed.stderr.trim();
        if (diagnostic === `error connecting to ${address} (No such file or directory)`) {
          await assert.rejects(fs.lstat(address), { code: 'ENOENT' }, 'missing own socket confirms no server');
        } else {
          assert.equal(diagnostic, `no server running on ${address}`, 'only no-server refusal confirms server exit');
        }
        break;
      }
      assert.equal(listed.status, 0, listed.stderr);
      assert.ok(Date.now() < cleanupDeadline, 'own tmux server must exit before cleanup deadline');
      await delay(Math.min(input.pollMs, Math.max(0, cleanupDeadline - Date.now())));
    }
    progress(`tmux:${kind}:server-exit:after`);
    let residual;
    try { residual = await fs.lstat(address); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (residual) {
      assert.ok(Date.now() < cleanupDeadline, 'own tmux socket cleanup retains its deadline');
      assert.ok(residual.isSocket(), 'residual own tmux endpoint must still be a socket');
      for (const field of ['dev', 'ino', 'uid']) assert.equal(residual[field], socketIdentity[field], `own tmux socket ${field} identity retained`);
      const directory = await fs.lstat(dirname(address));
      assert.ok(directory.isDirectory(), 'own tmux socket directory must not be replaced by a symlink');
      for (const field of ['dev', 'ino', 'uid', 'mode']) assert.equal(directory[field], directoryIdentity[field], `own tmux socket directory ${field} identity retained`);
      progress(`tmux:${kind}:socket-unlink:before`, { address });
      try { await fs.unlink(address); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      progress(`tmux:${kind}:socket-unlink:after`, { address });
    }
    while (true) {
      try { await fs.lstat(address); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      assert.ok(Date.now() < cleanupDeadline, 'own tmux socket must be removed');
      await delay(input.pollMs);
    }
    await fs.rm(output);
    progress(`tmux:${kind}:cleanup:after`);
  }
  await fs.writeFile(input.questions, 'question-updated-in-place');
  await fs.writeFile(join(input.workspace, 'allowed.txt'), input.payload);
  await fs.writeFile(join(input.runDirectory, 'report.json'), JSON.stringify({ status: 'succeeded', payload: input.payload }));
  for (const args of [['add', 'allowed.txt'], ['-c', 'user.name=Z404', '-c', 'user.email=z404@example.invalid', 'commit', '-m', 'own sandbox commit']]) {
    progress('git:before', { command: args[0] === '-c' ? 'commit' : args[0] });
    const result = spawnSync('git', args, { cwd: input.workspace, env: process.env, encoding: 'utf8', timeout: input.transitionMs });
    progress('git:after', { command: args[0] === '-c' ? 'commit' : args[0], pid: result.pid, status: result.status, signal: result.signal, errorCode: result.error?.code ?? null });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  }
  const sibling = join(dirname(input.questions), 'replacement.md');
  await denied(() => fs.writeFile(sibling, 'rename-must-not-widen'), 'questions-parent-create');
  process.stdout.write(JSON.stringify({ observations, ownIpc, tmux, child: childOutput, fileWrite: true, gitCommit: true }));
}
