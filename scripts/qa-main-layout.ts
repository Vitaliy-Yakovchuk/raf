import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type MainLayoutProject,
  type MainLayoutStartOptions,
} from '../src/main-layout.ts';

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
    commonDir: realpathSync(resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir'))),
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


const helperUrl = new URL('../src/main-layout.ts', import.meta.url).href;
const driver = `
  import { readFileSync } from 'node:fs';
  const { ensureMainLayoutForStart } = await import(process.argv[1]);
  const root = process.argv[2];
  const { projects } = JSON.parse(readFileSync(root + '/conf/projects.json', 'utf8'));
  try {
    const result = await ensureMainLayoutForStart({ root, projects, onCheckpoint(point) {
      if (point === process.argv[3]) process.kill(process.pid, 'SIGKILL');
    } });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error.stack + '\\n');
    process.exitCode = 1;
  }
`;

function run(f: Fixture, checkpoint = '') {
  const args = ['--input-type=module', '-e', driver, helperUrl, f.root, checkpoint];
  const child = spawnSync(process.execPath, args, {
    cwd: f.root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  });
  assert.equal(child.error, undefined);
  return {
    command: [process.execPath, ...args], exitCode: child.status, signal: child.signal,
    stdout: child.stdout, stderr: child.stderr, timeout: false,
  };
}

function snapshot(f: Fixture, physical: string) {
  const logical = join(f.root, 'raf-main');
  const logicalStat = lstatSync(logical);
  const parentIndex = gitPath(f.root, 'index');
  return {
    main: workingState(physical),
    parent: {
      head: git(f.root, 'rev-parse', 'HEAD'), indexSha256: digest(parentIndex),
      status: git(f.root, 'status', '--porcelain=v1', '--untracked-files=all'),
      entries: git(f.root, 'ls-files', '--stage'),
      gitmodules: readFileSync(join(f.root, '.gitmodules'), 'utf8'),
      indexedGitmodules: git(f.root, 'show', ':.gitmodules'),
      foreignStaged: git(f.root, 'diff', '--cached', '--binary', '--', 'parent-staged.txt'),
    },
    logical: { kind: logicalStat.isSymbolicLink() ? 'symlink' : 'directory',
      readlink: logicalStat.isSymbolicLink() ? readlinkSync(logical) : null,
      realpath: realpathSync(logical) },
  };
}

const evidence: Record<string, unknown> = {
  task: 'switch-raf-main-by-symlink:2.4', kind: 'filesystem-git-qa',
  startedAt: new Date().toISOString(),
  environment: { platform: process.platform, architecture: process.arch, node: process.version,
    kernel: execFileSync('uname', ['-sr'], { encoding: 'utf8' }).trim(),
    git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
    python: execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim() },
  workspace: { head: git(process.cwd(), 'rev-parse', 'HEAD'),
    status: git(process.cwd(), 'status', '--porcelain=v1', '--untracked-files=all'),
    diffSha256: createHash('sha256').update(git(process.cwd(), 'diff', '--binary', 'HEAD')).digest('hex'),
    helperSha256: digest(new URL('../src/main-layout.ts', import.meta.url).pathname),
    providerSha256: digest(new URL('../src/main-layout-publication.ts', import.meta.url).pathname) },
  scope: 'Real native helper invoked by fresh Node processes on local temporary Git submodules. Live agents, native agent conversion channel and skill start integration remain 7.1/7.2.',
};
const scenarios: Record<string, unknown>[] = [];
let failures = 0;
function scenario(name: string, copies: string[], body: (f: Fixture, record: Record<string, any>) => void) {
  const record: Record<string, any> = { name, copies, outcome: 'running' };
  scenarios.push(record);
  let f: Fixture | undefined;
  try {
    f = fixture();
    f.projects.raf.mainCopies = copies;
    writeConfiguration(f.root, f.projects);
    body(f, record);
    record.outcome = 'passed';
  } catch (error) {
    failures++;
    record.outcome = 'failed';
    record.error = error instanceof Error ? error.stack : String(error);
  } finally {
    if (f) {
      rmSync(f.base, { recursive: true, force: true });
      record.cleanup = { path: f.base, removed: !existsSync(f.base) };
    }
  }
}

for (const copies of [['raf-main-a', 'raf-main-b'], ['raf-main-b', 'raf-main-a']]) {
  scenario('dirty main conversion and repeated start', copies, (f, record) => {
    const before = snapshot(f, f.original);
    const outside = outsiders(f);
    record.before = before;
    record.firstStart = run(f);
    assert.equal(record.firstStart.exitCode, 0, record.firstStart.stderr);
    assert.equal(JSON.parse(record.firstStart.stdout).status, 'converted');
    const { active, inactive } = assertLayout(f);
    assert.equal(active, join(f.root, copies[0]));
    assert.equal(inactive, join(f.root, copies[1]));
    record.after = snapshot(f, active);
    assert.deepEqual(record.after.main, before.main);
    assert.deepEqual(outsiders(f), outside);
    const allBefore = tree(f.root);
    record.repeatStart = run(f);
    assert.equal(record.repeatStart.exitCode, 0, record.repeatStart.stderr);
    assert.equal(JSON.parse(record.repeatStart.stdout).status, 'unchanged');
    record.afterRepeat = snapshot(f, active);
    assert.deepEqual(tree(f.root), allBefore);
    record.assertions = { mainHeadIndexStatusFilesModesPreserved: true, foreignEntriesPreserved: true,
      physicalGitlinkAndIndexedGitmodules: true, detachedCleanInactive: true,
      commonRepository: true, independentMutableFiles: true, secondStartByteAndMetadataNoop: true };
  });
  for (const checkpoint of ['intent-durable', 'original-relocated', 'git-relocated', 'link-published']) {
    scenario('SIGKILL and fresh recovery at ' + checkpoint, copies, (f, record) => {
      record.before = snapshot(f, f.original);
      const outside = outsiders(f);
      record.crash = run(f, checkpoint);
      assert.equal(record.crash.signal, 'SIGKILL', record.crash.stderr);
      assert.equal(record.crash.exitCode, null);
      const intentPath = join(f.root, '.git/raf-main-layout/intent.json');
      record.intentAfterCrash = JSON.parse(readFileSync(intentPath, 'utf8'));
      record.recovery = run(f);
      assert.equal(record.recovery.exitCode, 0, record.recovery.stderr);
      assert.equal(JSON.parse(record.recovery.stdout).status, 'recovered');
      const { active } = assertLayout(f);
      record.afterRecovery = snapshot(f, active);
      assert.deepEqual(record.afterRecovery.main, record.before.main);
      assert.deepEqual(outsiders(f), outside);
      assert.equal(existsSync(intentPath), false);
      const recovered = tree(f.root);
      record.repeatStart = run(f);
      assert.equal(record.repeatStart.exitCode, 0, record.repeatStart.stderr);
      assert.equal(JSON.parse(record.repeatStart.stdout).status, 'unchanged');
      record.afterRepeat = snapshot(f, active);
      assert.deepEqual(tree(f.root), recovered);
      record.assertions = { originalStateAndForeignEntriesPreserved: true, physicalLayoutVerified: true,
        recoveryIntentRemoved: true, repeatedStartNoop: true };
    });
  }
}
for (const occupied of ['raf-main-a', 'raf-main-b']) {
  for (const kind of ['file', 'directory', 'repository']) {
    scenario('occupied ' + occupied + ' ' + kind, ['raf-main-a', 'raf-main-b'], (f, record) => {
      const path = join(f.root, occupied);
      if (kind === 'repository') seed(path);
      else write(kind === 'file' ? path : join(path, 'keep.bin'), new Uint8Array([0, 1, 255, 128, 10]));
      record.before = snapshot(f, f.original);
      const allBefore = tree(f.root);
      record.treeBeforeSha256 = createHash('sha256').update(JSON.stringify(allBefore)).digest('hex');
      record.foreignBefore = tree(path);
      record.refusal = run(f);
      assert.equal(record.refusal.exitCode, 1, record.refusal.stderr);
      assert.match(record.refusal.stderr, /expected.*actual/i);
      record.after = snapshot(f, f.original);
      record.foreignAfter = tree(path);
      const allAfter = tree(f.root);
      record.treeAfterSha256 = createHash('sha256').update(JSON.stringify(allAfter)).digest('hex');
      assert.deepEqual(allAfter, allBefore);
      assert.deepEqual(record.after, record.before);
      record.assertions = { completeTreeBytesModesInodesMtimesUnchanged: true, foreignPathPreserved: true };
    });
  }
}
evidence.scenarios = scenarios;
evidence.finishedAt = new Date().toISOString();
evidence.summary = { total: scenarios.length, passed: scenarios.length - failures, failed: failures,
  timeout: false, unexecuted: [], unknown: [], cleanup: scenarios.every(s => (s.cleanup as any)?.removed) };
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
process.exitCode = failures ? 1 : 0;
