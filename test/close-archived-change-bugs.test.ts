import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { BugWriteError } from '../src/bug-sync.ts';
import { formatCanonicalBugKey, parseCanonicalBugKey } from '../src/bug-store.ts';
import {
  ArchivedBugLeaseError,
  closeBugsNamedByArchivedChange,
  createArchivedBugCloser,
  observeArchivedChangeBugCloses,
  type ArchiveBugCloseMemory,
  type CloseArchivedBugsPorts,
} from '../src/close-archived-change-bugs.ts';

test('archive settlement shares one active-change snapshot at live OpenSpec cardinalities', async t => {
  const root = rootDir();
  const remembered = memory();
  const archives = Array.from({ length: 1434 }, (_, i) => `2026-11-07-fixture-${i}`);
  for (let i = 0; i < 104; i++) {
    writeChange(root, `active-${i}`, `projects/raf/bug#${i}\n${'fixture '.repeat(500)}`, '- [ ] 1.1 Pending\n');
  }
  for (let i = 0; i < archives.length; i++) {
    writeChange(root, archives[i], `projects/raf/bug#${i}\n`, '- [x] 1.1 Complete\n', true);
  }
  remembered.write({ active: [], archives: archives.slice(11) });
  const writer = ports();
  const close = createArchivedBugCloser(root, writer);
  const read = fs.readFile;
  const activeReads: string[] = [];
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    const path = String(args[0]);
    if (path.includes('/changes/active-')) activeReads.push(path);
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    const started = performance.now();
    await observeArchivedChangeBugCloses(root, remembered, close);
    const wallMs = performance.now() - started;
    t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', message: JSON.stringify({ archives: 1434, active: 104, pendingArchives: 11, activeReads: activeReads.length, wallMs, budgetMs: 500 }), location: null, stack: [], redacted: false, truncated: false }], evidence: [] }));
    assert.equal(writer.comments.length, 11);
    assert.equal(writer.fixed.length, 0);
    assert.equal(remembered.snapshot()?.archives.length, 1434);
    assert.equal(activeReads.length, 208, 'Read each active proposal and tasks once per command');
    assert.ok(wallMs < 500, `Archive settlement exceeded the reminder list budget: ${wallMs}ms`);
    writeChange(root, 'new-active', 'projects/raf/bug#2000\n', '- [ ] 1.1 Pending\n');
    writeChange(root, '2026-11-07-new-archive', 'projects/raf/bug#2000\n', '- [x] 1.1 Complete\n', true);
    await observeArchivedChangeBugCloses(root, remembered, createArchivedBugCloser(root, writer));
    assert.deepEqual(writer.comments.at(-1), { bugKey: 'projects/raf/bug#2000', active: ['new-active'] }, 'The next command observes newly added changes');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('production archive observer records a completed archive without opening bug services when it has no bug keys', async t => {
  const root = rootDir();
  const home = join(root, 'home');
  const path = join(home, '.raf', 'archived-bug-close.json');
  mkdirSync(join(home, '.raf'), { recursive: true });
  writeFileSync(path, JSON.stringify({ active: [], archives: [] }));
  writeChange(root, '2026-11-07-without-bugs', 'No bug references.\n', '- [x] 1.1 Complete\n', true);
  const warnings: unknown[] = [];
  t.mock.method(process, 'emitWarning', (warning: unknown) => { warnings.push(warning); });
  try {
    const { closeArchivedBugsForHome } = await import('../src/close-archived-change-bugs-production.ts');
    await closeArchivedBugsForHome(root, home);
    const { readFileSync } = await import('node:fs');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).archives, ['2026-11-07-without-bugs']);
    assert.deepEqual(warnings, [], 'A no-op archive requires no bug configuration or network client');
    writeChange(root, '2026-11-07-with-bug', 'projects/raf/bug#123\n', '- [x] 1.1 Complete\n', true);
    await closeArchivedBugsForHome(root, home);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).archives, ['2026-11-07-without-bugs'], 'Real bug work remains pending when its configuration is unavailable');
    assert.equal(warnings.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const stillActive of [false, true]) {
  test(`archive observer consumes definitive Dash not-found once (active=${stillActive})`, async t => {
    const root = rootDir();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const remembered = memory();
    remembered.write({ active: [], archives: [] });
    const archives = Array.from({ length: 11 }, (_, i) => `2026-11-07-missing-${i}`).sort();
    for (let i = 0; i < archives.length; i++) {
      writeChange(root, archives[i], `projects/raf/bug#${i}`, '- [x] Complete\n', true);
      if (stillActive) writeChange(root, `active-${i}`, `projects/raf/bug#${i}`, '- [ ] Pending\n');
    }
    let calls = 0;
    const missing = async () => {
      calls++;
      throw new BugWriteError('BUG_WRITE_REJECTED', 'Dash refused the read: not-found', { serverCode: 'not-found', status: 404 });
    };
    const writer = { ...ports(), setFixed: missing, commentRemaining: missing };
    t.mock.method(process, 'emitWarning', () => {});
    await observeArchivedChangeBugCloses(root, remembered, createArchivedBugCloser(root, writer));
    assert.equal(calls, 11, 'Each new archive checks its bug once');
    assert.deepEqual(remembered.snapshot()?.archives, archives, 'A definitive missing bug leaves no remote operation to retry');
    await observeArchivedChangeBugCloses(root, remembered, createArchivedBugCloser(root, writer));
    assert.equal(calls, 11, 'Unchanged commands do not repeat eleven remote reads');
  });
}

test('archive observer keeps rejected and uncertain Dash operations pending', async t => {
  const root = rootDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(process, 'emitWarning', () => {});
  writeChange(root, '2026-11-07-retry-archive', 'projects/raf/bug#1', '- [x] Complete\n', true);
  for (const error of [
    new BugWriteError('BUG_WRITE_REJECTED', 'Forbidden', { serverCode: 'forbidden', status: 403 }),
    new BugWriteError('BUG_WRITE_UNKNOWN', 'Unknown', { serverCode: 'not-found', status: 404 }),
    new BugWriteError('BUG_WRITE_UNKNOWN', 'Network', { serverCode: 'network' }),
  ]) {
    const remembered = memory();
    remembered.write({ active: [], archives: [] });
    let calls = 0;
    const writer = { ...ports(), setFixed: async () => { calls++; throw error; } };
    await observeArchivedChangeBugCloses(root, remembered, createArchivedBugCloser(root, writer));
    await observeArchivedChangeBugCloses(root, remembered, createArchivedBugCloser(root, writer));
    assert.equal(calls, 2);
    assert.deepEqual(remembered.snapshot()?.archives, []);
  }
});
