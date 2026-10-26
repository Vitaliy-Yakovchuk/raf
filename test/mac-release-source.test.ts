import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { processStart, validateReleaseWorkspace, withReleaseWriter } from '../src/hotfix-host.ts';

const execute = promisify(execFile);
const darwinOnly = { skip: process.platform !== 'darwin' };

async function git(cwd: string, ...args: string[]) {
  return (await execute('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Mac Test', GIT_AUTHOR_EMAIL: 'mac-test@example.invalid', GIT_COMMITTER_NAME: 'Mac Test', GIT_COMMITTER_EMAIL: 'mac-test@example.invalid' },
  })).stdout.trim();
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-mac-release-')));
  try {
    const main = join(root, 'raf-main');
    const cwd = join(root, 'raf-mac');
    const qaHome = join(root, 'qa-home');
    await mkdir(main);
    await mkdir(qaHome);
    await mkdir(join(root, 'conf'));
    await git(main, 'init', '-b', 'main');
    await writeFile(join(main, 'payload'), 'original repository bytes');
    await git(main, 'add', 'payload');
    await git(main, 'commit', '-m', 'fixture');
    await git(main, 'worktree', 'add', '-b', 'develop', join(root, 'raf-develop'));
    await git(main, 'worktree', 'add', '-b', 'mac', cwd);
    const projects = { projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix', mac: 'raf-mac' } } } };
    await writeFile(join(root, 'conf', 'projects.json'), JSON.stringify(projects));
    await writeFile(join(root, 'conf', 'flow.json'), JSON.stringify({ unitTests: { timeoutMs: 500 } }));
    const commonDirectory = await realpath(resolve(cwd, await git(cwd, 'rev-parse', '--git-common-dir')));
    const gitDirectory = await realpath(await git(cwd, 'rev-parse', '--absolute-git-dir'));
    const workspace = {
      runId: 'mac-release-test',
      orchestratorRoot: root,
      project: 'raf' as const,
      targetBranch: 'main' as const,
      cwd,
      baseCommit: await git(main, 'rev-parse', 'HEAD'),
      repositoryIdentity: commonDirectory,
      gitDirectory,
      commonDirectory,
      ownershipPath: join(root, '.raf-hotfix', 'runs', 'mac-release-test', 'ownership.json'),
    };
    const host = { orchestratorRoot: root, qaHome, environment: {}, sandboxExecutable: 'unused' };
    const lock = join(gitDirectory, 'raf-writer.lock');
    return { root, main, cwd, projects, host, workspace, lock, ownerPath: join(lock, 'owner.json') };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('Darwin accepts only the configured canonical mac source and its actual Git identity', darwinOnly, async () => {
  const f = await fixture();
  try {
    const result = await validateReleaseWorkspace(f.host, f.workspace, 'mac');
    assert.equal(result.cwd, f.main);
    assert.equal(result.repositoryIdentity, f.workspace.repositoryIdentity);
    assert.equal(result.productionDirectory, f.workspace.commonDirectory);
    assert.equal(typeof result.control, 'string');
    assert.notEqual(result.control, '');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Non-Darwin refuses mac as a release source even with the canonical configured worktree', { skip: process.platform === 'darwin' }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(validateReleaseWorkspace(f.host, f.workspace, 'mac'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Darwin mac source refuses forged Git metadata and symlink aliases', darwinOnly, async () => {
  const f = await fixture();
  try {
    await validateReleaseWorkspace(f.host, f.workspace, 'mac');
    const foreign = join(f.root, 'foreign-git');
    await mkdir(foreign);
    await assert.rejects(validateReleaseWorkspace(f.host, { ...f.workspace, gitDirectory: foreign }, 'mac'));
    await assert.rejects(validateReleaseWorkspace(f.host, { ...f.workspace, commonDirectory: foreign }, 'mac'));
    await assert.rejects(validateReleaseWorkspace(f.host, { ...f.workspace, repositoryIdentity: foreign }, 'mac'));
    const alias = join(f.root, 'mac-alias');
    await symlink('raf-mac', alias);
    await assert.rejects(validateReleaseWorkspace(f.host, { ...f.workspace, cwd: alias }, 'mac'));
    f.projects.projects.raf.branchPaths.mac = 'mac-alias';
    await writeFile(join(f.root, 'conf', 'projects.json'), JSON.stringify(f.projects));
    await assert.rejects(validateReleaseWorkspace(f.host, f.workspace, 'mac'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Darwin mac source refuses an actual wrong branch or a moved mac worktree', darwinOnly, async () => {
  const f = await fixture();
  try {
    await validateReleaseWorkspace(f.host, f.workspace, 'mac');
    await git(f.cwd, 'checkout', '-b', 'other');
    await assert.rejects(validateReleaseWorkspace(f.host, f.workspace, 'mac'));
    await git(f.cwd, 'checkout', 'mac');
    const moved = join(f.root, 'moved-mac');
    await git(f.main, 'worktree', 'move', f.cwd, moved);
    await assert.rejects(validateReleaseWorkspace(f.host, { ...f.workspace, cwd: moved }, 'mac'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Darwin release writer preserves a live owner and never enters a competing callback', darwinOnly, async () => {
  const f = await fixture();
  try {
    const owner = { pid: process.pid, start: await processStart(process.pid), token: randomUUID() };
    const original = JSON.stringify(owner);
    await mkdir(f.lock);
    await writeFile(f.ownerPath, original, { flag: 'wx' });
    let entered = false;
    await assert.rejects(withReleaseWriter(f.host, f.workspace, 'mac', async () => { entered = true; }));
    assert.equal(entered, false);
    assert.equal(await readFile(f.ownerPath, 'utf8'), original);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Darwin release writer retains an unknown legacy Darwin identity while its PID is live', darwinOnly, async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify({ pid: process.pid, start: 'Mon Jan 1 00:00:00 1990', token: randomUUID() });
    await mkdir(f.lock);
    await writeFile(f.ownerPath, original, { flag: 'wx' });
    let entered = false;
    await assert.rejects(withReleaseWriter(f.host, f.workspace, 'mac', async () => { entered = true; }));
    assert.equal(entered, false);
    assert.equal(await readFile(f.ownerPath, 'utf8'), original);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Darwin release writer reclaims a mismatched process identity and releases its own lease', darwinOnly, async () => {
  const f = await fixture();
  try {
    await mkdir(f.lock);
    await writeFile(f.ownerPath, JSON.stringify({ pid: process.pid, start: `${await processStart(process.pid)}:stale`, token: randomUUID() }), { flag: 'wx' });
    let entered = 0;
    const result = await withReleaseWriter(f.host, f.workspace, 'mac', async () => { entered += 1; return 'acquired'; });
    assert.equal(result, 'acquired');
    assert.equal(entered, 1);
    await assert.rejects(lstat(f.lock), { code: 'ENOENT' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Darwin release writer reclaims an exited owner without relying on procfs', darwinOnly, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout!, 'data');
    assert.ok(child.pid);
    const owner = { pid: child.pid, start: await processStart(child.pid), token: randomUUID() };
    child.kill('SIGTERM');
    await exited;
    await mkdir(f.lock);
    await writeFile(f.ownerPath, JSON.stringify(owner), { flag: 'wx' });
    let entered = 0;
    const result = await withReleaseWriter(f.host, f.workspace, 'mac', async () => { entered += 1; return 'reclaimed'; });
    assert.equal(result, 'reclaimed');
    assert.equal(entered, 1);
    await assert.rejects(lstat(f.lock), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Darwin release writer rechecks a live identity under its reclamation fence', darwinOnly, async () => {
  const f = await fixture();
  const originalPath = process.env.PATH;
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout!, 'data');
    assert.ok(child.pid);
    const owner = { pid: child.pid, start: await processStart(child.pid), token: randomUUID() };
    const original = JSON.stringify(owner);
    await mkdir(f.lock);
    await writeFile(f.ownerPath, original, { flag: 'wx' });
    const bin = join(f.root, 'bin');
    const counter = join(f.root, 'ps-observations');
    await mkdir(bin);
    await writeFile(counter, '0');
    const helper = join(bin, 'ps');
    await writeFile(helper, `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const output = execFileSync('/bin/ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
const selected = args.length === 4 && args[0] === '-p' && args[1] === ${JSON.stringify(String(owner.pid))} && args[2] === '-o' && args[3] === 'stat=,lstart=';
if (selected) {
  const counter = ${JSON.stringify(counter)};
  const observations = Number(readFileSync(counter, 'utf8')) + 1;
  writeFileSync(counter, String(observations));
  process.stdout.write(observations === 1 ? output.replace(/^(\\s*\\S+)\\s+.*$/m, '$1 Mon Jan  1 00:00:00 1990') : output);
} else {
  process.stdout.write(output);
}
`);
    await chmod(helper, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? '/usr/bin:/bin'}`;
    let entered = false;

    await assert.rejects(withReleaseWriter(f.host, f.workspace, 'mac', async () => { entered = true; }));

    assert.equal(entered, false);
    assert.ok(Number(await readFile(counter, 'utf8')) >= 2);
    assert.equal(await readFile(f.ownerPath, 'utf8'), original);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(f.root, { recursive: true, force: true });
  }
});
