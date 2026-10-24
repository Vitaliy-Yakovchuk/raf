import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [actor, reportPath] = process.argv.slice(2);
assert.ok(['one', 'two', 'neighbor'].includes(actor));
assert.ok(path.isAbsolute(reportPath));
const own = path.dirname(reportPath), cwd = fs.realpathSync(process.cwd()), root = path.dirname(cwd);
const atomic = (file, data) => {
  fs.writeFileSync(file + '.part', JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
};
const run = (exe, args) => {
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { command: [exe, ...args], cliExitCode: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const commonResult = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
assert.equal(commonResult.cliExitCode, 0);
const common = commonResult.stdout.trim();
const files = {
  main: path.join(root, 'raf-main/src/production-runtime.ts'),
  develop: path.join(root, 'raf-develop/src/production-runtime.ts'),
  mainIndex: path.join(common, 'index'), mainHead: path.join(common, 'HEAD'),
  mainRef: path.join(common, 'refs/heads/main'), config: path.join(common, 'config'),
  developIndex: path.join(common, 'worktrees/raf-develop/index'),
  developHead: path.join(common, 'worktrees/raf-develop/HEAD'),
  parentIndex: path.join(root, '.git/index')
};
const boundaries = {};
for (const [name, file] of Object.entries(files)) {
  assert.ok(fs.existsSync(file), 'A missing sentinel is not a deny: ' + file);
  try { fs.closeSync(fs.openSync(file, 'r+')); boundaries[name] = { writable: true }; }
  catch (error) { boundaries[name] = { writable: false, code: error.code }; }
}
const alias = path.join(cwd, 'qa-z334/alias-' + actor);
try {
  fs.symlinkSync(files.main, alias);
  try { fs.closeSync(fs.openSync(alias, 'r+')); boundaries.alias = { writable: true }; }
  catch (error) { boundaries.alias = { writable: false, code: error.code }; }
} finally { fs.rmSync(alias, { force: true }); }
const probe = { actor, runId: path.basename(own), cwd, branch: run('git', ['branch', '--show-current']), boundaries, home: process.env.HOME, qaHome: process.env.RAF_QA_HOME };
atomic(path.join(own, 'probe.json'), probe);
assert.equal(probe.branch.stdout.trim(), 'hotfix');
assert.ok(Object.values(boundaries).every(row => row.writable === false && ['EACCES', 'EPERM', 'EROFS'].includes(row.code)), 'Enforced boundaries required');
let sha;
if (actor !== 'neighbor') {
  for (const name of ['a.mjs', 'b.mjs']) fs.writeFileSync(path.join(cwd, 'qa-z334', name), `export const marker = ${JSON.stringify(actor)};\n`);
  const commit = run(process.execPath, [path.join(own, 'hotfix-commit.mjs'), '--message', 'qa: Z334 ' + actor, 'qa-z334/a.mjs', 'qa-z334/b.mjs']);
  atomic(path.join(own, 'commit.json'), commit);
  assert.equal(commit.cliExitCode, 0);
  sha = JSON.parse(commit.stdout).commit;
  assert.match(sha, /^[0-9a-f]{40}$/);
}
atomic(path.join(own, 'ready.json'), { actor, sha: sha ?? null, probe });
const settings = JSON.parse(fs.readFileSync(path.join(root, 'conf/raf.json'), 'utf8'));
const poll = settings.runnerProtocols.find(row => row.runner === 'codex').timeouts.pollMs;
while (!fs.existsSync(path.join(own, 'report-go'))) await delay(poll);
const report = { status: 'succeeded', answer: 'Z334 ' + actor + ': real tool boundary probes and ' + (sha ? 'own commit ' + sha : 'session preservation') + '.', changes: [{ id: 'z334-live', items: [{ id: actor === 'one' ? '1' : actor === 'two' ? '2' : '3', status: 'succeeded' }] }], commits: sha ? [{ repository: cwd, sha }] : [], context: { unnecessary: [], missing: [] } };
atomic(reportPath, report);
console.log(JSON.stringify({ actor, reportPath, status: report.status }));
