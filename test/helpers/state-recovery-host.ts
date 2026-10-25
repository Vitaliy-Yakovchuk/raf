import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { RecoveryGroup, RecoveryInFlight, StateRecoveryResult } from '../../src/test-run-state-recovery.ts';

export type HostCommand = {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};
export type HostIdentity = { pid: number; start: string; boot: string };
export type HostSnapshot = {
  group: RecoveryGroup;
  originalRun: RecoveryInFlight;
  controlStatePath: string;
  unitStatePath: string;
  wrapper: HostIdentity;
  tree: HostIdentity[];
  caller: { agentId: string; runId: string; identity: HostIdentity };
  generation: string;
  sha: string;
  dirtyPaths: string[];
  spawnCount: number;
  releaseCount: number;
};
export type HostExecution = {
  result: StateRecoveryResult;
  stderr: string;
  cliCode: number;
  argv: string[];
  cwd: string;
};
export type HostCheckpoint = {
  name: 'after-spawn' | 'before-commit' | 'after-commit-before-delivery';
  runId: string;
  atMs: number;
};
export type StateRecoveryHost = {
  command: HostCommand;
  deadlineMs: number;
  home: string;
  root: string;
  checkpointPath: string;
  childReleasePath: string;
  evidencePath: string;
  snapshot(): Promise<HostSnapshot>;
  reconcile(): Promise<HostExecution>;
  normal(mode: 'passed' | 'refused'): Promise<HostExecution>;
  restartRecipient(): Promise<void>;
  cleanupClosedChange(): Promise<void>;
  setMainAvailability(availability: 'unavailable' | 'accepted' | 'forwarded'): Promise<void>;
  markExitTimeUnknown(): Promise<void>;
  awaitTreeExit(): Promise<void>;
  awaitOriginalDeadline(): Promise<void>;
  finish(): Promise<{ remainingOwned: HostIdentity[]; operationalStateOpened: boolean }>;
};
export async function prepareStateRecoveryHost(input: {
  root: string;
  testKind: 'unit' | 'integration';
  checkpoint: HostCheckpoint['name'];
  child: 'early-exit' | 'alive-through-deadline';
  initialTimeoutCount: 1;
}): Promise<StateRecoveryHost> {
  const source = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const sourceRoot = dirname(source);
  const root = realpathSync(input.root);
  const workspace = join(root, 'raf-develop');
  const home = join(root, 'control');
  const unitOwner = join(root, 'u');
  const unitHome = join(unitOwner, createHash('sha256').update(JSON.stringify([root, 'raf', workspace])).digest('hex'));
  const checkpointPath = join(root, 'checkpoint.json');
  const childReleasePath = join(root, 'release');
  const evidencePath = join(root, 'evidence');
  const metadata = join(root, 'observations.json');
  const settings = join(root, 'receiver.json');
  const originalPath = join(root, 'original.json');
  const groupId = 'add-raf-test-run/state-open-recovery-fixture';
  const phase = input.testKind === 'unit' ? 'qa' : 'integration';
  const budget = 4000;
  const owned = new Map<number, HostIdentity>();
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value) + '\n');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sha = git(source, 'rev-parse', 'HEAD');
  const dirtyPaths = git(source, 'status', '--porcelain').split('\n').filter(Boolean).map(row => row.slice(3));
  const generation = createHash('sha256').update(['src/test-runs.ts', 'src/test-run-runtime.ts', 'src/test-run-state-recovery.ts', 'bin/raf.ts'].map(path => readFileSync(join(source, path))).join('\n')).digest('hex');
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const identity = (pid: number): HostIdentity | null => {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      return fields[0] === 'Z' ? null : { pid, start: fields[19], boot };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const remember = (row: HostIdentity | null) => { if (row) owned.set(row.pid, row); };
  const same = (row: HostIdentity) => { const now = identity(row.pid); return !!now && now.start === row.start && now.boot === row.boot; };
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && (['PATH', 'LANG', 'TZ'].includes(key) || key.startsWith('LC_')))) as Record<string, string>;
  const environment = { ...inherited, HOME: home, RAF_QA_HOME: home, TMPDIR: join(root, 't'), RAF_ORCHESTRATOR_ROOT: root };
  let controlStatePath = '';
  let unitStatePath = '';
  let original: RecoveryInFlight | null = null;
  let deadlineMs = 0;
  let command: HostCommand;
  let state: import('../../src/test-runs.ts').TestRunStatePort;
  let unitStore: { close(): void } | undefined;
  let controllerStore: { close(): void } | undefined;
  const callerRunId = randomUUID();
  const callerId = 'state-recovery-stand';
  const controllerIdentity = identity(process.pid);
  if (!controllerIdentity) throw new Error('Cannot prove stand caller identity');
  const wait = async (ready: () => boolean, label: string) => {
    while (Date.now() < deadlineMs) { if (ready()) return; await delay(10); }
    throw new Error(`Stand budget exhausted: ${label}`);
  };
  const track = () => {
    if (existsSync(originalPath)) {
      const saved = read(originalPath);
      original ??= saved.flight;
      remember(saved.wrapper);
      for (const row of saved.tree) remember(row);
    }
  };
  const finish = async () => {
    track();
    for (const row of owned.values()) if (same(row)) { try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    await wait(() => [...owned.values()].every(row => !same(row)), 'identity cleanup');
    unitStore?.close(); unitStore = undefined;
    controllerStore?.close(); controllerStore = undefined;
    return { remainingOwned: [...owned.values()].filter(same), operationalStateOpened: false };
  };
  try {
    for (const directory of ['conf', 'evidence', 'control', 'u', 't', 'main-origin', 'openspec/changes/add-raf-test-run', 'raf-develop/test']) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    for (const directory of ['src', 'bin', 'scripts', 'dist']) cpSync(join(source, directory), join(workspace, directory), { recursive: true });
    cpSync(join(source, 'package.json'), join(workspace, 'package.json'));
    mkdirSync(join(workspace, 'node_modules'), { recursive: true });
    symlinkSync(realpathSync(join(source, 'node_modules/typescript')), join(workspace, 'node_modules/typescript'), 'dir');
    cpSync(join(sourceRoot, 'conf'), join(root, 'conf'), { recursive: true, filter: path => !/(?:secret|credential)/i.test(path) });
    const projects = read(join(root, 'conf/projects.json'));
    projects.projects = { raf: { ...projects.projects.raf, path: './main-origin', branchPaths: { main: './main-origin', develop: './raf-develop' } } };
    json(join(root, 'conf/projects.json'), projects);
    const flow = read(join(root, 'conf/flow.json'));
    if (!Number.isSafeInteger(flow.integrationTests?.timeoutMs) || flow.integrationTests.timeoutMs <= 0) throw new Error('Activate the approved integration configuration/generation (6.2.5) before host QA');
    flow.integrationTests.timeoutMs = budget;
    flow.unitTests.timeoutMs = budget;
    json(join(root, 'conf/flow.json'), flow);
    const config = read(join(root, 'conf/test-runs.json'));
    const profileId = input.testKind === 'unit' ? 'node' : 'node-integration';
    const profile = config.projects.raf.profiles[profileId];
    if (!config.phases.integration?.allowed || !config.projects.raf.profiles['node-integration'] || !profile) throw new Error('The approved node-integration profile and integration phase are prerequisites');
    const file = `test/recovery-${input.testKind}.test.mjs`;
    const other = `test/unselected-${input.testKind}.test.mjs`;
    profile[input.testKind === 'unit' ? 'unitFiles' : 'integrationFiles'] = [file, other];
    profile.resourceEstimate ??= structuredClone(flow.resourceEstimates.agentTypes.qa);
    config.projects = { raf: { profiles: { [profileId]: profile }, groups: { [groupId]: { profileId, files: [file] } } } };
    config.temporaryArtifacts = { ...config.temporaryArtifacts, root: join(root, 't'), minimumNestedSocketPathBytes: 1 };
    json(join(root, 'conf/test-runs.json'), config);
    const constants = read(join(root, 'conf/raf-constants.json'));
    constants.commands.find((command: { path: string[] }) => command.path.join(' ') === 'test run').examples = [`raf test run --project raf --phase ${phase} --group ${groupId}`];
    json(join(root, 'conf/raf-constants.json'), constants);
    json(settings, { mode: 'crash', availability: 'unavailable', recipientGeneration: 0 });
    json(metadata, { spawnRuns: [], releasedRuns: [] });
    const hookSource = `import {existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
const root=${JSON.stringify(root)}, settings=${JSON.stringify(settings)}, original=${JSON.stringify(originalPath)}, meta=${JSON.stringify(metadata)};
const read=p=>JSON.parse(readFileSync(p,'utf8')); const json=(p,v)=>writeFileSync(p,JSON.stringify(v)+'\\n');
const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
function identity(pid){try{const r=readFileSync('/proc/'+pid+'/stat','utf8');const f=r.slice(r.lastIndexOf(')')+2).split(' ');return f[0]==='Z'?null:{pid,start:f[19],boot};}catch{return null;}}
function tree(pid){const rows=readdirSync('/proc').filter(n=>/^\\d+$/.test(n)).flatMap(n=>{try{const r=readFileSync('/proc/'+n+'/stat','utf8');const f=r.slice(r.lastIndexOf(')')+2).split(' ');return f[0]==='Z'?[]:[{pid:Number(n),ppid:Number(f[1]),pgid:Number(f[2]),start:f[19],boot}];}catch{return [];}});const owned=new Set([pid,...rows.filter(r=>r.pgid===pid).map(r=>r.pid)]);for(let size=-1;size!==owned.size;){size=owned.size;for(const r of rows)if(owned.has(r.ppid))owned.add(r.pid);}return rows.filter(r=>owned.has(r.pid)).map(({pid,start,boot})=>({pid,start,boot}));}
export function capture(group){if(!group.inFlight?.processIdentity)return;const m=read(meta);if(!m.spawnRuns.includes(group.inFlight.runId)){m.spawnRuns.push(group.inFlight.runId);json(meta,m);const pid=JSON.parse(group.inFlight.processIdentity).pid;json(original,{flight:group.inFlight,wrapper:identity(process.pid),tree:tree(pid)});}}
export function released(runId){const m=read(meta);if(!m.releasedRuns.includes(runId)){m.releasedRuns.push(runId);json(meta,m);}}
export async function checkpoint(name,runId){if(read(settings).mode!=='crash'||name!==${JSON.stringify(input.checkpoint)})return;json(${JSON.stringify(checkpointPath)},{name,runId,atMs:Date.now()});await new Promise((_,reject)=>setTimeout(()=>reject(new Error('Stand checkpoint watchdog')),${budget * 10}));}
export function mayReturn(){return read(settings).mode==='normal';}
export async function receipt(reply){const current=read(settings);if(current.availability==='unavailable')return {accepted:false,receiptId:null,forwarded:false};const receiptId=reply.delivery?.receiptId??('stand-receipt-'+reply.recovery.runId);return {accepted:true,receiptId,forwarded:current.availability==='forwarded'};}
`;
    writeFileSync(join(workspace, 'src/state-recovery-stand.ts'), hookSource);
    const change = (file: string, transform: (source: string) => string) => {
      const path = join(workspace, file), before = readFileSync(path, 'utf8'), after = transform(before);
      if (before === after) throw new Error(`Stand injection anchor absent: ${file}`);
      writeFileSync(path, after);
    };
    change('src/test-run-runtime.ts', source => "import * as stand from './state-recovery-stand.ts';\n" + source
      .replace("const owner = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`);", `const owner = ${JSON.stringify(unitOwner)};`)
      .replace('put: group => { db.prepare(', 'put: group => { stand.capture(group); db.prepare(')
      .replace('resultContext = stateContext;', `const release = resources.release; resources.release = async claim => { const done = await release(claim); if (done) stand.released(claim.testRunId); return done; };\n        resultContext = stateContext;`)
      .replace("messageMain: async () => ({ accepted: false, receiptId: null, forwarded: false }),", 'messageMain: stand.receipt,')
      .replace('const stateForDelivery = resultContext;', "const stateForDelivery = resultContext;\n    await stand.checkpoint('after-commit-before-delivery', output.runId);")
      .replace("const deliveredStore = openStore('unit', stateForDelivery);", "if (!stand.mayReturn()) return;\n        const deliveredStore = openStore('unit', stateForDelivery);"));
    change('src/test-runs.ts', source => "import * as stand from './state-recovery-stand.ts';\n" + source.replace('    const finished = await Promise.race([child.wait(), stopped]);', `    await stand.checkpoint(${JSON.stringify(input.checkpoint === 'before-commit' ? 'before-commit' : 'after-spawn')}, result.runId);\n    const finished = await Promise.race([child.wait(), stopped]);`));
    writeFileSync(join(workspace, file), `import {test} from 'node:test';import {existsSync,readFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
test('owned recovery child',async()=>{const settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));if(settings.mode==='normal'||${JSON.stringify(input.checkpoint)}==='after-commit-before-delivery')return;while(!existsSync(${JSON.stringify(childReleasePath)}))await delay(10);});\n`);
    writeFileSync(join(workspace, other), "import {test} from 'node:test';test('unselected',()=>{});\n");
    git(workspace, 'init', '-b', 'develop');
    git(workspace, '-c', 'user.name=State Recovery Stand', '-c', 'user.email=stand@invalid', 'commit', '--allow-empty', '-m', 'isolated state recovery stand');
    execFileSync(process.execPath, ['scripts/build.ts'], { cwd: workspace, encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const { resolveStateContext } = await import(pathToFileURL(join(workspace, 'src/state-migration-guard.ts')).href);
    const { openStateStore } = await import(pathToFileURL(join(workspace, 'src/state-store.ts')).href);
    const { sqliteTestRunState } = await import(pathToFileURL(join(workspace, 'src/test-run-runtime.ts')).href);
    const contextFor = (selectedHome: string) => resolveStateContext({ orchestratorRoot: root, modulePath: join(workspace, 'src/test-run-runtime.ts'), homeDirectory: selectedHome, operatingSystemHome: userInfo().homedir, environment: { ...environment, HOME: selectedHome, RAF_QA_HOME: selectedHome }, entryPoint: 'cli' });
    mkdirSync(unitHome, { recursive: true, mode: 0o700 });
    const controlContext = contextFor(home), unitContext = contextFor(unitHome);
    controlStatePath = controlContext.statePath; unitStatePath = unitContext.statePath;
    const control = openStateStore(controlStatePath, { context: controlContext }); controllerStore = control;
    const line = execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='], { encoding: 'utf8', env: { ...environment, LC_ALL: 'C' } }).trim();
    const match = line.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match) throw new Error('Cannot verify caller command');
    const assignment = { runId: callerRunId, agentId: callerId, type: 'qa', phase: 'qa', project: 'raf', workspace, branch: 'develop', changes: ['add-raf-test-run'] };
    control.sessionRepository.transaction((tx: any) => tx.putSession({ runId: callerRunId, addressId: callerId, revision: 1, state: 'running', activity: { type: 'qa', phase: 'qa', project: 'raf', cwd: workspace, features: [] }, process: { pid: process.pid, startedAt: new Date(match[1]).toISOString(), runner: 'main', runnerSessionId: callerId, tmuxSession: callerId, evidence: { command: match[2], machineId: readFileSync('/etc/machine-id', 'utf8').trim(), bootId: boot } }, launchContext: { testAssignment: assignment, assignment: { changes: [] } } }));
    const unit = openStateStore(unitStatePath, { context: unitContext }); unitStore = unit; state = sqliteTestRunState(unit);
    const key = { project: 'raf', workspace, group: groupId };
    await state.transaction(tx => tx.put({ key, testKind: input.testKind, profileId, timeoutCount: input.initialTimeoutCount, state: 'idle', selection: { files: [file], testIds: [] }, knownRed: [], unexecuted: [], unknown: [], inFlight: null, lastResult: null, delivery: null }));
    deadlineMs = Date.now() + flow.integrationTests.timeoutMs * 10;
    command = { executable: process.execPath, argv: [join(workspace, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', phase, '--group', groupId], cwd: workspace, env: environment };
    json(join(evidencePath, 'stand.json'), { sha, dirtyPaths, generation, source, command: { executable: command.executable, argv: command.argv, cwd: workspace }, controlStatePath, unitStatePath, configuredIntegrationBudgetMs: flow.integrationTests.timeoutMs, deadlineMs, injections: ['reservation published before protocol consumption', 'durable result before transport'], operationalStateOpened: false });
    const execute = async (argv = command.argv): Promise<HostExecution> => {
      const child = spawn(command.executable, argv, { cwd: workspace, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid) remember(identity(child.pid));
      let stdout = '', stderr = '', size = 0;
      const consume = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { child.kill('SIGKILL'); return; }
        if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      };
      child.stdout.on('data', consume('stdout')); child.stderr.on('data', consume('stderr'));
      const watchdog = setTimeout(() => { const row = child.pid && owned.get(child.pid); if (row && same(row)) process.kill(row.pid, 'SIGKILL'); }, Math.max(1, deadlineMs - Date.now()));
      const cliCode = await new Promise<number>((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => signal || code === null ? reject(new Error(`Stand CLI interrupted: ${signal}`)) : accept(code)); }).finally(() => clearTimeout(watchdog));
      const execution = { result: JSON.parse(stdout), stderr, cliCode, argv, cwd: workspace };
      const index = readdirSync(evidencePath).filter(name => name.endsWith('.stdout.json')).length;
      writeFileSync(join(evidencePath, `${index}.stdout.json`), stdout); writeFileSync(join(evidencePath, `${index}.stderr`), stderr); json(join(evidencePath, `${index}.execution.json`), execution);
      return execution;
    };
    let serial: Promise<unknown> = Promise.resolve();
    const reconcile = () => {
      const next = serial.then(() => execute());
      serial = next.catch(() => {}); return next;
    };
    return {
      command, deadlineMs, home, root, checkpointPath, childReleasePath, evidencePath,
      async snapshot() {
        track();
        const group = await state.transaction(tx => tx.get(key));
        if (!group) throw new Error('Original aggregate unavailable');
        const observations = read(metadata), saved = existsSync(originalPath) ? read(originalPath) : null;
        const liveTree = saved ? saved.tree.filter(same) : [];
        return { group: group as RecoveryGroup, originalRun: original!, controlStatePath, unitStatePath, wrapper: saved?.wrapper ?? null, tree: liveTree, caller: { agentId: callerId, runId: callerRunId, identity: controllerIdentity }, generation, sha, dirtyPaths, spawnCount: observations.spawnRuns.length, releaseCount: observations.releasedRuns.length };
      },
      reconcile,
      async normal(mode) {
        json(settings, { ...read(settings), mode: 'normal' });
        return execute(mode === 'refused' ? [...command.argv, '--only', file + '::unknown stand test'] : command.argv);
      },
      async restartRecipient() { json(settings, { ...read(settings), recipientGeneration: read(settings).recipientGeneration + 1 }); },
      async cleanupClosedChange() {
        const { cleanupClosedTestRunGroups } = await import(pathToFileURL(join(workspace, 'src/test-runs.ts')).href);
        await cleanupClosedTestRunGroups([], { workspace, projectWorkspaces: { raf: [workspace] } }, { state });
      },
      async setMainAvailability(availability) { json(settings, { ...read(settings), availability }); },
      async markExitTimeUnknown() { await state.transaction(tx => { const group = tx.get(key); if (group?.inFlight) { group.inFlight.finishedAtMs = null; tx.put(group); } }); },
      async awaitTreeExit() { track(); await wait(() => [...owned.values()].every(row => !same(row)), 'original tree exit'); },
      async awaitOriginalDeadline() { track(); if (!original) throw new Error('Original reservation unavailable'); await wait(() => Date.now() > original!.deadlineMs, 'original deadline'); },
      finish,
    };
  } catch (error) {
    deadlineMs ||= Date.now() + budget * 10;
    try { await finish(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Stand preparation and cleanup failed'); }
    throw error;
  }
}
