import { readGitHead } from './git.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { alive, command, durable, exists, hash, inventory, json, locked, mainRoute, readLease, processStart, validateReleaseWorkspace, withReleaseWriter } from './hotfix-host.ts';
import type { HotfixCleanupResult, HotfixHost, HotfixWorkspace } from "./hotfix-worktree.ts";

export type HotfixGateName = "build" | "regression" | "runtime-import" | "help" | "agent-ps" | "agent-message" | "service-start" | "service-ready" | "service-status" | "service-stop";
export type HotfixCheckpoint = "before-intent" | "after-intent" | "before-switch" | "after-switch" | "after-refs" | "after-index" | "after-smoke" | "before-cleanup" | "after-cleanup";
export type HotfixReaderKind = "cli" | "service" | "worker" | "hook" | "notice";

export interface HotfixSnapshotFile {
  path: string;
  sha256: string;
  mode?: number;
}

export interface HotfixGateEvidence {
  name: HotfixGateName;
  status: "passed" | "failed" | "skipped" | "timeout";
  code: number | null;
  command: readonly string[];
  cwd: string;
  home: string;
  commit: string;
  fingerprint: string;
  logPath: string;
}

export type HotfixSnapshotCheckpoint = "before-copy" | "after-copy";

export interface HotfixSnapshotOptions {
  source?: "hotfix" | "develop";
  sourceWorkspace?: HotfixWorkspace;
  checkpoint?: (phase: HotfixSnapshotCheckpoint) => Promise<void>;
}

export interface HotfixSealedSnapshot {
  source?: "hotfix" | "develop";
  sourceWorkspace?: HotfixWorkspace;
  root: string;
  configurationRoot: string;
  sourceCwd: string;
  sourceGitDirectory: string;
  sourceCommonDirectory: string;
  baseCommit: string;
  commit: string;
  tree: string;
  fingerprint: string;
  files: readonly HotfixSnapshotFile[];
  configuration: readonly HotfixSnapshotFile[];
}

export interface VerifiedHotfix {
  workspace: HotfixWorkspace;
  snapshot?: HotfixSealedSnapshot;
  commit: string;
  tree: string;
  fingerprint: string;
  files: readonly HotfixSnapshotFile[];
  configuration: readonly HotfixSnapshotFile[];
  gates: readonly HotfixGateEvidence[];
  evidencePath: string;
}

async function sourceIdentity(host: HotfixHost, workspace: HotfixWorkspace, source: "hotfix" | "develop" = "hotfix", sourceWorkspace?: HotfixWorkspace) {
  await validateReleaseWorkspace(host, workspace, source, sourceWorkspace);
  const files = await inventory(workspace.cwd);
  const tree = hash(JSON.stringify(files));
  const configuration = await configurationFiles(host, workspace);
  return { tree, files, configuration, fingerprint: fingerprint(tree, files, configuration) };
}

async function captureHotfixSnapshot(host: HotfixHost, workspace: HotfixWorkspace, options: HotfixSnapshotOptions): Promise<HotfixSealedSnapshot> {
  const before = await sourceIdentity(host, workspace, options.source, options.sourceWorkspace);
  await options.checkpoint?.('before-copy');
  await options.checkpoint?.('after-copy');
  if (JSON.stringify(before) !== JSON.stringify(await sourceIdentity(host, workspace, options.source, options.sourceWorkspace))) throw new Error('Hotfix source/configuration changed while capturing snapshot');
  return { source: options.source ?? 'hotfix', sourceWorkspace: options.sourceWorkspace, root: workspace.cwd, configurationRoot: host.orchestratorRoot, sourceCwd: workspace.cwd, sourceGitDirectory: workspace.gitDirectory, sourceCommonDirectory: workspace.commonDirectory, baseCommit: workspace.baseCommit, commit: readGitHead(workspace.cwd).commit ?? '', ...before };
}

export async function sealHotfixSnapshot(host: HotfixHost, workspace: HotfixWorkspace, options: HotfixSnapshotOptions = {}): Promise<HotfixSealedSnapshot> {
  return withReleaseWriter(host, workspace, options.source ?? 'hotfix', () => captureHotfixSnapshot(host, workspace, options), options.sourceWorkspace);
}

export interface HotfixVerificationRequest {
  source?: "hotfix" | "develop";
  sourceWorkspace?: HotfixWorkspace;
  workspace: HotfixWorkspace;
  regression: { executable: string; args: readonly string[] };
  mainAddress: string;
  message: string;
}

export interface AtomicHotfixSwitch {
  probe(currentDirectory: string, preparedDirectory: string): Promise<{ supported: boolean; sameDevice: boolean }>;
  exchange(currentDirectory: string, preparedDirectory: string): Promise<void>;
}

export interface HotfixPublication {
  currentDirectory: string;
  preparedDirectory: string;
  assertSnapshot(): Promise<void>;
  writeIntent(): Promise<void>;
  reconcileGit(): Promise<void>;
  clearIntent(): Promise<void>;
  generationRoot?: string;
  afterSwitch?(): Promise<void>;
  reconcileRefs?(): Promise<void>;
  activated?(): Promise<void>;
  rollback?(): Promise<void>;
  cleanup?(): Promise<void>;
}

export interface HotfixActivationOptions {
  publication?: HotfixPublication;
  checkpoint?: (phase: HotfixCheckpoint) => Promise<void>;
  switchProvider?: AtomicHotfixSwitch;
}

export interface HotfixActivationResult {
  status: "activated" | "already-active";
  commit: string;
  fingerprint: string;
  generationRoot: string;
}

export interface HotfixRecoveryResult {
  status: "idle" | "recovered";
  commit: string;
  fingerprint: string;
  pending: boolean;
}

export interface HotfixReaderLease {
  id: string;
  generationRoot: string;
  commit: string;
  fingerprint: string;
  release(): Promise<void>;
}

async function configurationFiles(host: HotfixHost, workspace: HotfixWorkspace): Promise<HotfixSnapshotFile[]> {
  const files: HotfixSnapshotFile[] = [];
  for (const root of new Set([join(host.orchestratorRoot, 'conf'), join(dirname(workspace.cwd), 'conf')])) for (const file of await inventory(root, new Set())) files.push({ ...file, path: relative(host.orchestratorRoot, join(root, file.path)) });
  return files;
}
const gateNames: readonly HotfixGateName[] = ['build', 'regression', 'runtime-import', 'help', 'agent-ps', 'agent-message', 'service-start', 'service-ready', 'service-status', 'service-stop'];
const fingerprint = (tree: string, files: readonly HotfixSnapshotFile[], configuration: readonly HotfixSnapshotFile[]) => hash(JSON.stringify({ tree, files, configuration }));

async function checkSnapshot(host: HotfixHost, workspace: HotfixWorkspace, snapshot: HotfixSealedSnapshot): Promise<void> {
  await validateReleaseWorkspace(host, workspace, snapshot.source ?? 'hotfix', snapshot.sourceWorkspace);
  if (snapshot.root !== workspace.cwd || snapshot.configurationRoot !== host.orchestratorRoot || snapshot.sourceCwd !== workspace.cwd) throw new Error('Snapshot ownership mismatch');
  if ((await sourceIdentity(host, workspace, snapshot.source, snapshot.sourceWorkspace)).fingerprint !== snapshot.fingerprint) throw new Error('Hotfix snapshot fingerprint changed');
  if (snapshot.sourceWorkspace && (await sourceIdentity(host, snapshot.sourceWorkspace, snapshot.source)).fingerprint !== snapshot.fingerprint) throw new Error('Release source fingerprint changed');
}

export async function verifyHotfixCandidate(host: HotfixHost, request: HotfixVerificationRequest): Promise<VerifiedHotfix> {
  const workspace = request.workspace;
  return withReleaseWriter(host, workspace, request.source ?? 'hotfix', async () => {
    const snapshot = await captureHotfixSnapshot(host, workspace, { source: request.source, sourceWorkspace: request.sourceWorkspace });
    const route = await validateReleaseWorkspace(host, workspace, request.source ?? "hotfix", request.sourceWorkspace);
    const evidenceRoot = join(route.control, 'verification', workspace.runId, randomUUID());
    const qaRoot = host.orchestratorRoot;
    const qaMain = workspace.cwd;
    const environment = { RAF_ORCHESTRATOR_ROOT: qaRoot, RAF_MAIN_PATH: qaMain };
    const cli = [process.execPath, join(qaMain, 'bin/raf.ts')];
    const specifications: { name: HotfixGateName; argv: readonly string[] }[] = [
      { name: 'build', argv: ['npm', 'run', 'build'] },
      { name: 'regression', argv: [request.regression.executable, ...request.regression.args] },
      { name: 'runtime-import', argv: [process.execPath, '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(qaMain, 'src/production-entry.ts')).href)});await import(${JSON.stringify(pathToFileURL(join(qaMain, 'src/production-runtime.ts')).href)})`] },
      { name: 'help', argv: [...cli, 'help'] },
      { name: 'agent-ps', argv: [...cli, 'agent', 'ps'] },
      { name: 'agent-message', argv: [process.execPath, '--input-type=module', '-e', `const {withProductionRuntime}=await import(${JSON.stringify(pathToFileURL(join(qaMain, 'src/production-entry.ts')).href)});const {rafSystemCaller}=await import(${JSON.stringify(pathToFileURL(join(qaMain, 'src/production-runtime.ts')).href)});const {runCli}=await import(${JSON.stringify(pathToFileURL(join(qaMain, 'src/bootstrap.ts')).href)});const result=await withProductionRuntime(${JSON.stringify({ orchestratorRoot: qaRoot, homeDirectory: host.qaHome, artifactPath: join(qaMain, 'dist/catalog.json') })},async()=>rafSystemCaller,runtime=>runCli(${JSON.stringify(['agent', 'message', '--to', request.mainAddress, '--text', request.message])},${JSON.stringify(join(qaMain, 'dist/catalog.json'))},runtime.handlers));if(result.stdout)console.log(result.stdout);if(result.stderr)console.error(result.stderr);process.exitCode=result.exitCode;`, '--', '--text', request.message] },
      { name: 'service-start', argv: [...cli, 'service', 'start'] },
      { name: 'service-ready', argv: [...cli, 'service', 'status'] },
      { name: 'service-status', argv: [...cli, 'service', 'status'] },
      { name: 'service-stop', argv: [...cli, 'service', 'stop'] },
    ];
    const gates: HotfixGateEvidence[] = [];
    let primary: unknown;
    for (const specification of specifications) {
      if (primary && specification.name !== 'service-stop') continue;
      let result: Awaited<ReturnType<typeof command>> | undefined;
      let verificationError: string | undefined;
      try {
        if (specification.name !== 'service-stop') {
          await checkSnapshot(host, workspace, snapshot);
        }
        result = await command(host, snapshot.root, specification.argv[0], specification.argv.slice(1), environment);
        if (['service-ready', 'service-status'].includes(specification.name) && result.code === 0 && JSON.parse(result.stdout).state !== 'ready') throw new Error('Service is not ready');
        await checkSnapshot(host, workspace, snapshot);
      } catch (error) {
        verificationError = String(error);
      }
      const logPath = join(evidenceRoot, specification.name + '.json');
      await durable(logPath, { ...(result ?? { code: null, signal: null, stdout: '', stderr: '' }), executed: result !== undefined, verificationError });
      gates.push({ name: specification.name, status: verificationError ? 'failed' : result?.code === 0 ? 'passed' : result?.signal ? 'timeout' : 'failed', code: result?.code ?? null, command: specification.argv, cwd: snapshot.root, home: host.qaHome, commit: snapshot.commit, fingerprint: snapshot.fingerprint, logPath });
      if ((verificationError || result?.code !== 0) && !primary) primary = new Error('Hotfix gate ' + specification.name + ' failed: ' + (verificationError ?? result?.stderr));
    }
    if (primary) throw primary;
    await checkSnapshot(host, workspace, snapshot);
    const verified: VerifiedHotfix = { workspace, snapshot, commit: snapshot.commit, tree: snapshot.tree, fingerprint: snapshot.fingerprint, files: snapshot.files, configuration: snapshot.configuration, gates, evidencePath: join(evidenceRoot, 'verified.json') };
    await durable(verified.evidencePath, verified);
    return verified;
  }, request.sourceWorkspace);
}

async function checkCandidate(host: HotfixHost, candidate: VerifiedHotfix) {
  const route = await validateReleaseWorkspace(host, candidate.workspace, candidate.snapshot?.source ?? "hotfix", candidate.snapshot?.sourceWorkspace);
  if (!candidate.snapshot || !candidate.evidencePath.startsWith(join(route.control, 'verification', candidate.workspace.runId) + '/') || JSON.stringify(await json(candidate.evidencePath)) !== JSON.stringify(candidate)) throw new Error('Hotfix verification evidence mismatch');
  await checkSnapshot(host, candidate.workspace, candidate.snapshot);
  if (candidate.commit !== candidate.snapshot.commit || candidate.tree !== candidate.snapshot.tree || candidate.fingerprint !== candidate.snapshot.fingerprint || JSON.stringify(candidate.files) !== JSON.stringify(candidate.snapshot.files) || JSON.stringify(candidate.configuration) !== JSON.stringify(candidate.snapshot.configuration)) throw new Error('Hotfix candidate snapshot mismatch');
  if (gateNames.some(name => !candidate.gates.some(gate => gate.name === name && gate.status === 'passed' && gate.code === 0 && gate.fingerprint === candidate.fingerprint && gate.commit === candidate.commit && gate.home === host.qaHome && gate.cwd === candidate.snapshot!.root))) throw new Error('Hotfix gates are incomplete');
  for (const gate of candidate.gates) {
    if (gate.logPath !== join(dirname(candidate.evidencePath), gate.name + '.json')) throw new Error('Hotfix gate log ownership changed');
    const log = await json(gate.logPath);
    if (log.code !== 0 || !log.executed || log.verificationError) throw new Error('Hotfix gate log changed');
  }
  return route;
}

async function mainSmoke(host: HotfixHost, root: string) {
  return command(host, root, process.execPath, ['--input-type=module', '-e', `const {runProductionCli}=await import(${JSON.stringify(pathToFileURL(join(root, 'src/production-entry.ts')).href)});const result=await runProductionCli(['agent','ps'],${JSON.stringify({ orchestratorRoot: host.orchestratorRoot, homeDirectory: host.qaHome, artifactPath: join(root, 'dist/catalog.json') })});if(result.stdout)process.stdout.write(result.stdout+'\\n');if(result.stderr)process.stderr.write(result.stderr+'\\n');process.exitCode=result.exitCode;`]);
}

async function publishHotfixSnapshot(host: HotfixHost, candidate: VerifiedHotfix, options: HotfixActivationOptions & { publication: HotfixPublication }): Promise<HotfixActivationResult> {
  const publication = options.publication;
  const provider = options.switchProvider;
  if (!provider) throw new Error('Publication requires an explicit atomic switch provider');
  const checkpoint = options.checkpoint ?? (async () => {});
  const support = await provider.probe(publication.currentDirectory, publication.preparedDirectory);
  if (!support.supported || !support.sameDevice) throw new Error('Atomic publication unsupported or EXDEV');
  await checkpoint('before-intent');
  await publication.assertSnapshot();
  await publication.writeIntent();
  await checkpoint('after-intent');
  await checkpoint('before-switch');
  try { await publication.assertSnapshot(); }
  catch (error) { await publication.clearIntent(); throw error; }
  await provider.exchange(publication.currentDirectory, publication.preparedDirectory);
  await publication.afterSwitch?.();
  await checkpoint('after-switch');
  await publication.reconcileRefs?.();
  await checkpoint('after-refs');
  await publication.reconcileGit();
  await checkpoint('after-index');
  const generationRoot = publication.generationRoot ?? publication.preparedDirectory;
  const smoke = await mainSmoke(host, generationRoot);
  if (smoke.code !== 0) {
    await publication.rollback?.();
    throw new Error('Activated main smoke failed: ' + smoke.stderr);
  }
  await checkpoint('after-smoke');
  await publication.activated?.();
  await publication.clearIntent();
  await checkpoint('before-cleanup');
  await publication.cleanup?.();
  await checkpoint('after-cleanup');
  return { status: 'activated', commit: candidate.commit, fingerprint: candidate.fingerprint, generationRoot };
}

export async function activateHotfix(host: HotfixHost, candidate: VerifiedHotfix, options: HotfixActivationOptions = {}): Promise<HotfixActivationResult> {
  if (options.publication) return publishHotfixSnapshot(host, candidate, { ...options, publication: options.publication });
  await checkCandidate(host, candidate);
  const { activateMainSymlinkHotfix } = await import('./main-symlink-activation.ts');
  return activateMainSymlinkHotfix(host, candidate, options, checkCandidate, activateHotfix);
}

export interface HotfixPublicationRecovery {
  reconcile(): Promise<{ result: HotfixRecoveryResult; generationRoot: string }>;
  clearIntent(): Promise<void>;
}

export async function recoverHotfixActivation(host: HotfixHost, options: { publication?: HotfixPublicationRecovery } = {}): Promise<HotfixRecoveryResult> {
  if (options.publication) {
    const { result, generationRoot } = await options.publication.reconcile();
    if (!result.pending) {
      const smoke = await mainSmoke(host, generationRoot);
      if (smoke.code !== 0) throw new Error('Recovered main smoke failed: ' + smoke.stderr);
      await options.publication.clearIntent();
    }
    return result;
  }
  const { recoverMainSymlinkHotfix } = await import('./main-symlink-activation.ts');
  return recoverMainSymlinkHotfix(host, recoverHotfixActivation);
}

export async function cleanupHotfixActivation(host: HotfixHost): Promise<HotfixCleanupResult> {
  return locked(host, async route => {
    const retained: string[] = [];
    for (const name of await fs.readdir(join(route.control, 'readers')).catch(() => [])) {
      const path = join(route.control, 'readers', name);
      const lease = await readLease(path);
      if (lease && await alive(lease.pid, lease.start)) retained.push(lease.root);
      else await fs.rm(path, { force: true });
    }
    return { removed: [], retained: [...new Set(retained)] };
  });
}

export async function acquireHotfixReader(host: HotfixHost, _kind: HotfixReaderKind): Promise<HotfixReaderLease> {
  return locked(host, async () => {
    const route = await mainRoute(host);
    if (await exists(join(route.control, 'main-symlink-intent.json')) || await exists(join(route.control, 'intent.json'))) throw new Error('Main publication recovery pending; reader admission refused');
    const commit = readGitHead(route.cwd).commit ?? '';
    const id = randomUUID();
    const path = join(route.control, 'readers', id + '.json');
    const fingerprint = hash(commit);
    await durable(path, { root: route.cwd, pid: process.pid, start: await processStart(process.pid) });
    return { id, generationRoot: route.cwd, commit, fingerprint, release: () => fs.rm(path, { force: true }) };
  }, true);
}

export function createAtomicHotfixSwitch(): AtomicHotfixSwitch {
  const execute = promisify(execFile);
  const exchange = async (left: string, right: string) => {
    await execute('python3', ['-c', 'import ctypes,os,sys; c=ctypes.CDLL(None,use_errno=True); r=c.renameat2(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),2); e=ctypes.get_errno(); r==0 or (_ for _ in ()).throw(OSError(e,os.strerror(e)))', left, right]);
    for (const path of new Set([dirname(left), dirname(right)])) { const directory = await fs.open(path, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  };
  return { exchange, probe: async (left, right) => {
    const sameDevice = (await fs.stat(left)).dev === (await fs.stat(right)).dev;
    if (!sameDevice || process.platform !== 'linux') return { supported: false, sameDevice };
    const a = join(dirname(right), '.probe-' + randomUUID());
    const b = join(dirname(right), '.probe-' + randomUUID());
    try { await fs.mkdir(a); await fs.mkdir(b); await exchange(a, b); return { supported: true, sameDevice }; }
    catch { return { supported: false, sameDevice }; }
    finally { await fs.rm(a, { recursive: true, force: true }); await fs.rm(b, { recursive: true, force: true }); }
  } };
}

export async function retainHotfixGeneration(host: HotfixHost, root: string): Promise<{ release(): Promise<void> } | undefined> {
  const route = await mainRoute(host);
  const copies = (await json(join(host.orchestratorRoot, 'conf/projects.json'))).projects?.raf?.mainCopies ?? [];
  if (root !== route.cwd && !copies.map((path: string) => join(host.orchestratorRoot, path)).includes(root)) return undefined;
  return locked(host, async () => {
    const current = await mainRoute(host);
    const directory = join(current.control, 'readers');
    if (root !== current.cwd) {
      let retained = false;
      for (const name of await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        const reader = await readLease(join(directory, name));
        if (reader?.root === root && await alive(reader.pid, reader.start)) retained = true;
      }
      if (!retained) throw new Error('Inactive main slot has no retained readers');
    }
    const path = join(directory, randomUUID() + '.json');
    await durable(path, { root, pid: process.pid, start: await processStart(process.pid) });
    return { release: () => fs.rm(path, { force: true }) };
  });
}
