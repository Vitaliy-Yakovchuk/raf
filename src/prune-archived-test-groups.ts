import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { gitAllowed } from './git.ts';
import { executeCommand } from './os-runtime.ts';

const subject = 'conf: agent test group registrations (auto)';
const pathspec = 'conf/test-runs.json';
const scans = new Map<string, { signature: string; referenced: string[] }>();

type GitResult = { code: number; stdout: string; stderr: string };

function safeChangeId(changeId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(changeId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function projectRecords(doc: Record<string, unknown>): Record<string, unknown>[] {
  const projects = doc.projects;
  if (!isRecord(projects)) return [];
  return Object.values(projects).filter(isRecord);
}

function groupMap(project: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(project.groups) ? project.groups : undefined;
}

function allGroupKeys(doc: Record<string, unknown>): string[] {
  return projectRecords(doc).flatMap(project => Object.keys(groupMap(project) ?? {}));
}

function changeIdOf(key: string): string | null {
  const index = key.indexOf('/');
  if (index <= 0) return null;
  const changeId = key.slice(0, index);
  return safeChangeId(changeId) ? changeId : null;
}

function prefixed(doc: Record<string, unknown>, changeIds: ReadonlySet<string>): string[] {
  return allGroupKeys(doc).filter(key => {
    const changeId = changeIdOf(key);
    return changeId !== null && changeIds.has(changeId) && key.startsWith(`${changeId}/`);
  });
}

function deleteKeys(doc: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  let changed = false;
  for (const project of projectRecords(doc)) {
    const groups = groupMap(project);
    if (!groups) continue;
    for (const key of Object.keys(groups)) {
      if (!keys.has(key)) continue;
      delete groups[key];
      changed = true;
    }
  }
  return changed;
}

function gitEnvironment(extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  if (extra?.GIT_INDEX_FILE) environment.GIT_INDEX_FILE = extra.GIT_INDEX_FILE;
  return environment;
}

async function git(root: string, args: readonly string[], extra?: Readonly<Record<string, string>>): Promise<GitResult> {
  const result = await executeCommand({ executable: 'git', args, cwd: root, environment: gitEnvironment(extra) });
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function mustGit(root: string, args: readonly string[], extra?: Readonly<Record<string, string>>): Promise<string> {
  const result = await git(root, args, extra);
  if (result.code !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr || result.stdout || result.code}`);
  return result.stdout;
}

async function insideWorkTree(root: string): Promise<boolean> {
  try {
    const result = await git(root, ['rev-parse', '--is-inside-work-tree']);
    return result.code === 0 && result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function activeChangeIds(root: string): Promise<Set<string>> {
  const directory = join(root, 'openspec', 'changes');
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return new Set(entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'archive').map(entry => entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

async function activeChangeFiles(root: string): Promise<{ path: string; mtimeMs: number; size: number }[]> {
  const found: { path: string; mtimeMs: number; size: number }[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const stat = await lstat(path);
        found.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  };
  const base = join(root, 'openspec', 'changes');
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'archive' || entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    await visit(join(base, entry.name));
  }
  return found;
}

async function referencedKeys(root: string, keys: readonly string[]): Promise<Set<string>> {
  const files = await activeChangeFiles(root);
  const signature = `${[...keys].sort().join('\n')}\n${files.map(file => `${file.path}\0${file.mtimeMs}\0${file.size}`).sort().join('\n')}`;
  const cached = scans.get(root);
  if (cached?.signature === signature) return new Set(cached.referenced);
  const found = new Set<string>();
  for (const file of files) {
    if (found.size === keys.length) break;
    let text: string;
    try { text = await readFile(file.path, 'utf8'); }
    catch { continue; }
    for (const key of keys) if (!found.has(key) && text.includes(key)) found.add(key);
  }
  scans.set(root, { signature, referenced: [...found] });
  return found;
}

async function hasSuccessfulArchive(root: string, changeId: string): Promise<boolean> {
  const directory = join(root, 'openspec', 'changes', 'archive');
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const matches = names.filter(name => name === changeId || (/^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === changeId));
  for (const name of matches) {
    try {
      const text = await readFile(join(directory, name, 'tasks.md'), 'utf8');
      const tasks = [...text.matchAll(/^\s*-\s+\[([ xX])\]\s+(.+)$/gm)];
      if (tasks.length > 0 && tasks.every(task => task[1].toLowerCase() === 'x')) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function waitForLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { await lstat(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error('Git index.lock is busy; wait before retrying');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function publishIndex(root: string, mode: string, blob: string, updateRef: () => Promise<boolean>): Promise<boolean> {
  const gitPath = (await mustGit(root, ['rev-parse', '--git-path', 'index'])).trim();
  const indexPath = isAbsolute(gitPath) ? gitPath : join(root, gitPath);
  const lockPath = `${indexPath}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (;;) {
    try { handle = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await waitForLock(lockPath);
    }
  }
  let published = false;
  const scratch = await mkdtemp(join(tmpdir(), 'raf-prune-index-'));
  try {
    const shared = join(scratch, 'index');
    try { await copyFile(indexPath, shared); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mustGit(root, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: shared });
    }
    await mustGit(root, ['update-index', '--cacheinfo', mode, blob, pathspec], { GIT_INDEX_FILE: shared });
    if (!await updateRef()) return false;
    const contents = await readFile(shared);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(lockPath, indexPath);
    published = true;
    return true;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!published) await rm(lockPath, { force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

async function commitDeletion(root: string, keys: ReadonlySet<string>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const parent = (await mustGit(root, ['rev-parse', 'HEAD'])).trim();
    const shown = await git(root, ['show', `${parent}:${pathspec}`]);
    if (shown.code !== 0) return;
    let headDoc: Record<string, unknown>;
    try { headDoc = JSON.parse(shown.stdout) as Record<string, unknown>; }
    catch { return; }
    if (!deleteKeys(headDoc, keys)) return;
    const content = `${JSON.stringify(headDoc, null, 2)}\n`;
    const identity = (await mustGit(root, ['log', '-1', '--format=%an%n%ae', parent])).trim().split('\n');
    const author = {
      GIT_AUTHOR_NAME: identity[0] ?? '',
      GIT_AUTHOR_EMAIL: identity[1] ?? '',
      GIT_COMMITTER_NAME: identity[0] ?? '',
      GIT_COMMITTER_EMAIL: identity[1] ?? '',
    };
    const scratch = await mkdtemp(join(tmpdir(), 'raf-prune-commit-'));
    try {
      const index = join(scratch, 'index');
      const blobFile = join(scratch, 'test-runs.json');
      await writeFile(blobFile, content);
      await mustGit(root, ['read-tree', parent], { GIT_INDEX_FILE: index });
      const blob = (await mustGit(root, ['hash-object', '-w', blobFile])).trim();
      const listed = (await mustGit(root, ['ls-tree', parent, '--', pathspec])).trim();
      const mode = listed.split(' ')[0];
      if (mode !== '100644' && mode !== '100755') return;
      await mustGit(root, ['update-index', '--add', '--cacheinfo', mode, blob, pathspec], { GIT_INDEX_FILE: index });
      const tree = (await mustGit(root, ['write-tree'], { GIT_INDEX_FILE: index })).trim();
      const sha = (await mustGit(root, ['commit-tree', tree, '-p', parent, '-m', subject], author)).trim();
      const published = await publishIndex(root, mode, blob, async () => {
        const result = await git(root, ['update-ref', 'HEAD', sha, parent]);
        if (result.code === 0) return true;
        const current = (await mustGit(root, ['rev-parse', 'HEAD'])).trim();
        if (current === parent) throw new Error(`Git update-ref failed: ${result.stderr || result.stdout || result.code}`);
        return false;
      });
      if (published) return;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  throw new Error('Git index.lock is busy; wait before retrying');
}

async function headDocument(root: string): Promise<Record<string, unknown> | undefined> {
  const shown = await git(root, ['show', `HEAD:${pathspec}`]);
  if (shown.code !== 0) return undefined;
  try { return JSON.parse(shown.stdout) as Record<string, unknown>; }
  catch { return undefined; }
}

async function pruneIds(root: string, changeIds: readonly string[]): Promise<void> {
  const selected = changeIds.filter(safeChangeId);
  if (!selected.length) return;
  const path = join(root, pathspec);
  let original: string;
  try { original = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(original) as Record<string, unknown>; }
  catch { return; }
  const allowGit = gitAllowed();
  if (allowGit && !await insideWorkTree(root)) return;
  const active = await activeChangeIds(root);
  const ids = new Set(selected.filter(changeId => !active.has(changeId)));
  if (!ids.size) return;
  const headDoc = allowGit ? await headDocument(root) : undefined;
  const candidates = [...new Set([...prefixed(doc, ids), ...(headDoc ? prefixed(headDoc, ids) : [])])];
  if (!candidates.length) return;
  const referenced = await referencedKeys(root, candidates);
  const deletable = new Set(candidates.filter(key => !referenced.has(key)));
  if (!deletable.size) return;
  if (deleteKeys(doc, deletable)) {
    const next = `${JSON.stringify(doc, null, 2)}\n`;
    if (next !== original) await writeAtomic(path, next);
  }
  if (headDoc && deleteKeys(headDoc, deletable)) await commitDeletion(root, deletable);
}

export async function pruneArchivedChangeTestGroups(root: string, changeId: string): Promise<void> {
  await pruneIds(root, [changeId]);
}

export async function pruneArchivedTestGroups(root: string): Promise<void> {
  if (!gitAllowed()) return;
  const path = join(root, pathspec);
  let original: string;
  try { original = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!await insideWorkTree(root)) return;
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(original) as Record<string, unknown>; }
  catch { return; }
  const active = await activeChangeIds(root);
  const headDoc = await headDocument(root);
  const ids = [...new Set([...allGroupKeys(doc), ...(headDoc ? allGroupKeys(headDoc) : [])].map(changeIdOf).filter((changeId): changeId is string => changeId !== null && !active.has(changeId)))];
  const archived: string[] = [];
  for (const changeId of ids) if (await hasSuccessfulArchive(root, changeId)) archived.push(changeId);
  if (archived.length) await pruneIds(root, archived);
}
