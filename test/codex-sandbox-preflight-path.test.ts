import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';

const linuxSunPathBytes = 108;

async function fixture() {
  assert.equal(process.platform, 'linux', 'Z390 fixture requires Linux namespaces');
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
    fs.appendFileSync(${JSON.stringify(witness)}, JSON.stringify({ address }) + '\\n');
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
  denyMounts.push('--perms', '000', ...(stat.isDirectory() ? ['--tmpfs', path] : ['--ro-bind-data', '3', path]));
  masks.push(path);
}
const emptyFd = openSync('/dev/null', 'r');
const child = spawnSync('bwrap', [
  '--die-with-parent', '--unshare-user', '--unshare-pid',
  '--ro-bind', '/', '/', '--bind', '/tmp', '/tmp', '--dev', '/dev', '--proc', '/proc',
  ...${JSON.stringify(accountHomes)}.flatMap(home => ['--tmpfs', home]),
  ...denyMounts,
  '--', args[separator + 1], '--require', join(__dirname, 'socket-witness.cjs'), ...args.slice(separator + 2)
], {
  stdio: ['inherit', 'inherit', 'inherit', emptyFd], env: process.env
});
closeSync(emptyFd);
if (child.error) { process.stderr.write('Z390 fixture requires the prepared bwrap backend: ' + child.error.message); process.exit(98); }
if (child.status !== 0) process.stderr.write('\\nZ390 fixture isolated probe failed through the prepared bwrap backend\\n');
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
          .map(line => JSON.parse(line) as { address: string | { address: string; port: number } });
        const unixObservations = observations.filter((value): value is { address: string } => typeof value.address === 'string');
        assert.ok(unixObservations.length > 0, 'preflight must actually listen on a Unix socket, rather than skip the probe');
        assert.ok(observations.some(({ address }) => typeof address === 'object' && address.address === '127.0.0.1' && address.port > 0), 'preflight must actually listen on its own loopback TCP socket under the Z.421 backend');
        for (const { address } of unixObservations) {
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
