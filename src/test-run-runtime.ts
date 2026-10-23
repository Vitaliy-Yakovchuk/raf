import { mkdtempSync, rmSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { TestRunDiagnostics, buildDiagnosticEnvironment, prepareRunTemporaryDirectory, cleanupRunTemporaryDirectory } from './test-run-diagnostics.ts';
import type { RunTemporaryPorts, RunTemporaryReservation } from './test-run-diagnostics.ts';
import { spawn, execFileSync } from 'node:child_process';
import { constants, accessSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { runSandboxTestCommand } from './sandbox-test-run.ts';
import { sandboxTestControlSnapshot } from './production-runtime.ts';
import { productionStateContext, stateContextEnvironment, canonicalStatePath, type StateContext } from './state-migration-guard.ts';
import { openStateStore } from './state-store.ts';
import { loadFlowPolicy } from './flow-policy.ts';
import { parseTestRunArgs, validateTestRunConfig, cleanupClosedTestRunGroups, reconcileTestRunGroup, testRunFailureResult } from './test-runs.ts';
import { cleanupTestProcessGroup, reconcileTestRunProcess } from './test-run-processes.ts';
import type { ChildExit, ManagedTestProcess, RunnerEvent, TestRunConfig, TestRunContext, TestRunEnvironment, TestRunGroup, TestRunGroupKey, TestRunPorts, TestRunStatePort, TestRunTransaction } from './test-runs.ts';
import type { ExecutionResult } from './cli.ts';
import type { StateStore } from './state-store.ts';

const keyArgs = (key: TestRunGroupKey) => [key.project, key.workspace, key.group];
export function sqliteTestRunState(store: StateStore): TestRunStatePort {
  const db = store.startupContextDatabase;
  return { transaction: async operation => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const tx: TestRunTransaction = {
        get: key => { const row = db.prepare('SELECT payload FROM test_run_groups WHERE project = ? AND workspace = ? AND group_id = ?').get(...keyArgs(key)); return row ? JSON.parse(String(row.payload)) : null; },
        list: (project, workspace) => db.prepare('SELECT payload FROM test_run_groups WHERE (? = \'\' OR project = ?) AND workspace = ?').all(project, project, workspace).map(row => JSON.parse(String(row.payload))),
        put: group => { db.prepare('INSERT INTO test_run_groups (project, workspace, group_id, payload) VALUES (?, ?, ?, ?) ON CONFLICT(project, workspace, group_id) DO UPDATE SET payload = excluded.payload').run(...keyArgs(group.key), JSON.stringify(group)); },
        delete: key => { db.prepare('DELETE FROM test_run_groups WHERE project = ? AND workspace = ? AND group_id = ?').run(...keyArgs(key)); },
      };
      const result = operation(tx);
      if (result && typeof (result as any).then === 'function') throw new Error('Test run transactions must be synchronous');
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
function processStart(pid: number): string | null {
  try { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' '); return fields[0] === 'Z' ? null : fields[19]; } catch { return null; }
}
function processTree(pgid: number): { pid: number; start: string }[] {
  const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try { const raw = readFileSync(`/proc/${name}/stat`, 'utf8'); const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' '); return fields[0] === 'Z' ? [] : [{ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] }]; } catch { return []; }
  });
  const owned = new Set([pgid, ...rows.filter(row => row.pgid === pgid).map(row => row.pid)]);
  for (let size = -1; size !== owned.size;) { size = owned.size; for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid); }
  return rows.filter(row => owned.has(row.pid));
}

async function settleKilledProcesses(signalled: { pid: number; start: string }[]): Promise<void> {
  for (const row of signalled) while (processStart(row.pid) === row.start) {
    try {
      const raw = readFileSync(`/proc/${row.pid}/stat`, 'utf8');
      if (raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0] === 'D') break;
    } catch { break; }
    await new Promise<void>(done => setTimeout(done));
  }
}

async function cleanGroup(pid: number): Promise<{ complete: boolean; remainingPids: number[] }> {
  return cleanupTestProcessGroup(pid, { tree: processTree, start: processStart, kill: target => process.kill(target, 'SIGKILL'), settle: (_root, signalled) => settleKilledProcesses(signalled) });
}

function executableAvailable(executable: string, cwd: string): boolean {
  const paths = isAbsolute(executable) ? [executable] : executable.includes('/') ? [resolve(cwd, executable)] : (process.env.PATH ?? '').split(':').map(path => join(path, executable));
  return paths.some(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}
function checkChannel(context: StateContext, inherited: Readonly<Record<string, string | undefined>>): boolean {
  for (const [key, value] of Object.entries(inherited)) {
    if (!value || !/^RAF_/.test(key)) continue;
    if (/STATE_DIRECTORY|SOCKET_PATH|HOME_DIRECTORY/.test(key) && !within(canonicalStatePath(value), context.homeDirectory)) return true;
    if (/COMMAND_(ACCESS|CHANNEL)|CONTROL_CHANNEL/.test(key)) return true;
  }
  return false;
}

export function createTestRunPorts(config: TestRunConfig, stateContext: StateContext, getStore: () => StateStore, inherited: Readonly<Record<string, string | undefined>> = process.env): TestRunPorts {
  let state: TestRunStatePort | undefined;
  const environment = stateContextEnvironment(stateContext, inherited);
  const temporaryPorts: RunTemporaryPorts = {
    socketPathCapacityBytes: () => process.platform === 'linux' ? 108 : 104,
    inspect: async path => { try { const st = lstatSync(path); return { path, realpath: realpathSync(path), device: String(st.dev), inode: String(st.ino), uid: st.uid, mode: st.mode, symlink: st.isSymbolicLink() }; } catch (e) { if ((e as any).code === 'ENOENT') return null; throw e; } },
    createPrivateDirectory: async root => { const path = mkdtempSync(join(root, 'r-')); return (await temporaryPorts.inspect(path))!; },
    saveReservation: async () => { throw new Error('Reservation writer unavailable'); },
    removeOwnedDirectory: async identity => { const actual = await temporaryPorts.inspect(identity.path); if (!actual || ['device', 'inode', 'uid', 'realpath'].some(key => (actual as any)[key] !== (identity as any)[key]) || actual.symlink) throw new Error('Temporary identity changed'); rmSync(identity.path, { recursive: true }); },
  };
  const ports: TestRunPorts = {
    diagnosticEnvironment: command => {
      const root = fileURLToPath(new URL('../../', import.meta.url));
      const read = (name: string) => readFileSync(join(root, 'conf', name));
      const profile = Object.values(config.projects).flatMap(p => Object.values(p.profiles)).find(p => p.executable === command?.executable);
      return buildDiagnosticEnvironment({ executable: command?.executable ?? process.execPath, runtimeVersion: process.version, adapter: profile?.resultAdapter ?? 'node-test-events', isolation: command?.argv.find(a => a.startsWith('--test-isolation='))?.split('=')[1] ?? 'process', configurationBytes: { flow: read('flow.json'), testRuns: read('test-runs.json'), projects: read('projects.json') }, tmpPath: command?.environment.TMPDIR ?? stateContext.tmpRoot, privateRunTmp: !!command?.environment.TMPDIR });
    },
    prepareTemporary: (runId, context, save) => prepareRunTemporaryDirectory(config.temporaryArtifacts, { runId, uid: process.getuid!(), qaHome: context.home, statePath: context.statePath, stateTmpPath: context.tmpPath, workspace: context.workspace, workingStatePath: join(context.operationalHome, '.raf') }, { ...temporaryPorts, saveReservation: save }).then(p => p.reservation),
    cleanupTemporary: (reservation, terminated) => cleanupRunTemporaryDirectory(reservation, terminated, temporaryPorts),
    state: { transaction: action => (state ??= sqliteTestRunState(getStore())).transaction(action) },
    clock: { now: Date.now, schedule: (deadline, callback) => { const timer = setTimeout(callback, Math.max(0, deadline - Date.now())); return () => clearTimeout(timer); } },
    newRunId: randomUUID,
    preflight: async context => {
      const profiles = Object.values(config.projects[Object.keys(context.projectWorkspaces).find(project => context.projectWorkspaces[project].includes(context.workspace)) ?? '']?.profiles ?? {});
      const files: TestRunEnvironment['files'] = {};
      const unitFiles = [...new Set(profiles.flatMap(profile => profile.unitFiles))];
      for (const profile of profiles) for (const file of profile.unitFiles) {
        try { const actual = realpathSync(resolve(context.workspace, profile.cwd, file)); files[file] = { kind: statSync(actual).isDirectory() ? 'directory' : 'file', realpath: actual, unit: true }; } catch { }
      }
      let gitIdentityMatches = false;
      try { gitIdentityMatches = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: context.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) === context.workspace; } catch { }
      const inheritedOperationalChannel = checkChannel(stateContext, inherited);
      if (!inheritedOperationalChannel) mkdirSync(stateContext.tmpRoot, { recursive: true });
      return { canonicalWorkspace: realpathSync(context.workspace), canonicalCwd: realpathSync(context.cwd), gitIdentityMatches,
        runtimeAvailable: profiles.every(p => executableAvailable(p.executable, resolve(context.workspace, p.cwd))),
        localRunnerAvailable: profiles.every(p => p.resultAdapter === 'node-test-events'),
        dependenciesAvailable: profiles.every(p => p.checks.every(path => existsSync(resolve(context.workspace, p.cwd, path)))),
        resultAdapterAvailable: existsSync(fileURLToPath(new URL('./test-run-reporter.ts', import.meta.url))),
        artifactsWritable: !inheritedOperationalChannel && (() => { try { accessSync(stateContext.tmpRoot, constants.W_OK); return true; } catch { return false; } })(),
        treeControlSupported: process.platform === 'linux' && existsSync('/proc/self/stat'), isolatedHome: stateContext.mode === 'qa', stateOriginAllowed: true,
        stateAliasesOperational: within(context.statePath, join(context.operationalHome, '.raf')), tmpAliasesOperational: within(context.tmpPath, join(context.operationalHome, '.raf')),
        inheritedOperationalChannel, unitFiles: unitFiles.filter(file => files[file]?.kind === 'file'), files };
    },
    spawn: async (command, onEvent): Promise<ManagedTestProcess> => {
      const child = spawn(command.executable, command.argv, { cwd: command.cwd, env: { ...environment, TMPDIR: command.environment.TMPDIR, RAF_TEST_RUN_IDS: JSON.stringify(command.environment.testIds ?? []) }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
      const pid = child.pid!;
      const exited = new Promise<void>(done => child.once('exit', () => done()));
      const identity = JSON.stringify({ pid, start: processStart(pid), boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
      let buffer = '', protocolBad = false, stderr = '', discarding = false;
      const decoder = new StringDecoder('utf8');
      const readDiagnostics = new TestRunDiagnostics(config.diagnostics, { workspace: command.cwd, qaHome: stateContext.homeDirectory, fixtureRoots: command.environment.TMPDIR ? [command.environment.TMPDIR] : [] });
      const consume = (line: string) => {
        try {
          const event = JSON.parse(line);
          if (!event || !['discovered', 'container-complete', 'passed', 'assertion-failed', 'setup-failed', 'complete', 'protocol-error'].includes(event.kind) ||
              event.kind === 'complete' && (!Array.isArray(event.expected) || event.expected.some((id: any) => typeof id?.file !== 'string' || typeof id?.name !== 'string')) ||
              ['discovered', 'container-complete', 'passed', 'assertion-failed', 'setup-failed'].includes(event.kind) && (typeof event.test?.file !== 'string' || typeof event.test?.name !== 'string') ||
              event.parent !== undefined && (typeof event.parent?.file !== 'string' || typeof event.parent?.name !== 'string')) throw new Error('Invalid runner event');
          onEvent(event as RunnerEvent);
        } catch { if (!protocolBad) onEvent({ kind: 'protocol-error', diagnostic: 'Invalid JSON runner protocol' }); protocolBad = true; }
      };
      child.stdout!.on('data', chunk => {
        for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
          if (discarding) { if (part.endsWith('\n')) discarding = false; continue; }
          if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > config.diagnostics.maxProtocolLineBytes) { if (!protocolBad) onEvent({ kind: 'protocol-error', diagnostic: 'Runner protocol line exceeds configured limit' }); protocolBad = true; buffer = ''; discarding = !part.endsWith('\n'); continue; }
          buffer += part;
          if (part.endsWith('\n')) { consume(buffer); buffer = ''; }
        }
      });
      child.stderr!.on('data', chunk => { readDiagnostics.stderrChunk(chunk); const available = config.diagnostics.maxStderrBytes - Buffer.byteLength(stderr); if (available > 0) stderr += Buffer.from(chunk).subarray(0, available).toString('utf8'); });
      const waited = new Promise<ChildExit>(done => child.once('close', (exitCode, signal) => { if (buffer.length) { onEvent({ kind: 'protocol-error', diagnostic: 'Truncated JSON runner protocol' }); } readDiagnostics.childExit({ exitCode, signal, validProtocol: !protocolBad });
        const details = readDiagnostics.attach({ runId: '', outcome: '', failureKinds: [], knownRed: [], unexecuted: [], unknown: [], timeoutCount: 0, timedOut: false, cleanup: '', evidence: [] }, {} as any);
        done({ exitCode, signal, stderr }); }));
      return { identity, wait: () => waited, cleanup: async (_deadline, reason) => {
        const cleaned = await cleanupTestProcessGroup(pid, {
          tree: processTree, start: processStart, kill: target => process.kill(target, 'SIGKILL'),
          settle: async (_rootSignalled, signalled) => {
            await settleKilledProcesses(signalled);
            if (processStart(pid) === null) await exited;
          },
        });
        if (reason !== 'exit') { child.stdout!.destroy(); child.stderr!.destroy(); }
        return cleaned;
      } };
    },
    subscribeInterruption: callback => {
      const term = () => callback('SIGTERM'), int = () => callback('SIGINT');
      process.on('SIGTERM', term); process.on('SIGINT', int);
      return () => { process.off('SIGTERM', term); process.off('SIGINT', int); };
    },
    reconcile: (identity, deadline) => reconcileTestRunProcess(identity, deadline, {
      now: Date.now, boot: () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      start: processStart, tree: processTree, cleanup: cleanGroup,
    }),
  };
  return ports;
}

export async function runConfiguredTestRun(argv: readonly string[], options: { orchestratorRoot: string; homeDirectory: string }): Promise<ExecutionResult> {
  let store: StateStore | undefined, controlStore: StateStore | undefined;
  let config: TestRunConfig | undefined;
  let context: TestRunContext = { cwd: process.cwd(), workspace: '', projectWorkspaces: {}, agentPhases: [], activeChanges: [], agentId: 'test-run', sha: '', home: options.homeDirectory, statePath: '', tmpPath: '', operationalHome: userInfo().homedir };
  const value = (option: string) => { const index = argv.indexOf(option); return index >= 0 ? argv[index + 1] ?? '' : ''; };
  let request = { project: value('--project'), phase: value('--phase'), group: value('--group') };
  try {
    const root = realpathSync(options.orchestratorRoot);
    const read = (file: string) => JSON.parse(readFileSync(join(root, 'conf', file), 'utf8'));
    const constants = read('raf-constants.json');
    const policy = loadFlowPolicy(join(root, 'conf/flow.json')).unitTests;
    const phases = constants.agentPhases.map((p: any) => p.id);
    config = validateTestRunConfig(read('test-runs.json'), phases, policy);
    const args = parseTestRunArgs(argv);
    request = { project: args.project, phase: args.phase, group: args.group };
    const projects = read('projects.json').projects;
    const cwd = realpathSync(process.cwd());
    const workspaces: Record<string, string[]> = {};
    for (const [id, project] of Object.entries(projects) as [string, any][]) workspaces[id] = [...new Set<string>(Object.values(project.branchPaths ?? { main: project.path }).map(path => resolve(root, String(path))))];
    const workspace = workspaces[args.project]?.find(path => within(cwd, path));
    if (!workspace) throw Object.assign(new Error('cwd is outside the registered project'), { code: 'WORKSPACE_MISMATCH' });
    context = { ...context, cwd, workspace, projectWorkspaces: workspaces, agentPhases: phases };
    if (!phases.includes(args.phase) || !config.phases[args.phase]?.allowed) throw Object.assign(new Error('Phase does not permit test execution'), { code: 'PHASE_NOT_ALLOWED' });
    const controlContext = productionStateContext(root, fileURLToPath(import.meta.url), options.homeDirectory, 'cli');
    controlStore = openStateStore(controlContext.statePath, { context: controlContext });
    const control = await sandboxTestControlSnapshot(controlStore, root, args.project, args.group);
    controlStore.close(); controlStore = undefined;
    const caller = control.ancestors.find(row => row.pid === process.pid);
    if (!caller) throw Object.assign(new Error('Current caller identity is unavailable'), { code: 'CALLER_UNVERIFIED' });
    const entrypoint = [process.execPath, realpathSync(fileURLToPath(new URL('../bin/raf.ts', import.meta.url)))];
    const literal = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
    let runtime: TestRunPorts | undefined;
    const reply = await runSandboxTestCommand({ command: [...entrypoint, 'test', 'run', ...argv].map(literal).join(' '), cwd }, {
      caller, entrypoint, control: async () => control,
      communicate: async () => { throw new Error('Unexpected communication request in the test entrypoint'); },
      unitContext: async key => {
        const owner = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`);
        mkdirSync(owner, { recursive: true, mode: 0o700 });
        const identity = lstatSync(owner);
        if (realpathSync(owner) !== owner || !identity.isDirectory() || identity.uid !== process.getuid?.() || (identity.mode & 0o077) !== 0) throw Object.assign(new Error('Unit HOME root is not private or has aliases'), { code: 'STATE_CONTEXT_REFUSED' });
        const home = join(owner, createHash('sha256').update(JSON.stringify([root, key.project, key.workspace])).digest('hex'));
        const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'LANG', 'TZ', 'SYSTEMROOT'].includes(name) || name.startsWith('LC_')));
        const unitEnvironment = { ...inherited, HOME: home, RAF_QA_HOME: home };
        const stateContext = productionStateContext(root, fileURLToPath(import.meta.url), home, 'cli', unitEnvironment);
        if (within(stateContext.homeDirectory, controlContext.homeDirectory) || within(controlContext.homeDirectory, stateContext.homeDirectory)) throw Object.assign(new Error('Unit HOME overlaps the control context'), { code: 'STATE_CONTEXT_REFUSED' });
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const homeIdentity = lstatSync(home);
        if (!homeIdentity.isDirectory() || homeIdentity.uid !== process.getuid?.() || (homeIdentity.mode & 0o077) !== 0) throw Object.assign(new Error('Unit HOME is not private'), { code: 'STATE_CONTEXT_REFUSED' });
        context = { cwd, workspace, projectWorkspaces: workspaces, agentPhases: phases, activeChanges: [...control.activeChanges],
          agentId: 'test-run', sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
          home, statePath: stateContext.statePath, tmpPath: stateContext.tmpRoot, operationalHome: userInfo().homedir };
        runtime = createTestRunPorts(config!, stateContext, () => store ??= openStateStore(stateContext.statePath, { context: stateContext }), { ...unitEnvironment, TMPDIR: stateContext.tmpRoot });
        return { config, policy, context, runtime };
      },
    });
    if (!reply.stdout) throw Object.assign(new Error(reply.stderr), { code: 'CALLER_UNAUTHORIZED' });
    if (store && runtime) {
      if (JSON.parse(reply.stdout).errorCode === 'GROUP_IN_FLIGHT') await reconcileTestRunGroup({ project: args.project, workspace, group: args.group }, policy, context, runtime);
      await cleanupClosedTestRunGroups(context.activeChanges, context, runtime);
    }
    return { exitCode: reply.code, stdout: reply.stdout.trimEnd(), stderr: reply.stderr.trimEnd() };
  } catch (error) {
    const result = testRunFailureResult(request, context, randomUUID(), Date.now(), config, error);
    if (!config || ['STATE_CONTEXT_REFUSED', 'STATE_SCHEMA_MISMATCH', 'HANDLER_FAILED'].includes(result.errorCode!)) {
      result.outcome = 'setup-failed'; result.failureKinds = ['setup'];
      const hintId = config?.phases[result.phase]?.hints.setup;
      result.hintIds = hintId ? [hintId] : []; result.hints = hintId ? [config!.hints[hintId]] : [];
    }
    return { exitCode: 1, stdout: JSON.stringify(result), stderr: '' };
  } finally { store?.close(); controlStore?.close(); }
}
