import type { Invocation, NativeSandboxScope } from './runner-protocols.ts';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PublishedAgentChannelContext } from './main-switch-agent-launcher.ts';
import { rafEntrypointPath } from './task-context.ts';

export interface CodexRafCommandAccessRequest {
  readonly invocation: Invocation;
  readonly scope: NativeSandboxScope;
  readonly cwd: string;
  readonly runDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly publication?: PublishedAgentChannelContext;
}

export interface PreparedCodexRafCommandAccess {
  readonly invocation: Invocation;
  readonly environment: Readonly<Record<string, string>>;
  readonly unavailable?: string;
  cleanup(): Promise<void>;
}

class HookProtocolUnavailable extends Error {}

const commandHookTimeoutSeconds = Number.MAX_SAFE_INTEGER;

export function codexFileDescriptorPath(fd: number, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'darwin' ? '/dev/fd/' : '/proc/self/fd/') + fd;
}

function codexDirectoryPath(fd: number, directoryPath: string): string {
  return process.platform === 'darwin' ? directoryPath : codexFileDescriptorPath(fd);
}

const replayProgram = String.raw`
const codexFileDescriptorPath = ${codexFileDescriptorPath.toString()};
const codexDirectoryPath = ${codexDirectoryPath.toString()};
const fs = await import('node:fs/promises');
const { constants, createReadStream } = await import('node:fs');
const { pipeline } = await import('node:stream/promises');
const [root, id] = process.argv.slice(1);
let directory, claimed;
const files = [];
try {
  if (!/^[a-f0-9-]+$/u.test(id)) throw new Error('invalid result identifier');
  claimed = root + '/replay-' + process.pid + '-' + id;
  await fs.rename(root + '/ready-' + id, claimed);
  directory = await fs.open(claimed, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const path = codexDirectoryPath(directory.fd, claimed);
  for (const name of ['stdout', 'stderr', 'result.json']) {
    const file = await fs.open(path + '/' + name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    files.push(file);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('invalid result file ' + name);
  }
  const result = JSON.parse(await files[2].readFile('utf8'));
  if (!Number.isInteger(result.code) || result.code < 0 || result.code > 255) throw new Error('invalid result exit code');
  const stats = await Promise.all(files.slice(0, 2).map(file => file.stat()));
  if (stats[0].size !== result.stdoutBytes || stats[1].size !== result.stderrBytes) throw new Error('incomplete result streams');
  const streamed = await Promise.allSettled([
    pipeline(createReadStream('', { fd: files[0].fd, autoClose: false }), process.stdout, { end: false }),
    pipeline(createReadStream('', { fd: files[1].fd, autoClose: false }), process.stderr, { end: false }),
  ]);
  const failure = streamed.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  process.exitCode = result.code;
} catch (error) {
  process.stderr.write('RAF command result read failed: ' + error.message + '\n');
  process.exitCode = 1;
} finally {
  await Promise.all(files.map(file => file.close().catch(() => {})));
  await directory?.close();
  if (claimed) {
    try { await fs.rm(claimed, { recursive: true, force: true }); }
    catch (error) { process.stderr.write('RAF command result cleanup failed: ' + error.message + '\n'); process.exitCode = 1; }
    try {
      const entries = await fs.readdir(root);
      if (entries.length === 1 && entries[0] === 'closed') {
        await fs.rm(root + '/closed', { force: true });
        await fs.rmdir(root).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { process.stderr.write('RAF command result cleanup failed: ' + error.message + '\n'); process.exitCode = 1; }
    }
  }
}
`;

const hookProgram = String.raw`
const codexFileDescriptorPath = ${codexFileDescriptorPath.toString()};
const codexDirectoryPath = ${codexDirectoryPath.toString()};
const { spawn } = await import('node:child_process');
const fs = await import('node:fs/promises');
const { constants, createWriteStream } = await import('node:fs');
const { randomUUID } = await import('node:crypto');
const { pipeline } = await import('node:stream/promises');
const parse = source => {
  const words = [];
  let word = '', started = false, quote = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = ''; else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '$' || char === '\x60') return null;
      else if (char === '\\') {
        const next = source[++i];
        if (next === undefined || next === '\n' || next === '\r') return null;
        word += ['$', '\x60', '"', '\\'].includes(next) ? next : '\\' + next;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char; started = true;
    } else if (char === '\\') {
      const next = source[++i];
      if (next === undefined || next === '\n' || next === '\r') return null;
      word += next; started = true;
    } else if (char === ' ' || char === '\t') {
      if (started) words.push(word);
      word = ''; started = false;
    } else if (/[\r\n\0;&|<>$\x60(){}*?\[\]~#]/u.test(char)) return null;
    else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
};
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const command = request.tool_input?.command;
const words = typeof command === 'string' ? parse(command) : null;
const allowed = access.commands.map(parse).find(prefix => prefix?.length && words?.length >= prefix.length && prefix.every((word, index) => words[index] === word));
if (request.hook_event_name === 'PreToolUse' && request.tool_name === 'Bash' && allowed) {
  let root, directory, name;
  const files = [];
  let response, published = false, verified = false;
  const literal = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const failure = error => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: literal(access.node) + ' -e ' + literal('process.stderr.write(process.argv[1] + "\\n"); process.exitCode = 1') + ' ' + literal('RAF command transport failed: ' + error.message + '; raf was not retried') } } });
  try {
    root = await fs.open(access.results.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = await root.stat();
    if (identity.dev !== access.results.dev || identity.ino !== access.results.ino) throw new Error('result directory identity changed');
    verified = true;
    const base = codexDirectoryPath(root.fd, access.results.path);
    const closed = async () => fs.lstat(base + '/closed').then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (await closed()) throw new Error('command channel is closed');
    const id = randomUUID();
    name = 'capture-' + process.pid + '-' + id;
    await fs.mkdir(base + '/' + name, { mode: 0o700 });
    directory = await fs.open(base + '/' + name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const path = codexDirectoryPath(directory.fd, base + '/' + name);
    for (const filename of ['stdout', 'stderr', 'result.json']) files.push(await fs.open(path + '/' + filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    if (await closed()) throw new Error('command channel closed before execution');
    const launcher = access.publication
      ? ['--input-type=module', '-e', 'const {runPublishedAgentChannel}=await import(process.argv[1]);process.exitCode=await runPublishedAgentChannel(JSON.parse(process.argv[2]));', access.launcher, JSON.stringify({ ...access.publication, cwd: access.cwd, issuedCommands: access.commands, command })]
      : words.slice(1);
    const child = spawn(access.publication ? access.node : allowed[0], launcher, { cwd: access.cwd, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError;
    const completed = new Promise(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', code => resolve(code ?? 1));
    });
    const outputs = [child.stdout, child.stderr].map((stream, index) => pipeline(stream, createWriteStream('', { fd: files[index].fd, autoClose: false })).catch(error => { child.kill('SIGKILL'); throw error; }));
    const [code, streams] = await Promise.all([completed, Promise.allSettled(outputs)]);
    if (spawnError) throw new Error('raf spawn failed: ' + spawnError.message);
    const failed = streams.find(stream => stream.status === 'rejected');
    if (failed) throw new Error('result stream write failed: ' + failed.reason.message);
    const stats = await Promise.all(files.slice(0, 2).map(file => file.stat()));
    await files[2].writeFile(JSON.stringify({ code, stdoutBytes: stats[0].size, stderrBytes: stats[1].size }));
    await Promise.all(files.splice(0).map(file => file.close()));
    if (await closed()) throw new Error('command channel closed after execution; raf was not retried');
    await fs.rename(base + '/' + name, base + '/ready-' + id);
    name = 'ready-' + id;
    published = true;
    const replay = literal(access.node) + ' --input-type=module -e ' + literal(access.reader) + ' ' + literal(access.results.path) + ' ' + literal(id);
    response = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: replay } } };
  } catch (error) {
    process.stderr.write('RAF command result capture failed: ' + error.message + '\n');
    response = failure(error);
  } finally {
    try {
      await Promise.all(files.map(file => file.close()));
      await directory?.close();
      if (root && name && !published) await fs.rm(codexDirectoryPath(root.fd, access.results.path) + '/' + name, { recursive: true, force: true });
      if (root && verified) {
        const base = codexDirectoryPath(root.fd, access.results.path);
        const entries = await fs.readdir(base);
        if (entries.length === 1 && entries[0] === 'closed') {
          await fs.rm(base + '/closed', { force: true });
          await fs.rmdir(access.results.path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
        }
      }
    } catch (error) { response = failure(new Error('result cleanup failed: ' + error.message)); }
    finally { await root?.close().catch(error => { response = failure(error); }); }
  }
  process.stdout.write(JSON.stringify(response));
} else process.stdout.write('{}');
`;

const literal = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function codexInvocationSandboxMode(args: readonly string[]): string | null {
  let mode: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '--dangerously-bypass-approvals-and-sandbox' || arg === '--yolo') return 'danger-full-access';
    if (arg === '--sandbox' || arg === '-s') mode = args[++i] ?? null;
    else if (arg.startsWith('--sandbox=')) mode = arg.slice('--sandbox='.length);
    else if (arg === '--full-auto') mode = 'workspace-write';
    else if (arg === '-c' || arg === '--config') {
      const setting = /^sandbox_mode\s*=\s*"?([A-Za-z-]+)"?\s*$/u.exec(args[++i] ?? '');
      if (setting) mode = setting[1];
    }
  }
  return mode;
}

async function hookIdentity(executable: string, args: string[], cwd: string, environment: Record<string, string>, command: string, timeoutMs: number): Promise<{ key: string; currentHash: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args, 'app-server', '--listen', 'stdio://'], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let answered = false;
    const finish = (error?: Error, value?: { key: string; currentHash: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => process.stderr.write(`Warning: Codex RAF hook inspection still pending after ${timeoutMs} ms; waiting\n`), timeoutMs);
    child.stderr.resume();
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(answered
      ? new Error('Codex RAF hook inspection exited before returning its definition')
      : new HookProtocolUnavailable(`${executable} exited without answering the app-server JSON-RPC initialize request`)));
    lines.on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch {
        if (!answered) return finish(new HookProtocolUnavailable(`${executable} does not speak the app-server JSON-RPC protocol`));
        return finish(new Error('Codex RAF hook inspection received non-protocol output'));
      }
      answered = true;
      try {
        if (message.error) return finish(new Error(`Codex RAF hook inspection failed: ${message.error.message}`));
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } }) + '\n');
        } else if (message.id === 2) {
          const hooks = message.result?.data?.flatMap((entry: { hooks: unknown[] }) => entry.hooks) ?? [];
          const matches = hooks.filter((hook: Record<string, unknown>) => hook.source === 'sessionFlags' && hook.eventName === 'preToolUse' && hook.command === command);
          if (matches.length !== 1 || typeof matches[0].key !== 'string' || typeof matches[0].currentHash !== 'string') return finish(new Error('Codex did not expose the exact RAF hook definition'));
          if (matches[0].timeoutSec !== commandHookTimeoutSeconds || matches[0].async === true) return finish(new Error('Codex RAF hook lifetime requires no independent timeout budget and synchronous result delivery'));
          finish(undefined, matches[0]);
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'raf-command-access', version: '1' }, capabilities: { experimentalApi: true } } }) + '\n');
  });
}

export async function prepareCodexRafCommandAccess(
  request: CodexRafCommandAccessRequest,
): Promise<PreparedCodexRafCommandAccess> {
  const environment = Object.fromEntries(Object.entries(request.environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const invocation = { ...request.invocation, args: [...request.invocation.args] };
  const sandbox = codexInvocationSandboxMode(invocation.args);
  let results: { path: string; dev: number; ino: number } | undefined;
  const cleanup = async () => {
    if (!results) return;
    const root = await open(results.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!root) return;
    try {
      const identity = await root.stat();
      if (identity.dev !== results.dev || identity.ino !== results.ino) throw new Error('Codex RAF result directory identity changed during cleanup');
      const base = codexDirectoryPath(root.fd, results.path);
      await writeFile(`${base}/closed`, '', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      let active = false;
      for (const name of await readdir(base)) {
        if (name === 'closed') continue;
        const pid = /^(?:capture|replay)-(\d+)-/u.exec(name)?.[1];
        if (pid) {
          try {
            const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
            if (!['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])) { process.kill(Number(pid), 0); active = true; continue; }
          }
          catch (error) { if (!['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        }
        await rm(join(base, name), { recursive: true, force: true });
      }
      if (!active) {
        await rm(`${base}/closed`, { force: true });
        await rmdir(results.path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      }
    } finally { await root.close(); }
  };
  if (request.scope.excludedCommands.length && sandbox !== null && sandbox !== 'danger-full-access') {
    const commands = request.scope.excludedCommands.map(command => {
      if (!command.trim() || command === ':*') throw new Error('Invalid Codex RAF command scope');
      return command.endsWith(':*') ? command.slice(0, -2) : command;
    });
    const timeoutMs = request.timeoutMs ?? JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((protocol: { runner: string }) => protocol.runner === 'codex')?.timeouts.transitionMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Codex RAF hook inspection requires a configured deadline');
    await mkdir(request.runDirectory, { recursive: true, mode: 0o700 });
    const runDirectory = await realpath(request.runDirectory);
    const path = await mkdtemp(join(runDirectory, 'codex-raf-results-'));
    const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const identity = await root.stat();
      results = { path, dev: identity.dev, ino: identity.ino };
    } finally { await root.close(); }
    const source = `const access = ${JSON.stringify({ commands, cwd: request.cwd, results, node: process.execPath, reader: replayProgram,
      ...(request.publication ? { publication: request.publication, launcher: pathToFileURL(join(dirname(dirname(rafEntrypointPath(import.meta.url, request.publication.orchestratorRoot))), 'src/main-switch-agent-launcher.ts')).href } : {}) })};\n${hookProgram}`;
    const command = `${literal(process.execPath)} --input-type=module -e ${literal(source)}`;
    const hook = `hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",timeout=${commandHookTimeoutSeconds},async=false,command=${JSON.stringify(command)}}]}]`;
    const configuration: string[] = [];
    for (let i = 0; i < invocation.args.length; i++) {
      if (['-c', '--config'].includes(invocation.args[i])) configuration.push('-c', invocation.args[++i]);
    }
    configuration.push('-c', hook);

    let identity: { key: string; currentHash: string };
    try {
      identity = await hookIdentity(invocation.executable, configuration, request.cwd, environment, command, timeoutMs);
    } catch (error) {
      await cleanup();
      if (!(error instanceof HookProtocolUnavailable)) throw error;
      return { invocation: { ...request.invocation, args: [...request.invocation.args] }, environment, unavailable: `RAF command channel unavailable: ${error.message}`, cleanup };
    }
    const end = invocation.args.indexOf('--');
    invocation.args.splice(end < 0 ? invocation.args.length : end, 0, '-c', hook, '-c', `hooks.state={${JSON.stringify(identity.key)}={trusted_hash=${JSON.stringify(identity.currentHash)}}}`);
  }
  return { invocation, environment, cleanup };
}
