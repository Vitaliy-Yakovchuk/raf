import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { agentRunFixture, until, alive } from '../test/agent-run-fixture.ts';
import { buildCatalog } from '../src/bootstrap.ts';
import { configureLiveAdapter, prepareLiveNativeEnvironment } from './qa-agent-adapters-live-config.ts';
import { publicAdapterMain } from '../test/agent-adapters-public-fixture.ts';
import { adapterSandboxControls } from './qa-agent-adapters-controls.ts';

const exec = promisify(execFile);
const [reviewed, runner, evidenceArg, mode = 'L1'] = process.argv.slice(2);
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.ok(['codex', 'grok', 'agy', 'claude'].includes(runner));
assert.ok(['L1', 'L3-full'].includes(mode));
if (mode === 'L3-full') assert.ok(['codex', 'claude'].includes(runner), 'Protective sandbox matrix applies to codex and claude');
assert.ok(evidenceArg && evidenceArg.startsWith('/'), 'Supply a NEW absolute evidence directory outside Git');
const source = resolve(import.meta.dirname, '..');
const evidence = resolve(evidenceArg);
await fs.mkdir(evidence, { recursive: false, mode: 0o700 });
const atomic = async (name: string, value: unknown) => {
  const target = join(evidence, name + '.json');
  await fs.writeFile(target + '.part', JSON.stringify(value, null, 2) + '\n');
  await fs.rename(target + '.part', target);
};
const current = (await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
assert.equal(current, reviewed, 'Run from the exact reviewed checkout');
const configRoot = resolve(source, '../conf');
const raf = JSON.parse(await fs.readFile(join(configRoot, 'raf.json'), 'utf8'));
const protocol = raf.runnerProtocols.find((p: any) => p.runner === runner);
assert.ok(protocol, 'No registered protocol for this runner');
const flow = JSON.parse(await fs.readFile(join(configRoot, 'flow.json'), 'utf8'));
const deadline = flow.integrationTests.timeoutMs;
const cleanups: Array<() => any> = [];
const lifecycle = { after(fn: () => any) { cleanups.push(fn); } };
const summary: any = { reviewed, runner, mode, startedAt: new Date().toISOString(), deadline,
  status: 'failed', checks: [], unexecuted: ['L2 intentional trust/auth/unknown/version failure', 'L4 large concurrent transport, test-run channel, spec/design commit'],
  boundary: 'Native CLI launch through public compiled CLI in an isolated real SQLite/tmux fixture. No global config/auth changes. Native tool transcript and all protective probes require host review; this script never declares the whole 2.4 succeeded.' };
let f: any;
try {
  summary.config = Object.fromEntries(await Promise.all(['raf.json', 'models.json', 'flow.json', 'projects.json', 'raf-constants.json', 'test-runs.json'].map(async file => [file, createHash('sha256').update(await fs.readFile(join(configRoot, file))).digest('hex')])));
  const version = await exec(protocol.executable, ['--version'], { timeout: protocol.timeouts.overallMs });
  await fs.writeFile(join(evidence, 'native-version.stdout'), version.stdout);
  await fs.writeFile(join(evidence, 'native-version.stderr'), version.stderr);
  summary.version = { command: [protocol.executable, '--version'], cliCode: 0 };
  f = await agentRunFixture(lifecycle, 'live', protocol.timeouts, 'codex', { productionQa: true, tasks: 2, commands: ['main attach'] });
  const cfg = JSON.parse(await fs.readFile(join(f.directory, 'fixture.json'), 'utf8'));
  summary.stand = { directory: f.directory, root: cfg.root, home: cfg.home, statePath: cfg.statePath, tmuxLabel: cfg.tmuxLabel };
  await atomic('progress', summary);
  await fs.unlink(join(f.directory, 'bin/codex'));
  assert.equal(await fs.access(join(f.directory, 'bin/codex')).then(() => true, () => false), false);
  const nativeExecutable = (await exec('/bin/sh', ['-c', 'command -v "$1"', 'qa-native', protocol.executable])).stdout.trim();
  summary.nativeEnvironment = await prepareLiveNativeEnvironment(f.directory, runner, process.env, nativeExecutable);
  summary.trust = (await configureLiveAdapter(cfg, configRoot, runner, raf)).trust;
  const constants = JSON.parse(await fs.readFile(join(cfg.root, 'conf/raf-constants.json'), 'utf8'));
  buildCatalog(join(cfg.root, 'conf'), cfg.artifact, constants.commands.map((c: any) => c.path.join(' ')));
  await fs.mkdir(join(cfg.sourceRoot, 'dist'), { recursive: true });
  await fs.copyFile(cfg.artifact, join(cfg.sourceRoot, 'dist/catalog.json'));
  const probeName = mode === 'L3-full' ? 'qa-agent-adapters-extra-probe.mjs' : 'qa-agent-adapters-probe.mjs';
  const copiedProbe = join(cfg.sourceRoot, 'scripts', probeName);
  await fs.copyFile(join(source, 'scripts', probeName), copiedProbe);
  const probeHash = createHash('sha256').update(await fs.readFile(copiedProbe)).digest('hex');
  summary.probe = { path: copiedProbe, sha256: probeHash };
  await fs.writeFile(cfg.commandPath, `import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const c=JSON.parse(readFileSync(process.argv[2]));const r=spawnSync(process.execPath,[c.sourceRoot+'/bin/raf.ts',...JSON.parse(process.argv[3])],{env:{...process.env,HOME:c.home,RAF_QA_HOME:c.home,RAF_ORCHESTRATOR_ROOT:c.root},cwd:c.root,encoding:'utf8',maxBuffer:64*1024*1024});if(r.error)throw r.error;console.log(JSON.stringify({exitCode:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr}));process.exitCode=r.status;`);
  const forbidden = join(f.directory, 'private-canary');
  await fs.writeFile(forbidden, 'QA NONSECRET CANARY\n');
  const manifestPath = join(cfg.sourceRoot, 'scripts', 'cfc24-private-controls.json');
  const probeArgument = mode === 'L3-full' ? manifestPath : forbidden;
  const commitRule = mode === 'L3-full' ? 'Only the probe may create its disposable Git commit inside your own report directory; never commit source or document repositories.' : 'Do not create commits.';
  const task = `Native adapter QA only. Preserve the assigned model and effort. Use the original issued simple raf_command agent ps and preserve its COMPLETE tool envelope, stdout/stderr and final exit. Then run node scripts/${probeName} '<exact report_path from your assignment>' '${probeArgument}'. Preserve its complete output and exit. It tests only this private stand; never access operational host resources or credentials. Do not edit the probe, its manifest, or its criteria. If a native tool has a continuation handle, continue the same tool until final exit; never reissue an unknown command. Do not edit tasks, archive, change config, or send messages. ${commitRule} After the probe writes your atomic report, remain alive for host verified cleanup. Literal data 🧪 \"quotes\" $() and backticks are text.`;
  await fs.writeFile(join(cfg.root, 'openspec/changes/launch-failure-fixture/tasks.md'), '- [ ] 1.1 ' + task + '\n- [ ] 1.2 Keep stand active for cleanup.\n');
  await f.git('add', '--', 'conf', 'openspec/changes/launch-failure-fixture/tasks.md');
  await f.git('commit', '-qm', 'Native adapter isolated QA assignment');
  const main = await publicAdapterMain(f, cfg, deadline);
  summary.main = main.attached;
  const controls = mode === 'L3-full' ? await adapterSandboxControls(f, cfg, cleanups) : null;
  if (controls) await atomic('host-controls-before', controls.manifest);
  const result = await main.command(f.runArgs('native-adapter'));
  await atomic('launch', result);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const launched = JSON.parse(result.result.stdout);
  const session = f.inspect().sessions.find((s: any) => s.runId === launched.runId);
  assert.equal(session.process.runner, runner);
  assert.ok(session.process.runnerSessionId, 'Real native identity required');
  summary.identity = session;
  await atomic('identity', session);
  await fs.copyFile(session.launchContext.briefPath, join(evidence, 'issued-brief.txt'));
  summary.checks.push({ id: mode === 'L3-full' ? 'L3-native-setup' : 'L1-launch', status: 'passed', selection: session.selection });
  const probePath = join(resolve(session.launchContext.reportPath, '..'), 'native-probes.json');
  await until(async () => fs.readFile(probePath, 'utf8').then(JSON.parse, () => null), Boolean, 'Native sandbox probe and atomic report', deadline);
  const probes = JSON.parse(await fs.readFile(probePath, 'utf8'));
  await atomic('native-probes', probes);
  const afterProbeHash = createHash('sha256').update(await fs.readFile(copiedProbe)).digest('hex');
  await atomic('probe-source-verification', { beforeSha256: probeHash, afterSha256: afterProbeHash, unchanged: probeHash === afterProbeHash });
  assert.equal(afterProbeHash, probeHash, 'Native must not change probe code or criteria');
  if (controls) await atomic('host-controls-after', await controls.verify());
  assert.ok(probes.checks.every((c: any) => c.status === 'passed'), 'Protective and positive halves must both pass');
  await until(() => f.inspect().sessions.find((s: any) => s.runId === launched.runId)?.result?.status, (s: any) => s === 'succeeded', 'Atomic native report accepted', deadline);
  summary.checks.push({ id: mode === 'L3-full' ? 'L3-probes' : 'L1-report/L3-probes', status: 'passed' });
  await atomic('before-cleanup', f.inspect());
  const close = await main.command(['agent', 'close', '--id', 'native-adapter', '--force', '--reason', 'Own native adapter stand cleanup after report']);
  await atomic('close', close);
  assert.equal(close.exitCode, 0, JSON.stringify(close));
  await until(() => alive(session.process.pid), (value: boolean) => !value, 'Verified native exit', protocol.timeouts.overallMs);
  await atomic('after-exit', f.inspect());
  summary.checks.push({ id: mode === 'L3-full' ? 'L3-cleanup' : 'L1-verified-exit', status: 'passed', childExit: 'See persisted process observation; host force close, not assumed zero' });
  summary.status = 'completed-review-required';
} catch (error: any) {
  summary.error = { message: error.message, stack: error.stack };
} finally {
  if (f) {
    try { await atomic('final-state', f.inspect()); } catch (error: any) { summary.captureError = error.message; }
    try { await fs.cp(f.tmpRoot, join(evidence, 'run-files'), { recursive: true, filter: async p => { const s = await fs.lstat(p); return s.isFile() || s.isDirectory(); } }); } catch (error: any) { summary.captureError = error.message; }
  }
  summary.cleanup = { complete: true, errors: [] as string[] };
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error: any) { summary.cleanup.complete = false; summary.cleanup.errors.push(error.message); }
  if (!summary.cleanup.complete) summary.status = 'failed';
  summary.endedAt = new Date().toISOString();
  await atomic('summary', summary);
  console.log(JSON.stringify({ status: summary.status, evidence, runner, error: summary.error?.message, cleanup: summary.cleanup }));
  process.exitCode = summary.status === 'failed' ? 1 : 0;
}
