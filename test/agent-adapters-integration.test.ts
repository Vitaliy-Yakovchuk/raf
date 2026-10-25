import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentRunFixture, alive, exists, until } from './agent-run-fixture.ts';
import { publicAdapterMain } from './agent-adapters-public-fixture.ts';

const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
const timeouts = settings.runnerProtocols.find((row: { runner: string }) => row.runner === 'codex').timeouts;
const change = 'launch-failure-fixture';
const taskFile = `openspec/changes/${change}/tasks.md`;
const exec = promisify(execFile);

async function fixture(t: TestContext, mode = 'live', preserveAfterPane = false) {
  const caseRunId = randomUUID();
  const caseDirectory = fileURLToPath(new URL('../evidence/cfc24-resumed-20261025/integration-cases/', import.meta.url));
  const casePath = join(caseDirectory, caseRunId + '.json');
  await mkdir(caseDirectory, { recursive: true });
  const events: unknown[] = [];
  const evidence = (id: string, value: unknown) => {
    events.push({ at: new Date().toISOString(), scenario: id, ...value as object });
    writeFileSync(casePath + '.part', JSON.stringify({ caseRunId, test: t.name, events }, null, 2) + '\n');
    renameSync(casePath + '.part', casePath);
  };
  t.diagnostic(JSON.stringify({ schema: 'raf-test-evidence-v1', test: { file: 'test/agent-adapters-integration.test.ts', name: t.name }, phase: 'integration', caseRunId, evidence: [casePath] }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sourceFiles = ['test/agent-adapters-integration.test.ts', 'test/agent-adapters-public-fixture.ts', 'test/agent-run-fixture.ts', 'src/message-delivery.ts', 'src/agent-adapters.ts', 'src/launch-wrapper.ts', 'src/production-runtime.ts'];
  evidence('environment-before', { mode, preserveAfterPane, node: process.version, platform: process.platform, arch: process.arch,
    head: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
    ownDiff: (await exec('git', ['diff', '--', ...sourceFiles], { cwd: root })).stdout,
    hashes: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')]))),
  });
  const f = await agentRunFixture(t, mode, timeouts, 'codex', { productionQa: true, tasks: 2, commands: ['main attach'] });
  const cfg = JSON.parse(await readFile(join(f.directory, 'fixture.json'), 'utf8'));
  await mkdir(join(cfg.sourceRoot, 'dist'), { recursive: true });
  await writeFile(join(cfg.sourceRoot, 'dist/catalog.json'), await readFile(cfg.artifact));
  await writeFile(cfg.commandPath, String.raw`
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const args = JSON.parse(process.argv[3]);
const env = { ...process.env, HOME: c.home, RAF_QA_HOME: c.home, RAF_ORCHESTRATOR_ROOT: c.root };
const result = spawnSync(process.execPath, [c.sourceRoot + '/bin/raf.ts', ...args], { cwd: c.root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.signal) throw new Error('Public CLI interrupted: ' + result.signal);
process.stdout.write(JSON.stringify({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr }) + '\n');
process.exitCode = result.status;
`);
  const runner = join(f.directory, 'bin/codex');
  let script = await readFile(runner, 'utf8');
  script = script.replace("assignment = candidate;", "assignment = candidate; writeFileSync(c.control + '/' + candidate.agent_id + '.literal', input);");
  script += String.raw`
process.stdout.on('error', () => {});
setInterval(() => {
  try {
    const request = JSON.parse(readFileSync(c.control + '/exit.json', 'utf8'));
    if (request.pid === process.pid) process.exit(request.code);
  } catch {}
}, 20);
`;
  if (preserveAfterPane) script += "\nprocess.on('SIGHUP', () => {});\n";
  await writeFile(runner, script, { mode: 0o700 });
  const tasks = join(cfg.root, taskFile);
  const literal = 'literal 🧪 "quote" $(touch ' + join(f.directory, 'must-not-exist') + ') `false`';
  await writeFile(tasks, (await readFile(tasks, 'utf8')).replace('Write launch failure fixture', 'Write launch failure fixture ' + literal));
  await f.git('add', '--', taskFile);
  await f.git('commit', '-qm', 'literal adapter fixture task');
  const main = await publicAdapterMain(f, cfg, JSON.parse(await readFile(new URL('../../conf/flow.json', import.meta.url), 'utf8')).integrationTests.timeoutMs);
  evidence('private-main', { attached: main.attached, config: cfg, compiledCatalogHash: createHash('sha256').update(await readFile(cfg.artifact)).digest('hex'), tmux: await exec(cfg.tmux, ['-V']) });
  const run = async (id: string) => {
    const result = await main.command(f.runArgs(id));
    evidence('public-agent-run', { id, result, state: f.inspect() });
    return result;
  };
  const launch = async (id: string) => {
    const cli = await run(id);
    assert.equal(cli.exitCode, 0, JSON.stringify(cli));
    assert.equal(cli.result.exitCode, 0, JSON.stringify(cli));
    const result = JSON.parse(cli.result.stdout);
    await until(() => exists(join(f.control, id + '.brief')), Boolean, 'single initial brief was received', timeouts.overallMs);
    const session = f.inspect().sessions.find(row => row.runId === result.runId)!;
    assert.ok(session?.process?.runnerSessionId, 'native identity is confirmed before delivery');
    assert.equal(session.process.runner, 'codex');
    const received = await readFile(join(f.control, id + '.literal'), 'utf8');
    assert.ok(received.includes(literal), 'literal shell-looking UTF-8 text arrived unchanged');
    assert.equal(await exists(join(f.directory, 'must-not-exist')), false);
    const payloadStart = received.search(/\{\s*"project"\s*:/);
    const assignment = JSON.parse(received.slice(payloadStart).trim());
    assert.equal(assignment.cwd, cfg.sourceRoot);
    assert.equal(assignment.report_path, session.launchContext!.reportPath);
    assert.equal(f.inspect().claims.length, 1);
    assert.equal(f.inspect().admission.length, 1);
    evidence('I1-launch', { cli, identity: session.process, runId: result.runId, selection: session.activity, claims: f.inspect().claims, admission: f.inspect().admission });
    return { result, session, assignment };
  };
  const ps = async () => {
    const listed = await main.command(['agent', 'ps']);
    assert.equal(listed.exitCode, 0, JSON.stringify(listed));
    return JSON.parse(listed.result.stdout);
  };
  return { ...f, run, cfg, literal, launch, ps, evidence, main };
}

async function publish(path: string, report: unknown) {
  await writeFile(path + '.part', JSON.stringify(report));
  await rename(path + '.part', path);
}

function report(status: 'succeeded' | 'failed') {
  return { status, answer: 'Isolated adapter integration result', commits: [], changes: [{ id: change, items: [{ id: '1.1', status, ...(status === 'failed' ? { reason: 'Intentional fixture failure' } : {}) }] }] };
}

test('[I1/I3] public compiled CLI persists identity, literal brief, atomic succeeded and nonzero exit exactly once', async t => {
  const f = await fixture(t);
  const { result, session } = await f.launch('adapter-report');
  const caller = await f.as('adapter-report', ['agent', 'ps']);
  assert.equal(caller.exitCode, 0, JSON.stringify(caller));
  await publish(session.launchContext!.reportPath, report('succeeded'));
  await until(() => f.inspect().sessions.find(row => row.runId === result.runId)?.result?.status, status => status === 'succeeded', 'watcher accepts atomic report', timeouts.overallMs);
  const acceptedHead = (await f.git('rev-parse', 'HEAD')).trim();
  assert.match(await readFile(join(f.cfg.root, taskFile), 'utf8'), /- \[x\] 1\.1 /);
  assert.match(await readFile(join(f.cfg.root, taskFile), 'utf8'), /- \[ \] 1\.2 /);
  await writeFile(join(f.control, 'exit.json'), JSON.stringify({ pid: session.process!.pid, code: 7 }));
  await until(() => alive(session.process!.pid), value => !value, 'nonzero child exit is verified', timeouts.overallMs);
  const rows = await Promise.all([f.ps(), f.ps()]);
  for (const list of rows) assert.equal(list.find((row: any) => row.runId === result.runId)?.result?.status, 'succeeded');
  assert.equal((await f.git('rev-parse', 'HEAD')).trim(), acceptedHead, 'parallel reconciliation does not duplicate checkbox commits');
  await until(() => f.inspect(), value => value.claims.length === 0 && value.admission.length === 0, 'verified exit releases claims and admission', timeouts.overallMs);
  f.evidence('I3-succeeded-nonzero', { runId: result.runId, childExitCode: 7, final: f.inspect(), acceptedHead });
});

for (const mode of ['delivery', 'readiness-unknown', 'fast-exit', 'limited']) {
  test(`[I2] public compiled CLI ${mode} keeps the primary error and cleans only its verified processes`, async t => {
    const f = await fixture(t, mode);
    if (mode === 'fast-exit') {
      const runner = join(f.directory, 'bin/codex');
      await writeFile(runner, '#!' + process.execPath + '\n' + (await readFile(runner, 'utf8')).split('\n').slice(1).join('\n').replace("const mode = readFileSync(c.control + '/mode', 'utf8').trim();", "const mode = readFileSync(c.control + '/mode', 'utf8').trim(); if (!process.argv.includes('--version')) process.exit(9);"), { mode: 0o700 });
    }
    if (mode === 'limited') {
      const conf = join(f.cfg.root, 'conf/raf.json');
      const raf = JSON.parse(await readFile(conf, 'utf8'));
      raf.runnerProtocols[0].markers.limited = ['RAF SYNTHETIC READY'];
      await writeFile(conf, JSON.stringify(raf));
    }
    const outcome = await f.run('adapter-refused');
    assert.equal(outcome.exitCode, 1, JSON.stringify(outcome));
    const failure = JSON.parse(outcome.result.stderr);
    assert.equal(failure.code, 'LAUNCH_FAILED');
    assert.equal(failure.details.retrySafe, true);
    assert.deepEqual(failure.details.pending, []);
    assert.deepEqual((await f.runners()).filter(alive), []);
    assert.equal(f.inspect().sessions.find(row => row.addressId === 'adapter-refused')?.state, 'finished');
    assert.deepEqual(f.inspect().claims, []);
    assert.deepEqual(f.inspect().admission, []);
    assert.equal(f.inspect().sessions.find(row => row.addressId === 'main')?.state, 'running', 'foreign main remains owned and alive');
    assert.deepEqual(await f.tmuxSessions(), ['adapter-main']);
    assert.match(failure.message, mode === 'limited' ? /limit/i : mode === 'fast-exit' ? /exit/i : /unknown/i);
    f.evidence('I2-' + mode, { outcome, final: f.inspect() });
  });
}

for (const payload of ['failed', 'partial', 'invalid', 'zero-without-report']) {
  test(`[I3] ${payload} cannot create succeeded from process exit zero`, async t => {
    const f = await fixture(t);
    const { result, session } = await f.launch('adapter-invalid');
    if (payload === 'failed') await publish(session.launchContext!.reportPath, report('failed'));
    if (payload === 'partial') await writeFile(session.launchContext!.reportPath, '{"status":');
    if (payload === 'invalid') await publish(session.launchContext!.reportPath, { status: 'succeeded' });
    if (payload === 'failed') await until(() => f.inspect().sessions.find(row => row.runId === result.runId)?.result?.status, value => value === 'failed', 'failed report is accepted', timeouts.overallMs);
    await writeFile(join(f.control, 'exit.json'), JSON.stringify({ pid: session.process!.pid, code: 0 }));
    await until(() => alive(session.process!.pid), value => !value, 'fixture exits zero', timeouts.overallMs);
    await f.ps();
    const current = f.inspect();
    assert.notEqual(current.sessions.find(row => row.runId === result.runId)?.result?.status, 'succeeded');
    assert.match(await readFile(join(f.cfg.root, taskFile), 'utf8'), /- \[ \] 1\.1 /);
    f.evidence('I3-' + payload, { runId: result.runId, childExitCode: 0, final: current });
  });
}

test('[I2] missing pane cannot release a live runner before its verified exit', async t => {
  const f = await fixture(t, 'live', true);
  const { result, session } = await f.launch('adapter-pane');
  await exec(f.cfg.tmux, ['-L', f.cfg.tmuxLabel, 'kill-pane', '-t', session.process!.evidence.tmuxPane!], { env: { ...process.env, TMUX_TMPDIR: f.directory } });
  assert.equal(alive(session.process!.pid), true, 'runner survives disappearance of its pane');
  const observation = await f.main.command(['agent', 'ps']);
  const before = f.inspect();
  assert.ok(before.sessions.find(row => row.runId === result.runId)?.state !== 'finished');
  assert.equal(before.claims.length, 1, 'pane loss is not verified exit');
  assert.equal(before.admission.length, 1);
  await writeFile(join(f.control, 'exit.json'), JSON.stringify({ pid: session.process!.pid, code: 7 }));
  await until(() => alive(session.process!.pid), value => !value, 'process exits after missing pane', timeouts.overallMs);
  await f.ps();
  await until(() => f.inspect(), value => !value.claims.length && !value.admission.length, 'claims released after verified exit', timeouts.overallMs);
  f.evidence('I2-pane-process', { runId: result.runId, observation, before, after: f.inspect() });
});

test('[I2] unconfirmed cleanup preserves the delivery failure and reservation until verified exit', async t => {
  const f = await fixture(t, 'delivery', true);
  const outcome = await f.run('adapter-unconfirmed');
  assert.equal(outcome.exitCode, 1, JSON.stringify(outcome));
  const failure = JSON.parse(outcome.result.stderr);
  assert.equal(failure.code, 'LAUNCH_RECOVERABLE');
  assert.equal(failure.details.retrySafe, false);
  assert.ok(failure.details.pending.length);
  assert.match(failure.message, /unknown/i);
  assert.match(failure.message, /cleanup|confirmation|confirmed/i);
  const before = f.inspect();
  assert.equal(before.claims.length, 1);
  assert.equal(before.admission.length, 1);
  const live = (await f.runners()).filter(alive);
  assert.equal(live.length, 1);
  await writeFile(join(f.control, 'exit.json'), JSON.stringify({ pid: live[0], code: 7 }));
  await until(() => alive(live[0]), value => !value, 'unconfirmed runner eventually exits', timeouts.overallMs);
  await f.ps();
  await until(() => f.inspect(), value => !value.claims.length && !value.admission.length, 'reconciliation releases only after actual exit', timeouts.overallMs);
  f.evidence('I2-unconfirmed-exit', { outcome, before, after: f.inspect() });
});

test('[I3] a late report for old run A cannot complete reused address run B', async t => {
  const f = await fixture(t);
  const a = await f.launch('adapter-reused');
  await writeFile(join(f.control, 'exit.json'), JSON.stringify({ pid: a.session.process!.pid, code: 0 }));
  await until(() => alive(a.session.process!.pid), value => !value, 'old A exits', timeouts.overallMs);
  await f.ps();
  await until(() => f.inspect(), value => !value.claims.length && !value.admission.length, 'A releases its reservation after exit', timeouts.overallMs);
  const cliB = await f.main.command(f.runArgs('adapter-reused', 'implement', ['1.2']));
  assert.equal(cliB.exitCode, 0, JSON.stringify(cliB));
  const b = JSON.parse(cliB.result.stdout);
  assert.notEqual(a.result.runId, b.runId);
  await mkdir(join(a.session.launchContext!.reportPath, '..'), { recursive: true });
  await publish(a.session.launchContext!.reportPath, report('succeeded'));
  await f.ps();
  const current = f.inspect();
  const active = current.sessions.find(row => row.runId === b.runId)!;
  assert.equal(active.state, 'running');
  assert.equal(active.result, undefined);
  assert.ok(current.claims.every(row => row.lease.owner.runId === b.runId));
  assert.match(await readFile(join(f.cfg.root, taskFile), 'utf8'), /- \[ \] 1\.1 /);
  assert.match(await readFile(join(f.cfg.root, taskFile), 'utf8'), /- \[ \] 1\.2 /);
  f.evidence('I3-old-A-current-B', { a: a.result.runId, b: b.runId, lateReport: a.session.launchContext!.reportPath, current });
});
