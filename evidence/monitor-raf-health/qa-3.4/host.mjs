import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicArtifact, configureDeliveryStand, parsePublicDeliveryEvidence } from '../../../scripts/qa-delivery-config.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await fs.mkdtemp('/srv/dev/mrh34-');
const output = join(base, 'public');
await fs.mkdir(output, { mode: 0o700 });
const cleanEnv = {
  PATH: '/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin',
  HOME: join(base, 'home'), RAF_QA_HOME: join(base, 'home'),
  TMPDIR: base, TMUX_TMPDIR: base, LANG: 'C.UTF-8',
  CODEX_HOME: '/home/dev/.codex', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
await fs.mkdir(cleanEnv.HOME, { mode: 0o700 });
const originalEnv = { ...process.env };
const git = (...args) => spawnSync('git', ['-C', source, ...args], { env: cleanEnv, encoding: 'utf8' });
const revision = git('rev-parse', 'HEAD').stdout.trim();
const sourceStatus = git('status', '--porcelain', '--untracked-files=no').stdout;
const untrackedStatus = git('ls-files', '--others', '--exclude-standard').stdout;
const realCodex = spawnSync('/bin/sh', ['-c', 'command -v codex'], { env: cleanEnv, encoding: 'utf8' }).stdout.trim();
assert.ok(realCodex.startsWith('/'));
const versions = Object.fromEntries([['node', process.execPath, ['--version']], ['tmux', '/usr/bin/tmux', ['-V']], ['codex', realCodex, ['--version']], ['git', '/usr/bin/git', ['--version']]].map(([name, executable, args]) => {
  const result = spawnSync(executable, args, { env: cleanEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, `${name} version`);
  return [name, result.stdout.trim()];
}));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, cleanEnv);
const after = [];
const steps = [];
const checks = [];
let fixture;
let failure;
let stage = 'imports';
let cleanupComplete = false;
const publicJson = async (name, value) => fs.writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const secret = randomUUID().replaceAll('-', '');
const markers = ['mail-' + secret + '@example.invalid', 'api-' + secret, 'bearer-' + secret, '/private/customer-' + secret];
const safe = value => assertPublicArtifact(value, markers);
const check = (name, details = {}) => checks.push({ name, passed: true, ...details });
try {
  const { agentRunFixture, alive, until } = await import('../../../test/agent-run-fixture.ts');
  const { prepareCodexSandbox } = await import('../../../src/codex-sandbox.ts');
  const { privateDeliveryEvidencePorts, cleanupExpiredDeliveryEvidence } = await import('../../../src/delivery-evidence-storage.ts');
  stage = 'prepare isolated production fixture';
  fixture = await agentRunFixture({ after: callback => after.push(callback) }, 'delivery', { startupMs: 20000, transitionMs: 15000, overallMs: 90000 }, 'codex', { productionQa: true, commands: ['agent message', 'agent ps'], tasks: 2 });
  stage = 'configure isolated fixture';
  const root = join(fixture.directory, 'orchestrator');
  const cfgPath = join(fixture.directory, 'fixture.json');
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  const projects = JSON.parse(await fs.readFile(join(root, 'conf/projects.json'), 'utf8'));
  const mainRoot = join(root, projects.projects.raf.branchPaths.main);
  const initialized = spawnSync('git', ['init', '-q', '--initial-branch=main', mainRoot], { env: cleanEnv, encoding: 'utf8' });
  assert.equal(initialized.status, 0, 'Isolated main repository initialized');
  const rafPath = join(root, 'conf/raf.json');
  const raf = JSON.parse(await fs.readFile(rafPath, 'utf8'));
  configureDeliveryStand(raf, JSON.parse(await fs.readFile(join(source, '../conf/raf.json'), 'utf8')));
  await fs.writeFile(rafPath, JSON.stringify(raf));
  const conf = JSON.parse(await fs.readFile(join(root, 'conf/flow.json'), 'utf8'));
  const retention = conf.retention.failedDeliveryEvidenceMs;
  assert.ok(Number.isSafeInteger(retention) && retention > 0);
  const seed = join(fixture.tmpRoot, '.control-frame');
  await fs.writeFile(seed, `Unknown native transition\nAccount: ${markers[0]}\napi_key=${markers[1]}\nAuthorization: Bearer ${markers[2]}\nWorkspace: ${markers[3]}\nMRH34 FRAME END`, { mode: 0o600 });
  const runnerPath = join(fixture.directory, 'bin/codex');
  let renderer = await fs.readFile(runnerPath, 'utf8');
  renderer = renderer.replace("if (process.argv.includes('--version'))", `if (process.argv.includes('sandbox') || process.argv.includes('app-server')) { const r = (await import('node:child_process')).spawnSync(${JSON.stringify(realCodex)}, process.argv.slice(2), { stdio: 'inherit', env: process.env }); process.exit(r.status ?? 1); }\nif (process.argv.includes('--version'))`);
  assert.ok(renderer.includes("'\\nUnknown native transition'"));
  renderer = renderer.replace("'\\nUnknown native transition'", `"\\n" + readFileSync(${JSON.stringify(seed)}, 'utf8')`);
  await fs.writeFile(runnerPath, renderer);
  const tmuxPath = join(fixture.directory, 'bin/tmux');
  let tmux = await fs.readFile(tmuxPath, 'utf8');
  tmux = tmux.replace("import { readFileSync }", "import { readFileSync, writeFileSync }");
  tmux = tmux.replace("{stdio:'inherit',env:process.env}", "{stdio:['inherit','pipe','inherit'],env:process.env}");
  tmux = tmux.replace("if (result.error) throw result.error;", `if (result.error) throw result.error;\nif (args.includes('capture-pane') && result.status === 0) writeFileSync(${JSON.stringify(join(fixture.tmpRoot, '.last-capture'))}, result.stdout);\nif (result.stdout) process.stdout.write(result.stdout);`);
  await fs.writeFile(tmuxPath, tmux);
  const run = async (address, tasks) => {
    const command = fixture.runArgs(address, 'implement', tasks);
    const result = await fixture.command(command);
    safe(result);
    steps.push({ command: ['node', cfg.commandPath, cfgPath, JSON.stringify(command)], ...result });
    await publicJson('cli.json', steps);
    return result;
  };
  stage = 'positive agent ps';
  const ps = await fixture.command(['agent', 'ps']);
  safe(ps);
  steps.push({ command: ['node', cfg.commandPath, cfgPath, JSON.stringify(['agent', 'ps'])], ...ps });
  await publicJson('cli.json', steps);
  assert.equal(ps.exitCode, 0, 'Positive agent ps failed; see cli.json');
  stage = 'failed launch with control markers';
  const outcome = await run('mrh34-failed-a', ['1.1']);
  assert.equal(outcome.exitCode, 1, 'Expected failed launch CLI code');
  const error = JSON.parse(outcome.result.stderr);
  assert.equal(error.code, 'LAUNCH_FAILED');
  assert.match(error.message, /Unknown native input or screen during initial brief submission/);
  const session = fixture.inspect().sessions.find(row => row.addressId === 'mrh34-failed-a');
  assert.ok(session);
  const runId = session.runId;
  const recordPath = join(fixture.tmpRoot, '.delivery-evidence', runId, 'frame.json');
  stage = 'verify private decision frame';
  const recordBytes = await fs.readFile(recordPath);
  const record = JSON.parse(recordBytes);
  const decision = await fs.readFile(join(fixture.tmpRoot, '.last-capture'));
  assert.deepEqual(Buffer.from(record.capture.frame.screen), decision, 'Raw is exactly the observed tmux decision frame');
  for (const marker of markers) assert.ok(record.capture.frame.screen.includes(marker), 'Raw frame retains control secret');
  assert.match(record.capture.frame.screen, /MRH34 FRAME END/);
  assert.equal(record.runId, runId);
  assert.equal(record.runner, 'codex');
  assert.equal(record.version, '0.0.1');
  assert.ok(record.generation.length > 0);
  assert.equal(record.capture.frame.phase, 'awaiting_acceptance');
  assert.equal(record.capture.method, 'tmux capture-pane -p');
  assert.ok(record.capture.limitations.length > 0);
  assert.equal(Date.parse(record.expiresAt) - Date.parse(record.firstFailureAt), retention);
  assert.equal((await fs.stat(recordPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dirname(recordPath))).mode & 0o777, 0o700);
  const publicEvidence = parsePublicDeliveryEvidence(error.message);
  assert.equal(publicEvidence.availability, 'available');
  assert.equal(publicEvidence.reference, record.reference);
  safe(error); safe(session.abortReason);
  check('Exact private decision frame and linked redacted CLI/SQLite diagnostics', { runId, reference: record.reference, frameBytes: decision.length, frameSha256: createHash('sha256').update(decision).digest('hex'), metadata: publicEvidence.metadata });
  await assert.rejects(fs.stat(join(fixture.tmpRoot, runId)), { code: 'ENOENT' });
  assert.deepEqual(fixture.inspect().claims, []);
  assert.deepEqual(fixture.inspect().admission, []);
  assert.deepEqual((await fixture.runners()).filter(alive), []);
  assert.deepEqual(await fixture.tmuxSessions(), []);
  await until(fixture.owned, pids => pids.length === 0, 'Failed launch process cleanup', 15000);
  check('Ordinary failed launch cleanup retained raw while removing launch resources');
  for (const id of ['own-probe', 'neighbour-probe']) {
    stage = id;
    const runDirectory = join(fixture.tmpRoot, id);
    await fs.mkdir(runDirectory, { mode: 0o700 });
    const sandbox = await prepareCodexSandbox({ runId: id, invocation: { executable: realCodex, args: ['--sandbox', 'workspace-write'], liveTaskVerified: true }, scope: { hidden: [join(cfg.home, '.raf'), fixture.tmpRoot], readable: [runDirectory], tmuxDirectory: runDirectory, excludedCommands: [] }, cwd: cfg.sourceRoot, runDirectory, writableDirectories: [runDirectory], environment: { ...cleanEnv, HOME: cfg.home, RAF_QA_HOME: cfg.home, TMPDIR: fixture.directory }, timeoutMs: 30000 });
    try {
      const control = join(runDirectory, 'control');
      await fs.writeFile(control, 'readable-control');
      const probe = `const fs=require('fs'); if(fs.readFileSync(${JSON.stringify(control)},'utf8')!=='readable-control')process.exit(12); for(const path of ${JSON.stringify([recordPath, seed, join(fixture.tmpRoot, '.delivery-evidence')])}) { try { fs.readFileSync(path); process.exit(13); } catch(e) { if(!['EACCES','EPERM','ENOENT','EISDIR'].includes(e.code))process.exit(14); } } console.log('PRIVATE_RAW_DENIED; OWN_CONTROL_READABLE');`;
      const result = spawnSync(sandbox.toolSandbox.executable, [...sandbox.toolSandbox.args, process.execPath, '-e', probe], { cwd: cfg.sourceRoot, env: sandbox.environment, encoding: 'utf8', timeout: 30000 });
      safe(result.stdout); safe(result.stderr);
      steps.push({ command: [sandbox.toolSandbox.executable, ...sandbox.toolSandbox.args, process.execPath, '-e', probe], cliExitCode: result.status, stdout: result.stdout, stderr: result.stderr, signal: result.signal });
      await publicJson('cli.json', steps);
      assert.equal(result.status, 0, 'Real Codex sandbox probe succeeds');
      assert.match(result.stdout, /PRIVATE_RAW_DENIED; OWN_CONTROL_READABLE/);
      const direct = spawnSync(sandbox.toolSandbox.executable, [...sandbox.toolSandbox.args, '/usr/bin/cat', recordPath], { cwd: cfg.sourceRoot, env: sandbox.environment, encoding: 'utf8', timeout: 30000 });
      safe(direct.stdout); safe(direct.stderr);
      steps.push({ command: [sandbox.toolSandbox.executable, ...sandbox.toolSandbox.args, '/usr/bin/cat', recordPath], cliExitCode: direct.status, stdout: direct.stdout, stderr: direct.stderr, signal: direct.signal });
      assert.notEqual(direct.status, 0);
      assert.equal(direct.stdout, '');
      assert.match(direct.stderr, /Permission denied|No such file/);
      check(id + ': real sandbox denies raw and permits own control', { denialCliCode: direct.status });
    } finally { await sandbox.cleanup(); await fs.rm(runDirectory, { recursive: true, force: true }); }
  }
  stage = 'configured retention cleanup';
  const ports = privateDeliveryEvidencePorts(fixture.tmpRoot, async () => {});
  const neighbour = structuredClone(record);
  neighbour.runId = 'retention-neighbour'; neighbour.reference = randomUUID();
  neighbour.firstFailureAt = record.expiresAt;
  neighbour.expiresAt = new Date(Date.parse(record.expiresAt) + retention).toISOString();
  await ports.putIfAbsent(neighbour);
  await cleanupExpiredDeliveryEvidence(fixture.tmpRoot, new Date(Date.parse(record.expiresAt) - 1).toISOString());
  assert.ok(await ports.read(runId));
  await cleanupExpiredDeliveryEvidence(fixture.tmpRoot, record.expiresAt);
  assert.equal(await ports.read(runId), null);
  assert.ok(await ports.read(neighbour.runId));
  await cleanupExpiredDeliveryEvidence(fixture.tmpRoot, record.expiresAt);
  assert.ok(await ports.read(neighbour.runId));
  check('Configured expiry boundary and idempotent cleanup preserve later neighbour', { retentionSource: 'conf/flow.json#/retention/failedDeliveryEvidenceMs', retentionMs: retention, clock: 'Explicit cleanup timestamp at actual record expiry; no wall clock or conf changes' });
  stage = 'private write failure';
  await fs.rename(join(fixture.tmpRoot, '.delivery-evidence'), join(fixture.tmpRoot, '.retained-private-evidence'));
  await fs.writeFile(join(fixture.tmpRoot, '.delivery-evidence'), 'blocked store', { mode: 0o600 });
  const unavailable = await run('mrh34-failed-b', ['1.2']);
  assert.equal(unavailable.exitCode, 1);
  const secondary = JSON.parse(unavailable.result.stderr);
  assert.equal(secondary.code, 'LAUNCH_FAILED');
  assert.match(secondary.message, /Unknown native input or screen during initial brief submission.*Delivery evidence unavailable: storage:/s);
  assert.equal(parsePublicDeliveryEvidence(secondary.message).availability, 'unavailable');
  check('Private write failure remains secondary to original LAUNCH_FAILED');
  stage = 'scan Git for control markers';
  const tracked = git('ls-files', '-z').stdout.split('\0').filter(Boolean);
  for (const path of tracked) {
    const content = await fs.readFile(join(source, path)).catch(() => Buffer.alloc(0));
    safe(content.toString('utf8'));
  }
  check('Control markers absent from tracked Git content');
} catch (error) {
  failure = { stage, name: error.name, code: error.code ?? null, message: error.message, stack: String(error.stack).split('\n').filter(line => /^\s*at /u.test(line)).slice(0, 12) };
  if (markers.some(marker => failure.message.includes(marker))) failure.message = 'Assertion failed involving private control data; raw error withheld';
} finally {
  for (const callback of after.reverse()) {
    try { await callback(); } catch (error) { failure ??= { name: error.name, message: 'Fixture cleanup failed: ' + error.message }; }
  }
  cleanupComplete = !fixture || !(await fs.stat(fixture.directory).catch(() => null));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  safe(steps); safe(checks); safe(failure);
  await publicJson('cli.json', steps);
  const report = { status: failure ? 'failed' : 'passed', assignment: 'monitor-raf-health:3.4', revision, sourceStatus, untrackedStatus, versions, platform: { os: process.platform, arch: process.arch }, isolation: 'Private /srv/dev fixture, own HOME/TMPDIR/state; real production CLI/worker/tmux and Codex sandbox; deterministic synthetic TUI, no live model or provider request', checks, failure, cleanup: { complete: cleanupComplete, privateFixtureRemoved: cleanupComplete }, unitRun: 'Separate authorized raf test run; not invoked by this host script' };
  safe(report);
  await publicJson('summary.json', report);
  console.log(JSON.stringify({ ...report, evidenceDirectory: output }));
  process.exitCode = failure || !cleanupComplete ? 1 : 0;
}
