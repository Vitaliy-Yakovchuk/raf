import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function metadataTree(directory) {
  const stat = fs.lstatSync(directory);
  const entry = { mode: stat.mode, dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
  if (stat.isSymbolicLink()) return { ...entry, target: fs.readlinkSync(directory) };
  if (stat.isFile()) return { ...entry, size: stat.size, sha256: createHash('sha256').update(fs.readFileSync(directory)).digest('hex') };
  if (!stat.isDirectory()) throw Error('Unexpected metadata type: ' + directory);
  return { ...entry, children: Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, metadataTree(path.join(directory, name))])) };
}

export function capturePolicy(directories, runId, phase) {
  const audit = process.env.SYM64_AUDIT;
  if (!audit) throw Error('QA policy audit directory is required');
  const control = directories.find(directory => directory.endsWith('/raf-hotfix'));
  if (!control) throw Error('Protected control directory is required');
  const value = { runId, phase, control, production: metadataTree(path.join(control, 'main.git')) };
  const target = path.join(audit, 'policy-' + runId + '-' + phase + '.json');
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
