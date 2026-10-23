import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { HotfixHost, HotfixWorkspace } from './hotfix-worktree.ts';

const execute = promisify(execFile);
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
export async function json(path: string): Promise<any> { return JSON.parse(await fs.readFile(path, 'utf8')); }
export async function exists(path: string): Promise<boolean> { return fs.lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
export function environment(host: HotfixHost): NodeJS.ProcessEnv {
  const env = { ...process.env, ...host.environment, HOME: host.qaHome, RAF_QA_HOME: host.qaHome, RAF_ORCHESTRATOR_ROOT: host.orchestratorRoot };
  for (const key of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'ALLOW_MIGRATIONS'].includes(key)) delete env[key];
  return env;
}
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)) delete env[key];
  return (await execute('git', ['-C', cwd, ...args], { env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}
export async function hostGit(host: HotfixHost, cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-C', cwd, ...args], { env: environment(host), maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}
export async function durable(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID();
  const file = await fs.open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
  await fs.rename(temporary, path);
  const directory = await fs.open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function mainRoute(host: HotfixHost): Promise<{ cwd: string; repositoryIdentity: string; control: string }> {
  const root = await fs.realpath(host.orchestratorRoot);
  if (root !== resolve(host.orchestratorRoot)) throw new Error('Hotfix root must be canonical');
  const config = await json(join(root, 'conf/projects.json'));
  const path = config.projects?.raf?.branchPaths?.main;
  if (typeof path !== 'string' || config.projects.raf.path !== path) throw new Error('Registered raf main route required');
  const cwd = resolve(root, path);
  if (await fs.realpath(cwd) !== cwd || await git(cwd, 'rev-parse', '--show-toplevel') !== cwd || await git(cwd, 'symbolic-ref', '--short', 'HEAD') !== 'main') throw new Error('Registered main Git root required');
  const repositoryIdentity = await fs.realpath(await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  return { cwd, repositoryIdentity, control: join(repositoryIdentity, 'raf-hotfix') };
}
export async function validateWorkspace(host: HotfixHost, workspace: HotfixWorkspace): Promise<Awaited<ReturnType<typeof mainRoute>>> {
  const route = await mainRoute(host);
  if (workspace.orchestratorRoot !== host.orchestratorRoot || workspace.project !== 'raf' || workspace.targetBranch !== 'main' || workspace.repositoryIdentity !== route.repositoryIdentity || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspace.runId) || workspace.runId === '..') throw new Error('BRANCH_MISMATCH: hotfix repository identity mismatch');
  const expected = join(host.orchestratorRoot, '.raf-hotfix', 'runs', workspace.runId);
  const configured = await hotfixRoute(host);
  if (workspace.ownershipPath !== join(expected, 'ownership.json') || workspace.cwd !== configured.cwd || await fs.realpath(workspace.cwd) !== workspace.cwd) throw new Error('BRANCH_MISMATCH: hotfix path identity mismatch');
  if (await git(workspace.cwd, 'rev-parse', '--show-toplevel') !== workspace.cwd || await fs.realpath(await git(workspace.cwd, 'rev-parse', '--path-format=absolute', '--git-dir')) !== workspace.gitDirectory || await fs.realpath(await git(workspace.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== workspace.commonDirectory || workspace.commonDirectory !== route.repositoryIdentity) throw new Error('Hotfix worktree registration mismatch');
  if (await git(workspace.cwd, 'symbolic-ref', '-q', 'HEAD') !== 'refs/heads/hotfix') throw new Error('BRANCH_MISMATCH: hotfix branch required');
  const records = await git(route.cwd, 'worktree', 'list', '--porcelain');
  if (!records.split('\n\n').some(record => record.startsWith('worktree ' + workspace.cwd + '\n') && record.includes('\nbranch refs/heads/hotfix'))) throw new Error('BRANCH_MISMATCH: lost hotfix worktree registration');
  await git(workspace.cwd, 'merge-base', '--is-ancestor', workspace.baseCommit, 'HEAD');
  return route;
}
export async function hotfixRoute(host: HotfixHost): Promise<{ cwd: string; gitDirectory: string }> {
  const route = await mainRoute(host);
  const config = await json(join(host.orchestratorRoot, 'conf/projects.json'));
  const path = config.projects?.raf?.branchPaths?.hotfix;
  if (typeof path !== 'string' || !path.trim()) throw new Error('UNKNOWN_BRANCH: conf/projects.json#/projects/raf/branchPaths/hotfix');
  const cwd = resolve(host.orchestratorRoot, path);
  let canonical: string;
  try { canonical = await fs.realpath(cwd); if (!(await fs.stat(cwd)).isDirectory()) throw new Error('not a directory'); }
  catch (error) { throw new Error('WORKSPACE_UNAVAILABLE: ' + cwd + ': ' + String(error)); }
  if (canonical !== cwd || await git(cwd, 'rev-parse', '--show-toplevel') !== cwd || await git(cwd, 'symbolic-ref', '-q', 'HEAD').catch(() => '') !== 'refs/heads/hotfix' || await fs.realpath(await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== route.repositoryIdentity) throw new Error('BRANCH_MISMATCH: registered hotfix Git identity required');
  const gitDirectory = await fs.realpath(await git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir'));
  return { cwd, gitDirectory };
}
export async function withHotfixWriter<T>(host: HotfixHost, use: () => Promise<T>): Promise<T> {
  const route = await hotfixRoute(host);
  const lock = join(route.gitDirectory, 'raf-writer.lock');
  const deadline = Date.now() + await timeoutMs(host);
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Hotfix writer lock timeout; coordinate writers with main');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    while (await exists(join(route.gitDirectory, 'index.lock'))) {
      if (Date.now() >= deadline) throw new Error('Hotfix index.lock timeout; existing lock retained');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return await use();
  } finally { await fs.rmdir(lock); }
}
export async function inventory(root: string, omit = new Set(['.git', 'node_modules'])): Promise<{ path: string; sha256: string; mode: number }[]> {
  const files: { path: string; sha256: string; mode: number }[] = [];
  async function walk(directory: string) {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (directory === root && omit.has(name)) continue;
      const path = join(directory, name);
      const info = await fs.lstat(path);
      if (info.isSymbolicLink()) throw new Error('Snapshot symlink refused: ' + path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && info.nlink === 1) files.push({ path: relative(root, path), sha256: hash(await fs.readFile(path)), mode: info.mode & 0o777 });
      else throw new Error('Snapshot file alias or unsupported type: ' + path);
    }
  }
  await walk(root);
  return files;
}
export async function copyTree(source: string, target: string): Promise<void> {
  await fs.cp(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false, filter: path => !['.git', 'node_modules'].includes(relative(source, path).split(sep)[0]) });
  if (await exists(join(source, 'node_modules'))) await fs.cp(join(source, 'node_modules'), join(target, 'node_modules'), { recursive: true, dereference: true });
}
export async function timeoutMs(host: HotfixHost): Promise<number> {
  const value = (await json(join(host.orchestratorRoot, 'conf/flow.json'))).unitTests?.timeoutMs;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid conf/flow.json#/unitTests/timeoutMs');
  return value;
}
export async function command(host: HotfixHost, cwd: string, executable: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execute(executable, [...args], { cwd, env: { ...environment(host), ...extra }, timeout: await timeoutMs(host), maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, signal: null, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) { return { code: typeof error.code === 'number' ? error.code : 1, signal: error.signal ?? null, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) }; }
}
export async function locked<T>(host: HotfixHost, use: (route: Awaited<ReturnType<typeof mainRoute>>) => Promise<T>, failIfBusy = false): Promise<T> {
  const route = await mainRoute(host);
  await fs.mkdir(route.control, { recursive: true, mode: 0o700 });
  const lock = join(route.control, 'activation.lock');
  const config = await json(join(host.orchestratorRoot, 'conf/raf.json'));
  const budgets = Object.values(config.runnerProtocols ?? {}).map((entry: any) => entry.timeouts?.transitionMs).filter((value: any) => Number.isFinite(value) && value > 0) as number[];
  const budget = budgets.length ? Math.min(...budgets) : await timeoutMs(host);
  const deadline = Date.now() + budget;
  for (;;) {
    try { await fs.mkdir(lock); await durable(join(lock, 'owner.json'), { pid: process.pid, start: await processStart(process.pid) }); break; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await json(join(lock, 'owner.json')).catch(() => null);
      if (owner && !await alive(owner.pid, owner.start)) { await fs.rm(lock, { recursive: true }); continue; }
      if (failIfBusy) throw new Error('Hotfix activation busy; reader admission refused');
      if (Date.now() >= deadline) throw new Error('Hotfix activation lock timeout');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const keepalive = setInterval(() => {}, budget);
  try { return await use(route); } finally { clearInterval(keepalive); await fs.rm(lock, { recursive: true }); }
}
export async function processStart(pid: number): Promise<string> {
  const value = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
  return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
}
export async function alive(pid: number, start: string): Promise<boolean> { return processStart(pid).then(value => value === start, () => false); }
