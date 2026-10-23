import { spawn, execFileSync } from 'node:child_process';
import { constants, accessSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { productionStateContext, stateContextEnvironment, canonicalStatePath, type StateContext } from './state-migration-guard.ts';
import { openStateStore } from './state-store.ts';
import { loadFlowPolicy } from './flow-policy.ts';
import { parseTestRunArgs, validateTestRunConfig, cleanupClosedTestRunGroups } from './test-runs.ts';
import { runTestRunCli } from './test-run-cli.ts';
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
function processGroup(pgid: number): number[] {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try { const raw = readFileSync(`/proc/${name}/stat`, 'utf8'); const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' '); return Number(fields[2]) === pgid && fields[0] !== 'Z' ? [Number(name)] : []; } catch { return []; }
  });
}
async function cleanGroup(pid: number): Promise<{ complete: boolean; remainingPids: number[] }> {
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return { complete: false, remainingPids: processGroup(pid) }; }
  await new Promise<void>(done => setImmediate(done));
  const remainingPids = processGroup(pid);
  return { complete: remainingPids.length === 0, remainingPids };
}
function executableAvailable(executable: string, cwd: string): boolean {
  const paths = isAbsolute(executable) ? [executable] : executable.includes('/') ? [resolve(cwd, executable)] : (process.env.PATH ?? '').split(':').map(path => join(path, executable));
  return paths.some(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}
function checkChannel(context: StateContext): boolean {
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !/^RAF_/.test(key)) continue;
    if (/STATE_DIRECTORY|SOCKET_PATH|HOME_DIRECTORY/.test(key) && !within(canonicalStatePath(value), context.homeDirectory)) return true;
    if (/COMMAND_(ACCESS|CHANNEL)|CONTROL_CHANNEL/.test(key)) return true;
  }
  return false;
}

export function createTestRunPorts(config: TestRunConfig, stateContext: StateContext, getStore: () => StateStore): TestRunPorts {
  let state: TestRunStatePort | undefined;
  const environment = stateContextEnvironment(stateContext, process.env);
  const ports: TestRunPorts = {
    state: { transaction: action => (state ??= sqliteTestRunState(getStore())).transaction(action) },
    clock: { now: Date.now, schedule: (deadline, callback) => { const timer = setTimeout(callback, Math.max(0, deadline - Date.now())); return () => clearTimeout(timer); } },
    newRunId: randomUUID,
    preflight: async context => {
      const profiles = Object.values(config.projects[Object.keys(context.projectWorkspaces).find(project => context.projectWorkspaces[project].includes(context.workspace)) ?? '']?.profiles ?? {});
      const files: TestRunEnvironment['files'] = {};
      const unitFiles = [...new Set(profiles.flatMap(profile => profile.unitFiles))];
      for (const file of unitFiles) {
        try { const actual = realpathSync(resolve(context.cwd, file)); files[file] = { kind: statSync(actual).isDirectory() ? 'directory' : 'file', realpath: actual, unit: true }; } catch { }
      }
      let gitIdentityMatches = false;
      try { gitIdentityMatches = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: context.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) === context.workspace; } catch { }
      const inheritedOperationalChannel = checkChannel(stateContext);
      if (!inheritedOperationalChannel) mkdirSync(stateContext.tmpRoot, { recursive: true });
      return { canonicalWorkspace: realpathSync(context.workspace), canonicalCwd: realpathSync(context.cwd), gitIdentityMatches,
        runtimeAvailable: profiles.every(p => executableAvailable(p.executable, context.cwd)),
        localRunnerAvailable: profiles.every(p => p.resultAdapter === 'node-test-events'),
        dependenciesAvailable: profiles.every(p => p.checks.every(path => existsSync(resolve(context.cwd, path)))),
        resultAdapterAvailable: existsSync(fileURLToPath(new URL('./test-run-reporter.ts', import.meta.url))),
        artifactsWritable: !inheritedOperationalChannel && (() => { try { accessSync(stateContext.tmpRoot, constants.W_OK); return true; } catch { return false; } })(),
        treeControlSupported: process.platform === 'linux' && existsSync('/proc/self/stat'), isolatedHome: stateContext.mode === 'qa', stateOriginAllowed: true,
        stateAliasesOperational: within(context.statePath, join(context.operationalHome, '.raf')), tmpAliasesOperational: within(context.tmpPath, join(context.operationalHome, '.raf')),
        inheritedOperationalChannel, unitFiles, files };
    },
    spawn: async (command, onEvent): Promise<ManagedTestProcess> => {
      const child = spawn(command.executable, command.argv, { cwd: command.cwd, env: environment, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
      const pid = child.pid!;
      const identity = JSON.stringify({ pid, start: processStart(pid), boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
      let buffer = '', protocolBad = false, stderr = '';
      const consume = (line: string) => {
        try {
          const event = JSON.parse(line);
          if (!event || !['passed', 'assertion-failed', 'setup-failed', 'complete', 'protocol-error'].includes(event.kind) ||
              event.kind === 'complete' && (!Array.isArray(event.expected) || event.expected.some((id: any) => typeof id?.file !== 'string' || typeof id?.name !== 'string')) ||
              ['passed', 'assertion-failed', 'setup-failed'].includes(event.kind) && (typeof event.test?.file !== 'string' || typeof event.test?.name !== 'string')) throw new Error('Invalid runner event');
          onEvent(event as RunnerEvent);
        } catch { if (!protocolBad) onEvent({ kind: 'protocol-error', diagnostic: 'Invalid JSON runner protocol' }); protocolBad = true; }
      };
      child.stdout!.on('data', chunk => { buffer += chunk.toString(); let newline: number; while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); } });
      child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
      const waited = new Promise<ChildExit>(done => child.once('close', (exitCode, signal) => { if (buffer.length) { onEvent({ kind: 'protocol-error', diagnostic: 'Truncated JSON runner protocol' }); } done({ exitCode, signal, stderr }); }));
      return { identity, wait: () => waited, cleanup: async () => { const cleaned = await cleanGroup(pid); await waited; return cleaned; } };
    },
    subscribeInterruption: callback => {
      const term = () => callback('SIGTERM'), int = () => callback('SIGINT');
      process.on('SIGTERM', term); process.on('SIGINT', int);
      return () => { process.off('SIGTERM', term); process.off('SIGINT', int); };
    },
    reconcile: async (identity, deadline) => {
      if (!identity) return { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: [] } };
      const processId = JSON.parse(identity);
      const sameBoot = processId.boot === readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const alive = sameBoot && processStart(processId.pid) === processId.start;
      if (!alive) return { alive: false, deadlineReached: false, cleanup: { complete: !sameBoot || processGroup(processId.pid).length === 0, remainingPids: sameBoot ? processGroup(processId.pid) : [] } };
      if (Date.now() < deadline) return { alive: true, deadlineReached: false, cleanup: { complete: false, remainingPids: processGroup(processId.pid) } };
      const cleanup = await cleanGroup(processId.pid);
      return { alive: !cleanup.complete, deadlineReached: true, cleanup };
    },
  };
  return ports;
}

export async function runConfiguredTestRun(argv: readonly string[], options: { orchestratorRoot: string; homeDirectory: string }): Promise<ExecutionResult> {
  let store: StateStore | undefined, stdout = '', stderr = '';
  try {
    const args = parseTestRunArgs(argv);
    const root = realpathSync(options.orchestratorRoot);
    const read = (file: string) => JSON.parse(readFileSync(join(root, 'conf', file), 'utf8'));
    const constants = read('raf-constants.json');
    const policy = loadFlowPolicy(join(root, 'conf/flow.json')).unitTests;
    const phases = constants.agentPhases.map((p: any) => p.id);
    const config = validateTestRunConfig(read('test-runs.json'), phases, policy);
    const projects = read('projects.json').projects;
    const cwd = realpathSync(process.cwd());
    const workspaces: Record<string, string[]> = {};
    for (const [id, project] of Object.entries(projects) as [string, any][]) workspaces[id] = [...new Set<string>(Object.values(project.branchPaths ?? { main: project.path }).map(path => resolve(root, String(path))))];
    const workspace = workspaces[args.project]?.find(path => within(cwd, path));
    if (!workspace) throw Object.assign(new Error('cwd is outside the registered project'), { code: 'WORKSPACE_MISMATCH' });
    if (!phases.includes(args.phase) || !config.phases[args.phase]?.allowed) throw Object.assign(new Error('Phase does not permit test execution'), { code: 'PHASE_NOT_ALLOWED' });
    const stateContext = productionStateContext(root, fileURLToPath(import.meta.url), options.homeDirectory, 'cli');
    const context: TestRunContext = { cwd, workspace, projectWorkspaces: workspaces, agentPhases: phases,
      activeChanges: readdirSync(join(root, 'openspec/changes'), { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'archive').map(entry => entry.name),
      agentId: 'test-run', sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
      home: stateContext.homeDirectory, statePath: stateContext.statePath, tmpPath: stateContext.tmpRoot, operationalHome: userInfo().homedir };
    const runtime = createTestRunPorts(config, stateContext, () => store ??= openStateStore(stateContext.statePath, { context: stateContext }));
    const exitCode = await runTestRunCli(argv, { config, policy, context, runtime, stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    if (store) await cleanupClosedTestRunGroups(context.activeChanges, context, runtime);
    return { exitCode, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: JSON.stringify({ outcome: 'setup-failed', failureKinds: ['setup'], errorCode: (error as any)?.code ?? 'CONFIGURATION_INVALID', reason: error instanceof Error ? error.message : String(error), exitCode: null }) };
  } finally { store?.close(); }
}
