import { gitAllowed, readGitHead, readGitMetadata } from './git.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alive, command, copyTree, durable, exists, git, hash, inventory, json, locked, mainRoute, processStart, validateReleaseWorkspace, withReleaseWriter, withHotfixWriter } from './hotfix-host.ts';
import type { HotfixCleanupResult, HotfixHost, HotfixWorkspace } from "./hotfix-worktree.ts";
import { stateFailure } from './state-migration-guard.ts';
import { createHotfixRuntimeInventory, defaultHotfixRuntimePolicy, verifyHotfixRuntimeInventory } from './hotfix-runtime-inventory.ts';
import type { HotfixRuntimeInventory } from './hotfix-runtime-inventory.ts';

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
  source?: "hotfix" | "develop" | "mac";
  sourceWorkspace?: HotfixWorkspace;
  checkpoint?: (phase: HotfixSnapshotCheckpoint) => Promise<void>;
}

export interface HotfixSealedSnapshot {
  source?: "hotfix" | "develop" | "mac";
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

async function sourceIdentity(host: HotfixHost, workspace: HotfixWorkspace, source: "hotfix" | "develop" | "mac" = "hotfix", sourceWorkspace?: HotfixWorkspace) {
  await validateReleaseWorkspace(host, workspace, source, sourceWorkspace);
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await exists(join(workspace.gitDirectory, marker))) throw new Error('Unfinished hotfix Git operation: ' + marker);
  }
  const commit = readGitHead(workspace.cwd).commit;
  if (!commit) throw new Error('Cannot read hotfix source HEAD');
  const files = await inventory(workspace.cwd);
  const tree = hash(JSON.stringify(files));
  const configuration = await configurationFiles(host, workspace);
  return { commit, tree, files, configuration, fingerprint: fingerprint(commit, tree, files, configuration) };
}

export async function sealHotfixSnapshot(host: HotfixHost, workspace: HotfixWorkspace, options: HotfixSnapshotOptions = {}): Promise<HotfixSealedSnapshot> {
  return withReleaseWriter(host, workspace, options.source ?? "hotfix", async () => {
    const route = await validateReleaseWorkspace(host, workspace, options.source ?? "hotfix", options.sourceWorkspace);
    const before = await sourceIdentity(host, workspace, options.source, options.sourceWorkspace);
    if (options.sourceWorkspace && (await sourceIdentity(host, options.sourceWorkspace, options.source)).fingerprint !== before.fingerprint) throw new Error("Prepared slot differs from release source snapshot");
    const parent = join(route.control, 'snapshots', workspace.runId, randomUUID());
    const root = join(parent, 'raf-main');
    const configurationRoot = parent;
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      await options.checkpoint?.('before-copy');
      await copyTree(workspace.cwd, root);
      await fs.cp(join(host.orchestratorRoot, 'conf'), join(configurationRoot, 'conf'), { recursive: true, dereference: false });
      await options.checkpoint?.('after-copy');
      if (JSON.stringify(before) !== JSON.stringify(await sourceIdentity(host, workspace, options.source, options.sourceWorkspace)) || JSON.stringify(before.files) !== JSON.stringify(await inventory(root)) || JSON.stringify(await inventory(join(host.orchestratorRoot, 'conf'), new Set())) !== JSON.stringify(await inventory(join(configurationRoot, 'conf'), new Set()))) throw new Error('Hotfix source/configuration changed while sealing snapshot');
      const snapshot: HotfixSealedSnapshot = { source: options.source ?? "hotfix", sourceWorkspace: options.sourceWorkspace, root, configurationRoot, sourceCwd: workspace.cwd, sourceGitDirectory: workspace.gitDirectory, sourceCommonDirectory: workspace.commonDirectory, baseCommit: workspace.baseCommit, ...before };
      await durable(join(parent, 'snapshot.json'), snapshot);
      return snapshot;
    } catch (error) {
      await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }, options.sourceWorkspace);
}

export interface HotfixVerificationRequest {
  source?: "hotfix" | "develop" | "mac";
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
const fingerprint = (commit: string, tree: string, files: readonly HotfixSnapshotFile[], configuration: readonly HotfixSnapshotFile[]) => hash(JSON.stringify({ commit, tree, files, configuration }));

async function prepareDependencies(host: HotfixHost, workspace: HotfixWorkspace, main: string, evidenceRoot: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const lockfile = await fs.readFile(join(workspace.cwd, 'package-lock.json'));
  const config = await json(join(host.orchestratorRoot, 'conf/projects.json'));
  const sources = new Set([fileURLToPath(new URL('../', import.meta.url)), main]);
  const develop = config.projects?.raf?.branchPaths?.develop;
  if (typeof develop === 'string') sources.add(resolve(host.orchestratorRoot, develop));
  for (const source of sources) {
    const modules = join(source, 'node_modules');
    if (resolve(source) === workspace.cwd || !await exists(modules)) continue;
    const sourceLockfile = await fs.readFile(join(source, 'package-lock.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!sourceLockfile?.equals(lockfile)) continue;
    await fs.rm(join(workspace.cwd, 'node_modules'), { recursive: true, force: true });
    await fs.cp(modules, join(workspace.cwd, 'node_modules'), { recursive: true, dereference: true });
    await durable(join(evidenceRoot, 'dependencies.json'), { method: 'copy', source, target: workspace.cwd, lockfileSha256: hash(lockfile) });
    return;
  }
  const argv = ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  const result = await command(host, workspace.cwd, 'npm', argv, environment);
  await durable(join(evidenceRoot, 'dependencies.json'), { method: 'npm-ci', command: ['npm', ...argv], cwd: workspace.cwd, lockfileSha256: hash(lockfile), ...result });
  if (result.code !== 0) throw new Error('Hotfix dependency preparation failed: no installed dependencies with an identical package-lock.json; npm ci is unavailable or failed: ' + result.stderr);
}

async function checkSnapshot(host: HotfixHost, workspace: HotfixWorkspace, snapshot: HotfixSealedSnapshot): Promise<void> {
  const route = await validateReleaseWorkspace(host, workspace, snapshot.source ?? "hotfix", snapshot.sourceWorkspace);
  const parent = dirname(snapshot.root);
  if (!parent.startsWith(join(route.control, 'snapshots', workspace.runId) + '/') || snapshot.root !== join(parent, 'raf-main') || snapshot.configurationRoot !== parent || await fs.realpath(parent) !== parent || await fs.realpath(snapshot.root) !== snapshot.root || snapshot.sourceCwd !== workspace.cwd || snapshot.sourceGitDirectory !== workspace.gitDirectory || snapshot.sourceCommonDirectory !== workspace.commonDirectory || snapshot.baseCommit !== workspace.baseCommit || JSON.stringify(await json(join(parent, 'snapshot.json'))) !== JSON.stringify(snapshot)) throw new Error('Sealed snapshot ownership mismatch');
  if ((await sourceIdentity(host, workspace, snapshot.source, snapshot.sourceWorkspace)).fingerprint !== snapshot.fingerprint || JSON.stringify(await inventory(snapshot.root)) !== JSON.stringify(snapshot.files) || JSON.stringify(await inventory(join(snapshot.configurationRoot, 'conf'), new Set())) !== JSON.stringify(await inventory(join(host.orchestratorRoot, 'conf'), new Set()))) throw new Error('Hotfix snapshot fingerprint changed');
  if (snapshot.sourceWorkspace && (await sourceIdentity(host, snapshot.sourceWorkspace, snapshot.source)).fingerprint !== snapshot.fingerprint) throw new Error('Release source fingerprint changed');
}

export async function verifyHotfixCandidate(host: HotfixHost, request: HotfixVerificationRequest): Promise<VerifiedHotfix> {
  const workspace = request.workspace;
  const snapshot = await sealHotfixSnapshot(host, workspace, { source: request.source, sourceWorkspace: request.sourceWorkspace });
  const route = await validateReleaseWorkspace(host, workspace, request.source ?? "hotfix", request.sourceWorkspace);
  const evidenceRoot = join(route.control, 'verification', workspace.runId, randomUUID());
  const qaRoot = join(evidenceRoot, 'stand');
  await fs.cp(join(snapshot.configurationRoot, 'conf'), join(qaRoot, 'conf'), { recursive: true, dereference: false });
  const qaConfig = await json(join(qaRoot, 'conf/projects.json'));
  qaConfig.projects.raf.path = 'raf-main';
  qaConfig.projects.raf.branchPaths.main = 'raf-main';
  qaConfig.projects.raf.branchPaths.develop = 'raf-develop';
  qaConfig.projects.raf.branchPaths.hotfix = 'raf-hotfix';
  delete qaConfig.projects.raf.mainCopies;
  await durable(join(qaRoot, 'conf/projects.json'), qaConfig);
  const environment = { RAF_ORCHESTRATOR_ROOT: qaRoot };
  const isolated = { ...workspace, cwd: snapshot.root };
  await prepareDependencies(host, isolated, workspace.cwd, evidenceRoot, environment);
  const qaMain = join(qaRoot, 'raf-main');
  await copyTree(snapshot.root, qaMain);
  await git(qaRoot, 'init', '-b', 'main');
  await fs.writeFile(join(qaRoot, '.gitmodules'), '[submodule "raf-main"]\n\tpath = raf-main\n\turl = ./raf-main\n');
  const metadata = join(qaRoot, '.git', 'modules', 'raf-main');
  await fs.mkdir(dirname(metadata), { recursive: true });
  await git(qaMain, 'init', '-b', 'main', '--separate-git-dir', metadata);
  await git(qaMain, 'fetch', '--no-tags', workspace.cwd, snapshot.commit);
  await git(qaMain, 'update-ref', 'refs/heads/main', snapshot.commit);
  await git(qaMain, 'read-tree', snapshot.commit);
  await git(qaRoot, 'add', '.gitmodules');
  await git(qaRoot, 'update-index', '--add', '--cacheinfo', '160000,' + snapshot.commit + ',raf-main');
  await git(qaMain, 'worktree', 'add', '-b', 'develop', join(qaRoot, 'raf-develop'), snapshot.commit);
  await git(qaMain, 'worktree', 'add', '-b', 'hotfix', join(qaRoot, 'raf-hotfix'), snapshot.commit);
  if (JSON.stringify(await inventory(qaMain)) !== JSON.stringify(snapshot.files)) throw new Error('Verification stand snapshot differs from sealed candidate');
  const cli = [process.execPath, join(qaMain, 'bin/raf.ts')];
  const standConfiguration = await inventory(join(qaRoot, 'conf'), new Set());
  const checkStand = async () => {
    if (JSON.stringify(await inventory(qaMain)) !== JSON.stringify(snapshot.files) || JSON.stringify(await inventory(join(qaRoot, 'conf'), new Set())) !== JSON.stringify(standConfiguration) ) throw new Error('Verification stand source/configuration fingerprint changed');
  };
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
        await withReleaseWriter(host, workspace, snapshot.source ?? "hotfix", () => checkSnapshot(host, workspace, snapshot), snapshot.sourceWorkspace);
        await checkStand();
      }
      result = await command(host, snapshot.root, specification.argv[0], specification.argv.slice(1), environment);
      if (['service-ready', 'service-status'].includes(specification.name) && result.code === 0 && JSON.parse(result.stdout).state !== 'ready') throw new Error('Service is not ready');
      await withReleaseWriter(host, workspace, snapshot.source ?? "hotfix", () => checkSnapshot(host, workspace, snapshot), snapshot.sourceWorkspace);
      await checkStand();
    } catch (error) {
      verificationError = String(error);
    }
    const logPath = join(evidenceRoot, specification.name + '.json');
    await durable(logPath, { ...(result ?? { code: null, signal: null, stdout: '', stderr: '' }), executed: result !== undefined, verificationError });
    gates.push({ name: specification.name, status: verificationError ? 'failed' : result?.code === 0 ? 'passed' : result?.signal ? 'timeout' : 'failed', code: result?.code ?? null, command: specification.argv, cwd: snapshot.root, home: host.qaHome, commit: snapshot.commit, fingerprint: snapshot.fingerprint, logPath });
    if ((verificationError || result?.code !== 0) && !primary) primary = new Error('Hotfix gate ' + specification.name + ' failed: ' + (verificationError ?? result?.stderr));
  }
  if (primary) throw primary;
  await withReleaseWriter(host, workspace, snapshot.source ?? "hotfix", () => checkSnapshot(host, workspace, snapshot), snapshot.sourceWorkspace);
  const verified: VerifiedHotfix = { workspace, snapshot, commit: snapshot.commit, tree: snapshot.tree, fingerprint: snapshot.fingerprint, files: snapshot.files, configuration: snapshot.configuration, gates, evidencePath: join(evidenceRoot, 'verified.json') };
  await durable(verified.evidencePath, verified);
  return verified;
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

interface Generation { root: string; commit: string; fingerprint: string; files: readonly HotfixSnapshotFile[]; runtimeInventory: HotfixRuntimeInventory }
interface Registry { current: string; generations: Record<string, Generation>; prepared?: string[]; garbage?: { path: string; root: string; kind: 'generation' | 'prepared' }[] }
async function assertMainWriterGate(host: HotfixHost, cwd: string): Promise<void> {
  const directories = new Set([cwd, host.orchestratorRoot].map(root => readGitMetadata(root)?.gitDirectory).filter((directory): directory is string => !!directory));
  for (const directory of directories) for (const marker of ['index.lock', 'HEAD.lock', 'refs/heads/main.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await exists(join(directory, marker))) throw new Error('Main writer/Git operation pending: ' + marker);
  }
}

interface Intent { version: 1; base: string; target: string; previous: string; next: string; prepared: string; oldTree: string; newTree: string; phase: string; candidate: VerifiedHotfix }
async function generationSmoke(host: HotfixHost, root: string) {
  return command(host, root, process.execPath, ['--input-type=module', '-e', `const {runProductionCli}=await import(${JSON.stringify(pathToFileURL(join(root, 'src/production-entry.ts')).href)});const result=await runProductionCli(['agent','ps'],${JSON.stringify({ orchestratorRoot: host.orchestratorRoot, homeDirectory: host.qaHome, artifactPath: join(root, 'dist/catalog.json') })});if(result.stdout)process.stdout.write(result.stdout+'\\n');if(result.stderr)process.stderr.write(result.stderr+'\\n');process.exitCode=result.exitCode;`]);
}
async function generation(host: HotfixHost, route: Awaited<ReturnType<typeof mainRoute>>, source: string, commit: string, configurationRoot = join(host.orchestratorRoot, 'conf')): Promise<Generation> {
  const parent = join(route.control, 'generations', randomUUID());
  const root = join(parent, 'raf-main');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await durable(join(parent, 'ownership.json'), { root, orchestratorRoot: host.orchestratorRoot, repositoryIdentity: route.repositoryIdentity });
  await copyTree(source, root);
  await fs.cp(configurationRoot, join(parent, 'conf'), { recursive: true, dereference: false });
  const files = await inventory(root);
  const runtimeInventory = createHotfixRuntimeInventory(root, commit, defaultHotfixRuntimePolicy(root));
  return { root, commit, fingerprint: hash(JSON.stringify(files)), files, runtimeInventory };
}
async function registry(host: HotfixHost, route: Awaited<ReturnType<typeof mainRoute>>): Promise<Registry> {
  const path = join(route.control, 'registry.json');
  if (await exists(path)) return json(path);
  const head = readGitHead(route.cwd).commit;
  if (!head) throw new Error('Cannot read initial main generation HEAD');
  const first = await generation(host, route, route.cwd, head);
  const value = { current: first.root, generations: { [first.root]: first } };
  await durable(path, value);
  return value;
}
async function updateGitlink(host: HotfixHost, cwd: string, commit: string): Promise<void> {
  const path = relative(host.orchestratorRoot, cwd);
  await git(host.orchestratorRoot, 'update-index', '--cacheinfo', '160000,' + commit + ',' + path);
}
async function treeIdentity(path: string): Promise<string> { return hash(JSON.stringify(await inventory(path))); }
async function removeIntent(path: string): Promise<void> {
  await fs.rm(path);
  const directory = await fs.open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function reconcile(host: HotfixHost, route: Awaited<ReturnType<typeof mainRoute>>): Promise<boolean> {
  const path = join(route.control, 'intent.json');
  if (!await exists(path)) return false;
  const intent: Intent = await json(path);
  await assertMainWriterGate(host, route.cwd);
  const state: Registry = await json(join(route.control, 'registry.json'));
  if (intent.version !== 1 || !state.generations[intent.previous] || !state.generations[intent.next] || !intent.prepared.startsWith(route.control + '/prepared/') || !state.prepared?.includes(intent.prepared) || state.generations[intent.previous].root !== intent.previous || state.generations[intent.next].root !== intent.next || state.generations[intent.previous].commit !== intent.base || state.generations[intent.next].commit !== intent.target || state.generations[intent.previous].fingerprint !== intent.oldTree || state.generations[intent.next].fingerprint !== intent.newTree) throw new Error('Unrecognized hotfix recovery ownership');
  for (const root of [intent.previous, intent.next]) {
    if (!root.startsWith(join(route.control, 'generations') + '/') || await fs.realpath(root) !== root || await treeIdentity(root) !== state.generations[root].fingerprint) throw new Error('Recovery generation fingerprint mismatch');
  }
  const actual = await treeIdentity(route.cwd);
  let commit: string;
  if (actual === intent.newTree) {
    const smoke = await generationSmoke(host, intent.next);
    if (smoke.code !== 0) {
      if (await treeIdentity(intent.prepared) !== intent.oldTree) throw new Error('Recovery rollback snapshot changed');
      await createAtomicHotfixSwitch().exchange(route.cwd, intent.prepared);
      return reconcile(host, route);
    }
    commit = intent.target; state.current = intent.next;
  }
  else if (actual === intent.oldTree) { commit = intent.base; state.current = intent.previous; }
  else throw new Error('Hotfix recovery cannot identify complete live snapshot');
  if (readGitHead(route.cwd).commit !== commit) await git(route.cwd, 'update-ref', 'refs/heads/main', commit);
  await git(route.cwd, 'read-tree', commit);
  await updateGitlink(host, route.cwd, commit);
  await durable(join(route.control, 'registry.json'), state);
  intent.phase = 'recovered';
  await durable(path, intent);
  await removeIntent(path);
  return true;
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
  await publication.assertSnapshot();
  await provider.exchange(publication.currentDirectory, publication.preparedDirectory);
  await publication.afterSwitch?.();
  await checkpoint('after-switch');
  await publication.reconcileRefs?.();
  await checkpoint('after-refs');
  await publication.reconcileGit();
  await checkpoint('after-index');
  const generationRoot = publication.generationRoot ?? publication.preparedDirectory;
  const smoke = await generationSmoke(host, generationRoot);
  if (smoke.code !== 0) {
    await publication.rollback?.();
    throw new Error('Activated generation smoke failed: ' + smoke.stderr);
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
  return locked(host, async route => withHotfixWriter(host, async () => {
    await reconcile(host, route);
    await checkCandidate(host, candidate);
    await assertMainWriterGate(host, route.cwd);
    const state = await registry(host, route);
    const head = readGitHead(route.cwd).commit;
    if (!head) throw new Error('Cannot read main HEAD');
    let current = state.generations[state.current];
    if (!current || await treeIdentity(current.root) !== current.fingerprint) throw new Error('Live main differs from registered generation');
    if (current.commit !== head) {
      if (head !== candidate.workspace.baseCommit) throw new Error('Stale hotfix base commit');
      const liveTree = await treeIdentity(route.cwd);
      const refreshed = await generation(host, route, route.cwd, head);
      await assertMainWriterGate(host, route.cwd);
      if (await treeIdentity(route.cwd) !== liveTree || refreshed.fingerprint !== liveTree) throw new Error('Main changed while registering refreshed generation');
      state.generations[refreshed.root] = refreshed;
      state.current = refreshed.root;
      await durable(join(route.control, 'registry.json'), state);
      current = refreshed;
    }
    if (await treeIdentity(route.cwd) !== current.fingerprint) throw new Error('Live main differs from registered generation');
    if (head === candidate.commit) {
      if (current.fingerprint !== hash(JSON.stringify(candidate.files))) throw new Error('Active main differs from verified snapshot');
      await updateGitlink(host, route.cwd, head);
      return { status: 'already-active', commit: head, fingerprint: candidate.fingerprint, generationRoot: state.current };
    }
    if (head !== candidate.workspace.baseCommit) throw new Error('Stale hotfix base commit');
    if (route.productionDirectory !== route.repositoryIdentity) await git(route.cwd, 'fetch', '--no-tags', '--no-write-fetch-head', route.repositoryIdentity, candidate.commit);
    const next = await generation(host, route, candidate.snapshot!.root, candidate.commit, join(candidate.snapshot!.configurationRoot, 'conf'));
    state.generations[next.root] = next;
    const prepared = join(route.control, 'prepared', randomUUID());
    state.prepared = [...(state.prepared ?? []), prepared];
    await durable(join(route.control, 'registry.json'), state);
    await copyTree(next.root, prepared);
    await fs.copyFile(join(route.cwd, '.git'), join(prepared, '.git'));
    const provider = options.switchProvider ?? createAtomicHotfixSwitch();
    let intent: Intent | undefined;
    const checkpoint = options.checkpoint ?? (async () => {});
    try {
      return await publishHotfixSnapshot(host, candidate, {
        switchProvider: provider,
        checkpoint,
        publication: {
          currentDirectory: route.cwd,
          preparedDirectory: prepared,
          generationRoot: next.root,
          async assertSnapshot() {
            await assertMainWriterGate(host, route.cwd);
            await checkCandidate(host, candidate);
            if (intent && (await treeIdentity(route.cwd) !== intent.oldTree || await treeIdentity(prepared) !== intent.newTree)) throw new Error('Main or prepared snapshot changed before activation switch');
          },
          async writeIntent() {
            intent = { version: 1, base: head, target: candidate.commit, previous: state.current, next: next.root, prepared, oldTree: await treeIdentity(route.cwd), newTree: await treeIdentity(prepared), phase: 'intent', candidate };
            await durable(join(route.control, 'registry.json'), state);
            await durable(join(route.control, 'intent.json'), intent);
          },
          async afterSwitch() {
            intent!.phase = 'switched';
            await durable(join(route.control, 'intent.json'), intent);
          },
          async reconcileRefs() {
            await assertMainWriterGate(host, route.cwd);
            await git(route.cwd, 'update-ref', 'refs/heads/main', candidate.commit, head);
            intent!.phase = 'refs';
            await durable(join(route.control, 'intent.json'), intent);
          },
          async reconcileGit() {
            await git(route.cwd, 'read-tree', candidate.commit);
            await updateGitlink(host, route.cwd, candidate.commit);
            intent!.phase = 'index';
            await durable(join(route.control, 'intent.json'), intent);
          },
          async rollback() { await provider.exchange(route.cwd, prepared); await reconcile(host, route); },
          async activated() { state.current = next.root; await durable(join(route.control, 'registry.json'), state); },
          async clearIntent() { await removeIntent(join(route.control, 'intent.json')); },
          async cleanup() { await cleanupGenerations(host, route); },
        },
      });
    } catch (primary) {
      try { await checkpoint('before-cleanup'); } catch {}
      throw primary;
    }
  }));
}

export interface HotfixPublicationRecovery {
  reconcile(): Promise<{ result: HotfixRecoveryResult; generationRoot: string }>;
  clearIntent(): Promise<void>;
}

export async function recoverHotfixActivation(host: HotfixHost, options: { publication?: HotfixPublicationRecovery } = {}): Promise<HotfixRecoveryResult> {
  if (options.publication) {
    const { result, generationRoot } = await options.publication.reconcile();
    if (!result.pending) {
      const smoke = await generationSmoke(host, generationRoot);
      if (smoke.code !== 0) throw new Error('Recovered generation smoke failed: ' + smoke.stderr);
      await options.publication.clearIntent();
    }
    return result;
  }
  return locked(host, async route => {
    const recovered = await reconcile(host, route);
    const state = await registry(host, route);
    const current = state.generations[state.current];
    return { status: recovered ? 'recovered' : 'idle', commit: current.commit, fingerprint: current.fingerprint, pending: false };
  });
}

async function cleanupGenerations(host: HotfixHost, route: Awaited<ReturnType<typeof mainRoute>>): Promise<HotfixCleanupResult> {
  if (await exists(join(route.control, 'intent.json'))) return { removed: [], retained: [join(route.control, 'intent.json')] };
  const state = await registry(host, route);
  const retained = new Set([state.current]);
  const leases = join(route.control, 'readers');
  for (const name of await fs.readdir(leases).catch(() => [])) {
    const path = join(leases, name);
    const lease = await json(path);
    if (await alive(lease.pid, lease.start)) retained.add(lease.root);
    else await fs.rm(path);
  }
  const garbage = state.garbage ?? [];
  for (const root of Object.keys(state.generations)) {
    if (retained.has(root)) continue;
    if (!root.startsWith(join(route.control, 'generations') + '/')) throw new Error('Generation cleanup ownership mismatch');
    if (!garbage.some(entry => entry.root === root)) garbage.push({ path: dirname(root), root, kind: 'generation' });
    delete state.generations[root];
  }
  for (const path of state.prepared ?? []) {
    if (!path.startsWith(join(route.control, 'prepared') + '/')) throw new Error('Prepared cleanup ownership mismatch');
    if (!garbage.some(entry => entry.path === path)) garbage.push({ path, root: path, kind: 'prepared' });
  }
  state.prepared = [];
  const roots = join(route.control, 'generations');
  for (const name of await fs.readdir(roots).catch(() => [])) {
    const parent = join(roots, name);
    const owner = await json(join(parent, 'ownership.json')).catch(() => null);
    if (!owner || owner.repositoryIdentity !== route.repositoryIdentity || owner.root !== join(parent, 'raf-main') || state.generations[owner.root] || retained.has(owner.root)) continue;
    if (!garbage.some(entry => entry.path === parent)) garbage.push({ path: parent, root: owner.root, kind: 'generation' });
  }
  state.garbage = garbage;
  await durable(join(route.control, 'registry.json'), state);
  const removed: string[] = [];
  while (garbage.length) {
    const entry = garbage[0];
    const directory = entry.kind === 'generation' ? 'generations' : 'prepared';
    if (!entry.path.startsWith(join(route.control, directory) + '/') || retained.has(entry.root) || await fs.realpath(entry.path).catch(error => { if (error.code === 'ENOENT') return entry.path; throw error; }) !== entry.path) throw new Error('Cleanup resource ownership mismatch');
    if (entry.kind === 'generation' && await exists(entry.path)) {
      const owner = await json(join(entry.path, 'ownership.json'));
      if (owner.repositoryIdentity !== route.repositoryIdentity || owner.root !== entry.root || entry.path !== dirname(entry.root)) throw new Error('Generation cleanup owner mismatch');
    }
    await fs.rm(entry.path, { recursive: true, force: true });
    removed.push(entry.root);
    garbage.shift();
    await durable(join(route.control, 'registry.json'), state);
  }
  return { removed, retained: [...retained] };
}

export async function cleanupHotfixActivation(host: HotfixHost): Promise<HotfixCleanupResult> {
  return locked(host, route => cleanupGenerations(host, route));
}

export async function acquireHotfixReader(host: HotfixHost, _kind: HotfixReaderKind): Promise<HotfixReaderLease> {
  return verifyReaderLease(await locked(host, async route => {
    if (gitAllowed()) await reconcile(host, route);
    const state = await registry(host, route);
    const current = state.generations[state.current];
    const id = randomUUID();
    const path = join(route.control, 'readers', id + '.json');
    await durable(path, { root: current.root, pid: process.pid, start: await processStart(process.pid) });
    return { generation: current, lease: { id, generationRoot: current.root, commit: current.commit, fingerprint: current.fingerprint, release: async () => { await fs.rm(path, { force: true }); } } };
  }, true));
}

async function verifyReaderLease<T extends { release(): Promise<void> }>(reader: { generation: Generation; lease: T }): Promise<T> {
  try {
    const { root, commit, runtimeInventory } = reader.generation;
    verifyHotfixRuntimeInventory(root, commit, runtimeInventory);
    return reader.lease;
  } catch (error) {
    await reader.lease.release();
    throw stateFailure('STATE_CONTEXT_REFUSED', error instanceof Error ? error.message : String(error));
  }
}

export function createAtomicHotfixSwitch(): AtomicHotfixSwitch {
  const execute = promisify(execFile);
  const exchange = async (left: string, right: string) => {
    if (!['linux', 'darwin'].includes(process.platform)) throw Object.assign(new Error('Atomic rename exchange unsupported on this platform'), { code: 'ENOTSUP' });
    await execute('python3', ['-c', 'import ctypes,os,sys; c=ctypes.CDLL(None,use_errno=True); a=os.fsencode(sys.argv[1]); b=os.fsencode(sys.argv[2]); r=c.renamex_np(a,b,2) if sys.platform=="darwin" else c.renameat2(-100,a,-100,b,2); e=ctypes.get_errno(); r==0 or (_ for _ in ()).throw(OSError(e,os.strerror(e)))', left, right]);
    for (const path of new Set([dirname(left), dirname(right)])) { const directory = await fs.open(path, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  };
  return { exchange, probe: async (left, right) => {
    const sameDevice = (await fs.stat(left)).dev === (await fs.stat(right)).dev;
    if (!sameDevice || !['linux', 'darwin'].includes(process.platform)) return { supported: false, sameDevice };
    const a = join(dirname(right), '.probe-' + randomUUID());
    const b = join(dirname(right), '.probe-' + randomUUID());
    try { await fs.mkdir(a); await fs.mkdir(b); await exchange(a, b); return { supported: true, sameDevice }; }
    catch { return { supported: false, sameDevice }; }
    finally { await fs.rm(a, { recursive: true, force: true }); await fs.rm(b, { recursive: true, force: true }); }
  } };
}

export async function retainHotfixGeneration(host: HotfixHost, root: string): Promise<{ release(): Promise<void> } | undefined> {
  if (!root.includes('/raf-hotfix/generations/')) return undefined;
  const route = await mainRoute(host);
  if (!root.startsWith(join(route.control, 'generations') + '/')) return undefined;
  return verifyReaderLease(await locked(host, async route => {
    const state: Registry = await json(join(route.control, 'registry.json'));
    const generation = state.generations[root];
    if (!generation) throw stateFailure('STATE_CONTEXT_REFUSED', 'Unregistered production generation');
    const path = join(route.control, 'readers', randomUUID() + '.json');
    await durable(path, { root, pid: process.pid, start: await processStart(process.pid) });
    return { generation, lease: { release: () => fs.rm(path, { force: true }) } };
  }));
}
