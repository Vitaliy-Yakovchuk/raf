import { ConfirmationBudgetExhaustedError, ConfirmationTransientError, confirmationTransient, confirmationStateTransient, readConfirmationJournal, type ConfirmationBudget } from './report-confirmation-retry.ts';
import { constants } from 'node:fs';
import { lstat, realpath, open, readFile, readdir, writeFile, mkdtemp, rm, copyFile, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { validAgentReport, type AgentReport, type AgentReportRequest } from './agent-report.ts';
import type { AssignmentSnapshot, AssignmentVerification, AssignmentIssue } from './assignment.ts';
import { executeCommand } from './os-runtime.ts';
import { trackOwnedWriterLock } from './owned-writer-lock.ts';

export interface TaskCheckboxCommit {
  readonly change: string;
  readonly item: string;
  readonly sha: string;
}

export interface TaskCheckboxConfirmation extends AssignmentVerification {
  readonly commits: readonly TaskCheckboxCommit[];
  readonly awaitingArchive: boolean;
  readonly budgetExhausted?: boolean;
  readonly transient?: 'writer-busy' | 'source-read-race' | 'index-busy';
}

export interface TaskCheckboxOperation {
  readonly runId: string;
  readonly change: string;
  readonly item: string;
  readonly originalLine: string;
  readonly parent: string;
  readonly phase: 'prepared' | 'written' | 'committed' | 'verified';
  readonly sha?: string;
}

export type TaskCheckboxCheckpoint = 'validated' | 'before-write' | 'after-write' | 'before-ref-update' | 'after-commit' | 'after-verification';

export interface TaskCheckboxPorts {
  verifyAssignmentCompletion(snapshot: AssignmentSnapshot, archiveClaims: Readonly<Record<string, string>>): Promise<AssignmentVerification>;
  readonly operations: {
    read(runId: string): Promise<readonly TaskCheckboxOperation[]>;
    write(runId: string, operations: readonly TaskCheckboxOperation[]): Promise<void>;
  };
  checkpoint?(phase: TaskCheckboxCheckpoint, item: Readonly<{ change: string; item: string }> | null): Promise<void>;
  executeGit?(args: readonly string[], options: Readonly<{ cwd: string; env?: Readonly<Record<string, string>> }>): Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;
  waitForIndex?(): Promise<void>;
  beforeWrite?(): Promise<void>;
  budget?: ConfirmationBudget;
}

export interface TaskCheckboxReportPort {
  confirmTaskCheckboxes(request: AgentReportRequest, report: AgentReport, budget?: ConfirmationBudget, beforeWrite?: () => Promise<void>): Promise<TaskCheckboxConfirmation>;
}

const queues = new Map<string, Promise<unknown>>();
const rows = (content: string) => [...content.matchAll(/^([\t ]*-\s+\[)([ xX])(\]\s+(\S+)\s+(.+?)[\t ]*)\r?$/gm)];
const checked = (line: string) => line.replace(/\[ \]/, '[x]');
const safeName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name !== '.' && name !== '..';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function prepareReportedTaskCheckboxes(request: AgentReportRequest, report: AgentReport, ports: TaskCheckboxPorts): Promise<TaskCheckboxConfirmation> {
  const previous = queues.get(request.assignment.root) ?? Promise.resolve();
  if (queues.has(request.assignment.root) && ports.budget) return { ok: false, issues: [], commits: [], awaitingArchive: false, transient: 'writer-busy' };
  const next = previous.catch(() => {}).then(() => prepare(request, report, ports));
  queues.set(request.assignment.root, next);
  try { return await next; } finally { if (queues.get(request.assignment.root) === next) queues.delete(request.assignment.root); }
}

async function prepare(request: AgentReportRequest, report: AgentReport, ports: TaskCheckboxPorts): Promise<TaskCheckboxConfirmation> {
  const commits: TaskCheckboxCommit[] = [];
  let awaitingArchive = false;
  let checkpointError: unknown;
  const checkpoint: NonNullable<TaskCheckboxPorts['checkpoint']> = async (phase, item) => {
    try { await ports.checkpoint?.(phase, item); }
    catch (error) { checkpointError = error; throw error; }
  };
  let current = { change: '', item: '' };
  const problem = (reason: string): AssignmentIssue => ({ change: current.change, requestedItems: current.item ? [current.item] : [], reason: `${current.change}:${current.item}: ${reason}`, foundItems: [], archives: [], remedy: 'Узгодьте поточний рядок, індекс і HEAD або відновіть доступ до джерела; повторіть підтвердження цього запуску.' });
  const reject = (reason: string): TaskCheckboxConfirmation => ({ ok: false, issues: [problem(reason)], commits, awaitingArchive });
  const checkBudget = () => {
    if (ports.budget && performance.now() >= ports.budget.deadline) throw new ConfirmationBudgetExhaustedError('Confirmation deadline reached before checkbox write');
  };
  if (!isAbsolute(request.assignment.root) || !safeName(request.runId) || !validAgentReport(report, request.assignment) || report.status !== 'succeeded') return reject('A valid succeeded report for the exact launch assignment is required');
  if (!request.assignment.changes.length || request.assignment.changes.some(change => !safeName(change.id) || !change.items.length)) return reject('Invalid change path');
  const archives = Object.fromEntries(report.changes.filter(change => change.archive !== undefined).map(change => [change.id, change.archive!]));
  for (const change of request.assignment.changes) {
    const claim = archives[change.id];
    if (claim !== undefined && (!safeName(claim) || (claim !== change.id && !(/^\d{4}-\d{2}-\d{2}-/.test(claim) && claim.slice(11) === change.id)) || request.assignment.baselineArchives.includes(claim))) return reject(`Invalid or pre-launch archive claim for ${change.id}`);
  }
  const root = request.assignment.root;
  const instances = new Map<string, string>();
  const environment = { ...process.env };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete environment[key];
  const git = async (args: readonly string[], env?: Readonly<Record<string, string>>) => {
    const result = ports.executeGit ? await ports.executeGit(args, { cwd: root, ...(env ? { env } : {}) }) : await executeCommand({ executable: 'git', args, cwd: root, environment: { ...environment, ...env } }).then(result => ({ code: result.exitCode, stdout: result.stdout, stderr: result.stderr }));
    if (result.code !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr || result.stdout || result.code}`);
    return result.stdout;
  };
  const lineFor = (content: string, id: string, description: string) => {
    const matches = rows(content).filter(row => row[4] === id);
    if (matches.length !== 1 || matches[0][5] !== description) throw new Error('Task ID is missing, ambiguous or its description changed');
    return matches[0];
  };
  const sourcePath = async (path: string) => {
    if (await realpath(root) !== root) throw new Error('Canonical root changed or is a symlink');
    const part = relative(root, path);
    if (part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Path outside assignment root');
    let next = root;
    for (const segment of part.split(sep)) {
      next = join(next, segment);
      const stat = await lstat(next);
      if (stat.isSymbolicLink() || !(next === path ? stat.isFile() : stat.isDirectory())) throw new Error(`Unsafe task source path: ${next}`);
      if (next === path.slice(0, path.lastIndexOf(sep))) {
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        if (instances.has(next) && instances.get(next) !== identity) throw new Error(`Task source instance changed: ${next}`);
        instances.set(next, identity);
      }
    }
  };
  const archiveSources = new Map<string, string>();
  const archiveSource = async (change: string) => {
    const known = archiveSources.get(change);
    if (known) { await sourcePath(known); return known; }
    const directory = join(root, 'openspec', 'changes', 'archive');
    const claim = archives[change];
    const candidates = claim === undefined
      ? (await readdir(directory)).filter(name => safeName(name) && !request.assignment.baselineArchives.includes(name)
        && (name === change || /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === change))
      : [claim];
    if (candidates.length !== 1) throw new Error(`Missing or ambiguous exact archive task source for ${change}`);
    const path = join(directory, candidates[0], 'tasks.md');
    await sourcePath(path);
    archiveSources.set(change, path);
    return path;
  };
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined;
  let ownership: ReturnType<typeof trackOwnedWriterLock> | undefined;
  let scratch: string | undefined;
  let unpublished: { path: string; pathspec: string; item: string; description: string; originalLine: string; dev: number; ino: number } | undefined;
  const rollback = async () => {
    if (!unpublished) return '';
    const marker = unpublished;
    ownership!.assertOwned();
    await sourcePath(marker.path);
    const headLine = lineFor(await git(['show', `HEAD:${marker.pathspec}`]), marker.item, marker.description);
    if (headLine[0] === checked(marker.originalLine)) return '; Published checkbox retained for journal/index recovery';
    if (headLine[0] !== marker.originalLine) throw new Error('Task row changed in HEAD; rollback refused');
    const handle = await open(marker.path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const pointed = await lstat(marker.path);
      if (opened.dev !== marker.dev || opened.ino !== marker.ino || opened.dev !== pointed.dev || opened.ino !== pointed.ino) throw new Error('Task file instance changed; rollback refused');
      const content = await handle.readFile('utf8');
      const row = lineFor(content, marker.item, marker.description);
      if (row[0] === marker.originalLine) return '; Uncommitted task checkbox already restored';
      if (row[0] !== checked(marker.originalLine)) throw new Error('Task row changed; rollback refused');
      await sourcePath(marker.path);
      ownership!.assertOwned();
      const currentPath = await lstat(marker.path);
      if (currentPath.dev !== opened.dev || currentPath.ino !== opened.ino || await readFile(marker.path, 'utf8') !== content) throw new Error('Task file changed before rollback; rollback refused');
      const position = Buffer.byteLength(content.slice(0, row.index! + row[1].length));
      await handle.write(Buffer.from(' '), 0, 1, position);
      await handle.sync();
      return '; Uncommitted task checkbox rolled back; adjacent edits retained';
    } finally { await handle.close(); }
  };
  try {
    for (const change of request.assignment.changes) {
      current = { change: change.id, item: change.items[0]?.id ?? '' };
      let path = join(root, 'openspec', 'changes', change.id, 'tasks.md');
      try { await sourcePath(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        path = await archiveSource(change.id);
      }
      const content = await readFile(path, 'utf8');
      for (const item of change.items) { current = { change: change.id, item: item.id }; lineFor(content, item.id, item.description); }
    }
    await checkpoint('validated', null);
    const recorded = await readConfirmationJournal(() => ports.operations.read(request.runId));
    if (!Array.isArray(recorded)) throw new Error('Invalid checkbox operation journal');
    let operations = [...recorded];
    if (operations.some(row => row.runId !== request.runId || !request.assignment.changes.some(change => change.id === row.change && change.items.some(item => item.id === row.item)))) throw new Error('Operation journal differs from launch assignment');
    const verifyCommit = async (operation: TaskCheckboxOperation, pathspec: string, description: string) => {
      if (!operation.sha || !/^[a-f0-9]+$/.test(operation.sha) || !/^[a-f0-9]+$/.test(operation.parent)) throw new Error('Missing checkbox commit provenance');
      await git(['merge-base', '--is-ancestor', operation.sha, 'HEAD']);
      const parent = (await git(['rev-parse', `${operation.sha}^`])).trim();
      if (parent !== operation.parent) throw new Error('Checkbox commit parent changed');
      const names = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', operation.sha])).trim();
      const original = await git(['show', `${parent}:${pathspec}`]);
      const row = lineFor(original, operation.item, description);
      const expected = original.slice(0, row.index!) + checked(row[0]) + original.slice(row.index! + row[0].length);
      if (row[0] !== operation.originalLine || names !== pathspec || await git(['show', `${operation.sha}:${pathspec}`]) !== expected) throw new Error('Checkbox commit is not the exact one-marker patch');
    };
    const verifyArchivedOperation = async (change: string, item: { id: string; description: string }) => {
      const operation = operations.find(row => row.change === change && row.item === item.id);
      if (!operation?.sha) throw new Error(`Missing current-run checkbox commit provenance for archived task ${change}:${item.id}`);
      const path = await archiveSource(change);
      const row = lineFor(await readFile(path, 'utf8'), item.id, item.description);
      if (row[0] !== checked(operation.originalLine)) throw new Error(`Archived task row differs from the committed checkbox: ${change}:${item.id}`);
      await verifyCommit(operation, `openspec/changes/${change}/tasks.md`, item.description);
      if (!Object.hasOwn(archives, change)) awaitingArchive = true;
      return operation;
    };
    const completed = async () => {
      if (!request.assignment.changes.every(change => change.items.every(item => operations.some(row => row.change === change.id && row.item === item.id && row.sha)))) return false;
      for (const change of request.assignment.changes) {
        const pathspec = `openspec/changes/${change.id}/tasks.md`;
        const path = join(root, pathspec);
        let content: string;
        try { await sourcePath(path); content = await readFile(path, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if ((await git(['ls-files', '--stage', '--', pathspec])).trim() || (await git(['ls-tree', 'HEAD', '--', pathspec])).trim()) return false;
          for (const item of change.items) {
            current = { change: change.id, item: item.id };
            await verifyArchivedOperation(change.id, item);
          }
          continue;
        }
        const head = await git(['show', `HEAD:${pathspec}`]);
        const staged = await git(['show', `:${pathspec}`]);
        for (const item of change.items) {
          current = { change: change.id, item: item.id };
          const operation = operations.find(row => row.change === change.id && row.item === item.id);
          if (!operation?.sha) return false;
          const headLine = lineFor(head, item.id, item.description);
          if (headLine[2].toLowerCase() !== 'x') return false;
          await verifyCommit(operation, pathspec, item.description);
          if (lineFor(content, item.id, item.description)[0] !== headLine[0]) throw new Error('Committed task row differs from index or worktree');
          const indexLine = lineFor(staged, item.id, item.description);
          if (indexLine[0] !== headLine[0]) {
            if (indexLine[0] === operation.originalLine) return false;
            throw new Error('Committed task row differs from index or worktree');
          }
        }
        const checkboxes = [...content.matchAll(/^\s*-\s+\[([ xX])\]/gm)];
        if (checkboxes.length && checkboxes.every(row => row[1].toLowerCase() === 'x')) awaitingArchive = true;
      }
      return true;
    };
    const gitDirectory = (await git(['rev-parse', '--absolute-git-dir'])).trim();
    lockPath = join(gitDirectory, 'raf-task-checkbox.lock');
    const contention = () => new ConfirmationTransientError('writer-busy', 'Task checkbox writer changed or is busy; retry confirmation');
    let contended = false;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let knownOwner = false;
      try {
        const before = await lstat(lockPath);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('Task checkbox writer has unknown ownership');
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (owner.kind !== 'raf-task-checkbox-lock' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Task checkbox writer has unknown ownership');
        knownOwner = true;
        let alive = true;
        try { process.kill(owner.pid, 0); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; alive = false; }
        const after = await lstat(lockPath);
        contended = before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.dev !== after.dev;
        if (!contended) {
          if (alive) contended = true;
          else {
            await rm(lockPath);
            try { lock = await open(lockPath, 'wx', 0o600); }
            catch (acquire) { if ((acquire as NodeJS.ErrnoException).code === 'EEXIST') throw contention(); throw acquire; }
          }
        }
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe;
        if (!knownOwner) throw contention();
        contended = true;
      }
    }
    if (contended) {
      if (await completed()) {
        for (const operation of operations) commits.push({ change: operation.change, item: operation.item, sha: operation.sha! });
        const verification = await ports.verifyAssignmentCompletion(request.assignment, archives);
        if (verification.ok) await checkpoint('after-verification', null);
        return { ...verification, commits, awaitingArchive };
      }
      throw contention();
    }
    if (!lock) throw contention();
    ownership = trackOwnedWriterLock(lockPath, lock);
    await lock.writeFile(JSON.stringify({ kind: 'raf-task-checkbox-lock', pid: process.pid }));
    await lock.sync();
    scratch = await mkdtemp(join(gitDirectory, 'raf-checkbox-'));
    const save = async (operation: TaskCheckboxOperation) => {
      operations = [...operations.filter(row => row.change !== operation.change || row.item !== operation.item), operation];
      await ports.operations.write(request.runId, operations);
    };
    const indexPathResult = (await git(['rev-parse', '--git-path', 'index'])).trim();
    const indexPath = isAbsolute(indexPathResult) ? indexPathResult : join(root, indexPathResult);
    const waitIndex = async () => {
      for (;;) {
        try { await lstat(`${indexPath}.lock`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        if (!ports.waitForIndex) throw new Error('Git index.lock is busy; wait before retrying');
        await ports.waitForIndex();
      }
    };
    const withIndexLock = async (update: (env: Readonly<Record<string, string>>) => Promise<boolean>, validatesPublication = false) => {
      let handle: Awaited<ReturnType<typeof open>>;
      for (;;) {
        try { handle = await open(`${indexPath}.lock`, 'wx', 0o600); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await waitIndex();
        }
      }
      const indexOwnership = trackOwnedWriterLock(`${indexPath}.lock`, handle);
      try {
        const sharedIndex = join(scratch!, 'shared-index');
        await copyFile(indexPath, sharedIndex);
        if (!await update({ GIT_INDEX_FILE: sharedIndex })) return false;
        if (!validatesPublication) await ports.beforeWrite?.();
        const contents = await readFile(sharedIndex);
        ownership!.assertOwned();
        indexOwnership.assertOwned();
        await handle.writeFile(contents);
        await handle.sync();
        await handle.close();
        ownership!.assertOwned();
        indexOwnership.assertOwned();
        await rename(`${indexPath}.lock`, indexPath);
        return true;
      } finally {
        try { await handle.close(); } finally { indexOwnership.release(); }
      }
    };
    const stageCheckbox = async (env: Readonly<Record<string, string>>, pathspec: string, item: string, description: string, originalLine: string) => {
      const content = await git(['show', `:${pathspec}`], env);
      const row = lineFor(content, item, description);
      if (row[0] === checked(originalLine)) return;
      if (row[0] !== originalLine) throw new Error('Task row conflict while updating shared index');
      const entry = (await git(['ls-files', '--stage', '--', pathspec], env)).trim();
      const mode = entry.split(' ')[0];
      if (!['100644', '100755'].includes(mode)) throw new Error('Tasks index entry is not a regular tracked file');
      const blobFile = join(scratch!, 'staged-tasks');
      await writeFile(blobFile, content.slice(0, row.index!) + checked(row[0]) + content.slice(row.index! + row[0].length));
      const blob = (await git(['hash-object', '-w', blobFile])).trim();
      await git(['update-index', '--cacheinfo', mode, blob, pathspec], env);
    };
    for (const change of request.assignment.changes) {
      const path = join(root, 'openspec', 'changes', change.id, 'tasks.md');
      try { await sourcePath(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        for (const item of change.items) {
          current = { change: change.id, item: item.id };
          const operation = await verifyArchivedOperation(change.id, item);
          const pathspec = `openspec/changes/${change.id}/tasks.md`;
          await withIndexLock(async env => {
            const staged = (await git(['ls-files', '--stage', '--', pathspec], env)).trim();
            const owned = (await git(['ls-tree', operation.sha!, '--', pathspec])).trim();
            const entry = owned.match(/^(\d+) blob ([a-f0-9]+)\t/);
            if (!entry || staged !== `${entry[1]} ${entry[2]} 0\t${pathspec}`) return false;
            const head = (await git(['rev-parse', 'HEAD'])).trim();
            if ((await git(['ls-tree', head, '--', pathspec])).trim()) return false;
            await git(['update-index', '--force-remove', '--', pathspec], env);
            if ((await git(['rev-parse', 'HEAD'])).trim() !== head) throw new Error('HEAD changed during archive index repair; retry confirmation');
            return true;
          });
          commits.push({ ...current, sha: operation.sha! });
        }
        continue;
      }
      const pathspec = relative(root, path).split(sep).join('/');
      for (const item of change.items) {
        current = { change: change.id, item: item.id };
        const rows = async () => {
          await sourcePath(path);
          const parent = (await git(['rev-parse', 'HEAD'])).trim();
          const head = await git(['show', `${parent}:${pathspec}`]);
          const staged = await git(['show', `:${pathspec}`]);
          const content = await readFile(path, 'utf8');
          return { parent, head, staged, headLine: lineFor(head, item.id, item.description), indexLine: lineFor(staged, item.id, item.description), workLine: lineFor(content, item.id, item.description) };
        };
        let observed = await rows();
        if (observed.headLine[2].toLowerCase() !== 'x') { await waitIndex(); observed = await rows(); }
        const { parent, head, staged, headLine, indexLine, workLine } = observed;
        let operation = operations.find(row => row.runId === request.runId && row.change === change.id && row.item === item.id);
        if (headLine[2].toLowerCase() === 'x') {
          if (workLine[0] !== headLine[0] || (indexLine[0] !== headLine[0] && !(operation && indexLine[0] === operation.originalLine))) throw new Error('Committed task row differs from index or worktree');
          if (operation?.sha) {
            await verifyCommit(operation, pathspec, item.description);
            if (indexLine[0] !== headLine[0]) await withIndexLock(async env => {
              await stageCheckbox(env, pathspec, item.id, item.description, operation!.originalLine);
              return true;
            });
            commits.push({ ...current, sha: operation.sha });
          } else if (operation) {
            const history = (await git(['log', '--format=%H', `--fixed-strings`, `--grep=raf checkbox ${request.runId} ${change.id}:${item.id}`, '--', pathspec])).trim().split('\n').filter(Boolean);
            if (history.length !== 1) throw new Error('Cannot identify the checkbox commit after interrupted ref update');
            operation = { ...operation, sha: history[0], phase: 'committed' };
            await verifyCommit(operation, pathspec, item.description);
            await save(operation);
            await withIndexLock(async env => {
              await stageCheckbox(env, pathspec, item.id, item.description, operation!.originalLine);
              return true;
            });
            commits.push({ ...current, sha: history[0] });
          }
          continue;
        }
        if (indexLine[0] !== headLine[0]) throw new Error('Task row conflict between HEAD and index');
        const ownWritten = operation && ['prepared', 'written'].includes(operation.phase) && operation.originalLine === headLine[0] && workLine[0] === checked(headLine[0]);
        if (workLine[0] !== headLine[0] && !ownWritten) throw new Error('Task row conflict between HEAD and worktree; uncommitted checkbox has unknown ownership');
        if (ownWritten) {
          const identity = await lstat(path);
          unpublished = { path, pathspec, item: item.id, description: item.description, originalLine: headLine[0], dev: identity.dev, ino: identity.ino };
        }
        operation = { runId: request.runId, ...current, originalLine: headLine[0], parent, phase: ownWritten ? 'written' : 'prepared' };
        await save(operation);
        checkBudget();
        await checkpoint('before-write', current);
        await ports.beforeWrite?.();
        await sourcePath(path);
        const latest = await readFile(path, 'utf8');
        const latestLine = lineFor(latest, item.id, item.description);
        if (latestLine[0] !== workLine[0]) throw new Error('Task row changed before write');
        if (!ownWritten) {
          const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
          try {
            const opened = await handle.stat();
            const pointed = await lstat(path);
            await sourcePath(path);
            if (opened.dev !== pointed.dev || opened.ino !== pointed.ino || await handle.readFile('utf8') !== latest) throw new Error('Task file changed before write');
            unpublished = { path, pathspec, item: item.id, description: item.description, originalLine: headLine[0], dev: opened.dev, ino: opened.ino };
            const position = Buffer.byteLength(latest.slice(0, latestLine.index! + latestLine[1].length));
            await handle.write(Buffer.from('x'), 0, 1, position);
            await handle.sync();
          } finally { await handle.close(); }
        }
        operation = { ...operation, phase: 'written' };
        await save(operation);
        await checkpoint('after-write', current);
        let commitParent = parent;
        let commitHead = head;
        for (;;) {
          const candidateLine = lineFor(commitHead, item.id, item.description);
          if (candidateLine[0] !== headLine[0]) throw new Error('Task row changed in concurrent HEAD');
          operation = { ...operation, parent: commitParent };
          await save(operation);
          const tempIndex = join(scratch, 'commit-index');
          const blobFile = join(scratch, 'tasks');
          const env = { GIT_INDEX_FILE: tempIndex };
          await git(['read-tree', commitParent], env);
          await writeFile(blobFile, commitHead.slice(0, candidateLine.index!) + checked(candidateLine[0]) + commitHead.slice(candidateLine.index! + candidateLine[0].length));
          const blob = (await git(['hash-object', '-w', blobFile])).trim();
          const entry = (await git(['ls-tree', commitParent, '--', pathspec])).trim();
          const mode = entry.split(' ')[0];
          if (!['100644', '100755'].includes(mode)) throw new Error('Tasks source is not a regular tracked file');
          await git(['update-index', '--add', '--cacheinfo', mode, blob, pathspec], env);
          const tree = (await git(['write-tree'], env)).trim();
          const sha = (await git(['commit-tree', tree, '-p', commitParent, '-m', `raf checkbox ${request.runId} ${change.id}:${item.id}`])).trim();
          checkBudget();
          await checkpoint('before-ref-update', current);
          let committed: boolean;
          try {
            committed = await withIndexLock(async indexEnv => {
              await sourcePath(path);
              const recheck = lineFor(await readFile(path, 'utf8'), item.id, item.description);
              if (recheck[0] !== checked(headLine[0])) throw new Error('Task changed before commit');
              if (await git(['show', `:${pathspec}`], indexEnv) !== staged) throw new Error('Index changed before commit');
              if ((await git(['rev-parse', 'HEAD'])).trim() !== commitParent) return false;
              await stageCheckbox(indexEnv, pathspec, item.id, item.description, headLine[0]);
              await ports.beforeWrite?.();
              checkBudget();
              await git(['update-ref', 'HEAD', sha, commitParent]);
              return true;
            }, true);
          }
          catch (error) {
            const moved = (await git(['rev-parse', 'HEAD'])).trim();
            if (moved === commitParent || moved === sha) throw error;
            commitParent = moved; commitHead = await git(['show', `${commitParent}:${pathspec}`]); continue;
          }
          if (!committed) { commitParent = (await git(['rev-parse', 'HEAD'])).trim(); commitHead = await git(['show', `${commitParent}:${pathspec}`]); continue; }
          unpublished = undefined;
          operation = { ...operation, sha, phase: 'committed' };
          await save(operation);
          commits.push({ ...current, sha });
          await checkpoint('after-commit', current);
          break;
        }
      }
      const finalContent = await readFile(path, 'utf8');
      const checkboxes = [...finalContent.matchAll(/^\s*-\s+\[([ xX])\]/gm)];
      if (checkboxes.length && checkboxes.every(row => row[1].toLowerCase() === 'x')) awaitingArchive = true;
    }
    const verification = await ports.verifyAssignmentCompletion(request.assignment, archives);
    if (!verification.ok) return { ...verification, commits, awaitingArchive };
    await checkpoint('after-verification', null);
    for (const operation of operations) if (operation.runId === request.runId && operation.sha) await save({ ...operation, phase: 'verified' });
    return { ...verification, commits, awaitingArchive };
  } catch (caught) {
    if (checkpointError === caught) throw caught;
    const error = confirmationStateTransient(caught) ?? caught;
    let recovery: string;
    try { recovery = await rollback(); }
    catch (failure) { recovery = `; Checkbox rollback failed: ${errorText(failure)}`; }
    return { ...reject(errorText(error) + recovery), ...(error instanceof ConfirmationBudgetExhaustedError ? { budgetExhausted: true } : {}), ...(confirmationTransient(error) ? { transient: error.cause } : {}) };
  }
  finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (lock) { try { await lock.close(); } finally { ownership?.release(); } }
  }
}
