import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { alive, durable, processStart } from './hotfix-host.ts';
import { nativeMainLayoutPublicationProvider } from './main-layout-publication.ts';
import { ensureProductionMainStore, productionStorePaths, resolveProductionStore } from './main-production-store.ts';

export interface MainLayoutProject {
  path: string;
  profile: string;
  branchPaths: Readonly<Record<string, string>>;
  mainCopies?: readonly string[];
  usesSharedLibs?: boolean;
}

export type MainLayoutCheckpoint =
  | 'intent-durable'
  | 'original-relocated'
  | 'git-relocated'
  | 'link-published';

export interface MainLayoutPublication {
  root: string;
  logicalPath: string;
  activePath: string;
  intentPath: string;
}

export interface MainLayoutPublicationProvider {
  assertSupported(root: string): Promise<void>;
  publish(publication: MainLayoutPublication): Promise<void>;
}

export interface MainLayoutStartOptions {
  root: string;
  projects: Readonly<Record<string, MainLayoutProject>>;
  publicationProvider?: MainLayoutPublicationProvider;
  onCheckpoint?: (
    checkpoint: MainLayoutCheckpoint,
    publication: MainLayoutPublication,
  ) => void | Promise<void>;
}

export interface MainLayoutStartResult {
  status: 'converted' | 'unchanged' | 'recovered';
  activePath: string;
  inactivePath: string;
}

export interface MainLayoutPathInspection {
  kind: 'missing' | 'directory' | 'file' | 'symlink' | 'cycle';
  canonicalPath: string | null;
}

export interface MainLayoutFileIdentity {
  relativePath: string;
  canonicalPath: string;
  device: number;
  inode: number;
}

export interface MainLayoutRepositoryInspection {
  identity: string;
  sourceIdentity?: string;
  head: string;
  branch: string | null;
  files: readonly MainLayoutFileIdentity[];
}

export interface MainLayoutGitRegistration {
  modulePath: string;
  gitlinkPath: string;
  gitlinkHead: string;
  logicalMode: '160000' | '120000';
}

export interface MainLayoutProbe {
  inspectPath(path: string): Promise<MainLayoutPathInspection>;
  inspectRepository(path: string): Promise<MainLayoutRepositoryInspection | null>;
  inspectGitRegistration(root: string): Promise<MainLayoutGitRegistration>;
}

export interface MainLayoutValidationOptions {
  root: string;
  projects: Readonly<Record<string, MainLayoutProject>>;
  probe: MainLayoutProbe;
}

export interface MainLayoutValidationResult {
  state: 'legacy' | 'ready';
  activePath: string;
  inactivePath: string;
}


const execute = promisify(execFile);
const within = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function refuse(message: string): never {
  throw new Error('Main layout expected safe canonical raf mainCopies and consistent Git registration; actual: ' + message);
}

function configuredPaths(root: string, projects: MainLayoutStartOptions['projects']) {
  if (!isAbsolute(root) || resolve(root) !== root) refuse(`expected canonical absolute root; received ${root}`);
  for (const [id, project] of Object.entries(projects)) {
    if (id !== 'raf' && project.mainCopies !== undefined) refuse(`mainCopies is supported only for raf; received projects.${id}.mainCopies`);
  }
  const raf = projects.raf;
  if (!raf || raf.path !== 'raf-main' || raf.branchPaths?.main !== 'raf-main') refuse('projects.raf.path and branchPaths.main must both be raf-main');
  if (!Array.isArray(raf.mainCopies) || raf.mainCopies.length !== 2) refuse('projects.raf.mainCopies must contain exactly two different physical paths');
  const physical = raf.mainCopies.map(path => {
    if (typeof path !== 'string' || !path || path !== path.trim() || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => ['', '.', '..', '.git'].includes(part))) refuse(`unsafe mainCopies path: ${String(path)}; expected relative path inside ${root}`);
    return resolve(root, path);
  });
  const logical = join(root, 'raf-main');
  if (overlaps(physical[0], physical[1]) || physical.some(path => overlaps(path, logical))) refuse('mainCopies paths must be different and must not overlap raf-main or one another');
  const protectedPaths: string[] = [];
  for (const [id, project] of Object.entries(projects)) {
    for (const path of new Set([project.path, ...Object.values(project.branchPaths ?? {})])) {
      const absolute = resolve(root, path);
      if (absolute === root && id === 'orchestrator' || id === 'raf' && absolute === logical) continue;
      if (physical.some(copy => overlaps(copy, absolute))) refuse(`mainCopies overlaps protected ${id} path ${absolute}`);
      protectedPaths.push(absolute);
    }
  }
  return { logical, physical, protectedPaths };
}

function differentFiles(repositories: readonly { path: string; repository: MainLayoutRepositoryInspection }[]) {
  const canonical = new Map<string, { repository: number; path: string }>();
  const inodes = new Map<string, { repository: number; path: string }>();
  for (const [index, entry] of repositories.entries()) {
    for (const file of entry.repository.files) {
      const path = join(entry.path, file.relativePath);
      const key = `${file.device}:${file.inode}`;
      for (const alias of [canonical.get(file.canonicalPath), inodes.get(key)]) {
        if (alias && alias.repository !== index) refuse(`source/build alias between ${alias.path} and ${path}`);
      }
      canonical.set(file.canonicalPath, { repository: index, path });
      inodes.set(key, { repository: index, path });
    }
  }
}

export async function validateMainLayoutForStart(
  options: MainLayoutValidationOptions,
): Promise<MainLayoutValidationResult> {
  const { root, projects, probe } = options;
  const { logical, physical } = configuredPaths(root, projects);
  const protectedPaths = Object.entries(projects.raf.branchPaths).filter(([branch]) => branch !== 'main').map(([, path]) => resolve(root, path));
  const copies = await Promise.all(physical.map(path => probe.inspectPath(path)));
  const main = await probe.inspectPath(logical);
  for (let i = 0; i < physical.length; i++) {
    const info = copies[i];
    if (info.kind !== 'missing' && (info.kind !== 'directory' || info.canonicalPath !== physical[i])) refuse(`expected physical directory ${physical[i]}; received ${info.kind} -> ${info.canonicalPath}`);
    if (info.canonicalPath && (!within(root, info.canonicalPath) || info.kind === 'missing' && info.canonicalPath !== physical[i])) refuse(`mainCopies escapes root: ${physical[i]} -> ${info.canonicalPath}`);
  }
  for (const path of protectedPaths) {
    const info = await probe.inspectPath(path);
    if (info.canonicalPath && physical.some(copy => overlaps(copy, info.canonicalPath!))) refuse(`canonical mainCopies overlap with protected path ${path} -> ${info.canonicalPath}`);
  }
  const state = main.kind === 'directory' ? 'legacy' : 'ready';
  if (state === 'legacy' && (main.canonicalPath !== logical || copies.some(copy => copy.kind !== 'missing'))) refuse(`legacy ${logical} requires two unoccupied physical targets; received ${copies.map(copy => copy.kind).join(', ')}`);
  if (state === 'ready' && (main.kind !== 'symlink' || !physical.includes(main.canonicalPath ?? '') || copies.some(copy => copy.kind !== 'directory'))) refuse(`expected ${logical} symlink to one of two existing physical mainCopies; received ${main.kind} -> ${main.canonicalPath}`);
  const activePath = state === 'legacy' ? physical[0] : main.canonicalPath!;
  const inactivePath = physical.find(path => path !== activePath)!;
  const active = await probe.inspectRepository(state === 'legacy' ? logical : activePath);
  if (!active || active.branch !== 'main') refuse(`expected raf main repository at ${state === 'legacy' ? logical : activePath}; received branch ${active?.branch ?? 'missing/detached'}`);
  const repositories = [{ path: state === 'legacy' ? logical : activePath, repository: active }];
  if (state === 'ready') {
    const inactive = await probe.inspectRepository(inactivePath);
    if (!inactive || inactive.identity !== active.identity || inactive.branch !== null) refuse(`expected detached copy of repository ${active.identity} at ${inactivePath}; received ${inactive?.identity ?? 'missing'} branch ${inactive?.branch}`);
    repositories.push({ path: inactivePath, repository: inactive });
  }
  for (const branch of ['develop', 'hotfix']) {
    const path = projects.raf.branchPaths[branch];
    if (!path) continue;
    const absolute = resolve(root, path);
    const repository = await probe.inspectRepository(absolute);
    if (!repository || repository.identity !== (active.sourceIdentity ?? active.identity) || repository.branch !== branch) refuse(`expected raf ${branch} worktree of ${active.sourceIdentity ?? active.identity} at ${absolute}; received ${repository?.identity ?? 'missing'} branch ${repository?.branch}`);

  }
  differentFiles(repositories);
  const registration = await probe.inspectGitRegistration(root);
  const registered = state === 'legacy' ? logical : activePath;
  if (resolve(root, registration.modulePath) !== registered || resolve(root, registration.gitlinkPath) !== registered || registration.gitlinkHead !== active.head || registration.logicalMode !== (state === 'legacy' ? '160000' : '120000')) refuse(`Git registration mismatch: expected module/gitlink ${registered} at ${active.head}, logical mode ${state === 'legacy' ? '160000' : '120000'}; received ${JSON.stringify(registration)}`);
  return { state, activePath, inactivePath };
}

async function stat(path: string) {
  return fs.lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}

async function git(cwd: string, args: string[], index?: string): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') delete env[key];
  if (index) env.GIT_INDEX_FILE = index;
  return (await execute('git', ['-C', cwd, ...args], { env, maxBuffer: 64 * 1024 * 1024 })).stdout.trimEnd();
}

async function inspectPath(path: string): Promise<MainLayoutPathInspection> {
  const info = await stat(path);
  if (!info) {
    let parent = dirname(path);
    while (!await stat(parent)) parent = dirname(parent);
    return { kind: 'missing', canonicalPath: resolve(await fs.realpath(parent), relative(parent, path)) };
  }
  try {
    return { kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file', canonicalPath: await fs.realpath(path) };
  } catch (error: any) {
    if (error.code === 'ELOOP') return { kind: 'cycle', canonicalPath: null };
    if (error.code === 'ENOENT') return { kind: info.isSymbolicLink() ? 'symlink' : 'missing', canonicalPath: null };
    throw error;
  }
}

async function inspectRepository(path: string, root?: string): Promise<MainLayoutRepositoryInspection | null> {
  if (!(await stat(path))?.isDirectory()) return null;
  let identity: string, head: string, branch: string | null;
  try {
    if (await fs.realpath(await git(path, ['rev-parse', '--show-toplevel'])) !== await fs.realpath(path)) return null;
    identity = await fs.realpath(await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    head = await git(path, ['rev-parse', 'HEAD']);
    branch = await git(path, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => null);
  } catch { return null; }
  const files: MainLayoutFileIdentity[] = [];
  async function walk(directory: string) {
    for (const name of await fs.readdir(directory)) {
      if (directory === path && ['.git', 'node_modules'].includes(name)) continue;
      const file = join(directory, name);
      const info = await fs.lstat(file);
      if (info.isDirectory()) await walk(file);
      else if (info.isFile() || info.isSymbolicLink()) {
        const target = await fs.stat(file).catch(() => null);
        if (!target?.isFile()) {
          if (info.isSymbolicLink() && /^(src|source|dist|build)(\/|$)/.test(relative(path, file))) refuse(`unverifiable source/build symlink ${file}`);
          continue;
        }
        files.push({ relativePath: relative(path, file), canonicalPath: await fs.realpath(file), device: target.dev, inode: target.ino });
      }
    }
  }
  await walk(path);
  const sourceIdentity = root ? (await resolveProductionStore(root, path)).source : undefined;
  return { identity, sourceIdentity, head, branch, files };
}

async function moduleRegistration(root: string) {
  const lines = (await git(root, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])).split('\n');
  const logical = await inspectPath(join(root, 'raf-main'));
  const expected = logical.kind === 'symlink' && logical.canonicalPath ? relative(root, logical.canonicalPath) : 'raf-main';
  const matches = lines.map(line => /^submodule\.(.+)\.path (.+)$/.exec(line)).filter(match => match && match[2] === expected);
  if (matches.length !== 1) refuse('expected exactly one raf submodule path registration in .gitmodules');
  return { name: matches[0]![1], path: matches[0]![2] };
}

async function inspectGitRegistration(root: string): Promise<MainLayoutGitRegistration> {
  const module = await moduleRegistration(root);
  const entry = await git(root, ['ls-files', '--stage', '--', module.path]);
  const match = /^160000 ([0-9a-f]+) 0\t/.exec(entry);
  const logical = await git(root, ['ls-files', '--stage', '--', 'raf-main']);
  if (!match || !/^(120000|160000) [0-9a-f]+ 0\t/.test(logical)) refuse('expected physical gitlink and tracked logical raf-main');
  return { modulePath: module.path, gitlinkPath: module.path, gitlinkHead: match[1], logicalMode: logical.slice(0, 6) as '160000' | '120000' };
}

const nativeProbe = (root: string): MainLayoutProbe => ({ inspectPath, inspectRepository: path => inspectRepository(path, root), inspectGitRegistration });

interface LayoutIntent {
  version: 1;
  root: string;
  logicalPath: string;
  activePath: string;
  inactivePath: string;
  repository: string;
  gitDirectory: string;
  head: string;
  originalDevice: number;
  originalInode: number;
  gitFileBefore: string;
  gitFileAfter: string;
  worktreeBefore: string;
  moduleBefore: string;
  moduleAfter: string;
  indexBefore: string;
  indexAfter: string;
  indexPath: string;
}

async function changedModule(data: Buffer, name: string, path: string, temporary: string, root: string) {
  await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
  try {
    const paths = await git(root, ['config', '-f', temporary, '--get-all', `submodule.${name}.path`]);
    if (paths !== 'raf-main') refuse(`expected staged/working .gitmodules submodule.${name}.path=raf-main; received ${paths}`);
    await git(root, ['config', '-f', temporary, `submodule.${name}.path`, path]);
    return await fs.readFile(temporary);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function prepareIntent(options: MainLayoutStartOptions, layout: MainLayoutValidationResult, indexPath: string, intentPath: string): Promise<LayoutIntent> {
  const root = options.root;
  const logicalPath = join(root, 'raf-main');
  const gitFileBefore = await fs.readFile(join(logicalPath, '.git'), 'utf8');
  const pointer = /^gitdir: (.+)\n?$/.exec(gitFileBefore);
  if (!pointer) refuse('legacy raf-main must be a registered submodule with a .git file');
  const gitDirectory = await fs.realpath(resolve(logicalPath, pointer[1]));
  const repository = await fs.realpath(await git(logicalPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (gitDirectory !== repository) refuse('legacy raf-main must be the primary submodule checkout, not another worktree');
  const original = (await stat(logicalPath))!;
  const indexBefore = await fs.readFile(indexPath);
  const moduleBefore = await fs.readFile(join(root, '.gitmodules'));
  const module = await moduleRegistration(root);
  const activeRelative = relative(root, layout.activePath);
  const temporary = intentPath + '.' + randomUUID();
  const moduleAfter = await changedModule(moduleBefore, module.name, activeRelative, temporary + '.modules', root);
  const stagedModule = Buffer.from(await git(root, ['show', ':.gitmodules']));
  const stagedAfter = await changedModule(stagedModule, module.name, activeRelative, temporary + '.staged', root);
  const stagedHashFile = temporary + '.blob';
  await fs.writeFile(stagedHashFile, stagedAfter, { flag: 'wx' });
  const logicalHashFile = temporary + '.link';
  await fs.writeFile(logicalHashFile, relative(dirname(logicalPath), layout.activePath), { flag: 'wx' });
  const temporaryIndex = temporary + '.index';
  try {
    const moduleHash = await git(root, ['hash-object', '-w', stagedHashFile]);
    const linkHash = await git(root, ['hash-object', '-w', logicalHashFile]);
    await fs.writeFile(temporaryIndex, indexBefore, { flag: 'wx' });
    await git(root, ['update-index', '--force-remove', '--', 'raf-main'], temporaryIndex);
    const head = await git(logicalPath, ['rev-parse', 'HEAD']);
    await git(root, ['update-index', '--add', '--cacheinfo', `160000,${head},${activeRelative}`], temporaryIndex);
    await git(root, ['update-index', '--add', '--cacheinfo', `120000,${linkHash},raf-main`], temporaryIndex);
    await git(root, ['update-index', '--cacheinfo', `100644,${moduleHash},.gitmodules`], temporaryIndex);
    return {
      version: 1, root, logicalPath, activePath: layout.activePath, inactivePath: layout.inactivePath,
      repository, gitDirectory, head, originalDevice: original.dev, originalInode: original.ino,
      gitFileBefore, gitFileAfter: 'gitdir: ' + relative(layout.activePath, gitDirectory) + '\n',
      worktreeBefore: await git(root, ['--git-dir=' + gitDirectory, 'config', '--get', 'core.worktree']),
      moduleBefore: moduleBefore.toString('base64'), moduleAfter: moduleAfter.toString('base64'),
      indexBefore: indexBefore.toString('base64'), indexAfter: (await fs.readFile(temporaryIndex)).toString('base64'), indexPath,
    };
  } finally {
    for (const path of [temporaryIndex, temporaryIndex + '.lock', stagedHashFile, logicalHashFile]) await fs.rm(path, { force: true });
  }
}

async function replaceExpected(path: string, before: Buffer, after: Buffer) {
  const current = await fs.readFile(path);
  if (current.equals(after)) return;
  if (!current.equals(before)) refuse(`concurrent or foreign changes at ${path}; recovery retained the intent and files`);
  const temporary = path + '.' + randomUUID();
  const info = await fs.stat(path);
  const file = await fs.open(temporary, 'wx', info.mode & 0o777);
  try { await file.writeFile(after); await file.sync(); } finally { await file.close(); }
  await fs.rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string) {
  const directory = await fs.open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function recoverLayout(options: MainLayoutStartOptions, intent: LayoutIntent, intentPath: string) {
  const publication: MainLayoutPublication = { root: intent.root, logicalPath: intent.logicalPath, activePath: intent.activePath, intentPath };
  const checkpoint = async (name: MainLayoutCheckpoint) => options.onCheckpoint?.(name, publication);
  const paths = configuredPaths(options.root, options.projects);
  if (intent.version !== 1 || intent.root !== options.root || intent.logicalPath !== paths.logical || !paths.physical.includes(intent.activePath) || !paths.physical.includes(intent.inactivePath) || intent.activePath === intent.inactivePath) refuse(`recovery intent/config mismatch at ${intentPath}`);
  const logical = await stat(intent.logicalPath);
  const active = await stat(intent.activePath);
  const isOriginal = (info: Awaited<ReturnType<typeof stat>>) => info?.isDirectory() && info.dev === intent.originalDevice && info.ino === intent.originalInode;
  const preparedLink = active?.isSymbolicLink() && await fs.readlink(intent.activePath) === relative(dirname(intent.logicalPath), intent.activePath);
  if (isOriginal(logical) && (!active || preparedLink)) {
    await fs.mkdir(dirname(intent.activePath), { recursive: true });
    if (await fs.realpath(dirname(intent.activePath)) !== dirname(intent.activePath)) refuse('active target parent is an alias');
    await options.publicationProvider!.publish(publication);
    await syncDirectory(dirname(intent.logicalPath));
    await syncDirectory(dirname(intent.activePath));
    await checkpoint('original-relocated');
  } else if (!isOriginal(active) || logical && !logical.isSymbolicLink()) refuse(`recovery cannot prove original directory at ${intent.logicalPath} or ${intent.activePath}; files retained`);
  if (logical?.isSymbolicLink() && await fs.realpath(intent.logicalPath) !== intent.activePath) refuse('recovery logical symlink points to a foreign target');
  await replaceExpected(join(intent.activePath, '.git'), Buffer.from(intent.gitFileBefore), Buffer.from(intent.gitFileAfter));
  const worktree = await git(intent.root, ['--git-dir=' + intent.gitDirectory, 'config', '--get', 'core.worktree']);
  const expectedWorktree = relative(intent.gitDirectory, intent.activePath);
  if (worktree !== expectedWorktree) {
    if (worktree !== intent.worktreeBefore) refuse('foreign submodule core.worktree change during recovery');
    await git(intent.root, ['--git-dir=' + intent.gitDirectory, 'config', 'core.worktree', expectedWorktree]);
    const configFile = await fs.open(join(intent.gitDirectory, 'config'), 'r');
    try { await configFile.sync(); } finally { await configFile.close(); }
    await syncDirectory(intent.gitDirectory);
  }
  if (await git(intent.activePath, ['rev-parse', 'HEAD']) !== intent.head || await fs.realpath(await git(intent.activePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== intent.repository) refuse('relocated original Git identity/HEAD changed; recovery refused');
  const inactive = await stat(intent.inactivePath);
  if (!inactive) {
    await fs.mkdir(dirname(intent.inactivePath), { recursive: true });
    if (await fs.realpath(dirname(intent.inactivePath)) !== dirname(intent.inactivePath)) refuse('inactive target parent is an alias');
    await git(intent.activePath, ['worktree', 'add', '--detach', intent.inactivePath, intent.head]);
    await syncDirectory(dirname(intent.inactivePath));
  } else {
    const repository = await inspectRepository(intent.inactivePath);
    if (!repository || repository.identity !== intent.repository || repository.branch !== null || repository.head !== intent.head) refuse(`occupied or incomplete inactive target ${intent.inactivePath}; files retained for recovery`);
  }
  if (await git(intent.inactivePath, ['status', '--porcelain=v1', '--untracked-files=normal'])) refuse(`incomplete or externally modified inactive checkout ${intent.inactivePath}; files and recovery intent retained`);
  await replaceExpected(join(intent.root, '.gitmodules'), Buffer.from(intent.moduleBefore, 'base64'), Buffer.from(intent.moduleAfter, 'base64'));
  const index = await fs.readFile(intent.indexPath);
  const before = Buffer.from(intent.indexBefore, 'base64');
  const after = Buffer.from(intent.indexAfter, 'base64');
  if (!index.equals(after)) {
    if (!index.equals(before)) refuse(`foreign Orchestrator index changes at ${intent.indexPath}; expected ${digest(before)} or ${digest(after)}, received ${digest(index)}; index retained`);
    const file = await fs.open(intent.indexPath + '.lock', 'wx', (await fs.stat(intent.indexPath)).mode & 0o777);
    try {
      if (!(await fs.readFile(intent.indexPath)).equals(before)) refuse('Orchestrator index changed while taking index.lock');
      await file.writeFile(after); await file.sync();
      await file.close();
      await fs.rename(intent.indexPath + '.lock', intent.indexPath);
      await syncDirectory(dirname(intent.indexPath));
    } finally { await file.close(); await fs.rm(intent.indexPath + '.lock', { force: true }); }
  }
  await checkpoint('git-relocated');
  if (!(await stat(intent.logicalPath))?.isSymbolicLink()) refuse('expected atomically published logical symlink after original relocation; recoverable intent retained');
  const published = await inspectPath(intent.logicalPath);
  if (published.kind !== 'symlink' || published.canonicalPath !== intent.activePath) refuse('publication provider did not publish the expected logical symlink; recoverable intent retained');
  await syncDirectory(dirname(intent.logicalPath));
  await checkpoint('link-published');
  const verified = await validateMainLayoutForStart({ root: options.root, projects: options.projects, probe: nativeProbe(options.root) });
  if (verified.state !== 'ready' || verified.activePath !== intent.activePath) refuse('final layout verification failed');
  await fs.unlink(intentPath);
  await syncDirectory(dirname(intentPath));
}

async function withLayoutWriter<T>(directory: string, use: () => Promise<T>): Promise<T> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'activation.lock');
  for (;;) {
    try { await fs.mkdir(path, { mode: 0o700 }); break; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await fs.readFile(join(path, 'owner.json'), 'utf8').then(JSON.parse, () => null);
      if (!owner || await alive(owner.pid, owner.start)) refuse(`writer barrier busy at ${path}; coordinate with start/activation, existing lock retained`);
      await fs.rm(path, { recursive: true });
    }
  }
  try {
    await durable(join(path, 'owner.json'), { pid: process.pid, start: await processStart(process.pid) });
    return await use();
  } finally { await fs.rm(path, { recursive: true }); }
}

export async function ensureMainLayoutForStart(
  options: MainLayoutStartOptions,
): Promise<MainLayoutStartResult> {
  const { root, projects } = options;
  const publicationProvider = options.publicationProvider ?? nativeMainLayoutPublicationProvider();
  options = { ...options, publicationProvider };
  configuredPaths(root, projects);
  if (await fs.realpath(root) !== root || await git(root, ['rev-parse', '--show-toplevel']) !== root) refuse('expected canonical Orchestrator Git root');
  const control = await fs.realpath(await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const intentPath = join(control, 'raf-main-layout', 'intent.json');
  let intent: LayoutIntent | null = await fs.readFile(intentPath, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  let layout: MainLayoutValidationResult | null = null;
  let production;
  if (!intent) {
    const store = await productionStorePaths(root);
    if (await stat(join(store.control, 'main-store-intent.json'))) {
      await publicationProvider.assertSupported(root);
      await ensureProductionMainStore({ root });
    }
    layout = await validateMainLayoutForStart({ root, projects, probe: nativeProbe(root) });
    await publicationProvider.assertSupported(root);
    production = await ensureProductionMainStore({ root });
    if (layout.state === 'ready') return { status: 'unchanged', activePath: layout.activePath, inactivePath: layout.inactivePath };
  }
  await publicationProvider.assertSupported(root);
  const repository = intent?.repository ?? (await inspectRepository(join(root, 'raf-main')))!.identity;
  if (await fs.realpath(repository) !== repository) refuse('repository identity must be canonical');
  const writerControl = production?.control ?? (await productionStorePaths(root)).control;
  return withLayoutWriter(writerControl, async () => {
    intent = await fs.readFile(intentPath, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
    if (intent && intent.repository !== repository) refuse('recovery repository changed while acquiring writer barrier');
    const recovered = !!intent;
    if (!intent) {
      layout = await validateMainLayoutForStart({ root, projects, probe: nativeProbe(root) });
      if (layout.state === 'ready') return { status: 'unchanged', activePath: layout.activePath, inactivePath: layout.inactivePath };
      const indexPath = await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
      if (await stat(indexPath + '.lock')) refuse(`Orchestrator index.lock busy at ${indexPath}.lock; existing lock retained`);
      await fs.mkdir(dirname(intentPath), { recursive: true, mode: 0o700 });
      intent = await prepareIntent(options, layout, indexPath, intentPath);
      await durable(intentPath, intent);
      await options.onCheckpoint?.('intent-durable', { root, logicalPath: intent.logicalPath, activePath: intent.activePath, intentPath });
    }
    await recoverLayout(options, intent, intentPath);
    return { status: recovered ? 'recovered' : 'converted', activePath: intent.activePath, inactivePath: intent.inactivePath };
  });
}
