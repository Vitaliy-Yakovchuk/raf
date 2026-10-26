import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireHotfixReader } from './hotfix-activation.ts';
import { mainRoute } from './hotfix-host.ts';
import { executeCommand, observeProcesses, readMachineBootIdentity } from './os-runtime.ts';
import { parseSandboxCommand } from './sandbox-test-run.ts';
import { productionStateContext } from './state-migration-guard.ts';
import { openStateStore } from './state-store.ts';

export interface PublishedAgentChannelContext {
  readonly orchestratorRoot: string;
  readonly homeDirectory: string;
  readonly runId: string;
  readonly agentId: string;
}

export interface PublishedAgentChannelRequest extends PublishedAgentChannelContext {
  readonly cwd: string;
  readonly issuedCommands: readonly string[];
  readonly command: string;
}

function refuse(reason: string): never {
  throw Object.assign(new Error('Agent channel refused: ' + reason), { code: 'CHANNEL_COMMAND_DENIED' });
}

async function verifyCaller(input: PublishedAgentChannelRequest): Promise<void> {
  const context = productionStateContext(input.orchestratorRoot, fileURLToPath(import.meta.url), input.homeDirectory, 'hook');
  const store = openStateStore(context.statePath, { context });
  try {
    const sessions = store.sessionRepository.transaction(tx => tx.listSessions(), 'read');
    const scan = await executeCommand({ executable: 'ps', args: ['-ww', '-axo', 'pid=,ppid='] });
    if (scan.exitCode !== 0) refuse('caller ancestry unavailable');
    const parents = new Map(scan.stdout.split('\n').filter(line => line.trim()).map(line => {
      const row = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!row) refuse('invalid caller ancestry');
      return [Number(row[1]), Number(row[2])] as const;
    }));
    const seen = new Set<number>();
    for (let pid = process.pid; pid && !seen.has(pid); pid = parents.get(pid) ?? 0) {
      seen.add(pid);
      const claims = sessions.filter(session => session.state === 'running' && session.process?.pid === pid);
      if (!claims.length) continue;
      if (claims.length !== 1) refuse('ambiguous caller claim');
      const session = claims[0];
      const identity = session.process!;
      if (session.state !== 'running' || session.runId !== input.runId || session.addressId !== input.agentId ||
          session.activity?.cwd !== input.cwd || !session.launchContext) refuse('caller differs from issued channel');
      const boot = await readMachineBootIdentity();
      if (identity.evidence.bootId !== boot.bootId || identity.evidence.machineId !== boot.machineId ||
          (await observeProcesses([identity]))[0].state !== 'alive') refuse('caller process identity changed');
      return;
    }
    refuse('no registered live caller');
  } finally { store.close(); }
}

export async function runPublishedAgentChannel(input: PublishedAgentChannelRequest): Promise<number> {
  input = structuredClone(input);
  if (![input.orchestratorRoot, input.homeDirectory, input.cwd].every(path => isAbsolute(path) && resolve(path) === path) ||
      !input.runId || !input.agentId) refuse('invalid issued context');
  const words = parseSandboxCommand(input.command);
  const entrypoint = fileURLToPath(new URL('../bin/raf.ts', import.meta.url));
  const issued = input.issuedCommands.map(prefix => parseSandboxCommand(prefix));
  if (issued.some(prefix => !prefix || prefix.length < 2 || !['node', process.execPath].includes(prefix[0]) || prefix[1] !== entrypoint)) refuse('untrusted issued prefix');
  if (!words || !issued.some(prefix => prefix!.every((word, index) => words[index] === word))) refuse('command is outside issued scope');
  await verifyCaller(input);
  const lease = await acquireHotfixReader({ orchestratorRoot: input.orchestratorRoot,
    qaHome: input.homeDirectory, environment: {}, sandboxExecutable: 'codex' }, 'hook');
  try {
    const environment = { ...process.env, HOME: input.homeDirectory, RAF_ORCHESTRATOR_ROOT: input.orchestratorRoot };
    for (const key of Object.keys(environment)) if (key.startsWith('GIT_') || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete environment[key];
    return await new Promise<number>((resolveExit, reject) => {
      const child = spawn(process.execPath, [join(lease.generationRoot, 'bin/raf.ts'), ...words.slice(2)],
        { cwd: input.cwd, env: environment, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
    });
  } finally { await lease.release(); }
}

export async function agentChannelReadOnlyPaths(orchestratorRoot: string, homeDirectory: string): Promise<string[]> {
  const host = { orchestratorRoot, qaHome: homeDirectory, environment: {}, sandboxExecutable: 'codex' };
  const route = await mainRoute(host);
  const configuration = JSON.parse(await fs.readFile(join(orchestratorRoot, 'conf/projects.json'), 'utf8')).projects.raf;
  const logical = resolve(orchestratorRoot, configuration.branchPaths.main);
  const copies = configuration.mainCopies;
  if (copies !== undefined && (!Array.isArray(copies) || copies.length !== 2 || new Set(copies).size !== 2 ||
      copies.some((copy: unknown) => typeof copy !== 'string' || !copy || isAbsolute(copy) || copy.split('/').some(part => ['', '.', '..', '.git'].includes(part))))) refuse('invalid main copies');
  const roots = copies ? copies.map((copy: string) => resolve(orchestratorRoot, copy)) : [route.cwd];
  return [...new Set([logical, ...roots, join(orchestratorRoot, '.gitmodules'), route.control])];
}
