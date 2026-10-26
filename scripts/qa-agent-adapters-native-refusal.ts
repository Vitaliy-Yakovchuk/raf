import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { agentRunFixture, until, alive } from '../test/agent-run-fixture.ts';
import { buildCatalog } from '../src/bootstrap.ts';
import { configureLiveAdapter, prepareLiveNativeEnvironment } from './qa-agent-adapters-live-config.ts';
import { publicAdapterMain } from '../test/agent-adapters-public-fixture.ts';

const exec = promisify(execFile);
const [reviewed, runner, evidenceArg] = process.argv.slice(2);
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.ok(['codex', 'claude'].includes(runner));
assert.ok(evidenceArg?.startsWith('/'));
const source = resolve(import.meta.dirname, '..');
assert.equal((await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim(), reviewed);
const evidence = resolve(evidenceArg);
await fs.mkdir(evidence, { recursive: false, mode: 0o700 });
const atomic = async (name: string, value: unknown) => {
  const target = join(evidence, name + '.json');
  await fs.writeFile(target + '.part', JSON.stringify(value, null, 2) + '\n');
  await fs.rename(target + '.part', target);
};
const configRoot = resolve(source, '../conf');
const raf = JSON.parse(await fs.readFile(join(configRoot, 'raf.json'), 'utf8'));
const flow = JSON.parse(await fs.readFile(join(configRoot, 'flow.json'), 'utf8'));
const protocol = raf.runnerProtocols.find((p: any) => p.runner === runner);
assert.ok(protocol);
const nativeExecutable = (await exec('/bin/sh', ['-c', 'command -v "$1"', 'qa-native', protocol.executable])).stdout.trim();
const cleanups: Array<() => any> = [];
const summary: any = { reviewed, runner, mode: 'L2-native-noauth-refusal', status: 'failed', startedAt: new Date().toISOString(), checks: [],
  boundary: 'Actual installed CLI with a new private empty auth HOME and API credential variables removed only from its environment. No installed CLI, owner auth/config, or global settings are changed. No synthetic screen. This covers observed startup refusal without blind input, not the complete L2 matrix.',
  unexecuted: ['Positive trust route', 'NBSP/paste/modeHints/working/finished', 'Intentional permission dialog', 'Version warning and nonworking version command', 'Full L4 native matrix'] };
let f: any;
try {
  summary.config = Object.fromEntries(await Promise.all(['raf.json', 'models.json', 'flow.json', 'projects.json', 'raf-constants.json', 'test-runs.json'].map(async name => [name, createHash('sha256').update(await fs.readFile(join(configRoot, name))).digest('hex')])));
  const version = await exec(nativeExecutable, ['--version'], { timeout: protocol.timeouts.overallMs });
  await fs.writeFile(join(evidence, 'native-version.stdout'), version.stdout);
  await fs.writeFile(join(evidence, 'native-version.stderr'), version.stderr);
  summary.version = { executable: nativeExecutable, command: [nativeExecutable, '--version'], cliCode: 0 };
  f = await agentRunFixture({ after(fn: () => any) { cleanups.push(fn); } }, 'live', protocol.timeouts, 'codex', { productionQa: true, tasks: 2, commands: ['main attach'] });
  const cfg = JSON.parse(await fs.readFile(join(f.directory, 'fixture.json'), 'utf8'));
  summary.stand = { directory: f.directory, root: cfg.root, home: cfg.home, statePath: cfg.statePath };
  await fs.unlink(join(f.directory, 'bin/codex'));
  const authHome = join(f.directory, 'native-empty-auth');
  const codexHome = join(authHome, '.codex');
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = { HOME: authHome, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: undefined,
    OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined, OPENAI_BASE_URL: undefined, ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined };
  summary.nativeEnvironment = await prepareLiveNativeEnvironment(f.directory, runner, environment, nativeExecutable);
  summary.trust = (await configureLiveAdapter(cfg, configRoot, runner, raf)).trust;
  const auditPath = join(f.control, 'tmux-native-input.jsonl');
  const tmuxPath = join(f.directory, 'bin/tmux');
  const original = await fs.readFile(tmuxPath, 'utf8');
  assert.ok(original.includes('const input = process.argv.slice(2);'));
  assert.ok(original.includes("const result = spawnSync(c.tmux, ['-L', c.tmuxLabel, ...args]"));
  const audited = original.replace("import { readFileSync } from 'node:fs';", "import { readFileSync, appendFileSync } from 'node:fs';")
    .replace('const input = process.argv.slice(2);', "const input = process.argv.slice(2); appendFileSync(" + JSON.stringify(auditPath) + ", JSON.stringify({at:Date.now(),args:input})+'\\n');")
    .replace('const result = spawnSync(c.tmux,', "if (args.includes('capture-pane')) { const target = args[args.indexOf('-t')+1]; const probe = spawnSync(c.tmux, ['-L', c.tmuxLabel, 'display-message', '-p', '-t', target, '#{pane_pid}'], {encoding:'utf8',env:process.env}); appendFileSync(" + JSON.stringify(auditPath) + ", JSON.stringify({at:Date.now(),observation:'native-pane-pid',target,exitCode:probe.status,pid:Number(probe.stdout?.trim())})+'\\n'); }\nconst result = spawnSync(c.tmux,");
  await fs.writeFile(tmuxPath, audited, { mode: 0o700 });
  const constants = JSON.parse(await fs.readFile(join(cfg.root, 'conf/raf-constants.json'), 'utf8'));
  buildCatalog(join(cfg.root, 'conf'), cfg.artifact, constants.commands.map((c: any) => c.path.join(' ')));
  await fs.mkdir(join(cfg.sourceRoot, 'dist'), { recursive: true });
  await fs.copyFile(cfg.artifact, join(cfg.sourceRoot, 'dist/catalog.json'));
  const briefSentinel = 'PRIVATE-L2-NEVER-DELIVER-' + createHash('sha256').update(evidence).digest('hex');
  await fs.writeFile(join(cfg.root, 'openspec/changes/launch-failure-fixture/tasks.md'), '- [ ] 1.1 ' + briefSentinel + '\n- [ ] 1.2 Keep private stand active for cleanup.\n');
  await f.git('add', '--', 'conf', 'openspec/changes/launch-failure-fixture/tasks.md');
  await f.git('commit', '-qm', 'Native noauth refusal private assignment');
  const main = await publicAdapterMain(f, cfg, flow.integrationTests.timeoutMs, environment);
  summary.main = main.attached;
  await atomic('progress', summary);
  const result = await main.command(f.runArgs('native-refusal'));
  await atomic('launch', result);
  assert.notEqual(result.exitCode, 0, 'Native startup must refuse without existing auth');
  const failure = JSON.parse(result.result.stderr.trim().split('\n').at(-1));
  assert.equal(failure.code, 'LAUNCH_FAILED', 'Capacity, resource, version and setup refusals are not native readiness evidence');
  assert.match(failure.message, /Runner readiness (?:auth_required|unknown_screen|exited)/, 'An actual observed readiness refusal is required');
  const audits = (await fs.readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(audits.some(record => record.args?.includes('capture-pane')), 'Native screen observation required');
  const inputs = audits.filter(record => record.args?.some((arg: string) => ['send-keys', 'load-buffer', 'paste-buffer'].includes(arg)));
  await atomic('native-input-audit', { records: audits, inputs, boundary: 'Full wrapper commands from this private stand only; no synthetic runner or generated native screen.' });
  assert.deepEqual(inputs, [], 'No blind key, buffer load, brief paste or Enter may follow an unrecognized/auth screen');
  assert.equal(audits.some(record => record.args?.includes(briefSentinel)), false);
  const state = f.inspect();
  await atomic('after-refusal', state);
  const session = state.sessions.find((s: any) => s.addressId === 'native-refusal');
  assert.ok(session?.runId, 'Persisted identity of the refused native launch is required');
  assert.equal(session.state, 'finished');
  const observedPids = [...new Set(audits.filter(record => record.observation === 'native-pane-pid' && record.exitCode === 0 && Number.isSafeInteger(record.pid) && record.pid > 0).map(record => record.pid))];
  assert.ok(observedPids.length, 'Independent native pane PID observation before the readiness refusal is required');
  for (const pid of observedPids) await until(() => alive(pid), (value: boolean) => !value, 'Verified refused native pane process exit', protocol.timeouts.overallMs);
  assert.deepEqual(failure.details.pending, [], 'No unverified native process may remain pending');
  assert.equal(failure.details.retrySafe, true);
  assert.deepEqual(state.claims, [], 'Refused launch task claims must be released');
  assert.deepEqual(state.admission, [], 'Refused launch admission must be released');
  assert.equal(state.sessions.find((s: any) => s.addressId === 'main')?.state, 'running', 'Private main must survive its refused child launch');
  assert.deepEqual(await f.tmuxSessions(), ['adapter-main'], 'Only the independently owned private main tmux session remains');
  summary.exitObservation = { runId: session.runId, persistedProcess: session.process, observedPids, alive: false, claims: state.claims, admission: state.admission, pending: failure.details.pending };
  summary.checks.push({ id: 'L2-native-startup-refusal-no-input', status: 'passed', code: failure.code, reason: failure.message, inputs: 0,
    boundary: 'The actual returned screen class is preserved. unknown_screen is not relabeled as authentication required.' });
  summary.status = 'completed-review-required';
} catch (error: any) {
  summary.error = { message: error.message, stack: error.stack };
} finally {
  if (f) {
    try { await atomic('final-state', f.inspect()); } catch (error: any) { summary.captureError = error.message; }
    try { await fs.cp(f.tmpRoot, join(evidence, 'run-files'), { recursive: true, filter: async path => { const value = await fs.lstat(path); return value.isFile() || value.isDirectory(); } }); } catch (error: any) { summary.captureError = error.message; }
  }
  summary.cleanup = { complete: true, errors: [] as string[] };
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error: any) { summary.cleanup.complete = false; summary.cleanup.errors.push(error.message); }
  if (!summary.cleanup.complete) summary.status = 'failed';
  summary.endedAt = new Date().toISOString();
  await atomic('summary', summary);
  console.log(JSON.stringify({ status: summary.status, evidence, runner, error: summary.error?.message, cleanup: summary.cleanup }));
  process.exitCode = summary.status === 'failed' ? 1 : 0;
}
