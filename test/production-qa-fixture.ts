import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type FixtureLifecycle = { after(action: () => void): void };
type FixtureLocation = { root: string; home: string; runtimeCatalog?: string };
type ProductionCli = typeof import('../src/production-entry.ts').runProductionCli;

export function copyProductionQaDependencies(codeRoot: string): void {
  mkdirSync(join(codeRoot, 'node_modules'), { recursive: true });
  cpSync(new URL('../node_modules/typescript', import.meta.url), join(codeRoot, 'node_modules/typescript'), { recursive: true, dereference: true });
  const result = spawnSync('git', ['-C', codeRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const exclude = result.stdout.trim();
  mkdirSync(dirname(exclude), { recursive: true });
  if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes('/node_modules/')) appendFileSync(exclude, '\n/node_modules/\n');
}

export async function prepareProductionQaFixture(t: FixtureLifecycle, location: FixtureLocation, beforeLoad?: (codeRoot: string) => Promise<void>): Promise<ProductionCli> {
  const projects = JSON.parse(readFileSync(join(location.root, 'conf', 'projects.json'), 'utf8'));
  mkdirSync(join(location.root, projects.projects.raf.path), { recursive: true });
  for (const name of ['flow.json', 'test-runs.json']) {
    cpSync(new URL(`../../conf/${name}`, import.meta.url), join(location.root, 'conf', name), { force: false });
  }
  const codeRoot = join(location.root, projects.projects.raf.branchPaths.develop);
  mkdirSync(codeRoot, { recursive: true });
  const gitEnvironment = { ...process.env };
  for (const name of Object.keys(gitEnvironment)) if (name.startsWith('GIT_')) delete gitEnvironment[name];
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=QA fixture', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: gitEnvironment });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  };
  const mainRoot = join(location.root, projects.projects.raf.branchPaths.main);
  git(location.root, 'init', '-q', '--initial-branch=main');
  git(mainRoot, 'init', '-q', '--initial-branch=main');
  if (location.runtimeCatalog) {
    for (const name of ['src', 'bin', 'scripts', 'test', 'package.json']) cpSync(new URL(`../${name}`, import.meta.url), join(mainRoot, name), { recursive: true });
    mkdirSync(join(mainRoot, 'dist'), { recursive: true });
    cpSync(location.runtimeCatalog, join(mainRoot, 'dist', 'catalog.json'));
    copyProductionQaDependencies(mainRoot);
    writeFileSync(join(mainRoot, '.gitignore'), '/node_modules/\n');
    git(mainRoot, 'add', '--', '.gitignore', 'src', 'bin', 'scripts', 'test', 'package.json', 'dist/catalog.json');
  }
  git(mainRoot, 'commit', '--allow-empty', '-m', 'Registered QA source');
  git(location.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './' + projects.projects.raf.branchPaths.main, projects.projects.raf.branchPaths.main);
  git(location.root, 'submodule', 'absorbgitdirs');
  rmSync(join(codeRoot, '.git'), { recursive: true, force: true });
  const retained = mkdtempSync(join(location.root, '.qa-retained-source-'));
  renameSync(codeRoot, join(retained, 'source'));
  git(mainRoot, 'worktree', 'add', '-b', 'develop', codeRoot, 'HEAD');
  git(mainRoot, 'worktree', 'add', '-b', 'hotfix', join(location.root, projects.projects.raf.branchPaths.hotfix), 'HEAD');
  cpSync(join(retained, 'source'), codeRoot, { recursive: true });
  rmSync(retained, { recursive: true });
  for (const name of ['src', 'bin', 'scripts', 'package.json']) {
    cpSync(new URL(`../${name}`, import.meta.url), join(codeRoot, name), { recursive: true });
  }
  copyProductionQaDependencies(codeRoot);
  const { prepareMainLayoutForProductionStart } = await import('../src/production-start-layout.ts');
  await prepareMainLayoutForProductionStart({ orchestratorRoot: location.root });

  const names = ['HOME', 'RAF_QA_HOME', 'RAF_ORCHESTRATOR_ROOT', 'TMUX', 'TMUX_PANE'] as const;
  const inherited = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (inherited[name] === undefined) delete process.env[name];
      else process.env[name] = inherited[name];
    }
  });
  process.env.HOME = location.home;
  process.env.RAF_QA_HOME = location.home;
  process.env.RAF_ORCHESTRATOR_ROOT = location.root;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  await beforeLoad?.(codeRoot);
  const entry: typeof import('../src/production-entry.ts') = await import(pathToFileURL(join(codeRoot, 'src', 'production-entry.ts')).href);
  return entry.runProductionCli;
}
