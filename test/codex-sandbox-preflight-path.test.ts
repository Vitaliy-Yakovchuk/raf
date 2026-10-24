import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexSandbox } from '../src/codex-sandbox.ts';

const linuxSunPathBytes = 108;

async function fixture() {
  const root = await mkdtemp('/tmp/z390-');
  const bin = join(root, 'bin');
  const cwd = join(root, 'workspace');
  const shortRun = join(root, 'run');
  const shortTmp = join(root, 'tmp');
  const longBase = join(root, 'srv/dev/qa-raf-home/z331-outside-symlink/root/.git/modules/raf/raf-hotfix/generations/01234567-89ab-4cde-8f01-23456789abcd/raf-main');
  const longRun = join(longBase, 'runner/run-directory');
  const longTmp = join(longBase, 'temporary-artifacts/TMPDIR');
  const witness = join(root, 'listening.jsonl');
  await Promise.all([bin, cwd, shortRun, shortTmp, longRun, longTmp].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(bin, 'socket-witness.cjs'), `
const fs = require('node:fs');
const net = require('node:net');
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
const { join } = require('node:path');
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (args[0] !== 'sandbox' || separator < 0 || !args[separator + 1]) {
  process.stderr.write('Z390 fixture expects codex sandbox -- executable args');
  process.exit(97);
}
const child = spawnSync(args[separator + 1], ['--require', join(__dirname, 'socket-witness.cjs'), ...args.slice(separator + 2)], {
  stdio: 'inherit', env: process.env
});
if (child.error) { process.stderr.write(child.error.message); process.exit(98); }
process.exit(child.status ?? 99);
`, { mode: 0o700 });
  await writeFile(join(bin, 'bwrap'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  return { root, bin, cwd, shortRun, shortTmp, longRun, longTmp, witness };
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
      if (scenario.longRun) assert.ok(Buffer.byteLength(runDirectory) > linuxSunPathBytes);
      if (scenario.longTmp) assert.ok(Buffer.byteLength(tmpDirectory) > linuxSunPathBytes);
      const flow = JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
      assert.ok(Number.isSafeInteger(flow.unitTests.timeoutMs) && flow.unitTests.timeoutMs > 0);
      const prepared = await prepareCodexSandbox({
        runId: 'z390-preflight',
        invocation: { executable: 'codex', args: ['--sandbox', 'workspace-write'], liveTaskVerified: false },
        scope: { hidden: [], readable: [], tmuxDirectory: runDirectory, excludedCommands: [] },
        cwd: f.cwd,
        runDirectory,
        writableDirectories: [f.cwd, runDirectory, tmpDirectory],
        environment: { PATH: `${f.bin}${delimiter}${process.env.PATH ?? ''}`, HOME: f.root, TMPDIR: tmpDirectory },
        timeoutMs: flow.unitTests.timeoutMs,
      });
      try {
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
