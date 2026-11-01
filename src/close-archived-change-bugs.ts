import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BugStoreError, formatCanonicalBugKey, parseCanonicalBugKey } from './bug-store.ts';

export type CloseArchivedBugsResult = {
  closed: string[];
  skipped: { bugKey: string; active: string[] }[];
  retry: { bugKey: string; retryAfterMs: number | null }[];
  incomplete: boolean;
};

export class ArchivedBugLeaseError extends Error {
  readonly retryAfterMs: number | null;

  constructor(retryAfterMs: number | null) {
    super('lease-required');
    this.name = 'ArchivedBugLeaseError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CloseArchivedBugsPorts {
  setFixed(bugKey: string, reason: string): Promise<void>;
  commentRemaining(bugKey: string, activeChangeIds: readonly string[]): Promise<void>;
  wait(ms: number): Promise<void>;
}

export interface ArchiveBugCloseState {
  active: string[];
  archives: string[];
}

export interface ArchiveBugCloseMemory {
  read(): ArchiveBugCloseState | null;
  write(state: ArchiveBugCloseState): void;
}

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_PATTERN = /projects\/[a-z0-9][a-z0-9._-]*\/bug(?:@[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+){3})?#[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*/g;
const TASK_PATTERN = /^\s*-\s+\[([ xX])\]\s+(.+)$/gm;

export function changeIdFromArchiveName(name: string): string {
  if (!CHANGE_ID.test(name)) return '';
  const id = name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  return CHANGE_ID.test(id) ? id : '';
}

function bugKeys(text: string, into: string[]): void {
  for (const match of text.matchAll(KEY_PATTERN)) {
    try {
      const key = formatCanonicalBugKey(parseCanonicalBugKey(match[0].replace(/\.+$/, '')));
      if (!into.includes(key)) into.push(key);
    } catch { void 0; }
  }
}

async function readOwnText(path: string): Promise<string | 'missing' | 'error'> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'missing';
    if (!stat.isFile()) return 'error';
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'error';
  }
}

async function archiveTasksSuccessful(root: string, archiveName: string): Promise<boolean> {
  const text = await readOwnText(join(root, 'openspec', 'changes', 'archive', archiveName, 'tasks.md'));
  if (text === 'missing') return false;
  if (text === 'error') throw new Error(`Cannot read archived tasks for ${archiveName}`);
  const tasks = [...text.matchAll(TASK_PATTERN)];
  return tasks.length > 0 && tasks.every(task => task[1]!.toLowerCase() === 'x');
}

async function listTree(root: string): Promise<{ absent: boolean; active: string[]; archives: string[] }> {
  const changes = join(root, 'openspec', 'changes');
  let entries;
  try {
    entries = await readdir(changes, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true, active: [], archives: [] };
    throw error;
  }
  const active = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'archive').map(entry => entry.name).sort();
  let archives: string[] = [];
  try {
    const archived = await readdir(join(changes, 'archive'), { withFileTypes: true });
    archives = archived.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { absent: false, active, archives };
}

function missingBug(error: unknown): boolean {
  return error instanceof BugStoreError && (error.code === 'bug-not-found' || error.code === 'invalid-bug-key');
}

async function writeFixed(ports: CloseArchivedBugsPorts, bugKey: string, reason: string, retry: CloseArchivedBugsResult['retry']): Promise<boolean> {
  const attempt = async (): Promise<ArchivedBugLeaseError | 'done' | 'missing'> => {
    try {
      await ports.setFixed(bugKey, reason);
      return 'done';
    } catch (error) {
      if (error instanceof ArchivedBugLeaseError) return error;
      if (missingBug(error)) {
        process.emitWarning(`archived bug close skipped ${bugKey}: ${error instanceof Error ? error.message : String(error)}`);
        return 'missing';
      }
      throw error;
    }
  };
  const first = await attempt();
  if (first === 'done') return true;
  if (first === 'missing') return false;
  await ports.wait(first.retryAfterMs ?? 0);
  const second = await attempt();
  if (second === 'done') return true;
  if (second === 'missing') return false;
  retry.push({ bugKey, retryAfterMs: second.retryAfterMs });
  return false;
}

export async function closeBugsNamedByArchivedChange(root: string, changeId: string, ports: CloseArchivedBugsPorts): Promise<CloseArchivedBugsResult> {
  const empty: CloseArchivedBugsResult = { closed: [], skipped: [], retry: [], incomplete: false };
  if (!CHANGE_ID.test(changeId)) return empty;
  const archiveDir = join(root, 'openspec', 'changes', 'archive');
  let archived;
  try {
    archived = await readdir(archiveDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...empty, incomplete: true };
    return { ...empty, incomplete: true };
  }
  const folders = archived.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && changeIdFromArchiveName(entry.name) === changeId);
  const keys: string[] = [];
  for (const folder of folders) {
    let successful = false;
    try { successful = await archiveTasksSuccessful(root, folder.name); }
    catch { return { ...empty, incomplete: true }; }
    if (!successful) continue;
    for (const file of ['proposal.md', 'tasks.md']) {
      const text = await readOwnText(join(archiveDir, folder.name, file));
      if (text === 'error') return { ...empty, incomplete: true };
      if (text !== 'missing') bugKeys(text, keys);
    }
  }
  if (!keys.length) return empty;
  let entries;
  try {
    entries = await readdir(join(root, 'openspec', 'changes'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...empty, incomplete: true };
    return { ...empty, incomplete: true };
  }
  const activeByKey = new Map(keys.map(key => [key, [] as string[]]));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'archive') continue;
    const present: string[] = [];
    for (const file of ['proposal.md', 'tasks.md']) {
      const text = await readOwnText(join(root, 'openspec', 'changes', entry.name, file));
      if (text === 'error') return { ...empty, incomplete: true };
      if (text !== 'missing') bugKeys(text, present);
    }
    for (const key of present) activeByKey.get(key)?.push(entry.name);
  }
  const result: CloseArchivedBugsResult = { closed: [], skipped: [], retry: [], incomplete: false };
  for (const key of keys) {
    const active = [...new Set(activeByKey.get(key) ?? [])].sort();
    if (active.length) {
      await ports.commentRemaining(key, active);
      result.skipped.push({ bugKey: key, active });
      continue;
    }
    if (await writeFixed(ports, key, `зміна ${changeId} заархівована`, result.retry)) result.closed.push(key);
  }
  return result;
}

export async function observeArchivedChangeBugCloses(
  root: string,
  memory: ArchiveBugCloseMemory,
  close: (changeId: string) => Promise<CloseArchivedBugsResult | void>,
): Promise<void> {
  const listed = await listTree(root);
  if (listed.absent) return;
  const prior = memory.read();
  if (!prior) {
    memory.write({ active: listed.active, archives: listed.archives });
    return;
  }
  const seen = new Set(prior.archives);
  let changed = false;
  for (const name of listed.archives) {
    if (seen.has(name)) continue;
    const changeId = changeIdFromArchiveName(name);
    if (!changeId) {
      seen.add(name);
      changed = true;
      continue;
    }
    let successful = false;
    try { successful = await archiveTasksSuccessful(root, name); }
    catch (error) {
      process.emitWarning(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!successful) continue;
    let result: CloseArchivedBugsResult | void;
    try { result = await close(changeId); }
    catch (error) {
      process.emitWarning(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (result?.incomplete) continue;
    if (result?.retry?.length) process.emitWarning(`archived bug close still lease-required for ${result.retry.map(item => item.bugKey).join(', ')}`);
    seen.add(name);
    changed = true;
  }
  if (changed) memory.write({ active: listed.active, archives: [...seen].sort() });
}

export async function noteHandledChangeArchives(root: string, memory: ArchiveBugCloseMemory, changeId: string): Promise<void> {
  if (!CHANGE_ID.test(changeId)) return;
  const prior = memory.read();
  if (!prior) return;
  const listed = await listTree(root);
  if (listed.absent) return;
  const seen = new Set(prior.archives);
  let changed = false;
  for (const name of listed.archives) {
    if (seen.has(name) || changeIdFromArchiveName(name) !== changeId) continue;
    let successful = false;
    try { successful = await archiveTasksSuccessful(root, name); }
    catch { continue; }
    if (!successful) continue;
    seen.add(name);
    changed = true;
  }
  if (changed) memory.write({ active: prior.active, archives: [...seen].sort() });
}
