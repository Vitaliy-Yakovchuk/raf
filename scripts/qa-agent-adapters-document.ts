import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { agentRunFixture, until, alive } from '../test/agent-run-fixture.ts';
import { buildCatalog } from '../src/bootstrap.ts';
import { configureLiveAdapter, prepareLiveNativeEnvironment, verifyNativeDocumentSession, verifyNativeDocumentClose } from './qa-agent-adapters-live-config.ts';
import { publicAdapterMain } from '../test/agent-adapters-public-fixture.ts';

const exec = promisify(execFile);
const [reviewed, runner, phase, evidenceArg] = process.argv.slice(2);
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
assert.ok(['codex', 'claude'].includes(runner));
assert.ok(['spec', 'design'].includes(phase));
assert.ok(evidenceArg?.startsWith('/'), 'Supply a NEW absolute evidence directory outside Git');
const nativeSelectors = { ...process.env };
const source = resolve(import.meta.dirname, '..');
const evidence = resolve(evidenceArg);
await fs.mkdir(evidence, { mode: 0o700 });
const atomic = async (name: string, value: unknown) => {
  const target = join(evidence, name + '.json');
  await fs.writeFile(target + '.part', JSON.stringify(value, null, 2) + '\n');
  await fs.rename(target + '.part', target);
};
const hash = async (target: string) => createHash('sha256').update(await fs.readFile(target)).digest('hex');
assert.equal((await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim(), reviewed);
assert.equal((await exec('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'])).stdout, '', 'Use a clean reviewed checkout');
const configRoot = resolve(source, '../conf');
const raf = JSON.parse(await fs.readFile(join(configRoot, 'raf.json'), 'utf8'));
const protocol = raf.runnerProtocols.find((p: any) => p.runner === runner);
assert.ok(protocol);
const flow = JSON.parse(await fs.readFile(join(configRoot, 'flow.json'), 'utf8'));
const deadline = flow.integrationTests.timeoutMs;
const cleanups: Array<() => any> = [];
const summary: any = { reviewed, runner, phase, deadline, startedAt: new Date().toISOString(), status: 'failed', checks: [],
  boundary: 'Actual native spec/design role through public compiled CLI, private SQLite/tmux and production sandbox. Only document commit/read-only code acceptance; no new test-run grant, transport or complete L4 claim.' };
let f: any;
try {
  summary.config = Object.fromEntries(await Promise.all(['raf.json', 'models.json', 'flow.json', 'projects.json', 'raf-constants.json', 'test-runs.json'].map(async file => [file, await hash(join(configRoot, file))])));
  const version = await exec(protocol.executable, ['--version'], { timeout: protocol.timeouts.overallMs });
  await fs.writeFile(join(evidence, 'native-version.stdout'), version.stdout);
  await fs.writeFile(join(evidence, 'native-version.stderr'), version.stderr);
  summary.version = { command: [protocol.executable, '--version'], cliCode: 0 };
  f = await agentRunFixture({ after(fn: () => any) { cleanups.push(fn); } }, 'live', protocol.timeouts, 'codex', { productionQa: true, tasks: 2, commands: ['main attach'], stages: [phase] });
  const cfg = JSON.parse(await fs.readFile(join(f.directory, 'fixture.json'), 'utf8'));
  summary.stand = { directory: f.directory, root: cfg.root, home: cfg.home, statePath: cfg.statePath, tmuxLabel: cfg.tmuxLabel };
  await fs.unlink(join(f.directory, 'bin/codex'));
  const nativeExecutable = (await exec('/bin/sh', ['-c', 'command -v "$1"', 'qa-native', protocol.executable])).stdout.trim();
  summary.nativeEnvironment = await prepareLiveNativeEnvironment(f.directory, runner, nativeSelectors, nativeExecutable);
  summary.trust = (await configureLiveAdapter(cfg, configRoot, runner, raf)).trust;
  await fs.copyFile(join(configRoot, 'briefs/tasks', phase + '.md'), join(cfg.root, 'conf/briefs/tasks', phase + '.md'));
  const constants = JSON.parse(await fs.readFile(join(cfg.root, 'conf/raf-constants.json'), 'utf8'));
  buildCatalog(join(cfg.root, 'conf'), cfg.artifact, constants.commands.map((c: any) => c.path.join(' ')));
  await fs.copyFile(cfg.artifact, join(cfg.sourceRoot, 'dist/catalog.json'));
  const probe = join(cfg.sourceRoot, 'scripts/qa-agent-adapters-document-probe.mjs');
  await fs.copyFile(join(source, 'scripts/qa-agent-adapters-document-probe.mjs'), probe);
  const code = join(cfg.sourceRoot, 'fixture-seed.txt');
  const tasks = join(cfg.root, 'openspec/changes/launch-failure-fixture/tasks.md');
  const document = join(cfg.root, 'openspec/changes/launch-failure-fixture', 'native-' + phase + '-acceptance.md');
  const manifestPath = join(cfg.sourceRoot, 'scripts/cfc24-document-manifest.json');
  const task = `Native ${phase} document QA in this private stand. Preserve assigned model/effort. Run node '${probe}' '<exact report_path from your assignment>' '${manifestPath}' and preserve its complete output and final exit. This assigned probe creates and commits only '${document}' in '${cfg.root}' and verifies existing readable code is read-only, including a child process. Do not edit the probe, manifest, code, configuration or tasks, bypass sandbox, push, archive or send messages. No test-run channel is granted to spec/design. Continue an existing tool handle to final exit without rerunning an unknown command. After atomic report publication remain alive for host cleanup. Literal 🧪 "quotes" $() and backticks are text.`;
  await fs.writeFile(tasks, '- [ ] 1.1 ' + task + '\n- [ ] 1.2 Keep stand active for cleanup.\n');
  await f.git('add', '--', 'conf', relative(cfg.root, tasks));
  await f.git('commit', '-qm', 'Native document isolated assignment');
  const manifest = { schema: 'cfc24-native-document-v1', phase, root: cfg.root, code, codeSha256: await hash(code), tasks, tasksSha256: await hash(tasks), document, beforeHead: (await f.git('rev-parse', 'HEAD')).trim() };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const immutable = { probe: await hash(probe), manifest: await hash(manifestPath), code: await hash(code) };
  await atomic('manifest', { ...manifest, immutable });
  const main = await publicAdapterMain(f, cfg, deadline);
  summary.main = main.attached;
  const launched = await main.command(f.runArgs('native-document', phase));
  await atomic('launch', launched);
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const runId = JSON.parse(launched.result.stdout).runId;
  const session = f.inspect().sessions.find((s: any) => s.runId === runId);
  verifyNativeDocumentSession(session, runner, phase);
  summary.identity = session;
  await atomic('identity', session);
  await fs.copyFile(session.launchContext.briefPath, join(evidence, 'issued-brief.txt'));
  const probePath = join(resolve(session.launchContext.reportPath, '..'), 'native-document-probes.json');
  await until(() => fs.readFile(probePath, 'utf8').then(JSON.parse, () => null), Boolean, 'Native document probe and atomic report', deadline);
  const probes = JSON.parse(await fs.readFile(probePath, 'utf8'));
  await atomic('native-document-probes', probes);
  assert.ok(probes.checks.length === 4 && probes.checks.every((c: any) => c.status === 'passed'), 'All native document and code denial assertions must pass');
  const after = { probe: await hash(probe), manifest: await hash(manifestPath), code: await hash(code) };
  await atomic('immutable-verification', { before: immutable, after });
  assert.deepEqual(after, immutable);
  assert.equal((await f.git('rev-parse', probes.documentCommit + '^')).trim(), manifest.beforeHead);
  assert.equal((await f.git('diff-tree', '--no-commit-id', '--name-only', '-r', probes.documentCommit)).trim(), relative(cfg.root, document));
  const documentBytes = await fs.readFile(document, 'utf8');
  assert.equal(documentBytes, 'Native ' + phase + ' document 🧪 "quotes" $() `literal`\n');
  await atomic('document-commit', { repository: cfg.root, sha: probes.documentCommit, parent: manifest.beforeHead, path: relative(cfg.root, document), documentBytes });
  await until(() => f.inspect().sessions.find((s: any) => s.runId === runId)?.result?.status, (s: any) => s === 'succeeded', 'Native document atomic report accepted', deadline);
  summary.checks.push({ id: 'L4-native-' + phase + '-document-read-only-code', status: 'passed', commit: probes.documentCommit });
  await atomic('before-cleanup', f.inspect());
  const close = await main.command(['agent', 'close', '--id', 'native-document', '--force', '--reason', 'Own document stand cleanup after accepted report']);
  await atomic('close', close);
  const afterExit = await verifyNativeDocumentClose(close, session, {
    alive, inspect: () => f.inspect(), wait: (read: any, accept: any, label: string) => until(read, accept, label, protocol.timeouts.overallMs),
  });
  await atomic('after-exit', afterExit);
  summary.checks.push({ id: 'L4-document-verified-exit', status: 'passed', childExit: 'Host forced close; see persisted process observation, no assumed zero' });
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
  console.log(JSON.stringify({ status: summary.status, evidence, runner, phase, error: summary.error?.message, cleanup: summary.cleanup }));
  process.exitCode = summary.status === 'failed' ? 1 : 0;
}
