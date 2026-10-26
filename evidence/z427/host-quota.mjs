import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert.equal(args.length, 6, 'Usage: node host-quota.mjs --orchestrator ROOT --source-home HOME --evidence DIRECTORY');
assert.deepEqual([args[0], args[2], args[4]], ['--orchestrator', '--source-home', '--evidence']);
const source = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const orchestrator = await fs.realpath(args[1]);
const ownerHome = await fs.realpath(args[3]);
const evidence = resolve(args[5]);
await fs.mkdir(evidence, { mode: 0o700 });
const stand = await fs.mkdtemp(join(tmpdir(), 'z427-'));
await fs.chmod(stand, 0o700);
const root = join(stand, 'root');
const home = join(stand, 'home');
const code = join(root, 'raf-develop');
const socket = join(home, '.raf/tmp/tmux/server.sock');
const env = { ...process.env, HOME: home, RAF_QA_HOME: home, RAF_ORCHESTRATOR_ROOT: root, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: join(stand, 'tmp') };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') || ['TMUX', 'TMUX_PANE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ALLOW_MIGRATIONS', 'RAF_STATE_DIRECTORY', 'RAF_CODE_ROOT'].includes(key)) delete env[key];
const run = (executable, argv, cwd = root, required = true) => {
  const result = spawnSync(executable, argv, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const value = { executable, argv, cwd, exitCode: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
  if (required) assert.equal(value.exitCode, 0, JSON.stringify(value));
  return value;
};
const write = (name, value) => fs.writeFile(join(evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = async path => createHash('sha256').update(await fs.readFile(path)).digest('hex');
const ownerFiles = [join(ownerHome, '.claude.json'), join(ownerHome, '.claude/.credentials.json')];
const ownerHashes = async () => Object.fromEntries(await Promise.all(ownerFiles.map(async path => [path, await hash(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })])));
const summary = { source, stand, home, root, startedAt: new Date().toISOString(), success: false, cleanup: null };
let before;
const observed = new Map();
let captureIndex = 0;
const identity = async pid => {
  try { const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return fields[0] === 'Z' ? null : fields[19]; } catch { return null; }
};
const observe = async () => {
  const panes = run('tmux', ['-S', socket, 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}'], root, false);
  if (panes.exitCode !== 0) return;
  const rows = run('ps', ['-eo', 'pid=,ppid='], root).stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set(panes.stdout.trim().split('\n').map(line => Number(line.split('\t')[1])));
  for (let pass = 0; pass < rows.length; pass++) { let added = false; for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); added = true; } if (!added) break; }
  for (const pid of owned) { const tick = await identity(pid); if (tick) observed.set(pid, tick); }
  for (const line of panes.stdout.trim().split('\n')) {
    const pane = line.split('\t')[0];
    const capture = run('tmux', ['-S', socket, 'capture-pane', '-p', '-J', '-S', '-', '-t', pane], root, false);
    if (capture.exitCode === 0) await write(`capture-${++captureIndex}.txt`, capture.stdout.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>'));
  }
};
try {
  for (const directory of [root, home, env.TMPDIR, join(home, '.claude'), join(root, 'conf')]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  before = await ownerHashes();
  assert.ok(before[ownerFiles[0]], 'Source HOME must have .claude.json onboarding state');
  for (const path of ownerFiles) if (before[path]) { const target = join(home, path.slice(ownerHome.length + 1)); await fs.copyFile(path, target); await fs.chmod(target, 0o600); }
  for (const name of ['raf.json', 'models.json', 'raf-constants.json', 'projects.json', 'flow.json', 'test-runs.json']) await fs.copyFile(join(orchestrator, 'conf', name), join(root, 'conf', name));
  const projects = JSON.parse(await fs.readFile(join(root, 'conf/projects.json'), 'utf8'));
  projects.projects.raf.path = 'raf-main';
  projects.projects.raf.branchPaths = { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' };
  delete projects.projects.raf.mainCopies;
  await fs.writeFile(join(root, 'conf/projects.json'), JSON.stringify(projects));
  const sourceHead = run('git', ['rev-parse', 'HEAD'], source).stdout.trim();
  summary.sourceHead = sourceHead;
  summary.sourceStatus = run('git', ['status', '--short', '--untracked-files=no'], source).stdout;
  assert.equal(summary.sourceStatus, '', 'Run only from a clean committed clone');
  run('git', ['init', '-q', '--initial-branch=main']);
  run('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'raf-main']);
  run('git', ['checkout', '--detach', sourceHead], join(root, 'raf-main'));
  run('git', ['checkout', '-B', 'main'], join(root, 'raf-main'));
  run('git', ['worktree', 'add', '-b', 'develop', code, sourceHead], join(root, 'raf-main'));
  const dependencyCandidates = [join(source, 'node_modules/typescript'), join(orchestrator, 'raf-main/node_modules/typescript'), join(orchestrator, 'raf-hotfix/node_modules/typescript')];
  const dependency = (await Promise.all(dependencyCandidates.map(async path => await fs.stat(path).then(() => path, () => null)))).find(Boolean);
  assert.ok(dependency, 'A local TypeScript dependency is required; no install is performed');
  await fs.mkdir(join(code, 'node_modules'), { recursive: true });
  await fs.cp(dependency, join(code, 'node_modules/typescript'), { recursive: true, dereference: true });
  const { ensureProductionMainStore } = await import(pathToFileURL(join(code, 'src/main-production-store.ts')).href);
  const inherited = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try { await ensureProductionMainStore({ root }); } finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, inherited); }
  await write('build.json', run(process.execPath, ['scripts/build.ts'], code));
  const settings = JSON.parse(await fs.readFile(join(root, 'conf/raf.json'), 'utf8'));
  const protocol = settings.runnerProtocols.find(row => row.runner === 'claude');
  assert.equal(protocol.version, '2.1.308');
  const version = run(protocol.executable, ['--version'], code);
  await write('version.json', version);
  assert.match(version.stdout, /^2\.1\.310\s+\(Claude Code\)/);
  summary.pinnedVersion = protocol.version;
  summary.ownerBefore = before;
  const configBefore = await hash(join(root, 'conf/raf.json'));
  const deadline = JSON.parse(await fs.readFile(join(root, 'conf/flow.json'), 'utf8')).integrationTests.timeoutMs;
  assert.ok(Number.isFinite(deadline) && deadline > 0);
  const command = { executable: process.execPath, argv: [join(code, 'bin/raf.ts'), 'runner', 'limits', '--runners', 'claude'], cwd: code };
  const child = spawn(command.executable, command.argv, { cwd: code, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, spawnError = null;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { spawnError = error.message; });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000).unref(); }, deadline);
  let busy = false;
  const polling = setInterval(() => { if (!busy) { busy = true; observe().catch(error => { summary.observationError = error.message; }).finally(() => { busy = false; }); } }, 500);
  const finished = await new Promise(done => child.once('close', (exitCode, signal) => done({ exitCode, signal })));
  clearTimeout(timer); clearInterval(polling);
  while (busy) await new Promise(done => setTimeout(done, 10));
  await observe();
  await write('limits.stdout', stdout);
  await write('limits.stderr', stderr);
  await write('limits.json', { ...command, ...finished, timedOut, spawnError, timeoutPolicy: 'conf/flow.json#/integrationTests/timeoutMs', timeoutMs: deadline });
  summary.command = { ...command, ...finished, timedOut, spawnError };
  assert.equal(timedOut, false);
  assert.equal(finished.exitCode, 0, stderr);
  const output = JSON.parse(stdout);
  const objects = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(objects)];
  const records = objects(output);
  assert.ok(records.some(row => row.runner === 'claude' && row.collected === true), 'Fresh Claude quota collection required');
  assert.ok(records.some(row => Array.isArray(row.issues) && row.issues.includes('версія 2.1.310 не збігається з перевіреною 2.1.308, протокол не перевірено')), 'Version warning required');
  assert.equal(await hash(join(root, 'conf/raf.json')), configBefore);
  summary.success = true;
} catch (error) {
  summary.error = { name: error.name, message: error.message };
} finally {
  const sessions = run('tmux', ['-S', socket, 'list-sessions', '-F', '#{session_name}'], root, false);
  const remaining = [];
  for (const [pid, tick] of observed) if (await identity(pid) === tick) remaining.push({ pid, startTicks: tick });
  summary.cleanup = { beforeCleanupSessions: sessions.stdout.trim(), remainingOwnedProcesses: remaining, complete: sessions.stdout.trim() === '' && remaining.length === 0 };
  run('tmux', ['-S', socket, 'kill-server'], root, false);
  for (const { pid, startTicks } of remaining) if (await identity(pid) === startTicks) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await new Promise(done => setTimeout(done, 1000));
  for (const { pid, startTicks } of remaining) if (await identity(pid) === startTicks) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  if (remaining.length) await new Promise(done => setTimeout(done, 1000));
  summary.cleanup.afterForcedCleanup = [];
  for (const { pid, startTicks } of remaining) if (await identity(pid) === startTicks) summary.cleanup.afterForcedCleanup.push(pid);
  summary.ownerAfter = await ownerHashes();
  summary.ownerUnchanged = before !== undefined && JSON.stringify(before) === JSON.stringify(summary.ownerAfter);
  summary.success &&= summary.cleanup.complete && summary.ownerUnchanged;
  await fs.rm(stand, { recursive: true, force: true });
  summary.standRemoved = true;
  summary.endedAt = new Date().toISOString();
  await write('summary.json', summary);
  console.log(JSON.stringify({ evidence, success: summary.success, error: summary.error ?? null }));
  process.exitCode = summary.success ? 0 : 1;
}
