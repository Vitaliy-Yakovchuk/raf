import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [actor, reportPath] = process.argv.slice(2);
if (!['a', 'b'].includes(actor) || !path.isAbsolute(reportPath)) throw Error('Expected actor a/b and assigned report_path');
const cwd = fs.realpathSync(process.cwd());
const root = path.dirname(cwd), own = path.dirname(reportPath);
const run = (exe, args, timeout = 20000) => {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  return { command: [exe, ...args], cliExitCode: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const probe = { actor, cwd, runId: path.basename(own), env: { HOME: process.env.HOME, RAF_QA_HOME: process.env.RAF_QA_HOME }, git: {}, boundaries: {} };
for (const [key, args] of Object.entries({ head: ['rev-parse', 'HEAD'], branch: ['branch', '--show-current'], top: ['rev-parse', '--show-toplevel'], gitDir: ['rev-parse', '--absolute-git-dir'], common: ['rev-parse', '--path-format=absolute', '--git-common-dir'] })) probe.git[key] = run('git', args);
const main = path.join(root, 'raf-main'), develop = path.join(root, 'raf-develop');
const common = probe.git.common.stdout.trim();
for (const [name, file] of Object.entries({ mainSource: path.join(main, 'src/production-runtime.ts'), developSource: path.join(develop, 'src/production-runtime.ts'), mainHead: path.join(common, 'HEAD'), mainIndex: path.join(common, 'index'), mainRef: path.join(common, 'refs/heads/main'), developHead: path.join(common, 'worktrees/raf-develop/HEAD'), developIndex: path.join(common, 'worktrees/raf-develop/index'), gitConfig: path.join(common, 'config'), parentIndex: path.join(root, '.git/index') })) {
  try { fs.closeSync(fs.openSync(file, 'r+')); probe.boundaries[name] = { writable: true, file }; }
  catch (e) { probe.boundaries[name] = { writable: false, file, code: e.code }; }
}
const alias = path.join(cwd, `qa/alias-${actor}`);
try {
  fs.symlinkSync(path.join(main, 'src/production-runtime.ts'), alias);
  try { fs.closeSync(fs.openSync(alias, 'r+')); probe.boundaries.alias = { writable: true }; }
  catch (e) { probe.boundaries.alias = { writable: false, code: e.code }; }
} finally { try { fs.unlinkSync(alias); } catch {} }
const marker = `qa/own-${actor}.json`;
fs.writeFileSync(path.join(cwd, marker), JSON.stringify(probe, null, 2) + '\n');
atomic(path.join(own, 'probe.json'), probe);
console.log('Z331_PROBE_READY', actor);
const deadline = Date.now() + 900000;
const wait = async name => { while (!fs.existsSync(path.join(own, name))) { if (Date.now() > deadline) throw Error('Host gate timeout: ' + name); await delay(250); } };
await wait('commit-go');
const commit = run(process.execPath, [path.join(own, 'hotfix-commit.mjs'), '--message', `qa: own Z331 ${actor} evidence`, marker], 15000);
atomic(path.join(own, 'commit-result.json'), commit);
console.log('Z331_COMMIT_RESULT', actor, commit.cliExitCode, commit.signal);
let sha;
try { sha = JSON.parse(commit.stdout).commit; } catch {}
const boundariesOk = Object.values(probe.boundaries).every(x => x.writable === false && ['EACCES', 'EPERM', 'EROFS'].includes(x.code));
const ok = commit.cliExitCode === 0 && /^[0-9a-f]{40}$/.test(sha ?? '') && boundariesOk && probe.git.branch.stdout.trim() === 'hotfix';
atomic(path.join(own, 'worker-ready.json'), { ok, commit, probe, sha: sha ?? null });
await wait('report-go');
const reason = ok ? undefined : `Live probe or own commit failed; see own probe.json/commit-result.json (commit status ${commit.cliExitCode}, signal ${commit.signal})`;
const report = { status: ok ? 'succeeded' : 'failed', answer: reason ?? `Own Z331 ${actor} commit ${sha}; shared hotfix and real boundary probes verified.`, changes: [{ id: 'z331-live-fixture', items: [{ id: actor === 'a' ? '1.1' : '1.2', status: ok ? 'succeeded' : 'failed', ...(reason ? { reason } : {}) }] }], commits: sha ? [{ repository: cwd, sha }] : [], context: { unnecessary: [], missing: [] } };
atomic(reportPath, report);
console.log('Z331_REPORT_WRITTEN', actor, report.status);
