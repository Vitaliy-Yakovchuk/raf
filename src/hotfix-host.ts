import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, watch } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { HotfixHost, HotfixWorkspace } from './hotfix-worktree.ts';
import { resolveProductionStore } from './main-production-store.ts';
import { gitOutput, readGitMetadata } from './git.ts';

const execute = promisify(execFile);
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
export async function json(path: string): Promise<any> { return JSON.parse(await fs.readFile(path, 'utf8')); }
export async function readLease(path: string): Promise<any | undefined> { return json(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }); }
export async function exists(path: string): Promise<boolean> { return fs.lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
export function environment(host: HotfixHost): NodeJS.ProcessEnv {
  const env = { ...process.env, ...host.environment, HOME: host.qaHome, RAF_QA_HOME: host.qaHome, RAF_ORCHESTRATOR_ROOT: host.orchestratorRoot };
  for (const key of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'ALLOW_MIGRATIONS'].includes(key)) delete env[key];
  return env;
}
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)) delete env[key];
  return (await gitOutput(['-C', cwd, ...args], { env })).trim();
}
export async function hostGit(host: HotfixHost, cwd: string, ...args: string[]): Promise<string> {
  return (await gitOutput(['-C', cwd, ...args], { env: environment(host) })).trim();
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
export async function mainRoute(host: HotfixHost): Promise<{ cwd: string; repositoryIdentity: string; productionDirectory: string; control: string }> {
  const root = await fs.realpath(host.orchestratorRoot);
  if (root !== resolve(host.orchestratorRoot)) throw new Error('Hotfix root must be canonical');
  const config = await json(join(root, 'conf/projects.json'));
  const path = config.projects?.raf?.branchPaths?.main;
  if (typeof path !== 'string' || config.projects.raf.path !== path) throw new Error('Registered raf main route required');
  const logical = resolve(root, path);
  const cwd = await fs.realpath(logical);
  if (cwd !== logical) {
    const copies = config.projects.raf.mainCopies;
    if (!(await fs.lstat(logical)).isSymbolicLink() || !Array.isArray(copies) || copies.length !== 2 || new Set(copies).size !== 2 || copies.some((copy: unknown) => typeof copy !== 'string' || !copy || copy.startsWith('/') || copy.split('/').some(part => ['', '.', '..', '.git'].includes(part))) || !copies.map((copy: string) => resolve(root, copy)).includes(cwd)) throw new Error('Registered main symlink layout required');
  }
  const store = await resolveProductionStore(root, cwd);
  return { cwd, repositoryIdentity: store.source, productionDirectory: store.production, control: store.control };
}
export async function validateWorkspace(host: HotfixHost, workspace: HotfixWorkspace): Promise<Awaited<ReturnType<typeof mainRoute>>> {
  const route = await mainRoute(host);
  if (workspace.orchestratorRoot !== host.orchestratorRoot || workspace.project !== 'raf' || workspace.targetBranch !== 'main' || workspace.repositoryIdentity !== route.repositoryIdentity || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspace.runId) || workspace.runId === '..') throw new Error('BRANCH_MISMATCH: hotfix repository identity mismatch');
  const expected = join(host.orchestratorRoot, '.raf-hotfix', 'runs', workspace.runId);
  const configured = await hotfixRoute(host);
  if (workspace.ownershipPath !== join(expected, 'ownership.json') || workspace.cwd !== configured.cwd || await fs.realpath(workspace.cwd) !== workspace.cwd) throw new Error('BRANCH_MISMATCH: hotfix path identity mismatch');
  return route;
}
export async function validateReleaseWorkspace(host: HotfixHost, workspace: HotfixWorkspace, source: 'hotfix' | 'develop', sourceWorkspace?: HotfixWorkspace): Promise<Awaited<ReturnType<typeof mainRoute>>> {
  if (sourceWorkspace) {
    const route = await validateReleaseWorkspace(host, sourceWorkspace, source);
    const copies = (await json(join(host.orchestratorRoot, 'conf/projects.json'))).projects?.raf?.mainCopies;
    if (!Array.isArray(copies) || !copies.map((path: string) => resolve(host.orchestratorRoot, path)).includes(workspace.cwd) || workspace.cwd === sourceWorkspace.cwd || await fs.realpath(workspace.cwd) !== workspace.cwd || workspace.project !== 'raf' || workspace.targetBranch !== 'main' || workspace.orchestratorRoot !== host.orchestratorRoot || workspace.baseCommit !== sourceWorkspace.baseCommit || workspace.runId !== sourceWorkspace.runId || workspace.repositoryIdentity !== route.repositoryIdentity || workspace.commonDirectory !== route.productionDirectory) throw new Error('BRANCH_MISMATCH: prepared main slot/source identity mismatch');
    return route;
  }
  if (source === 'hotfix') return validateWorkspace(host, workspace);
  if (source !== 'develop') throw new Error('Unknown release source');
  const route = await mainRoute(host);
  const config = await json(join(host.orchestratorRoot, 'conf/projects.json'));
  const configured = config.projects?.raf?.branchPaths?.develop;
  if (typeof configured !== 'string' || workspace.cwd !== resolve(host.orchestratorRoot, configured) || await fs.realpath(workspace.cwd) !== workspace.cwd || workspace.orchestratorRoot !== host.orchestratorRoot || workspace.project !== 'raf' || workspace.targetBranch !== 'main' || workspace.repositoryIdentity !== route.repositoryIdentity || workspace.commonDirectory !== route.repositoryIdentity || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspace.runId) || workspace.runId === '..') throw new Error('BRANCH_MISMATCH: registered develop release source required');
  return route;
}

export async function withReleaseWriter<T>(host: HotfixHost, workspace: HotfixWorkspace, source: 'hotfix' | 'develop', use: () => Promise<T>, sourceWorkspace?: HotfixWorkspace): Promise<T> {
  if (sourceWorkspace) {
    await validateReleaseWorkspace(host, workspace, source, sourceWorkspace);
    return withReleaseWriter(host, sourceWorkspace, source, () => withWriterLock(host, workspace.gitDirectory, use));
  }
  if (source === 'hotfix') return withHotfixWriter(host, use);
  await validateReleaseWorkspace(host, workspace, source);
  return withWriterLock(host, workspace.gitDirectory, use);
}

export async function hotfixRoute(host: HotfixHost): Promise<{ cwd: string; gitDirectory: string }> {
  const config = await json(join(host.orchestratorRoot, 'conf/projects.json'));
  const path = config.projects?.raf?.branchPaths?.hotfix;
  if (typeof path !== 'string' || !path.trim()) throw new Error('UNKNOWN_BRANCH: conf/projects.json#/projects/raf/branchPaths/hotfix');
  const cwd = resolve(host.orchestratorRoot, path);
  let canonical: string;
  try { canonical = await fs.realpath(cwd); if (!(await fs.stat(cwd)).isDirectory()) throw new Error('not a directory'); }
  catch (error) { throw new Error('WORKSPACE_UNAVAILABLE: ' + cwd + ': ' + String(error)); }
  if (canonical !== cwd) throw new Error('BRANCH_MISMATCH: registered hotfix worktree must be canonical');
  const metadata = readGitMetadata(cwd);
  if (!metadata) throw new Error('WORKSPACE_UNAVAILABLE: ' + cwd + ': Git metadata missing');
  return { cwd, gitDirectory: await fs.realpath(metadata.gitDirectory) };
}
interface LockOwner { pid: number; start: string; token: string }
async function claimLock(lock: string): Promise<LockOwner> {
  const prepared = lock + '.owner-' + randomUUID();
  await fs.mkdir(prepared);
  try {
    const owner: LockOwner = { pid: process.pid, start: await processStart(process.pid), token: randomUUID() };
    await durable(join(prepared, 'owner.json'), owner);
    await fs.rename(prepared, lock);
    return owner;
  } catch (error) {
    await fs.rm(prepared, { recursive: true, force: true });
    if (error.code === 'ENOTEMPTY') error.code = 'EEXIST';
    throw error;
  }
}
async function releaseLock(lock: string, owner: LockOwner): Promise<void> {
  const current = await json(join(lock, 'owner.json'));
  if (current.pid !== owner.pid || current.start !== owner.start || current.token !== owner.token) throw new Error('Hotfix lock ownership changed; existing lock retained');
  const released = lock + '.released-' + owner.token;
  await fs.rename(lock, released);
  await fs.rm(released, { recursive: true });
}
async function reclaimDeadLock(lock: string): Promise<void> {
  await execute('python3', ['-c', `import fcntl,json,os,shutil,subprocess,sys,uuid
lock=sys.argv[1]
with open(lock+'.reaper', 'a') as guard:
 fcntl.flock(guard, fcntl.LOCK_EX)
 try:
  with open(os.path.join(lock,'owner.json')) as file: owner=json.load(file)
 except FileNotFoundError: sys.exit(0)
 try:
  if owner['start'].startswith('ps:'):
   start=subprocess.check_output(['ps','-p',str(owner['pid']),'-o','lstart='],env={**os.environ,'LC_ALL':'C'},text=True).strip()
   active='ps:'+start==owner['start']
  else:
   with open('/proc/'+str(owner['pid'])+'/stat') as file: stat=file.read()
   active=stat[stat.rfind(')')+2:].split()[19]==owner['start']
 except (FileNotFoundError,subprocess.CalledProcessError): active=False
 if not active:
  stale=lock+'.stale-'+str(uuid.uuid4())
  os.rename(lock,stale)
  shutil.rmtree(stale)
`, lock]);
}
export async function withHotfixWriter<T>(host: HotfixHost, use: () => Promise<T>): Promise<T> {
  const route = await hotfixRoute(host);
  return withWriterLock(host, route.gitDirectory, use);
}
async function withWriterLock<T>(host: HotfixHost, gitDirectory: string, use: () => Promise<T>): Promise<T> {
  const lock = join(gitDirectory, 'raf-writer.lock');
  const deadline = Date.now() + await timeoutMs(host);
  let owner: LockOwner;
  for (;;) {
    try {
      owner = await claimLock(lock);
      break;
    }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await json(join(lock, 'owner.json')).catch(() => null);
      if (owner && !await alive(owner.pid, owner.start)) { await reclaimDeadLock(lock); continue; }
      if (Date.now() >= deadline) throw new Error('Hotfix writer lock timeout; coordinate writers with main');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    while (await exists(join(gitDirectory, 'index.lock'))) {
      if (Date.now() >= deadline) throw new Error('Hotfix index.lock timeout; existing lock retained');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return await use();
  } finally { await releaseLock(lock, owner); }
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
  let warned = false;
  let owner: LockOwner;
  for (;;) {
    const changed = Promise.withResolvers<void>();
    let watchError: Error | undefined;
    const watcher = watch(route.control, (_event, filename) => {
      if (filename === null || [basename(lock), 'intent.json'].includes(String(filename))) changed.resolve();
    });
    watcher.on('error', error => { watchError = error; changed.resolve(); });
    try {
      try { owner = await claimLock(lock); break; }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const holder = await json(join(lock, 'owner.json')).catch(() => null);
        if (holder && !await alive(holder.pid, holder.start)) { await reclaimDeadLock(lock); continue; }
        if (failIfBusy && await exists(join(route.control, 'intent.json'))) throw new Error('Hotfix activation busy; reader admission refused');
        const warning = setInterval(async () => {
          if (!warned) { warned = true; process.stderr.write(`Warning: hotfix activation lock still busy after ${budget} ms; waiting\n`); }
          if (holder && !await alive(holder.pid, holder.start)) changed.resolve();
        }, budget);
        try { await changed.promise; if (watchError) throw watchError; }
        finally { clearInterval(warning); }
      }
    } finally { watcher.close(); }
  }
  const keepalive = setInterval(() => {}, budget);
  try { return await use(route); } finally { clearInterval(keepalive); await releaseLock(lock, owner); }
}
export async function processStart(pid: number): Promise<string> {
  try {
    const value = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' } });
    if (!stdout.trim()) throw error;
    return 'ps:' + stdout.trim();
  }
}
export async function alive(pid: number, start: string): Promise<boolean> { return processStart(pid).then(value => value === start, () => false); }
