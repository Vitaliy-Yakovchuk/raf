import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { alive, durable, processStart } from './hotfix-host.ts';
import { gitOutput, readGitHead, readGitMetadata } from './git.ts';

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return (await gitOutput(['--no-optional-locks', '-C', cwd, ...args], { env })).trimEnd();
}
async function commonDirectory(cwd: string) {
  const metadata = readGitMetadata(cwd);
  if (!metadata) refused('Git metadata missing: ' + cwd);
  return fs.realpath(metadata.commonDirectory);
}
async function exists(path: string) {
  return fs.lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
}
function refused(reason: string): never { throw new Error('Production Git store refused: ' + reason); }
async function canonicalDirectory(path: string) {
  if (await fs.realpath(path) !== path || !(await fs.lstat(path)).isDirectory()) refused('directory alias: ' + path);
  return path;
}

export interface ProductionStore {
  source: string;
  production: string;
  control: string;
  split: boolean;
}

interface Registration {
  version: 1;
  root: string;
  source: string;
  production: string;
  control: string;
}

async function sourceStore(root: string) {
  const configuration = JSON.parse(await fs.readFile(join(root, 'conf/projects.json'), 'utf8')).projects.raf;
  const source = await commonDirectory(resolve(root, configuration.branchPaths.develop));
  const control = join(source, 'raf-hotfix');
  return { configuration, source, control, production: join(control, 'main.git') };
}

export async function productionStorePaths(root: string): Promise<Omit<ProductionStore, 'split'>> {
  const { source, production, control } = await sourceStore(root);
  return { source, production, control };
}

export async function resolveProductionStore(root: string, main: string): Promise<ProductionStore> {
  const { source, control, production } = await sourceStore(root);
  const actual = await commonDirectory(main);
  if (actual === source) return { source, control, production: source, split: false };
  if (actual !== production) refused('main uses an unregistered Git store: ' + actual);
  return { source, control, production, split: true };
}

interface CopyIntent {
  cwd: string;
  oldDirectory: string;
  newDirectory: string;
  before: string;
  after: string;
  head: string;
  files: Record<string, { hash: string; mode: number }>;
}
interface StoreIntent extends Registration {
  copies: CopyIntent[];
  staging: string;
}

async function metadata(directory: string) {
  const files: Record<string, { hash: string; mode: number }> = {};
  const names = ['HEAD', 'index', 'config.worktree', 'ORIG_HEAD', 'logs/HEAD', ...(await fs.readdir(directory)).filter(name => name.startsWith('sharedindex.'))];
  for (const name of names) {
    const path = join(directory, name);
    if (!await exists(path)) continue;
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) refused('aliased main metadata: ' + path);
    files[name] = { hash: digest(await fs.readFile(path)), mode: stat.mode & 0o777 };
  }
  for (const name of ['index.lock', 'HEAD.lock', 'config.worktree.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await exists(join(directory, name))) refused('busy main metadata retained: ' + join(directory, name));
  }
  return files;
}

async function checkFiles(copy: CopyIntent, directory: string) {
  for (const [name, expected] of Object.entries(copy.files)) {
    const path = join(directory, name);
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== expected.mode || digest(await fs.readFile(path)) !== expected.hash) refused('main metadata changed; recovery retained: ' + path);
  }
}

async function replacePointer(copy: CopyIntent) {
  const pointer = join(copy.cwd, '.git');
  const current = await fs.readFile(pointer, 'utf8');
  if (current === copy.after) return;
  if (current !== copy.before) refused('foreign Git pointer; recovery retained: ' + pointer);
  await checkFiles(copy, copy.oldDirectory);
  const temporary = pointer + '.' + randomUUID();
  const file = await fs.open(temporary, 'wx', (await fs.stat(pointer)).mode & 0o777);
  try { await file.writeFile(copy.after); await file.sync(); } finally { await file.close(); }
  await fs.rename(temporary, pointer);
  const directory = await fs.open(copy.cwd, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function independentTree(directory: string) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) refused('shared production inode: ' + path);
    if (stat.isDirectory()) await independentTree(path);
  }
}

export async function recordProductionSandboxProtection(directories: readonly string[], policyPath: string) {
  const bytes = await fs.readFile(policyPath);
  const policy = JSON.parse(bytes.toString());
  const start = await processStart(process.pid);
  for (const control of directories) {
    if (!control.endsWith('/raf-hotfix') || policy.filesystem?.[control] !== 'read' || await fs.realpath(control) !== control) continue;
    const readers = join(control, 'readers');
    for (const name of await fs.readdir(readers).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!name.endsWith('.json')) continue;
      const path = join(readers, name), lease = JSON.parse(await fs.readFile(path, 'utf8'));
      if (lease.pid === process.pid && lease.start === start) await durable(path, { ...lease, nativeProtection: { control, policyPath, sha256: digest(bytes) } });
    }
  }
}

async function requireProtectedReaders(control: string, starter?: number) {
  const readers = join(control, 'readers');
  const start = await processStart(process.pid);
  for (const name of await fs.readdir(readers).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!name.endsWith('.json')) continue;
    const lease = JSON.parse(await fs.readFile(join(readers, name), 'utf8'));
    if (lease.pid === process.pid && lease.start === start || lease.pid === starter) continue;
    if (!await alive(lease.pid, lease.start)) continue;
    const protection = lease.nativeProtection;
    if (protection?.control !== control || typeof protection.policyPath !== 'string') refused('live reader has unknown protection; wait without terminating it');
    const bytes = await fs.readFile(protection.policyPath), policy = JSON.parse(bytes.toString());
    const within = (path: string) => path === control || path.startsWith(control + '/');
    if (digest(bytes) !== protection.sha256 || policy.filesystem?.[control] !== 'read' || Object.entries(policy.filesystem).some(([path, access]) => within(path) && access === 'write') || policy.writableFiles?.some(within)) refused('live reader has unsafe protection; wait without terminating it');
  }
}

async function syncTree(directory: string) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else { const file = await fs.open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
  }
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

export interface ProductionStoreOptions {
  root: string;
  starter?: number;
  onCheckpoint?: (phase: 'store-prepared' | 'store-pointer' | 'store-registered') => void | Promise<void>;
}

export async function ensureProductionMainStore(options: ProductionStoreOptions): Promise<ProductionStore> {
  const root = await canonicalDirectory(options.root);
  const { configuration, source, control, production } = await sourceStore(root);
  if (!await exists(join(control, 'main-store-intent.json'))) {
    const current = await resolveProductionStore(root, await fs.realpath(resolve(root, configuration.branchPaths.main)));
    if (current.split) return current;
  }
  await fs.mkdir(control, { recursive: true, mode: 0o700 });
  await canonicalDirectory(control);
  const lock = join(control, 'activation.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await fs.readFile(join(lock, 'owner.json'), 'utf8').then(JSON.parse, () => null);
    if (!owner || await alive(owner.pid, owner.start)) refused('writer barrier busy; existing lock retained');
    await fs.rm(lock, { recursive: true });
    await fs.mkdir(lock, { mode: 0o700 });
  }
  try {
    await durable(join(lock, 'owner.json'), { pid: process.pid, start: await processStart(process.pid) });
    await requireProtectedReaders(control, options.starter);
    const intentPath = join(control, 'main-store-intent.json');
    let intent: StoreIntent | null = await fs.readFile(intentPath, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
    const logical = resolve(root, configuration.branchPaths.main);
    const main = await fs.realpath(logical);
    const allowed = [logical, ...(configuration.mainCopies ?? []).map((copy: string) => resolve(root, copy))];
    if (!allowed.includes(main)) refused('unregistered main path');
    if (!intent) {
      const current = await resolveProductionStore(root, main);
      if (current.split) return current;
      if (await exists(production)) refused('foreign occupied production store');
      const copies = [main, ...(configuration.mainCopies ?? []).map((copy: string) => resolve(root, copy)).filter((copy: string) => copy !== main && copy !== logical)];
      const prepared: CopyIntent[] = [];
      for (const cwd of [...new Set<string>(copies)]) {
        if (!await exists(cwd)) continue;
        const oldDirectory = await fs.realpath(readGitMetadata(cwd)?.gitDirectory ?? join(cwd, '.git'));
        const pointer = await fs.readFile(join(cwd, '.git'), 'utf8');
        if (!pointer.startsWith('gitdir: ')) refused('registered main Git pointer required');
        const newDirectory = prepared.length ? join(production, 'worktrees', 'main-inactive') : production;
        prepared.push({ cwd, oldDirectory, newDirectory, before: pointer, after: 'gitdir: ' + relative(cwd, newDirectory) + '\n', head: readGitHead(cwd).commit ?? await git(cwd, 'rev-parse', 'HEAD'), files: await metadata(oldDirectory) });
      }
      const staging = production + '.' + randomUUID();
      intent = { version: 1, root, source, production, control, copies: prepared, staging };
      await git(root, 'clone', '--mirror', '--no-local', source, staging);
      await git(root, '--git-dir=' + staging, 'config', '--unset-all', 'remote.origin.fetch');
      await git(root, '--git-dir=' + staging, 'config', '--unset-all', 'remote.origin.mirror');
      await git(root, '--git-dir=' + staging, 'config', 'remote.origin.url', await git(main, 'remote', 'get-url', 'origin').catch(() => source));
      await git(root, '--git-dir=' + staging, 'config', 'core.bare', 'false');
      await git(root, '--git-dir=' + staging, 'config', 'core.worktree', main);
      for (const copy of prepared) {
        const records = (await git(copy.cwd, 'ls-files', '--stage', '-z')).split('\0');
        const objects = [...new Set([copy.head, ...records.flatMap(row => { const match = /^(100[0-7]{3}|120000) ([0-9a-f]+) [0-3]\t/.exec(row); return match ? [match[2]] : []; })])];
        for (let offset = 0; offset < objects.length; offset += 100) await git(root, '--git-dir=' + staging, 'fetch', '--no-tags', '--no-write-fetch-head', source, ...objects.slice(offset, offset + 100));
        const destination = copy.newDirectory === production ? staging : join(staging, relative(production, copy.newDirectory));
        for (const name of Object.keys(copy.files)) {
          await fs.mkdir(dirname(join(destination, name)), { recursive: true });
          await fs.copyFile(join(copy.oldDirectory, name), join(destination, name));
          await fs.chmod(join(destination, name), copy.files[name].mode);
        }
        if (copy.newDirectory !== production) {
          await fs.writeFile(join(destination, 'commondir'), '../..\n');
          await fs.writeFile(join(destination, 'gitdir'), join(copy.cwd, '.git') + '\n');
        }
        await checkFiles(copy, copy.oldDirectory);
      }
      await independentTree(staging);
      await syncTree(staging);
      await durable(intentPath, intent);
      await fs.rename(staging, production);
      await options.onCheckpoint?.('store-prepared');
    }
    if (intent.version !== 1 || intent.root !== root || intent.source !== source || intent.production !== production || intent.control !== control || !intent.staging.startsWith(production + '.') || dirname(intent.staging) !== control || !intent.copies.length || intent.copies.length > 2 || intent.copies.some(copy => !allowed.includes(copy.cwd) || copy.newDirectory !== production && copy.newDirectory !== join(production, 'worktrees', 'main-inactive'))) refused('recovery registration mismatch');
    if (!await exists(production)) {
      await canonicalDirectory(intent.staging);
      await independentTree(intent.staging);
      await fs.rename(intent.staging, production);
    }
    await canonicalDirectory(production);
    await independentTree(production);
    await durable(join(control, 'main-store.json'), { version: 1, root, source, production, control });
    for (const copy of intent.copies) {
      await checkFiles(copy, copy.newDirectory);
      await replacePointer(copy);
      await options.onCheckpoint?.('store-pointer');
    }
    await options.onCheckpoint?.('store-registered');
    await fs.unlink(intentPath);
    return resolveProductionStore(root, main);
  } finally { await fs.rm(lock, { recursive: true }); }
}
