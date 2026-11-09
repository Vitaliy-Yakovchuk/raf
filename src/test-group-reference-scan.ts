import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

const scanner = String.raw`
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
const { paths, keys } = workerData;
const found = new Set();
const pattern = new RegExp([...keys].sort((a,b) => b.length-a.length).map(key => key.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&')).join('|'), 'g');
for (const path of paths) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { continue; }
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (!found.has(match[0])) for (const key of keys) if (match[0].includes(key)) found.add(key);
    pattern.lastIndex = match.index + 1;
  }
  if (found.size === keys.length) break;
}
parentPort.postMessage([...found]);
`;

export async function scanTestGroupReferences(files: readonly { path: string; size: number }[], keys: readonly string[]): Promise<Set<string>> {
  const count = Math.min(availableParallelism(), files.length);
  const buckets = Array.from({ length: count }, () => ({ bytes: 0, paths: [] as string[] }));
  for (const file of [...files].sort((a, b) => b.size - a.size)) {
    const bucket = buckets.reduce((left, right) => left.bytes <= right.bytes ? left : right);
    bucket.paths.push(file.path);
    bucket.bytes += file.size;
  }
  const workers = buckets.map(bucket => new Worker(scanner, { eval: true, workerData: { paths: bucket.paths, keys } }));
  try {
    const results = await Promise.all(workers.map(worker => new Promise<string[]>((resolve, reject) => {
      let received = false;
      worker.once('message', value => { received = true; resolve(value); });
      worker.once('error', reject);
      worker.once('exit', code => { if (!received) reject(new Error(`Reference scan worker exited without a result (${code})`)); });
    })));
    return new Set(results.flat());
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}
