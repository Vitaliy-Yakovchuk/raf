import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { resolveGitWriteBoundaries } from '../src/task-context.ts';

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'qa', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'qa', GIT_COMMITTER_EMAIL: 'qa@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const inside = (base: string, path: string) => {
  const suffix = relative(base, path);
  return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
};

async function filesChangedSince(root: string, since: number): Promise<string[]> {
  const changed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if ((await stat(path)).mtimeMs > since) changed.push(path);
  }
  return changed;
}

test('[executor-commit-qa] real submodule worktree: an executor commits only its own path, foreign uncommitted edits stay intact and every git write lands inside the launch git boundaries', async t => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'raf-executor-commit-qa-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  await mkdir(join(root, '.git', 'modules'));
  git(root, 'init', '-q', '-b', 'main', '--separate-git-dir', join(root, '.git', 'modules', 'raf'), join(root, 'raf-main'));
  const primary = join(root, 'raf-main');
  await writeFile(join(primary, 'shared.ts'), 'export const shared = 1;\n');
  git(primary, 'add', 'shared.ts');
  git(primary, 'commit', '-q', '-m', 'base');
  git(primary, 'worktree', 'add', '-q', '-b', 'develop', join(root, 'raf-develop'));
  const tree = join(root, 'raf-develop');

  await writeFile(join(tree, 'shared.ts'), 'export const shared = 2; // foreign edit\n');
  await writeFile(join(tree, 'foreign-new.ts'), 'export const foreign = true;\n');
  const foreignBefore = { shared: await readFile(join(tree, 'shared.ts'), 'utf8'), created: await readFile(join(tree, 'foreign-new.ts'), 'utf8') };
  const head = git(tree, 'rev-parse', 'HEAD');

  const boundaries = await resolveGitWriteBoundaries(tree, root);
  const [gitDir, commonDir] = git(tree, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir').split('\n').map(path => realpathSync(path));
  assert.deepEqual([...boundaries].sort(), [gitDir, commonDir, realpathSync(join(root, '.git'))].sort(), 'межі запуску збігаються з git-dir і common-dir, які повертає сам git, і git-каталогом кореня');

  await writeFile(join(tree, 'own.ts'), 'export const own = true;\n');
  await new Promise(resolve => setTimeout(resolve, 20));
  const since = Date.now();
  git(tree, 'add', '--', 'own.ts');
  git(tree, 'commit', '-q', '-m', 'own work', '--', 'own.ts');

  assert.equal(git(tree, 'rev-parse', 'HEAD~1'), head, 'зʼявився рівно один новий коміт');
  assert.deepEqual(git(tree, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['own.ts'], 'коміт містить лише власний шлях');
  assert.equal(await readFile(join(tree, 'shared.ts'), 'utf8'), foreignBefore.shared, 'чужа незакомічена правка не змінена');
  assert.equal(await readFile(join(tree, 'foreign-new.ts'), 'utf8'), foreignBefore.created, 'чужий новий файл не змінений');
  assert.deepEqual(execFileSync('git', ['status', '--porcelain'], { cwd: tree, env: gitEnv, encoding: 'utf8' }).split('\n').filter(Boolean).sort(), [' M shared.ts', '?? foreign-new.ts'], 'чужі зміни лишилися незакоміченими й непроіндексованими');
  assert.equal(git(tree, 'remote'), '', 'фікстура без remote: коміт не потребує push');

  const written = (await filesChangedSince(root, since)).filter(path => !inside(tree, path));
  assert.ok(written.length > 0, 'коміт мав записати щось у git-каталоги поза робочим деревом');
  const outside = written.filter(path => !boundaries.some(boundary => inside(boundary, path)));
  assert.deepEqual(outside, [], 'усі записи git commit поза робочим деревом лежать у межах запуску');
});
