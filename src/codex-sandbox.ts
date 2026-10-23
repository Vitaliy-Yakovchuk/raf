import type { Invocation, NativeSandboxScope } from './runner-protocols.ts';
import { codexInvocationSandboxMode } from './codex-raf-command-access.ts';
import { spawn } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface CodexSandboxRequest {
  readonly runId: string;
  readonly invocation: Invocation;
  readonly scope: NativeSandboxScope;
  readonly cwd: string;
  readonly runDirectory: string;
  readonly writableDirectories: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
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

const profile = 'linux';
const unavailable = (reason: string): never => { throw new CodexSandboxUnavailable(`Codex sandbox isolation unavailable: ${reason}`); };
const within = (root: string, path: string) => { const suffix = relative(root, path); return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`); };
const scrubbed = ['TMUX', 'TMUX_PANE', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'];
const literal = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const architectures: Partial<Record<string, { audit: number; socket: number; ioUringSetup: number; x32: boolean }>> = {
  x64: { audit: 0xc000003e, socket: 41, ioUringSetup: 425, x32: true },
  arm64: { audit: 0xc00000b7, socket: 198, ioUringSetup: 425, x32: false },
};

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

async function executable(name: string, environment: Readonly<Record<string, string | undefined>>, exclude: string): Promise<string> {
  const candidates = isAbsolute(name) ? [name] : (environment.PATH ?? '').split(delimiter).filter(directory => isAbsolute(directory) && directory !== exclude).map(directory => join(directory, name));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return unavailable(`${name} executable is not available`);
}

function socketAddresses(environment: Readonly<Record<string, string | undefined>>): string[] {
  const paths: string[] = [];
  const tmux = environment.TMUX?.split(',')[0];
  if (tmux) paths.push(tmux);
  if (environment.SSH_AUTH_SOCK) paths.push(environment.SSH_AUTH_SOCK);
  if (environment.XDG_RUNTIME_DIR) paths.push(environment.XDG_RUNTIME_DIR);
  for (const address of (environment.DBUS_SESSION_BUS_ADDRESS ?? '').split(';').filter(Boolean)) {
    const [transport, options = ''] = address.split(/:(.*)/su);
    const values = Object.fromEntries(options.split(',').filter(Boolean).map(option => { const at = option.indexOf('='); return [option.slice(0, at), decodeURIComponent(option.slice(at + 1))]; }));
    if (transport === 'unix' && (values.path || values.dir || values.tmpdir)) paths.push(values.path ?? values.dir ?? values.tmpdir);
    else if (!(transport === 'unix' && values.abstract) && transport !== 'tcp' && transport !== 'nonce-tcp') unavailable(`session bus transport ${transport} cannot be closed`);
  }
  for (const path of paths) if (!isAbsolute(path)) unavailable(`host endpoint ${path} is not an absolute path`);
  return paths;
}

function networkFilter(): Buffer {
  const arch = architectures[process.arch] ?? unavailable(`no network filter for architecture ${process.arch}`);
  const allow = 0x7fff0000, deny = 0x00050000 | 13;
  const program: [number, number, number, number][] = [
    [0x20, 0, 0, 4],
    [0x15, 0, 7, arch.audit],
    [0x20, 0, 0, 0],
    arch.x32 ? [0x35, 5, 0, 0x40000000] : [0x15, 0, 0, 0xffffffff],
    [0x15, 4, 0, arch.ioUringSetup],
    [0x15, 0, 2, arch.socket],
    [0x20, 0, 0, 16],
    [0x15, 0, 1, 1],
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

const probeProgram = String.raw`
const net = require('node:net');
const fs = require('node:fs');
const [socket, port, ...hidden] = JSON.parse(process.argv[1]);
const fail = (code, message) => { process.stderr.write(message); process.exit(code); };
const leaks = [];
for (const path of hidden) {
  try { const stat = fs.statSync(path); if (stat.isDirectory()) fs.readdirSync(path); else if (!stat.isSocket()) fs.closeSync(fs.openSync(path, 'r')); leaks.push(path); } catch {}
}
if (leaks.length) fail(3, 'hidden paths readable: ' + leaks.join(', '));
const tcp = net.connect(port, '127.0.0.1');
tcp.on('connect', () => fail(7, 'host loopback TCP reachable'));
tcp.on('error', error => {
  if (['ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)) fail(7, 'host TCP not blocked: ' + error.code);
  const server = net.createServer(connection => connection.end('raf-probe'));
  server.on('error', error => fail(4, 'unix listen failed: ' + error.code));
  server.listen(socket, () => {
    const client = net.connect(socket);
    let data = '';
    client.on('data', chunk => { data += chunk; });
    client.on('error', error => fail(5, 'unix connect failed: ' + error.code));
    client.on('close', () => { server.close(); try { fs.unlinkSync(socket); } catch {} process.exit(data === 'raf-probe' ? 0 : 6); });
  });
});
`;

async function probe(toolSandbox: Invocation, environment: Record<string, string>, cwd: string, socket: string, hidden: readonly string[], timeoutMs: number): Promise<void> {
  const listener: Server = createServer(connection => connection.destroy());
  listener.on('error', () => {});
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => resolve()); });
  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(toolSandbox.executable, [...toolSandbox.args, process.execPath, '-e', probeProgram, JSON.stringify([socket, port, ...hidden])], { cwd, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new CodexSandboxUnavailable('Codex sandbox isolation unavailable: preflight probe timed out')); }, timeoutMs);
      child.on('error', error => { clearTimeout(timer); reject(new CodexSandboxUnavailable(`Codex sandbox isolation unavailable: ${error.message}`)); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new CodexSandboxUnavailable(`Codex sandbox isolation unavailable: preflight probe exited ${code}: ${stderr.trim().slice(-400)}`));
      });
    });
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
}

export async function prepareCodexSandbox(
  request: CodexSandboxRequest,
): Promise<PreparedCodexSandbox> {
  if (!/^[A-Za-z0-9_-]+$/u.test(request.runId)) unavailable('invalid run id');
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) unavailable('preflight requires a positive deadline');
  const mode = codexInvocationSandboxMode(request.invocation.args);
  if (mode !== 'workspace-write') unavailable(`invocation sandbox mode ${mode ?? 'unset'} is not workspace-write`);
  const cwd = await canonical(request.cwd);
  const runDirectory = await canonical(request.runDirectory);
  const writable = new Set<string>([cwd, runDirectory]);
  const args: string[] = [];
  const source = request.invocation.args;
  const end = source.indexOf('--');
  for (let i = 0; i < (end < 0 ? source.length : end); i++) {
    const arg = source[i];
    if (arg === '--sandbox' || arg === '-s') { i++; continue; }
    if (arg === '--add-dir') { const value = source[++i] ?? unavailable('--add-dir without a directory'); writable.add(await canonical(value)); args.push(arg, value); continue; }
    if (arg.startsWith('--sandbox=') || arg === '--full-auto') continue;
    if (arg.startsWith('--add-dir=')) { writable.add(await canonical(arg.slice('--add-dir='.length))); args.push(arg); continue; }
    if ((arg === '-c' || arg === '--config') && /^\s*(?:sandbox_mode|default_permissions|permissions|sandbox_workspace_write)\b/u.test(source[i + 1] ?? '')) { i++; continue; }
    args.push(arg);
  }
  for (const directory of request.writableDirectories) writable.add(await canonical(directory));
  let accountHome: string;
  try { accountHome = userInfo().homedir; }
  catch { return unavailable('cannot determine account HOME for hidden RAF state'); }
  if (!isAbsolute(accountHome)) unavailable('account HOME for hidden RAF state is not absolute');
  const accountState = join(accountHome, '.raf');
  const accountPaths = [accountState, join(accountState, 'tmp')];
  const accountRoots = [...accountPaths, ...await Promise.all(accountPaths.map(canonical))];
  const hidden = new Set<string>();
  for (const path of [...accountRoots, ...request.scope.hidden, ...socketAddresses(request.environment)]) {
    if (!isAbsolute(path)) unavailable(`hidden path ${path} is not absolute`);
    hidden.add(path);
    hidden.add(await canonical(path));
  }
  for (const path of hidden) {
    if (path === '/' || within(runDirectory, path)) unavailable(`hidden host resource ${path} overlaps the run directory`);
    if (within(path, cwd)) unavailable(`workspace ${cwd} lies inside hidden host resource ${path}`);
    if (within(cwd, path) && (accountRoots.includes(path) || (await fs.stat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable(`cannot inspect hidden host resource ${path}`);
      return null;
    }))?.isDirectory())) unavailable(`workspace ${cwd} overlaps hidden host state directory ${path}`);
    for (const directory of writable) if (within(path, directory) && !within(runDirectory, directory)) unavailable(`writable directory ${directory} lies inside hidden host resource ${path}`);
  }
  const directory = join(runDirectory, `codex-sandbox-${request.runId}`);
  const codex = await executable(request.invocation.executable, request.environment, directory);
  const bwrap = await executable('bwrap', request.environment, directory);
  const filter = networkFilter();
  const sharedTmp = !within('/tmp', directory);
  const entries: Record<string, string> = { ':root': 'read', ...(sharedTmp ? { ':slash_tmp': 'write' } : {}) };
  const toolVariables: Record<string, string> = { TMUX_TMPDIR: runDirectory, ...(sharedTmp ? {} : { TMPDIR: runDirectory }) };
  for (const path of writable) entries[path] = 'write';
  const git = join(cwd, '.git');
  const gitEntry = await fs.lstat(git).catch(() => null);
  if (!gitEntry || gitEntry.isFile()) entries[git] = 'write';
  entries[directory] = 'read';
  for (const path of hidden) entries[path] = 'none';
  const filesystem = `{${Object.entries(entries).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',')}}`;
  const policy = ['-c', 'sandbox_mode="workspace-write"', '-c', `default_permissions="${profile}"`, '-c', `permissions.${profile}.filesystem=${filesystem}`, '-c', `permissions.${profile}.network.enabled=true`];
  const shellEnvironment = [...scrubbed.flatMap(name => ['-c', `shell_environment_policy.set.${name}=""`]), ...Object.entries(toolVariables).flatMap(([name, value]) => ['-c', `shell_environment_policy.set.${name}=${JSON.stringify(value)}`])];
  const launcher = join(directory, 'codex');
  const invocation: Invocation = { ...request.invocation, executable: launcher, args: [...args, ...policy, ...shellEnvironment, ...(end < 0 ? [] : source.slice(end))] };
  const toolSandbox: Invocation = { executable: launcher, args: ['sandbox', '-C', cwd, '-P', profile, ...policy, '--'], liveTaskVerified: request.invocation.liveTaskVerified };
  const environment = Object.fromEntries(Object.entries(request.environment).filter((entry): entry is [string, string] => entry[1] !== undefined && !scrubbed.includes(entry[0])));
  Object.assign(environment, toolVariables);
  const probeSocket = join(runDirectory, `.codex-sandbox-probe-${process.pid}.sock`);
  let created = false;
  const cleanup = async () => {
    await fs.rm(probeSocket, { force: true });
    if (created) await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
    await fs.writeFile(join(directory, 'network.bpf'), filter, { mode: 0o400 });
    const tmuxSockets = join(runDirectory, `tmux-${process.getuid?.() ?? 0}`);
    await fs.writeFile(join(directory, 'bwrap'), [
      '#!/bin/sh',
      'mounted=0',
      'for argument do',
      '  shift',
      `  if [ "$mounted" = 0 ] && [ "$argument" = -- ]; then set -- "$@" --perms 0700 --tmpfs ${literal(tmuxSockets)} --; mounted=1; else set -- "$@" "$argument"; fi`,
      'done',
      `exec ${literal(bwrap)} --unshare-net --add-seccomp-fd 9 "$@" 9<${literal(join(directory, 'network.bpf'))}`,
      '',
    ].join('\n'), { mode: 0o500 });
    await fs.writeFile(launcher, `#!/bin/sh\nPATH=${literal(directory)}:"$PATH"\nexport PATH\nexec ${literal(codex)} "$@"\n`, { mode: 0o500 });
    await fs.writeFile(join(directory, 'policy.json'), JSON.stringify({ runId: request.runId, profile, sandboxMode: 'workspace-write', codex, bwrap, network: { codex: 'enabled', namespace: 'unshared', socketFamilies: ['AF_UNIX'], ioUring: 'denied' }, tmuxSockets: 'private tmpfs per sandboxed command', filesystem: entries, environment: { cleared: scrubbed, set: toolVariables } }, null, 2), { mode: 0o400 });
    const visible: string[] = [];
    for (const path of hidden) if (await fs.access(path, constants.R_OK).then(() => true, () => false)) visible.push(path);
    await probe(toolSandbox, environment, cwd, probeSocket, visible, request.timeoutMs);
  } catch (error) {
    await cleanup().catch(() => undefined);
    if (error instanceof CodexSandboxUnavailable) throw error;
    throw new CodexSandboxUnavailable(`Codex sandbox isolation unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { invocation, environment, toolSandbox, policyPaths: [directory], cleanup };
}
