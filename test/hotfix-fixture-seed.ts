import { createHash } from 'node:crypto';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inputs = ['src', 'bin', 'scripts', 'test', 'package.json', 'package-lock.json', '.gitignore', 'node_modules'];
let fallback: string | undefined;

function cacheRoot(): string {
  if (process.env.HOTFIX_FIXTURE_CACHE) return process.env.HOTFIX_FIXTURE_CACHE;
  if (existsSync(join(tmpdir(), '.raf-test-run'))) return join(tmpdir(), 'hf-builds');
  if (!fallback) {
    fallback = mkdtempSync(join(tmpdir(), 'hf-builds-'));
    process.once('exit', () => rmSync(fallback!, { recursive: true, force: true }));
  }
  return fallback;
}

export async function fixtureSeed(source: string, configuration: string, build: (main: string) => void): Promise<{ main: string; cache: string }> {
  const hash = createHash('sha256');
  function fingerprint(path: string, name: string, dereference = false): void {
    if (!existsSync(path)) { hash.update(JSON.stringify([name, 'absent'])); return; }
    const info = statSync(path);
    hash.update(JSON.stringify([name, info.mode & 0o777]));
    if (info.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!dereference && entry.isSymbolicLink()) hash.update(JSON.stringify([join(name, entry.name), 'symlink', readlinkSync(join(path, entry.name))]));
        else fingerprint(join(path, entry.name), join(name, entry.name), dereference);
      }
    } else hash.update(readFileSync(path));
  }
  for (const name of inputs) fingerprint(join(source, name), name, name === 'node_modules');
  if (existsSync(join(source, 'dist'))) {
    for (const name of readdirSync(join(source, 'dist')).sort()) if (name !== 'catalog.json') fingerprint(join(source, 'dist', name), join('dist', name));
  }
  fingerprint(configuration, 'conf');
  const cache = cacheRoot();
  mkdirSync(cache, { recursive: true });
  const root = join(cache, hash.digest('hex'));
  const main = join(root, 'raf-main');
  const ready = join(root, 'ready');
  const failed = join(root, 'failed');
  let creator = false;
  try { mkdirSync(root); creator = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (creator) {
    try {
      cpSync(configuration, join(root, 'conf'), { recursive: true, mode: constants.COPYFILE_FICLONE });
      mkdirSync(main);
      for (const name of [...inputs, 'dist']) {
        if (existsSync(join(source, name))) cpSync(join(source, name), join(main, name), { recursive: true, dereference: name === 'node_modules', mode: constants.COPYFILE_FICLONE });
      }
      build(main);
      writeFileSync(ready, 'ready');
    } catch (error) {
      writeFileSync(failed, String(error));
      throw error;
    }
  } else if (!existsSync(ready)) {
    await new Promise<void>((resolve, reject) => {
      const observer = watch(root, check);
      observer.on('error', error => { observer.close(); reject(error); });
      function check() {
        if (existsSync(failed)) { observer.close(); reject(new Error(readFileSync(failed, 'utf8'))); }
        else if (existsSync(ready)) { observer.close(); resolve(); }
      }
      check();
    });
  }
  return { main, cache };
}
