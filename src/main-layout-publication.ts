import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createAtomicHotfixSwitch } from './hotfix-activation.ts';
import type { MainLayoutPublicationProvider } from './main-layout.ts';

async function exchange(left: string, right: string) {
  try { await createAtomicHotfixSwitch().exchange(left, right); }
  catch (error: any) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Atomic raf-main conversion requires python3 on PATH for the existing Linux renameat2 exchange provider; install python3 before retrying start. No non-atomic fallback is available.'), { code: 'ENOTSUP' });
    const detail = String(error.stderr || error.message);
    throw Object.assign(new Error('Atomic raf-main directory publication unsupported or failed: ' + detail), { code: /EXDEV|\[Errno 18\]/.test(detail) ? 'EXDEV' : 'ENOTSUP' });
  }
}

export function nativeMainLayoutPublicationProvider(): MainLayoutPublicationProvider {
  return {
    async assertSupported(root) {
      if (process.platform !== 'linux') throw Object.assign(new Error('Atomic raf-main conversion requires a supported rename exchange provider'), { code: 'ENOTSUP' });
      if ((await fs.stat(root)).dev !== (await fs.stat(dirname(root))).dev) throw Object.assign(new Error('Atomic raf-main provider preflight requires the same filesystem as the root'), { code: 'EXDEV' });
      const probe = await fs.mkdtemp(join(dirname(root), '.raf-layout-provider-'));
      try {
        const directory = join(probe, 'directory');
        const link = join(probe, 'link');
        await fs.mkdir(directory);
        await fs.writeFile(join(directory, 'proof'), 'raf-main exchange probe');
        await fs.symlink('directory', link);
        await exchange(directory, link);
        if (!(await fs.lstat(directory)).isSymbolicLink() || !(await fs.lstat(link)).isDirectory() || await fs.readFile(join(link, 'proof'), 'utf8') !== 'raf-main exchange probe') throw new Error('Atomic raf-main exchange provider verification failed');
      } finally { await fs.rm(probe, { recursive: true, force: true }); }
    },
    async publish({ logicalPath, activePath }) {
      const target = relative(dirname(logicalPath), activePath);
      const original = await fs.lstat(logicalPath);
      if (!original.isDirectory()) throw new Error('Atomic raf-main publication expected original directory at ' + logicalPath);
      const parent = dirname(activePath);
      if ((await fs.stat(parent)).dev !== original.dev) throw Object.assign(new Error('Atomic raf-main conversion cannot cross filesystems'), { code: 'EXDEV' });
      const prepared = await fs.lstat(activePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (prepared) {
        if (!prepared.isSymbolicLink() || await fs.readlink(activePath) !== target) throw new Error('Atomic raf-main publication found a foreign prepared target at ' + activePath);
      } else await fs.symlink(target, activePath);
      const owned = await fs.lstat(activePath);
      try { await exchange(logicalPath, activePath); }
      catch (error) {
        const current = await fs.lstat(activePath);
        if (current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(activePath);
        throw error;
      }
    },
  };
}
