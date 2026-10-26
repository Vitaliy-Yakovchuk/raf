import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { agentRunFixture } from '../test/agent-run-fixture.ts';

const exec = promisify(execFile);
const [reviewed, evidenceArg] = process.argv.slice(2);
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.ok(evidenceArg?.startsWith('/'), 'Supply a NEW absolute evidence directory');
const source = resolve(import.meta.dirname, '..');
assert.equal((await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim(), reviewed);
const evidence = resolve(evidenceArg);
await fs.mkdir(evidence, { recursive: false, mode: 0o700 });
const cleanups: Array<() => any> = [];
const summary: any = { reviewed, startedAt: new Date().toISOString(), status: 'failed',
  boundary: 'Host-only regression of the L3 QA fixture endpoint routing. All tmux servers and resources are disposable and owned by this script. This is neither native sandbox acceptance nor a replacement for raf test run.' };
const capture = async (file: string, args: string[], options: any = {}) => {
  try { const value = await exec(file, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...options });
    return { command: [file, ...args], cliCode: 0, signal: null, stdout: value.stdout, stderr: value.stderr };
  } catch (error: any) { return { command: [file, ...args], cliCode: typeof error.code === 'number' ? error.code : null,
    signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: error.message }; }
};
try {
  summary.hashes = Object.fromEntries(await Promise.all(['test/agent-run-fixture.ts', 'scripts/qa-agent-adapters-extra-probe.mjs'].map(async name =>
    [name, createHash('sha256').update(await fs.readFile(join(source, name))).digest('hex')])));
  const settings = JSON.parse(await fs.readFile(join(source, '../conf/raf.json'), 'utf8'));
  const f = await agentRunFixture({ after(fn: () => any) { cleanups.push(fn); } }, 'live', settings.runnerProtocols.find((p: any) => p.runner === 'codex').timeouts);
  const marker = join(f.directory, 'fixture.json');
  const cfg = JSON.parse(await fs.readFile(marker, 'utf8'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cfg.home, TMPDIR: f.directory, TMUX_TMPDIR: f.directory,
    PATH: join(f.directory, 'bin') + ':' + process.env.PATH, RAF_AGENT_RUN_FIXTURE: marker };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const launch = await capture(cfg.tmux, ['-L', cfg.tmuxLabel, '-f', '/dev/null', 'new-session', '-d', '-s', 'adapter-main', 'sleep 90'], { env });
  summary.controlLaunch = launch;
  assert.equal(launch.cliCode, 0, JSON.stringify(launch));
  const control = () => capture(cfg.tmux, ['-L', cfg.tmuxLabel, 'display-message', '-p', '-t', 'adapter-main', '#{session_name}:#{pid}:#{pane_pid}'], { env });
  summary.before = await control();
  assert.equal(summary.before.cliCode, 0, JSON.stringify(summary.before));
  const own = join(f.tmpRoot, randomUUID());
  await fs.mkdir(own, { mode: 0o700 });
  const manifest = { schema: 'cfc24-private-sandbox-controls-v1', tmuxExecutable: cfg.tmux, resources: [] };
  const manifestPath = join(f.control, 'tmux-regression-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  summary.probe = await capture(process.execPath, [join(source, 'scripts/qa-agent-adapters-extra-probe.mjs'), join(own, 'result.json'), manifestPath], { env });
  summary.nativeProbes = await fs.readFile(join(own, 'native-probes.json'), 'utf8').then(JSON.parse, error => ({ unavailable: error.message }));
  summary.after = await control();
  summary.ownSocketRemains = await fs.lstat(join(own, 'extra-tmux.sock')).then(() => true, () => false);
  assert.equal(summary.after.cliCode, 0, 'L3 positive control must preserve the distinct protected control server: ' + JSON.stringify(summary.after));
  assert.equal(summary.after.stdout, summary.before.stdout, 'Protected control identity must remain unchanged');
  assert.equal(summary.probe.cliCode, 0, JSON.stringify(summary.probe));
  const ownTmux = summary.nativeProbes.checks.find((row: any) => row.id === 'L3-own-tmux');
  assert.equal(ownTmux?.status, 'passed', JSON.stringify(ownTmux));
  assert.ok(ownTmux.evidence.commands.every((command: any) => command.command[0] === cfg.tmux && command.command.includes(join(own, 'extra-tmux.sock'))), 'Positive control must invoke the independently resolved real tmux executable and own socket');
  summary.status = 'passed';
} catch (error: any) { summary.error = { message: error.message, stack: error.stack }; }
finally {
  summary.cleanup = { complete: true, errors: [] as string[] };
  for (const cleanup of cleanups.reverse()) try { await cleanup(); } catch (error: any) { summary.cleanup.complete = false; summary.cleanup.errors.push(error.message); }
  if (!summary.cleanup.complete) summary.status = 'failed';
  summary.endedAt = new Date().toISOString();
  await fs.writeFile(join(evidence, 'summary.json.part'), JSON.stringify(summary, null, 2) + '\n');
  await fs.rename(join(evidence, 'summary.json.part'), join(evidence, 'summary.json'));
  console.log(JSON.stringify(summary));
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}
