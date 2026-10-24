import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer, connect, type Server } from 'node:net';
import { endianness } from 'node:os';
import { dirname, join, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRunnerExecutable } from '../../src/runner-availability.ts';
import type { CodexSandboxRequest } from '../../src/codex-sandbox.ts';
import { buildRunnerInvocation, nativeWriteScopeArgs } from '../../src/runner-protocols.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const orchestrator = dirname(repository);
const conf = JSON.parse(await fs.readFile(join(orchestrator, 'conf/raf.json'), 'utf8'));
const protocol = conf.runnerProtocols.find((entry: { runner: string }) => entry.runner === 'codex');
export const transitionMs: number = protocol.timeouts.transitionMs;
export const pollMs: number = protocol.timeouts.pollMs;

export async function command(executable: string, args: readonly string[], cwd: string,
  environment: Readonly<Record<string, string | undefined>>, timeoutMs = transitionMs) {
  const child = spawn(executable, [...args], { cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, spawnError: Error | undefined;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const terminate = () => {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>(done => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => done({ code, signal }));
    });
    return { ...exit, stdout, stderr, timedOut, spawnError: spawnError?.message };
  } finally { clearTimeout(timer); terminate(); }
}

export function ok(result: Awaited<ReturnType<typeof command>>, label: string) {
  assert.equal(result.spawnError, undefined, `${label}: setup executable unavailable`);
  assert.equal(result.timedOut, false, `${label}: timeout is not positive acceptance`);
  assert.equal(result.signal, null, `${label}: interrupted`);
  assert.equal(result.code, 0, `${label}: ${result.stderr}`);
}

export function cleanEnvironment(home: string, path = process.env.PATH ?? '') {
  return {
    PATH: path.split(delimiter).filter(part => !/\/raf-(?:tools|ipc)-/.test(part)).join(delimiter),
    HOME: home, RAF_QA_HOME: home, TMPDIR: home, CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8', TERM: 'xterm-256color',
  };
}

export async function checkPrerequisites() {
  if (process.platform !== 'linux' || endianness() !== 'LE' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('Z404_SETUP: Linux little-endian x64/arm64 userns/seccomp required');
  }
  const root = await fs.mkdtemp('/tmp/z404-os-');
  try {
    const env = cleanEnvironment(root);
    await fs.mkdir(env.CODEX_HOME);
    const resolved = await resolveRunnerExecutable('codex', 'codex', env);
    if (resolved.status !== 'resolved') throw new Error(`Z404_SETUP: bare Codex missing: ${resolved.reason}`);
    const npm = resolved.path;
    const npmReal = await fs.realpath(npm);
    if (!npmReal.endsWith('/bin/codex.js')) throw new Error('Z404_SETUP: npm Codex entry missing; do not replace npm case by native');
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    const triple = process.arch === 'x64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl';
    const packageRoot = resolve(dirname(npmReal), '..');
    const native = join(packageRoot, 'node_modules/@openai', `codex-linux-${arch}`, 'vendor', triple, 'bin/codex');
    const bundledBwrap = join(dirname(dirname(native)), 'codex-resources/bwrap');
    const configuredResolution = await resolveRunnerExecutable('codex', protocol.executable, env);
    if (configuredResolution.status !== 'resolved') throw new Error(`Z404_SETUP: configured resolver: ${configuredResolution.reason}`);
    const binaries = [];
    for (const [kind, path] of [['npm', npm], ['native', native], ['configured', configuredResolution.path],
      ['system-bwrap', '/usr/bin/bwrap'], ['bundled-bwrap', bundledBwrap]] as const) {
      const result = await command(path, ['--version'], root, env);
      ok(result, `Z404_SETUP ${kind}`);
      if (['npm', 'native', 'configured'].includes(kind)) assert.match(result.stdout, /^codex-cli 0\.163\.0\s*$/, `Z404_SETUP ${kind}: wrong installed version`);
      binaries.push({ kind, path, realpath: await fs.realpath(path), sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex'), version: result.stdout.trim() });
    }
    for (const [executable, args] of [['tmux', ['-V']], ['strace', ['--version']], ['git', ['--version']]] as const) {
      ok(await command(executable, args, root, env), `Z404_SETUP ${executable}`);
    }
    const syscall = process.arch === 'x64' ? 41 : 198;
    const instructions = [[0x20, 0, 0, 0], [0x15, 0, 4, syscall], [0x20, 0, 0, 16],
      [0x15, 1, 0, 2], [0x15, 0, 1, 10], [0x06, 0, 0, 0x00050001], [0x06, 0, 0, 0x7fff0000]];
    const bpf = Buffer.alloc(instructions.length * 8);
    instructions.forEach(([code, jt, jf, value], index) => {
      bpf.writeUInt16LE(code, index * 8); bpf[index * 8 + 2] = jt; bpf[index * 8 + 3] = jf; bpf.writeUInt32LE(value, index * 8 + 4);
    });
    const filter = join(root, 'os-check.bpf');
    await fs.writeFile(filter, bpf);
    const primitiveProgram = `
const assert = require('node:assert/strict'), net = require('node:net'), fs = require('node:fs');
const {spawnSync}=require('node:child_process');
(async () => {
 for (const host of ['127.0.0.1', '::1']) await new Promise((resolve, reject) => {
  const s = net.connect(9, host); s.on('connect', () => { s.destroy(); reject(Error('INET socket permitted')); });
  s.on('error', e => { try { assert.equal(e.code, 'EPERM'); resolve(); } catch (e) { reject(e); } });
 });
 const s = net.createServer(c => c.end('primitive-payload'));
 await new Promise((r,j) => { s.once('error',j); s.listen('primitive.sock',r); });
 const data = await new Promise((r,j) => { let v=''; const c=net.connect('primitive.sock'); c.on('data',b=>v+=b); c.on('end',()=>r(v)); c.on('error',j); });
 assert.equal(data,'primitive-payload'); await new Promise(r=>s.close(r)); fs.unlinkSync('primitive.sock');
 for(const named of [false,true]) {
  const prefix=named?['-L','z404-primitive']:[];
  const run=args=>{const r=spawnSync('tmux',[...prefix,...args],{env:{...process.env,TMUX_TMPDIR:process.cwd()},encoding:'utf8'});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  let started=false;
  try {
   run(['-f','/dev/null','new-session','-d','-s','qa','/bin/sh']); started=true;
   assert.ok(Buffer.byteLength(run(['display-message','-p','#{socket_path}']))<108);
   run(['set-environment','Z404_PAYLOAD','primitive-payload']);
   assert.equal(run(['show-environment','Z404_PAYLOAD']),'Z404_PAYLOAD=primitive-payload');
  } finally { if(started)run(['kill-server']); }
 }
})().catch(e=>{ console.error(e.message); process.exitCode=1; });`;
    const result = await command('/bin/sh', ['-c', 'exec 3<"$1"; shift; exec /usr/bin/bwrap --die-with-parent --unshare-user --unshare-pid --unshare-net --seccomp 3 --ro-bind / / --bind "$1" "$1" --dev /dev --proc /proc --chdir "$1" -- "$2" -e "$3"',
      'z404-os', filter, root, process.execPath, primitiveProgram], root, env);
    ok(result, 'Z404_SETUP independent user/pid/mount/network namespaces + seccomp + Unix payload');
    return { npm, native, configured: configuredResolution.path, configuredExecutable: protocol.executable, binaries, primitives: 'verified' as const };
  } catch (error) {
    throw new Error(`Z404_SETUP: prerequisites failed; not product red: ${(error as Error).message}`, { cause: error });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function listener(path: string | { host: string; port: number }) {
  const server = createServer(socket => socket.end('host-sentinel'));
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(path as never, done); });
  return server;
}

export async function exchange(address: string | { host: string; port: number }) {
  return new Promise<string>((done, reject) => {
    const socket = typeof address === 'string' ? connect(address) : connect(address);
    let payload = '';
    socket.setTimeout(transitionMs, () => socket.destroy(new Error('host control deadline')));
    socket.on('error', reject); socket.on('data', chunk => { payload += chunk; }); socket.on('end', () => done(payload));
  });
}

export async function ownCompactAliases(roots: readonly string[]) {
  const found: string[] = [];
  for (const directory of [`/tmp/raf-ipc-${process.getuid!()}`, `/tmp/raf-tools-${process.getuid!()}`]) {
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const name of names) {
      const path = join(directory, name);
      let target;
      try { target = resolve(directory, await fs.readlink(path)); }
      catch (error) { if (['EINVAL', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
      if (roots.some(root => target === root || target.startsWith(root + '/'))) found.push(path);
    }
  }
  return found.sort();
}

export async function stand(long: boolean) {
  const root = await fs.mkdtemp(join(repository, '.z404-host-'));
  const shortHome = await fs.mkdtemp('/tmp/z404-h-');
  const servers: Server[] = [];
  const dispose = async () => {
    try {
      await Promise.all(servers.map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))));
    } finally {
      await Promise.all([root, shortHome].map(path => fs.rm(path, { recursive: true, force: true })));
    }
  };
  try {
    const home = long ? join(root, 'srv/dev/qa-home/.git/modules/raf/raf-hotfix/generations', randomUUID(), 'raf-main/isolated-long-HOME') : shortHome;
    const account = join(home, '.raf'), runDirectory = join(account, 'tmp/run');
    const source = join(root, 'source'), workspace = join(root, 'workspace');
    const host = join(root, 'host'), questions = join(root, 'questions/questions.md');
    const endpoint = join(host, 'registered.sock'), alias = join(workspace, 'registered-alias.sock');
    const environment = { ...cleanEnvironment(home), TMUX: `${endpoint},123,0`, TMUX_PANE: '%777',
      SSH_AUTH_SOCK: join(host, 'ssh.sock'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(host, 'bus.sock')}`, XDG_RUNTIME_DIR: host };
    await Promise.all([runDirectory, source, host, dirname(questions), environment.CODEX_HOME, environment.XDG_CONFIG_HOME].map(path => fs.mkdir(path, { recursive: true })));
    await fs.writeFile(questions, 'question-original');
    await fs.writeFile(join(dirname(questions), 'sibling.md'), 'sibling-original');
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'secrets.json']) await fs.writeFile(join(account, name), `synthetic-${name}`);
    const git = async (args: string[], cwd = source) => ok(await command('git', args, cwd, environment), `Z404_SETUP git ${args[0]}`);
    await git(['init', '-b', 'main']);
    await fs.writeFile(join(source, 'seed.txt'), 'source-original');
    await git(['add', 'seed.txt']);
    await git(['-c', 'user.name=Z404', '-c', 'user.email=z404@example.invalid', 'commit', '-m', 'fixture']);
    await git(['worktree', 'add', '-b', 'agent', workspace]);
    const common = join(source, '.git');
    const gitdir = (await fs.readFile(join(workspace, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    const writableGit = [join(common, 'objects'), join(common, 'refs'), join(common, 'logs'), gitdir];
    await fs.mkdir(join(common, 'worktrees/foreign'), { recursive: true });
    await fs.writeFile(join(common, 'worktrees/foreign/index'), 'foreign-index');
    const endpoints = [endpoint, join(host, 'raf.sock'), join(host, 'ssh.sock'), join(host, 'bus.sock')];
    for (const path of endpoints) servers.push(await listener(path));
    await fs.symlink(endpoint, alias); endpoints.push(alias);
    const tcp4 = await listener({ host: '127.0.0.1', port: 0 }); servers.push(tcp4);
    const ports = [{ host: '127.0.0.1', port: (tcp4.address() as { port: number }).port }];
    let ipv6Unavailable: string | undefined;
    try {
      const tcp6 = await listener({ host: '::1', port: 0 }); servers.push(tcp6);
      ports.push({ host: '::1', port: (tcp6.address() as { port: number }).port });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(code ?? '')) throw error;
      ipv6Unavailable = code;
    }
    const denyReads = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'secrets.json'].map(name => join(account, name));
    const stateAlias = join(workspace, 'state-alias');
    await fs.symlink(denyReads[0], stateAlias); denyReads.push(stateAlias);
    const siblingRun = join(account, 'tmp/neighbor'); await fs.mkdir(siblingRun);
    await fs.writeFile(join(siblingRun, 'brief.json'), 'neighbor-run'); denyReads.push(join(siblingRun, 'brief.json'));
    const denyWrites = [...denyReads, join(source, 'seed.txt'), join(common, 'config'), join(common, 'worktrees/foreign/index'), join(dirname(questions), 'sibling.md'), join(dirname(questions), 'new-sibling.md')];
    const denyDirectories = [account, host, '/run', `/tmp/tmux-${process.getuid!()}`, '/tmp/cc-socks'];
    const retained = [...new Set([...denyReads, ...denyWrites.slice(0, -1), questions])];
    const snapshot = await Promise.all(retained.map(async path => [path, await fs.readFile(path, 'utf8')] as const));
    const control = async () => {
      for (const path of endpoints) assert.equal(await exchange(path), 'host-sentinel');
      for (const address of ports) assert.equal(await exchange(address), 'host-sentinel');
      for (const [path, value] of snapshot) {
        if (path === questions) continue;
        assert.equal(await fs.readFile(path, 'utf8'), value, `foreign sentinel changed: ${path}`);
      }
    };
    const writableDirectories = [workspace, runDirectory, environment.CODEX_HOME, questions, ...writableGit];
    const models = JSON.parse(await fs.readFile(join(orchestrator, 'conf/models.json'), 'utf8')).models;
    const model = models.find((entry: { runner: string; enabled: boolean }) => entry.runner === 'codex' && entry.enabled);
    assert.ok(model, 'Z404_SETUP needs a configured enabled Codex selection');
    const invocation = buildRunnerInvocation(protocol, { model: model.id, effort: model.effort });
    const request = (executable: string): CodexSandboxRequest => ({
      runId: randomUUID(), invocation: { ...invocation, executable, args: [...invocation.args, ...nativeWriteScopeArgs(protocol, writableDirectories, [source])] },
      cwd: workspace, runDirectory, writableDirectories,
      readOnlyDirectories: [source], scope: { hidden: [account, host], readable: [source], tmuxDirectory: runDirectory, excludedCommands: [] },
      environment, timeoutMs: transitionMs,
    });
    return { root, home, account, runDirectory, workspace, source, common, gitdir, questions, endpoint, alias,
      endpoints, denyReads, denyWrites, denyDirectories, ports, ipv6Unavailable, environment, request, control, dispose };
  } catch (error) {
    await dispose();
    throw new Error(`Z404_SETUP: stand preparation failed: ${(error as Error).message}`, { cause: error });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await checkPrerequisites(), null, 2)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 2; }
}
