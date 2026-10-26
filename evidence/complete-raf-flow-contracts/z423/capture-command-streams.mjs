import { watch, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [source, target] = process.argv.slice(2);
const watchers = new Map();
const saved = new Set();
mkdirSync(target, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function inspect(directory) {
  try {
    const metadata = readFileSync(join(directory, 'result.json'));
    const manifest = JSON.parse(metadata);
    const stdout = readFileSync(join(directory, 'stdout'));
    const stderr = readFileSync(join(directory, 'stderr'));
    if (stdout.length !== manifest.stdoutBytes || stderr.length !== manifest.stderrBytes) return;
    const result = JSON.parse(stdout.toString('utf8'));
    if (result.group !== 'complete-raf-flow-contracts/z423' || saved.has(result.runId)) return;
    const prefix = `${result.phase}-${result.runId}`;
    writeFileSync(join(target, `${prefix}.stdout.json`), stdout);
    writeFileSync(join(target, `${prefix}.stderr.txt`), stderr);
    writeFileSync(join(target, `${prefix}.cli-code.txt`), `${manifest.code}\n`);
    writeFileSync(join(target, `${prefix}.capture.json`), metadata);
    writeFileSync(join(target, `${prefix}.digests.json`), JSON.stringify({ stdout: hash(stdout), stderr: hash(stderr) }, null, 2) + '\n');
    saved.add(result.runId);
    console.log(JSON.stringify({ captured: result.runId, phase: result.phase, stdoutBytes: stdout.length, stderrBytes: stderr.length, code: manifest.code }));
  } catch {}
}
function scan() {
  for (const name of readdirSync(source)) {
    if (!/^(capture|ready|replay)-/.test(name)) continue;
    const directory = join(source, name);
    if (!watchers.has(directory)) {
      try {
        watchers.set(directory, watch(directory, () => inspect(directory)));
      } catch {}
    }
    inspect(directory);
  }
}
watch(source, scan);
scan();
console.log('Watching only own command transport outputs; source files remain unchanged.');
