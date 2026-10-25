import { resolve, join, isAbsolute } from 'node:path';

export interface WorkspaceProjectsConfig {
  profiles?: Record<string, { development?: string | null }>;
  projects: Record<string, {
    path: string;
    profile: string;
    branchPaths?: Record<string, string>;
    usesSharedLibs?: boolean;
    mainCopies?: readonly string[];
  }>;
}

export interface WorkspaceRouteRequest {
  root: string;
  project: string;
  branch: string;
  hotfixRunId?: string;
}

export interface WorkspaceRoutingDependencies {
  pathKind(path: string): Promise<'directory' | 'symlink' | 'file' | 'missing'>;
  readLink(path: string): Promise<string>;
  currentBranch(cwd: string): Promise<string | null>;
  realPath?(path: string): Promise<string>;
  gitRoot?(cwd: string): Promise<string | null>;
}

export type WorkspaceRoutingErrorCode =
  | 'CONFIGURATION_INVALID'
  | 'UNKNOWN_PROJECT'
  | 'NON_PRODUCT_PROJECT'
  | 'UNKNOWN_BRANCH'
  | 'WORKSPACE_UNAVAILABLE'
  | 'BRANCH_MISMATCH'
  | 'SHARED_LIBS_UNAVAILABLE'
  | 'SHARED_LIBS_LINK_INVALID'
  | 'SHARED_LIBS_BRANCH_MISMATCH';

export type WorkspaceRouteResult = {
  ok: true;
  project: string;
  branch: string;
  cwd: string;
  sharedLibrariesPath?: string;
  hotfix?: import('./hotfix-worktree.ts').HotfixWorkspace;
} | {
  ok: false;
  error: { code: WorkspaceRoutingErrorCode; message: string };
};

function failure(code: WorkspaceRoutingErrorCode, message: string): WorkspaceRouteResult {
  return { ok: false, error: { code, message } };
}

export function resolveDevelopmentBranch(project: string, config: WorkspaceProjectsConfig): { ok: true; branch: string } | Extract<WorkspaceRouteResult, { ok: false }> {
  const entry = Object.hasOwn(config.projects, project) ? config.projects[project] : undefined;
  if (!entry) return { ok: false, error: { code: 'UNKNOWN_PROJECT', message: `Unknown project: ${project}.` } };
  const profile = typeof entry.profile === 'string' && config.profiles && Object.hasOwn(config.profiles, entry.profile) ? config.profiles[entry.profile] : undefined;
  const branch = profile?.development;
  if (typeof branch !== 'string' || !branch.trim() || branch !== branch.trim()) return { ok: false, error: { code: 'CONFIGURATION_INVALID', message: `conf/projects.json#/profiles/${entry.profile}/development must name a development branch for project ${project}.` } };
  return { ok: true, branch };
}

export function configuredWorkspaceRoute(request: WorkspaceRouteRequest, config: WorkspaceProjectsConfig): WorkspaceRouteResult {
  const { root, project, branch } = request;
  if (['learning', 'grok', 'startups'].includes(project)) return failure('NON_PRODUCT_PROJECT', `${project} is a non-product repository.`);
  if (!Object.hasOwn(config.projects, project)) return failure('UNKNOWN_PROJECT', `Unknown project: ${project}.`);
  const entry = config.projects[project];
  const rootProject = project === 'orchestrator' && entry.path === '.';
  const development = rootProject ? resolveDevelopmentBranch(project, config) : undefined;
  if (development && !development.ok) return development;
  const available = rootProject && development?.ok ? [development.branch] : Object.keys(entry.branchPaths ?? {});
  const path = rootProject ? development?.ok && branch === development.branch ? '.' : undefined
    : entry.branchPaths && Object.hasOwn(entry.branchPaths, branch) ? entry.branchPaths[branch] : undefined;
  if (typeof path !== 'string' || !path.trim()) return failure('UNKNOWN_BRANCH', `conf/projects.json#/projects/${project}/branchPaths/${branch}: no workspace for project ${project}, profile ${entry.profile}, branch ${branch}; available routes: ${available.join(', ') || '(none)'}.`);
  return { ok: true, project, branch, cwd: resolve(root, path) };
}

export async function resolveWorkspaceRoute(
  request: WorkspaceRouteRequest,
  config: WorkspaceProjectsConfig,
  dependencies: WorkspaceRoutingDependencies,
): Promise<WorkspaceRouteResult> {
  const { root, project, branch } = request;
  const configured = configuredWorkspaceRoute(request, config);
  if (!configured.ok) return configured;
  const entry = config.projects[project];
  const rootProject = project === 'orchestrator' && entry.path === '.';
  let cwd = configured.cwd;
  try {
    if (rootProject && dependencies.realPath) cwd = await dependencies.realPath(cwd);
    const kind = await dependencies.pathKind(cwd);
    if (kind === 'symlink' && project === 'raf' && branch === 'main' && entry.mainCopies !== undefined) {
      const copies = entry.mainCopies;
      if (!Array.isArray(copies) || copies.length !== 2 || new Set(copies).size !== 2 || copies.some(copy => typeof copy !== 'string' || !copy || isAbsolute(copy) || copy.includes('\\') || copy.split('/').some(part => ['', '.', '..', '.git'].includes(part)))) return failure('CONFIGURATION_INVALID', 'raf mainCopies must contain two distinct physical paths within the Orchestrator root.');
      if (!dependencies.realPath || !dependencies.gitRoot) return failure('WORKSPACE_UNAVAILABLE', 'Canonical main target and Git root verification required.');
      const active = await dependencies.realPath(cwd);
      if (!copies.map(copy => resolve(root, copy)).includes(active) || await dependencies.pathKind(active) !== 'directory' || await dependencies.gitRoot(active) !== active) return failure('WORKSPACE_UNAVAILABLE', `Workspace ${cwd} does not point to a registered physical main worktree.`);
    } else if (kind !== 'directory') {
      return failure('WORKSPACE_UNAVAILABLE', `Workspace ${cwd} is not an available directory.`);
    }
    if (rootProject && dependencies.gitRoot && await dependencies.gitRoot(cwd) !== cwd) return failure('WORKSPACE_UNAVAILABLE', `Workspace ${cwd} is not the Orchestrator Git root.`);
    const actual = await dependencies.currentBranch(cwd);
    if (actual !== branch) {
      return failure('BRANCH_MISMATCH', `Workspace ${cwd} is on ${actual ?? 'detached HEAD'}; expected ${branch}.`);
    }
  } catch (error) {
    return failure('WORKSPACE_UNAVAILABLE', `Cannot inspect workspace ${cwd}: ${String(error)}.`);
  }
  const result: WorkspaceRouteResult = { ok: true, project, branch, cwd };
  if (!entry.usesSharedLibs) return result;
  const library = Object.hasOwn(config.projects, 'shared-libs') ? config.projects['shared-libs'] : undefined;
  if (!library?.branchPaths || !Object.hasOwn(library.branchPaths, branch)) {
    return failure('SHARED_LIBS_UNAVAILABLE', `No shared-libs workspace configured for branch ${branch}.`);
  }
  const libraryPath = resolve(root, library.branchPaths[branch]);
  const linkPath = join(cwd, 'shared-libs');
  try {
    if (await dependencies.pathKind(linkPath) !== 'symlink') {
      return failure('SHARED_LIBS_LINK_INVALID', `${linkPath} must be a symbolic link to ${libraryPath}.`);
    }
    const target = await dependencies.readLink(linkPath);
    if (resolve(cwd, target) !== libraryPath) {
      return failure('SHARED_LIBS_LINK_INVALID', `${linkPath} points to ${target}; expected ${libraryPath}.`);
    }
  } catch (error) {
    return failure('SHARED_LIBS_LINK_INVALID', `Cannot inspect shared-libs link ${linkPath}: ${String(error)}.`);
  }
  try {
    if (await dependencies.pathKind(libraryPath) !== 'directory') {
      return failure('SHARED_LIBS_UNAVAILABLE', `Shared libraries ${libraryPath} are not an available directory.`);
    }
    const actual = await dependencies.currentBranch(libraryPath);
    if (actual !== branch) {
      return failure('SHARED_LIBS_BRANCH_MISMATCH', `Shared libraries ${libraryPath} are on ${actual ?? 'detached HEAD'}; expected ${branch}.`);
    }
  } catch (error) {
    return failure('SHARED_LIBS_UNAVAILABLE', `Cannot inspect shared libraries ${libraryPath}: ${String(error)}.`);
  }
  return { ...result, sharedLibrariesPath: linkPath };
}
