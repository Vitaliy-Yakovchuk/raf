import { fstatSync, lstatSync, unlinkSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

const writers = new Set<() => void>();

export function releaseOwnedWriterLocks(): void {
  for (const release of [...writers]) release();
}

export function trackOwnedWriterLock(path: string, handle: FileHandle) {
  const identity = fstatSync(handle.fd);
  let released = false;
  const ownsPath = () => {
    try {
      const current = lstatSync(path);
      return current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const release = () => {
    if (released) return;
    if (ownsPath()) unlinkSync(path);
    released = true;
    writers.delete(release);
    if (!writers.size) process.off('exit', releaseOwnedWriterLocks);
  };
  if (!writers.size) process.on('exit', releaseOwnedWriterLocks);
  writers.add(release);
  return {
    release,
    assertOwned: () => {
      if (released || !ownsPath()) throw new Error('Git writer lock ownership lost; publication cancelled');
    },
  };
}
