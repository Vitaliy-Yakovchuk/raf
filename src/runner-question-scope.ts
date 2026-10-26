import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function runnerQuestionReadDenials(root: string, writable: readonly string[], workspace?: string): Promise<string[]> {
  const within = (parent: string, path: string) => {
    const suffix = relative(parent, path);
    return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
  };
  const allowed = await Promise.all(writable.map(async path => {
    try { return await fs.realpath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return resolve(path);
    }
  }));
  const hidden: string[] = [];
  const cwd = workspace && await fs.realpath(workspace);
  const visit = async (path: string): Promise<void> => {
    const info = await fs.lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    if (!info || allowed.some(boundary => within(boundary, path))) return;
    if (info.isDirectory() && (allowed.some(boundary => within(path, boundary)) || cwd && within(cwd, path))) {
      for (const name of (await fs.readdir(path)).sort()) await visit(join(path, name));
    } else hidden.push(path);
  };
  await visit(join(await fs.realpath(root), 'questions'));
  return hidden;
}
