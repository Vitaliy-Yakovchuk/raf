import { readGitHead } from './git.ts';
import { createServer } from 'node:net';
import { prepareEtchlyIntegrationEnvironment } from './test-run-etchly-integration.ts';
import { testRunConfigurationManifest, captureTestRunConfiguration, assertTestRunConfigurationUnchanged } from './test-run-config-dependencies.ts';
import type { TestRunConfigurationReader, TestRunConfigurationFile, TestRunConfigurationSnapshot } from './test-run-config-dependencies.ts';
import { RafCostRuntime, rafCostBoundary, type RafCostBoundary } from './raf-cost-runtime.ts';
import { RunnerProtocol } from './test-run-protocol.ts';
import { isDeepStrictEqual } from 'node:util';
import { resolveSandboxTestCaller } from './sandbox-test-caller.ts';
import { createTestRunQueuePort } from './test-run-queue-runtime.ts';
import { acknowledgeTestRunDelivery, recoverTestRun, releaseRecoveredTestRunClaims, stateOpenFailure } from './test-run-state-recovery.ts';
import type { RecoveryStatePort } from './test-run-state-recovery.ts';
import { observeReservedTestTree } from './test-run-resource-process.ts';
import { profileFiles, profileTestKind, testRunTimeoutPolicy } from './test-run-integration-profiles.ts';
import { testWrapperIdentity } from './test-run-resource-process.ts';
import { createTestRunResourcePort } from './test-run-resource-runtime.ts';
import { reconcileTestRunResources } from './test-run-reservations.ts';
import { readMachineBootIdentity } from './os-runtime.ts';
import { etchlyBrowserRequirements, observeEtchlyInventory } from './test-run-etchly-inventory.ts';
import { planVitestInvocations, prepareEtchlyEnvironment } from './test-run-etchly.ts';
import { mkdtempSync, rmSync, writeFileSync, openSync, closeSync, fstatSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { TestRunDiagnostics, buildDiagnosticEnvironment, prepareRunTemporaryDirectory, cleanupRunTemporaryDirectory } from './test-run-diagnostics.ts';
import type { RunTemporaryPorts, DiagnosticEnvironmentInput } from './test-run-diagnostics.ts';
import { spawn } from 'node:child_process';
import { constants, accessSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { runSandboxTestCommand } from './sandbox-test-run.ts';
import { sandboxTestControlSnapshot } from './production-runtime.ts';
import { productionStateContext, stateContextEnvironment, canonicalStatePath, type StateContext } from './state-migration-guard.ts';
import { openStateStore } from './state-store.ts';
import { prepareUnitTestState } from './test-run-unit-state.ts';
import { loadFlowPolicy } from './flow-policy.ts';
import { planTestRun, parseTestRunArgs, validateTestRunConfig, cleanupClosedTestRunGroups, testRunFailureResult } from './test-runs.ts';
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

export function verifyEtchlyDependencies(context: TestRunContext, profiles: import('./test-runs.ts').TestRunProfile[], files: string[], inherited: Readonly<Record<string, string | undefined>>): void {
  const projects = JSON.parse(readFileSync(join(dirname(context.workspace), 'conf/projects.json'), 'utf8'));
  const entries = Object.entries(projects.projects.etchly.branchPaths) as [string, string][];
  const branch = entries.find(([, path]) => resolve(dirname(context.workspace), path) === context.workspace)?.[0];
  const libraryPath = projects.projects['shared-libs']?.branchPaths?.[branch ?? ''];
  const expected = libraryPath ? resolve(dirname(context.workspace), libraryPath) : '';
  let actual: string | null = null;
  try { actual = realpathSync(join(context.workspace, 'shared-libs')); } catch { }
  const has = (file: string) => existsSync(resolve(context.workspace, file));
  const browserEngines = etchlyBrowserRequirements(context.workspace, files);
  const browserCache = inherited.PLAYWRIGHT_BROWSERS_PATH;
  const browserAvailable = !!browserCache && browserCache !== '0' && isAbsolute(browserCache) && browserEngines.every(engine => {
    try {
      return globSync(engine === 'chromium' ? ['chromium-*/**/chrome', 'chromium_headless_shell-*/**/headless_shell', 'chromium_headless_shell-*/**/chrome-headless-shell'] : engine === 'firefox' ? ['firefox-*/**/firefox'] : ['webkit-*/**/pw_run.sh'], { cwd: browserCache }).some(path => {
        try { accessSync(resolve(browserCache, path), constants.X_OK); return statSync(resolve(browserCache, path)).isFile(); } catch { return false; }
      });
    } catch { return false; }
  });
  const vitestVersion = has('node_modules/vitest/package.json') ? JSON.parse(readFileSync(resolve(context.workspace, 'node_modules/vitest/package.json'), 'utf8')).version : '';
  const usesVitest = profiles.some(p => p.resultAdapter === 'vitest-events');
  prepareEtchlyEnvironment({ workspace: context.workspace, branch: branch ?? '', expectedLibrary: expected, actualLibrary: actual,
    nodeAvailable: profiles.every(p => executableAvailable(p.executable, context.workspace)), vitestAvailable: !usesVitest || has('node_modules/vitest/vitest.mjs'), adapterCompatible: !usesVitest || /^4\./.test(vitestVersion),
    preloadAvailable: has('scripts/shared-library-runtime.mjs'), aliasesAvailable: has('scripts/shared-library-aliases.ts') && has('scripts/shared-libs-path.mjs'), configAvailable: profiles.filter(p => p.resultAdapter === 'vitest-events').every(p => has(p.cwd + '/vitest.config.ts')),
    happyDomRequired: profiles.some(p => p.checks.includes('node_modules/happy-dom/package.json')), happyDomAvailable: has('node_modules/happy-dom/package.json'), isolatedHome: context.home !== context.operationalHome, stateOrigin: true, privateTmpWritable: true,
    browserRequired: browserEngines.length > 0, trustedBrowserCache: browserCache ?? null, requestedBrowserCache: browserCache ?? null, browserAvailable,
  }, { home: context.home, tmp: context.tmpPath });
}

export async function verifyEtchlyD1Dependencies(context: TestRunContext, profiles: import('./test-runs.ts').TestRunProfile[]): Promise<void> {
  const problems: string[] = [];
  for (const profile of profiles.filter(profile => profile.testKind === 'integration')) {
    for (const file of profile.checks) if (!existsSync(resolve(context.workspace, file))) problems.push(file);
  }
  for (const file of ['node_modules/workerd/bin/workerd', 'node_modules/esbuild/bin/esbuild']) {
    if (!executableAvailable(resolve(context.workspace, file), context.workspace)) problems.push(`executable ${file}`);
  }
  const library = resolve(context.workspace, 'shared-libs/resource-protocol');
  if (!existsSync(join(library, 'node_modules')) || !existsSync(join(library, 'node_modules/@resource-protocol'))) problems.push('shared-libs/resource-protocol/node_modules');
  const index = resolve(context.workspace, 'app/dist/local/index.html');
  try {
    if (realpathSync(index) !== index || !statSync(index).isFile() || !statSync(index).size || readFileSync(index, 'utf8').includes('href="/favicon-dev1.svg"')) problems.push('app/dist/local/index.html (local environment build required)');
  } catch { problems.push('app/dist/local/index.html (prepare local build before integration)'); }
  if (problems.length) throw Object.assign(new Error(`Etchly D1 setup: ${problems.join(', ')}; prepare local dependencies/build without install or hidden build in the runner`), { code: 'ENVIRONMENT_INVALID' });
  await new Promise<void>((done, fail) => {
    const server = createServer();
    server.once('error', error => fail(Object.assign(new Error(`Etchly D1 setup: local loopback unavailable: ${error.message}`), { code: 'ENVIRONMENT_INVALID' })));
    server.listen(0, '127.0.0.1', () => server.close(error => error ? fail(error) : done()));
  });
}

export function createTestRunPorts(config: TestRunConfig, stateContext: StateContext, getStore: () => StateStore, inherited: Readonly<Record<string, string | undefined>> = process.env, configurationBytes?: DiagnosticEnvironmentInput['configurationBytes'], request?: import('./test-runs.ts').ParsedTestRunArgs, bindSpawn?: (identity: string) => void, spawnFailed?: () => void): TestRunPorts {
  let state: TestRunStatePort | undefined;
  const environment = stateContextEnvironment(stateContext, inherited);
  if (request?.phase !== 'integration' && environment.PATH !== undefined) environment.PATH = environment.PATH.split(delimiter).filter(path => !path.split(sep).some(part => part.startsWith('codex-sandbox-'))).join(delimiter);
  const readConfiguration = (name: string) => readFileSync(join(stateContext.orchestratorRoot, 'conf', name));
  const snapshot = configurationBytes ?? { flow: readConfiguration('flow.json'), testRuns: readConfiguration('test-runs.json'), projects: readConfiguration('projects.json') };
  const temporaryPorts: RunTemporaryPorts = {
    socketPathCapacityBytes: () => process.platform === 'linux' ? 108 : 104,
    inspect: async path => {
      try {
        const st = lstatSync(path), realpath = realpathSync(path);
        let runId: string | undefined;
        if (st.isDirectory() && !st.isSymbolicLink() && realpath === path && st.uid === process.getuid!() && (st.mode & 0o777) === 0o700) {
          let descriptor: number | undefined;
          try {
            descriptor = openSync(join(path, '.raf-test-run'), constants.O_RDONLY | constants.O_NOFOLLOW);
            const marker = fstatSync(descriptor);
            if (marker.isFile() && marker.uid === st.uid && marker.size > 0 && marker.size <= 4096) {
              const value = readFileSync(descriptor, 'utf8');
              if (Buffer.byteLength(value) === marker.size && !value.includes('\0')) runId = value;
            }
          } catch (error) { if (!['ENOENT', 'ELOOP'].includes((error as any).code)) throw error; }
          finally { if (descriptor !== undefined) closeSync(descriptor); }
        }
        return { path, realpath, device: String(st.dev), inode: String(st.ino), uid: st.uid, mode: st.mode, symlink: st.isSymbolicLink(), ...(runId ? { runId } : {}) };
      } catch (error) { if ((error as any).code === 'ENOENT') return null; throw error; }
    },
    createPrivateDirectory: async (root, runId) => { const path = mkdtempSync(join(root, 'r-')); writeFileSync(join(path, '.raf-test-run'), runId, { flag: 'wx', mode: 0o600 }); return (await temporaryPorts.inspect(path))!; },
    saveReservation: async () => { throw new Error('Reservation writer unavailable'); },
    removeOwnedDirectory: async identity => { const actual = await temporaryPorts.inspect(identity.path); if (!actual || ['device', 'inode', 'uid', 'realpath', 'runId'].some(key => (actual as any)[key] !== (identity as any)[key]) || actual.symlink) throw new Error('Temporary identity changed'); rmSync(identity.path, { recursive: true }); },
  };
  const ports: TestRunPorts = {
    diagnosticEnvironment: command => {
      const profile = Object.values(config.projects).flatMap(p => Object.values(p.profiles)).find(p => p.executable === command?.executable);
      return buildDiagnosticEnvironment({ executable: command?.executable ?? process.execPath, runtimeVersion: process.version, adapter: command?.environment.vitestBatches ? 'vitest-events' : profile?.resultAdapter ?? 'node-test-events', isolation: command?.argv.find(a => a.startsWith('--test-isolation='))?.split('=')[1] ?? 'process', configurationBytes: snapshot, tmpPath: command?.environment.TMPDIR ?? stateContext.tmpRoot, privateRunTmp: !!command?.environment.TMPDIR });
    },
    prepareTemporary: (runId, context, save) => prepareRunTemporaryDirectory(config.temporaryArtifacts, { runId, uid: process.getuid!(), qaHome: context.home, statePath: context.statePath, stateTmpPath: context.tmpPath, workspace: context.workspace, workingStatePath: join(context.operationalHome, '.raf') }, { ...temporaryPorts, saveReservation: save }).then(p => p.reservation),
    cleanupTemporary: (reservation, terminated) => cleanupRunTemporaryDirectory(reservation, terminated, temporaryPorts),
    state: { transaction: action => (state ??= sqliteTestRunState(getStore())).transaction(action) },
    clock: { now: Date.now, schedule: (deadline, callback) => { const timer = setTimeout(callback, Math.max(0, deadline - Date.now())); return () => clearTimeout(timer); } },
    newRunId: randomUUID,
    preflight: async context => {
      const projectId = Object.keys(context.projectWorkspaces).find(project => context.projectWorkspaces[project].includes(context.workspace)) ?? '';
      const projectProfiles = config.projects[projectId]?.profiles ?? {};
      const allProfiles = Object.values(projectProfiles);
      const selectedFiles = projectId === 'etchly' && request ? request.files ?? request.only?.map(id => id.split('::')[0]) ?? config.projects[projectId].groups[request.group]?.files ?? [] : allProfiles.flatMap(profileFiles);
      const profiles = projectId === 'etchly' && request ? allProfiles.filter(p => selectedFiles.some(file => profileFiles(p).includes(file))) : allProfiles;
      const observed = projectId === 'etchly' ? await observeEtchlyInventory(context.workspace, projectProfiles) : null;
      const files: TestRunEnvironment['files'] = {};
      const unitFiles = [...new Set(allProfiles.filter(profile => profileTestKind(profile) === 'unit').flatMap(profileFiles))];
      for (const profile of allProfiles) for (const file of profileFiles(profile)) {
        try { const actual = realpathSync(resolve(context.workspace, file)); files[file] = { kind: statSync(actual).isDirectory() ? 'directory' : 'file', realpath: actual, unit: profileTestKind(profile) === 'unit', testKind: profileTestKind(profile) }; } catch { }
      }
      if (projectId === 'etchly') {
        verifyEtchlyDependencies(context, profiles, selectedFiles, inherited);
        if (profiles.some(profile => profile.testKind === 'integration')) await verifyEtchlyD1Dependencies(context, profiles);
      }
      const inheritedOperationalChannel = checkChannel(stateContext, inherited);
      if (!inheritedOperationalChannel) mkdirSync(stateContext.tmpRoot, { recursive: true });
      return { canonicalWorkspace: realpathSync(context.workspace), canonicalCwd: realpathSync(context.cwd),
        runtimeAvailable: profiles.every(p => executableAvailable(p.executable, resolve(context.workspace, p.cwd))),
        localRunnerAvailable: profiles.every(p => p.resultAdapter === 'node-test-events' || p.resultAdapter === 'vitest-events' && ['./test-run-vitest-runner.ts', '../scripts/test-run-vitest.ts', '../scripts/test-run-vitest-api.ts'].every(path => existsSync(fileURLToPath(new URL(path, import.meta.url))))),
        dependenciesAvailable: profiles.every(p => p.checks.every(path => existsSync(resolve(context.workspace, path)))),
        resultAdapterAvailable: profiles.every(p => existsSync(fileURLToPath(new URL(p.resultAdapter === 'vitest-events' ? './test-run-vitest-reporter.ts' : './test-run-reporter.ts', import.meta.url)))),
        artifactsWritable: !inheritedOperationalChannel && (() => { try { accessSync(stateContext.tmpRoot, constants.W_OK); return true; } catch { return false; } })(),
        treeControlSupported: process.platform === 'linux' && existsSync('/proc/self/stat'), isolatedHome: stateContext.mode === 'qa', stateOriginAllowed: true,
        stateAliasesOperational: within(context.statePath, join(context.operationalHome, '.raf')), tmpAliasesOperational: within(context.tmpPath, join(context.operationalHome, '.raf')),
        inheritedOperationalChannel, unitFiles: observed ? observed.filter(f => f.classification === 'unit').map(f => f.file) : unitFiles.filter(file => files[file]?.kind === 'file'), files };
    },
    spawn: async (command, onEvent): Promise<ManagedTestProcess> => {
      let child: ReturnType<typeof spawn>;
      try {
        const project = request ? config.projects[request.project] : undefined;
        const profileId = request ? project?.groups[request.group]?.profileId : undefined;
        const profiles = profileId ? [project!.profiles[profileId]] : Object.values(config.projects).flatMap(project => Object.values(project.profiles));
        const vitestProfile = profiles.find(p => p.resultAdapter === 'vitest-events' && command.executable === p.executable && command.argv[0] === p.argv[0] && command.argv.includes(p.argv[p.argv.indexOf('run') - 1]) && (p.cwd === '.' || command.cwd.endsWith('/' + p.cwd)) && (!p.argv.includes('--project') || command.argv[command.argv.indexOf('--project') + 1] === p.argv[p.argv.indexOf('--project') + 1]));
        let vitestEnvironment: Record<string, string> = {};
        if (vitestProfile) {
          const workspace = resolve(command.cwd, relative(vitestProfile.cwd, '.'));
          const run = command.argv.indexOf('run');
          const options = command.argv.slice(run + 1);
          const firstOption = options.findIndex(arg => arg.startsWith('-'));
          const files = (firstOption < 0 ? options : options.slice(0, firstOption)).map(file => relative(workspace, resolve(command.cwd, file)));
          const ids = command.environment.testIds ?? [];
          const policy = command.environment.timeoutPolicy ?? testRunTimeoutPolicy(profileTestKind(vitestProfile), JSON.parse(Buffer.from(snapshot.flow).toString('utf8')));
          const batches = planVitestInvocations({ workspace, selection: { files, testIds: ids }, command } as any, vitestProfile, policy, fileURLToPath(new URL('./test-run-vitest-reporter.ts', import.meta.url)), ids);
          const localConfig = readFileSync(resolve(command.cwd, 'vitest.config.ts'), 'utf8');
          const baseRunner = localConfig.match(/\brunner:\s*["']([^"']+)["']/)?.[1];
          command.environment.vitestBatches = batches;
          vitestEnvironment = { RAF_TEST_RUN_VITEST_BATCHES: JSON.stringify(batches), RAF_TEST_RUN_WORKSPACE: workspace, RAF_TEST_RUN_KIND: profileTestKind(vitestProfile), RAF_TEST_RUN_DIAGNOSTICS: JSON.stringify(config.diagnostics), ...(baseRunner ? { RAF_TEST_RUN_BASE_RUNNER: resolve(command.cwd, baseRunner) } : {}) };
          command.argv = [fileURLToPath(new URL('../scripts/test-run-vitest.ts', import.meta.url))];
        }
        let childEnvironment = environment;
        if (vitestProfile?.testKind === 'integration') {
          const runRoot = command.environment.TMPDIR;
          if (!runRoot) throw Object.assign(new Error('Etchly D1 requires a reserved private run TMPDIR'), { code: 'ENVIRONMENT_INVALID' });
          const facts = [runRoot, stateContext.homeDirectory].map(path => { const st = lstatSync(path); return !st.isSymbolicLink() && st.isDirectory() && realpathSync(path) === path && st.uid === process.getuid!() && !(st.mode & 0o077); });
          accessSync(runRoot, constants.W_OK);
          if (Buffer.byteLength(resolve(runRoot, 'tmp')) > 50 || !facts.every(Boolean)) throw Object.assign(new Error('Etchly D1 HOME/TMPDIR must be canonical, private and compact'), { code: 'ENVIRONMENT_INVALID' });
          const prepared = prepareEtchlyIntegrationEnvironment({ missingChecks: [], executableRuntime: true, compatibleBridge: true, sharedLibsBranchMatches: true, resourceProtocolInstalled: true, localBuildValid: true, privateTmpWritable: true, loopbackAvailable: true, isolatedHome: stateContext.homeDirectory, operationalHome: userInfo().homedir, stateOriginVerified: stateContext.mode === 'qa', privateRunRoot: runRoot, inheritedEnv: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
          if ('errorCode' in prepared) throw Object.assign(new Error(prepared.reason), { code: prepared.errorCode });
          for (const path of prepared.ownedPaths) mkdirSync(path, { mode: 0o700 });
          childEnvironment = prepared.env;
        }
        child = spawn(command.executable, command.argv, { cwd: command.cwd, env: { ...childEnvironment, ...(inherited.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: inherited.PLAYWRIGHT_BROWSERS_PATH } : {}), ...vitestEnvironment, TMPDIR: vitestProfile?.testKind === 'integration' ? childEnvironment.TMPDIR : command.environment.TMPDIR, RAF_TEST_RUN_IDS: JSON.stringify(command.environment.testIds ?? []), RAF_TEST_RUN_DIAGNOSTICS_PROTOCOL: '2' }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
      } catch (error) {
        spawnFailed?.();
        throw error;
      }
      const pid = child.pid!;
      const exited = new Promise<void>(done => child.once('exit', () => done()));
      const identity = JSON.stringify({ pid, start: processStart(pid), boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
      bindSpawn?.(identity);
      let buffer = '', protocolBad = false;
      const protocol = new RunnerProtocol();
      const decoder = new StringDecoder('utf8');
      const readDiagnostics = new TestRunDiagnostics(config.diagnostics, { workspace: command.cwd, qaHome: stateContext.homeDirectory, fixtureRoots: command.environment.TMPDIR ? [command.environment.TMPDIR] : [] });
      const consume = (line: string) => {
        try {
          const event = JSON.parse(line);
          protocol.accept(event);
          onEvent(event as RunnerEvent);
        } catch { if (!protocolBad) onEvent({ kind: 'protocol-error', diagnostic: 'Invalid JSON runner protocol' }); protocolBad = true; }
      };
      child.stdout!.on('data', chunk => {
        for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
          buffer += part;
          if (part.endsWith('\n')) { consume(buffer); buffer = ''; }
        }
      });
      child.stderr!.on('data', chunk => readDiagnostics.stderrChunk(chunk));
      const waited = new Promise<ChildExit>(done => child.once('close', (exitCode, signal) => {
        if (buffer.length || decoder.end()) onEvent({ kind: 'protocol-error', diagnostic: 'Truncated JSON runner protocol' });
        try { protocol.finish(); } catch { if (!protocolBad) onEvent({ kind: 'protocol-error', diagnostic: 'Incomplete runner expected inventory' }); }
        done({ exitCode, signal, stderr: readDiagnostics.stderrText(), stderrTruncated: readDiagnostics.readState().stderrTruncated });
      }));
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

export async function runConfiguredTestRun(argv: readonly string[], options: { orchestratorRoot: string; homeDirectory: string; costStartedAt?: RafCostBoundary; commandTimingOwner?: 'production'; settle?: (store: StateStore) => Promise<void> }): Promise<ExecutionResult> {
  const costStartedAt = options.costStartedAt ?? rafCostBoundary();
  let costProfile: RafCostRuntime | undefined;
  let execution: ExecutionResult | undefined;
  let store: StateStore | undefined, controlStore: StateStore | undefined;
  let config: TestRunConfig | undefined;
  let resultContext: StateContext | undefined;
  let context: TestRunContext = { cwd: process.cwd(), workspace: '', projectWorkspaces: {}, agentPhases: [], activeChanges: [], agentId: 'test-run', sha: '', home: options.homeDirectory, statePath: '', tmpPath: '', operationalHome: userInfo().homedir };
  const value = (option: string) => { const index = argv.indexOf(option); return index >= 0 ? argv[index + 1] ?? '' : ''; };
  let request = { project: value('--project'), phase: value('--phase'), group: value('--group') };
  try {
    const root = realpathSync(options.orchestratorRoot);
    const configuration = new Map<string, Buffer>();
    const read = (file: string) => { const data = readFileSync(join(root, 'conf', file)); configuration.set(file, data); return JSON.parse(data.toString('utf8')); };
    const constants = read('raf-constants.json');
    const flowBytes = readFileSync(join(root, 'conf/flow.json'));
    const policy = loadFlowPolicy(join(root, 'conf/flow.json')).unitTests;
    if (!flowBytes.equals(readFileSync(join(root, 'conf/flow.json')))) throw Object.assign(new Error('Flow configuration changed while reading'), { code: 'CONFIGURATION_INVALID' });
    const integrationTests = JSON.parse(flowBytes.toString('utf8')).integrationTests;
    const phases = constants.agentPhases.map((p: any) => p.id);
    config = validateTestRunConfig(read('test-runs.json'), phases, policy, integrationTests);
    const args = parseTestRunArgs(argv);
    request = { project: args.project, phase: args.phase ?? '', group: args.group };
    const projects = read('projects.json').projects;
    read('raf.json');
    configuration.set('flow.json', flowBytes);
    const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const configurationReader: TestRunConfigurationReader = {
      read: async file => { const bytes = readFileSync(join(root, file)); return { text: bytes.toString('utf8'), revision: revision(bytes) }; },
      revision: async file => revision(readFileSync(join(root, file))),
    };
    const initialConfigurationReader: TestRunConfigurationReader = {
      revision: async file => revision(configuration.get(file.slice('conf/'.length))!),
      read: async file => { const bytes = configuration.get(file.slice('conf/'.length))!; return { text: bytes.toString('utf8'), revision: revision(bytes) }; },
    };
    const cwd = realpathSync(process.cwd());
    const workspaces: Record<string, string[]> = {};
    for (const [id, project] of Object.entries(projects) as [string, any][]) workspaces[id] = [...new Set<string>(Object.values(project.branchPaths ?? { main: project.path }).map(path => resolve(root, String(path))))];
    const workspace = workspaces[args.project]?.find(path => within(cwd, path));
    if (!workspace) throw Object.assign(new Error('cwd is outside the registered project'), { code: 'WORKSPACE_MISMATCH' });
    context = { ...context, cwd, workspace, projectWorkspaces: workspaces, agentPhases: phases, integrationTests };
    const controlContext = productionStateContext(root, fileURLToPath(import.meta.url), options.homeDirectory, 'cli');
    const openStore = (role: 'control' | 'unit', state: StateContext): StateStore => {
      try { return openStateStore(state.statePath, { context: state }); }
      catch (error) {
        if ((error as any)?.operation === 'open' || (error as any)?.code?.startsWith('ERR_SQLITE') && !(error as any)?.operation) Object.assign(error as object, { stateAccess: stateOpenFailure(role, state.statePath, error, config!.diagnostics) });
        throw error;
      }
    };
    const sqliteStartedAt = rafCostBoundary();
    controlStore = openStore('control', controlContext);
    if (options.commandTimingOwner !== 'production') {
      costProfile = new RafCostRuntime(controlStore, { scope: 'command', command: 'test run' }, root, 'handler', costStartedAt, sqliteStartedAt);
      costProfile.install();
    }
    const control = await sandboxTestControlSnapshot(controlStore, root, args.project, args.group);
    const caller = control.ancestors.find(row => row.pid === process.pid);
    if (!caller) throw Object.assign(new Error('Current caller identity is unavailable'), { code: 'CALLER_UNVERIFIED' });
    const entrypoint = [process.execPath, realpathSync(fileURLToPath(new URL('../bin/raf.ts', import.meta.url)))];
    const literal = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
    let runtime: TestRunPorts | undefined;
    const reply = await runSandboxTestCommand({ command: [...entrypoint, 'test', 'run', ...argv].map(literal).join(' '), cwd }, {
      caller, entrypoint, control: async () => control,
      communicate: async () => { throw new Error('Unexpected communication request in the test entrypoint'); },
      unitContext: async (key, assignment) => {
        const owner = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`);
        mkdirSync(owner, { recursive: true, mode: 0o700 });
        const identity = lstatSync(owner);
        if (realpathSync(owner) !== owner || !identity.isDirectory() || identity.uid !== process.getuid?.() || (identity.mode & 0o077) !== 0) throw Object.assign(new Error('Unit HOME root is not private or has aliases'), { code: 'STATE_CONTEXT_REFUSED' });
        const home = join(owner, createHash('sha256').update(JSON.stringify([root, key.project, key.workspace])).digest('hex'));
        const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'LANG', 'TZ', 'SYSTEMROOT', 'PLAYWRIGHT_BROWSERS_PATH'].includes(name) || name.startsWith('LC_')));
        const unitEnvironment = { ...inherited, HOME: home, RAF_QA_HOME: home };
        const stateContext = productionStateContext(root, fileURLToPath(import.meta.url), home, 'cli', unitEnvironment);
        if (within(stateContext.homeDirectory, controlContext.homeDirectory) || within(controlContext.homeDirectory, stateContext.homeDirectory)) throw Object.assign(new Error('Unit HOME overlaps the control context'), { code: 'STATE_CONTEXT_REFUSED' });
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const homeIdentity = lstatSync(home);
        if (!homeIdentity.isDirectory() || homeIdentity.uid !== process.getuid?.() || (homeIdentity.mode & 0o077) !== 0) throw Object.assign(new Error('Unit HOME is not private'), { code: 'STATE_CONTEXT_REFUSED' });
        await prepareUnitTestState(stateContext, key);
        context = { integrationTests, cwd, workspace, projectWorkspaces: workspaces, agentPhases: phases, activeChanges: [...control.activeChanges],
          agentId: assignment.agentId, callerPhase: assignment.phase, sha: readGitHead(workspace).commit ?? '',
          home, statePath: stateContext.statePath, tmpPath: stateContext.tmpRoot, operationalHome: userInfo().homedir };
        const boot = await readMachineBootIdentity();
        const session = controlStore!.sessionRepository.transaction(tx => tx.getSession(assignment.runId), 'read');
        const items = session?.launchContext?.assignment.changes.flatMap(change => change.items.map(item => ({ project: session.activity?.project ?? args.project, change: change.id, item: item.id }))) ?? [];
        const resources = createTestRunResourcePort(controlStore!, { root, workspace, home: context.operationalHome, machineId: boot.machineId, config, resultStatePath: stateContext.statePath, items });
        resultContext = stateContext;
        runtime = createTestRunPorts(config!, stateContext, () => store ??= openStore('unit', stateContext), { ...unitEnvironment, TMPDIR: stateContext.tmpRoot }, { flow: flowBytes, testRuns: configuration.get('test-runs.json')!, projects: configuration.get('projects.json')! }, args, resources.bindSpawn, resources.spawnFailed);
        let capturedConfiguration: TestRunConfigurationSnapshot | undefined;
        const originalPreflight = runtime.preflight;
        runtime.preflight = async value => {
          const current = await sandboxTestControlSnapshot(controlStore!, root, args.project, args.group, { projects, config });
          if (!isDeepStrictEqual(resolveSandboxTestCaller(current.callerEvidence), assignment) ||
              !current.activeChanges.includes(args.group.split('/')[0])) {
            throw Object.assign(new Error('Test authorization changed while waiting'), { code: 'CALLER_UNAUTHORIZED' });
          }
          if (capturedConfiguration) await assertTestRunConfigurationUnchanged(capturedConfiguration, configurationReader);
          return originalPreflight(value);
        };
        const resourceRoute = { branchPaths: Object.fromEntries(Object.entries(projects[args.project].branchPaths ?? { main: projects[args.project].path })
          .map(([branch, path]) => [branch, resolve(root, String(path))])) };
        const queue = createTestRunQueuePort(controlStore!, { root, workspace, home: controlContext.homeDirectory,
          machineId: boot.machineId, settle: async () => { await options.settle?.(controlStore!); } });
        const configurationDependencies = {
          capture: async () => {
            const environment = await runtime!.preflight(context);
            const only = args.only?.map(id => {
              const split = id.indexOf('::');
              return id.startsWith('{') ? JSON.parse(id) : { file: id.slice(0, split), name: id.slice(split + 2) };
            });
            const phase = args.phase ?? assignment.phase;
            const plan = planTestRun({ ...args, phase, only }, config!, context, environment);
            const dependencies = testRunConfigurationManifest({ project: args.project, profileId: plan.profileId, group: args.group,
              phase, testKind: plan.testKind ?? 'unit', resourceLevel: assignment.branch === 'hotfix' ? 'hotfix' : 'normal',
              projectProfileId: projects[args.project].profile, agentPhaseIndex: phases.indexOf(phase),
              commandIndex: constants.commands.findIndex((entry: any) => isDeepStrictEqual(entry.path, ['test', 'run'])) });
            const add = (file: TestRunConfigurationFile, pointer: string) => dependencies.push({ file, pointer });
            add('conf/raf-constants.json', '/resourceWaitLevels');
            add('conf/raf.json', '/service');
            for (const hint of Object.values(config!.phases[phase].hints)) add('conf/test-runs.json', `/hints/${hint.replaceAll('~', '~0').replaceAll('/', '~1')}`);
            add('conf/flow.json', assignment.branch === 'hotfix' ? '/resources/normal' : '/resources/hotfix');
            const presetKey = config!.projects[args.project].groups[args.group] ? args.group : args.group.slice(args.group.indexOf('/') + 1);
            const groupDependency = dependencies.find(dependency => dependency.file === 'conf/test-runs.json' && dependency.pointer.includes('/groups/'))!;
            if (config!.projects[args.project].groups[presetKey]) groupDependency.pointer = `/projects/${args.project.replaceAll('~', '~0').replaceAll('/', '~1')}/groups/${presetKey.replaceAll('~', '~0').replaceAll('/', '~1')}`;
            else dependencies.splice(dependencies.indexOf(groupDependency), 1);
            const snapshot = await captureTestRunConfiguration(dependencies, initialConfigurationReader);
            await assertTestRunConfigurationUnchanged(snapshot, configurationReader);
            capturedConfiguration = snapshot;
            return snapshot;
          },
          recheck: (snapshot: TestRunConfigurationSnapshot) => assertTestRunConfigurationUnchanged(snapshot, configurationReader),
        };
        const reserved = Object.assign(runtime, { configurationDependencies, resourceRoute, queue, deferDelivery: true, machineId: boot.machineId, wrapperIdentity: testWrapperIdentity(), resources });
        runtime.recoverGroup = async groupKey => {
          const recovery = await recoverTestRun({ key: groupKey, authorized: true, nowMs: Date.now() }, {
            state: runtime!.state as RecoveryStatePort,
            observe: async flight => {
              const owner = observeReservedTestTree(flight.ownerIdentity ?? flight.wrapperIdentity ?? null);
              const tree = observeReservedTestTree(flight.processIdentity);
              return { owner: owner.state === 'dead' ? 'lost' : owner.state === 'alive' ? 'alive' : 'unknown', tree: tree.state, identity: tree.processIdentity, finishedAtMs: flight.finishedAtMs ?? null, deadlineObservedAtMs: flight.deadlineObservedAtMs ?? null, interrupted: false };
            },
            cleanup: async flight => {
              const cleanup = flight.processIdentity ? (await runtime!.reconcile(flight.processIdentity, flight.deadlineMs)).cleanup : { complete: true, remainingPids: [] };
              if (flight.temporary && runtime!.cleanupTemporary) {
                const temporary = await runtime!.cleanupTemporary(flight.temporary, cleanup.complete);
                if (temporary.cleanup !== 'complete') cleanup.complete = false;
              }
              return cleanup;
            },
            release: (runId, identity) => releaseRecoveredTestRunClaims(runId, identity, resources, boot.machineId),
            returnResult: async () => ({ returned: false }),
            messageMain: async () => ({ accepted: false, receiptId: null, forwarded: false }),
          });
          return recovery.result;
        };
        await reconcileTestRunResources(context, policy, reserved);
        return { config, policy, context, runtime: reserved };
      },
    });
    if (!reply.stdout) throw Object.assign(new Error(reply.stderr.trim()), { code: 'CALLER_UNAUTHORIZED' });
    if (store && runtime) {
      await cleanupClosedTestRunGroups(context.activeChanges, context, runtime);
      if (controlStore) {
        const retained = new Set(store.startupContextDatabase.prepare('SELECT payload FROM test_run_groups').all().flatMap(row => {
          const group: TestRunGroup = JSON.parse(String(row.payload));
          return [group.lastResult?.runId, group.inFlight?.runId].filter(Boolean);
        }));
        const db = controlStore.startupContextDatabase;
        for (const row of db.prepare("SELECT run_id, payload FROM resource_usage WHERE kind = 'test'").all()) {
          const record = JSON.parse(String(row.payload));
          if (record.context.resultStatePath === context.statePath && record.finishedAt !== null && !retained.has(String(row.run_id))) db.prepare("DELETE FROM resource_usage WHERE kind = 'test' AND run_id = ? AND payload = ?").run(String(row.run_id), String(row.payload));
        }
      }
    }
    const output = JSON.parse(reply.stdout);
    const stateForDelivery = resultContext;
    return execution = { exitCode: reply.code, stdout: reply.stdout.trimEnd(), stderr: reply.stderr.trimEnd(),
      afterDelivery: stateForDelivery && output.groupSnapshot === 'loaded' ? async () => {
        const deliveredStore = openStore('unit', stateForDelivery);
        try { await acknowledgeTestRunDelivery(output, sqliteTestRunState(deliveredStore)); } finally { deliveredStore.close(); }
      } : undefined };
  } catch (error) {
    const result = testRunFailureResult(request, context, randomUUID(), Date.now(), config, error);
    if (!config || ['STATE_CONTEXT_REFUSED', 'STATE_SCHEMA_MISMATCH', 'HANDLER_FAILED'].includes(result.errorCode!)) {
      result.outcome = 'setup-failed'; result.failureKinds = ['setup'];
      const hintId = config?.phases[result.phase]?.hints.setup;
      result.hintIds = hintId ? [hintId] : []; result.hints = hintId ? [config!.hints[hintId]] : [];
    }
    return execution = { exitCode: 1, stdout: JSON.stringify(result), stderr: result.errorCode === 'CALLER_UNAUTHORIZED' && error instanceof Error ? error.message : '' };
  } finally {
    try { costProfile?.stage('finalization'); costProfile?.finish(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (execution) { execution.exitCode = execution.exitCode || 1; execution.stderr = [execution.stderr, `Cost profile storage failed: ${message}`].filter(Boolean).join('\n'); }
      else process.emitWarning(error instanceof Error ? error : String(error));
    }
    finally { store?.close(); controlStore?.close(); }
  }
}
