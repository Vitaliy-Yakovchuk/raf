import { ConfirmationBudgetExhaustedError, ConfirmationTransientError } from './report-confirmation-retry.ts';
import { watch } from 'node:fs';
import { copyFile, lstat, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { executeCommand } from './os-runtime.ts';

export interface ReportCommitIndexRequest {
  repositoryRoot: string;
  commits: readonly string[];
}

export async function reconcileReportedCommitIndex(
  request: ReportCommitIndexRequest,
  control?: { deadline: number; pollMs: number; beforeWrite?: () => Promise<void> },
): Promise<void> {
  if (!request.commits.length) return;
  const environment = { ...process.env };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const git = async (args: string[], index?: string, stdin?: string) => {
    const result = await executeCommand({ executable: 'git', args, cwd: request.repositoryRoot, environment: { ...environment, ...(index ? { GIT_INDEX_FILE: index } : {}) }, stdin });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Git ${args[0]} failed`);
    return result.stdout;
  };
  const commits: string[] = [];
  for (const sha of request.commits) {
    if (!/^[a-fA-F0-9]{4,64}$/.test(sha)) throw new Error('Reported commit must be a Git object ID');
    const commit = (await git(['rev-parse', '--verify', `${sha}^{commit}`])).trim();
    if (!commits.includes(commit)) commits.push(commit);
  }
  for (let i = 1; i < commits.length; i++) await git(['merge-base', '--is-ancestor', commits[i - 1], commits[i]]);
  const parents = (await git(['rev-list', '--parents', '-n', '1', commits[0]])).trim().split(' ').slice(1);
  const baseline = parents[0] ?? (await git(['hash-object', '-t', 'tree', '--stdin'], undefined, '')).trim();
  const paths = new Set<string>();
  for (const commit of commits) {
    const parent = (await git(['rev-list', '--parents', '-n', '1', commit])).trim().split(' ')[1];
    for (const path of (await git(['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', ...(parent ? [parent, commit] : [commit])])).split('\0').filter(Boolean)) paths.add(path);
  }
  if (!paths.size) return;
  type Entry = { mode: string; oid: string };
  const tree = async (ref: string): Promise<Map<string, Entry>> => {
    const entries = new Map<string, Entry>();
    if (!parents.length && ref === baseline) return entries;
    for (const row of (await git(['ls-tree', '-r', '-z', '--full-tree', ref])).split('\0').filter(Boolean)) {
      const match = row.match(/^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/);
      if (!match) throw new Error('Invalid Git tree entry');
      if (paths.has(match[3])) entries.set(match[3], { mode: match[1], oid: match[2] });
    }
    return entries;
  };
  const base = await tree(baseline);
  const indexResult = (await git(['rev-parse', '--git-path', 'index'])).trim();
  const indexPath = isAbsolute(indexResult) ? indexResult : join(request.repositoryRoot, indexResult);
  const lockPath = `${indexPath}.lock`;
  const checkBudget = () => { if (control && performance.now() >= control.deadline) throw new ConfirmationBudgetExhaustedError('Confirmation deadline reached waiting for Git index.lock'); };
  const waitForIndex = () => control ? (async () => { checkBudget(); await new Promise(resolve => setTimeout(resolve, Math.min(control.pollMs, Math.max(0, control.deadline - performance.now())))); checkBudget(); })() : new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(indexPath), (_event, name) => {
      if (name === null || name.toString() === basename(indexPath) || name.toString() === basename(lockPath)) { watcher.close(); resolve(); }
    });
    watcher.once('error', error => { watcher.close(); reject(error); });
    void lstat(lockPath).catch(error => { watcher.close(); if (error.code === 'ENOENT') resolve(); else reject(error); });
  });
  let lock: Awaited<ReturnType<typeof open>>;
  for (;;) {
    checkBudget();
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (control) throw new ConfirmationTransientError('index-busy', 'Git index.lock is busy; retain foreign lock'); await waitForIndex(); }
  }
  let scratch: string | undefined;
  let published = false;
  try {
    scratch = await mkdtemp(join(dirname(indexPath), 'raf-report-index-'));
    const temporaryIndex = join(scratch, 'index');
    try { await copyFile(indexPath, temporaryIndex); await lock.chmod((await lstat(indexPath)).mode & 0o777); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const staged = new Map<string, Entry>();
    const conflicted = new Set<string>();
    for (const row of (await git(['ls-files', '--stage', '-z'], temporaryIndex)).split('\0').filter(Boolean)) {
      const match = row.match(/^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/);
      if (!match) throw new Error('Invalid Git index entry');
      if (match[3] !== '0') conflicted.add(match[4]);
      else staged.set(match[4], { mode: match[1], oid: match[2] });
    }
    const equal = (left: Entry | undefined, right: Entry | undefined) => left?.oid === right?.oid && left?.mode === right?.mode;
    for (;;) {
      checkBudget();
      const head = (await git(['rev-parse', 'HEAD'])).trim();
      for (const commit of commits) await git(['merge-base', '--is-ancestor', commit, head]);
      const current = await tree(head);
      let updates = '';
      for (const path of paths) {
        if (conflicted.has(path) || !equal(staged.get(path), base.get(path)) || equal(staged.get(path), current.get(path))) continue;
        const entry = current.get(path);
        updates += entry ? `${entry.mode} ${entry.oid}\t${path}\0` : `0 ${'0'.repeat(head.length)}\t${path}\0`;
      }
      if (!updates) return;
      try { await copyFile(indexPath, temporaryIndex); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await rm(temporaryIndex, { force: true }); }
      await git(['update-index', '-z', '--index-info'], temporaryIndex, updates);
      if ((await git(['rev-parse', 'HEAD'])).trim() !== head) continue;
      await control?.beforeWrite?.();
      checkBudget();
      if ((await git(['rev-parse', 'HEAD'])).trim() !== head) continue;
      await lock.writeFile(await readFile(temporaryIndex));
      await lock.sync();
      await lock.close();
      await rename(lockPath, indexPath);
      published = true;
      return;
    }
  } finally {
    await lock.close();
    if (!published) await rm(lockPath, { force: true });
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
