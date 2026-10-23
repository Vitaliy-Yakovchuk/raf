import type { HotfixCleanupResult, HotfixHost, HotfixWorkspace } from "./hotfix-worktree.ts";

export type HotfixGateName = "build" | "regression" | "runtime-import" | "help" | "agent-ps" | "agent-message" | "service-start" | "service-ready" | "service-status" | "service-stop";
export type HotfixCheckpoint = "before-intent" | "after-intent" | "before-switch" | "after-switch" | "after-refs" | "after-index" | "after-smoke" | "before-cleanup" | "after-cleanup";
export type HotfixReaderKind = "cli" | "service" | "worker" | "hook" | "notice";

export interface HotfixSnapshotFile {
  path: string;
  sha256: string;
}

export interface HotfixGateEvidence {
  name: HotfixGateName;
  status: "passed" | "failed" | "skipped" | "timeout";
  code: number | null;
  command: readonly string[];
  cwd: string;
  home: string;
  commit: string;
  fingerprint: string;
  logPath: string;
}

export interface VerifiedHotfix {
  workspace: HotfixWorkspace;
  commit: string;
  tree: string;
  fingerprint: string;
  files: readonly HotfixSnapshotFile[];
  configuration: readonly HotfixSnapshotFile[];
  gates: readonly HotfixGateEvidence[];
  evidencePath: string;
}

export interface HotfixVerificationRequest {
  workspace: HotfixWorkspace;
  regression: { executable: string; args: readonly string[] };
  mainAddress: string;
  message: string;
}

export interface AtomicHotfixSwitch {
  probe(currentDirectory: string, preparedDirectory: string): Promise<{ supported: boolean; sameDevice: boolean }>;
  exchange(currentDirectory: string, preparedDirectory: string): Promise<void>;
}

export interface HotfixActivationOptions {
  checkpoint?: (phase: HotfixCheckpoint) => Promise<void>;
  switchProvider?: AtomicHotfixSwitch;
}

export interface HotfixActivationResult {
  status: "activated" | "already-active";
  commit: string;
  fingerprint: string;
  generationRoot: string;
}

export interface HotfixRecoveryResult {
  status: "idle" | "recovered";
  commit: string;
  fingerprint: string;
  pending: boolean;
}

export interface HotfixReaderLease {
  id: string;
  generationRoot: string;
  commit: string;
  fingerprint: string;
  release(): Promise<void>;
}

export async function verifyHotfixCandidate(_host: HotfixHost, _request: HotfixVerificationRequest): Promise<VerifiedHotfix> {
  throw new Error("NotImplemented: verifyHotfixCandidate");
}

export async function activateHotfix(_host: HotfixHost, _candidate: VerifiedHotfix, _options?: HotfixActivationOptions): Promise<HotfixActivationResult> {
  throw new Error("NotImplemented: activateHotfix");
}

export async function recoverHotfixActivation(_host: HotfixHost): Promise<HotfixRecoveryResult> {
  throw new Error("NotImplemented: recoverHotfixActivation");
}

export async function cleanupHotfixActivation(_host: HotfixHost): Promise<HotfixCleanupResult> {
  throw new Error("NotImplemented: cleanupHotfixActivation");
}

export async function acquireHotfixReader(_host: HotfixHost, _kind: HotfixReaderKind): Promise<HotfixReaderLease> {
  throw new Error("NotImplemented: acquireHotfixReader");
}

export function createAtomicHotfixSwitch(): AtomicHotfixSwitch {
  throw new Error("NotImplemented: createAtomicHotfixSwitch");
}
