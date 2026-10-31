import { recordProductionSandboxProtection } from './main-production-store.ts';
import { createRafToolSocketDirectory, socketPathFits } from './raf-temporary-socket.ts';
import type { Invocation, NativeSandboxScope } from './runner-protocols.ts';
import { codexInvocationSandboxMode } from './codex-raf-command-access.ts';
import { promises as fs, constants } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface CodexSandboxRequest {
  readonly runId: string;
  readonly invocation: Invocation;
  readonly scope: NativeSandboxScope;
  readonly cwd: string;
  readonly runDirectory: string;
  readonly readOnlyDirectories?: readonly string[];
  readonly writableDirectories: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface PreparedCodexSandbox {
  readonly invocation: Invocation;
  readonly environment: Readonly<Record<string, string>>;
  readonly toolSandbox: Invocation;
  readonly policyPaths: readonly string[];
  cleanup(): Promise<void>;
}

export class CodexSandboxUnavailable extends Error {
  readonly code = 'CODEX_SANDBOX_UNAVAILABLE';
}

const unavailable = (reason: string): never => { throw new CodexSandboxUnavailable(`Codex sandbox isolation unavailable: ${reason}`); };
const within = (root: string, path: string) => { const suffix = relative(root, path); return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`); };
const scrubbed = ['TMUX', 'TMUX_PANE', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID'];
const literal = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const architectures: Partial<Record<string, { audit: number; socket: number; ioUringSetup: number; x32: boolean }>> = {
  x64: { audit: 0xc000003e, socket: 41, ioUringSetup: 425, x32: true },
  arm64: { audit: 0xc00000b7, socket: 198, ioUringSetup: 425, x32: false },
};
const socketFamilies = { AF_UNIX: 1, AF_INET: 2, AF_INET6: 10 } as const;

async function canonical(path: string): Promise<string> {
  if (!isAbsolute(path)) unavailable(`path ${path} is not absolute`);
  const missing: string[] = [];
  let ancestor = resolve(path);
  for (;;) {
    try { return resolve(await fs.realpath(ancestor), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable(`cannot resolve sandbox path ${path}`);
      const entry = await fs.lstat(ancestor).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable(`cannot inspect sandbox path ${path}`);
        return null;
      });
      if (entry?.isSymbolicLink() || dirname(ancestor) === ancestor) unavailable(`cannot resolve sandbox path ${path}`);
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

export async function protectCodexReadOnlyPaths(
  original: Readonly<Record<string, string>>,
  readOnlyPaths: readonly string[],
  writableFiles: readonly string[] = [],
): Promise<{ filesystem: Record<string, string>; writableFiles: string[]; symlinkParents: string[] }> {
  const filesystem = { ...original };
  const targets = await Promise.all(readOnlyPaths.map(async path => {
    const source = resolve(path);
    let target = await canonical(path);
    while (!await fs.lstat(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    })) target = dirname(target);
    return { source, target };
  }));
  const protectedPath = (path: string) => targets.some(value => within(value.target, path) || within(value.source, path));
  const parents = new Set<string>();
  for (const { source } of targets) {
    let cursor = dirname(source);
    const ancestors = [source];
    while (dirname(cursor) !== cursor) { ancestors.unshift(cursor); cursor = dirname(cursor); }
    for (const path of ancestors) {
      const entry = await fs.lstat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      });
      if (!entry) break;
      if (entry.isSymbolicLink()) { parents.add(await canonical(dirname(path))); break; }
    }
  }
  const accessAt = (path: string): string => Object.entries(original)
    .map(([root, access]) => [root === ':root' ? '/' : root === ':slash_tmp' ? '/tmp' : root, access])
    .filter(([root]) => isAbsolute(root) && within(root, path))
    .sort(([left], [right]) => right.length - left.length)[0]?.[1] ?? 'none';
  const files = new Set(writableFiles.filter(path => !protectedPath(path)));
  const symlinkParents = [...parents].sort((left, right) => left.length - right.length);
  for (const parent of symlinkParents) {
    if (accessAt(parent) === 'write') {
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        const path = join(parent, entry.name);
        if (entry.isSymbolicLink() || protectedPath(path) || accessAt(path) !== 'write') continue;
        if (entry.isDirectory()) filesystem[path] = 'write';
        else if (entry.isFile()) files.add(path);
      }
    }
    filesystem[parent] = 'read';
  }
  for (const { source, target } of targets) {
    if (source !== target) delete filesystem[source];
    filesystem[target] = 'read';
  }
  for (const [path, access] of Object.entries(filesystem)) {
    if (isAbsolute(path) && access !== 'none' && targets.some(({ target }) => path !== target && within(target, path))) delete filesystem[path];
  }
  return { filesystem, writableFiles: [...files], symlinkParents };
}

export function codexBwrapWrapper(bwrap: string, networkFilterPath: string, tmuxSockets: string, writableFiles: readonly string[]): string {
  return [
    '#!/bin/bash',
    'mounted=0',
    'for argument do',
    '  shift',
    `  if [ "$mounted" = 0 ] && [ "$argument" = -- ]; then set -- "$@" --perms 0700 --tmpfs ${literal(tmuxSockets)} ${writableFiles.map(path => `--bind ${literal(path)} ${literal(path)}`).join(' ')} --; mounted=1; else set -- "$@" "$argument"; fi`,
    'done',
    `exec {raf_network_fd}<${literal(networkFilterPath)}`,
    `exec ${literal(bwrap)} --add-seccomp-fd "$raf_network_fd" "$@"`,
    '',
  ].join('\n');
}

async function workspaceGitPaths(cwd: string): Promise<string[]> {
  const dotGit = join(cwd, '.git');
  const entry = await fs.stat(dotGit).catch(() => null);
  if (!entry) return [];
  if (entry.isDirectory()) return [await canonical(dotGit)];
  const value = (await fs.readFile(dotGit, 'utf8')).trim();
  if (!value.startsWith('gitdir:')) unavailable(`invalid workspace git pointer ${dotGit}`);
  const git = await canonical(resolve(cwd, value.slice('gitdir:'.length).trim()));
  const common = await fs.readFile(join(git, 'commondir'), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '';
  });
  return [...new Set([dotGit, git, ...(common.trim() ? [await canonical(resolve(git, common.trim()))] : [])])];
}

async function executable(name: string, environment: Readonly<Record<string, string | undefined>>, exclude: string): Promise<string> {
  const candidates = isAbsolute(name) ? [name] : (environment.PATH ?? '').split(delimiter).filter(directory => isAbsolute(directory) && directory !== exclude && !directory.split(sep).some(part => part.startsWith('codex-sandbox-'))).map(directory => join(directory, name));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return unavailable(`${name} executable is not available`);
}

function sshAgentAddresses(environment: Readonly<Record<string, string | undefined>>): string[] {
  const path = environment.SSH_AUTH_SOCK;
  return path && isAbsolute(path) ? [path] : [];
}

function networkFilter(): Buffer {
  const arch = architectures[process.arch] ?? unavailable(`no network filter for architecture ${process.arch}`);
  const allow = 0x7fff0000, deny = 0x00050000 | 13;
  const families = Object.values(socketFamilies);
  const program: [number, number, number, number][] = [
    [0x20, 0, 0, 4],
    [0x15, 0, 6 + families.length, arch.audit],
    [0x20, 0, 0, 0],
    arch.x32 ? [0x35, 4 + families.length, 0, 0x40000000] : [0x15, 0, 0, 0xffffffff],
    [0x15, 3 + families.length, 0, arch.ioUringSetup],
    [0x15, 0, 1 + families.length, arch.socket],
    [0x20, 0, 0, 16],
    ...families.map((family, index): [number, number, number, number] => [0x15, families.length - 1 - index, index === families.length - 1 ? 1 : 0, family]),
    [0x06, 0, 0, allow],
    [0x06, 0, 0, deny],
  ];
  const filter = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], index) => {
    filter.writeUInt16LE(code, index * 8);
    filter.writeUInt8(jt, index * 8 + 2);
    filter.writeUInt8(jf, index * 8 + 3);
    filter.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return filter;
}

export async function prepareCodexSandbox(
  request: CodexSandboxRequest,
): Promise<PreparedCodexSandbox> {
  if (!/^[A-Za-z0-9_-]+$/u.test(request.runId)) unavailable('invalid run id');
  const mode = codexInvocationSandboxMode(request.invocation.args);
  if (mode !== 'workspace-write') unavailable(`invocation sandbox mode ${mode ?? 'unset'} is not workspace-write`);
  const cwd = await canonical(request.cwd);
  const runDirectory = await canonical(request.runDirectory);
  const writable = new Set<string>([runDirectory]);
  const args: string[] = [];
  const source = request.invocation.args;
  const end = source.indexOf('--');
  for (let i = 0; i < (end < 0 ? source.length : end); i++) {
    const arg = source[i];
    if (arg === '--sandbox' || arg === '-s') { i++; continue; }
    if (arg === '--add-dir') { const value = source[++i] ?? unavailable('--add-dir without a directory'); writable.add(await canonical(value)); continue; }
    if (arg.startsWith('--sandbox=') || arg === '--full-auto') continue;
    if (arg.startsWith('--add-dir=')) { writable.add(await canonical(arg.slice('--add-dir='.length))); continue; }
    if ((arg === '-c' || arg === '--config') && /^\s*(?:sandbox_mode|default_permissions|permissions|sandbox_workspace_write)\b/u.test(source[i + 1] ?? '')) { i++; continue; }
    args.push(arg);
  }
  if (!args.includes('--no-daemon')) args.unshift('--no-daemon');
  for (const directory of request.writableDirectories) writable.add(await canonical(directory));
  const readOnlyDirectories = [...(request.readOnlyDirectories ?? [])];
  const hidden = new Set<string>();
  const accountHome = (() => { try { return userInfo().homedir; } catch { return undefined; } })();
  const secrets = accountHome && isAbsolute(accountHome) ? [join(accountHome, '.raf', 'secrets.json')] : [];
  for (const path of [...secrets, ...request.scope.hidden, ...sshAgentAddresses(request.environment)]) {
    if (!isAbsolute(path)) continue;
    hidden.add(path);
    hidden.add(await canonical(path));
  }
  const existingHidden: string[] = [];
  const codexPlugins = join(request.environment.CODEX_HOME || join(request.environment.HOME || '/srv/dev', '.codex'), 'plugins');
  for (const path of [...hidden, codexPlugins]) {
    if (path !== await canonical(path)) continue;
    try { await fs.stat(path); existingHidden.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable(`cannot inspect hidden host resource ${path}`); }
  }
  const masked = existingHidden.filter(path => !existingHidden.some(other => other !== path && within(other, path)));
  const directory = join(runDirectory, `codex-sandbox-${request.runId}`);
  const codex = await executable(request.invocation.executable, request.environment, directory);
  const darwin = process.platform === 'darwin';
  const profile = darwin ? 'darwin' : 'linux';
  const bwrap = darwin ? undefined : await executable('/usr/bin/bwrap', request.environment, directory);
  const filter = darwin ? undefined : networkFilter();
  const sharedTmp = !within('/tmp', directory);
  let entries: Record<string, string> = { ':root': 'read', ...(sharedTmp ? { ':slash_tmp': 'write' } : {}) };
  const compactToolTmux = !socketPathFits(join(runDirectory, `tmux-${process.getuid?.() ?? 0}`, 'default'));
  let fileWrites: string[] = [];
  for (const path of writable) {
    const info = await fs.stat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable(`cannot inspect writable path ${path}`);
      return null;
    });
    if (info?.isFile()) fileWrites.push(path);
    else if (!info || info.isDirectory()) entries[path] = 'write';
    else unavailable(`writable path ${path} is not a file or directory`);
  }
  if (!writable.has(cwd)) entries[cwd] = 'read';
  const git = join(cwd, '.git');
  const gitEntry = await fs.lstat(git).catch(() => null);
  if (writable.has(cwd)) {
    if (!gitEntry || gitEntry.isFile() || gitEntry.isDirectory()) entries[git] = 'write';
  } else {
    for (const path of await workspaceGitPaths(cwd)) entries[path] = writable.has(path) ? 'write' : 'read';
    for (const path of writable) {
      const modules = join(path, 'modules');
      if ((await fs.stat(modules).catch(() => null))?.isDirectory()) entries[modules] = 'read';
    }
  }
  for (const path of masked) entries[path] = 'none';
  const protectedScope = await protectCodexReadOnlyPaths(entries, readOnlyDirectories, fileWrites);
  entries = protectedScope.filesystem;
  fileWrites = protectedScope.writableFiles;
  entries[directory] = 'read';
  for (const path of masked) entries[path] = 'none';
  if (darwin) {
    for (const path of fileWrites) entries[path] = 'write';
    for (const path of hidden) entries[path] = 'none';
  }
  const mountpoints: { path: string; parent: string; dev: number; ino: number }[] = [];
  for (const path of writable) {
    const parent = await fs.stat(path).catch(() => null);
    if (!parent?.isDirectory()) continue;
    for (const name of ['.git', '.codex', '.agents', '.aws']) {
      const target = join(path, name);
      const existing = await fs.lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      });
      if (!existing) mountpoints.push({ path: target, parent: path, dev: parent.dev, ino: parent.ino });
    }
  }
  let identity: { dev: number; ino: number } | undefined;
  let toolDirectory: Awaited<ReturnType<typeof createRafToolSocketDirectory>> | undefined;
  const cleanup = async () => {
    if (toolDirectory) { await toolDirectory.cleanup(); toolDirectory = undefined; }
    if (identity) {
      const current = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current && (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino)) throw new Error('Codex sandbox cleanup directory identity mismatch');
      if (current) await fs.rm(directory, { recursive: true });
      identity = undefined;
    }
    for (const mountpoint of mountpoints.splice(0)) {
      const parent = await fs.lstat(mountpoint.parent).catch(() => null);
      if (!parent?.isDirectory() || parent.dev !== mountpoint.dev || parent.ino !== mountpoint.ino) continue;
      await fs.rmdir(mountpoint.path).catch(error => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EBUSY', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      });
    }
  };
  try {
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(directory, { mode: 0o700 });
    identity = await fs.lstat(directory);
    const helperDirectory = directory;
    if (compactToolTmux) toolDirectory = await createRafToolSocketDirectory();
    const toolTmux = toolDirectory?.directory ?? runDirectory;
    const tmuxSockets = toolDirectory?.directory ?? join(runDirectory, `tmux-${process.getuid?.() ?? 0}`);
    entries[helperDirectory] = 'read';
    entries[tmuxSockets] = 'write';
    entries[toolTmux] = 'write';
    const toolVariables: Record<string, string> = { TMUX_TMPDIR: toolTmux, ...(sharedTmp ? {} : { TMPDIR: runDirectory }) };
    const filesystem = `{${Object.entries(entries).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',')}}`;
    const policy = ['-c', 'sandbox_mode="workspace-write"', '-c', `default_permissions="${profile}"`, '-c', `permissions.${profile}.filesystem=${filesystem}`, '-c', `permissions.${profile}.network.enabled=true`];
    const shellEnvironment = [...scrubbed.flatMap(name => ['-c', `shell_environment_policy.set.${name}=""`]), ...Object.entries(toolVariables).flatMap(([name, value]) => ['-c', `shell_environment_policy.set.${name}=${JSON.stringify(value)}`])];
    const launcher = join(helperDirectory, 'codex');
    const invocation: Invocation = { ...request.invocation, executable: launcher, args: [...args, ...policy, ...shellEnvironment, ...(end < 0 ? [] : source.slice(end))] };
    const toolSandbox: Invocation = { executable: launcher, args: ['--no-daemon', 'sandbox', '-C', cwd, '-P', profile, ...policy, '--'], liveTaskVerified: request.invocation.liveTaskVerified };
    const environment = Object.fromEntries(Object.entries(request.environment).filter((entry): entry is [string, string] => entry[1] !== undefined && !scrubbed.includes(entry[0])));
    Object.assign(environment, toolVariables);
    if (bwrap && filter) {
      await fs.writeFile(join(helperDirectory, 'network.bpf'), filter, { mode: 0o400 });
      await fs.writeFile(join(helperDirectory, 'bwrap'), codexBwrapWrapper(bwrap, join(helperDirectory, 'network.bpf'), tmuxSockets, fileWrites), { mode: 0o500 });
    }
    await fs.writeFile(join(helperDirectory, 'codex'), `#!/bin/sh\nPATH=${literal(helperDirectory)}:"$PATH"\nexport PATH\nexec ${literal(codex)} "$@"\n`, { mode: 0o500 });
    await fs.writeFile(join(directory, 'policy.json'), JSON.stringify({ runId: request.runId, profile, sandboxMode: 'workspace-write', codex, bwrap, backend: { selection: darwin ? 'native-seatbelt' : 'PATH', sharedDaemon: false, helperDirectory, hidden: masked }, network: { codex: 'enabled', namespace: 'host', socketFamilies: Object.keys(socketFamilies), ...(darwin ? {} : { ioUring: 'denied' }) }, tmuxSockets: darwin ? tmuxSockets : 'private tmpfs per sandboxed command', filesystem: entries, writableFiles: fileWrites, symlinkParents: protectedScope.symlinkParents, environment: { cleared: scrubbed, set: toolVariables } }, null, 2), { mode: 0o400 });
    await recordProductionSandboxProtection(request.readOnlyDirectories ?? [], join(directory, 'policy.json'));
    return { invocation, environment, toolSandbox, policyPaths: [directory], cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    if (error instanceof CodexSandboxUnavailable) throw error;
    throw new CodexSandboxUnavailable(`Codex sandbox isolation unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
