import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { settleArchiveEvents } from '../src/archive-events-runtime.ts';
import { closeBugsNamedByArchivedChange, type CloseArchivedBugsPorts } from '../src/close-archived-change-bugs.ts';
import type { EventCatalog } from '../src/event-registry.ts';
import { runGitFreeCommand } from '../src/git.ts';
import { pruneArchivedTestGroups } from '../src/prune-archived-test-groups.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';
import type { Reminder } from '../src/reminders.ts';

const registrationSubject = 'conf: agent test group registrations (auto)';

const catalog: EventCatalog = {
  events: [{ id: 'openspec.archived', idKind: 'changeId', description: 'Change archived' }],
  eventIdKinds: { changeId: 'OpenSpec change id' },
};

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Archive observation fixture',
    GIT_AUTHOR_EMAIL: 'archive-observation@example.invalid',
    GIT_COMMITTER_NAME: 'Archive observation fixture',
    GIT_COMMITTER_EMAIL: 'archive-observation@example.invalid',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  return env;
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function text(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readConf(root: string): { projects: { raf: { groups: Record<string, unknown> } } } {
  return JSON.parse(readFileSync(join(root, 'conf', 'test-runs.json'), 'utf8'));
}

function showGroups(root: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  return JSON.parse(git(root, env, 'show', 'HEAD:conf/test-runs.json')).projects.raf.groups;
}

function writeChange(root: string, name: string, proposal: string, tasks: string, archived = false): void {
  const dir = join(root, 'openspec', 'changes', ...(archived ? ['archive', name] : [name]));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proposal.md'), proposal);
  writeFileSync(join(dir, 'tasks.md'), tasks);
}

function reminder(id: string): Reminder {
  return {
    id: 'rem-bound', createdFor: 'main', assignedTo: 'worker', text: 'Після архівації',
    at: '2099-01-01T00:00:00.000Z', binding: { kind: 'openspec.archived', id, action: 'close' },
    state: 'pending', closedAt: null, closeReason: null,
  };
}

function writer(): CloseArchivedBugsPorts & { fixed: { bugKey: string; reason: string }[] } {
  const fixed: { bugKey: string; reason: string }[] = [];
  return {
    fixed,
    async setFixed(bugKey, reason) { fixed.push({ bugKey, reason }); },
    async commentRemaining() {},
    async wait() {},
  };
}

test('архів зміни без нагадування прибирає групи й закриває жука', async () => {
  const root = mkdtempSync(join(tmpdir(), 'raf-archive-without-reminder-'));
  const env = environment();
  const bin = join(root, 'bin');
  const previousPath = process.env.PATH;
  let store: StateStore | undefined;
  try {
    mkdirSync(join(root, 'conf'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'openspec'), `#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const archived = process.argv.includes('--archived');
const dir = join(process.cwd(), 'openspec', 'changes', ...(archived ? ['archive'] : []));
let entries = [];
try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const changes = entries.filter(entry => entry.isDirectory() && entry.name !== 'archive').map(entry => {
  let body = '';
  try { body = readFileSync(join(dir, entry.name, 'tasks.md'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tasks = [...body.matchAll(/^\\s*-\\s+\\[([ xX])\\]\\s+(.+)$/gm)];
  return { name: entry.name, totalTasks: tasks.length, completedTasks: tasks.filter(task => task[1].toLowerCase() === 'x').length };
});
process.stdout.write(JSON.stringify({ changes }));
`, { mode: 0o755 });
    const committed = {
      projects: {
        raf: {
          groups: {
            'plain-change/unit': { files: ['plain.test.ts'] },
            'bound-change/unit': { files: ['bound.test.ts'] },
          },
          profiles: { node: { kind: 'unit', unitFiles: ['kept.test.ts'] } },
        },
      },
    };
    writeFileSync(join(root, 'conf', 'test-runs.json'), text(committed));
    git(root, env, 'init', '-q', '-b', 'main');
    git(root, env, 'config', 'user.name', 'Archive observation fixture');
    git(root, env, 'config', 'user.email', 'archive-observation@example.invalid');
    git(root, env, 'config', 'commit.gpgsign', 'false');
    git(root, env, 'add', '--', 'conf/test-runs.json');
    git(root, env, 'commit', '-qm', 'baseline');
    writeChange(root, 'plain-change', 'projects/raf/bug#344\n', '- [ ] ще відкрито\n');
    writeChange(root, 'bound-change', 'без жука\n', '- [ ] ще відкрито\n');
    store = openStateStore(join(root, 'state.sqlite'));
    store.reminderRepository.transaction(tx => tx.save(reminder('bound-change')));
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    const settle = settleArchiveEvents as (
      store: StateStore, root: string, catalog: EventCatalog, effects?: { closeBugs?(changeId: string): Promise<void> },
    ) => Promise<void>;
    await settle(store, root, catalog, { async closeBugs() { throw new Error('active change must not close bugs'); } });
    rmSync(join(root, 'openspec', 'changes', 'plain-change'), { recursive: true, force: true });
    rmSync(join(root, 'openspec', 'changes', 'bound-change'), { recursive: true, force: true });
    writeChange(root, '2026-11-01-plain-change', 'projects/raf/bug#344\n', '- [x] готово\n', true);
    writeChange(root, '2026-11-01-bound-change', 'без жука\n', '- [x] готово\n', true);
    const fixed: { bugKey: string; reason: string }[] = [];
    const invoked: string[] = [];
    await settle(store, root, catalog, {
      async closeBugs(changeId) {
        invoked.push(changeId);
        const ports = writer();
        await closeBugsNamedByArchivedChange(root, changeId, ports);
        fixed.push(...ports.fixed);
      },
    });
    assert.deepEqual(invoked.sort(), ['bound-change', 'plain-change']);
    assert.deepEqual(fixed, [{ bugKey: 'projects/raf/bug#344', reason: 'зміна plain-change заархівована' }]);
    assert.equal(Object.hasOwn(readConf(root).projects.raf.groups, 'plain-change/unit'), false);
    assert.equal(Object.hasOwn(readConf(root).projects.raf.groups, 'bound-change/unit'), false);
    assert.equal(Object.hasOwn(showGroups(root, env), 'plain-change/unit'), false);
    assert.equal(Object.hasOwn(showGroups(root, env), 'bound-change/unit'), false);
    assert.deepEqual(readConf(root).projects.raf.profiles, committed.projects.raf.profiles);
    const events = store.eventRepository.transaction(tx => tx.listPending()
      .filter(fact => fact.event.kind === 'openspec.archived').map(fact => fact.event.id).sort());
    assert.deepEqual(events, ['bound-change']);
  } finally {
    process.env.PATH = previousPath;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('архів зміни в зоні без git прибирає її групи з conf', async () => {
  const root = mkdtempSync(join(tmpdir(), 'raf-archive-no-git-'));
  const env = environment();
  const bin = join(root, 'bin');
  const previousPath = process.env.PATH;
  let store: StateStore | undefined;
  try {
    mkdirSync(join(root, 'conf'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'openspec'), `#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const archived = process.argv.includes('--archived');
const dir = join(process.cwd(), 'openspec', 'changes', ...(archived ? ['archive'] : []));
let entries = [];
try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const changes = entries.filter(entry => entry.isDirectory() && entry.name !== 'archive').map(entry => {
  let body = '';
  try { body = readFileSync(join(dir, entry.name, 'tasks.md'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tasks = [...body.matchAll(/^\\s*-\\s+\\[([ xX])\\]\\s+(.+)$/gm)];
  return { name: entry.name, totalTasks: tasks.length, completedTasks: tasks.filter(task => task[1].toLowerCase() === 'x').length };
});
process.stdout.write(JSON.stringify({ changes }));
`, { mode: 0o755 });
    const committed = {
      projects: {
        raf: {
          groups: {
            'fix-x/unit': { files: ['unit.test.ts'] },
            'fix-x/regression': { files: ['regression.test.ts'] },
          },
          profiles: { node: { kind: 'unit', unitFiles: ['kept.test.ts'] } },
        },
      },
    };
    writeFileSync(join(root, 'conf', 'test-runs.json'), text(committed));
    git(root, env, 'init', '-q', '-b', 'main');
    git(root, env, 'config', 'user.name', 'Archive observation fixture');
    git(root, env, 'config', 'user.email', 'archive-observation@example.invalid');
    git(root, env, 'config', 'commit.gpgsign', 'false');
    git(root, env, 'add', '--', 'conf/test-runs.json');
    git(root, env, 'commit', '-qm', 'baseline');
    const parent = git(root, env, 'rev-parse', 'HEAD');
    const dirty = readConf(root);
    dirty.projects.raf.groups['kept-change/unit'] = { files: ['stay.test.ts'] };
    writeFileSync(join(root, 'conf', 'test-runs.json'), text(dirty));
    writeChange(root, 'fix-x', 'projects/raf/bug#5b27f80a\n', '- [ ] ще відкрито\n');
    store = openStateStore(join(root, 'state.sqlite'));
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    const settle = settleArchiveEvents as (
      store: StateStore, root: string, catalog: EventCatalog,
    ) => Promise<void>;
    await runGitFreeCommand('agent ps', async () => {
      await settle(store!, root, catalog);
      rmSync(join(root, 'openspec', 'changes', 'fix-x'), { recursive: true, force: true });
      writeChange(root, '2026-11-01-fix-x', 'projects/raf/bug#5b27f80a\n', '- [x] готово\n', true);
      await settle(store!, root, catalog);
    });
    const current = readConf(root);
    assert.equal(Object.hasOwn(current.projects.raf.groups, 'fix-x/unit'), false);
    assert.equal(Object.hasOwn(current.projects.raf.groups, 'fix-x/regression'), false);
    assert.deepEqual(current.projects.raf.groups['kept-change/unit'], { files: ['stay.test.ts'] });
    assert.deepEqual(current.projects.raf.profiles, committed.projects.raf.profiles);
    assert.equal(git(root, env, 'rev-parse', 'HEAD'), parent);
    assert.equal(Object.hasOwn(showGroups(root, env), 'fix-x/unit'), true);
    assert.equal(Object.hasOwn(showGroups(root, env), 'fix-x/regression'), true);
    await pruneArchivedTestGroups(root);
    const head = git(root, env, 'rev-parse', 'HEAD');
    assert.equal(git(root, env, 'rev-list', '--count', `${parent}..${head}`), '1');
    assert.equal(git(root, env, 'log', '-1', '--format=%s'), registrationSubject);
    assert.equal(Object.hasOwn(showGroups(root, env), 'fix-x/unit'), false);
    assert.equal(Object.hasOwn(showGroups(root, env), 'fix-x/regression'), false);
    assert.equal(Object.hasOwn(showGroups(root, env), 'kept-change/unit'), false);
    assert.deepEqual(readConf(root).projects.raf.groups['kept-change/unit'], { files: ['stay.test.ts'] });
    assert.deepEqual(readConf(root).projects.raf.profiles, committed.projects.raf.profiles);
  } finally {
    process.env.PATH = previousPath;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
