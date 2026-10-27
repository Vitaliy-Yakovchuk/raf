import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { codexBwrapWrapper } from '../src/codex-sandbox.ts';
import { networkSandbox } from './helpers/codex-host-network.ts';

test('Codex bwrap preserves the host network namespace and native sandbox arguments', async t => {
  const { root, prepared } = await networkSandbox(t, '/bin/true');
  const recorder = join(root, 'record-bwrap');
  await writeFile(recorder, '#!/bin/sh\nexec ' + process.execPath + ' -e \'console.log(JSON.stringify(process.argv.slice(1)))\' -- "$@"\n', { mode: 0o700 });
  const wrapper = join(root, 'wrapper');
  const filter = join(prepared.policyPaths[0], 'network.bpf');
  const tmux = join(root, 'tmux');
  await writeFile(wrapper, codexBwrapWrapper(recorder, filter, tmux, []), { mode: 0o700 });
  const native = ['--ro-bind', '/', '/', '--', '/bin/true'];
  const result = spawnSync(wrapper, native, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout);
  assert.equal(args.includes('--unshare-net'), false, 'DNS and TCP must use the host network namespace');
  assert.equal(args.includes('--unshare-all'), false);
  assert.equal(args[0], '--add-seccomp-fd');
  assert.deepEqual(args.slice(2), ['--ro-bind', '/', '/', '--perms', '0700', '--tmpfs', tmux, '--', '/bin/true']);
});

test('Codex network policy reports enabled networking in the host namespace', async t => {
  const { prepared } = await networkSandbox(t, '/bin/true');
  const policy = JSON.parse(await readFile(join(prepared.policyPaths[0], 'policy.json'), 'utf8'));
  assert.equal(policy.network.codex, 'enabled');
  assert.equal(policy.network.namespace, 'host');
  assert.ok(prepared.toolSandbox.args.includes('permissions.linux.network.enabled=true'));
});
