import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRafTemporarySocketEndpoint } from './raf-temporary-socket.ts';
import { pathToFileURL } from 'node:url';
import { command, durable, environment, exists, git, hostGit, hotfixRoute, inventory, json, mainRoute, validateWorkspace, withHotfixWriter, within } from './hotfix-host.ts';

export type HotfixRunner = "codex" | "claude";

export interface HotfixHost {
  orchestratorRoot: string;
  qaHome: string;
  environment: Readonly<Record<string, string>>;
  sandboxExecutable: string;
}

export interface HotfixWorkspace {
  runId: string;
  orchestratorRoot: string;
  project: "raf";
  targetBranch: "main";
  cwd: string;
  baseCommit: string;
  repositoryIdentity: string;
  gitDirectory: string;
  commonDirectory: string;
  ownershipPath: string;
}

export interface HotfixLaunchRequest {
  runId: string;
  addressId: string;
  features: readonly string[];
  tasks: readonly string[];
  runner: HotfixRunner;
  origin: "agent-run" | "direct-main";
}

export interface HotfixLaunch {
  workspace: HotfixWorkspace;
  runId: string;
  pid: number;
  workerPid: number;
  reportPath: string;
  briefPath: string;
  taskContextPath: string;
  workerContextPath: string;
  invocationPath: string;
  trustTranscriptPath: string;
  runnerSessionId: string;
}

export interface HotfixCommand {
  executable: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}

export interface HotfixCommandResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface HotfixCommitRequest {
  workspace: HotfixWorkspace;
  paths: readonly string[];
  message: string;
}

export interface HotfixCommit {
  commit: string;
  tree: string;
  workspace: HotfixWorkspace;
}

export interface HotfixCleanupResult {
  removed: readonly string[];
  retained: readonly string[];
}

export async function prepareHotfixWorktree(host: HotfixHost, runId: string): Promise<HotfixWorkspace> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '..') throw new Error('Invalid hotfix runId');
  return withHotfixWriter(host, async () => {
    const route = await mainRoute(host);
    const { cwd, gitDirectory } = await hotfixRoute(host);
    const baseCommit = await git(route.cwd, 'rev-parse', 'HEAD');
    if (route.productionDirectory !== route.repositoryIdentity) await git(cwd, 'fetch', '--no-tags', '--no-write-fetch-head', route.productionDirectory, baseCommit);
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (await exists(join(gitDirectory, marker))) throw new Error('Hotfix preparation has unfinished Git operation: ' + marker);
    }
    const included = await git(cwd, 'merge-base', '--is-ancestor', baseCommit, 'HEAD').then(() => true, () => false);
    if (!included) {
      if (await git(cwd, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Dirty hotfix workspace/index; main must coordinate writers before refresh');
      await hostGit(host, cwd, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-edit', baseCommit);
    }
    if (await git(route.cwd, 'rev-parse', 'HEAD') !== baseCommit) throw new Error('Main changed during hotfix preparation; refresh again before launch');
    const run = join(host.orchestratorRoot, '.raf-hotfix', 'runs', runId);
    const workspace: HotfixWorkspace = { runId, orchestratorRoot: host.orchestratorRoot, project: 'raf', targetBranch: 'main', cwd, baseCommit, repositoryIdentity: route.repositoryIdentity, gitDirectory, commonDirectory: route.repositoryIdentity, ownershipPath: join(run, 'ownership.json') };
    await validateWorkspace(host, workspace);
    await inventory(cwd);
    await fs.mkdir(dirname(run), { recursive: true, mode: 0o700 });
    await fs.mkdir(run, { mode: 0o700 });
    await durable(workspace.ownershipPath, workspace);
    return workspace;
  });
}

export async function launchHotfix(host: HotfixHost, request: HotfixLaunchRequest): Promise<HotfixLaunch> {
  const route = await mainRoute(host);
  await hotfixRoute(host);
  if (!['codex', 'claude'].includes(request.runner) || !['agent-run', 'direct-main'].includes(request.origin)) throw new Error('Invalid hotfix launch');
  const module = pathToFileURL(join(route.cwd, 'src/production-entry.ts')).href;
  const args = ['agent', 'run', '--id', request.addressId, '--type', 'hotfix', '--project', 'raf', '--phase', 'implement', '--complexity', 'decision', ...request.features.flatMap(value => ['--features', value]), ...request.tasks.flatMap(value => ['--tasks', value])];
  const options = { orchestratorRoot: host.orchestratorRoot, homeDirectory: host.qaHome, artifactPath: join(route.cwd, 'dist/catalog.json'), runIdentity: { runId: request.runId, tmuxSession: 'hotfix-' + request.runId } };
  const script = `const {runProductionCli}=await import(${JSON.stringify(module)}); const options=${JSON.stringify(options)}; const {productionStateContext}=await import(${JSON.stringify(pathToFileURL(join(route.cwd, 'src/state-migration-guard.ts')).href)}); const {openStateStore}=await import(${JSON.stringify(pathToFileURL(join(route.cwd, 'src/state-store.ts')).href)}); const proof=productionStateContext(options.orchestratorRoot,${JSON.stringify(join(route.cwd, 'src/production-entry.ts'))},options.homeDirectory,'cli'); if(proof.mode!=='qa')throw new Error('Hotfix host requires isolated QA HOME'); const store=openStateStore(proof.statePath,{context:proof});try{for(const runner of ${JSON.stringify((await json(join(host.orchestratorRoot, 'conf/models.json'))).runners.map((row: { id: string }) => row.id))})store.setRunnerEnabled(runner,runner===${JSON.stringify(request.runner)});}finally{store.close();} const result=await runProductionCli(${JSON.stringify(args)},options); if(result.stdout) console.log(result.stdout); if(result.stderr) console.error(result.stderr); process.exitCode=result.exitCode;`;
  const result = await command(host, route.cwd, process.execPath, ['--input-type=module', '-e', script]);
  if (result.code !== 0) throw new Error('Hotfix production launch failed: ' + result.stderr);
  const output = JSON.parse(result.stdout.trim());
  if (output.selection?.runner !== request.runner) throw new Error('Hotfix selected runner differs from requested runner');
  const runDirectory = dirname(output.reportPath);
  const manifest = await json(join(runDirectory, 'runtime.json'));
  const workspace = manifest.workspaceRoute?.hotfix;
  await validateWorkspace(host, workspace);
  return { workspace, runId: output.runId, pid: output.process.pid, workerPid: (await json(join(dirname(workspace.ownershipPath), 'launch.json'))).pid, reportPath: output.reportPath, briefPath: join(runDirectory, 'brief.txt'), taskContextPath: join(runDirectory, 'task-context.json'), workerContextPath: join(runDirectory, 'runtime.json'), invocationPath: join(runDirectory, 'invocation.json'), trustTranscriptPath: join(runDirectory, 'trust.json'), runnerSessionId: output.process.runnerSessionId };
}

export async function runHotfixSandboxCommand(host: HotfixHost, workspace: HotfixWorkspace, input: HotfixCommand): Promise<HotfixCommandResult> {
  await validateWorkspace(host, workspace);
  const inspect = async (directory: string): Promise<void> => {
    for (const name of await fs.readdir(directory)) {
      if (directory === workspace.cwd && ['.git', 'node_modules'].includes(name)) continue;
      const path = join(directory, name);
      const info = await fs.lstat(path);
      if (info.isDirectory()) await inspect(path);
      else if (info.isFile() && info.nlink !== 1) throw new Error('Hotfix hardlink alias denied: ' + path);
    }
  };
  try { await inspect(workspace.cwd); } catch (error) { return { code: 1, signal: null, stdout: '', stderr: 'EACCES: snapshot alias denied: ' + String(error) }; }
  const { prepareCodexSandbox } = await import('./codex-sandbox.ts');
  const own = join(host.qaHome, '.raf', 'tmp', workspace.runId);
  await fs.mkdir(own, { recursive: true, mode: 0o700 });
  const directory = join(own, 'sandbox-' + (await import('node:crypto')).randomUUID());
  await fs.mkdir(directory, { mode: 0o700 });
  const prepared = await prepareCodexSandbox({ runId: workspace.runId, invocation: { executable: host.sandboxExecutable, args: ['--sandbox', 'workspace-write'], liveTaskVerified: false }, scope: { hidden: [join(host.qaHome, '.raf', 'secrets.json')], readable: [own], tmuxDirectory: directory, excludedCommands: [] }, cwd: workspace.cwd, runDirectory: own, writableDirectories: [workspace.cwd, own], readOnlyDirectories: [workspace.commonDirectory, join(workspace.cwd, '.git')], environment: environment(host) });
  try { return await command(host, workspace.cwd, prepared.toolSandbox.executable, [...prepared.toolSandbox.args, input.executable, ...input.args], { ...prepared.environment, ...input.environment }); }
  finally { await prepared.cleanup(); await fs.rm(directory, { recursive: true, force: true }); }
}

export async function commitHotfix(host: HotfixHost, request: HotfixCommitRequest): Promise<HotfixCommit> {
  return withHotfixWriter(host, async () => {
  const { workspace, paths, message } = request;
  await validateWorkspace(host, workspace);
  if (!paths.length || !message.trim()) throw new Error('Explicit hotfix paths and commit message required');
  const selected = new Set<string>();
  for (const path of paths) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some(part => ['.', '..', '.git', ''].includes(part)) || path.startsWith('-') || path.includes('\0')) throw new Error('Unsafe hotfix commit path: ' + path);
    const absolute = resolve(workspace.cwd, path);
    if (!within(workspace.cwd, absolute)) throw new Error('Hotfix path escapes workspace');
    if ((await fs.lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.isDirectory()) throw new Error('Explicit hotfix file paths required');
    let current = absolute;
    while (current !== workspace.cwd) {
      const info = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info?.isSymbolicLink() || info?.isFile() && info.nlink !== 1) throw new Error('Hotfix commit alias refused');
      current = dirname(current);
    }
    selected.add(path);
  }
  await inventory(workspace.cwd);
  const staged = (await git(workspace.cwd, 'diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean);
  if (staged.some(path => !selected.has(path))) throw new Error('Foreign staged hotfix paths');
  if (staged.length && await git(workspace.cwd, '--literal-pathspecs', 'diff', '--name-only', '--', ...staged)) throw new Error('Shared staged hunks require coordination; index preserved');
  await hostGit(host, workspace.cwd, '--literal-pathspecs', 'add', '-f', '--', ...paths);
  await hostGit(host, workspace.cwd, '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message, '--', ...paths);
  return { commit: await git(workspace.cwd, 'rev-parse', 'HEAD'), tree: await git(workspace.cwd, 'rev-parse', 'HEAD^{tree}'), workspace };
  });
}

export async function cleanupHotfixWorktree(host: HotfixHost, workspace: HotfixWorkspace): Promise<HotfixCleanupResult> {
  await validateWorkspace(host, workspace);
  const run = dirname(workspace.ownershipPath);
  if (!await exists(run)) return { removed: [], retained: [workspace.cwd] };
  const owner = await json(workspace.ownershipPath);
  if (JSON.stringify(owner) !== JSON.stringify(workspace) || await fs.realpath(run) !== run) throw new Error('Hotfix cleanup run identity mismatch');
  const activity = await json(join(run, 'launch.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (activity) {
    const { alive } = await import('./hotfix-host.ts');
    if (await alive(activity.pid, activity.start)) return { removed: [], retained: [workspace.cwd, run] };
  }
  await fs.rm(run, { recursive: true });
  return { removed: [run], retained: [workspace.cwd] };
}

export async function validateHotfixTrust(orchestratorRoot: string, cwd: string, workspace: HotfixWorkspace): Promise<boolean> {
  try {
    if (cwd !== workspace.cwd) return false;
    await validateWorkspace({ orchestratorRoot, qaHome: '', environment: {}, sandboxExecutable: '' }, workspace);
    return true;
  } catch { return false; }
}

export async function startHotfixCommitPort(host: HotfixHost, workspace: HotfixWorkspace, directory: string): Promise<{ close(): Promise<void> }> {
  const { createServer } = await import('node:net');
  await validateWorkspace(host, workspace);
  const { processStart } = await import('./hotfix-host.ts');
  await durable(join(dirname(workspace.ownershipPath), 'launch.json'), { pid: process.pid, start: await processStart(process.pid) });
  const endpoint = await createRafTemporarySocketEndpoint({ runId: workspace.runId, directory, basename: 'hotfix-commit.sock', serverCwd: workspace.cwd, clientCwd: workspace.cwd });
  const socketPath = endpoint.bind.address;
  let chain = Promise.resolve();
  const server = createServer(socket => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 1024 * 1024) socket.destroy();
      if (!input.endsWith('\n')) return;
      socket.pause();
      chain = chain.then(async () => {
        try {
          const request = JSON.parse(input);
          if (!Array.isArray(request.paths) || !request.paths.every(path => typeof path === 'string') || typeof request.message !== 'string') throw new Error('Invalid hotfix commit request');
          socket.end(JSON.stringify(await commitHotfix(host, { workspace, paths: request.paths, message: request.message })) + '\n');
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n'); }
      });
    });
  });
  try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  const clientDirectory = await fs.realpath(dirname(socketPath));
  const clientIdentity = await fs.lstat(clientDirectory);
  const clientProgram = `import {connect} from 'node:net'; const request=JSON.parse(process.argv[1]); const socket=connect('hotfix-commit.sock'); socket.on('connect',()=>socket.write(JSON.stringify(request)+'\\n')); let value=''; socket.on('data',chunk=>value+=chunk);socket.on('end',()=>{const result=JSON.parse(value);if(result.error){console.error(result.error);process.exitCode=1}else console.log(JSON.stringify(result));});socket.on('error',error=>{console.error(error.message);process.exitCode=1});`;
  const source = `import {lstat,realpath} from 'node:fs/promises'; import {spawn} from 'node:child_process'; const args=process.argv.slice(2); if(args[0]!=='--message'||!args[1]||args.length<3)throw new Error('Expected --message text paths'); if(process.cwd()!==${JSON.stringify(workspace.cwd)})throw new Error('Hotfix client workspace mismatch'); const directory=${JSON.stringify(clientDirectory)}; const info=await lstat(directory); if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o077)!==0||info.dev!==${clientIdentity.dev}||info.ino!==${clientIdentity.ino}||await realpath(directory)!==directory)throw new Error('Hotfix client socket directory identity mismatch'); const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(clientProgram)},JSON.stringify({message:args[1],paths:args.slice(2)})],{cwd:directory,stdio:'inherit'});child.on('error',error=>{console.error(error.message);process.exitCode=1});child.on('exit',(code,signal)=>{process.exitCode=code??1});`;
  await fs.writeFile(join(directory, 'hotfix-commit.mjs'), source, { flag: 'wx', mode: 0o500 });
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await endpoint.cleanup().catch(() => undefined);
    throw error;
  }
  return { close: async () => { await chain; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await endpoint.cleanup(); } };
}
