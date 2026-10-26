import { openSync, closeSync, fstatSync, readSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let [source, destination, mode] = process.argv.slice(2);
if (mode === '--next') {
  const parent = source;
  const existing = new Set(readdirSync(parent));
  let next;
  while (!next) {
    next = readdirSync(parent).find(name => name.startsWith('capture-') && !existing.has(name));
    if (!next) await delay(10);
  }
  source = join(parent, next);
}
const names = ['stdout', 'stderr', 'result.json'];
const descriptors = names.map(name => openSync(join(source, name), 'r'));
const read = fd => {
  const bytes = Buffer.alloc(fstatSync(fd).size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!count) throw new Error('Incomplete captured file');
    offset += count;
  }
  return bytes;
};
try {
  let manifest;
  while (!manifest) {
    try { manifest = JSON.parse(read(descriptors[2]).toString()); }
    catch { await delay(100); }
  }
  const [stdout, stderr, result] = descriptors.map(read);
  if (stdout.length !== manifest.stdoutBytes || stderr.length !== manifest.stderrBytes) throw new Error('Captured stream length mismatch');
  const parsed = JSON.parse(stdout.toString());
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'stdout.json'), stdout);
  writeFileSync(join(destination, 'stderr.txt'), stderr);
  writeFileSync(join(destination, 'cli-result.json'), result);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(destination, 'delivery.json'), JSON.stringify({
    source,
    method: 'Read-only descriptors opened during own command; copy complete streams after capture manifest publication, including after replay unlink.',
    cliCode: manifest.code,
    childExitCode: parsed.exitCode,
    stdoutBytes: stdout.length,
    stdoutSha256: hash(stdout),
    stderrBytes: stderr.length,
    stderrSha256: hash(stderr),
    captureResultSha256: hash(result),
    runId: parsed.runId,
    project: parsed.project,
    phase: parsed.phase,
    group: parsed.group,
    selection: parsed.selection,
    limitation: 'Installed capture manifest contains code and lengths; independent hashes attest the copied streams.'
  }, null, 2) + '\n');
  console.log(JSON.stringify({ destination, runId: parsed.runId, outcome: parsed.outcome, cliCode: manifest.code, childExitCode: parsed.exitCode, timeoutCount: parsed.timeoutCount, groupState: parsed.groupState, nextAction: parsed.nextAction, counts: Object.fromEntries(['passed', 'knownRed', 'unexecuted', 'unknown'].map(key => [key, parsed[key]?.length])) }));
} finally {
  descriptors.forEach(closeSync);
}
