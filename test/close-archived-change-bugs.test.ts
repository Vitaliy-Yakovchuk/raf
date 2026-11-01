import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatCanonicalBugKey, parseCanonicalBugKey } from '../src/bug-store.ts';
import {
  ArchivedBugLeaseError,
  closeBugsNamedByArchivedChange,
  observeArchivedChangeBugCloses,
  type ArchiveBugCloseMemory,
  type CloseArchivedBugsPorts,
} from '../src/close-archived-change-bugs.ts';

function rootDir(): string {
  return mkdtempSync(join(tmpdir(), 'raf-close-bugs-'));
}

function writeChange(root: string, name: string, proposal: string | undefined, tasks: string | undefined, archived = false): void {
  const dir = join(root, 'openspec', 'changes', ...(archived ? ['archive', name] : [name]));
  mkdirSync(dir, { recursive: true });
  if (proposal !== undefined) writeFileSync(join(dir, 'proposal.md'), proposal);
  if (tasks !== undefined) writeFileSync(join(dir, 'tasks.md'), tasks);
}

function ports(): CloseArchivedBugsPorts & {
  fixed: { bugKey: string; reason: string }[];
  comments: { bugKey: string; active: string[] }[];
  waits: number[];
  failLease: number;
} {
  const fixed: { bugKey: string; reason: string }[] = [];
  const comments: { bugKey: string; active: string[] }[] = [];
  const waits: number[] = [];
  const state = { failLease: 0 };
  return {
    fixed,
    comments,
    waits,
    get failLease() { return state.failLease; },
    set failLease(value: number) { state.failLease = value; },
    async setFixed(bugKey, reason) {
      if (state.failLease > 0) {
        state.failLease -= 1;
        throw new ArchivedBugLeaseError(1500);
      }
      fixed.push({ bugKey, reason });
    },
    async commentRemaining(bugKey, active) {
      comments.push({ bugKey, active: [...active] });
    },
    async wait(ms) { waits.push(ms); },
  };
}

function memory(): ArchiveBugCloseMemory & { snapshot(): { active: string[]; archives: string[] } | null } {
  let state: { active: string[]; archives: string[] } | null = null;
  return {
    read: () => state ? { active: [...state.active], archives: [...state.archives] } : null,
    write: next => { state = { active: [...next.active], archives: [...next.archives] }; },
    snapshot: () => state ? { active: [...state.active], archives: [...state.archives] } : null,
  };
}

test('заархівована зміна закриває жука з proposal текстом архівації', async () => {
  const root = rootDir();
  try {
    writeChange(root, '2026-11-01-close-bugs', 'Див. projects/raf/bug#344.\n', '- [x] готово\n', true);
    const writer = ports();
    const result = await closeBugsNamedByArchivedChange(root, 'close-bugs', writer);
    assert.equal(result.incomplete, false);
    assert.deepEqual(writer.fixed, [{ bugKey: 'projects/raf/bug#344', reason: 'зміна close-bugs заархівована' }]);
    assert.deepEqual(result.closed, ['projects/raf/bug#344']);
    assert.deepEqual(writer.comments, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ключ лише в tasks.md теж закривається', async () => {
  const root = rootDir();
  try {
    writeChange(root, 'tasks-only', 'без ключа\n', '- [x] projects/etchly/bug#12\n', true);
    const writer = ports();
    await closeBugsNamedByArchivedChange(root, 'tasks-only', writer);
    assert.deepEqual(writer.fixed.map(item => item.bugKey), ['projects/etchly/bug#12']);
    assert.equal(writer.fixed[0]?.reason, 'зміна tasks-only заархівована');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('активна зміна з тим самим ключем лишає жука відкритим і коментує перелік', async () => {
  const root = rootDir();
  try {
    writeChange(root, '2026-11-01-done-change', 'projects/etchly/bug#344\n', '- [x] готово\n', true);
    writeChange(root, 'still-open', 'Ще projects/etchly/bug#344\n', '- [ ] далі\n');
    const writer = ports();
    const result = await closeBugsNamedByArchivedChange(root, 'done-change', writer);
    assert.deepEqual(writer.fixed, []);
    assert.deepEqual(result.closed, []);
    assert.deepEqual(writer.comments, [{ bugKey: 'projects/etchly/bug#344', active: ['still-open'] }]);
    assert.deepEqual(result.skipped, [{ bugKey: 'projects/etchly/bug#344', active: ['still-open'] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ключ в tasks.md іншої активної зміни теж блокує закриття', async () => {
  const root = rootDir();
  try {
    writeChange(root, 'archived-one', 'projects/raf/bug#9\n', '- [x] готово\n', true);
    writeChange(root, 'beta-change', 'немає\n', 'залишилось projects/raf/bug#9\n');
    const writer = ports();
    await closeBugsNamedByArchivedChange(root, 'archived-one', writer);
    assert.deepEqual(writer.fixed, []);
    assert.deepEqual(writer.comments, [{ bugKey: 'projects/raf/bug#9', active: ['beta-change'] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lease-required повторює setFixed один раз після wait', async () => {
  const root = rootDir();
  try {
    writeChange(root, 'leased', 'projects/raf/bug#5\n', '- [x] готово\n', true);
    const writer = ports();
    writer.failLease = 1;
    const result = await closeBugsNamedByArchivedChange(root, 'leased', writer);
    assert.deepEqual(writer.waits, [1500]);
    assert.deepEqual(writer.fixed, [{ bugKey: 'projects/raf/bug#5', reason: 'зміна leased заархівована' }]);
    assert.deepEqual(result.retry, []);
    writer.failLease = 2;
    writer.fixed.length = 0;
    writer.waits.length = 0;
    const again = await closeBugsNamedByArchivedChange(root, 'leased', writer);
    assert.deepEqual(writer.waits, [1500]);
    assert.deepEqual(writer.fixed, []);
    assert.deepEqual(again.retry, [{ bugKey: 'projects/raf/bug#5', retryAfterMs: 1500 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('неповний перелік активних змін не закриває жука', async () => {
  const root = rootDir();
  try {
    writeChange(root, 'ready', 'projects/raf/bug#3\n', '- [x] готово\n', true);
    mkdirSync(join(root, 'openspec', 'changes', 'broken', 'proposal.md'), { recursive: true });
    const writer = ports();
    const result = await closeBugsNamedByArchivedChange(root, 'ready', writer);
    assert.equal(result.incomplete, true);
    assert.deepEqual(writer.fixed, []);
    assert.deepEqual(writer.comments, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('текст без ключа і дублікати дають рівно один виклик, кваліфікований ключ і id зі слешем зберігаються', async () => {
  const root = rootDir();
  try {
    const qualified = 'projects/raf/bug@proj/env/source/owner#raw-id';
    const slashed = 'projects/etchly/bug#vplyv-kavy-na-liudynu-19/1/0';
    const canonicalQualified = formatCanonicalBugKey(parseCanonicalBugKey(qualified));
    writeChange(
      root,
      'mixed',
      `не ключ bug#12 і ${qualified} та ${qualified}\n`,
      `- [x] ${slashed} і ще раз ${qualified}\n`,
      true,
    );
    const writer = ports();
    await closeBugsNamedByArchivedChange(root, 'mixed', writer);
    assert.deepEqual(writer.fixed.map(item => item.bugKey), [canonicalQualified, slashed]);
    assert.deepEqual(writer.fixed.map(item => item.reason), ['зміна mixed заархівована', 'зміна mixed заархівована']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('небезпечний ідентифікатор зміни нічого не закриває', async () => {
  const root = rootDir();
  try {
    writeChange(root, 'ok', 'projects/raf/bug#1\n', '- [x] готово\n', true);
    const writer = ports();
    const result = await closeBugsNamedByArchivedChange(root, '../ok', writer);
    assert.deepEqual(writer.fixed, []);
    assert.deepEqual(result.closed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('перший огляд лише запам’ятовує архіви, новий успішний архів закривається після виконаних tasks', async () => {
  const root = rootDir();
  try {
    writeChange(root, '2026-10-01-old-fix', 'projects/raf/bug#1\n', '- [x] готово\n', true);
    writeChange(root, 'live', 'projects/raf/bug#1\n', '- [ ] ні\n');
    const remembered = memory();
    const seen: string[] = [];
    await observeArchivedChangeBugCloses(root, remembered, async id => { seen.push(id); });
    assert.deepEqual(seen, []);
    assert.deepEqual(remembered.snapshot()?.archives, ['2026-10-01-old-fix']);
    writeChange(root, '2026-11-01-new-fix', 'projects/raf/bug#2\n', '- [ ] ще\n', true);
    await observeArchivedChangeBugCloses(root, remembered, async id => { seen.push(id); });
    assert.deepEqual(seen, []);
    writeFileSync(join(root, 'openspec', 'changes', 'archive', '2026-11-01-new-fix', 'tasks.md'), '- [x] готово\n');
    await observeArchivedChangeBugCloses(root, remembered, async id => { seen.push(id); });
    assert.deepEqual(seen, ['new-fix']);
    assert.ok(remembered.snapshot()?.archives.includes('2026-11-01-new-fix'));
    await observeArchivedChangeBugCloses(root, remembered, async id => { seen.push(id); });
    assert.deepEqual(seen, ['new-fix']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
