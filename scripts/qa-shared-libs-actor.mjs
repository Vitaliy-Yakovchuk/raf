import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const [mode, report] = process.argv.slice(2);
assert.ok(['dependent', 'independent'].includes(mode));
assert.ok(path.isAbsolute(report ?? ''));
const own = path.dirname(report);
assert.match(own, /^\/srv\/dev\/cfc97-[^/]+\/\.raf\/tmp\/[a-f0-9-]+$/);
const root = path.resolve(process.cwd(), '..');
assert.equal(process.cwd(), path.join(root, 'etchly-develop'));
const library = path.join(root, 'shared-libs-develop');
const atomic = (file, data) => {
  fs.writeFileSync(file + '.part', JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
};
const evidence = { mode, runId: path.basename(own), pid: process.pid, cwd: process.cwd(),
  library, commands: [], denials: [], status: 'failed' };
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000 });
  evidence.commands.push({ command: ['git', '-C', cwd, ...args], cliExitCode: result.status,
    signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
try {
  assert.equal(fs.realpathSync('shared-libs'), library);
  assert.equal(git(process.cwd(), 'branch', '--show-current'), 'develop');
  assert.equal(git(library, 'branch', '--show-current'), 'develop');
  evidence.gitDirectory = git(library, 'rev-parse', '--absolute-git-dir');
  evidence.commonDirectory = git(library, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const marker = 'qa-cfc97-' + mode + '.txt';
  let repository;
  if (mode === 'dependent') {
    repository = library;
    fs.writeFileSync(path.join(process.cwd(), 'shared-libs', marker), evidence.runId + '\n', { flag: 'wx' });
    assert.equal(fs.readFileSync(path.join(library, marker), 'utf8'), evidence.runId + '\n');
  } else {
    assert.ok(fs.existsSync(path.join(library, 'qa-cfc97-dependent.txt')), 'Host positive control must exist');
    for (const target of [path.join(library, marker), path.join(process.cwd(), 'shared-libs', marker),
      path.join(evidence.gitDirectory, marker), path.join(evidence.commonDirectory, marker)]) {
      let failure;
      try { fs.writeFileSync(target, evidence.runId, { flag: 'wx' }); }
      catch (error) { failure = { target, code: error.code, message: error.message }; }
      evidence.denials.push(failure ?? { target, unexpectedlyWritable: true });
      assert.ok(failure && ['EROFS', 'EACCES', 'EPERM'].includes(failure.code), 'Expected real sandbox denial: ' + target);
      assert.equal(fs.existsSync(target), false);
    }
    repository = process.cwd();
    fs.writeFileSync(path.join(repository, marker), evidence.runId + '\n', { flag: 'wx' });
  }
  assert.equal(git(repository, 'status', '--porcelain', '--untracked-files=all'), '?? ' + marker);
  git(repository, 'add', '--', marker);
  git(repository, 'commit', '--only', '-m', 'qa: shared-libs ' + mode + ' sandbox probe', '--', marker);
  const sha = git(repository, 'rev-parse', 'HEAD');
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(git(repository, 'show', '--format=', '--name-only', sha), marker);
  evidence.commit = { repository, sha }; evidence.status = 'passed';
  atomic(path.join(own, 'cfc97-probe.json'), evidence);
  atomic(report, { status: 'succeeded', answer: 'Ізольований живий sandbox: ' + mode + ' пройдено.',
    changes: [{ id: 'cfc97-fixture', items: [{ id: mode === 'dependent' ? '1.1' : '1.2', status: 'succeeded' }] }],
    commits: [evidence.commit], context: { unnecessary: [], missing: [] }, evidence: 'cfc97-probe.json' });
  console.log(JSON.stringify({ mode, runId: evidence.runId, status: evidence.status, commit: evidence.commit }));
} catch (error) {
  evidence.error = error.stack;
  atomic(path.join(own, 'cfc97-probe.json'), evidence);
  console.error(error.stack); process.exitCode = 1;
}
