import type {
  AtomicHotfixSwitch,
  HotfixActivationOptions,
  HotfixActivationResult,
  HotfixCheckpoint,
  HotfixRecoveryResult,
  VerifiedHotfix,
  activateHotfix,
  recoverHotfixActivation,
  verifyHotfixCandidate,
} from "./hotfix-activation.ts";
import type { HotfixHost, HotfixWorkspace } from "./hotfix-worktree.ts";

export type MainSlot = "a" | "b";
export type MainReleaseSource = { kind: "develop" | "hotfix"; workspace: HotfixWorkspace };
export type MainReleaseSnapshot = {
  active: MainSlot;
  slots: Record<MainSlot, { root: string; commit: string; fingerprint: string }>;
  mainRef: string;
  head: string;
  indexTree: string;
  gitlink: { path: string; commit: string; repository: string };
  gitmodules: { path: string; repository: string };
  foreignIndexFingerprint: string;
  activationComplete: boolean;
  handoverComplete: boolean;
  readers: Record<MainSlot, readonly string[]>;
};
export type MainReleaseIntent = {
  id: string;
  previous: MainReleaseSnapshot;
  candidate: VerifiedHotfix;
  destination: MainSlot;
};
export type PreparedMainRelease = {
  source: MainReleaseSource;
  destination: MainSlot;
  previous: MainReleaseSnapshot;
  candidate: VerifiedHotfix;
};
export type MainReleaseRequest = {
  source: MainReleaseSource;
  regression: { executable: string; args: readonly string[] };
  mainAddress: string;
  message: string;
};
export type MainReleasePublication = HotfixActivationResult & {
  active: MainSlot;
  handoverComplete: boolean;
};
export interface MainSymlinkStorage {
  logicalPath: string;
  inspect(): Promise<MainReleaseSnapshot>;
  withPublicationLock<T>(operation: () => Promise<T>): Promise<T>;
  prepareInactive(source: MainReleaseSource, destination: MainSlot): Promise<HotfixWorkspace>;
  assertSnapshot(candidate: VerifiedHotfix): Promise<void>;
  readIntent(): Promise<MainReleaseIntent | undefined>;
  writeIntent(intent: MainReleaseIntent): Promise<void>;
  probeRename(): Promise<{ supported: boolean; sameDevice: boolean }>;
  createTemporarySymlink(target: string): Promise<string>;
  renameSymlink(temporary: string, logical: string): Promise<void>;
  removeTemporarySymlink(temporary: string): Promise<void>;
  reconcileGit(intent: MainReleaseIntent, active: MainSlot): Promise<void>;
  clearIntent(id: string): Promise<void>;
  resolvePublished(root: string, fingerprint: string): Promise<boolean>;
  loadPublished(slot: MainSlot): Promise<VerifiedHotfix>;
}
export interface MainReleasePorts {
  host: HotfixHost;
  storage: MainSymlinkStorage;
  shared: {
    verify: typeof verifyHotfixCandidate;
    activate: typeof activateHotfix;
    recover: typeof recoverHotfixActivation;
  };
  compatibility(previous: MainReleaseSnapshot, candidate: VerifiedHotfix): Promise<{ compatible: boolean; reason?: string }>;
  confirmHandover(active: MainSlot): Promise<boolean>;
  checkpoint?(phase: HotfixCheckpoint): Promise<void>;
}
export class MainSymlinkRelease {
  constructor(ports: MainReleasePorts) {
    throw new Error("NotImplemented");
  }

  prepare(request: MainReleaseRequest): Promise<PreparedMainRelease> {
    throw new Error("NotImplemented");
  }

  publish(prepared: PreparedMainRelease): Promise<MainReleasePublication> {
    throw new Error("NotImplemented");
  }

  recover(): Promise<HotfixRecoveryResult> {
    throw new Error("NotImplemented");
  }

  rollback(previous: PreparedMainRelease): Promise<MainReleasePublication> {
    throw new Error("NotImplemented");
  }

  resolveProduction(root: string, fingerprint: string): Promise<{ root: string; commit: string; fingerprint: string }> {
    throw new Error("NotImplemented");
  }
}

export function createMainSymlinkRelease(ports: MainReleasePorts): MainSymlinkRelease {
  throw new Error("NotImplemented");
}

export function createMainSymlinkSwitch(storage: MainSymlinkStorage): AtomicHotfixSwitch {
  throw new Error("NotImplemented");
}

export function mainSymlinkActivationOptions(
  storage: MainSymlinkStorage,
  checkpoint?: (phase: HotfixCheckpoint) => Promise<void>,
): HotfixActivationOptions {
  throw new Error("NotImplemented");
}
