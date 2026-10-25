import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { cleanupFailedDeliveryEvidence, type DeliveryEvidencePorts, type PrivateDeliveryEvidence } from './delivery-evidence.ts';

const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
const storeRoot = (tmpRoot: string) => join(tmpRoot, '.delivery-evidence');

async function directory(path: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Invalid private evidence directory');
}

export function privateDeliveryEvidencePorts(tmpRoot: string, verifyIsolation: (runId: string) => Promise<void>): DeliveryEvidencePorts {
  const pathFor = (runId: string) => {
    if (!validId(runId)) throw new Error('Invalid evidence run identity');
    return join(storeRoot(tmpRoot), runId);
  };
  const verifyRoot = async (create: boolean) => {
    if (await fs.realpath(tmpRoot) !== resolve(tmpRoot)) throw new Error('Evidence root must be canonical');
    await directory(storeRoot(tmpRoot), create);
  };
  const read = async (runId: string): Promise<PrivateDeliveryEvidence | null> => {
    const path = pathFor(runId);
    try {
      await verifyRoot(false);
      await directory(path, false);
      const file = await fs.open(join(path, 'frame.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Invalid private evidence file');
        const record = JSON.parse(await file.readFile('utf8')) as PrivateDeliveryEvidence;
        if (record.runId !== runId || !validId(record.reference)) throw new Error('Evidence identity mismatch');
        return record;
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  return {
    verifyIsolation, read, newReference: randomUUID,
    putIfAbsent: async record => {
      await verifyIsolation(record.runId);
      await verifyRoot(true);
      const path = pathFor(record.runId);
      await directory(path, true);
      const temporary = join(path, randomUUID() + '.tmp');
      try {
        await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        try { await fs.link(temporary, join(path, 'frame.json')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally { await fs.rm(temporary, { force: true }); }
      const retained = await read(record.runId);
      if (!retained) throw new Error('Evidence publication unavailable');
      return retained;
    },
    remove: async (runId, reference) => {
      await verifyIsolation(runId);
      const record = await read(runId);
      if (!record) return;
      if (record.reference !== reference) throw new Error('Evidence cleanup identity mismatch');
      await fs.unlink(join(pathFor(runId), 'frame.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(pathFor(runId)).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; });
    },
  };
}

export async function cleanupExpiredDeliveryEvidence(tmpRoot: string, at: string): Promise<void> {
  let entries: string[];
  try { await directory(storeRoot(tmpRoot), false); entries = await fs.readdir(storeRoot(tmpRoot)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const ports = privateDeliveryEvidencePorts(tmpRoot, async runId => {
    if (!validId(runId)) throw new Error('Invalid evidence cleanup run');
  });
  for (const runId of entries) await cleanupFailedDeliveryEvidence(runId, at, ports);
}
