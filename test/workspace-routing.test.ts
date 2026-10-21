import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkspaceRoute } from '../src/workspace-routing.ts';
import type {
  WorkspaceProjectsConfig,
  WorkspaceRouteResult,
  WorkspaceRoutingDependencies,
  WorkspaceRoutingErrorCode,
} from '../src/workspace-routing.ts';

const root = '/workspace/orchestrator';


function fixture() {
  const config: WorkspaceProjectsConfig = {
    projects: {
      raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' }, usesSharedLibs: false },
      app: { path: 'app-main', profile: 'product', branchPaths: { main: 'app-main', develop: 'app-develop', release: 'app-release' }, usesSharedLibs: true },
      'shared-libs': { path: 'shared-libs-main', profile: 'library', branchPaths: { main: 'shared-libs-main', develop: 'shared-libs-develop', release: 'shared-libs-release' }, usesSharedLibs: false },
      orchestrator: { path: '.', profile: 'orchestrator' },
    },
  };
  const kinds = new Map<string, 'directory' | 'symlink' | 'file' | 'missing'>();
  const branches = new Map<string, string | null>();
  const links = new Map<string, string>();
  for (const project of Object.values(config.projects)) {
    for (const [branch, path] of Object.entries(project.branchPaths ?? {})) {
      kinds.set(`${root}/${path}`, 'directory');
      branches.set(`${root}/${path}`, branch);
      if (project.usesSharedLibs) {
        kinds.set(`${root}/${path}/shared-libs`, 'symlink');
        links.set(`${root}/${path}/shared-libs`, `../shared-libs-${branch}`);
      }
    }
  }
  const reads: string[] = [];
  const dependencies: WorkspaceRoutingDependencies = {
    async pathKind(path) { reads.push(path); return kinds.get(path) ?? 'missing'; },
    async readLink(path) {
      reads.push(path);
      const target = links.get(path);
      if (target === undefined) throw new Error('Not a link');
      return target;
    },
    async currentBranch(path) {
      reads.push(path);
      if (!branches.has(path)) throw new Error('Not a Git repository');
      return branches.get(path)!;
    },
  };
  return { config, kinds, branches, links, reads, dependencies,
    route(project = 'app', branch = 'develop') {
      return resolveWorkspaceRoute({ root, project, branch }, config, dependencies);
    },
  };
}

function failure(result: WorkspaceRouteResult, code: WorkspaceRoutingErrorCode) {
  assert.equal(result.ok, false, `Expected ${code}; received ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.equal(result.error.code, code);
  assert.ok(result.error.message.trim().length > 0, 'Failure must explain why routing was refused');
}

test('selects develop from branchPaths rather than the default main path', async () => {
  const f = fixture();
  assert.deepEqual(await f.route('raf'), { ok: true, project: 'raf', branch: 'develop', cwd: `${root}/raf-develop` });
  assert.ok(f.reads.includes(`${root}/raf-develop`), 'Actual tree must be checked');
  assert.ok(!f.reads.some(path => path.includes('shared-libs') || path.includes('raf-main')));
});

test('different branch tasks keep distinct cwd and local same-branch libraries', async () => {
  const f = fixture();
  for (const branch of ['develop', 'release']) {
    assert.deepEqual(await f.route('app', branch), {
      ok: true, project: 'app', branch, cwd: `${root}/app-${branch}`,
      sharedLibrariesPath: `${root}/app-${branch}/shared-libs`,
    });
    assert.ok(f.reads.includes(`${root}/shared-libs-${branch}`));
  }
});

test('shared-libs is itself a routable library without a recursive dependency', async () => {
  assert.deepEqual(await fixture().route('shared-libs'), {
    ok: true, project: 'shared-libs', branch: 'develop', cwd: `${root}/shared-libs-develop`,
  });
});

test('unknown project is refused before filesystem or Git access', async () => {
  const f = fixture();
  failure(await f.route('unknown'), 'UNKNOWN_PROJECT');
  assert.deepEqual(f.reads, []);
});

test('learning, grok and startups never receive product routing even if configured', async () => {
  for (const project of ['learning', 'grok', 'startups']) {
    const f = fixture();
    failure(await f.route(project), 'NON_PRODUCT_PROJECT');
    f.config.projects[project] = { path: project, profile: 'product', branchPaths: { develop: `${project}-develop` } };
    failure(await f.route(project), 'NON_PRODUCT_PROJECT');
    assert.deepEqual(f.reads, []);
  }
});

test('absent branch mapping never falls back to project.path or another branch', async () => {
  const f = fixture();
  failure(await f.route('raf', 'release'), 'UNKNOWN_BRANCH');
  assert.deepEqual(f.reads, []);
});

test('missing selected workspace is refused despite an available main tree', async () => {
  const f = fixture();
  f.kinds.delete(`${root}/raf-develop`);
  failure(await f.route('raf'), 'WORKSPACE_UNAVAILABLE');
  assert.ok(!f.reads.includes(`${root}/raf-main`));
});

test('actual wrong branch or detached HEAD refuses the requested workspace', async () => {
  for (const actual of ['main', null]) {
    const f = fixture();
    f.branches.set(`${root}/raf-develop`, actual);
    failure(await f.route('raf'), 'BRANCH_MISMATCH');
  }
});

test('non-Git workspace returns an explicit failure', async () => {
  const f = fixture();
  f.branches.delete(`${root}/raf-develop`);
  failure(await f.route('raf'), 'WORKSPACE_UNAVAILABLE');
});

test('a missing link, directory or regular file cannot replace the local symlink', async () => {
  for (const kind of ['missing', 'directory', 'file'] as const) {
    const f = fixture();
    f.kinds.set(`${root}/app-develop/shared-libs`, kind);
    failure(await f.route(), 'SHARED_LIBS_LINK_INVALID');
  }
});

test('wrong-branch or legacy library symlink is refused without fallback', async () => {
  for (const target of ['../shared-libs-main', '../shared-libs', '../shared-libs-release']) {
    const f = fixture();
    f.links.set(`${root}/app-develop/shared-libs`, target);
    failure(await f.route(), 'SHARED_LIBS_LINK_INVALID');
    assert.ok(!f.reads.includes(`${root}/shared-libs-main`));
  }
});

test('missing library branch mapping or target tree is refused', async () => {
  const unmapped = fixture();
  delete unmapped.config.projects['shared-libs'].branchPaths!.develop;
  failure(await unmapped.route(), 'SHARED_LIBS_UNAVAILABLE');
  const absent = fixture();
  absent.kinds.delete(`${root}/shared-libs-develop`);
  failure(await absent.route(), 'SHARED_LIBS_UNAVAILABLE');
  assert.ok(!absent.reads.includes(`${root}/shared-libs-main`));
});

test('library target must actually have the same Git branch, not merely the right directory name', async () => {
  for (const actual of ['main', null]) {
    const f = fixture();
    f.branches.set(`${root}/shared-libs-develop`, actual);
    failure(await f.route(), 'SHARED_LIBS_BRANCH_MISMATCH');
  }
});

test('unreadable symlink and non-Git library fail explicitly', async () => {
  const unreadable = fixture();
  unreadable.links.clear();
  failure(await unreadable.route(), 'SHARED_LIBS_LINK_INVALID');
  const nonGit = fixture();
  nonGit.branches.delete(`${root}/shared-libs-develop`);
  failure(await nonGit.route(), 'SHARED_LIBS_UNAVAILABLE');
});
