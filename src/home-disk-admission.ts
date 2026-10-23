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
  throw new Error('NotImplemented');
}
