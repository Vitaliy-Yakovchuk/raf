import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
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
  mainRef?: string;
  head: string;
  indexTree?: string;
  gitlink?: { path: string; commit: string; repository: string };
  gitmodules?: { path: string; repository: string };
  foreignIndexFingerprint?: string;
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
  prepareVerified(candidate: VerifiedHotfix, destination: MainSlot): Promise<VerifiedHotfix>;
  assertSnapshot(candidate: VerifiedHotfix, checkSource?: boolean): Promise<void>;
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

const other = (slot: MainSlot): MainSlot => slot === 'a' ? 'b' : 'a';
const gates = ['build', 'regression', 'runtime-import', 'help', 'agent-ps', 'agent-message', 'service-start', 'service-ready', 'service-status', 'service-stop'] as const;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export function assertMainReleaseLayout(state: MainReleaseSnapshot, logicalPath: string): void {
  const slot = state.slots[state.active];
  if (!slot || state.slots.a.root === state.slots.b.root || Object.values(state.slots).some(value => resolve(value.root) !== value.root || value.root === logicalPath)) throw failure('MAIN_LAYOUT_INVALID', 'Main physical layout mismatch');
}

function assertFree(state: MainReleaseSnapshot, destination: MainSlot): void {
  if (state.active === destination || !state.activationComplete || !state.handoverComplete || state.readers[destination].length) throw failure('MAIN_SLOT_BUSY', 'Inactive main slot busy: activation, handover or readers pending');
}

function assertBase(previous: MainReleaseSnapshot, current: MainReleaseSnapshot): void {
  if (previous.active !== current.active || (['a', 'b'] as const).some(slot => previous.slots[slot].root !== current.slots[slot].root || previous.slots[slot].fingerprint !== current.slots[slot].fingerprint)) throw failure('MAIN_BASE_STALE', 'Main files changed');
}

function assertGates(candidate: VerifiedHotfix, host: HotfixHost): void {
  if (gates.some(name => !candidate.gates.some(gate => gate.name === name && gate.status === 'passed' && gate.code === 0 && gate.commit === candidate.commit && gate.fingerprint === candidate.fingerprint && gate.home === host.qaHome))) throw new Error('Common verification gates incomplete, skipped or failed');
}

export class MainSymlinkRelease {
  private readonly ports: MainReleasePorts;

  constructor(ports: MainReleasePorts) {
    this.ports = ports;
  }

  async prepare(request: MainReleaseRequest): Promise<PreparedMainRelease> {
    const { storage, shared, host } = this.ports;
    return storage.withPublicationLock(async () => {
      if (await storage.readIntent()) throw failure('MAIN_RECOVERY_REQUIRED', 'Pending publication intent requires recovery before preparation');
      const previous = await storage.inspect();
      assertMainReleaseLayout(previous, storage.logicalPath);
      const destination = other(previous.active);
      assertFree(previous, destination);
      const verified = await shared.verify(host, { workspace: request.source.workspace, regression: request.regression, mainAddress: request.mainAddress, message: request.message, source: request.source.kind });
      assertGates(verified, host);
      const candidate = await storage.prepareVerified(verified, destination);
      await storage.assertSnapshot(candidate);
      await this.compatible(previous, candidate);
      const current = await storage.inspect();
      assertMainReleaseLayout(current, storage.logicalPath);
      if (current.active !== previous.active || current.slots[previous.active].root !== previous.slots[previous.active].root || current.slots[previous.active].fingerprint !== previous.slots[previous.active].fingerprint) throw new Error('Main changed during preparation');
      return { source: request.source, destination, previous: current, candidate };
    });
  }

  async publish(prepared: PreparedMainRelease): Promise<MainReleasePublication> {
    const { storage } = this.ports;
    return storage.withPublicationLock(async () => {
      if (await storage.readIntent()) throw failure('MAIN_RECOVERY_REQUIRED', 'Pending publication intent requires recovery');
      const current = await storage.inspect();
      assertBase(prepared.previous, current);
      assertMainReleaseLayout(current, storage.logicalPath);
      assertFree(current, prepared.destination);
      return this.activate(prepared.candidate, current, prepared.destination);
    });
  }

  private async compatible(previous: MainReleaseSnapshot, candidate: VerifiedHotfix): Promise<void> {
    const result = await this.ports.compatibility(previous, candidate);
    if (!result.compatible) throw failure(result.reason ?? 'MAIN_INCOMPATIBLE', 'Incompatible main release/rollback: ' + (result.reason ?? 'shared state or protocol'));
  }

  private async activate(candidate: VerifiedHotfix, previous: MainReleaseSnapshot, destination: MainSlot, requireFree = true): Promise<MainReleasePublication> {
    const { storage, shared, host } = this.ports;
    assertGates(candidate, host);
    await storage.assertSnapshot(candidate, requireFree);
    await this.compatible(previous, candidate);
    const support = await storage.probeRename();
    if (!support.supported) throw failure('ATOMIC_SWITCH_UNSUPPORTED', 'Atomic symlink rename unsupported');
    if (!support.sameDevice) throw failure('EXDEV', 'Atomic symlink rename requires the same filesystem');
    const intent: MainReleaseIntent = { id: randomUUID(), previous, candidate, destination };
    const options = mainSymlinkActivationOptions(storage, this.ports.checkpoint);
    options.publication = {
      currentDirectory: storage.logicalPath,
      preparedDirectory: previous.slots[destination].root,
      assertSnapshot: async () => {
        await storage.assertSnapshot(candidate, requireFree);
        await this.compatible(previous, candidate);
        const current = await storage.inspect();
        assertMainReleaseLayout(current, storage.logicalPath);
        assertBase(previous, current);
        const pending = await storage.readIntent();
        if (pending && !same(pending, intent)) throw failure('MAIN_RECOVERY_REQUIRED', 'Another publication intent requires recovery');
        if (requireFree) assertFree(pending ? { ...current, activationComplete: true } : current, destination);
      },
      writeIntent: () => storage.writeIntent(intent),
      reconcileGit: () => storage.reconcileGit(intent, destination),
      clearIntent: () => storage.clearIntent(intent.id),
    };
    const result = await shared.activate(host, candidate, options);
    const handoverComplete = await this.ports.confirmHandover(destination);
    if (!handoverComplete) throw failure('MAIN_HANDOVER_INCOMPLETE', 'Main handover failed; previous slot retained for rollback');
    return { ...result, active: destination, handoverComplete };
  }

  async recover(): Promise<HotfixRecoveryResult> {
    const { storage, shared, host } = this.ports;
    return storage.withPublicationLock(async () => {
      const intent = await storage.readIntent();
      if (!intent) {
        const state = await storage.inspect();
        assertMainReleaseLayout(state, storage.logicalPath);
        return { status: 'idle', ...state.slots[state.active], pending: !state.activationComplete || !state.handoverComplete };
      }
      const result = await shared.recover(host, { publication: { reconcile: async () => {
        const state = await storage.inspect();
        const active = state.active;
        if (active !== intent.previous.active && active !== intent.destination) throw new Error('Unrecognized publication recovery slot');
        const expected = active === intent.destination ? intent.candidate : intent.previous.slots[active];
        if (active === intent.destination) await storage.assertSnapshot(intent.candidate, false);
        else if (state.slots[active].commit !== expected.commit || state.slots[active].fingerprint !== expected.fingerprint) throw new Error('Recovery snapshot fingerprint mismatch');
        if (!await storage.resolvePublished(state.slots[active].root, expected.fingerprint) && active !== intent.destination) throw new Error('Recovery origin is not a retained published snapshot');
        await this.compatible(intent.previous, intent.candidate);
        await storage.reconcileGit(intent, active);
        return { result: { status: 'recovered', commit: expected.commit, fingerprint: expected.fingerprint, pending: false }, generationRoot: state.slots[active].root };
      }, clearIntent: () => storage.clearIntent(intent.id) } });
      if (result.pending) return result;
      const state = await storage.inspect();
      assertMainReleaseLayout(state, storage.logicalPath);
      if (!await this.ports.confirmHandover(state.active)) return { ...result, pending: true };
      return { ...result, status: 'recovered', pending: false };
    });
  }

  async rollback(previous: PreparedMainRelease): Promise<MainReleasePublication> {
    const { storage } = this.ports;
    return storage.withPublicationLock(async () => {
      if (await storage.readIntent()) throw failure('MAIN_RECOVERY_REQUIRED', 'Pending publication intent requires recovery before rollback');
      const current = await storage.inspect();
      assertMainReleaseLayout(current, storage.logicalPath);
      const destination = previous.previous.active;
      const candidate = await storage.loadPublished(destination);
      const expected = previous.previous.slots[destination];
      if (candidate.commit !== expected.commit || candidate.fingerprint !== expected.fingerprint || !await storage.resolvePublished(expected.root, expected.fingerprint)) throw new Error('Previous published snapshot changed or retired');
      await this.compatible(current, candidate);
      if (current.active === destination) {
        assertMainReleaseLayout(current, storage.logicalPath);
        return { status: 'already-active', commit: candidate.commit, fingerprint: candidate.fingerprint, generationRoot: expected.root, active: destination, handoverComplete: await this.ports.confirmHandover(destination) };
      }
      return this.activate(candidate, current, destination, false);
    });
  }

  async resolveProduction(root: string, fingerprint: string): Promise<{ root: string; commit: string; fingerprint: string }> {
    const { storage } = this.ports;
    return storage.withPublicationLock(async () => {
      if (await storage.readIntent()) throw new Error('Publication recovery pending; production admission refused');
      if (!await storage.resolvePublished(root, fingerprint)) throw failure('MAIN_GENERATION_UNPUBLISHED', 'Unpublished or changed production origin');
      const state = await storage.inspect();
      const entry = Object.entries(state.slots).find(([, slot]) => slot.root === root && slot.fingerprint === fingerprint);
      if (!entry || entry[0] !== state.active && !state.readers[entry[0] as MainSlot].length) throw failure('MAIN_GENERATION_UNPUBLISHED', 'Retired production generation');
      return { root, commit: entry[1].commit, fingerprint };
    });
  }
}

export function createMainSymlinkRelease(ports: MainReleasePorts): MainSymlinkRelease {
  return new MainSymlinkRelease(ports);
}

export function createMainSymlinkSwitch(storage: MainSymlinkStorage): AtomicHotfixSwitch {
  return {
    probe: async () => storage.probeRename(),
    exchange: async (current, prepared) => {
      if (current !== storage.logicalPath) throw new Error('Unregistered logical main symlink');
      const state = await storage.inspect();
      if (!Object.values(state.slots).some(slot => slot.root === prepared)) throw new Error('Unregistered main slot target');
      const support = await storage.probeRename();
      if (!support.supported) throw failure('ATOMIC_SWITCH_UNSUPPORTED', 'Atomic symlink rename unsupported');
      if (!support.sameDevice) throw failure('EXDEV', 'Atomic symlink rename requires the same filesystem');
      const temporary = await storage.createTemporarySymlink(prepared);
      try {
        if (dirname(temporary) !== dirname(current) || temporary === current) throw new Error('Atomic symlink temporary must share logical parent');
        await storage.renameSymlink(temporary, current);
      } catch (primary) {
        await storage.removeTemporarySymlink(temporary).catch(() => {});
        throw primary;
      }
      await storage.removeTemporarySymlink(temporary);
    },
  };
}

export function mainSymlinkActivationOptions(
  storage: MainSymlinkStorage,
  checkpoint?: (phase: HotfixCheckpoint) => Promise<void>,
): HotfixActivationOptions {
  return { switchProvider: createMainSymlinkSwitch(storage), checkpoint };
}

export { createProductionMainSymlinkStorage } from './main-symlink-storage.ts';
