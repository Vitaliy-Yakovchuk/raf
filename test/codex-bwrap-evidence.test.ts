import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { traceEvidence } from './helpers/z404-trace-evidence.ts';
import { prepareHostTmuxEndpoint } from './helpers/z4044-host-tmux.mjs';
import { configureLiveCodexTrust } from './helpers/z4044-live-trust.mjs';

const helper = '/tmp/own/bwrap';
const filter = '/tmp/own/network.bpf';

test('[Z.404 E09] live fixture keeps alias parents private under inherited group-write umask, including subprocesses', () => {
  const module = new URL('./helpers/z4044-live-permissions.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
    import { spawnSync } from 'node:child_process';
    import { setPrivateLiveUmask } from ${JSON.stringify(module)};
    process.umask(0o002); setPrivateLiveUmask();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z4044-mode-'));
    try {
      const direct = path.join(root, 'qa'); fs.mkdirSync(direct);
      const child = path.join(root, 'worktree-qa');
      const result = spawnSync(process.execPath, ['-e', 'require("node:fs").mkdirSync(process.argv[1])', child], { encoding: 'utf8' });
      if (result.status !== 0) throw Error(result.stderr || result.error);
      console.log(JSON.stringify([direct, child].map(file => fs.statSync(file).mode & 0o022)));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), [0, 0], 'direct and inherited subprocess dirs satisfy the unchanged runtime alias parent guard');
});

test('[Z.404 E08] live trust survives Codex dotted-key splitting for mktemp paths and pins the quota cwd', () => {
  const root = '/tmp/z4044c-live2.fJPF5N/"owned"/root';
  const configuration = { runnerProtocols: [{ runner: 'codex', baseArgs: [], quota: { args: ['--sandbox', 'read-only'] } }] };
  const trust = configureLiveCodexTrust(configuration, root);
  assert.equal(trust.overrides.length, 1, 'one top-level TOML projects table; quoted paths cannot be CLI dotted keys');
  const separator = trust.overrides[0].indexOf('=');
  assert.deepEqual(trust.overrides[0].slice(0, separator).split('.'), ['projects'], 'Codex splits the override key literally at every dot');
  const value = trust.overrides[0].slice(separator + 1);
  assert.equal(value, '{' + trust.gitRoots.map(directory => `${JSON.stringify(directory)}={trust_level="trusted"}`).join(',') + '}');
  assert.equal(trust.quotaCwd, root + '/raf-main');
  assert.deepEqual(configuration.runnerProtocols[0].quota.args.slice(-2), ['-C', trust.quotaCwd], 'effective quota cwd is an exact registered Git root, independent of tmux respawn cwd');
});

test('[Z.404 E07] live fixture supplies scoped trust to both real quota probe and workers without changing their policies', () => {
  const root = '/tmp/own isolated/"stand"/root';
  const configuration = { runnerProtocols: [
    { runner: 'codex', executable: 'codex', baseArgs: ['--no-daemon', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'], quota: { args: ['--model', 'assigned-quota-model', '--sandbox', 'read-only'], env: { TZ: 'UTC' } }, modelFlag: '--model', effortFlag: '-c' },
    { runner: 'claude', baseArgs: ['unchanged'], quota: { args: ['unchanged'] } },
  ] };
  const before = structuredClone(configuration);
  const gitRoots = [root, ...['raf-main', 'raf-develop', 'raf-hotfix'].map(name => root + '/' + name)];
  const overrides = ['projects={' + gitRoots.map(directory => `${JSON.stringify(directory)}={trust_level="trusted"}`).join(',') + '}'];
  const quotaCwd = root + '/raf-main';
  const args = overrides.flatMap(value => ['-c', value]);
  const trust = configureLiveCodexTrust(configuration, root);
  assert.deepEqual(configuration.runnerProtocols[0].quota.args, [...before.runnerProtocols[0].quota.args, ...args, '-C', quotaCwd], 'quota must not depend on persisting trust to the shared CODEX_HOME');
  assert.deepEqual(configuration.runnerProtocols[0].baseArgs, [...before.runnerProtocols[0].baseArgs, ...args], 'workers use the same owned Git roots');
  assert.deepEqual(trust, { gitRoots, overrides, quotaCwd });
  const restored = structuredClone(configuration);
  restored.runnerProtocols[0].baseArgs = before.runnerProtocols[0].baseArgs;
  restored.runnerProtocols[0].quota.args = before.runnerProtocols[0].quota.args;
  assert.deepEqual(restored, before, 'model, effort, executable, sandbox, env and other runners retain their configured values');
});

test('[Z.404 E05] registered host tmux control survives absence and closure of worker sessions', () => {
  const endpoint = '/tmp/own-stand/.raf/tmp/tmux/server.sock';
  const sessions = new Set<string>();
  const execute = (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ['-S', endpoint]);
    if (args.includes('new-session')) {
      const name = args[args.indexOf('-s') + 1];
      assert.ok(name && name !== 'worker', 'host owns a separate sentinel session');
      sessions.add(name);
    }
    return { cliExitCode: sessions.size ? 0 : 1, stderr: sessions.size ? '' : `no server running on ${endpoint}\n` };
  };
  const sentinel = prepareHostTmuxEndpoint(endpoint, execute);
  assert.ok(sessions.has(sentinel.session), 'service start need not create a tmux server');
  sessions.add('worker'); sessions.delete('worker');
  assert.equal(execute(['-S', endpoint, 'list-sessions']).cliExitCode, 0, 'last worker exit must not invalidate the host deny control');
});

test('[Z.404 E06] host tmux control cannot pass when sentinel creation fails', () => {
  assert.throws(() => prepareHostTmuxEndpoint('/tmp/own-stand/.raf/tmp/tmux/server.sock', () => ({
    cliExitCode: 1, stderr: 'cannot create own host tmux endpoint',
  })), /cannot create own host tmux endpoint/);
});

test('[Z.404 E01] helper pathname in another execve argv is not helper execution', () => {
  const observed = traceEvidence([
    `101 execve("/usr/bin/node", ["node", "${helper}"], 0x0 /* 4 vars */) = 0`,
    `102 execve("${helper}", ["${helper}"], 0x0 /* 4 vars */) = -1 ENOENT (No such file or directory)`,
  ], helper, filter);
  assert.equal(observed.helperExecuted, false);
  assert.equal(observed.systemBwrapExecuted, false);
});

test('[Z.404 E02] O_WRONLY BPF creation and unrelated Codex seccomp do not prove RAF filter read/application', () => {
  const observed = traceEvidence([
    `101 openat(AT_FDCWD, "${filter}", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0400) = 20`,
    '102 seccomp(SECCOMP_SET_MODE_FILTER, 0, {len=34, filter=0x1234}) = 0',
    `103 openat(AT_FDCWD, "${filter}", O_RDONLY|O_CLOEXEC) = -1 EACCES (Permission denied)`,
  ], helper, filter);
  assert.equal(observed.filterRead, false);
  assert.equal(observed.seccompInstalled, true);
  assert.ok(!('rafFilterApplied' in observed), 'application requires OS behavior or linked filter evidence, never this event alone');
});

test('[Z.404 E03] exact successful execve and successful O_RDONLY remain separate observations', () => {
  assert.deepEqual(traceEvidence([
    `101 execve("${helper}", ["${helper}"], 0x0 /* 4 vars */) = 0`,
    '102 execve("/usr/bin/bwrap", ["bwrap", "--help"], 0x0 /* 4 vars */) = 0',
    `103 openat(AT_FDCWD, "${filter}", O_RDONLY|O_CLOEXEC) = 3<${filter}>`,
  ], helper, filter), {
    helperExecuted: true, systemBwrapExecuted: true, systemSandboxWithoutRafFlags: false, filterRead: true, seccompInstalled: false,
  });
});

test('[Z.404 E04] bwrap help is not the sandbox payload; inspect flags on the actual execve', () => {
  const help = '102 execve("/usr/bin/bwrap", ["bwrap", "--help"], 0x0 /* 4 vars */) = 0';
  assert.equal(traceEvidence([help], helper, filter).systemSandboxWithoutRafFlags, false);
  const sandbox = '103 execve("/usr/bin/bwrap", ["bwrap", "--ro-bind", "/", "/", "--", "/usr/bin/node"], 0x0 /* 4 vars */) = 0';
  assert.equal(traceEvidence([help, sandbox], helper, filter).systemSandboxWithoutRafFlags, true);
  assert.equal(traceEvidence([sandbox.replace('"--ro-bind"', '"--unshare-net", "--ro-bind"')], helper, filter).systemSandboxWithoutRafFlags, false);
  assert.equal(traceEvidence([sandbox.replace('"/usr/bin/node"', '"/usr/bin/node", "--unshare-net"')], helper, filter).systemSandboxWithoutRafFlags, true, 'a payload argument is not a bwrap option');
});
