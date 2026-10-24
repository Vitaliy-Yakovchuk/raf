import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, lstatSync, mkdirSync, realpathSync, symlinkSync, readlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface RafTemporarySocketScope {
  readonly address: string;
  readonly cwd: string;
}

export interface RafTemporarySocketRequest {
  readonly runId: string;
  readonly directory: string;
  readonly basename: string;
  readonly serverCwd: string;
  readonly clientCwd: string;
}

export interface RafTemporarySocketEndpoint {
  readonly bind: RafTemporarySocketScope;
  readonly connect: RafTemporarySocketScope;
  readonly ownedResources: readonly string[];
  cleanup(): Promise<void>;
}

export const rafSocketRoot = () => `/tmp/raf-ipc-${process.getuid?.() ?? 0}`;
export const socketPathFits = (path: string) => !path.includes('\0') && Buffer.byteLength(path) < (process.platform === 'linux' ? 108 : 104);

function privateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('RAF socket directory must be private and owned by the current user: ' + directory);
}

export function rafSocketDirectory(directory: string, purpose: 'host' | 'tool' = 'host'): string {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new Error('Absolute socket directory required');
  privateDirectory(directory);
  const target = realpathSync(directory);
  const root = purpose === 'host' ? rafSocketRoot() : `/tmp/raf-tools-${process.getuid?.() ?? 0}`;
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  privateDirectory(root);
  const link = join(root, createHash('sha256').update(target).digest('hex').slice(0, 32));
  try { symlinkSync(target, link, 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(link);
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid?.() || readlinkSync(link) !== target || realpathSync(link) !== target) throw new Error('RAF socket alias identity mismatch');
  return link;
}

export async function releaseRafSocketDirectory(directory: string, alias: string): Promise<void> {
  const target = await fs.realpath(directory);
  const stat = await fs.lstat(alias).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return;
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await fs.readlink(alias) !== target) throw new Error('RAF socket cleanup alias identity mismatch');
  await fs.unlink(alias);
}

export async function createRafTemporarySocketEndpoint(request: RafTemporarySocketRequest): Promise<RafTemporarySocketEndpoint> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.runId) || request.runId === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.basename) || request.basename === '..' || !isAbsolute(request.serverCwd) || !isAbsolute(request.clientCwd)) throw new Error('Invalid RAF socket request');
  if (!isAbsolute(request.directory)) throw new Error('Absolute socket directory required');
  privateDirectory(request.directory);
  const directory = join(request.directory, '.ipc-' + randomUUID());
  await fs.mkdir(directory, { mode: 0o700 });
  const identity = await fs.lstat(directory);
  let alias: string | undefined;
  try {
    alias = rafSocketDirectory(directory);
    const address = join(alias, request.basename);
    if (!socketPathFits(address)) throw new Error('RAF socket pathname exceeds sun_path');
    let cleaned = false;
    return {
      bind: { address, cwd: request.serverCwd }, connect: { address, cwd: request.clientCwd }, ownedResources: [alias, directory],
      cleanup: async () => {
        if (cleaned) return;
        const current = await fs.lstat(directory);
        if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('RAF socket cleanup directory identity mismatch');
        const socketPath = join(directory, request.basename);
        const socket = await fs.lstat(socketPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (socket) {
          if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error('RAF socket cleanup encountered foreign file');
          await fs.unlink(socketPath);
        }
        await releaseRafSocketDirectory(directory, alias!);
        await fs.rmdir(directory);
        cleaned = true;
      },
    };
  } catch (error) {
    if (alias) await releaseRafSocketDirectory(directory, alias).catch(() => undefined);
    await fs.rmdir(directory).catch(() => undefined);
    throw error;
  }
}
