import { hotfixModuleOrigin } from './hotfix-origin.ts';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { commandFailure, failureContext } from './cli-contract.ts';

export type StateEntryPoint = 'cli' | 'runner-limits' | 'worker' | 'service-store' | 'notice' | 'hook';

export interface StateContextRequest {
  orchestratorRoot: string;
  modulePath: string;
  homeDirectory: string;
  operatingSystemHome: string;
  environment: Readonly<Record<string, string | undefined>>;
  entryPoint: StateEntryPoint;
}

export interface StateContext {
  mode: 'production' | 'qa';
  orchestratorRoot: string;
  codeRoot: string;
  homeDirectory: string;
  statePath: string;
  tmpRoot: string;
  tmuxSocketPath: string;
}

export interface StateTransferPermit {
  statePath: string;
  fromVersion: number;
  toVersion: number;
}

export interface StateStoreOpenOptions {
  context?: StateContext;
  transfer?: StateTransferPermit;
  afterMigrationStep?: (version: number) => void;
}

export function stateFailure(code: string, reason: string): Error {
  return Object.assign(commandFailure({ code, message: `${code}: ${reason}`, reason, stage: 'state-preflight',
    source: 'state-store', sourceCode: code, received: null, expected: null, found: null,
    completed: [], pending: [], retrySafe: true,
    remediation: [code === 'STATE_CONTEXT_REFUSED'
      ? 'Use the configured raf production tree and account HOME, or select a separate HOME with RAF_QA_HOME before starting any child process.'
      : 'Stop incompatible clients and use scripts/migrate-state.ts with an explicit state path, versions and new backup; never change user_version manually.'],
  }), { code });
}

function refuse(reason: string): never { throw stateFailure('STATE_CONTEXT_REFUSED', reason); }
function contextFailure(code: 'CONFIGURATION_INVALID' | 'HANDLER_FAILED', reason: string, source: string): never {
  throw Object.assign(commandFailure({ code, message: reason, reason, source, stage: 'state-preflight', sourceCode: null,
    received: null, expected: null, found: null, completed: [], pending: [], retrySafe: true,
    remediation: [code === 'CONFIGURATION_INVALID' ? 'Correct the runtime configuration file before retrying.' : 'Restore access to the selected state directory before retrying.'],
  }), { code });
}
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
const proofs = new WeakMap<StateContext, { request: StateContextRequest; workingHome: string }>();

function activeMainOrigin(root: string, project: any, productionRoot: string, modulePath: string): string | undefined {
  const copies = project.mainCopies;
  if (!Array.isArray(copies) || copies.length !== 2 || new Set(copies).size !== 2 || !inside(modulePath, productionRoot)) return;
  try {
    if (!lstatSync(resolve(root, project.path)).isSymbolicLink()) return;
    if (!copies.every(path => typeof path === 'string' && path && !isAbsolute(path) &&
      relative(root, resolve(root, path)) === path && realpathSync(resolve(root, path)) === resolve(root, path))) return;
    const active = copies.find(path => resolve(root, path) === productionRoot);
    if (!active) return;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args],
      { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit = git(productionRoot, 'rev-parse', 'HEAD');
    if (git(productionRoot, 'symbolic-ref', 'HEAD') !== 'refs/heads/main' || git(productionRoot, 'rev-parse', 'refs/heads/main') !== commit) return;
    if (git(root, 'config', '-f', '.gitmodules', '--get', 'submodule.raf-main.path') !== active ||
      git(root, 'ls-files', '--stage', '--', active) !== `160000 ${commit} 0\t${active}`) return;
    return productionRoot;
  } catch { return; }
}

export function canonicalStatePath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) refuse(`Absolute state context path required: ${path}`);
  const parts: string[] = [];
  let ancestor = resolve(path);
  for (;;) {
    try { return resolve(realpathSync(ancestor), ...parts); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) refuse(`Cannot resolve state context path: ${path}`);
      try { if (lstatSync(ancestor).isSymbolicLink()) refuse(`Dangling state context symlink: ${ancestor}`); }
      catch (missing) { if (!['ENOENT', 'ENOTDIR'].includes((missing as NodeJS.ErrnoException).code ?? '')) throw missing; }
      const parent = dirname(ancestor);
      if (parent === ancestor) refuse(`Cannot resolve state context ancestor: ${path}`);
      parts.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function isolatedPaths(context: StateContext, workingHome: string): void {
  const workingState = join(workingHome, '.raf');
  const paths = [context.homeDirectory, dirname(context.statePath), context.statePath,
    context.statePath + '-wal', context.statePath + '-shm', context.tmpRoot, dirname(context.tmuxSocketPath), context.tmuxSocketPath];
  for (const path of paths) {
    const actual = canonicalStatePath(path);
    if (actual !== path) refuse(`State context path changed or aliases another location: ${path} -> ${actual}`);
    if (context.mode === 'qa' && (inside(actual, workingState) || actual === workingHome || inside(workingState, actual))) {
      refuse(`QA state aliases working HOME/.raf: ${path}`);
    }
  }
  for (const path of [context.homeDirectory, dirname(context.statePath), context.tmpRoot, dirname(context.tmuxSocketPath)]) {
    try {
      if (!statSync(path).isDirectory()) contextFailure('HANDLER_FAILED', `ENOTDIR: State directory path is blocked by a file: ${path}`, path);
    } catch (error) {
      if (failureContext(error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') contextFailure('HANDLER_FAILED', `Cannot access state directory ${path}: ${error instanceof Error ? error.message : String(error)}`, path);
    }
  }
  if (context.mode === 'qa') {
    for (const path of [context.statePath, context.statePath + '-wal', context.statePath + '-shm']) {
      try {
        const info = lstatSync(path);
        if (!info.isFile() || info.nlink !== 1) refuse(`QA database or sidecar has aliases/hardlinks: ${path}`);
        for (const name of [basename(context.statePath), basename(context.statePath) + '-wal', basename(context.statePath) + '-shm']) {
          try {
            const working = statSync(join(workingState, name));
            if (info.dev === working.dev && info.ino === working.ino) refuse(`QA file shares working state identity: ${path}`);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

export function resolveStateContext(request: StateContextRequest): StateContext {
  try {
    const orchestratorRoot = realpathSync(request.orchestratorRoot);
    const projects = JSON.parse(readFileSync(join(orchestratorRoot, 'conf', 'projects.json'), 'utf8'));
    const project = projects.projects?.raf;
    const profile = projects.profiles?.[project?.profile];
    if (projects.version !== 1 || !project?.path || !project.branchPaths || !profile ||
        typeof profile.production !== 'string' || profile.environments?.runtime !== profile.production ||
        project.branchPaths[profile.production] !== project.path) refuse('Cannot prove configured raf production/runtime tree');
    const productionRoot = realpathSync(resolve(orchestratorRoot, project.path));
    const modulePath = realpathSync(request.modulePath);
    if (statSync(modulePath).nlink !== 1) refuse(`Module origin has hardlink aliases: ${modulePath}`);
    const roots = Object.values(project.branchPaths).filter((path): path is string => typeof path === 'string')
      .map(path => resolve(orchestratorRoot, path));
    let originReason: string | undefined;
    const codeRoot = roots.find(root => { try { return realpathSync(root) === root && inside(modulePath, root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }) ??
      activeMainOrigin(orchestratorRoot, project, productionRoot, modulePath) ?? hotfixModuleOrigin(orchestratorRoot, productionRoot, modulePath, request.environment.RAF_QA_HOME !== undefined, reason => { originReason = reason; });
    if (!codeRoot || !['src', 'bin', 'scripts'].includes(relative(codeRoot, modulePath).split(sep)[0])) refuse(originReason ?? `Unregistered module origin: ${modulePath}`);
    const settingsPath = join(orchestratorRoot, 'conf', 'raf.json');
    let settings;
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch (error) { contextFailure('CONFIGURATION_INVALID', `Cannot read valid ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`, settingsPath); }
    const fileName = settings?.state?.fileName;
    if (settings?.version !== 1 || typeof fileName !== 'string' || !fileName.trim() || ['.', '..'].includes(fileName) ||
        basename(fileName) !== fileName || /[\\/\0]/.test(fileName)) contextFailure('CONFIGURATION_INVALID', `Invalid raf.json version or state.fileName: ${settingsPath}`, settingsPath);
    const workingHome = canonicalStatePath(request.operatingSystemHome);
    const selectedHome = canonicalStatePath(request.homeDirectory);
    const qa = request.environment.RAF_QA_HOME;
    let mode: StateContext['mode'] = 'production';
    if (qa !== undefined) {
      if (!qa || canonicalStatePath(qa) !== selectedHome || canonicalStatePath(request.environment.HOME ?? '') !== selectedHome) {
        refuse('RAF_QA_HOME and HOME must select the same separate canonical HOME');
      }
      mode = 'qa';
    } else if ((codeRoot !== productionRoot && !hotfixModuleOrigin(orchestratorRoot, productionRoot, modulePath, false)) || selectedHome !== workingHome ||
        request.environment.HOME !== undefined && canonicalStatePath(request.environment.HOME) !== workingHome) {
      refuse(`Loaded code ${codeRoot} cannot use state ${join(selectedHome, '.raf', fileName)} with HOME ${selectedHome}; production tree is ${productionRoot}, account HOME is ${workingHome}`);
    }
    const statePath = join(selectedHome, '.raf', fileName);
    const tmpRoot = join(selectedHome, '.raf', 'tmp');
    const context: StateContext = Object.freeze({ mode, orchestratorRoot, codeRoot, homeDirectory: selectedHome,
      statePath, tmpRoot, tmuxSocketPath: join(tmpRoot, 'tmux', 'server.sock') });
    isolatedPaths(context, workingHome);
    proofs.set(context, { request: { ...request, environment: { ...request.environment } }, workingHome });
    return context;
  } catch (error) {
    if (failureContext(error)) throw error;
    refuse(`Cannot prove state context for ${request.modulePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function verifyStateContext(context: StateContext): void {
  let proof = proofs.get(context);
  if (!proof) {
    const request: StateContextRequest = { orchestratorRoot: context.orchestratorRoot,
      modulePath: join(context.codeRoot, 'src', 'state-store.ts'), homeDirectory: context.homeDirectory,
      operatingSystemHome: userInfo().homedir, entryPoint: 'worker',
      environment: { HOME: context.homeDirectory, ...(context.mode === 'qa' ? { RAF_QA_HOME: context.homeDirectory } : {}) } };
    const rebuilt = resolveStateContext(request);
    if (JSON.stringify(rebuilt) !== JSON.stringify(context)) refuse('Serialized state context differs from resolved paths');
    proof = proofs.get(rebuilt)!;
    proofs.set(context, proof);
  }
  const current = resolveStateContext(proof.request);
  if (JSON.stringify(current) !== JSON.stringify(context)) refuse('State context configuration changed before open');
  isolatedPaths(context, proof.workingHome);
}

export function verifyStateModule(context: StateContext, modulePath: string): void {
  if (context.mode !== 'production') return;
  verifyStateContext(context);
  const actual = realpathSync(modulePath);
  if (actual !== resolve(modulePath) || !inside(actual, context.codeRoot)) refuse('Dynamic module is outside the pinned production generation: ' + modulePath);
  if (context.codeRoot.includes('/raf-hotfix/generations/')) {
    const projects = JSON.parse(readFileSync(join(context.orchestratorRoot, 'conf/projects.json'), 'utf8'));
    const productionRoot = realpathSync(resolve(context.orchestratorRoot, projects.projects.raf.path));
    if (hotfixModuleOrigin(context.orchestratorRoot, productionRoot, actual, false) !== context.codeRoot) refuse('Dynamic module is not protected by its generation runtime inventory: ' + modulePath);
  }
}

export function stateContextEnvironment(context: StateContext, inherited: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  verifyStateContext(context);
  const environment: Record<string, string | undefined> = { ...inherited, HOME: context.homeDirectory, RAF_HOME_DIRECTORY: context.homeDirectory,
    RAF_ORCHESTRATOR_ROOT: context.orchestratorRoot, RAF_STATE_DIRECTORY: dirname(context.statePath),
    RAF_SOCKET_PATH: join(dirname(context.statePath), 'service.sock') };
  delete environment.ALLOW_MIGRATIONS;
  if (context.mode === 'qa') {
    environment.RAF_QA_HOME = context.homeDirectory;
    delete environment.TMUX;
    delete environment.TMUX_PANE;
  } else delete environment.RAF_QA_HOME;
  return environment;
}

export function productionStateContext(orchestratorRoot: string, modulePath: string, homeDirectory: string, entryPoint: StateEntryPoint,
  environment: Readonly<Record<string, string | undefined>> = process.env): StateContext {
  return resolveStateContext({ orchestratorRoot, modulePath, homeDirectory, operatingSystemHome: userInfo().homedir, environment, entryPoint });
}
