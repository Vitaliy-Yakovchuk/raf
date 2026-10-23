export interface ResourceAdmissionVolumePaths {
  readonly orchestratorRoot: string;
  readonly workspace: string;
  readonly home: string;
}

export interface ResourceAdmissionVolumes {
  readonly requiredFileSystemIds: string[];
  readonly homeFileSystemId: string | null;
  readonly reasons: string[];
}

export function deriveResourceAdmissionVolumes(
  paths: ResourceAdmissionVolumePaths,
  fileSystemByPath: Readonly<Record<string, string | null>>,
): ResourceAdmissionVolumes {
  const reasons: string[] = [];
  const identify = (path: string, label: string): string | null => {
    const id = typeof path === 'string' && path.trim() ? fileSystemByPath[path] : null;
    if (typeof id === 'string' && id.trim()) return id;
    reasons.push(`Missing filesystem mapping for ${label}: ${path}`);
    return null;
  };
  const development = [identify(paths.orchestratorRoot, 'Orchestrator root'), identify(paths.workspace, 'development workspace')];
  const homeFileSystemId = identify(paths.home, 'HOME');
  return { requiredFileSystemIds: [...new Set(development.filter((id): id is string => id !== null))], homeFileSystemId, reasons };
}
