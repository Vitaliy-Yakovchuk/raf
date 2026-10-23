import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alive, command, copyTree, durable, exists, git, hash, inventory, json, locked, mainRoute, processStart, validateWorkspace } from './hotfix-host.ts';
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

export interface VerifiedHotfix {
  workspace: HotfixWorkspace;
  commit: string;
  tree: string;
  fingerprint: string;
  files: readonly HotfixSnapshotFile[];
  configuration: readonly HotfixSnapshotFile[];
  gates: readonly HotfixGateEvidence[];
  evidencePath: string;
}

export interface HotfixVerificationRequest {
  workspace: HotfixWorkspace;
  regression: { executable: string; args: readonly string[] };
  mainAddress: string;
  message: string;
}

export interface AtomicHotfixSwitch {
  probe(currentDirectory: string, preparedDirectory: string): Promise<{ supported: boolean; sameDevice: boolean }>;
  exchange(currentDirectory: string, preparedDirectory: string): Promise<void>;
}

export interface HotfixActivationOptions {
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

export async function verifyHotfixCandidate(host: HotfixHost, request: HotfixVerificationRequest): Promise<VerifiedHotfix> {
  const route = await validateWorkspace(host, request.workspace);
  const workspace = request.workspace;
  if (await git(workspace.cwd, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Dirty hotfix candidate');
  let commit = await git(workspace.cwd, 'rev-parse', 'HEAD');
  let tree = await git(workspace.cwd, 'rev-parse', 'HEAD^{tree}');
  const before = await inventory(workspace.cwd);
  const evidenceRoot = join(route.control, 'verification', workspace.runId, randomUUID());
  await fs.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const qaRoot = dirname(workspace.cwd);
  const qaConfig = await json(join(qaRoot, 'conf/projects.json'));
  qaConfig.projects.raf.path = 'raf-main';
  qaConfig.projects.raf.branchPaths.main = 'raf-main';
  await durable(join(qaRoot, 'conf/projects.json'), qaConfig);
  const configuration = await configurationFiles(host, workspace);
  const environment = { RAF_ORCHESTRATOR_ROOT: qaRoot };
  await prepareDependencies(host, workspace, route.cwd, evidenceRoot, environment);
  const cli = [process.execPath, join(workspace.cwd, 'bin/raf.ts')];
  const specifications: { name: HotfixGateName; argv: readonly string[] }[] = [
    { name: 'build', argv: ['npm', 'run', 'build'] },
    { name: 'regression', argv: [request.regression.executable, ...request.regression.args] },
    { name: 'runtime-import', argv: [process.execPath, '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(workspace.cwd, 'src/production-runtime.ts')).href)})`] },
    { name: 'help', argv: [...cli, 'help'] },
    { name: 'agent-ps', argv: [...cli, 'agent', 'ps'] },
    { name: 'agent-message', argv: [process.execPath, '--input-type=module', '-e', `const {withProductionRuntime}=await import(${JSON.stringify(pathToFileURL(join(workspace.cwd, 'src/production-entry.ts')).href)}); const {rafSystemCaller}=await import(${JSON.stringify(pathToFileURL(join(workspace.cwd, 'src/production-runtime.ts')).href)}); const receipt=await withProductionRuntime(${JSON.stringify({ orchestratorRoot: qaRoot, homeDirectory: host.qaHome, artifactPath: join(workspace.cwd, 'dist/catalog.json') })},async()=>rafSystemCaller, runtime=>runtime.handlers['agent message'](${JSON.stringify({to: request.mainAddress,text:request.message})})); if(!receipt.accepted)throw new Error('Message not acknowledged');console.log(JSON.stringify(receipt));`, '--', '--text', request.message] },
    { name: 'service-start', argv: [...cli, 'service', 'start'] },
    { name: 'service-ready', argv: [...cli, 'service', 'status'] },
    { name: 'service-status', argv: [...cli, 'service', 'status'] },
    { name: 'service-stop', argv: [...cli, 'service', 'stop'] },
  ];
  const gates: HotfixGateEvidence[] = [];
  let primary: Error | undefined;
  for (const specification of specifications) {
    if (primary && specification.name !== 'service-stop') continue;
    let result = await command(host, workspace.cwd, specification.argv[0], specification.argv.slice(1), environment);
    if (specification.name === 'build' && result.code === 0) {
      const changed = (await git(workspace.cwd, 'diff', 'HEAD', '--name-only')).split('\n').filter(Boolean);
      if (changed.some(path => path !== 'dist/catalog.json')) throw new Error('Source changed during hotfix build');
      if (changed.length) {
        const { commitHotfix } = await import('./hotfix-worktree.ts');
        await commitHotfix(host, { workspace, paths: changed, message: 'Build verified hotfix catalog' });
        commit = await git(workspace.cwd, 'rev-parse', 'HEAD');
        tree = await git(workspace.cwd, 'rev-parse', 'HEAD^{tree}');
        result = await command(host, workspace.cwd, specification.argv[0], specification.argv.slice(1), environment);
      }
    }
    if (['service-ready', 'service-status'].includes(specification.name) && result.code === 0) {
      try { if (JSON.parse(result.stdout).state !== 'ready') throw new Error('Service is not ready'); } catch (error) { result.code = 1; result.stderr += String(error); }
    }
    const logPath = join(evidenceRoot, specification.name + '.json');
    await durable(logPath, result);
    gates.push({ name: specification.name, status: result.code === 0 ? 'passed' : result.signal ? 'timeout' : 'failed', code: result.code, command: specification.argv, cwd: workspace.cwd, home: host.qaHome, commit, fingerprint: '', logPath });
    if (result.code !== 0 && !primary) primary = new Error('Hotfix gate ' + specification.name + ' failed: ' + result.stderr);
  }
  if (primary) throw primary;
  if (await git(workspace.cwd, 'rev-parse', 'HEAD') !== commit || await git(workspace.cwd, 'diff', 'HEAD', '--name-only')) throw new Error('Candidate changed during verification');
  const files = await inventory(workspace.cwd);
  if (JSON.stringify(before.filter(file => file.path !== 'dist/catalog.json')) !== JSON.stringify(files.filter(file => file.path !== 'dist/catalog.json'))) throw new Error('Source changed during hotfix gates');
  if (JSON.stringify(configuration) !== JSON.stringify(await configurationFiles(host, workspace))) throw new Error('Hotfix configuration changed during gates');
  const value = fingerprint(commit, tree, files, configuration);
  gates.forEach(gate => { gate.fingerprint = value; });
  const verified: VerifiedHotfix = { workspace, commit, tree, fingerprint: value, files, configuration, gates, evidencePath: join(evidenceRoot, 'verified.json') };
  await durable(verified.evidencePath, verified);
  return verified;
}

async function checkCandidate(host: HotfixHost, candidate: VerifiedHotfix) {
  const route = await validateWorkspace(host, candidate.workspace);
  if (!candidate.evidencePath.startsWith(join(route.control, 'verification', candidate.workspace.runId) + '/') || JSON.stringify(await json(candidate.evidencePath)) !== JSON.stringify(candidate)) throw new Error('Hotfix verification evidence mismatch');
  if (gateNames.some(name => !candidate.gates.some(gate => gate.name === name && gate.status === 'passed' && gate.code === 0 && gate.fingerprint === candidate.fingerprint && gate.commit === candidate.commit && gate.home === host.qaHome))) throw new Error('Hotfix gates are incomplete');
  const commit = await git(candidate.workspace.cwd, 'rev-parse', 'HEAD');
  const tree = await git(candidate.workspace.cwd, 'rev-parse', 'HEAD^{tree}');
  if (await git(candidate.workspace.cwd, 'diff', 'HEAD', '--name-only') || fingerprint(commit, tree, await inventory(candidate.workspace.cwd), await configurationFiles(host, candidate.workspace)) !== candidate.fingerprint) throw new Error('Hotfix fingerprint changed');
  for (const gate of candidate.gates) if ((await json(gate.logPath)).code !== 0) throw new Error('Hotfix gate log changed');
  return route;
}

interface Generation { root: string; commit: string; fingerprint: string; files: readonly HotfixSnapshotFile[] }
interface Registry { current: string; generations: Record<string, Generation>; prepared?: string[] }
interface Intent { version: 1; base: string; target: string; previous: string; next: string; prepared: string; oldTree: string; newTree: string; phase: string; candidate: VerifiedHotfix }
async function generation(host: HotfixHost, route: Awaited<ReturnType<typeof mainRoute>>, source: string, commit: string): Promise<Generation> {
  const parent = join(route.control, 'generations', randomUUID());
  const root = join(parent, 'raf-main');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await durable(join(parent, 'ownership.json'), { root, orchestratorRoot: host.orchestratorRoot, repositoryIdentity: route.repositoryIdentity });
  await copyTree(source, root);
  await fs.cp(join(host.orchestratorRoot, 'conf'), join(parent, 'conf'), { recursive: true, dereference: true });
  const files = await inventory(root);
  return { root, commit, fingerprint: hash(JSON.stringify(files)), files };
}
async function registry(host: HotfixHost, route: Awaited<ReturnType<typeof mainRoute>>): Promise<Registry> {
  const path = join(route.control, 'registry.json');
  if (await exists(path)) return json(path);
  const first = await generation(host, route, route.cwd, await git(route.cwd, 'rev-parse', 'HEAD'));
  const value = { current: first.root, generations: { [first.root]: first } };
  await durable(path, value);
  return value;
}
async function updateGitlink(host: HotfixHost, cwd: string, commit: string): Promise<void> {
  const path = relative(host.orchestratorRoot, cwd);
  const entry = await git(host.orchestratorRoot, 'ls-files', '--stage', '--', path);
  if (!entry.startsWith('160000 ')) throw new Error('Registered main submodule gitlink required');
  await git(host.orchestratorRoot, 'update-index', '--cacheinfo', '160000,' + commit + ',' + path);
}
async function treeIdentity(path: string): Promise<string> { return hash(JSON.stringify(await inventory(path))); }
async function reconcile(host: HotfixHost, route: Awaited<ReturnType<typeof mainRoute>>): Promise<boolean> {
  const path = join(route.control, 'intent.json');
  if (!await exists(path)) return false;
  const intent: Intent = await json(path);
  const state: Registry = await json(join(route.control, 'registry.json'));
  if (intent.version !== 1 || !state.generations[intent.previous] || !state.generations[intent.next] || !intent.prepared.startsWith(route.control + '/prepared/')) throw new Error('Unrecognized hotfix recovery ownership');
  const actual = await treeIdentity(route.cwd);
  let commit: string;
  if (actual === intent.newTree) {
    const smoke = await command(host, intent.next, process.execPath, [join(intent.next, 'bin/raf.ts'), 'agent', 'ps']);
    if (smoke.code !== 0) {
      await createAtomicHotfixSwitch().exchange(route.cwd, intent.prepared);
      return reconcile(host, route);
    }
    commit = intent.target; state.current = intent.next;
  }
  else if (actual === intent.oldTree) { commit = intent.base; state.current = intent.previous; }
  else throw new Error('Hotfix recovery cannot identify complete live snapshot');
  const head = await git(route.cwd, 'rev-parse', 'HEAD');
  if (![intent.base, intent.target].includes(head)) throw new Error('Hotfix recovery HEAD conflict');
  if (head !== commit) await git(route.cwd, 'update-ref', 'refs/heads/main', commit, head);
  if (await git(route.cwd, 'diff', '--cached', commit, '--name-only')) await git(route.cwd, 'read-tree', commit);
  await updateGitlink(host, route.cwd, commit);
  await durable(join(route.control, 'registry.json'), state);
  intent.phase = 'recovered';
  await durable(path, intent);
  await fs.rm(path);
  return true;
}

export async function activateHotfix(host: HotfixHost, candidate: VerifiedHotfix, options: HotfixActivationOptions = {}): Promise<HotfixActivationResult> {
  return locked(host, async route => {
    await reconcile(host, route);
    await checkCandidate(host, candidate);
    const state = await registry(host, route);
    const head = await git(route.cwd, 'rev-parse', 'HEAD');
    if (head === candidate.commit && state.generations[state.current]?.commit === head) return { status: 'already-active', commit: head, fingerprint: candidate.fingerprint, generationRoot: state.current };
    if (head !== candidate.workspace.baseCommit) throw new Error('Stale hotfix base commit');
    if (await git(route.cwd, 'status', '--porcelain', '--untracked-files=all') || await git(route.cwd, 'diff', '--cached', '--name-only')) throw new Error('Dirty main target');
    const next = await generation(host, route, candidate.workspace.cwd, candidate.commit);
    state.generations[next.root] = next;
    const prepared = join(route.control, 'prepared', randomUUID());
    state.prepared = [...(state.prepared ?? []), prepared];
    await durable(join(route.control, 'registry.json'), state);
    await copyTree(next.root, prepared);
    await fs.copyFile(join(route.cwd, '.git'), join(prepared, '.git'));
    const provider = options.switchProvider ?? createAtomicHotfixSwitch();
    const support = await provider.probe(route.cwd, prepared);
    if (!support.supported || !support.sameDevice) throw new Error('Atomic hotfix switch unsupported or EXDEV');
    const checkpoint = options.checkpoint ?? (async () => {});
    try {
    await checkpoint('before-intent');
    const intent: Intent = { version: 1, base: head, target: candidate.commit, previous: state.current, next: next.root, prepared, oldTree: await treeIdentity(route.cwd), newTree: await treeIdentity(prepared), phase: 'intent', candidate };
    await durable(join(route.control, 'registry.json'), state);
    await durable(join(route.control, 'intent.json'), intent);
    await checkpoint('after-intent');
    await checkpoint('before-switch');
    await provider.exchange(route.cwd, prepared);
    intent.phase = 'switched'; await durable(join(route.control, 'intent.json'), intent);
    await checkpoint('after-switch');
    await git(route.cwd, 'update-ref', 'refs/heads/main', candidate.commit, head);
    intent.phase = 'refs'; await durable(join(route.control, 'intent.json'), intent);
    await checkpoint('after-refs');
    await git(route.cwd, 'read-tree', candidate.commit);
    await updateGitlink(host, route.cwd, candidate.commit);
    intent.phase = 'index'; await durable(join(route.control, 'intent.json'), intent);
    await checkpoint('after-index');
    const smoke = await command(host, next.root, process.execPath, [join(next.root, 'bin/raf.ts'), 'agent', 'ps']);
    if (smoke.code !== 0) {
      await provider.exchange(route.cwd, prepared);
      await reconcile(host, route);
      throw new Error('Activated generation smoke failed: ' + smoke.stderr);
    }
    await checkpoint('after-smoke');
    state.current = next.root;
    await durable(join(route.control, 'registry.json'), state);
    await fs.rm(join(route.control, 'intent.json'));
    await checkpoint('before-cleanup');
    await checkpoint('after-cleanup');
    return { status: 'activated', commit: candidate.commit, fingerprint: candidate.fingerprint, generationRoot: next.root };
    } catch (primary) {
      try { await checkpoint('before-cleanup'); } catch {}
      throw primary;
    }
  });
}

export async function recoverHotfixActivation(host: HotfixHost): Promise<HotfixRecoveryResult> {
  return locked(host, async route => {
    const recovered = await reconcile(host, route);
    const state = await registry(host, route);
    const current = state.generations[state.current];
    return { status: recovered ? 'recovered' : 'idle', commit: current.commit, fingerprint: current.fingerprint, pending: false };
  });
}

export async function cleanupHotfixActivation(host: HotfixHost): Promise<HotfixCleanupResult> {
  return locked(host, async route => {
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
    const removed: string[] = [];
    for (const [root] of Object.entries(state.generations)) {
      if (retained.has(root)) continue;
      if (!root.startsWith(join(route.control, 'generations') + '/') || await fs.realpath(root) !== root) throw new Error('Generation cleanup ownership mismatch');
      await fs.rm(dirname(root), { recursive: true });
      delete state.generations[root];
      removed.push(root);
    }
    for (const path of state.prepared ?? []) {
      if (!path.startsWith(join(route.control, 'prepared') + '/') || await fs.realpath(path).catch(() => path) !== path) throw new Error('Prepared cleanup ownership mismatch');
      await fs.rm(path, { recursive: true, force: true }); removed.push(path);
    }
    state.prepared = [];
    const roots = join(route.control, 'generations');
    for (const name of await fs.readdir(roots).catch(() => [])) {
      const parent = join(roots, name);
      const owner = await json(join(parent, 'ownership.json')).catch(() => null);
      if (!owner || owner.repositoryIdentity !== route.repositoryIdentity || owner.root !== join(parent, 'raf-main') || state.generations[owner.root] || await fs.realpath(parent) !== parent) continue;
      await fs.rm(parent, { recursive: true }); removed.push(owner.root);
    }
    await durable(join(route.control, 'registry.json'), state);
    return { removed, retained: [...retained] };
  });
}

export async function acquireHotfixReader(host: HotfixHost, _kind: HotfixReaderKind): Promise<HotfixReaderLease> {
  return locked(host, async route => {
    await reconcile(host, route);
    const state = await registry(host, route);
    const current = state.generations[state.current];
    if (await treeIdentity(current.root) !== current.fingerprint) throw new Error('Production generation fingerprint changed');
    const id = randomUUID();
    const path = join(route.control, 'readers', id + '.json');
    await durable(path, { root: current.root, pid: process.pid, start: await processStart(process.pid) });
    return { id, generationRoot: current.root, commit: current.commit, fingerprint: current.fingerprint, release: async () => { await fs.rm(path, { force: true }); } };
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
  if (!root.includes('/raf-hotfix/generations/')) return undefined;
  const route = await mainRoute(host);
  if (!root.startsWith(join(route.control, 'generations') + '/')) return undefined;
  return locked(host, async route => {
    const state: Registry = await json(join(route.control, 'registry.json'));
    const generation = state.generations[root];
    if (!generation || await treeIdentity(root) !== generation.fingerprint) throw new Error('Unregistered or changed production generation');
    const path = join(route.control, 'readers', randomUUID() + '.json');
    await durable(path, { root, pid: process.pid, start: await processStart(process.pid) });
    return { release: () => fs.rm(path, { force: true }) };
  });
}
