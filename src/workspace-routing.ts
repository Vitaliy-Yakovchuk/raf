import { resolve, join } from 'node:path';

export interface WorkspaceProjectsConfig {
  projects: Record<string, {
    path: string;
    profile: string;
    branchPaths?: Record<string, string>;
    usesSharedLibs?: boolean;
  }>;
}

export interface WorkspaceRouteRequest {
  root: string;
  project: string;
  branch: string;
}

export interface WorkspaceRoutingDependencies {
  pathKind(path: string): Promise<'directory' | 'symlink' | 'file' | 'missing'>;
  readLink(path: string): Promise<string>;
  currentBranch(cwd: string): Promise<string | null>;
}

export type WorkspaceRoutingErrorCode =
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
} | {
  ok: false;
  error: { code: WorkspaceRoutingErrorCode; message: string };
};

function failure(code: WorkspaceRoutingErrorCode, message: string): WorkspaceRouteResult {
  return { ok: false, error: { code, message } };
}

export async function resolveWorkspaceRoute(
  request: WorkspaceRouteRequest,
  config: WorkspaceProjectsConfig,
  dependencies: WorkspaceRoutingDependencies,
): Promise<WorkspaceRouteResult> {
  const { root, project, branch } = request;
  if (['learning', 'grok', 'startups'].includes(project)) {
    return failure('NON_PRODUCT_PROJECT', `${project} is a non-product repository.`);
  }
  if (!Object.hasOwn(config.projects, project)) {
    return failure('UNKNOWN_PROJECT', `Unknown project: ${project}.`);
  }
  const entry = config.projects[project];
  if (!entry.branchPaths || !Object.hasOwn(entry.branchPaths, branch)) {
    return failure('UNKNOWN_BRANCH', `No configured workspace for ${project} branch ${branch}.`);
  }
  const cwd = resolve(root, entry.branchPaths[branch]);
  try {
    if (await dependencies.pathKind(cwd) !== 'directory') {
      return failure('WORKSPACE_UNAVAILABLE', `Workspace ${cwd} is not an available directory.`);
    }
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
