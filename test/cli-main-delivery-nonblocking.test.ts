import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { buildCatalog } from '../src/bootstrap.ts';
import { openStateStore } from '../src/state-store.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import { observeProcesses, readMachineBootIdentity } from '../src/os-runtime.ts';
import { deliverCheckedMessage, type MessageDeliveryPorts } from '../src/message-delivery.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const change = 'main-delivery-nonblocking-fixture';
const transitionMs = 300;

const tmuxScript = (cfgJson: string) => String.raw`
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const c = ${cfgJson};
const args = process.argv.slice(2);
const socketIdx = args.indexOf('-S');
const socket = socketIdx >= 0 ? args[socketIdx + 1] : null;
if (socket === c.mainSocket) {
  const subcommand = args.find((arg, index) => index > socketIdx + 1 && !arg.startsWith('-'));
  const statePath = c.control + '/main-display-state.json';
  const readState = () => {
    try { return JSON.parse(readFileSync(statePath, 'utf8')); }
    catch { return { displays: 0, capturesInDelivery: 0 }; }
  };
  if (subcommand === 'display-message') {
    const state = readState();
    writeFileSync(statePath, JSON.stringify({ ...state, displays: state.displays + 1 }));
    process.stdout.write(c.mainPane + '\t' + c.mainPid + '\n');
    process.exit(0);
  }
  if (subcommand === 'capture-pane') {
    const mode = readFileSync(c.control + '/main-mode', 'utf8').trim();
    const state = readState();
    const capturesInDelivery = state.displays >= 2 ? 1 : state.capturesInDelivery + 1;
    writeFileSync(statePath, JSON.stringify({ displays: 0, capturesInDelivery }));
    if (mode === 'busy') {
      if (capturesInDelivery >= 2) {
        appendFileSync(c.control + '/main-waited.jsonl', JSON.stringify({ at: Date.now(), capturesInDelivery }) + '\n');
        process.stdout.write('RAF SYNTHETIC READY\n› RAF SYNTHETIC READY\n');
        process.exit(0);
      }
      process.stdout.write('RAF SYNTHETIC READY\n› [raf] попереднє непідтверджене повідомлення\n');
      process.exit(0);
    }
    const delivered = existsSync(c.control + '/main-delivered.jsonl')
      ? readFileSync(c.control + '/main-delivered.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [];
    process.stdout.write(['RAF SYNTHETIC READY', ...delivered, '› RAF SYNTHETIC READY'].join('\n') + '\n');
    process.exit(0);
  }
  if (subcommand === 'load-buffer') {
    const text = readFileSync(0, 'utf8');
    writeFileSync(c.control + '/main-buffer.txt', text);
    const mode = readFileSync(c.control + '/main-mode', 'utf8').trim();
    if (mode === 'busy') appendFileSync(c.control + '/main-pasted-while-busy.jsonl', JSON.stringify(text) + '\n');
    process.exit(0);
  }
  if (subcommand === 'paste-buffer') {
    const text = existsSync(c.control + '/main-buffer.txt') ? readFileSync(c.control + '/main-buffer.txt', 'utf8') : '';
    appendFileSync(c.control + '/main-delivered.jsonl', JSON.stringify(text) + '\n');
    process.exit(0);
  }
  if (subcommand === 'send-keys' || subcommand === 'delete-buffer') {
    process.exit(0);
  }
  const res = spawnSync(c.tmux, args, { stdio: 'inherit', env: process.env });
  if (res.error) throw res.error;
  process.exit(res.status ?? 1);
}
const forwarded = args.includes('-S') ? args : ['-S', c.workerTmuxSocket, ...args];
const result = spawnSync(c.tmux, forwarded, { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

const openspecScript = (cfgJson: string) => String.raw`
import { spawnSync } from 'node:child_process';
const c = ${cfgJson};
const result = spawnSync(c.openspec, process.argv.slice(2), { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

const runnerScript = (cfgJson: string) => String.raw`
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.1'); process.exit(0); }
const c = ${cfgJson};
if (process.argv.includes('--main-pane')) {
  writeFileSync(c.control + '/main.pid', String(process.pid));
  console.log('RAF SYNTHETIC READY\n› [raf] попереднє непідтверджене повідомлення');
  setInterval(() => {}, 1000);
} else {
  const nativeId = randomUUID();
  writeFileSync(c.control + '/worker-runner-' + process.pid + '.pid', String(process.pid));
  console.log('RAF SYNTHETIC READY\n› RAF SYNTHETIC READY');
  process.stdin.setEncoding('utf8');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = '', assigned = false;
  process.stdin.on('data', chunk => {
    input += chunk.replace(/\x1b\[(?:200|201)~/g, '').replace(/\r/g, '\n');
    if (input.includes('/status')) {
      console.log('\nSession: ' + nativeId + '\nRAF SYNTHETIC READY\n› RAF SYNTHETIC READY');
      input = '';
      return;
    }
    if (assigned) return;
    const offset = input.search(/\{\s*"project"\s*:/);
    if (offset < 0) return;
    let candidate;
    try { candidate = JSON.parse(input.slice(offset).trim()); } catch { return; }
    if (!candidate.report_path || !candidate.assignments || !/[\r\n]\s*$/.test(input)) return;
    assigned = true;
    console.log('\n• Working (0s • esc to interrupt)\n› ');
  });
  setInterval(() => {}, 1000);
}
`;

function readJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function waitSocketClosed(socketPath: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!existsSync(socketPath)) return;
    const closed = await new Promise<boolean>(resolve => {
      const conn = createConnection(socketPath);
      conn.once('connect', () => { conn.destroy(); resolve(false); });
      conn.once('error', () => { conn.destroy(); resolve(true); });
    });
    if (closed) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('CLI commands agent ps, reminder add, and agent run complete without waiting for main delivery while main composer has an unconfirmed message, and queued messages deliver once main composer clears', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'raf-main-delivery-')));
  const root = join(directory, 'orchestrator');
  const home = join(directory, 'home');
  const conf = join(root, 'conf');
  const stateDirectory = join(home, '.raf');
  const tmpRoot = join(stateDirectory, 'tmp');
  const control = join(directory, 'control');
  const bin = join(directory, 'bin');
  const workspace = join(root, 'raf-develop');
  for (const path of [conf, tmpRoot, control, bin, workspace]) await fs.mkdir(path, { recursive: true, mode: 0o700 });

  const [openspecBin, tmuxBin] = await Promise.all(['openspec', 'tmux'].map(async name => (await exec('/bin/sh', ['-c', 'command -v "$1"', 'fixture', name])).stdout.trim()));
  const models = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/models.json'), 'utf8'));
  models.models = models.models.filter((x: any) => x.id === 'gpt-6.1-sol');
  models.runners = models.runners.filter((x: any) => x.id === 'codex');
  const constants = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/raf-constants.json'), 'utf8'));
  const artifactPath = join(directory, 'catalog.json');
  const changeDir = join(root, 'openspec', 'changes', change);
  const questionsPath = join(root, 'questions', 'projects', 'raf', 'questions.md');

  await fs.writeFile(join(conf, 'projects.json'), await fs.readFile(join(sourceRoot, '../conf/projects.json'), 'utf8'));
  const runProductionCli = await prepareProductionQaFixture(t, { root, home });

  const statePath = join(stateDirectory, 'state.sqlite');
  const mainSocket = join(directory, 'main-tmux.sock');
  const mainPane = '%0';
  const workerTmuxSocket = join(directory, 'worker-tmux.sock');
  const fixtureFile = join(directory, 'fixture.json');
  await fs.writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }), { mode: 0o600 });
  const mainScriptPath = join(bin, 'codex');
  await fs.writeFile(mainScriptPath, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex-cli 0.0.1'); process.exit(0); }\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const mainChild = spawn(process.execPath, [mainScriptPath, '--main-pane'], { stdio: 'ignore' });
  assert.ok(mainChild.pid, 'Failed to spawn main pane process');
  const mainPid = mainChild.pid;

  const cfg = {
    sourceRoot: workspace, root, conf, home, stateDirectory, statePath, tmpRoot, control, workspace,
    artifact: artifactPath, bin, change, changeDir, questionsPath, models,
    tmux: tmuxBin, openspec: openspecBin, mainSocket, mainPane, mainPid, workerTmuxSocket, transitionMs,
  };
  const cfgJson = JSON.stringify(cfg);
  await fs.writeFile(fixtureFile, cfgJson, { mode: 0o600 });
  await fs.writeFile(join(control, 'main-mode'), 'busy\n', { mode: 0o600 });

  for (const [name, source] of Object.entries({ codex: runnerScript(cfgJson), tmux: tmuxScript(cfgJson), openspec: openspecScript(cfgJson) })) {
    await fs.writeFile(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  }

  const savedEnv = {
    PATH: process.env.PATH,
    RAF_MAIN_DELIVERY_FIXTURE: process.env.RAF_MAIN_DELIVERY_FIXTURE,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.RAF_MAIN_DELIVERY_FIXTURE = fixtureFile;
  process.env.TMPDIR = directory;

  const ownedProcesses = new Map<number, any>();
  const ownedSockets = new Set<string>([mainSocket, workerTmuxSocket, join(tmpRoot, 'tmux', 'server.sock')]);

  const inspectOwned = () => {
    if (!existsSync(statePath)) return;
    const store = openStateStore(statePath);
    try {
      const claims = listTaskReservations(store);
      const sessions = store.sessionRepository.transaction(tx => tx.listSessions());
      for (const identity of [...claims.flatMap(claim => [claim.wrapper, claim.agent]), ...sessions.map(session => session.process)]) {
        if (!identity) continue;
        ownedProcesses.set(identity.pid, identity);
        if (identity.evidence.tmuxSocket) ownedSockets.add(identity.evidence.tmuxSocket);
      }
    } finally {
      store.close();
    }
  };

  t.after(async () => {
    try {
      inspectOwned();
      for (const socket of ownedSockets) {
        if (existsSync(socket)) {
          await exec(tmuxBin, ['-S', socket, 'kill-server']).catch(() => {});
          await waitSocketClosed(socket);
        }
      }
      for (const identity of ownedProcesses.values()) {
        try { process.kill(identity.pid, 'SIGKILL'); } catch {}
      }
      for (const identity of ownedProcesses.values()) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const [obs] = await observeProcesses([identity]);
          if (obs.state === 'exited') break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  await fs.writeFile(join(conf, 'models.json'), JSON.stringify(models));
  await fs.writeFile(join(conf, 'raf-constants.json'), JSON.stringify(constants));
  const flow = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/flow.json'), 'utf8'));
  const raf = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/raf.json'), 'utf8'));
  await fs.writeFile(join(conf, 'flow.json'), JSON.stringify({
    ...flow,
    resources: Object.fromEntries(Object.entries(flow.resources).map(([tier, thresholds]) => [tier, { ...(thresholds as object), minRamBytes: 1, minDiskBytes: 1 }])),
  }));
  await fs.mkdir(dirname(questionsPath), { recursive: true });
  await fs.writeFile(questionsPath, '# Питання\n');
  const codexProtocol = raf.runnerProtocols.find((r: any) => r.runner === 'codex');
  await fs.writeFile(join(conf, 'raf.json'), JSON.stringify({
    ...raf,
    runnerProtocols: [{
      ...codexProtocol,
      runner: 'codex', executable: 'codex', version: '0.0.1', baseArgs: [], modelFlag: '--model', effortFlag: '-c',
      effortFormat: 'codex_config', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null,
      quotaCommand: '/status', navigation: [], markers: { ready: ['RAF SYNTHETIC READY'] }, quotaParser: 'codex_status',
      modelPools: {}, quotaReliable: false, liveTaskVerified: true,
      timeouts: { startupMs: 15000, transitionMs, overallMs: 20000, pollMs: 25 },
      collection: { intervalMs: 300000, failureBackoffMs: 60000, staleAfterMs: 60000 },
    }],
  }));
  for (const path of ['runners/codex.md', 'tasks/implement.md', 'completion.md']) {
    await fs.mkdir(dirname(join(conf, 'briefs', path)), { recursive: true });
    await fs.writeFile(join(conf, 'briefs', path), 'Synthetic fixture brief.\n');
  }
  buildCatalog(conf, artifactPath, constants.commands.map((x: any) => x.path.join(' ')));

  await fs.mkdir(join(changeDir, 'specs', 'production-fixture'), { recursive: true });
  await fs.writeFile(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(join(changeDir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-28\n');
  await fs.writeFile(join(changeDir, 'proposal.md'), '## Why\nIsolated main delivery fixture.\n\n## What Changes\nExercise non-blocking CLI commands.\n\n## Capabilities\n\n### New Capabilities\n- `production-fixture`: Isolated fixture task.\n\n## Impact\nFixture only.\n');
  await fs.writeFile(join(changeDir, 'design.md'), '## Context\nIsolated QA HOME fixture.\n\n## Decisions\nVerify non-blocking CLI commands.\n');
  await fs.writeFile(join(changeDir, 'specs', 'production-fixture', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Isolated fixture task\nThe fixture SHALL run without waiting for main delivery.\n\n#### Scenario: Non-blocking CLI\n- **WHEN** main composer is busy\n- **THEN** CLI commands complete immediately\n');
  await fs.writeFile(join(changeDir, 'tasks.md'), '## 1. Fixture\n\n- [ ] 1.1 Write fixture alpha\n');

  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const name of Object.keys(gitEnv)) {
    if (name.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(name)) delete gitEnv[name];
  }
  const git = async (repo: string, ...args: string[]) => (await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv })).stdout.trim();
  await git(root, 'add', '--', 'openspec', 'questions');
  await git(root, 'commit', '--quiet', '-m', 'Fixture assignment baseline');
  await git(workspace, 'add', '--', 'package.json');
  await git(workspace, 'commit', '--quiet', '-m', 'Fixture workspace baseline');

  const psOut = (await exec('ps', ['-ww', '-p', String(mainPid), '-o', 'lstart=,command='])).stdout.trim();
  const psMatch = psOut.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  assert.ok(psMatch, `Cannot parse main process ps row: ${psOut}`);
  const boot = await readMachineBootIdentity();
  const mainIdentity = {
    pid: mainPid,
    startedAt: new Date(psMatch[1]!).toISOString(),
    runner: 'main',
    runnerSessionId: mainPane,
    tmuxSession: 'main',
    evidence: {
      command: psMatch[2]!,
      tmuxSocket: mainSocket,
      tmuxPane: mainPane,
      machineId: boot.machineId,
      bootId: boot.bootId,
    },
  };
  ownedProcesses.set(mainPid, mainIdentity);

  const now = Date.now();
  const twoMinutesAgo = new Date(now - 2 * 60_000).toISOString();
  const oneMinuteAgo = new Date(now - 60_000).toISOString();
  const store = openStateStore(statePath);
  try {
    store.sessionRepository.transaction(tx => {
      tx.putSession({
        runId: 'main-run-1',
        addressId: 'main',
        revision: 1,
        state: 'running',
        activity: { type: 'main', project: 'orchestrator', features: [], phase: 'main', cwd: root },
        process: mainIdentity,
      });
      tx.putSession({
        runId: 'worker-prev',
        addressId: 'worker-prev',
        revision: 2,
        state: 'finished',
        finishedAt: twoMinutesAgo,
        launchedBy: { addressId: 'main', runId: 'main-run-1' },
        activity: { type: 'implement', project: 'raf', features: ['production-fixture'], phase: 'implement', cwd: workspace },
        launchContext: {
          assignment: {
            changes: [{ id: change, items: [{ id: '1.1', section: '1. Implementation', description: 'Non-blocking main delivery fixture task' }] }],
            taskItems: [{ changeId: change, itemId: '1.1', section: '1. Implementation', description: 'Non-blocking main delivery fixture task' }],
          },
          selection: { runner: 'codex', model: 'gpt-5.4-codex', effort: 'high', reason: 'fixture' },
          briefPath: join(home, '.raf/tmp/worker-prev/brief.md'),
          reportPath: join(home, '.raf/tmp/worker-prev/worker-prev.json'),
        },
        result: { status: 'succeeded', response: 'Попередня задача виконана', proof: { runId: 'worker-prev', at: twoMinutesAgo } },
      });
    });
    store.reminderRepository.transaction(tx => {
      tx.save({
        id: 'rem-queued-1',
        createdFor: 'main',
        assignedTo: 'main',
        text: 'Перше непідтверджене нагадування',
        at: twoMinutesAgo,
        binding: null,
        state: 'active',
        closedAt: null,
        closeReason: null,
      });
    });
  } finally {
    store.close();
  }

  const entry = { orchestratorRoot: root, homeDirectory: home, artifactPath };

  const psRes = await runProductionCli(['agent', 'ps'], entry);
  assert.equal(psRes.exitCode, 0, psRes.stderr);
  assert.deepEqual(readJsonLines(join(control, 'main-waited.jsonl')), [], 'agent ps must not wait for delivery into a busy main pane');

  const remRes = await runProductionCli(['reminder', 'add', '--to', 'main', '--at', oneMinuteAgo, '--text', 'Друге нагадування в черзі'], entry);
  assert.equal(remRes.exitCode, 0, remRes.stderr);
  const addedReminder = JSON.parse(remRes.stdout) as { id: string };
  assert.deepEqual(readJsonLines(join(control, 'main-waited.jsonl')), [], 'reminder add must not wait for delivery into a busy main pane');

  const runRes = await runProductionCli([
    'agent', 'run',
    '--id', 'worker-live',
    '--type', 'implement',
    '--project', 'raf',
    '--features', 'production-fixture',
    '--phase', 'implement',
    '--complexity', 'decision',
    '--tasks', `${change}:1.1`,
  ], entry);
  assert.equal(runRes.exitCode, 0, runRes.stderr);
  assert.deepEqual(readJsonLines(join(control, 'main-waited.jsonl')), [], 'agent run must not wait for delivery into a busy main pane');
  assert.deepEqual(readJsonLines(join(control, 'main-pasted-while-busy.jsonl')), [], 'No message may be pasted into main while its composer input is non-empty');
  assert.deepEqual(readJsonLines(join(control, 'main-delivered.jsonl')), [], 'Messages must wait in the queue while main composer input is non-empty');

  const checkQueuedStore = openStateStore(statePath);
  try {
    const notices = checkQueuedStore.resultNotices.list();
    assert.equal(notices.find(n => n.id === 'worker-prev:result-notice')?.state, 'pending', 'Result notice must remain pending in queue while main is busy');
    assert.equal(checkQueuedStore.reminderDeliveries.get('rem-queued-1'), undefined, 'First reminder must remain undelivered in queue while main is busy');
    assert.equal(checkQueuedStore.reminderDeliveries.get(addedReminder.id), undefined, 'Second reminder must remain undelivered in queue while main is busy');
  } finally {
    checkQueuedStore.close();
  }

  await fs.writeFile(join(control, 'main-mode'), 'empty\n', { mode: 0o600 });
  const drainRes = await runProductionCli(['agent', 'ps'], entry);
  assert.equal(drainRes.exitCode, 0, drainRes.stderr);

  const checkDeliveredStore = openStateStore(statePath);
  try {
    const notices = checkDeliveredStore.resultNotices.list();
    assert.equal(notices.find(n => n.id === 'worker-prev:result-notice')?.state, 'delivered', 'Queued result notice must be delivered once main composer clears');
    assert.ok(checkDeliveredStore.reminderDeliveries.get('rem-queued-1')?.receiptId, 'First queued reminder must be delivered once main composer clears');
    assert.ok(checkDeliveredStore.reminderDeliveries.get(addedReminder.id)?.receiptId, 'Second queued reminder must be delivered once main composer clears');
  } finally {
    checkDeliveredStore.close();
  }

  const deliveredTexts = readJsonLines(join(control, 'main-delivered.jsonl')) as string[];
  assert.ok(deliveredTexts.some(text => text.includes('worker-prev') && text.includes('succeeded')), 'Result notice text delivered to main');
  assert.ok(deliveredTexts.some(text => text.includes('Перше непідтверджене нагадування')), 'First reminder text delivered to main');
  assert.ok(deliveredTexts.some(text => text.includes('Друге нагадування в черзі')), 'Second reminder text delivered to main');
});

test('deliverCheckedMessage releases the delivery lease while waiting for a busy main composer so other calls are not blocked', async () => {
  const settings = {
    runner: 'claude', version: 'fixture', navigation: [], markers: { ready: ['agent ready'], permission_required: ['Permission required'] },
    native: { composer: '^(?:\\$|❯)(?:\\s|$)', pendingPaste: { pattern: '^\\[Pasted text #\\d+ \\+(\\d+) lines\\]$', unit: 'newlines' }, working: '^Working', identity: { source: 'session_start' } },
    timeouts: { transitionMs: 20, pollMs: 5 },
  } as unknown as ProtocolSettings;

  const frame = (input: string, history = 'agent ready') => `${history}\n❯ ${input}\nfooter`;
  const frames = [frame('owner unfinished draft'), frame('owner unfinished draft'), frame(''), frame('', 'agent ready\n[sender] hello')];
  let held = false;
  let nonBlockingChecksDuringWait = 0;
  let nonBlockingRefusalReason: string | undefined;

  const acquire = async () => {
    if (held) return null;
    held = true;
    return { release: async () => { held = false; } };
  };

  const ports: MessageDeliveryPorts = {
    settings,
    waitForComposer: true,
    acquire,
    verify: async () => true,
    capture: async () => frames.length > 1 ? frames.shift()! : frames[0]!,
    paste: async () => {
      assert.equal(held, true, 'Lease must be held during paste');
    },
    enter: async () => {},
    now: () => 0,
    delay: async () => {
      if (frames[0]?.includes('owner unfinished draft') || nonBlockingChecksDuringWait === 0) {
        nonBlockingChecksDuringWait++;
        const concurrent = await deliverCheckedMessage({
          settings,
          waitForComposer: false,
          acquire,
          verify: async () => true,
          capture: async () => frame('owner unfinished draft'),
          paste: async () => {},
          enter: async () => {},
          now: () => 0,
          delay: async () => {},
        }, '[raf] Reminder check');
        nonBlockingRefusalReason = concurrent.reason;
      }
    },
  };

  const result = await deliverCheckedMessage(ports, '[sender] hello');
  assert.deepEqual(result, { accepted: true });
  assert.equal(held, false, 'Lease must be released after completion');
  assert.ok(nonBlockingChecksDuringWait >= 1, 'Waiting delivery delayed at least once');
  assert.equal(nonBlockingRefusalReason, 'Recipient has no recognized empty agent composer', 'Waiting for a busy composer must not hold the delivery lease and block other callers with Another delivery owns the recipient composer');
});
