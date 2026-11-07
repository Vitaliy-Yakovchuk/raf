import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createProductionBugPorts } from './bug-production.ts';
import { BugWriteError, type BugWriter } from './bug-sync.ts';
import type { BugRepository } from './bug-store.ts';
import {
  ArchivedBugLeaseError,
  closeBugsNamedByArchivedChange,
  noteHandledChangeArchives,
  observeArchivedChangeBugCloses,
  type ArchiveBugCloseMemory,
  type ArchiveBugCloseState,
  type CloseArchivedBugsPorts,
} from './close-archived-change-bugs.ts';

function fileMemory(path: string): ArchiveBugCloseMemory {
  return {
    read(): ArchiveBugCloseState | null {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ArchiveBugCloseState>;
        if (!parsed || !Array.isArray(parsed.active) || !Array.isArray(parsed.archives)) return null;
        if (!parsed.active.every(item => typeof item === 'string') || !parsed.archives.every(item => typeof item === 'string')) return null;
        return { active: parsed.active, archives: parsed.archives };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write(state) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state)}\n`);
      renameSync(temporary, path);
    },
  };
}

function archivedBugPorts(writer: () => Promise<BugWriter>): CloseArchivedBugsPorts {
  return {
    async setFixed(bugKey, reason) {
      try { await (await writer()).setStatus({ bugKey, status: 'fixed', reason }); }
      catch (error) {
        if (error instanceof BugWriteError && error.serverCode === 'lease-required') throw new ArchivedBugLeaseError(error.retryAfterMs);
        throw error;
      }
    },
    async commentRemaining(bugKey, activeChangeIds) {
      await (await writer()).addComment({ bugKey, text: `Активні зміни: ${[...activeChangeIds].sort().join(', ')}` });
    },
    async wait(ms) {
      if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
    },
  };
}

function openProduction(root: string, homeDirectory: string): { ports: CloseArchivedBugsPorts; finish(): void } {
  const production = createProductionBugPorts({ orchestratorRoot: root, homeDirectory });
  let repository: BugRepository | undefined;
  let writer: BugWriter | undefined;
  return {
    ports: archivedBugPorts(async () => {
      if (writer) return writer;
      const config = production.loadConfig();
      repository = production.openRepository(config);
      writer = production.writer(repository, config, await production.claims(config));
      return writer;
    }),
    finish() { repository?.close(); },
  };
}

export function openArchivedBugCloser(root: string, homeDirectory: string): { close(changeId: string): Promise<void>; finish(): void } | undefined {
  if (!homeDirectory || homeDirectory === process.env.RAF_QA_HOME) return undefined;
  const session = openProduction(root, homeDirectory);
  const memory = fileMemory(join(homeDirectory, '.raf', 'archived-bug-close.json'));
  return {
    async close(changeId) {
      const result = await closeBugsNamedByArchivedChange(root, changeId, session.ports);
      if (result.incomplete) return;
      if (result.retry.length) process.emitWarning(`archived bug close still lease-required for ${result.retry.map(item => item.bugKey).join(', ')}`);
      await noteHandledChangeArchives(root, memory, changeId);
    },
    finish() { session.finish(); },
  };
}

export async function closeArchivedBugsForHome(root: string, homeDirectory: string): Promise<void> {
  if (!homeDirectory || homeDirectory === process.env.RAF_QA_HOME) return;
  const session = openProduction(root, homeDirectory);
  try {
    await observeArchivedChangeBugCloses(root, fileMemory(join(homeDirectory, '.raf', 'archived-bug-close.json')), async changeId => {
      return closeBugsNamedByArchivedChange(root, changeId, session.ports);
    });
  } finally {
    session.finish();
  }
}
