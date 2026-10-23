export type HotfixRunner = "codex" | "claude";

export interface HotfixHost {
  orchestratorRoot: string;
  qaHome: string;
  environment: Readonly<Record<string, string>>;
  sandboxExecutable: string;
}

export interface HotfixWorkspace {
  runId: string;
  project: "raf";
  targetBranch: "main";
  cwd: string;
  baseCommit: string;
  repositoryIdentity: string;
  gitDirectory: string;
  commonDirectory: string;
  ownershipPath: string;
}

export interface HotfixLaunchRequest {
  runId: string;
  addressId: string;
  features: readonly string[];
  tasks: readonly string[];
  runner: HotfixRunner;
  origin: "agent-run" | "direct-main";
}

export interface HotfixLaunch {
  workspace: HotfixWorkspace;
  runId: string;
  pid: number;
  workerPid: number;
  reportPath: string;
  briefPath: string;
  taskContextPath: string;
  workerContextPath: string;
  invocationPath: string;
  trustTranscriptPath: string;
  runnerSessionId: string;
}

export interface HotfixCommand {
  executable: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}

export interface HotfixCommandResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface HotfixCommitRequest {
  workspace: HotfixWorkspace;
  paths: readonly string[];
  message: string;
}

export interface HotfixCommit {
  commit: string;
  tree: string;
  workspace: HotfixWorkspace;
}

export interface HotfixCleanupResult {
  removed: readonly string[];
  retained: readonly string[];
}

export async function prepareHotfixWorktree(_host: HotfixHost, _runId: string): Promise<HotfixWorkspace> {
  throw new Error("NotImplemented: prepareHotfixWorktree");
}

export async function launchHotfix(_host: HotfixHost, _request: HotfixLaunchRequest): Promise<HotfixLaunch> {
  throw new Error("NotImplemented: launchHotfix");
}

export async function runHotfixSandboxCommand(_host: HotfixHost, _workspace: HotfixWorkspace, _command: HotfixCommand): Promise<HotfixCommandResult> {
  throw new Error("NotImplemented: runHotfixSandboxCommand");
}

export async function commitHotfix(_host: HotfixHost, _request: HotfixCommitRequest): Promise<HotfixCommit> {
  throw new Error("NotImplemented: commitHotfix");
}

export async function cleanupHotfixWorktree(_host: HotfixHost, _workspace: HotfixWorkspace): Promise<HotfixCleanupResult> {
  throw new Error("NotImplemented: cleanupHotfixWorktree");
}
