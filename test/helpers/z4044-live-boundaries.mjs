import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function checkBoundaries(own, actor) {
  const config = JSON.parse(await fs.readFile('qa/z4044-boundaries.json', 'utf8'));
  const result = { runId: path.basename(own), actor, denied: [], ipc: [], tmux: [] };
  const deadline = config.transitionMs;
  const denied = async (label, action, codes) => {
    let error;
    try { await action(); } catch (caught) { error = caught; }
    assert.ok(error, label + ' unexpectedly allowed');
    assert.ok(codes.includes(error.code), label + ': ' + error.code);
    result.denied.push({ label, code: error.code });
  };
  const transport = address => new Promise((done, reject) => {
    const socket = connect(address);
    socket.setTimeout(deadline, () => socket.destroy(new Error('transport deadline')));
    socket.on('error', reject); socket.on('connect', () => { socket.destroy(); done(); });
  });
  for (const target of config.denyReads) await denied('read:' + target, () => fs.readFile(target), ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);
  for (const target of [...config.endpoints, path.resolve('qa/z4044-main-alias.sock')]) await denied('unix:' + target, () => transport(target), ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);
  for (const target of config.ports) await denied('tcp:' + target.host, () => transport(target), ['EACCES', 'EPERM', 'ENETUNREACH', 'EHOSTUNREACH']);
  const payload = `z4044-${actor}-${path.basename(own)}`;
  const old = process.cwd();
  for (const directory of [old, own]) {
    process.chdir(directory);
    const address = `z4044-${actor}.sock`;
    const server = createServer(socket => socket.end(payload));
    try {
      await new Promise((done, reject) => { server.once('error', reject); server.listen(address, done); });
      const received = await new Promise((done, reject) => {
        let value = ''; const socket = connect(address);
        socket.on('error', reject); socket.on('data', bytes => value += bytes); socket.on('end', () => done(value));
      });
      assert.equal(received, payload);
      result.ipc.push({ directory, logicalPathBytes: Buffer.byteLength(path.join(directory, address)), address, addressBytes: Buffer.byteLength(address), payload: received });
    } finally {
      if (server.listening) await new Promise(done => server.close(done));
      await fs.rm(address, { force: true }); process.chdir(old);
    }
  }
  assert.ok(!process.env.TMUX && !process.env.TMUX_PANE);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const kind of ['default', 'named']) {
    const prefix = kind === 'named' ? ['-L', `z4044-${actor}`] : [];
    const execute = args => spawnSync('tmux', [...prefix, ...args], { env: process.env, encoding: 'utf8', timeout: deadline });
    const good = r => { assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    let started = false, address, identity;
    const output = path.join(own, `live-${kind}.payload`);
    try {
      good(execute(['-f', '/dev/null', 'new-session', '-d', '-s', 'z4044', '/bin/sh'])); started = true;
      address = good(execute(['display-message', '-p', '#{socket_path}']));
      assert.ok(Buffer.byteLength(address) <= 107);
      identity = await fs.lstat(address); assert.ok(identity.isSocket()); assert.equal(identity.uid, process.getuid());
      const command = [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1],process.argv[2])", output, payload].map(quote).join(' ');
      good(execute(['send-keys', '-t', 'z4044', '-l', command])); good(execute(['send-keys', '-t', 'z4044', 'Enter']));
      const end = Date.now() + deadline;
      while (true) {
        try { assert.equal(await fs.readFile(output, 'utf8'), payload); break; }
        catch (error) { if (error.code !== 'ENOENT' || Date.now() >= end) throw error; await delay(config.pollMs); }
      }
      result.tmux.push({ kind, address, addressBytes: Buffer.byteLength(address), payload });
    } finally { if (started) good(execute(['kill-server'])); }
    const listed = execute(['list-sessions']);
    assert.equal(listed.error, undefined); assert.equal(listed.signal, null); assert.equal(listed.status, 1); assert.equal(listed.stdout.trim(), '');
    assert.ok([`no server running on ${address}`, `error connecting to ${address} (No such file or directory)`].includes(listed.stderr.trim()));
    let residual;
    try { residual = await fs.lstat(address); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (residual) {
      assert.ok(residual.isSocket());
      for (const field of ['dev', 'ino', 'uid']) assert.equal(residual[field], identity[field]);
      await fs.unlink(address);
    }
    await assert.rejects(fs.lstat(address), { code: 'ENOENT' });
    await fs.unlink(output); result.tmux.at(-1).cleaned = true;
  }
  return result;
}
