import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type FixtureLifecycle = { after(action: () => void): void };
type FixtureLocation = { root: string; home: string };
type ProductionCli = typeof import('../src/production-entry.ts').runProductionCli;

export async function prepareProductionQaFixture(t: FixtureLifecycle, location: FixtureLocation): Promise<ProductionCli> {
  const projects = JSON.parse(readFileSync(join(location.root, 'conf', 'projects.json'), 'utf8'));
  mkdirSync(join(location.root, projects.projects.raf.path), { recursive: true });
  cpSync(new URL('../../conf/flow.json', import.meta.url), join(location.root, 'conf', 'flow.json'), { force: false });
  const codeRoot = join(location.root, projects.projects.raf.branchPaths.develop);
  for (const name of ['src', 'bin', 'scripts', 'package.json']) {
    cpSync(new URL(`../${name}`, import.meta.url), join(codeRoot, name), { recursive: true });
  }
  const gitEnvironment = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete gitEnvironment[name];
  const initialized = spawnSync('git', ['init', '-q', '--initial-branch=develop', codeRoot], { encoding: 'utf8', env: gitEnvironment });
  assert.ifError(initialized.error);
  assert.equal(initialized.status, 0, initialized.stderr);

  const names = ['HOME', 'RAF_QA_HOME', 'TMUX', 'TMUX_PANE'] as const;
  const inherited = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (inherited[name] === undefined) delete process.env[name];
      else process.env[name] = inherited[name];
    }
  });
  process.env.HOME = location.home;
  process.env.RAF_QA_HOME = location.home;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  const entry: typeof import('../src/production-entry.ts') = await import(pathToFileURL(join(codeRoot, 'src', 'production-entry.ts')).href);
  return entry.runProductionCli;
}
