import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pruneArchivedChangeTestGroups } from '../src/prune-archived-test-groups.ts';

const subject = 'conf: agent test group registrations (auto)';

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Group prune fixture',
    GIT_AUTHOR_EMAIL: 'group-prune@example.invalid',
    GIT_COMMITTER_NAME: 'Group prune fixture',
    GIT_COMMITTER_EMAIL: 'group-prune@example.invalid',
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

function readConf(root: string): any {
  return JSON.parse(readFileSync(join(root, 'conf', 'test-runs.json'), 'utf8'));
}

function showConf(root: string, env: NodeJS.ProcessEnv, revision: string): any {
  return JSON.parse(git(root, env, 'show', `${revision}:conf/test-runs.json`));
}

function groupNames(doc: any): string[] {
  return Object.values(doc.projects).flatMap((project: any) => Object.keys(project.groups));
}

function repository(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'raf-prune-groups-'));
  const env = environment();
  mkdirSync(join(root, 'conf'), { recursive: true });
  git(root, env, 'init', '-q', '-b', 'main');
  git(root, env, 'config', 'user.name', 'Group prune fixture');
  git(root, env, 'config', 'user.email', 'group-prune@example.invalid');
  git(root, env, 'config', 'commit.gpgsign', 'false');
  return { root, env };
}

test('large reference scans preserve literal, nested, overlapping and Unicode group keys', async () => {
  const { root, env } = repository();
  try {
    const keys = ['fix-x/a', 'fix-x/a.b/c', 'fix-x/a.b', 'fix-x/дія', 'fix-x/key+[]', 'fix-x/a.b-only', 'fix-x/unreferenced'];
    writeFileSync(join(root, 'conf/test-runs.json'), text({ projects: { raf: {
      groups: Object.fromEntries(keys.map(key => [key, { files: ['fixture.test.ts'] }])),
    } } }));
    git(root, env, 'add', '--', 'conf/test-runs.json');
    git(root, env, 'commit', '-qm', 'baseline');
    const active = join(root, 'openspec/changes/active');
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, 'large.md'), 'Ж'.repeat(5 * 1024 * 1024) + '\nfix-x/a.b/cfix-x/key+[]\nfix-x/дія\nfix-x/axb-only\n');
    await pruneArchivedChangeTestGroups(root, 'fix-x');
    assert.deepEqual(groupNames(readConf(root)).sort(), keys.slice(0, 5).sort());
    assert.deepEqual(groupNames(showConf(root, env, 'HEAD')).sort(), keys.slice(0, 5).sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Архівація зміни прибирає її групи', async () => {
  const { root, env } = repository();
  try {
    const committed = {
      projects: {
        raf: {
          groups: {
            'fix-x/unit': { files: ['unit.test.ts'] },
            'fix-x/regression': { files: ['regression.test.ts'] },
            'fix-xy/unit': { files: ['neighbor.test.ts'] },
            'fix-x': { files: ['bare.test.ts'] },
          },
          profiles: { node: { kind: 'unit', unitFiles: ['kept.test.ts'], cwd: '.', executable: 'node', argv: ['./scripts/test-run-node.ts'] } },
        },
        other: {
          groups: { 'fix-x/regression': { files: ['more.test.ts'] } },
          profiles: { node: { kind: 'unit', unitFiles: ['profile-owned.test.ts'] } },
        },
      },
    };
    writeFileSync(join(root, 'conf', 'test-runs.json'), text(committed));
    writeFileSync(join(root, 'foreign.txt'), 'baseline\n');
    git(root, env, 'add', '--', 'conf/test-runs.json', 'foreign.txt');
    git(root, env, 'commit', '-qm', 'baseline');
    const parent = git(root, env, 'rev-parse', 'HEAD');
    const dirty = readConf(root);
    dirty.projects.raf.groups['kept-change/unit'] = { files: ['stay.test.ts'] };
    dirty.projects.raf.profiles.node.unitFiles = ['kept.test.ts', 'new-uncommitted.test.ts'];
    dirty.projects.other.profiles.node.note = 'uncommitted profile edit';
    writeFileSync(join(root, 'conf', 'test-runs.json'), text(dirty));
    writeFileSync(join(root, 'foreign.txt'), 'staged-line\n');
    git(root, env, 'add', '--', 'foreign.txt');
    writeFileSync(join(root, 'foreign.txt'), 'staged-line\nunstaged-line\n');
    const stagedForeign = git(root, env, 'diff', '--cached', '--', 'foreign.txt');
    const unstagedForeign = git(root, env, 'diff', '--', 'foreign.txt');
    mkdirSync(join(root, 'openspec', 'changes', 'archive', '2026-11-01-fix-x'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'changes', 'archive', '2026-11-01-fix-x', 'tasks.md'), '- [x] done fix-x/unit\n');
    await pruneArchivedChangeTestGroups(root, 'fix-x');
    const current = readConf(root);
    assert.deepEqual(groupNames(current).filter(key => key.startsWith('fix-x/')).sort(), []);
    assert.deepEqual(current.projects.raf.groups['fix-xy/unit'], { files: ['neighbor.test.ts'] });
    assert.deepEqual(current.projects.raf.groups['fix-x'], { files: ['bare.test.ts'] });
    assert.deepEqual(current.projects.raf.groups['kept-change/unit'], { files: ['stay.test.ts'] });
    assert.deepEqual(current.projects.raf.profiles.node.unitFiles, ['kept.test.ts', 'new-uncommitted.test.ts']);
    assert.equal(current.projects.other.profiles.node.note, 'uncommitted profile edit');
    const head = git(root, env, 'rev-parse', 'HEAD');
    assert.equal(git(root, env, 'rev-list', '--count', `${parent}..${head}`), '1');
    assert.equal(git(root, env, 'log', '-1', '--format=%s'), subject);
    const committedNow = showConf(root, env, 'HEAD');
    const committedParent = showConf(root, env, 'HEAD~1');
    assert.deepEqual(groupNames(committedNow).filter(key => key.startsWith('fix-x/')), []);
    assert.equal(Object.hasOwn(committedNow.projects.raf.groups, 'kept-change/unit'), false);
    assert.deepEqual(committedNow.projects.raf.profiles, committedParent.projects.raf.profiles);
    assert.deepEqual(committedNow.projects.other.profiles, committedParent.projects.other.profiles);
    assert.deepEqual(committedNow.projects.raf.groups['fix-xy/unit'], { files: ['neighbor.test.ts'] });
    assert.deepEqual(committedNow.projects.raf.groups['fix-x'], { files: ['bare.test.ts'] });
    assert.equal(git(root, env, 'diff', '--cached', '--', 'conf/test-runs.json'), '');
    assert.match(git(root, env, 'diff', '--', 'conf/test-runs.json'), /kept-change\/unit/);
    assert.match(git(root, env, 'diff', '--', 'conf/test-runs.json'), /new-uncommitted\.test\.ts/);
    assert.equal(git(root, env, 'diff', '--cached', '--', 'foreign.txt'), stagedForeign);
    assert.equal(git(root, env, 'diff', '--', 'foreign.txt'), unstagedForeign);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Група, на яку посилається активна зміна, лишається', async () => {
  const { root, env } = repository();
  try {
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
    git(root, env, 'add', '--', 'conf/test-runs.json');
    git(root, env, 'commit', '-qm', 'baseline');
    const parent = git(root, env, 'rev-parse', 'HEAD');
    mkdirSync(join(root, 'openspec', 'changes', 'still-open'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'changes', 'still-open', 'tasks.md'), '- [ ] keep the group fix-x/unit registered\n');
    writeFileSync(join(root, 'openspec', 'changes', 'still-open', 'proposal.md'), 'The archived change fix-x is mentioned only by id.\n');
    mkdirSync(join(root, 'openspec', 'changes', 'archive', '2026-11-01-fix-x'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'changes', 'archive', '2026-11-01-fix-x', 'tasks.md'), '- [x] archived fix-x/unit and fix-x/regression\n');
    await pruneArchivedChangeTestGroups(root, 'fix-x');
    const current = readConf(root);
    assert.deepEqual(current.projects.raf.groups['fix-x/unit'], { files: ['unit.test.ts'] });
    assert.equal(Object.hasOwn(current.projects.raf.groups, 'fix-x/regression'), false);
    assert.deepEqual(current.projects.raf.profiles, committed.projects.raf.profiles);
    const head = git(root, env, 'rev-parse', 'HEAD');
    assert.equal(git(root, env, 'rev-list', '--count', `${parent}..${head}`), '1');
    const committedNow = showConf(root, env, 'HEAD');
    assert.deepEqual(committedNow.projects.raf.groups['fix-x/unit'], { files: ['unit.test.ts'] });
    assert.equal(Object.hasOwn(committedNow.projects.raf.groups, 'fix-x/regression'), false);
    assert.deepEqual(committedNow.projects.raf.profiles, committed.projects.raf.profiles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Група, на яку посилається активна зміна, лишається без автокоміта, коли видаляти нічого', async () => {
  const { root, env } = repository();
  try {
    const committed = {
      projects: {
        raf: {
          groups: { 'fix-x/unit': { files: ['unit.test.ts'] } },
          profiles: { node: { kind: 'unit', unitFiles: ['kept.test.ts'] } },
        },
      },
    };
    writeFileSync(join(root, 'conf', 'test-runs.json'), text(committed));
    git(root, env, 'add', '--', 'conf/test-runs.json');
    git(root, env, 'commit', '-qm', 'baseline');
    const parent = git(root, env, 'rev-parse', 'HEAD');
    mkdirSync(join(root, 'openspec', 'changes', 'still-open'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'changes', 'still-open', 'tasks.md'), '- [ ] fix-x/unit stays\n');
    await pruneArchivedChangeTestGroups(root, 'fix-x');
    assert.deepEqual(readConf(root), committed);
    assert.equal(git(root, env, 'rev-parse', 'HEAD'), parent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
