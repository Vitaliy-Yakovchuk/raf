import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [runner, report] = process.argv.slice(2);
assert.ok(['codex', 'grok', 'agy', 'claude'].includes(runner));
assert.ok(path.isAbsolute(report ?? ''));
const own = path.dirname(report);
assert.match(own, /^\/srv\/dev\/mr105-[^/]+\/\.raf\/tmp\/[a-f0-9-]+$/);
assert.match(process.cwd(), /^\/srv\/dev\/mr105-[^/]+\/root\/raf-develop$/);
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const evidence = { runner, runId: path.basename(own), cwd: process.cwd(), commands: [] };
const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 30000 });
  evidence.commands.push({ command: ['git', ...args], cliExitCode: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
try {
  assert.equal(git('branch', '--show-current'), 'develop');
  atomic(path.join(own, 'mr105-ready.json'), evidence);
  const until = Date.now() + 600000;
  while (!fs.existsSync(path.join(own, 'mr105-release.json')) && Date.now() < until) await delay(200);
  assert.ok(fs.existsSync(path.join(own, 'mr105-release.json')), 'Host disable observation must precede report');
  const marker = 'qa-mr105-' + runner + '.txt';
  assert.equal(git('status', '--porcelain'), '', 'Do not commit another actor changes');
  fs.writeFileSync(marker, evidence.runId + '\n', { flag: 'wx' });
  git('add', '--', marker);
  git('commit', '--only', '-m', 'qa: native model routing ' + runner, '--', marker);
  evidence.commit = { repository: process.cwd(), sha: git('rev-parse', 'HEAD') };
  assert.match(evidence.commit.sha, /^[a-f0-9]{40}$/);
  assert.equal(git('show', '--format=', '--name-only', evidence.commit.sha), marker);
  atomic(path.join(own, 'mr105-actor.json'), evidence);
  atomic(report, { status: 'succeeded', answer: 'Живий ізольований CLI виконав контрольний коміт.',
    changes: [{ id: 'mr105-fixture', items: [{ id: '1.' + (['codex', 'grok', 'agy', 'claude'].indexOf(runner) + 1), status: 'succeeded' }] }],
    commits: [evidence.commit], context: { unnecessary: [], missing: [] } });
} catch (error) {
  evidence.error = error.stack; atomic(path.join(own, 'mr105-actor.json'), evidence);
  console.error(error.stack); process.exitCode = 1;
}
