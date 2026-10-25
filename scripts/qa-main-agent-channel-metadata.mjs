import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

export function negativePeerCommand(peer) {
  return ['agent', 'close', '--id', peer];
}

export async function drainStandServiceReader(options) {
  const pid = options.service.pid;
  assert.ok(Number.isInteger(pid) && pid > 0, 'The stand must own a verified host service reader');
  const start = await options.processStart(pid);
  assert.ok(start && await options.alive(pid, start), 'The host service identity must still be live before draining');
  const result = await options.request('service-before-live-split-stop', ['service', 'stop']);
  assert.equal(result.cliExitCode, 0, result.stderr || result.error);
  assert.equal(JSON.parse(result.stdout).state, 'stopped', 'The host service must acknowledge a graceful stop');
  await options.wait('host service reader exit before migration', async () => !await options.alive(pid, start));
  return { pid, start, result };
}

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
