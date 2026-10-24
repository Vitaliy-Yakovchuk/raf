import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const input = JSON.parse(process.argv[2]);
const deniedCodes = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS'];
const observations = [];

async function denied(action, label, codes = deniedCodes) {
  let failure;
  try { await action(); } catch (error) { failure = error; }
  assert.ok(failure, `${label}: unexpectedly permitted`);
  assert.ok(codes.includes(failure.code), `${label}: ${failure.code} is not isolation`);
  observations.push({ label, code: failure.code });
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
    }
  }
  return ownIpc;
}

if (input.child) {
  process.stdout.write(JSON.stringify({ observations, ownIpc: await unixPayload() }));
} else {
  const child = spawnSync(process.execPath, [process.argv[1], JSON.stringify({ ...input, child: true })], { env: process.env, encoding: 'utf8', timeout: input.transitionMs });
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
    const execute = more => spawnSync('tmux', [...args, ...more], { env: process.env, encoding: 'utf8', timeout: input.transitionMs });
    const good = result => { assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    const output = join(input.runDirectory, `tmux-${kind}.payload`);
    let started = false, address;
    try {
      good(execute(['-f', '/dev/null', 'new-session', '-d', '-s', 'probe', '/bin/sh']));
      started = true;
      address = good(execute(['display-message', '-p', '#{socket_path}']));
      assert.ok(Buffer.byteLength(address) < 108, 'actual default/named tmux address fits sun_path');
      const command = [process.execPath, '-e', `require('node:fs').writeFileSync(process.argv[1],process.argv[2])`, output, input.payload].map(literal).join(' ');
      good(execute(['send-keys', '-t', 'probe', '-l', command])); good(execute(['send-keys', '-t', 'probe', 'Enter']));
      const deadline = Date.now() + input.transitionMs;
      while (true) {
        try { assert.equal(await fs.readFile(output, 'utf8'), input.payload); break; }
        catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; await delay(input.pollMs); }
      }
      tmux.push({ kind, address, payload: await fs.readFile(output, 'utf8') });
    } finally {
      if (started) {
        const killed = execute(['kill-server']);
        assert.equal(killed.error, undefined); assert.equal(killed.status, 0, killed.stderr);
      }
    }
    const cleanupDeadline = Date.now() + input.transitionMs;
    while (true) {
      try { await fs.lstat(address); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      assert.ok(Date.now() < cleanupDeadline, 'own tmux socket must be removed');
      await delay(input.pollMs);
    }
    await fs.rm(output);
  }
  await fs.writeFile(input.questions, 'question-updated-in-place');
  await fs.writeFile(join(input.workspace, 'allowed.txt'), input.payload);
  await fs.writeFile(join(input.runDirectory, 'report.json'), JSON.stringify({ status: 'succeeded', payload: input.payload }));
  for (const args of [['add', 'allowed.txt'], ['-c', 'user.name=Z404', '-c', 'user.email=z404@example.invalid', 'commit', '-m', 'own sandbox commit']]) {
    const result = spawnSync('git', args, { cwd: input.workspace, env: process.env, encoding: 'utf8', timeout: input.transitionMs });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  }
  const sibling = join(dirname(input.questions), 'replacement.md');
  await denied(() => fs.writeFile(sibling, 'rename-must-not-widen'), 'questions-parent-create');
  process.stdout.write(JSON.stringify({ observations, ownIpc, tmux, child: childOutput, fileWrite: true, gitCommit: true }));
}
