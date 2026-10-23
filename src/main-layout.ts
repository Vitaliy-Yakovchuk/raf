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

export async function validateMainLayoutForStart(
  options: MainLayoutValidationOptions,
): Promise<MainLayoutValidationResult> {
  throw new Error('NotImplemented');
}

export async function ensureMainLayoutForStart(
  options: MainLayoutStartOptions,
): Promise<MainLayoutStartResult> {
  throw new Error('NotImplemented');
}
