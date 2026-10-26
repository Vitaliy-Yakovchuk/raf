import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateMainLayoutForStart,
  type MainLayoutPathInspection,
  type MainLayoutProbe,
  type MainLayoutProject,
  type MainLayoutValidationOptions,
} from '../src/main-layout.ts';

const root = '/fixture/orchestrator';

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

function model(ready: boolean, activeSlot = 'raf-main-a') {
  const projects = configuration();
  const paths = new Map<string, MainLayoutPathInspection>([
    [root, { kind: 'directory', canonicalPath: root }],
    [`${root}/raf-develop`, { kind: 'directory', canonicalPath: `${root}/raf-develop` }],
    [`${root}/raf-hotfix`, { kind: 'directory', canonicalPath: `${root}/raf-hotfix` }],
  ]);
  if (ready) {
    paths.set(`${root}/raf-main`, { kind: 'symlink', canonicalPath: `${root}/${activeSlot}` });
    for (const slot of projects.raf.mainCopies!) {
      const path = `${root}/${slot}`;
      paths.set(path, { kind: 'directory', canonicalPath: path });
    }
  } else {
    paths.set(`${root}/raf-main`, { kind: 'directory', canonicalPath: `${root}/raf-main` });
  }
  const calls: string[] = [];
  const probe: MainLayoutProbe = {
    async inspectPath(path) {
      calls.push(`path:${path}`);
      return paths.get(path) ?? { kind: 'missing', canonicalPath: null };
    },
  };
  const options: MainLayoutValidationOptions = { root, projects, probe };
  return { projects, paths, calls, options };
}

test('unit: ordinary main is convertible with two absent destination slots', async () => {
  const f = model(false);
  const input = JSON.stringify(f.projects);
  const result = await validateMainLayoutForStart(f.options);
  assert.deepEqual(result, { state: 'legacy', activePath: `${root}/raf-main-a`, inactivePath: `${root}/raf-main-b` });
  assert.equal(JSON.stringify(f.projects), input);
  assert.ok(f.calls.every(call => !call.includes('other-main')), 'the two-copy exception only inspects raf');
});

for (const active of ['raf-main-a', 'raf-main-b']) {
  test(`unit: ready layout accepts active ${active} and detached previous inactive generation`, async () => {
    const f = model(true, active);
    const inactive = active === 'raf-main-a' ? 'raf-main-b' : 'raf-main-a';
    const before = JSON.stringify(f.projects);
    assert.deepEqual(await validateMainLayoutForStart(f.options), {
      state: 'ready', activePath: `${root}/${active}`, inactivePath: `${root}/${inactive}`,
    });
    assert.equal(JSON.stringify(f.projects), before);
    assert.ok(f.calls.includes(`path:${root}/${inactive}`));
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
];

for (const [name, mutate] of invalidObservations) {
  test(`unit: inspected layout rejects ${name}`, async () => {
    const f = model(true);
    mutate(f);
    const before = JSON.stringify({ projects: f.projects, paths: [...f.paths] });
    await assert.rejects(() => validateMainLayoutForStart(f.options), diagnostic);
    assert.equal(JSON.stringify({ projects: f.projects, paths: [...f.paths] }), before,
      'validation never repairs or rewrites observations');
  });
}

test('unit: foreign occupied destination blocks legacy conversion', async () => {
  const f = model(false);
  f.paths.set(`${root}/raf-main-a`, { kind: 'directory', canonicalPath: `${root}/raf-main-a` });
  await assert.rejects(() => validateMainLayoutForStart(f.options), diagnostic);
});
