import { prepareProductionQaFixture } from './production-qa-fixture.ts';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { buildCatalog } from '../src/bootstrap.ts';
import { openStateStore } from '../src/state-store.ts';
import { listTaskReservations } from '../src/task-reservations.ts';
import { observeProcesses } from '../src/os-runtime.ts';
import type { RuntimeRunParameters } from '../src/app-runtime.ts';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const descriptions = { '1.1': 'Write fixture alpha', '1.2': 'Write fixture beta', '1.3': 'Write fixture gamma', '1.4': 'Keep fixture unrelated open' };
const change = 'production-launch-fixture';
const budgetMs = 30000;

const commandScript = String.raw`
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const c = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { runProductionCli } = await import(pathToFileURL(c.sourceRoot + '/src/production-entry.ts'));
const result = await runProductionCli(JSON.parse(process.argv[3]), {orchestratorRoot:c.root,homeDirectory:c.home,artifactPath:c.artifact});
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.exitCode;
`;

const tmuxScript = String.raw`
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const c = JSON.parse(readFileSync(process.env.RAF_INTEGRATION_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
const result = spawnSync(c.tmux, args.includes('-S') ? args : ['-S', c.tmuxSocket, ...args], {stdio:'inherit',env:process.env});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

const openspecScript = String.raw`
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
const c = JSON.parse(readFileSync(process.env.RAF_INTEGRATION_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'instructions' && args[1] === 'apply' && existsSync(c.control + '/verify.block') && existsSync(c.control + '/verify.peer') && Number(readFileSync(c.control + '/verify.peer','utf8')) === process.ppid) {
  writeFileSync(c.control + '/verify.entered', JSON.stringify({pid:process.pid,parent:process.ppid,args}));
  while (!existsSync(c.control + '/verify.release')) await new Promise(r => setTimeout(r, 20));
}
const child = spawn(c.openspec, args, {cwd:process.cwd(),env:process.env,stdio:'inherit'});
child.on('error', error => { throw error; });
child.on('exit', (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  const mutation = c.control + '/mutate-after-validation.json';
  if (args[0] === 'instructions' && args[1] === 'apply' && process.cwd() === c.root && existsSync(mutation)) {
    const { from, to } = JSON.parse(readFileSync(mutation, 'utf8'));
    unlinkSync(mutation);
    const path = c.root + '/openspec/changes/' + c.change + '/tasks.md';
    writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
    writeFileSync(c.control + '/mutated', JSON.stringify({ from, to }));
  }
  process.exit(code ?? 1);
});
`;

const runnerScript = String.raw`
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
if (process.argv.includes('--version')) { console.log('codex-cli 0.0.1'); process.exit(0); }
const c = JSON.parse(readFileSync(process.env.RAF_INTEGRATION_FIXTURE, 'utf8'));
const { openStateStore } = await import(pathToFileURL(c.sourceRoot + '/src/state-store.ts'));
const { listTaskReservations } = await import(pathToFileURL(c.sourceRoot + '/src/task-reservations.ts'));
const nativeId = randomUUID();
writeFileSync(c.control + '/spawn-' + process.pid + '.json', JSON.stringify({pid:process.pid,nativeId,args:process.argv.slice(2)}));
console.log('RAF SYNTHETIC READY\n› RAF SYNTHETIC READY');
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
let input = '', assignment, reported = false;
process.stdin.on('data', chunk => {
  input += chunk.replace(/\x1b\[(?:200|201)~/g, '').replace(/\r/g, '\n');
  if (input.includes('/status')) { console.log('\nSession: ' + nativeId + '\nRAF SYNTHETIC READY\n› RAF SYNTHETIC READY'); input = ''; return; }
  if (assignment) return;
  const offset = input.search(/\{\s*"project"\s*:/);
  if (offset < 0) return;
  let candidate;
  try { candidate = JSON.parse(input.slice(offset).trim()); } catch { return; }
  if (!candidate.report_path || !candidate.assignments) return;
  if (!/[\r\n]\s*$/.test(input)) return;
  assignment = candidate;
  console.log('\n• Working (0s • esc to interrupt)\n› ');
  const store = openStateStore(c.statePath);
  try {
    const rows = store.sessionRepository.transaction(tx => tx.listSessions());
    writeFileSync(c.control + '/' + assignment.agent_id + '.brief.json', JSON.stringify({pid:process.pid,nativeId,assignment,sessions:rows,claims:listTaskReservations(store),admission:store.sessionRepository.transaction(tx=>tx.listReservations())}));
  } finally { store.close(); }
});
setInterval(() => {
  if (!assignment) return;
  const id = assignment.agent_id;
  if (!reported && existsSync(c.control + '/' + id + '.report')) {
    for (const assigned of assignment.assignments) {
      const path = assignment.root + '/openspec/changes/' + assigned.id + '/tasks.md';
      let text = readFileSync(path, 'utf8');
      for (const item of assigned.items) text = text.replace('- [ ] ' + item.id + ' ' + item.description, '- [x] ' + item.id + ' ' + item.description);
      writeFileSync(path, text);
    }
    const report = {status:'succeeded',answer:'synthetic answer ' + id,changes:assignment.assignments.map(x=>({id:x.id,items:x.items.map(item=>({id:item.id,status:'succeeded'}))}))};
    writeFileSync(assignment.report_path + '.partial', JSON.stringify(report));
    renameSync(assignment.report_path + '.partial', assignment.report_path);
    writeFileSync(c.control + '/' + id + '.reported', JSON.stringify(report));
    reported = true;
  }
  if (existsSync(c.control + '/' + id + '.exit')) {
    writeFileSync(c.control + '/' + id + '.exit17', '17');
    process.exit(17);
  }
}, 20);
`;

const starterScript = String.raw`
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const c = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { openStateStore } = await import(pathToFileURL(c.sourceRoot + '/src/state-store.ts'));
const { createProductionServices } = await import(pathToFileURL(c.sourceRoot + '/src/production-runtime.ts'));
const { listTaskReservations } = await import(pathToFileURL(c.sourceRoot + '/src/task-reservations.ts'));
const { bindWorkspaceBoundaries } = await import(pathToFileURL(c.sourceRoot + '/src/task-context.ts'));
const params = JSON.parse(process.argv[3]);
const store = openStateStore(c.statePath);
store.initializeRunners(c.models.runners);
const context = {orchestratorRoot:c.root,confRoot:c.conf,artifactPath:c.artifact,statePath:c.statePath,tmpRoot:c.tmpRoot,mode:'test',commandStartedAtMs:Date.now(),resolveCaller:async()=>undefined};
const services = await createProductionServices(store,{catalog:JSON.parse(await readFile(c.artifact,'utf8')),models:c.models,commandTiming:{emaAlpha:0.1}},context);
const valid = await services.assignment.validate({root:c.root,selections:[{change:c.change,items:params.tasks.map(task=>({id:task.split(':')[1]}))}]});
if (!valid.ok) throw new Error(JSON.stringify(valid));
const task = await services.resolveTask(params,valid.snapshot);
const selection = services.selectModel(c.models,await services.routingSnapshot(),{complexity:params.complexity,role:params.type});
if (selection.status !== 'selected') throw new Error(JSON.stringify(selection));
const runId = randomUUID();
const launch = {runId,addressId:params.id,tmuxSession:randomUUID(),activity:{type:params.type,project:params.project,features:params.features,phase:params.phase,cwd:c.workspace},assignment:valid.snapshot,selection,statePath:c.statePath,tmpRoot:c.tmpRoot,writeBoundaries:bindWorkspaceBoundaries(task,c.workspace),taskContext:{parameters:params,context:task}};
const prepared = await services.prepareReport(launch);
const admitted = await services.reserve({...launch,reportPath:prepared.reportPath,requested:task.requested,requiredFileSystemIds:[...task.requiredFileSystemIds]});
if (!admitted.admitted) throw new Error(JSON.stringify(admitted));
await writeFile(c.control + '/' + params.id + '.seeded', JSON.stringify({runId,claims:listTaskReservations(store)}));
setInterval(()=>{},1000);
`;

const serviceScript = String.raw`
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const c = JSON.parse(await readFile(process.argv[2], 'utf8'));
const module = process.argv[3] === 'host' ? '/src/service-host.ts' : '/src/production-service-ports.ts';
const { createServicePorts } = await import(pathToFileURL(c.sourceRoot + module));
const ports = await createServicePorts({orchestratorRoot:c.root,homeDirectory:c.home,stateDirectory:c.stateDirectory,socketPath:c.serviceSocket});
await ports.recover();
await writeFile(c.control + '/' + process.argv[4] + '.ready', String(process.pid));
const lines = createInterface({input:process.stdin});
for await (const line of lines) {
  if (line === 'refresh') { await ports.refresh(); console.log('refreshed'); }
  if (line === 'stop') break;
}
await ports.shutdown();
`;

async function json(path: string) { return JSON.parse(await fs.readFile(path, 'utf8')); }
async function writeJson(path: string, value: unknown) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
async function exists(path: string) { try { await fs.access(path); return true; } catch { return false; } }
async function until<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T;
  do {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`${label}; останнє спостереження: ${JSON.stringify(last)}`);
}

async function fixture(t: any) {
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/raf-pi-'));
  const root = join(directory, 'orchestrator');
  const home = join(directory, 'home');
  const conf = join(root, 'conf');
  const stateDirectory = join(home, '.raf');
  const tmpRoot = join(stateDirectory, 'tmp');
  const control = join(directory, 'control');
  const bin = join(directory, 'bin');
  const workspace = join(root, 'raf-develop');
  for (const path of [conf, tmpRoot, control, bin, workspace]) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const programs = await Promise.all(['openspec', 'tmux'].map(async name => (await exec('/bin/sh', ['-c', 'command -v "$1"', 'fixture', name])).stdout.trim()));
  assert.match((await exec(programs[0], ['--version'], { cwd: root, env: { ...process.env, HOME: home } })).stdout, /^1\.14\.3\s*$/);
  const models = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/models.json'), 'utf8'));
  models.models = models.models.filter((x: any) => x.id === 'gpt-6.1-sol');
  models.runners = models.runners.filter((x: any) => x.id === 'codex');
  assert.equal(models.models[0]?.effort, 'high');
  const constants = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/raf-constants.json'), 'utf8'));
  constants.commands = constants.commands.filter((x: any) => ['agent run', 'agent close', 'agent interrupt', 'agent message', 'agent ps', 'runner disable', 'test run', 'help'].includes(x.path.join(' ')));
  const artifact = join(directory, 'catalog.json');
  const changeDir = join(root, 'openspec', 'changes', change);
  const questionsPath = join(root, 'questions', 'projects', 'raf', 'questions.md');
  await writeJson(join(conf, 'projects.json'), JSON.parse(await fs.readFile(join(sourceRoot, '../conf/projects.json'), 'utf8')));
  await prepareProductionQaFixture(t, { root, home });
  const { createProductionServices }: typeof import('../src/production-runtime.ts') = await import(pathToFileURL(join(workspace, 'src', 'production-runtime.ts')).href);
  const { createServicePorts: productionPorts }: typeof import('../src/production-service-ports.ts') = await import(pathToFileURL(join(workspace, 'src', 'production-service-ports.ts')).href);
  const { createServicePorts: defaultHost }: typeof import('../src/service-host.ts') = await import(pathToFileURL(join(workspace, 'src', 'service-host.ts')).href);
  const cfg = { sourceRoot: workspace, root, conf, home, stateDirectory, statePath: join(stateDirectory, 'state.sqlite'), tmpRoot, control, workspace, artifact, bin, change, changeDir, questionsPath, models,
    tmux: programs[1], openspec: programs[0], tmuxSocket: join(directory, 'tmux.sock'), serviceSocket: join(stateDirectory, 'service.sock'), file: join(directory, 'fixture.json') };
  const env = { ...process.env, HOME: home, RAF_QA_HOME: home, PATH: `${bin}:${process.env.PATH}`, RAF_INTEGRATION_FIXTURE: cfg.file, TMPDIR: directory };
  const children: ReturnType<typeof spawn>[] = [];
  const ownedProcesses = new Map<number, any>();
  const ownedSockets = new Set<string>([cfg.tmuxSocket, join(tmpRoot, 'tmux', 'server.sock')]);
  const spawnChild = (name: string, args: string[] = []) => {
    const child = spawn(process.execPath, [join(directory, name + '.mjs'), cfg.file, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout!.on('data', data => { stdout += data; });
    child.stderr!.on('data', data => { stderr += data; });
    const done = new Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
    });
    return { child, done, output: () => ({ stdout, stderr }) };
  };
  t.after(async () => {
    await fs.writeFile(join(control, 'verify.release'), 'release');
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await inspect();
    for (const identity of ownedProcesses.values()) {
      const [actual] = await observeProcesses([identity]);
      assert.notEqual(actual.state, 'unknown', `Не можна підтвердити own process для cleanup: ${JSON.stringify(actual)}`);
      if (actual.state === 'alive') {
        try { process.kill(identity.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('close', () => resolve()))));
    for (const identity of ownedProcesses.values()) {
      await until(async () => (await observeProcesses([identity]))[0], observation => observation.state === 'exited', `OS має підтвердити завершення own process ${identity.pid} перед socket cleanup`);
    }
    for (const socket of ownedSockets) {
      const path = resolve(socket);
      if (!path.startsWith(directory + '/')) continue;
      if (!await exists(path)) continue;
      const parent = await fs.realpath(dirname(path));
      if (parent !== directory && !parent.startsWith(directory + '/')) continue;
      assert.ok((await fs.lstat(path)).isSocket(), `Очікується own tmux socket: ${path}`);
      await exec(cfg.tmux, ['-S', path, 'kill-server']).catch(error => {
        if (!/no server running|error connecting|no such file/i.test(String(error.stderr))) throw error;
      });
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await writeJson(cfg.file, cfg);
  const scripts = { command: commandScript, starter: starterScript, service: serviceScript };
  for (const [name, source] of Object.entries(scripts)) await fs.writeFile(join(directory, name + '.mjs'), source);
  for (const [name, source] of Object.entries({ codex: runnerScript, tmux: tmuxScript, openspec: openspecScript })) await fs.writeFile(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  for (const path of [...Object.keys(scripts).map(name => join(directory, name + '.mjs')), ...['codex', 'tmux', 'openspec'].map(name => join(bin, name))]) await exec(process.execPath, ['--check', path], { cwd: root, env });
  await writeJson(join(conf, 'models.json'), models);
  await writeJson(join(conf, 'raf-constants.json'), constants);
  const flow = JSON.parse(await fs.readFile(join(sourceRoot, '../conf/flow.json'), 'utf8'));
  await writeJson(join(conf, 'flow.json'), { ...flow, resources: Object.fromEntries(Object.entries(flow.resources).map(([tier, thresholds]) => [tier, { ...(thresholds as object), minRamBytes: 1, minDiskBytes: 1 }])) });
  await fs.mkdir(dirname(questionsPath), { recursive: true });
  await fs.writeFile(questionsPath, '# Питання\n');
  await writeJson(join(conf, 'raf.json'), { version: 1, state: { fileName: 'state.sqlite' }, commandTiming: { emaAlpha: 0.1 }, resourceWait: { grantIntervalMs: 15000 }, service: { hostTickIntervalMs: 10000, readinessTimeoutMs: 30000, entryRelativePath: 'bin/service.ts' }, runnerProtocols: [{
    runner: 'codex', executable: 'codex', version: '0.0.1', baseArgs: [], modelFlag: '--model', effortFlag: '-c', effortFormat: 'codex_config', modelAliases: {}, promptTransport: 'positional', sessionIdFlag: null, quotaCommand: '/status', navigation: [], markers: { ready: ['RAF SYNTHETIC READY'] }, quotaParser: 'codex_status', modelPools: {}, quotaReliable: false, liveTaskVerified: true,
    timeouts: { startupMs: 20000, transitionMs: 10000, overallMs: 30000, pollMs: 25 }, collection: { intervalMs: 300000, failureBackoffMs: 60000, staleAfterMs: 60000 }
  }] });
  for (const path of ['runners/codex.md', 'tasks/implement.md', 'completion.md']) { await fs.mkdir(dirname(join(conf, 'briefs', path)), { recursive: true }); await fs.writeFile(join(conf, 'briefs', path), 'Synthetic integration fixture.\n'); }
  buildCatalog(conf, artifact, constants.commands.map((x: any) => x.path.join(' ')));
  await exec('git', ['init', '-b', 'develop', workspace], { env });
  await fs.mkdir(changeDir, { recursive: true });
  await fs.writeFile(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await fs.writeFile(join(changeDir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-22\n');
  await fs.writeFile(join(changeDir, 'proposal.md'), '## Why\nIsolated production entry fixture.\n\n## What Changes\nExercise owned fixture tasks.\n\n## Capabilities\n\n### New Capabilities\n- `production-fixture`: Execute isolated fixture work.\n\n## Impact\nTemporary fixture only.\n');
  await fs.writeFile(join(changeDir, 'design.md'), '## Context\nSynthetic executable with actual OS boundaries.\n\n## Decisions\nUse a private temporary fixture and explicit gates.\n');
  await fs.mkdir(join(changeDir, 'specs', 'production-fixture'), { recursive: true });
  await fs.writeFile(join(changeDir, 'specs', 'production-fixture', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Isolated fixture task\nThe fixture SHALL execute only selected temporary tasks.\n\n#### Scenario: Selected task completes\n- **WHEN** the report gate opens\n- **THEN** only assigned temporary task items are completed\n');
  await fs.writeFile(join(changeDir, 'tasks.md'), '## 1. Fixture\n\n' + Object.entries(descriptions).map(([id, description]) => `- [ ] ${id} ${description}`).join('\n') + '\n');
  openStateStore(cfg.statePath).close();
  function parameters(id: string, tasks = ['1.1']): RuntimeRunParameters { return { id, type: 'implement', project: 'raf', features: ['production-launch'], phase: 'implement', complexity: 'decision', tasks: tasks.map(item => `${change}:${item}`) }; }
  function argv(params: RuntimeRunParameters) { return ['agent', 'run', '--id', params.id, '--type', params.type, '--project', params.project, '--features', ...params.features, '--phase', params.phase, '--complexity', params.complexity, '--tasks', ...params.tasks]; }
  async function run(id: string, tasks = ['1.1']) { return spawnChild('command', [JSON.stringify(argv(parameters(id, tasks)))]); }
  async function inspect() {
    const store = openStateStore(cfg.statePath);
    try {
      const claims = listTaskReservations(store);
      const sessions = store.sessionRepository.transaction(tx => tx.listSessions());
      for (const identity of [...claims.flatMap(claim => [claim.wrapper, claim.agent]), ...sessions.map(session => session.process)]) {
        if (!identity) continue;
        ownedProcesses.set(identity.pid, identity);
        if (identity.evidence.tmuxSocket) ownedSockets.add(identity.evidence.tmuxSocket);
      }
      return { sessions, claims, admission: store.sessionRepository.transaction(tx => tx.listReservations()), pending: store.sessionRepository.transaction(tx => tx.listPending()) };
    }
    finally { store.close(); }
  }
  async function launched(id: string, tasks = ['1.1']) {
    const invocation = await run(id, tasks);
    const result = await until(() => invocation.child.exitCode !== null || invocation.child.signalCode !== null ? invocation.done : undefined, x => x !== undefined, 'Parent invocation має реально завершитися');
    assert.equal(result!.exitCode, 0, JSON.stringify(result));
    const brief = await until(async () => await exists(join(control, id + '.brief.json')) ? json(join(control, id + '.brief.json')) : null, Boolean, 'Runner має отримати brief');
    const snapshot = await inspect();
    const session = snapshot.sessions.find(x => x.addressId === id)!;
    assert.ok(session?.process, 'Потрібен actual runner process у canonical SQLite');
    return { invocation, brief, session };
  }
  async function startService(label: string, host = false) {
    const worker = spawnChild('service', [host ? 'host' : 'production', label]);
    await until(async () => ({ ready: await exists(join(control, label + '.ready')), output: worker.output(), code: worker.child.exitCode }), x => { assert.equal(x.code, null, JSON.stringify(x)); return x.ready; }, 'Default service recover має завершитися');
    return worker;
  }
  return { ...cfg, createProductionServices, productionPorts, defaultHost, directory, env, children, spawnChild, inspect, parameters, argv, run, launched, startService, gate: (name: string) => fs.writeFile(join(control, name), 'go'), brief: (id: string) => json(join(control, id + '.brief.json')) };
}

test('[production-launch] default entry derives task context, ignores a legacy context file and fences actual runner before first brief', async t => {
  const f = await fixture(t);
  await writeJson(join(f.tmpRoot, 'task-context', 'entry.json'), { version: 1, parameters: f.parameters('entry'), assignment: { root: f.root, changes: [{ id: change, items: [{ id: '1.1', description: descriptions['1.1'] }] }], baselineArchives: [] }, context: { branch: 'main', outcome: 'FOREIGN_OUTCOME', writeBoundaries: [f.root], sources: ['/FOREIGN — чуже; завжди'], requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [], reportSchema: { foreign: true } } });
  const { brief, session, invocation } = await f.launched('entry');
  assert.equal(invocation.child.exitCode, 0);
  process.kill(brief.pid, 0);
  assert.equal(session.state, 'running');
  assert.equal(session.process!.pid, brief.pid);
  assert.equal(session.process!.runnerSessionId, brief.nativeId);
  assert.match(brief.nativeId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.doesNotMatch(JSON.stringify(brief.assignment), /FOREIGN/);
  assert.equal(brief.assignment.outcome, `${change}:1.1 — ${descriptions['1.1']}`);
  assert.deepEqual(brief.assignment.write_boundaries, [f.workspace, f.changeDir, f.questionsPath]);
  assert.deepEqual(session.launchContext!.writeBoundaries, [f.workspace, f.changeDir, f.questionsPath]);
  const diagnostic = await json(join(f.tmpRoot, session.runId, 'task-context.json'));
  assert.equal(diagnostic.runId, session.runId);
  assert.deepEqual(diagnostic.parameters, f.parameters('entry'));
  assert.equal(diagnostic.context.outcome, brief.assignment.outcome);
  const claim = brief.claims.find((x: any) => x.lease.owner.runId === session.runId);
  assert.equal(claim?.stage, 'running');
  assert.equal(claim.agent.pid, brief.pid);
  assert.equal(claim.agent.runnerSessionId, brief.nativeId);
  assert.ok(claim.lease.owner.fence);
  assert.ok(claim.lease.revision > 1);
  assert.ok(brief.admission.some((x: any) => x.runId === session.runId));
  const task = claim.tasks[0];
  const canonicalRoot = await fs.realpath(f.root);
  const expected = createHash('sha256').update(JSON.stringify(['raf-task-fingerprint-v1', 'raf', canonicalRoot, change, task.changeInstance, '1.1', descriptions['1.1']])).digest('hex');
  assert.equal(task.fingerprint, expected);
  assert.equal(brief.assignment.report_path, join(f.tmpRoot, session.runId, 'entry.json'));
  assert.equal(session.launchContext!.selection.model, 'gpt-6.1-sol');
  assert.equal(session.launchContext!.selection.effort, 'high');
});

test('[production-launch] invalid assignment and assignment changed between derivation and start create no runner or claims; forged main rejected', async t => {
  const f = await fixture(t);
  const bad = f.parameters('bad-assignment', ['99.9']);
  const result = await f.spawnChild('command', [JSON.stringify(f.argv(bad))]).done;
  assert.notEqual(result.exitCode, 0, JSON.stringify(result));
  const forged = 'Write forged fixture alpha';
  await writeJson(join(f.control, 'mutate-after-validation.json'), { from: `- [ ] 1.1 ${descriptions['1.1']}`, to: `- [ ] 1.1 ${forged}` });
  const changedResult = await f.spawnChild('command', [JSON.stringify(f.argv(f.parameters('changed-assignment')))]).done;
  assert.deepEqual(await json(join(f.control, 'mutated')), { from: `- [ ] 1.1 ${descriptions['1.1']}`, to: `- [ ] 1.1 ${forged}` });
  assert.notEqual(changedResult.exitCode, 0, JSON.stringify(changedResult));
  const failure = JSON.parse(JSON.parse(changedResult.stdout).stderr);
  assert.equal(failure.details.stage, 'reservation', changedResult.stdout);
  assert.match(failure.details.reason, new RegExp(`${change}/1\\.1 is missing, ambiguous, changed or completed`));
  const leftovers = [];
  for (const entry of await fs.readdir(f.tmpRoot)) if (await exists(join(f.tmpRoot, entry, 'task-context.json'))) leftovers.push(entry);
  assert.deepEqual(leftovers, [], 'cleanupUnstarted має прибрати каталог запуску з виведеним контекстом');
  const snapshot = await f.inspect();
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.claims.length, 0);
  assert.equal(snapshot.admission.length, 0);
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 0);
  const store = openStateStore(f.statePath);
  try {
    const services = await f.createProductionServices(store, { catalog: await json(f.artifact), models: f.models, commandTiming: { emaAlpha: 0.1 } }, { orchestratorRoot: f.root, confRoot: f.conf, artifactPath: f.artifact, statePath: f.statePath, tmpRoot: f.tmpRoot, mode: 'test', commandStartedAtMs: Date.now(), resolveCaller: async () => ({ id: 'main', authority: true }) });
    await assert.rejects(services.authorizeMain({ id: 'main', addressId: 'main', authority: true, proof: true }));
  } finally { store.close(); }
});

test('[production-launch] concurrent overlapping real entry is all-or-none and independent item remains launchable', async t => {
  const f = await fixture(t);
  const attempts = await Promise.all([f.run('left', ['1.1', '1.2']), f.run('right', ['1.2', '1.3'])]);
  const results = await Promise.all(attempts.map(x => x.done));
  assert.equal(results.filter(x => x.exitCode === 0).length, 1, JSON.stringify(results));
  const loser = results[0].exitCode === 0 ? 1 : 0;
  const winnerId = loser === 0 ? 'right' : 'left';
  const diagnostic = results[loser].stdout + results[loser].stderr;
  assert.match(diagnostic, /conflict|reserved|зайнят|конфлікт/i);
  assert.ok(diagnostic.includes('1.2'), diagnostic);
  assert.ok(diagnostic.includes(winnerId), diagnostic);
  const snapshot = await f.inspect();
  assert.equal(snapshot.sessions.filter(x => x.state !== 'finished').length, 1);
  assert.equal(snapshot.claims.length, 1);
  assert.equal(snapshot.claims[0].tasks.length, 2);
  assert.equal(snapshot.claims[0].lease.owner.addressId, winnerId);
  assert.equal(snapshot.admission.length, 1);
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 1);
  await f.launched('independent', [loser === 0 ? '1.1' : '1.3']);
  assert.equal((await f.inspect()).claims.length, 2);
});

test('[production-launch] accepted succeeded answer is visible while running and survives deterministic exit17 with minimal retention', async t => {
  const f = await fixture(t);
  const { session } = await f.launched('report');
  await f.gate('report.report');
  await until(f.inspect, x => x.sessions.some(s => s.runId === session.runId && s.state === 'running' && s.result?.status === 'succeeded'), 'Actual watcher має підтвердити succeeded до exit gate');
  const active = (await f.inspect()).sessions.find(x => x.runId === session.runId)!;
  assert.equal(active.result!.response, 'synthetic answer report');
  process.kill(active.process!.pid, 0);
  assert.ok((await f.inspect()).admission.some(x => x.runId === session.runId));
  await f.gate('report.exit');
  const finished = await until(f.inspect, x => x.sessions.some(s => s.runId === session.runId && s.state === 'finished'), 'Persistent worker має завершити lifecycle');
  const retained = finished.sessions.find(x => x.runId === session.runId)!;
  assert.equal(await fs.readFile(join(f.control, 'report.exit17'), 'utf8'), '17');
  assert.equal(retained.result?.status, 'succeeded');
  assert.equal(retained.result?.response, '');
  assert.equal(retained.result?.proof, null);
  assert.equal(retained.launchContext, undefined);
  assert.equal(finished.claims.length, 0);
  assert.equal(finished.admission.length, 0);
});

test('[production-launch] default service refresh/recover cannot finalize exit while persistent report verification is gated', async t => {
  const f = await fixture(t);
  const { session } = await f.launched('race');
  const before = await f.inspect();
  const claim = before.claims.find(x => x.lease.owner.runId === session.runId)!;
  assert.ok(claim.wrapper?.pid);
  await fs.writeFile(join(f.control, 'verify.peer'), String(claim.wrapper!.pid));
  await f.gate('verify.block');
  await f.gate('race.report');
  await until(() => exists(join(f.control, 'verify.entered')), Boolean, 'Actual OpenSpec verification має досягти gate');
  assert.equal((await f.inspect()).sessions.find(x => x.runId === session.runId)!.result?.status, undefined);
  await f.gate('race.exit');
  await until(() => exists(join(f.control, 'race.exit17')), Boolean, 'Actual runner має вийти під час перевірки');
  await until(async () => { try { process.kill(session.process!.pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; } }, Boolean, 'OS має підтвердити завершення runner');
  const service = await f.startService('race-service', true);
  service.child.stdin!.write('refresh\n');
  await until(service.output, x => x.stdout.includes('refreshed'), 'Default service refresh має завершитися');
  const pending = (await f.inspect()).sessions.find(x => x.runId === session.runId)!;
  assert.notEqual(pending.state, 'finished', 'Живий verified wrapper ще перевіряє звіт цього run');
  assert.notEqual(pending.result?.status, 'failed');
  assert.deepEqual(pending.launchContext, session.launchContext);
  assert.ok((await f.inspect()).admission.some(x => x.runId === session.runId));
  assert.ok((await f.inspect()).claims.some(x => x.lease.owner.runId === session.runId));
  await f.gate('verify.release');
  const finished = await until(f.inspect, x => x.sessions.some(s => s.runId === session.runId && s.state === 'finished'), 'Confirmed report має виграти race після actual OpenSpec');
  assert.equal(finished.sessions.find(x => x.runId === session.runId)!.result?.status, 'succeeded');
  assert.equal(finished.claims.length, 0);
  assert.equal(finished.admission.length, 0);
  assert.equal(finished.pending.filter(x => x.runId === session.runId && x.event === 'agent.failed').length, 0);
});

test('[production-launch] default service startup releases real SIGKILL starter before spawn without manual cleanup', async t => {
  const f = await fixture(t);
  const params = f.parameters('starter');
  const starter = f.spawnChild('starter', [JSON.stringify(params)]);
  const seeded = await until(async () => await exists(join(f.control, 'starter.seeded')) ? json(join(f.control, 'starter.seeded')) : null, Boolean, 'Public production reserve має зафіксувати starter');
  const before = await f.inspect();
  assert.equal(before.claims[0].stage, 'starting');
  assert.equal(before.claims[0].starter.pid, starter.child.pid);
  assert.equal(before.admission.length, 1);
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 0);
  starter.child.kill('SIGKILL');
  assert.equal((await starter.done).signal, 'SIGKILL');
  const service = await f.startService('starter-recovery');
  const after = await f.inspect();
  assert.equal(after.claims.length, 0, 'recover має викликати shared OS claims reconciliation');
  assert.equal(after.admission.length, 0);
  assert.equal(after.sessions.find(x => x.runId === seeded.runId)?.state, 'finished');
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 0);
  service.child.stdin!.end('stop\n');
  assert.equal((await service.done).exitCode, 0);
});

test('[production-launch] live actual runner and its lease survive default service restart without respawn', async t => {
  const f = await fixture(t);
  const { session } = await f.launched('survivor');
  const before = await f.inspect();
  const service = await f.startService('first-service');
  service.child.stdin!.end('stop\n');
  assert.equal((await service.done).exitCode, 0);
  const restarted = await f.startService('second-service', true);
  restarted.child.stdin!.write('refresh\n');
  await until(restarted.output, x => x.stdout.includes('refreshed'), 'Restarted default host refresh');
  const after = await f.inspect();
  assert.deepEqual(after.claims, before.claims);
  assert.equal(after.sessions.find(x => x.runId === session.runId)?.state, 'running');
  assert.deepEqual(after.sessions.find(x => x.runId === session.runId)?.process, session.process);
  process.kill(session.process!.pid, 0);
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 1);
});

test('[production-launch] incomplete persisted process evidence stays conservative during default startup recovery', async t => {
  const f = await fixture(t);
  const params = f.parameters('unknown');
  const starter = f.spawnChild('starter', [JSON.stringify(params)]);
  await until(() => exists(join(f.control, 'unknown.seeded')), Boolean, 'Real starter reserve');
  const store = openStateStore(f.statePath);
  try {
    store.taskReservationRepository.transaction(tx => {
      const claim = tx.listTaskReservations()[0];
      tx.putTaskReservation({ ...claim, starter: { ...claim.starter, startedAt: '', evidence: { ...claim.starter.evidence, command: '' } } });
    });
  } finally { store.close(); }
  const before = await f.inspect();
  const context = { orchestratorRoot: f.root, homeDirectory: f.home, stateDirectory: f.stateDirectory, socketPath: f.serviceSocket };
  for (const create of [f.productionPorts, f.defaultHost]) {
    const ports = await create(context);
    try {
      await assert.rejects(ports.recover(), /TASK_LIVENESS_UNKNOWN|unknown|identity|evidence|невідом/i);
      const after = await f.inspect();
      assert.deepEqual(after.claims, before.claims);
      assert.deepEqual(after.admission, before.admission);
      assert.notEqual(after.sessions[0].state, 'finished');
      process.kill(starter.child.pid!, 0);
    } finally { await ports.shutdown(); }
  }
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 0);
});
