import { isAbsolute, normalize, relative, sep, join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseSandboxCommand } from './sandbox-test-run.ts';
import { prepareCodexSandbox, CodexSandboxUnavailable } from './codex-sandbox.ts';

const refuse = (message: string, code = 'CHANNEL_COMMAND_DENIED'): never => { throw Object.assign(new Error('Agent channel refused: ' + message), { code }); };
const within = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix === '' || suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix);
};
const absolute = (path: string): string => {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) refuse('noncanonical absolute path');
  return path;
};
const sameIdentity = (a: ChannelIdentity, b: ChannelIdentity): boolean =>
  (['agentId', 'runId', 'runnerSessionId'] as const).every(key => !!a[key] && a[key] === b[key]);
const sameGeneration = (a: PublishedChannelGeneration, b: PublishedChannelGeneration): boolean =>
  (['publicationId', 'slot', 'root', 'entrypoint', 'executable', 'commit', 'sourceFingerprint', 'buildFingerprint', 'catalogFingerprint'] as const).every(key => !!a[key] && a[key] === b[key]);

export type ChannelIdentity = Readonly<{
  agentId: string;
  runId: string;
  runnerSessionId: string;
}>;

export type AgentChannelGrant = Readonly<{
  identity: ChannelIdentity;
  issuedPrefix: string;
  issuedSlot: string;
  workspace: string;
  allowedSubcommands: readonly ("message" | "ps")[];
  routing: "trusted-facade" | "legacy";
}>;

export type PublishedChannelGeneration = Readonly<{
  publicationId: string;
  slot: string;
  root: string;
  entrypoint: string;
  executable: string;
  commit: string;
  sourceFingerprint: string;
  buildFingerprint: string;
  catalogFingerprint: string;
}>;

export type ChannelPublicationRegistry = Readonly<{
  revision: string;
  activePublicationId: string;
  publications: readonly PublishedChannelGeneration[];
}>;

export type ChannelGenerationLease = Readonly<{
  generation: PublishedChannelGeneration;
  release(): Promise<void>;
}>;

export type AgentChannelRequest = Readonly<{
  command: string;
  callerPid: number;
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export type ChannelCommandOutput = Readonly<{
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}>;

export type PinnedChannelExecution = Readonly<{
  generation: PublishedChannelGeneration;
  executable: string;
  argv: readonly string[];
  cwd: string;
  sender: ChannelIdentity;
  shell: false;
}>;

export interface AgentChannelPorts {
  verifyCaller(callerPid: number): Promise<ChannelIdentity | null>;
  loadGrant(identity: ChannelIdentity): Promise<AgentChannelGrant | null>;
  readPublicationRegistry(): Promise<ChannelPublicationRegistry>;
  pinGeneration(
    generation: PublishedChannelGeneration,
    registryRevision: string,
  ): Promise<ChannelGenerationLease>;
  executePinned(input: PinnedChannelExecution): Promise<ChannelCommandOutput>;
}

export async function routeAgentChannelCommand(
  request: AgentChannelRequest,
  ports: AgentChannelPorts,
): Promise<ChannelCommandOutput> {
  if (!Number.isSafeInteger(request.callerPid) || request.callerPid <= 0) refuse('caller PID', 'CALLER_UNVERIFIED');
  const identity = await ports.verifyCaller(request.callerPid);
  if (!identity) refuse('unverified caller', 'CALLER_UNVERIFIED');
  const grant = await ports.loadGrant(identity);
  if (!grant) refuse('grant missing', 'CHANNEL_GRANT_MISSING');
  if (!sameIdentity(identity, grant.identity)) refuse('grant identity mismatch', 'CALLER_UNVERIFIED');
  const prefix = parseSandboxCommand(grant.issuedPrefix);
  const words = parseSandboxCommand(request.command);
  if (!prefix?.length || !words || !prefix.every((word, index) => words[index] === word)) refuse('issued prefix or simple command mismatch');
  const args = words.slice(prefix.length);
  if (args[0] !== 'agent' || !grant.allowedSubcommands.includes(args[1] as 'message' | 'ps')) refuse('subcommand not granted');
  if (args[1] === 'ps') {
    if (args.length !== 2) refuse('agent ps arguments');
  } else if (args[1] === 'message') {
    if (args.length !== 6) refuse('agent message arguments');
    const options = new Map<string, string>();
    for (let index = 2; index < args.length; index += 2) {
      if (!['--to', '--text'].includes(args[index]) || options.has(args[index]) || !args[index + 1]) refuse('agent message options');
      options.set(args[index], args[index + 1]);
    }
    if (!options.has('--to') || !options.has('--text')) refuse('agent message options missing');
  } else refuse('unsupported command');
  const registry = await ports.readPublicationRegistry();
  const candidates = registry.publications.filter(value => value.publicationId === registry.activePublicationId);
  if (!registry.revision || candidates.length !== 1) refuse('unpublished or ambiguous generation', 'CHANNEL_PUBLICATION_UNVERIFIED');
  const generation = structuredClone(candidates[0]);
  absolute(generation.root);
  absolute(generation.entrypoint);
  absolute(generation.executable);
  if (!within(generation.root, generation.entrypoint) || generation.root === generation.entrypoint ||
      !(['publicationId', 'slot', 'commit', 'sourceFingerprint', 'buildFingerprint', 'catalogFingerprint'] as const).every(key => !!generation[key])) refuse('incomplete published snapshot', 'CHANNEL_PUBLICATION_UNVERIFIED');
  if (grant.routing === 'legacy' && generation.slot !== grant.issuedSlot) refuse('legacy channel holds its issued slot');
  if (grant.routing !== 'trusted-facade' && grant.routing !== 'legacy') refuse('unknown routing');
  const lease = await ports.pinGeneration(generation, registry.revision);
  try {
    if (!sameGeneration(generation, lease.generation)) refuse('pinned snapshot mismatch', 'CHANNEL_SNAPSHOT_MISMATCH');
    return await ports.executePinned({ generation, executable: generation.executable,
      argv: [generation.entrypoint, ...args], cwd: grant.workspace, sender: { ...identity }, shell: false });
  } finally { await lease.release(); }
}

export type ChannelSlotReader = Readonly<{
  id: string;
  slot: string;
  live: boolean;
  kind: "operation" | "legacy-channel" | "redirectable-channel";
  safeRouting: boolean;
}>;

export type ChannelSlotReuse = Readonly<{
  reusable: boolean;
  blockingReaderIds: readonly string[];
}>;

export function assessAgentChannelSlotReuse(input: Readonly<{
  slot: string;
  readers: readonly ChannelSlotReader[];
}>): ChannelSlotReuse {
  const blockingReaderIds = [...new Set(input.readers.filter(reader => reader.live && reader.slot === input.slot &&
    (reader.kind !== 'redirectable-channel' || !reader.safeRouting)).map(reader => reader.id))];
  return { reusable: blockingReaderIds.length === 0, blockingReaderIds };
}

export type AgentNativePolicyInput = Readonly<{
  mainCopies: readonly [string, string];
  logicalMain: string;
  activationMetadata: readonly string[];
  writableRoots: readonly string[];
  exactWritableFiles: readonly string[];
  denyReadPaths: readonly string[];
  denyConnectPaths: readonly string[];
  issuedCommandPrefixes: readonly string[];
}>;

export type AgentNativePolicy = Readonly<{
  providerRequired: true;
  readOnlyPaths: readonly string[];
  writableRoots: readonly string[];
  exactWritableFiles: readonly string[];
  denyReadPaths: readonly string[];
  denyConnectPaths: readonly string[];
  issuedCommandPrefixes: readonly string[];
}>;

export interface AgentNativePolicyPorts {
  canonicalPath(path: string): Promise<string>;
}

export async function compileAgentChannelNativePolicy(
  input: AgentNativePolicyInput,
  ports: AgentNativePolicyPorts,
): Promise<AgentNativePolicy> {
  const expand = async (paths: readonly string[]): Promise<string[]> => {
    const expanded: string[] = [];
    for (const path of paths) {
      const source = absolute(path);
      const target = absolute(await ports.canonicalPath(source));
      if (source === '/' || target === '/') refuse('policy root is too broad');
      expanded.push(source, target);
    }
    return [...new Set(expanded)];
  };
  if (input.mainCopies.length !== 2 || input.mainCopies[0] === input.mainCopies[1]) refuse('two distinct main copies required');
  const copies = await Promise.all(input.mainCopies.map(path => ports.canonicalPath(absolute(path))));
  if (copies[0] === copies[1]) refuse('main copies alias each other');
  const readOnlyPaths = await expand([...input.mainCopies, input.logicalMain, ...input.activationMetadata]);
  const writableRoots = await expand(input.writableRoots);
  const exactWritableFiles = await expand(input.exactWritableFiles);
  const denyReadPaths = await expand(input.denyReadPaths);
  const denyConnectPaths = await expand(input.denyConnectPaths);
  const protectedPaths = [...readOnlyPaths, ...denyReadPaths, ...denyConnectPaths];
  for (const writable of [...writableRoots, ...exactWritableFiles]) {
    if (protectedPaths.some(path => within(path, writable))) refuse('writable alias overlaps protected path');
  }
  for (const prefix of input.issuedCommandPrefixes) {
    const words = parseSandboxCommand(prefix);
    if (!words?.length) refuse('invalid issued command prefix');
  }
  return { providerRequired: true, readOnlyPaths, writableRoots, exactWritableFiles, denyReadPaths,
    denyConnectPaths, issuedCommandPrefixes: [...input.issuedCommandPrefixes] };
}

export type NativeChannelProbeRequest = Readonly<{
  policy: AgentNativePolicy;
  executable: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export async function runAgentChannelNativeProbe(
  input: NativeChannelProbeRequest,
): Promise<ChannelCommandOutput> {
  if (input.policy.providerRequired !== true) throw new CodexSandboxUnavailable('Native provider is required');
  const runDirectory = await mkdtemp(join(tmpdir(), 'raf-channel-native-'));
  let sandbox: Awaited<ReturnType<typeof prepareCodexSandbox>> | undefined;
  try {
    const environment = { ...process.env };
    if (Object.entries(input.env).some(([key, value]) => !key || /[=\0]/.test(key) || value.includes('\0'))) refuse('invalid native target environment');
    const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
    const timeoutMs = settings.runnerProtocols.find((protocol: { runner: string }) => protocol.runner === 'codex')?.timeouts.transitionMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CodexSandboxUnavailable('Configured native probe deadline is required');
    sandbox = await prepareCodexSandbox({ runId: randomUUID(), cwd: input.cwd, runDirectory,
      invocation: { executable: 'codex', args: ['--sandbox', 'workspace-write'] },
      scope: { hidden: [...input.policy.denyReadPaths, ...input.policy.denyConnectPaths],
        readable: input.policy.readOnlyPaths, tmuxDirectory: runDirectory, excludedCommands: [] },
      writableDirectories: [...input.policy.writableRoots, ...input.policy.exactWritableFiles],
      readOnlyDirectories: input.policy.readOnlyPaths, environment, timeoutMs });
    return await new Promise<ChannelCommandOutput>((resolve, reject) => {
      const child = spawn(sandbox!.toolSandbox.executable, [...sandbox!.toolSandbox.args, '/usr/bin/env', ...Object.entries(input.env).map(([key, value]) => key + '=' + value), input.executable, ...input.argv],
        { cwd: input.cwd, env: sandbox!.environment, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) reject(new CodexSandboxUnavailable('Native probe exceeded configured transition deadline'));
        else if (signal) reject(new Error('Native probe terminated: ' + signal));
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 1 });
      });
    });
  } finally {
    await sandbox?.cleanup();
    await rm(runDirectory, { recursive: true, force: true });
  }
}
