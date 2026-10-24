import assert from 'node:assert/strict';
import { test } from 'node:test';
import { traceEvidence } from './helpers/z404-trace-evidence.ts';

const helper = '/tmp/own/bwrap';
const filter = '/tmp/own/network.bpf';

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
