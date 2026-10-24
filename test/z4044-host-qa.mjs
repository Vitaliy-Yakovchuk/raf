import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [mode, sourceSha, evidence] = process.argv.slice(2);
assert.ok(['direct', 'live'].includes(mode), 'mode direct|live');
assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);
assert.ok(evidence && path.isAbsolute(evidence), 'absolute private evidence directory required');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownerRoot = path.dirname(source);
const home = process.env.RAF_QA_HOME;
assert.ok(home && home === process.env.HOME && home === process.env.TMPDIR, 'explicit isolated HOME=RAF_QA_HOME=TMPDIR');
assert.ok(home.startsWith('/tmp/') && fs.realpathSync(home) === home, 'own canonical mktemp HOME below /tmp');
assert.ok(!fs.existsSync(path.join(home, '.raf')), 'fresh QA HOME, never working state');
assert.ok(!fs.existsSync(evidence), 'never overwrite/replay an earlier result');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
for (const key of ['TMUX', 'TMUX_PANE', 'RAF_ORCHESTRATOR_ROOT', 'RAF_STATE_DIRECTORY', 'RAF_SOCKET_PATH', 'ALLOW_MIGRATIONS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
const root = path.join(home, 'source-root'), clone = path.join(root, 'raf-develop');
const summary = { mode, sourceSha, startedAt: new Date().toISOString(), status: 'failed', steps: [], modelPromptMayBeSent: mode === 'live', source, evidence, selectors: {}, cleanup: {} };
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (label, executable, args, cwd = source, timeout = 120000) => {
  const out = fs.openSync(path.join(evidence, label + '.stdout'), 'wx', 0o600);
  const err = fs.openSync(path.join(evidence, label + '.stderr'), 'wx', 0o600);
  let r;
  try { r = spawnSync(executable, args, { cwd, env, stdio: ['ignore', out, err], timeout }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const result = { command: [executable, ...args], cwd, cliExitCode: r.status, signal: r.signal, spawnError: r.error?.message ?? null };
  atomic(path.join(evidence, label + '.capture.json'), result); summary.steps.push({ label, ...result });
  return result;
};
const must = r => { assert.equal(r.spawnError, null); assert.equal(r.signal, null); assert.equal(r.cliExitCode, 0, 'see separate stdout/stderr'); };
try {
  must(run('source-object', 'git', ['cat-file', '-e', sourceSha + '^{commit}']));
  must(run('source-status', 'git', ['status', '--porcelain=v1']));
  summary.sourceStatus = fs.readFileSync(path.join(evidence, 'source-status.stdout'), 'utf8');
  summary.driverSha256 = hash(fileURLToPath(import.meta.url));
  fs.mkdirSync(root);
  fs.cpSync(path.join(ownerRoot, 'conf'), path.join(root, 'conf'), { recursive: true });
  must(run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', source, clone]));
  must(run('checkout', 'git', ['checkout', '--detach', sourceSha], clone));
  if (fs.existsSync(path.join(source, 'node_modules'))) fs.cpSync(path.join(source, 'node_modules'), path.join(clone, 'node_modules'), { recursive: true, dereference: true });
  for (const name of ['raf.json', 'models.json', 'flow.json']) summary[name + 'Sha256'] = hash(path.join(root, 'conf', name));
  if (mode === 'direct') {
    env.CODEX_HOME = path.join(home, 'empty-codex'); fs.mkdirSync(env.CODEX_HOME);
    env.XDG_CONFIG_HOME = path.join(home, '.config'); fs.mkdirSync(env.XDG_CONFIG_HOME);
    summary.modelPromptSent = false;
    must(run('setup', process.execPath, ['test/z404-bwrap-entry-host.mjs', 'setup', path.join(evidence, 'setup')], clone));
    const verify = run('verify', process.execPath, ['test/z404-bwrap-entry-host.mjs', 'verify', path.join(evidence, 'verify')], clone, 1200000);
    summary.matrix = JSON.parse(fs.readFileSync(path.join(evidence, 'verify/summary.json'), 'utf8'));
    must(verify); assert.equal(summary.matrix.passed, true);
    assert.equal(summary.matrix.cases.length, 11);
  } else {
    assert.ok(env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME), 'live needs an explicit existing CODEX_HOME selector, never copy auth');
    summary.codeHomeSelector = env.CODEX_HOME;
    const live = run('live', process.execPath, ['test/helpers/z4044-live-stand.mjs', sourceSha, home], clone, 1800000);
    const liveLocation = JSON.parse(fs.readFileSync(path.join(evidence, 'live.stdout'), 'utf8').trim().split('\n').at(-1));
    summary.liveLocation = liveLocation;
    summary.live = JSON.parse(fs.readFileSync(liveLocation.evidence, 'utf8'));
    must(live); assert.equal(summary.live.status, 'succeeded');
  }
  summary.status = 'succeeded';
} catch (error) { summary.error = { message: error.message, stack: error.stack }; }
finally {
  summary.selectors = Object.fromEntries(['HOME', 'RAF_QA_HOME', 'TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PATH'].map(key => [key, env[key] ?? null]));
  summary.finishedAt = new Date().toISOString();
  summary.cleanup = { retainedPrivateEvidenceAndClones: true, home, note: 'main reviews process/alias cleanup then removes this exact owned mktemp; no foreign cleanup' };
  atomic(path.join(evidence, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, evidence: path.join(evidence, 'summary.json'), error: summary.error?.message ?? null }));
  process.exitCode = summary.status === 'succeeded' ? 0 : 1;
}
