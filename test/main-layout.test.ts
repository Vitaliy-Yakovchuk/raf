import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateMainLayoutForStart,
  type MainLayoutGitRegistration,
  type MainLayoutPathInspection,
  type MainLayoutProbe,
  type MainLayoutProject,
  type MainLayoutRepositoryInspection,
  type MainLayoutValidationOptions,
} from '../src/main-layout.ts';

const root = '/fixture/orchestrator';
const sha = 'a'.repeat(40);
const olderSha = 'b'.repeat(40);

function configuration(): Record<string, MainLayoutProject> {
  return {
    raf: {
      path: 'raf-main', profile: 'raf',
      branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' },
      mainCopies: ['raf-main-a', 'raf-main-b'], usesSharedLibs: false,
    },
    other: {
      path: 'other-main', profile: 'fixture-other', branchPaths: { main: 'other-main' },
    },
  };
}

function repository(path: string, branch: string | null, head = sha): MainLayoutRepositoryInspection {
  return {
    identity: '/fixture/orchestrator/.git/modules/raf', head, branch,
    files: ['src/main.ts', 'build/main.js'].map((relativePath, index) => ({
      relativePath, canonicalPath: `${path}/${relativePath}`, device: 1,
      inode: (path.endsWith('-b') ? 200 : 100) + index,
    })),
  };
}

function model(ready: boolean, activeSlot = 'raf-main-a') {
  const projects = configuration();
  const paths = new Map<string, MainLayoutPathInspection>([
    [root, { kind: 'directory', canonicalPath: root }],
    [`${root}/raf-develop`, { kind: 'directory', canonicalPath: `${root}/raf-develop` }],
    [`${root}/raf-hotfix`, { kind: 'directory', canonicalPath: `${root}/raf-hotfix` }],
  ]);
  const repos = new Map<string, MainLayoutRepositoryInspection | null>();
  repos.set(`${root}/raf-develop`, repository(`${root}/raf-develop`, 'develop'));
  repos.set(`${root}/raf-hotfix`, repository(`${root}/raf-hotfix`, 'hotfix'));
  if (ready) {
    paths.set(`${root}/raf-main`, { kind: 'symlink', canonicalPath: `${root}/${activeSlot}` });
    for (const slot of projects.raf.mainCopies!) {
      const path = `${root}/${slot}`;
      paths.set(path, { kind: 'directory', canonicalPath: path });
      repos.set(path, repository(path, slot === activeSlot ? 'main' : null));
    }
    repos.set(`${root}/raf-main`, repos.get(`${root}/${activeSlot}`)!);
  } else {
    paths.set(`${root}/raf-main`, { kind: 'directory', canonicalPath: `${root}/raf-main` });
    repos.set(`${root}/raf-main`, repository(`${root}/raf-main`, 'main'));
  }
  const registration: MainLayoutGitRegistration = {
    modulePath: ready ? activeSlot : 'raf-main',
    gitlinkPath: ready ? activeSlot : 'raf-main', gitlinkHead: sha,
    logicalMode: ready ? '120000' : '160000',
  };
  const calls: string[] = [];
  const probe: MainLayoutProbe = {
    async inspectPath(path) {
      calls.push(`path:${path}`);
      return paths.get(path) ?? { kind: 'missing', canonicalPath: null };
    },
    async inspectRepository(path) {
      calls.push(`repository:${path}`);
      return repos.get(path) ?? null;
    },
    async inspectGitRegistration(path) {
      calls.push(`registration:${path}`);
      assert.equal(path, root);
      return registration;
    },
  };
  const options: MainLayoutValidationOptions = { root, projects, probe };
  return { projects, paths, repos, registration, calls, options };
}

test('unit: ordinary main is convertible with two absent destination slots', async () => {
  const f = model(false);
  const input = JSON.stringify(f.projects);
  const result = await validateMainLayoutForStart(f.options);
  assert.deepEqual(result, { state: 'legacy', activePath: `${root}/raf-main-a`, inactivePath: `${root}/raf-main-b` });
  assert.equal(JSON.stringify(f.projects), input);
  assert.ok(f.calls.includes(`repository:${root}/raf-main`));
  assert.ok(f.calls.every(call => !call.includes('other-main')), 'the two-copy exception only inspects raf');
});

for (const active of ['raf-main-a', 'raf-main-b']) {
  test(`unit: ready layout accepts active ${active} and detached previous inactive generation`, async () => {
    const f = model(true, active);
    const inactive = active === 'raf-main-a' ? 'raf-main-b' : 'raf-main-a';
    f.repos.get(`${root}/${inactive}`)!.head = olderSha;
    const before = JSON.stringify(f.projects);
    assert.deepEqual(await validateMainLayoutForStart(f.options), {
      state: 'ready', activePath: `${root}/${active}`, inactivePath: `${root}/${inactive}`,
    });
    assert.equal(JSON.stringify(f.projects), before);
    assert.ok(f.calls.includes(`path:${root}/${inactive}`));
    assert.ok(f.calls.includes(`repository:${root}/${inactive}`));
    assert.ok(f.calls.includes(`registration:${root}`));
  });
}

const invalidConfig: Array<[string, (project: MainLayoutProject) => void]> = [
  ['missing mainCopies', p => { delete p.mainCopies; }],
  ['empty mainCopies', p => { p.mainCopies = []; }],
  ['one slot', p => { p.mainCopies = ['raf-main-a']; }],
  ['three slots', p => { p.mainCopies = ['a', 'b', 'c']; }],
  ['non-array mainCopies', p => { p.mainCopies = 'raf-main-a' as unknown as string[]; }],
  ['non-string slot', p => { p.mainCopies = [42, 'raf-main-b'] as unknown as string[]; }],
  ['empty slot', p => { p.mainCopies = ['', 'raf-main-b']; }],
  ['duplicate', p => { p.mainCopies = ['raf-main-a', 'raf-main-a']; }],
  ['normalized duplicate', p => { p.mainCopies = ['raf-main-a', './raf-main-a']; }],
  ['absolute slot', p => { p.mainCopies = [`${root}/a`, 'raf-main-b']; }],
  ['root escape', p => { p.mainCopies = ['../elsewhere', 'raf-main-b']; }],
  ['root itself', p => { p.mainCopies = ['.', 'raf-main-b']; }],
  ['nested slots', p => { p.mainCopies = ['slots', 'slots/nested']; }],
  ['logical main slot', p => { p.mainCopies = ['raf-main', 'raf-main-b']; }],
  ['develop slot', p => { p.mainCopies = ['raf-develop', 'raf-main-b']; }],
  ['hotfix slot', p => { p.mainCopies = ['raf-hotfix', 'raf-main-b']; }],
  ['nested develop', p => { p.mainCopies = ['raf-develop/sub', 'raf-main-b']; }],
  ['ancestor of hotfix', p => {
    p.branchPaths = { ...p.branchPaths, hotfix: 'trees/hotfix' };
    p.mainCopies = ['trees', 'raf-main-b'];
  }],
  ['logical path changed', p => { p.path = 'raf-main-a'; }],
  ['logical branch path changed', p => { p.branchPaths = { ...p.branchPaths, main: 'raf-main-a' }; }],
];

function diagnostic(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.notEqual(error.message, 'NotImplemented');
  assert.match(error.message, /expected|очікуван/i);
  assert.match(error.message, /actual|фактичн/i);
  return true;
}

for (const [name, mutate] of invalidConfig) {
  test(`unit: config rejects ${name} before filesystem/process probes`, async () => {
    const f = model(false);
    mutate(f.projects.raf);
    await assert.rejects(() => validateMainLayoutForStart(f.options), diagnostic);
    assert.deepEqual(f.calls, [], 'syntactically invalid configuration is rejected before IO');
  });
}

type Model = ReturnType<typeof model>;
const invalidObservations: Array<[string, (f: Model) => void]> = [
  ['missing physical slot', f => { f.paths.delete(`${root}/raf-main-b`); }],
  ['physical slot is a file', f => { f.paths.set(`${root}/raf-main-b`, { kind: 'file', canonicalPath: `${root}/raf-main-b` }); }],
  ['physical slot is an alias', f => { f.paths.set(`${root}/raf-main-b`, { kind: 'symlink', canonicalPath: `${root}/raf-main-a` }); }],
  ['canonical duplicate', f => { f.paths.get(`${root}/raf-main-b`)!.canonicalPath = `${root}/raf-main-a`; }],
  ['canonical root escape', f => { f.paths.get(`${root}/raf-main-b`)!.canonicalPath = '/outside/slot'; }],
  ['canonical develop overlap', f => { f.paths.get(`${root}/raf-main-b`)!.canonicalPath = `${root}/raf-develop`; }],
  ['canonical hotfix overlap', f => { f.paths.get(`${root}/raf-main-b`)!.canonicalPath = `${root}/raf-hotfix`; }],
  ['cycle', f => { f.paths.set(`${root}/raf-main-b`, { kind: 'cycle', canonicalPath: null }); }],
  ['dangling logical symlink', f => { f.paths.get(`${root}/raf-main`)!.canonicalPath = null; }],
  ['logical target outside copies', f => { f.paths.get(`${root}/raf-main`)!.canonicalPath = `${root}/raf-develop`; }],
  ['foreign repository', f => { f.repos.get(`${root}/raf-main-b`)!.identity = '/foreign/repository'; }],
  ['non-repository slot', f => { f.repos.set(`${root}/raf-main-b`, null); }],
  ['active branch is not main', f => { f.repos.get(`${root}/raf-main-a`)!.branch = 'develop'; }],
  ['two main checkouts', f => { f.repos.get(`${root}/raf-main-b`)!.branch = 'main'; }],
  ['active commit differs from gitlink', f => { f.registration.gitlinkHead = olderSha; }],
  ['physical gitlink points to inactive', f => { f.registration.gitlinkPath = 'raf-main-b'; }],
  ['gitmodules points to logical main', f => { f.registration.modulePath = 'raf-main'; }],
  ['logical path still indexed as gitlink', f => { f.registration.logicalMode = '160000'; }],
  ['source hardlink alias', f => {
    const a = f.repos.get(`${root}/raf-main-a`)!.files[0];
    Object.assign(f.repos.get(`${root}/raf-main-b`)!.files[0], { device: a.device, inode: a.inode });
  }],
  ['build symlink alias', f => {
    const a = f.repos.get(`${root}/raf-main-a`)!.files[1];
    Object.assign(f.repos.get(`${root}/raf-main-b`)!.files[1], { canonicalPath: a.canonicalPath });
  }],
];

for (const [name, mutate] of invalidObservations) {
  test(`unit: inspected layout rejects ${name}`, async () => {
    const f = model(true);
    mutate(f);
    const before = JSON.stringify({ projects: f.projects, paths: [...f.paths], repos: [...f.repos], registration: f.registration });
    await assert.rejects(() => validateMainLayoutForStart(f.options), diagnostic);
    assert.equal(JSON.stringify({ projects: f.projects, paths: [...f.paths], repos: [...f.repos], registration: f.registration }), before,
      'validation never repairs or rewrites observations');
  });
}

test('unit: foreign occupied destination blocks legacy conversion', async () => {
  const f = model(false);
  f.paths.set(`${root}/raf-main-a`, { kind: 'directory', canonicalPath: `${root}/raf-main-a` });
  await assert.rejects(() => validateMainLayoutForStart(f.options), diagnostic);
});
