import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import {
  ensureMainLayoutForStart,
  type MainLayoutCheckpoint,
  type MainLayoutProject,
  type MainLayoutStartOptions,
} from '../src/main-layout.ts';

import { ensureProductionMainStore } from '../src/main-production-store.ts';
import { processStart } from '../src/hotfix-host.ts';

type Fixture = {
  base: string;
  root: string;
  original: string;
  sha: string;
  projects: Record<string, MainLayoutProject>;
  options: MainLayoutStartOptions;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Layout fixture', GIT_AUTHOR_EMAIL: 'layout@example.invalid',
      GIT_COMMITTER_NAME: 'Layout fixture', GIT_COMMITTER_EMAIL: 'layout@example.invalid',
    },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function seed(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  for (const file of ['source.txt', 'staged.txt', 'unstaged.txt', 'deleted.txt', 'mode.sh', 'build/output.js']) {
    write(join(path, file), `committed ${file}\n`);
  }
  git(path, 'add', '--all');
  git(path, 'commit', '-m', 'Fixture main');
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'raf-layout-'));
  const root = join(base, 'orchestrator');
  try {
    const rafSource = join(base, 'raf-source');
    const otherSource = join(base, 'other-source');
    seed(rafSource);
    seed(otherSource);
    mkdirSync(root);
    git(root, 'init', '-b', 'main');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'raf', rafSource, 'raf-main');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'other', otherSource, 'other-main');
    const original = join(root, 'raf-main');
    git(original, 'worktree', 'add', '-b', 'develop', join(root, 'raf-develop'));
    git(original, 'worktree', 'add', '-b', 'hotfix', join(root, 'raf-hotfix'));
    const projects: Record<string, MainLayoutProject> = {
      raf: {
        path: 'raf-main', profile: 'raf',
        branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' },
        mainCopies: ['raf-main-a', 'raf-main-b'], usesSharedLibs: false,
      },
      other: {
        path: 'other-main', profile: 'fixture-other', branchPaths: { main: 'other-main' },
      },
    };
    writeConfiguration(root, projects);
    write(join(root, 'parent-staged.txt'), 'committed parent\n');
    git(root, 'add', '.gitmodules', 'raf-main', 'other-main', 'conf/projects.json', 'parent-staged.txt');
    git(root, 'commit', '-m', 'Fixture physical submodules');
    write(join(root, 'parent-staged.txt'), 'foreign staged parent\n');
    git(root, 'add', 'parent-staged.txt');
    write(join(root, 'parent-staged.txt'), 'foreign unstaged parent\n');
    write(join(root, 'parent-untracked.txt'), 'foreign parent untracked\n');
    write(join(original, 'staged.txt'), 'staged content\n');
    write(join(original, 'binary.bin'), new Uint8Array([0, 255, 128, 10]));
    git(original, 'add', 'staged.txt', 'binary.bin');
    write(join(original, 'staged.txt'), 'unstaged over staged content\n');
    write(join(original, 'unstaged.txt'), 'unstaged content\n');
    write(join(original, 'private/untracked.txt'), 'untracked main\n');
    chmodSync(join(original, 'mode.sh'), 0o755);
    rmSync(join(original, 'deleted.txt'));
    write(join(root, 'raf-develop/local.txt'), 'develop stays\n');
    write(join(root, 'raf-hotfix/local.txt'), 'hotfix stays\n');
    write(join(root, 'other-main/local.txt'), 'other stays\n');
    write(join(root, 'shared-libs-develop/library.txt'), 'shared stays\n');
    symlinkSync('../shared-libs-develop', join(root, 'raf-develop/shared-libs'));
    write(join(root, 'learning/notes.txt'), 'non-product stays\n');
    return {
      base, root, original, projects, sha: git(original, 'rev-parse', 'HEAD'),
      options: { root, projects },
    };
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

function writeConfiguration(root: string, projects: Record<string, MainLayoutProject>): void {
  write(join(root, 'conf/projects.json'), JSON.stringify({
    version: 1,
    profiles: {
      raf: {
        development: 'develop', integration: 'main', candidate: null,
        production: 'main', environments: { runtime: 'main' },
      },
      'fixture-other': {
        development: 'main', integration: 'main', candidate: null,
        production: 'main', environments: { prod: 'main' },
      },
    },
    projects,
  }, null, 2));
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitPath(cwd: string, path: string): string {
  return resolve(cwd, git(cwd, 'rev-parse', '--git-path', path));
}

function tree(path: string): unknown {
  if (!existsSync(path)) {
    try { return { link: readlinkSync(path) }; } catch { return { missing: true }; }
  }
  const stat = lstatSync(path);
  const identity = { mode: stat.mode, ino: stat.ino, mtimeMs: stat.mtimeMs };
  if (stat.isSymbolicLink()) return { ...identity, link: readlinkSync(path) };
  if (stat.isDirectory()) return {
    ...identity,
    entries: Object.fromEntries(readdirSync(path).sort().map(name => [name, tree(join(path, name))])),
  };
  return { ...identity, hash: digest(path) };
}

function workingState(cwd: string): unknown {
  return {
    head: git(cwd, 'rev-parse', 'HEAD'),
    branch: git(cwd, 'symbolic-ref', 'HEAD'),
    index: digest(gitPath(cwd, 'index')),
    staged: git(cwd, 'diff', '--cached', '--binary'),
    unstaged: git(cwd, 'diff', '--binary'),
    status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
    files: Object.fromEntries(readdirSync(cwd).filter(name => name !== '.git').sort()
      .map(name => [name, tree(join(cwd, name))])),
  };
}

function outsiders(f: Fixture): unknown {
  return {
    trees: Object.fromEntries([
      'raf-develop', 'raf-hotfix', 'other-main', 'shared-libs-develop', 'learning',
      'parent-staged.txt', 'parent-untracked.txt', 'conf/projects.json',
    ].map(name => [name, tree(join(f.root, name))])),
    heads: ['raf-develop', 'raf-hotfix', 'other-main'].map(name => {
      const cwd = join(f.root, name);
      return [git(cwd, 'rev-parse', 'HEAD'), git(cwd, 'symbolic-ref', 'HEAD'), digest(gitPath(cwd, 'index'))];
    }),
    parentHead: git(f.root, 'rev-parse', 'HEAD'),
    parentEntry: git(f.root, 'ls-files', '--stage', '--', 'parent-staged.txt', 'other-main', 'conf/projects.json'),
    parentStaged: git(f.root, 'diff', '--cached', '--binary', '--', 'parent-staged.txt'),
    parentUnstaged: git(f.root, 'diff', '--binary', '--', 'parent-staged.txt'),
    otherModule: git(f.root, 'config', '-f', '.gitmodules', '--get', 'submodule.other.path'),
    refs: git(f.original, 'for-each-ref', '--format=%(refname) %(objectname)'),
  };
}

function assertLayout(f: Fixture): { active: string; inactive: string } {
  const logical = join(f.root, 'raf-main');
  assert.ok(lstatSync(logical).isSymbolicLink(), 'start must publish a logical main symlink');
  const active = realpathSync(logical);
  const copies = f.projects.raf.mainCopies!.map(path => realpathSync(join(f.root, path)));
  assert.equal(new Set(copies).size, 2, 'canonical main copies must differ');
  assert.ok(copies.includes(active));
  const inactive = copies.find(path => path !== active)!;
  for (const copy of copies) {
    assert.ok(!lstatSync(copy).isSymbolicLink(), 'a slot must be a physical directory');
    assert.ok(!isAbsolute(relative(f.root, copy)) && !relative(f.root, copy).startsWith('..'));
    assert.equal(git(copy, 'rev-parse', 'HEAD'), f.sha);
    assert.equal(git(copy, 'remote', 'get-url', 'origin'), git(logical, 'remote', 'get-url', 'origin'));
    assert.equal(realpathSync(resolve(copy, git(copy, 'rev-parse', '--git-common-dir'))),
      realpathSync(resolve(logical, git(logical, 'rev-parse', '--git-common-dir'))));
    assert.equal(git(copy, 'rev-parse', '--show-toplevel'), copy);
  }
  assert.equal(git(active, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(inactive, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(git(inactive, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.equal(readFileSync(join(inactive, 'staged.txt'), 'utf8'), 'committed staged.txt\n');
  assert.equal(existsSync(join(inactive, 'private/untracked.txt')), false);
  assert.equal(git(f.root, 'config', '-f', '.gitmodules', '--get', 'submodule.raf.path'), relative(f.root, active));
  assert.equal(git(f.root, 'config', '--get', 'submodule.raf.url'), git(active, 'remote', 'get-url', 'origin'));
  assert.equal(git(f.root, 'ls-files', '--stage', '--', relative(f.root, active)),
    `160000 ${f.sha} 0\t${relative(f.root, active)}`);
  const logicalEntry = git(f.root, 'ls-files', '--stage', '--', 'raf-main');
  assert.match(logicalEntry, /^120000 [a-f0-9]+ 0\traf-main$/);
  assert.equal(git(f.root, 'show', ':raf-main'), readlinkSync(logical));
  const indexedModules = git(f.root, 'show', ':.gitmodules');
  assert.match(indexedModules, new RegExp(`path = ${relative(f.root, active)}`));
  assert.ok(!indexedModules.split('\n').some(line => line.trim() === 'path = raf-main'));
  const gitlinks = git(f.root, 'ls-files', '--stage').split('\n').filter(line => line.startsWith('160000 '));
  assert.equal(gitlinks.filter(line => line.endsWith(`\t${relative(f.root, active)}`)).length, 1);
  assert.ok(!gitlinks.some(line => line.endsWith('\traf-main') || line.endsWith(`\t${relative(f.root, inactive)}`)));
  assert.match(git(f.root, 'submodule', 'status', '--', relative(f.root, active)), new RegExp(f.sha));
  git(active, 'fsck', '--no-reflogs');
  for (const file of ['source.txt', 'build/output.js']) {
    const a = lstatSync(join(active, file));
    const b = lstatSync(join(inactive, file));
    assert.ok(a.isFile() && b.isFile());
    assert.notEqual(`${a.dev}:${a.ino}`, `${b.dev}:${b.ino}`, 'mutable files must not be hardlinked');
  }
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('raf-main')).sort(),
    ['raf-main', ...f.projects.raf.mainCopies!.filter(name => !name.includes('/'))].sort(),
    'no third permanent main copy');
  return { active, inactive };
}

async function withFixture(body: (f: Fixture) => void | Promise<void>): Promise<void> {
  const f = fixture();
  try { await body(f); } finally { rmSync(f.base, { recursive: true, force: true }); }
}

for (const copies of [['raf-main-a', 'raf-main-b'], ['slots/one', 'slots/two']]) {
  test(`start converts dirty physical main using configured copies ${copies.join(', ')}`, async () => {
    await withFixture(async f => {
      f.projects.raf.mainCopies = copies;
      writeConfiguration(f.root, f.projects);
      const source = git(f.original, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      const before = workingState(f.original);
      const outside = outsiders(f);
      const input = JSON.stringify(f.projects);
      const result = await ensureMainLayoutForStart(f.options);
      assert.equal(result.status, 'converted');
      const { active, inactive } = assertLayout(f);
      const production = join(source, 'raf-hotfix/main.git');
      assert.equal(git(active, 'rev-parse', '--path-format=absolute', '--git-common-dir'), production);
      assert.equal(git(inactive, 'rev-parse', '--path-format=absolute', '--git-common-dir'), production);
      assert.equal(git(join(f.root, 'raf-develop'), 'rev-parse', '--path-format=absolute', '--git-common-dir'), source);
      assert.equal(result.activePath, active);
      assert.equal(result.inactivePath, inactive);
      assert.deepEqual(workingState(active), before, 'HEAD, index bytes, modes and every local file survive relocation');
      assert.deepEqual(outsiders(f), outside, 'develop/hotfix/other projects and foreign parent index entries survive');
      assert.equal(JSON.stringify(f.projects), input, 'profile roles and logical paths are retained');
      write(join(inactive, 'source.txt'), 'isolated candidate edit\n');
      assert.equal(readFileSync(join(active, 'source.txt'), 'utf8'), 'committed source.txt\n');
      write(join(inactive, 'source.txt'), 'committed source.txt\n');
      const physicalBefore = tree(f.root);
      const again = await ensureMainLayoutForStart(f.options);
      assert.equal(again.status, 'unchanged');
      assert.deepEqual(tree(f.root), physicalBefore, 'repeated start performs no writes or recloning');
    });
  });
}

for (const checkpoint of ['intent-durable', 'original-relocated', 'git-relocated', 'link-published'] satisfies MainLayoutCheckpoint[]) {
  test(`fresh process recovers conversion interrupted at ${checkpoint}`, async () => {
    await withFixture(async f => {
      const before = workingState(f.original);
      const outside = outsiders(f);
      const moduleUrl = new URL('../src/main-layout.ts', import.meta.url).href;
      const script = `
        import { readFileSync, existsSync, writeFileSync } from 'node:fs';
        const { ensureMainLayoutForStart } = await import(process.argv[1]);
        const root = process.argv[2];
        const { projects } = JSON.parse(readFileSync(root + '/conf/projects.json', 'utf8'));
        await ensureMainLayoutForStart({ root, projects, onCheckpoint(point, publication) {
          if (point === process.argv[3]) {
            if (!existsSync(publication.intentPath)) throw new Error('Missing durable conversion intent');
            const intent = readFileSync(publication.intentPath, 'utf8');
            if (!intent.trim()) throw new Error('Empty durable conversion intent');
            writeFileSync(process.argv[4], JSON.stringify({ intentPath: publication.intentPath }));
            process.kill(process.pid, 'SIGKILL');
          }
        } });
      `;
      const evidencePath = join(f.base, 'checkpoint-evidence.json');
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.root, checkpoint, evidencePath], {
        cwd: f.root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
      });
      assert.equal(child.error, undefined);
      assert.equal(child.signal, 'SIGKILL', `must reach durable boundary: ${child.stderr}`);
      const result = await ensureMainLayoutForStart(f.options);
      assert.equal(result.status, 'recovered');
      const { active } = assertLayout(f);
      assert.deepEqual(workingState(active), before);
      assert.deepEqual(outsiders(f), outside);
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as { intentPath: string };
      assert.equal(existsSync(evidence.intentPath), false, 'completed recovery removes its transaction intent');
      const recovered = tree(f.root);
      assert.equal((await ensureMainLayoutForStart(f.options)).status, 'unchanged');
      assert.deepEqual(tree(f.root), recovered);
    });
  });
}

type InvalidCase = { name: string; prepare(f: Fixture): void };
const invalidCases: InvalidCase[] = [
  { name: 'missing mainCopies', prepare: f => { delete f.projects.raf.mainCopies; } },
  { name: 'one copy', prepare: f => { f.projects.raf.mainCopies = ['raf-main-a']; } },
  { name: 'three copies', prepare: f => { f.projects.raf.mainCopies = ['a', 'b', 'c']; } },
  { name: 'duplicate copy', prepare: f => { f.projects.raf.mainCopies = ['raf-main-a', 'raf-main-a']; } },
  { name: 'normalized duplicate', prepare: f => { f.projects.raf.mainCopies = ['raf-main-a', './raf-main-a']; } },
  { name: 'absolute path', prepare: f => { f.projects.raf.mainCopies = [join(f.root, 'a'), 'raf-main-b']; } },
  { name: 'root escape', prepare: f => { f.projects.raf.mainCopies = ['../outside', 'raf-main-b']; } },
  { name: 'root itself', prepare: f => { f.projects.raf.mainCopies = ['.', 'raf-main-b']; } },
  { name: 'overlapping slots', prepare: f => { f.projects.raf.mainCopies = ['slots', 'slots/nested']; } },
  { name: 'logical main as slot', prepare: f => { f.projects.raf.mainCopies = ['raf-main', 'raf-main-b']; } },
  { name: 'develop as slot', prepare: f => { f.projects.raf.mainCopies = ['raf-develop', 'raf-main-b']; } },
  { name: 'hotfix as slot', prepare: f => { f.projects.raf.mainCopies = ['raf-hotfix', 'raf-main-b']; } },
  { name: 'nested develop', prepare: f => { f.projects.raf.mainCopies = ['raf-develop/nested', 'raf-main-b']; } },
  { name: 'symlink alias of develop', prepare: f => { symlinkSync('raf-develop', join(f.root, 'raf-main-a')); } },
  { name: 'symlink alias of hotfix', prepare: f => { symlinkSync('raf-hotfix', join(f.root, 'raf-main-a')); } },
  { name: 'symlink outside root', prepare: f => { symlinkSync(f.base, join(f.root, 'raf-main-a')); } },
  { name: 'canonical duplicate', prepare: f => {
    mkdirSync(join(f.root, 'raf-main-a'));
    symlinkSync('raf-main-a', join(f.root, 'raf-main-b'));
  } },
  { name: 'symlink cycle', prepare: f => {
    symlinkSync('raf-main-b', join(f.root, 'raf-main-a'));
    symlinkSync('raf-main-a', join(f.root, 'raf-main-b'));
  } },
  { name: 'dangling target', prepare: f => { symlinkSync('missing-copy', join(f.root, 'raf-main-a')); } },
  { name: 'foreign repository', prepare: f => { seed(join(f.root, 'raf-main-b')); } },
  { name: 'occupied file', prepare: f => { write(join(f.root, 'raf-main-a'), 'foreign bytes\n'); } },
  { name: 'occupied directory', prepare: f => { write(join(f.root, 'raf-main-b/keep.bin'), new Uint8Array([0, 1, 255])); } },
];

for (const invalid of invalidCases) {
  test(`invalid layout refuses before mutation: ${invalid.name}`, async () => {
    await withFixture(async f => {
      invalid.prepare(f);
      const before = tree(f.root);
      await assert.rejects(() => ensureMainLayoutForStart(f.options), error => {
        assert.ok(error instanceof Error);
        assert.notEqual(error.message, 'NotImplemented', 'a real validation diagnostic is required');
        assert.match(error.message, /expected|очікуван/i);
        assert.match(error.message, /actual|фактичн/i);
        assert.match(error.message, /raf-main|mainCopies|slots|outside|raf-develop|raf-hotfix/);
        return true;
      });
      assert.deepEqual(tree(f.root), before, 'refusal preserves all bytes, modes, paths and Git metadata');
    });
  });
}

for (const code of ['ENOTSUP', 'EXDEV']) {
test(`atomic conversion provider ${code} refuses without a filesystem/Git fallback`, async () => {
  await withFixture(async f => {
    const before = tree(f.root);
    let preflight = 0;
    let publishes = 0;
    await assert.rejects(() => ensureMainLayoutForStart({
      ...f.options,
      publicationProvider: {
        async assertSupported(root) {
          preflight += 1;
          assert.equal(root, f.root);
          throw Object.assign(new Error('Atomic directory conversion is unsupported'), { code });
        },
        async publish() { publishes += 1; assert.fail('unsupported provider cannot publish'); },
      },
    }), { code });
    assert.equal(preflight, 1);
    assert.equal(publishes, 0);
    assert.deepEqual(tree(f.root), before);
  });
});
}

for (const corruption of ['gitlink', 'gitmodules', 'logical-target', 'source-hardlink', 'build-symlink']) {
  test(`ready physical layout refuses ${corruption} corruption without overwriting it`, async () => {
    await withFixture(async f => {
      await ensureMainLayoutForStart(f.options);
      const { active, inactive } = assertLayout(f);
      if (corruption === 'gitlink') {
        git(f.root, 'update-index', '--cacheinfo', `160000,${'b'.repeat(40)},${relative(f.root, active)}`);
      } else if (corruption === 'gitmodules') {
        git(f.root, 'config', '-f', '.gitmodules', 'submodule.raf.path', relative(f.root, inactive));
      } else if (corruption === 'logical-target') {
        rmSync(f.original);
        symlinkSync('raf-develop', f.original);
      } else if (corruption === 'source-hardlink') {
        rmSync(join(inactive, 'source.txt'));
        linkSync(join(active, 'source.txt'), join(inactive, 'source.txt'));
      } else {
        rmSync(join(inactive, 'build/output.js'));
        symlinkSync(join(active, 'build/output.js'), join(inactive, 'build/output.js'));
      }
      const before = tree(f.root);
      await assert.rejects(() => ensureMainLayoutForStart(f.options), error => {
        assert.ok(error instanceof Error);
        assert.notEqual(error.message, 'NotImplemented');
        return true;
      });
      assert.deepEqual(tree(f.root), before);
    });
  });
}

test('already converted layout rejects missing slot or foreign repository without repair over data', async () => {
  await withFixture(async f => {
    await ensureMainLayoutForStart(f.options);
    const { inactive } = assertLayout(f);
    rmSync(inactive, { recursive: true });
    const missing = tree(f.root);
    await assert.rejects(() => ensureMainLayoutForStart(f.options), /missing|відсутн|actual|фактичн/i);
    assert.deepEqual(tree(f.root), missing);
    seed(inactive);
    const foreign = tree(f.root);
    await assert.rejects(() => ensureMainLayoutForStart(f.options), /repository|репозитор|identity/i);
    assert.deepEqual(tree(f.root), foreign);
  });
});


test('production migration preserves split index, unreachable staged blobs and concurrent source commits', async () => {
  await withFixture(async f => {
    git(f.original, 'update-index', '--split-index');
    const before = workingState(f.original), source = git(f.original, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const sourceIndex = digest(join(source, 'index'));
    const develop = join(f.root, 'raf-develop');
    let sourceCommit = '';
    const result = await ensureProductionMainStore({ root: f.root, onCheckpoint: async checkpoint => {
      if (checkpoint !== 'store-prepared') return;
      write(join(develop, 'own-migration.txt'), 'concurrent source commit\n');
      git(develop, 'add', '--', 'own-migration.txt');
      git(develop, 'commit', '--only', '-m', 'Concurrent source commit', '--', 'own-migration.txt');
      sourceCommit = git(develop, 'rev-parse', 'HEAD');
      write(join(f.root, 'own-migration.txt'), 'concurrent Orchestrator commit\n');
      git(f.root, 'add', '--', 'own-migration.txt');
      git(f.root, 'commit', '--only', '-m', 'Concurrent Orchestrator commit', '--', 'own-migration.txt');
    } });
    assert.equal(result.source, source);
    assert.equal(result.production, join(source, 'raf-hotfix/main.git'));
    assert.equal(git(develop, 'rev-parse', 'HEAD'), sourceCommit);
    assert.equal(digest(join(source, 'index')), sourceIndex);
    assert.deepEqual(workingState(f.original), before);
    assert.equal(git(f.original, 'cat-file', '-s', ':binary.bin'), '4');
    const check = directory => { for (const name of readdirSync(directory)) {
      const file = join(directory, name), info = lstatSync(file);
      assert.ok(!info.isSymbolicLink());
      if (info.isDirectory()) check(file); else assert.equal(info.nlink, 1);
    } };
    check(result.production);
    assert.ok(!existsSync(join(result.production, 'objects/info/alternates')));
  });
});

for (const checkpoint of ['store-prepared', 'store-pointer', 'store-registered']) {
  test(`fresh process recovers production migration interrupted at ${checkpoint}`, async () => {
    await withFixture(async f => {
      const before = workingState(f.original);
      const module = new URL('../src/main-production-store.ts', import.meta.url).href;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { ensureProductionMainStore } from ${JSON.stringify(module)};
        await ensureProductionMainStore({ root: ${JSON.stringify(f.root)}, onCheckpoint: phase => {
          if (phase === ${JSON.stringify(checkpoint)}) process.kill(process.pid, 'SIGKILL');
        } });
      `], { encoding: 'utf8', timeout: 30000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const result = await ensureProductionMainStore({ root: f.root });
      assert.equal(result.split, true);
      assert.deepEqual(workingState(f.original), before);
      assert.ok(!existsSync(join(result.control, 'main-store-intent.json')));
    });
  });
}

test('unknown live reader holds production migration without terminating it', async () => {
  await withFixture(async f => {
    const source = git(f.original, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const control = join(source, 'raf-hotfix');
    write(join(control, 'readers/old.json'), JSON.stringify({ pid: process.pid, start: await processStart(process.pid), root: f.original }));
    const before = tree(f.root);
    await assert.rejects(ensureProductionMainStore({ root: f.root }), /live reader has unknown protection/);
    assert.deepEqual(tree(f.original), before.entries['raf-main']);
    assert.ok(!existsSync(join(control, 'main.git')));
    process.kill(process.pid, 0);
  });
});
