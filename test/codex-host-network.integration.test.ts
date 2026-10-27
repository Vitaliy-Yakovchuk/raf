import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { readFile, readlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { networkSandbox } from './helpers/codex-host-network.ts';

test('real Codex sandbox resolves example.com, connects externally and reaches host TCP with truthful policy', async t => {
  const { cwd, prepared } = await networkSandbox(t, 'codex');
  const hostNamespace = await readlink('/proc/self/ns/net');
  const addresses = await lookup('example.com', { all: true });
  assert.ok(addresses.length > 0, 'host DNS prerequisite');
  const external = createConnection({ host: 'example.com', port: 80 });
  try { await once(external, 'connect'); } finally { external.destroy(); }
  const server = createServer(socket => socket.end('host-network-ok'));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const script = `
    import {lookup} from 'node:dns/promises';
    import {readlink} from 'node:fs/promises';
    import {createConnection} from 'node:net';
    import {once} from 'node:events';
    const connect=async options=>{
      const socket=createConnection(options);
      try { await once(socket,'connect'); return socket.remoteAddress; }
      finally { socket.destroy(); }
    };
    const namespace=await readlink('/proc/self/ns/net');
    const dns=await lookup('example.com',{all:true});
    const external=await connect({host:'example.com',port:80});
    const host=await connect({host:'127.0.0.1',port:Number(process.argv[1])});
    process.stdout.write(JSON.stringify({namespace,dns,external,host}));
  `;
  const child = spawn(prepared.toolSandbox.executable, [...prepared.toolSandbox.args, process.execPath, '--input-type=module', '-e', script, String(address.port)], { cwd, env: { ...prepared.environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  const observation = JSON.parse(stdout);
  assert.equal(observation.namespace, hostNamespace);
  assert.ok(observation.dns.length > 0);
  assert.ok(observation.external);
  assert.equal(observation.host, '127.0.0.1');
  const policy = JSON.parse(await readFile(join(prepared.policyPaths[0], 'policy.json'), 'utf8'));
  assert.equal(policy.network.codex, 'enabled');
  assert.equal(policy.network.namespace, 'host');
  t.diagnostic(JSON.stringify({ hostNamespace, observation, networkPolicy: policy.network }));
});
