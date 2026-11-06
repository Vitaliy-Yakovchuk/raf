import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, json, writeJson, until } from '../test/production-launch-fixture.ts';
import { openStateStore } from '../src/state-store.ts';
import { readMachineBootIdentity } from '../src/os-runtime.ts';

const exec = promisify(execFile);
const output = resolve(process.argv[2]);
const before = process.argv.includes('--before');
const baseline = before ? process.argv[process.argv.indexOf('--before') + 1] ?? 'HEAD' : null;
const cleanup: (() => Promise<void> | void)[] = [];
const liveRoot = resolve(new URL('../../', import.meta.url).pathname);
const liveHome = process.env.HOME!;
const option = (flag: string) => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const snapshotRoot = option('--snapshot-root') ?? liveRoot;
const snapshotState = option('--snapshot-state') ?? join(liveHome, '.raf/state.sqlite');
const measurements: unknown[] = [];
let priorWorkerCosts: any[] = [];
const result: Record<string, unknown> = { before, baseline, source: liveRoot, snapshotRoot, snapshotState, measurements };
try {
  const f = await fixture({ after(action: () => Promise<void> | void) { cleanup.push(action); } });
  cleanup.push(async () => { await exec('chmod', ['-R', 'u+rwX', join(f.root, 'openspec')]); });
  await writeJson(f.file, { ...await json(f.file), latency: true });
  const retained = new Map(await Promise.all(['projects.json', 'models.json', 'raf.json', 'flow.json', 'raf-constants.json'].map(async name => [name, await fs.readFile(join(f.conf, name))] as const)));
  await fs.cp(join(snapshotRoot, 'conf'), f.conf, { recursive: true });
  for (const [name, content] of retained) await fs.writeFile(join(f.conf, name), content);
  await fs.cp(join(snapshotRoot, 'openspec'), join(f.root, 'openspec'), { recursive: true });
  await exec('chmod', ['-R', 'u+rwX', join(f.root, 'openspec')]);
  const input = new DatabaseSync(snapshotState, { readOnly: true });
  await backup(input, f.statePath);
  input.close();
  const db = new DatabaseSync(f.statePath);
  db.exec('PRAGMA foreign_keys=ON; BEGIN');
  for (const row of db.prepare('SELECT run_id,payload FROM sessions').all()) {
    const value = JSON.parse(String(row.payload));
    value.state = 'finished'; value.finishedAt = new Date().toISOString();
    delete value.process; delete value.modelHandoff;
    db.prepare("UPDATE sessions SET state='finished',payload=? WHERE run_id=?").run(JSON.stringify(value), row.run_id);
  }
  for (const table of ['task_reservations', 'task_reservation_runs', 'admission_reservations', 'agent_launch_queue_entries', 'agent_launch_queues', 'delivery_claims', 'reminder_deliveries']) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM pending_intents WHERE id!='openspec:archive-observation'");
  for (const row of db.prepare('SELECT id,payload FROM reminders').all()) {
    const value = JSON.parse(String(row.payload)); value.assignedTo = 'isolated-inactive';
    db.prepare('UPDATE reminders SET payload=? WHERE id=?').run(JSON.stringify(value), row.id);
  }
  for (const row of db.prepare('SELECT id,payload FROM result_notices').all()) {
    const value = JSON.parse(String(row.payload)); value.recipient = 'isolated-inactive'; value.recipientRunId = null;
    db.prepare('UPDATE result_notices SET payload=? WHERE id=?').run(JSON.stringify(value), row.id);
  }
  db.exec('COMMIT');
  result.sessions = db.prepare('SELECT count(*) n FROM sessions').get()!.n;
  result.changes = (await fs.readdir(join(f.root, 'openspec/changes'))).filter(name => name !== 'archive').length;
  result.archives = (await fs.readdir(join(f.root, 'openspec/changes/archive'))).length;
  result.notices = db.prepare('SELECT count(*) n FROM result_notices').get()!.n;
  priorWorkerCosts = db.prepare("SELECT payload FROM raf_cost_profile WHERE scope='worker'").all().map(row => JSON.parse(String(row.payload)));
  db.close();
  if (before) for (const name of ['src/production-entry.ts', 'src/cli.ts', 'src/reminder-cli.ts', 'src/state-store.ts', 'src/archive-events-runtime.ts', 'src/assignment.ts', 'src/production-runtime.ts', 'src/production-agent-queue.ts', 'src/assignment-identity.ts', 'src/prune-archived-test-groups.ts', 'src/agent-adapters.ts']) {
    const { stdout } = await exec('git', ['show', `${baseline}:${name}`], { maxBuffer: 16 * 1024 * 1024 });
    await fs.writeFile(join(f.workspace, name), stdout);
  }
  if (process.argv.includes('--trace')) {
    const path = join(f.workspace, 'src/production-runtime.ts');
    let source = await fs.readFile(path, 'utf8');
    const log = `await fs.appendFile(${JSON.stringify(join(f.control, 'runtime-cost.jsonl'))}, JSON.stringify({pid:process.pid,kind,name,at:Date.now(),wallMs:performance.now()-at})+'\\n');`;
    source = source.replace('const execute: AdapterCommandExecutor = async command => {', `const execute: AdapterCommandExecutor = async command => { const at=performance.now(); const kind='execute',name=command.executable+' '+command.args[0]; try {`)
      .replace('  runtimeEnvironments.set(execute, environmentForCommand);', '  runtimeEnvironments.set(execute, environmentForCommand);');
    const boundary = '  };\n  runtimeEnvironments.set(execute, environmentForCommand);';
    source = source.replace(boundary, `  } finally { ${log} } };\n  runtimeEnvironments.set(execute, environmentForCommand);`);
    source = source.replace('return executeCommand({ ...command, environment });', 'return await executeCommand({ ...command, environment });');
    source = source.replace('  return api;', `  for (const [object,prefix] of [[api,'api'],[api.assignment,'assignment'],[api.adapter,'adapter']]) for (const key of Object.keys(object)) { const original=object[key]; if(typeof original!=='function'||['selectModel','listModels'].includes(key))continue; object[key]=async function(...args) { const at=performance.now(),kind='api',name=prefix+'.'+key;try{return await original.apply(this,args);}finally{${log}}}; } return api;`);
    source += `\nasync function traced(name,fn,...args){const at=performance.now(),kind='step';try{return await fn(...args);}finally{${log}}}\n`;
    for (const name of ['settleCommandState', 'settleWorkerHealth', 'settleRuntimeHealthCpu', 'handoffTaskReservations', 'runnerWritableDirectories', 'runnerSandboxScope', 'agentChannelReadOnlyPaths', 'sharedLibraryReadOnlyPaths', 'prepareCodexSandbox', 'prepareCodexRafCommandAccess']) source = source.replaceAll(`await ${name}(`, `await traced('${name}', ${name}, `);
    source = source.replace('resolveTasks: identity.resolveTasks', "resolveTasks: (...args) => traced('resolveTasks', identity.resolveTasks, ...args)");

    await fs.writeFile(path, source);
    const prunePath = join(f.workspace, 'src/prune-archived-test-groups.ts');
    let pruning = await fs.readFile(prunePath, 'utf8');
    pruning = "import {appendFile} from 'node:fs/promises';\n" + pruning;
    pruning += `\nasync function traced(name,fn,...args){const at=performance.now(),kind='prune';try{return await fn(...args);}finally{await appendFile(${JSON.stringify(join(f.control, 'runtime-cost.jsonl'))},JSON.stringify({pid:process.pid,kind,name,at:Date.now(),wallMs:performance.now()-at})+'\\n');}}\n`;
    for(const name of ['activeChangeFiles','referencedKeys','headDocument','archiveNames','pruneIds']) pruning = pruning.replaceAll(`await ${name}(`, `await traced('${name}',${name}, `);
    await fs.writeFile(prunePath, pruning);

  }
  const observed = (await exec('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='])).stdout.trim();
  const row = observed.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
  const boot = await readMachineBootIdentity();
  const store = openStateStore(f.statePath);
  store.sessionRepository.transaction(tx => tx.putSession({ runId: 'profile-main', addressId: 'main', revision: 1, state: 'running', process: { pid: process.pid, startedAt: new Date(row[1]).toISOString(), runner: 'raf', runnerSessionId: 'profile-main', tmuxSession: 'profile-main', evidence: { command: row[2], ...boot } } }));
  store.close();
  const costs = (command: string) => {
    const db = new DatabaseSync(f.statePath, { readOnly: true });
    try { return db.prepare("SELECT payload FROM raf_cost_profile WHERE scope='command' AND command=?").all(command).map(row => JSON.parse(String(row.payload))); }
    finally { db.close(); }
  };
  async function command(argv: string[]) {
    const name = argv.slice(0, 2).join(' '), prior = costs(name);
    const helpers = async () => { try { return (await fs.readFile(join(f.control, 'openspec-cost.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
    const priorHelpers = (await helpers()).length;
    const started = performance.now();
    const child = await f.spawnChild('command', [JSON.stringify(argv)]).done;
    const wallMs = performance.now() - started;
    const stages = costs(name).map(row => {
      const old = prior.find(previous => previous.stage === row.stage && previous.executor === row.executor);
      return { stage: row.stage, executor: row.executor, wallMs: row.wallTotalMs - (old?.wallTotalMs ?? 0), samples: row.samples - (old?.samples ?? 0), cpuUserMs: row.cpuUserTotalMs - (old?.cpuUserTotalMs ?? 0), cpuSystemMs: row.cpuSystemTotalMs - (old?.cpuSystemTotalMs ?? 0) };
    });
    measurements.push({ command: name, wallMs, exitCode: child.exitCode, signal: child.signal, stages, openspec: (await helpers()).slice(priorHelpers), stderr: child.stderr });
    if (child.exitCode !== 0) throw new Error(`${name} failed: ${child.stdout} ${child.stderr}`);
    return JSON.parse(JSON.parse(child.stdout).stdout);
  }
  await command(['reminder', 'list']);
  await command(['agent', 'ps']);
  const launched = await command(f.argv(f.parameters('profile-worker')));
  await command(['agent', 'message', '--to', 'profile-worker', '--text', 'Isolated profiling message']);
  await f.gate('profile-worker.exit');
  await until(f.inspect, snapshot => snapshot.sessions.some(row => row.runId === launched.runId && row.state === 'finished'), 'Profile worker must finish');
  await command(['agent', 'close', '--id', 'profile-worker']);
  if (process.argv.includes('--trace')) result.trace = (await fs.readFile(join(f.control, 'runtime-cost.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const workerCosts = new DatabaseSync(f.statePath, { readOnly: true });
  result.workerCosts = workerCosts.prepare("SELECT payload FROM raf_cost_profile WHERE scope='worker'").all().map(row => {
    const value = JSON.parse(String(row.payload));
    const previous = priorWorkerCosts.find(old => old.stage === value.stage && old.executor === value.executor);
    return { stage: value.stage, executor: value.executor, wallMs: value.wallTotalMs - (previous?.wallTotalMs ?? 0), samples: value.samples - (previous?.samples ?? 0), cpuUserMs: value.cpuUserTotalMs - (previous?.cpuUserTotalMs ?? 0), cpuSystemMs: value.cpuSystemTotalMs - (previous?.cpuSystemTotalMs ?? 0) };
  });
  workerCosts.close();
} catch (error) {
  result.error = String(error); process.exitCode = 1;
} finally {
  for (const action of cleanup.reverse()) try { await action(); } catch (error) { result.cleanupError = String(error); process.exitCode = 1; }
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
}
