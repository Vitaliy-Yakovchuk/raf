import { randomUUID } from 'node:crypto';
import { createMainSymlinkSwitch, assertMainReleaseLayout } from './main-symlink-release.ts';
import { createProductionMainSymlinkStorage } from './main-symlink-storage.ts';
import { withReleaseWriter } from './hotfix-host.ts';
import type { MainReleaseIntent } from './main-symlink-release.ts';
import type { HotfixHost } from './hotfix-worktree.ts';
import type { HotfixActivationOptions, HotfixActivationResult, HotfixRecoveryResult, VerifiedHotfix, activateHotfix, recoverHotfixActivation } from './hotfix-activation.ts';

export async function activateMainSymlinkHotfix(
  host: HotfixHost,
  candidate: VerifiedHotfix,
  options: HotfixActivationOptions,
  validate: (host: HotfixHost, candidate: VerifiedHotfix) => Promise<unknown>,
  publish: typeof activateHotfix,
): Promise<HotfixActivationResult> {
  const storage = createProductionMainSymlinkStorage(host);
  return storage.withPublicationLock(() => withReleaseWriter(host, candidate.workspace, candidate.snapshot?.source ?? 'hotfix', async () => {
    if (await storage.readIntent()) throw new Error('Main publication recovery required');
    await validate(host, candidate);
    const before = await storage.inspect();
    assertMainReleaseLayout(before, storage.logicalPath);
    if (before.head === candidate.commit) {
      if (before.slots[before.active].fingerprint !== candidate.fingerprint) throw new Error('Active main differs from verified snapshot');
      return { status: 'already-active', commit: candidate.commit, fingerprint: candidate.fingerprint, generationRoot: before.slots[before.active].root };
    }
    if (before.head !== candidate.workspace.baseCommit) throw new Error('Stale hotfix base commit');
    const destination = before.active === 'a' ? 'b' : 'a';
    const prepared = await storage.prepareVerified(candidate, destination);
    const previous = await storage.inspect();
    assertMainReleaseLayout(previous, storage.logicalPath);
    for (const key of ['active', 'head', 'mainRef', 'indexTree', 'gitlink', 'gitmodules', 'foreignIndexFingerprint'] as const) if (JSON.stringify(before[key]) !== JSON.stringify(previous[key])) throw new Error('Main changed while preparing inactive slot: ' + key);
    const intent: MainReleaseIntent = { id: randomUUID(), previous, candidate: prepared, destination };
    const provider = options.switchProvider ?? createMainSymlinkSwitch(storage);
    const generationRoot = prepared.workspace.cwd;
    return publish(host, prepared, {
      ...options,
      switchProvider: provider,
      publication: {
        currentDirectory: storage.logicalPath,
        preparedDirectory: previous.slots[destination].root,
        generationRoot,
        async assertSnapshot() {
          await validate(host, candidate);
          await storage.assertSnapshot(prepared);
          const current = await storage.inspect();
          assertMainReleaseLayout(current, storage.logicalPath);
          for (const key of ['active', 'slots', 'head', 'mainRef', 'indexTree', 'gitlink', 'gitmodules', 'foreignIndexFingerprint'] as const) if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) throw new Error('Main publication base changed: ' + key);
          if (!current.handoverComplete || current.readers[destination].length) throw new Error('Inactive main slot busy');
          const pending = await storage.readIntent();
          if (pending && pending.id !== intent.id) throw new Error('Another main publication requires recovery');
        },
        writeIntent: () => storage.writeIntent(intent),
        reconcileGit: () => storage.reconcileGit(intent, destination),
        clearIntent: () => storage.clearIntent(intent.id),
        async rollback() {
          await provider.exchange(storage.logicalPath, previous.slots[previous.active].root);
          await storage.reconcileGit(intent, previous.active);
        },
      },
    });
  }, candidate.snapshot?.sourceWorkspace));
}

export async function recoverMainSymlinkHotfix(host: HotfixHost, recover: typeof recoverHotfixActivation): Promise<HotfixRecoveryResult> {
  const storage = createProductionMainSymlinkStorage(host);
  return storage.withPublicationLock(async () => {
    const intent = await storage.readIntent();
    if (!intent) {
      const state = await storage.inspect();
      assertMainReleaseLayout(state, storage.logicalPath);
      return { status: 'idle', commit: state.head, fingerprint: state.slots[state.active].fingerprint, pending: !state.handoverComplete };
    }
    return recover(host, { publication: {
      async reconcile() {
        const state = await storage.inspect();
        if (![intent.previous.active, intent.destination].includes(state.active)) throw new Error('Unrecognized recovery slot');
        if (state.active === intent.destination) await storage.assertSnapshot(intent.candidate, false);
        else if (!await storage.resolvePublished(state.slots[state.active].root, intent.previous.slots[state.active].fingerprint)) throw new Error('Recovery origin is not a retained publication');
        await storage.reconcileGit(intent, state.active);
        const current = await storage.inspect();
        assertMainReleaseLayout(current, storage.logicalPath);
        return { result: { status: 'recovered', commit: current.head, fingerprint: current.slots[current.active].fingerprint, pending: false }, generationRoot: current.slots[current.active].root };
      },
      clearIntent: () => storage.clearIntent(intent.id),
    } });
  });
}
