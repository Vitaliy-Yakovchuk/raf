import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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

function moduleCodeRoot(modulePath: string): string {
  for (let directory = dirname(modulePath); dirname(directory) !== directory; directory = dirname(directory)) {
    if (['src', 'bin', 'scripts'].includes(basename(directory))) return dirname(directory);
  }
  return dirname(modulePath);
}

function configuredProductionRoot(orchestratorRoot: string): string | undefined {
  try {
    const project = JSON.parse(readFileSync(join(orchestratorRoot, 'conf', 'projects.json'), 'utf8')).projects?.raf;
    return typeof project?.path === 'string' ? realpathSync(resolve(orchestratorRoot, project.path)) : undefined;
  } catch { return undefined; }
}

export function canonicalStatePath(path: string): string {
  const parts: string[] = [];
  let ancestor = resolve(path);
  for (;;) {
    try { return resolve(realpathSync(ancestor), ...parts); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) refuse(`Cannot resolve state context path: ${path}`);
      const parent = dirname(ancestor);
      if (parent === ancestor) refuse(`Cannot resolve state context ancestor: ${path}`);
      parts.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function blockedPaths(context: StateContext): void {
  for (const path of [context.homeDirectory, dirname(context.statePath), context.tmpRoot, dirname(context.tmuxSocketPath)]) {
    try {
      if (!statSync(path).isDirectory()) contextFailure('HANDLER_FAILED', `ENOTDIR: State directory path is blocked by a file: ${path}`, path);
    } catch (error) {
      if (failureContext(error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') contextFailure('HANDLER_FAILED', `Cannot access state directory ${path}: ${error instanceof Error ? error.message : String(error)}`, path);
    }
  }
}

export function resolveStateContext(request: StateContextRequest): StateContext {
  const orchestratorRoot = canonicalStatePath(resolve(request.orchestratorRoot));
  const modulePath = canonicalStatePath(resolve(request.modulePath));
  const codeRoot = moduleCodeRoot(modulePath);
  const settingsPath = join(orchestratorRoot, 'conf', 'raf.json');
  let settings;
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch (error) { contextFailure('CONFIGURATION_INVALID', `Cannot read valid ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`, settingsPath); }
  const fileName = settings?.state?.fileName;
  if (settings?.version !== 1 || typeof fileName !== 'string' || !fileName.trim() || ['.', '..'].includes(fileName) ||
      basename(fileName) !== fileName || /[\\/\0]/.test(fileName)) contextFailure('CONFIGURATION_INVALID', `Invalid raf.json version or state.fileName: ${settingsPath}`, settingsPath);
  const workingHome = canonicalStatePath(request.operatingSystemHome);
  const selectedHome = canonicalStatePath(request.homeDirectory);
  const mode: StateContext['mode'] = request.environment.RAF_QA_HOME ? 'qa' : 'production';
  const statePath = join(selectedHome, '.raf', fileName);
  if (mode === 'production' && selectedHome === workingHome && request.entryPoint === 'cli') {
    const productionRoot = configuredProductionRoot(orchestratorRoot);
    if (productionRoot && !inside(modulePath, productionRoot)) {
      process.stderr.write(`STATE_CONTEXT_WARNING: raf from ${codeRoot} uses working state ${statePath}; production tree is ${productionRoot}. Use a separate stand HOME with RAF_QA_HOME for develop.\n`);
    }
  }
  const tmpRoot = join(selectedHome, '.raf', 'tmp');
  const context: StateContext = Object.freeze({ mode, orchestratorRoot, codeRoot, homeDirectory: selectedHome,
    statePath, tmpRoot, tmuxSocketPath: join(tmpRoot, 'tmux', 'server.sock') });
  blockedPaths(context);
  return context;
}

export function verifyStateContext(context: StateContext): void {
  blockedPaths(context);
}

export function admitStateStore(context: StateContext): () => void {
  blockedPaths(context);
  return () => blockedPaths(context);
}

export function stateContextEnvironment(context: StateContext, inherited: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
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
