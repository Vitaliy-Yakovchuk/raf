import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { endianness, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';

const linuxSunPathBytes = 108;

async function fixture() {
  const socketSyscall = new Map([['x64', 41], ['arm64', 198]]).get(process.arch);
  assert.equal(process.platform, 'linux', 'Z390 fixture requires Linux seccomp');
  assert.equal(endianness(), 'LE', 'Z390 fixture requires little-endian seccomp instructions');
  assert.ok(socketSyscall !== undefined, 'Z390 fixture supports x64/arm64 socket syscalls');
  const root = await mkdtemp('/tmp/z390-');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const accountRoot = join(home, '.raf');
  const accountHomes = [...new Set([userInfo().homedir, home])];
  assert.ok(accountHomes.every(path => path !== '/'), 'Z390 fixture requires account homes below /');
  const cwd = join(root, 'workspace');
  const shortRun = join(root, 'run');
  const shortTmp = join(root, 'tmp');
  const longBase = join(root, 'srv/dev/qa-raf-home/z331-outside-symlink/root/.git/modules/raf/raf-hotfix/generations/01234567-89ab-4cde-8f01-23456789abcd/raf-main');
  const longRun = join(longBase, 'runner/run-directory');
  const longTmp = join(longBase, 'temporary-artifacts/TMPDIR');
  const witness = join(root, 'listening.jsonl');
  const invocations = join(root, 'codex-invocations.jsonl');
  await Promise.all([bin, accountRoot, cwd, shortRun, shortTmp, longRun, longTmp].map(path => mkdir(path, { recursive: true })));
  const loadWordAbsolute = 0x20;
  const jumpEqual = 0x15;
  const returnConstant = 0x06;
  const denyWithEperm = 0x00050001;
  const allow = 0x7fff0000;
  const syscallOffset = 0;
  const firstArgumentOffset = 16;
  const afInet = 2;
  const afInet6 = 10;
  const instructions: [number, number, number, number][] = [
    [loadWordAbsolute, 0, 0, syscallOffset],
    [jumpEqual, 0, 4, socketSyscall],
    [loadWordAbsolute, 0, 0, firstArgumentOffset],
    [jumpEqual, 1, 0, afInet],
    [jumpEqual, 0, 1, afInet6],
    [returnConstant, 0, 0, denyWithEperm],
    [returnConstant, 0, 0, allow],
  ];
  const seccomp = Buffer.alloc(instructions.length * 8);
  for (const [index, [code, jumpTrue, jumpFalse, value]] of instructions.entries()) {
    seccomp.writeUInt16LE(code, index * 8);
    seccomp.writeUInt8(jumpTrue, index * 8 + 2);
    seccomp.writeUInt8(jumpFalse, index * 8 + 3);
    seccomp.writeUInt32LE(value, index * 8 + 4);
  }
  await writeFile(join(bin, 'deny-tcp.bpf'), seccomp);
  await writeFile(join(accountRoot, 'fixture-marker'), 'z390-account-root');
  await writeFile(join(bin, 'socket-witness.cjs'), `
const fs = require('node:fs');
const net = require('node:net');
for (const home of ${JSON.stringify(accountHomes)}) {
  const accountRoot = require('node:path').join(home, '.raf');
  if (fs.existsSync(accountRoot)) throw new Error('Z390 fixture account root is still visible: ' + accountRoot);
}
const originalEmit = net.Server.prototype.emit;
net.Server.prototype.emit = function(event, ...args) {
  if (event === 'listening') {
    const address = this.address();
    if (typeof address === 'string') fs.appendFileSync(${JSON.stringify(witness)}, JSON.stringify({ address }) + '\\n');
  }
  return Reflect.apply(originalEmit, this, [event, ...args]);
};
`);
  await writeFile(join(bin, 'codex'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { appendFileSync, openSync, closeSync, statSync } = require('node:fs');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const knownGlobalOptions = new Set(['--no-daemon']);
let commandIndex = 0;
while (knownGlobalOptions.has(argv[commandIndex])) commandIndex++;
const globalOptions = argv.slice(0, commandIndex);
const args = argv.slice(commandIndex);
appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ argv, globalOptions, args }) + '\\n');
const separator = args.indexOf('--');
if (args[0] !== 'sandbox' || separator < 0 || !args[separator + 1]) {
  process.stderr.write('Z390 fixture expects codex sandbox -- executable args');
  process.exit(97);
}
const filesystemKey = 'permissions.linux.filesystem=';
const filesystemConfigs = args.slice(0, separator).flatMap((arg, index) =>
  arg === '-c' && args[index + 1]?.startsWith(filesystemKey) ? [args[index + 1].slice(filesystemKey.length)] : []);
if (filesystemConfigs.length !== 1) throw new Error('Z390 fixture requires one filesystem permissions table');
const table = filesystemConfigs[0];
if (!table.startsWith('{') || !table.endsWith('}')) throw new Error('Z390 fixture requires an inline filesystem permissions table');
const body = table.slice(1, -1);
const entries = [...body.matchAll(/("(?:[^"\\\\]|\\\\.)*")=("(?:[^"\\\\]|\\\\.)*")/g)];
if (entries.map(entry => entry[0]).join(',') !== body) throw new Error('Z390 fixture cannot parse filesystem permissions');
const denied = entries.flatMap(([, key, value]) => {
  const path = JSON.parse(key);
  const access = JSON.parse(value);
  if (!['none', 'read', 'write'].includes(access)) throw new Error('Z390 fixture received an unknown filesystem access');
  if (access !== 'none') return [];
  if (!path.startsWith('/') || path === '/') throw new Error('Z390 fixture requires absolute deny paths below /');
  return [path];
});
const masks = [...${JSON.stringify(accountHomes)}];
const denyMounts = [];
for (const path of [...new Set(denied)].sort((left, right) => left.length - right.length)) {
  if (masks.some(parent => path === parent || path.startsWith(parent + '/'))) continue;
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) continue;
  denyMounts.push('--perms', '000', ...(stat.isDirectory() ? ['--tmpfs', path] : ['--ro-bind-data', '4', path]));
  masks.push(path);
}
const seccompFd = openSync(join(__dirname, 'deny-tcp.bpf'), 'r');
const emptyFd = openSync('/dev/null', 'r');
const child = spawnSync('/usr/bin/bwrap', [
  '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-net',
  '--seccomp', '3',
  '--ro-bind', '/', '/', '--bind', '/tmp', '/tmp', '--dev', '/dev', '--proc', '/proc',
  ...${JSON.stringify(accountHomes)}.flatMap(home => ['--tmpfs', home]),
  ...denyMounts,
  '--', args[separator + 1], '--require', join(__dirname, 'socket-witness.cjs'), ...args.slice(separator + 2)
], {
  stdio: ['inherit', 'inherit', 'inherit', seccompFd, emptyFd], env: process.env
});
closeSync(seccompFd);
closeSync(emptyFd);
if (child.error) { process.stderr.write('Z390 fixture requires /usr/bin/bwrap, seccomp, and user/pid/mount/network namespaces: ' + child.error.message); process.exit(98); }
if (child.status !== 0) process.stderr.write('\\nZ390 fixture isolated probe failed; /usr/bin/bwrap, seccomp, and user/pid/mount/network namespaces are required\\n');
process.exit(child.status ?? 99);
`, { mode: 0o700 });
  await symlink('/usr/bin/bwrap', join(bin, 'bwrap'));
  return { root, bin, home, accountRoot, cwd, shortRun, shortTmp, longRun, longTmp, witness, invocations };
}

const scenarios = [
  { name: 'short-path control executes the actual Unix listen probe', longRun: false, longTmp: false },
  { name: 'runDirectory exceeds sun_path while TMPDIR is short', longRun: true, longTmp: false },
  { name: 'TMPDIR exceeds sun_path while runDirectory is short', longRun: false, longTmp: true },
  { name: 'QA generation runDirectory and TMPDIR both exceed sun_path', longRun: true, longTmp: true },
] as const;

for (const scenario of scenarios) {
  test(`[Z.390] preflight: ${scenario.name}`, async () => {
    const f = await fixture();
    try {
      const runDirectory = scenario.longRun ? f.longRun : f.shortRun;
      const tmpDirectory = scenario.longTmp ? f.longTmp : f.shortTmp;
      assert.equal(await readFile(join(f.accountRoot, 'fixture-marker'), 'utf8'), 'z390-account-root');
      if (scenario.longRun) assert.ok(Buffer.byteLength(runDirectory) > linuxSunPathBytes);
      if (scenario.longTmp) assert.ok(Buffer.byteLength(tmpDirectory) > linuxSunPathBytes);
      const flow = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
      assert.ok(Number.isSafeInteger(flow.unitTests.timeoutMs) && flow.unitTests.timeoutMs > 0);
      const prepared = await prepareCodexSandbox({
        runId: 'z390-preflight',
        invocation: { executable: 'codex', args: ['--sandbox', 'workspace-write'], liveTaskVerified: false },
        scope: { hidden: [f.accountRoot], readable: [], tmuxDirectory: runDirectory, excludedCommands: [] },
        cwd: f.cwd,
        runDirectory,
        writableDirectories: [f.cwd, runDirectory, tmpDirectory],
        environment: { PATH: `${f.bin}${delimiter}${process.env.PATH ?? ''}`, HOME: f.home, TMPDIR: tmpDirectory },
        timeoutMs: flow.unitTests.timeoutMs,
      });
      try {
        const invocations = (await readFile(f.invocations, 'utf8')).trim().split('\n')
          .map(line => JSON.parse(line) as { argv: string[]; globalOptions: string[]; args: string[] });
        assert.ok(invocations.length > 0, 'preflight must invoke codex sandbox');
        for (const invocation of invocations) {
          assert.ok(invocation.globalOptions.includes('--no-daemon'), 'preflight must disable the shared Codex daemon before the sandbox subcommand');
          assert.equal(invocation.args[0], 'sandbox');
          assert.deepEqual(invocation.argv, [...invocation.globalOptions, ...invocation.args]);
        }
        const observations = (await readFile(f.witness, 'utf8')).trim().split('\n')
          .map(line => JSON.parse(line) as { address: string });
        assert.ok(observations.length > 0, 'preflight must actually listen on a Unix socket, rather than skip the probe');
        for (const { address } of observations) {
          assert.ok(Buffer.byteLength(address) < linuxSunPathBytes, 'the actual listening socket must fit Linux sun_path');
        }
      } finally {
        await prepared.cleanup();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
