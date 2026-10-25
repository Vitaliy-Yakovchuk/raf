import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceRoute } from '../../src/workspace-routing.ts';
import { createWorkspacePorts } from '../../src/os-runtime.ts';

const root = await mkdtemp(join(tmpdir(), 'cfc94-probe-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  git('init', '-q', '-b', 'main');
  await mkdir(join(root, 'app-main'));
  const snapshot = () => ({ head: git('symbolic-ref', 'HEAD'), status: git('--no-optional-locks', 'status', '--porcelain=v1') });
  const before = snapshot();
  const actual = await resolveWorkspaceRoute({ root, project: 'app', branch: 'main' }, { projects: { app: { path: 'app-main', profile: 'product', branchPaths: { main: 'app-main' } } } }, createWorkspacePorts());
  const after = snapshot();
  const gitRoot = execFileSync('git', ['-C', join(root, 'app-main'), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  console.log(JSON.stringify({ command: 'node evidence/cfc94-workspace-routing/non-git-probe.mjs', root, expected: 'WORKSPACE_UNAVAILABLE: app-main is not a Git root', actual, before, after, gitRoot }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
