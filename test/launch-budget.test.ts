import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { executeCommand } from '../src/os-runtime.ts';
import { configuration, fixture, type ProductionFixture } from './production-fixture.ts';

function seedHistory(f: ProductionFixture): void {
  const db = f.store.startupContextDatabase;
  const insert = db.prepare('INSERT INTO sessions(run_id,address_id,state,payload) VALUES(?,?,?,?)');
  for (let i = 0; i < 406; i++) {
    const row = { runId: `history-${i}`, addressId: `history-${i}`, state: 'finished', revision: 1, history: 'x'.repeat(18000) };
    insert.run(row.runId, row.addressId, row.state, JSON.stringify(row));
  }
  insert.close();
  const notice = db.prepare('INSERT INTO result_notices(id,run_id,payload) VALUES(?,?,?)');
  for (let i = 0; i < 486; i++) {
    const row = { id: `notice-${i}`, runId: `history-${i % 406}`, recipient: '', recipientRunId: null,
      source: { runId: `history-${i % 406}`, addressId: `history-${i % 406}`, revision: 1, state: 'finished' },
      state: i < 115 ? 'pending' : 'delivered', attempts: 1, text: 'x'.repeat(2400), lastError: 'Recipient is inactive' };
    notice.run(row.id, row.runId, JSON.stringify(row));
  }
  notice.close();
  const intent = db.prepare('INSERT INTO pending_intents(id,run_id,payload) VALUES(?,?,?)');
  for (let i = 0; i < 300; i++) intent.run(`intent-${i}`, null, JSON.stringify({ id: `intent-${i}`, runId: null, event: 'fixture.unknown', payload: {} }));
  intent.close();
  const reminder = db.prepare('INSERT INTO reminders(id,created_for,assigned_to,at,state,closed_at,payload) VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 227; i++) {
    const row = { id: `reminder-${i}`, createdFor: 'main', assignedTo: 'main', text: 'fixture', at: '2099-01-01T00:00:00.000Z',
      binding: null, state: 'pending', closedAt: null, closeReason: null };
    reminder.run(row.id, row.createdFor, row.assignedTo, row.at, row.state, null, JSON.stringify(row));
  }
  reminder.close();
}

async function configureRunners(f: ProductionFixture): Promise<string> {
  const realCodex = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
  const eventsPath = join(f.root, 'runner-events.jsonl');
  const runnerPidPath = join(f.root, 'runner.pid');
  f.trackPidFile(runnerPidPath);
  const synthetic = await readFile(new URL('../evidence/hotfix-1.1.6/synthetic-codex.mjs', import.meta.url), 'utf8');
  const runner = synthetic.replace("log('status-submit');", "if (statusPending) continue; log('status-submit');").replace('/* fixture options */', `
if (process.argv.includes('app-server')) {
  const { spawn } = await import('node:child_process');
  const child = spawn(${JSON.stringify(realCodex)}, process.argv.slice(2), { stdio: 'inherit' });
  child.once('error', error => { throw error; });
  child.once('exit', code => process.exit(code ?? 1));
  await new Promise(() => {});
}
const runnerPidPath = ${JSON.stringify(runnerPidPath)};
const eventsPath = ${JSON.stringify(eventsPath)};
const statusDelayMs = 2816;
`)
    .replace("draw();\nprocess.stdin.on", "await new Promise(resolve => setTimeout(resolve, 531));\ndraw();\nprocess.stdin.on")
    .replace("working = true; log('brief-submit'); draw();", "log('brief-submit'); setTimeout(() => { working = true; log('brief-accepted'); draw(); }, 2624);");
  await writeFile(join(f.binRoot, 'codex'), runner, { mode: 0o700 });
  await writeFile(join(f.binRoot, 'agy'), `#!${process.execPath}\nawait new Promise(resolve => setTimeout(resolve, 941)); console.log('1.0.0');\n`, { mode: 0o700 });
  const models = { ...configuration.models, runners: [...configuration.models.runners, { id: 'agy', initialEnabled: false }] };
  await writeFile(join(f.confRoot, 'models.json'), JSON.stringify(models));
  const rafPath = join(f.confRoot, 'raf.json');
  const raf = JSON.parse(await readFile(rafPath, 'utf8'));
  for (const protocol of raf.runnerProtocols) {
    if (protocol.runner === 'codex') Object.assign(protocol, { executable: join(f.binRoot, 'codex'), version: '0.133.0' });
    if (protocol.runner === 'agy') protocol.executable = join(f.binRoot, 'agy');
  }
  await writeFile(rafPath, JSON.stringify(raf));
  const codexHome = join(f.home, '.codex');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), '');
  return codexHome;
}

test('cold production CLI keeps RAF overhead below three seconds across launch stages', async t => {
  const f = await fixture(t, { productionQa: true });
  const projects = JSON.parse(await readFile(join(f.confRoot, 'projects.json'), 'utf8'));
  await writeFile(join(f.confRoot, 'briefs/tasks/hotfix.md'), 'FIXTURE_HOTFIX_STAGE');
  const hotfix = join(f.root, projects.projects.raf.branchPaths.hotfix);
  execFileSync('git', ['-C', f.cwd, 'worktree', 'add', '-b', 'hotfix', hotfix, 'HEAD'], { stdio: 'pipe' });
  const codexHome = await configureRunners(f);
  seedHistory(f);
  const started = performance.now();
  const result = await executeCommand({ executable: process.execPath, args: [join(f.cwd, 'bin/raf.ts'),
    'agent', 'run', '--id', 'budget', '--type', 'hotfix', '--project', 'raf', '--features', 'fixture-launch',
    '--phase', 'implement', '--complexity', 'decision', '--tasks', 'fixture-launch:2.1'], cwd: f.cwd,
    environment: { HOME: f.home, RAF_QA_HOME: f.home, RAF_ORCHESTRATOR_ROOT: f.root, CODEX_HOME: codexHome,
      PATH: f.binRoot + delimiter + (process.env.PATH ?? ''), TMUX: '', TMUX_PANE: '' } });
  const wallMs = performance.now() - started;
  assert.equal(result.exitCode, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  const rows = (await readFile(join(f.tmpRoot, response.runId, 'launch-timeline.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  f.trackProcess(rows.find(row => row.stage === 'worker-start').pid);
  const at = (stage: string) => {
    const row = rows.find(row => row.stage === stage);
    assert.ok(row, `Missing production stage ${stage}`);
    return row.atMs;
  };
  const runnerMs = at('readiness-end') - at('readiness-start') + at('delivery-end') - at('delivery-start');
  const overheadMs = wallMs - runnerMs;
  const stageMs = Object.fromEntries([
    ['cli-start', 'brief-start'], ['brief-start', 'brief-end'], ['admission-start', 'admission-end'],
    ['admission-end', 'worker-start'], ['worker-start', 'command-access-start'], ['command-access-start', 'command-access-end'],
    ['tmux-spawn-start', 'tmux-spawn-end'], ['lifecycle-start', 'lifecycle-end'], ['handshake-start', 'handshake-received'],
    ['command-settle-start', 'command-settle-end'], ['handler-end', 'cli-response-ready'],
  ].map(([start, end]) => [`${start} → ${end}`, at(end) - at(start)]));
  t.diagnostic(JSON.stringify({ diagnostics: [{ kind: 'runner', message: JSON.stringify({
    size: { sessions: 406, notices: 486, pendingNotices: 115, reminders: 227, intents: 300 },
    wallMs, runnerMs, overheadMs, stageMs,
  }), location: null, stack: [], redacted: false, truncated: false }], evidence: [] }));
  assert.ok(at('native-id-visible') <= at('delivery-start'));
  assert.ok(at('delivery-end') <= at('handshake-start'));
  assert.ok(at('command-access-end') > at('command-access-start'), 'The budget includes Codex hook inspection');
  const policy = JSON.parse(await readFile(join(f.tmpRoot, response.runId, `codex-sandbox-${response.runId}`, 'policy.json'), 'utf8'));
  assert.equal(policy.sandboxMode, 'workspace-write');
  const launched = JSON.parse(await readFile(join(f.tmpRoot, response.runId, 'invocation.json'), 'utf8'));
  assert.ok(launched.invocation.args.some((argument: string) => argument.startsWith('hooks.state=')), 'The budget includes the inspected and trusted hook');
  assert.ok(overheadMs < 3000, `RAF overhead ${overheadMs}ms across cold CLI, admission, worker, command access, lifecycle and response`);
});
