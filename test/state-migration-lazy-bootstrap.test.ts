import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CompiledCatalog } from '../src/catalog.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const orchestrator = dirname(repository);
const timeoutMs: number = JSON.parse(readFileSync(join(orchestrator, 'conf/flow.json'), 'utf8')).unitTests.timeoutMs;
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'unitTests.timeoutMs must be configured');
const compiledCatalog: CompiledCatalog = JSON.parse(readFileSync(join(repository, 'dist/catalog.json'), 'utf8'));

type Event = { kind: string; path?: string; operation?: string; generation?: string; name?: string; params?: unknown };
type Audit = { events: Event[]; completed: boolean };
type ProbeResult = { code: number | null; signal: string | null; stdout: string; stderr: string; audit: Audit };
type Configuration = 'registered' | 'missing' | 'partial' | 'malformed';
type ProbeOptions = {
  surface: 'public' | 'api';
  codeRoot?: string;
  argv: string[];
  mode?: 'lazy' | 'runtime' | 'guard';
  qa?: boolean;
  selectedGeneration?: 'old' | 'new';
  readerFailure?: boolean;
  importFailure?: boolean;
  handlerFailure?: boolean;
  releaseFailure?: boolean;
  switchAtBarrier?: boolean;
};

const PRELOAD_SOURCE = String.raw`
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import os from 'node:os';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(fs.readFileSync(process.env.Z353_PROBE_CONFIG, 'utf8'));
const originalRead = fs.readFileSync.bind(fs);
const originalWrite = fs.writeFileSync.bind(fs);
const events = [];
globalThis.__z353 = { config, events };
const emit = event => events.push(event);
process.on('exit', () => originalWrite(config.auditPath, JSON.stringify({ events, completed: true })));
const userInfo = os.userInfo.bind(os);
os.userInfo = (...args) => ({ ...userInfo(...args), homedir: config.workingHome });
const asPath = value => {
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return resolve(value.toString());
  return typeof value === 'string' ? resolve(value) : undefined;
};
const inside = (path, root) => path === root || path.startsWith(root + sep);
const sourceRoot = path => config.codeRoots.find(root => inside(path, root));
const generation = path => {
  const root = sourceRoot(path);
  if (!root) return undefined;
  try { return originalRead(join(root, '.z353-generation'), 'utf8'); }
  catch { return 'unavailable-generation'; }
};
const statePath = path => [config.workingHome, config.qaHome].some(home => inside(path, join(home, '.raf')));
function access(operation, value) {
  const path = asPath(value);
  if (!path) return;
  const codeRoot = sourceRoot(path);
  if (codeRoot && path === join(codeRoot, 'dist/catalog.json')) {
    emit({ kind: 'catalog-read', path, generation: generation(path), operation });
    return;
  }
  const runtimeConf = inside(path, join(config.root, 'conf')) || (codeRoot && inside(path, join(codeRoot, 'conf')));
  const git = path.split(sep).includes('.git');
  const metadata = inside(path, config.root) && !codeRoot && !inside(path, join(config.root, 'conf')) &&
    path !== config.root && !config.codeRoots.some(root => root.startsWith(path + sep));
  const state = statePath(path);
  if (runtimeConf || git || metadata || state) {
    emit({ kind: runtimeConf ? 'conf-access' : git ? 'git-access' : state ? 'state-access' : 'metadata-access', path, operation });
    if (config.mode === 'lazy') throw new Error('Z353_FORBIDDEN_ATTEMPT:' + operation + ':' + path);
  }
  if (path.includes(sep + '.raf' + sep) && !inside(path, config.sandbox)) {
    emit({ kind: 'outside-state-attempt', path, operation });
    throw new Error('Z353_OUTSIDE_FIXTURE_STATE');
  }
}
const operations = ['readFile', 'writeFile', 'appendFile', 'open', 'stat', 'lstat', 'access', 'realpath', 'readdir',
  'mkdir', 'rm', 'unlink', 'rename', 'copyFile', 'readlink', 'symlink', 'link', 'chmod', 'truncate', 'createReadStream', 'createWriteStream'];
for (const name of operations) {
  for (const key of [name, name + 'Sync']) {
    if (typeof fs[key] !== 'function') continue;
    const original = fs[key].bind(fs);
    const wrapped = function (...args) {
      access(key, args[0]);
      if (['rename', 'copyFile', 'symlink', 'link'].includes(name)) access(key, args[1]);
      return original(...args);
    };
    if (key === 'realpath' || key === 'realpathSync') {
      const native = fs[key].native?.bind(fs);
      if (native) wrapped.native = (...args) => { access(key + '.native', args[0]); return native(...args); };
    }
    fs[key] = wrapped;
  }
  if (typeof fsp[name] === 'function') {
    const original = fsp[name].bind(fsp);
    fsp[name] = async (...args) => {
      access('promises.' + name, args[0]);
      if (['rename', 'copyFile', 'symlink', 'link'].includes(name)) access('promises.' + name, args[1]);
      return original(...args);
    };
  }
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name].bind(cp);
  cp[name] = (...args) => {
    emit({ kind: 'child-process', operation: name, name: String(args[0]) });
    if (config.mode === 'lazy') throw new Error('Z353_FORBIDDEN_CHILD_PROCESS');
    return original(...args);
  };
}
const sqlite = createRequire(import.meta.url)('node:sqlite');
const OriginalDatabase = sqlite.DatabaseSync;
sqlite.DatabaseSync = class extends OriginalDatabase {
  constructor(path, ...args) {
    const actual = asPath(path);
    emit({ kind: 'sqlite-open', path: actual });
    if (config.mode === 'lazy' || !actual || !inside(actual, config.sandbox)) throw new Error('Z353_SQLITE_TRIPWIRE');
    super(path, ...args);
  }
};
syncBuiltinESMExports();
const readerMock = String.raw${'`'}
const { config, events } = globalThis.__z353;
export async function acquireHotfixReader() {
  events.push({ kind: 'reader-acquire' });
  if (config.mode === 'lazy') throw new Error('Z353_FORBIDDEN_READER');
  if (config.readerFailure) throw new Error('Z353_READER_PRIMARY');
  events.push({ kind: 'reader-barrier' });
  const selected = await new Promise(resolve => {
    process.once('message', message => resolve(message.generationRoot));
    process.send({ phase: 'reader-barrier' });
  });
  events.push({ kind: 'reader-pinned', path: selected });
  return { id: 'z353-lease', generationRoot: selected, commit: 'z353-commit', fingerprint: 'z353-fingerprint',
    async release() {
      events.push({ kind: 'reader-release', path: selected });
      if (config.releaseFailure) throw new Error('Z353_RELEASE_SECONDARY');
    } };
}
export async function retainHotfixGeneration(_host, root) {
  events.push({ kind: 'reader-retain', path: root });
  if (config.mode === 'lazy') throw new Error('Z353_FORBIDDEN_RETAIN');
  return { async release() { events.push({ kind: 'retained-release', path: root }); } };
}
export async function recoverHotfixActivation() {
  events.push({ kind: 'recovery' });
  throw new Error('Z353_UNEXPECTED_RECOVERY');
}
export async function cleanupHotfixActivation() { throw new Error('Z353_UNEXPECTED_CLEANUP'); }
export async function activateHotfix() { throw new Error('Z353_UNEXPECTED_ACTIVATION'); }
export async function verifyHotfixCandidate() { throw new Error('Z353_UNEXPECTED_VERIFICATION'); }
export function createAtomicHotfixSwitch() { throw new Error('Z353_UNEXPECTED_SWITCH_PROVIDER'); }
${'`'};
const appMock = String.raw${'`'}
const { config, events } = globalThis.__z353;
export function createAppRuntime(context) {
  events.push({ kind: 'runtime-create', path: context.artifactPath });
  if (config.mode === 'lazy') throw new Error('Z353_FORBIDDEN_RUNTIME');
  return {
    handlers: new Proxy({}, { get(_target, name) { return async params => {
      const deferred = await import('./z353-deferred-fixture.mjs');
      events.push({ kind: 'handler', generation: deferred.generation, name: String(name), params });
      if (config.handlerFailure) throw new Error('Z353_HANDLER_PRIMARY');
      await Promise.resolve();
      events.push({ kind: 'handler-complete', generation: deferred.generation });
      return { generation: deferred.generation, artifactPath: context.artifactPath, params };
    }; } }),
    async close() { events.push({ kind: 'runtime-close' }); }
  };
}
export function runnerLimitsHandler() { return async () => { throw new Error('Z353_UNEXPECTED_QUOTA'); }; }
${'`'};
const runtimeMock = String.raw${'`'}
export const rafSystemCaller = Object.freeze({});
export async function createProductionServices() {
  globalThis.__z353.events.push({ kind: 'production-services' });
  throw new Error('Z353_UNEXPECTED_SERVICES');
}
export async function runProductionWorker() { throw new Error('Z353_UNEXPECTED_WORKER'); }
${'`'};
const guardMock = String.raw${'`'}
import { join } from 'node:path';
export function productionStateContext(root, modulePath, home) {
  globalThis.__z353.events.push({ kind: 'guard', path: modulePath });
  return { mode: 'production', orchestratorRoot: root, codeRoot: root, homeDirectory: home,
    statePath: join(home, '.raf/state.sqlite'), tmpRoot: join(home, '.raf/tmp'), tmuxSocketPath: join(home, '.raf/tmux.sock') };
}
export function verifyStateContext() {}
export function canonicalStatePath(path) { return path; }
export function resolveStateContext() { throw new Error('Z353_UNEXPECTED_DIRECT_GUARD'); }
export function stateContextEnvironment(_context, environment) { return environment; }
export function stateFailure(code, reason) { return Object.assign(new Error(reason), { code }); }
${'`'};
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);
    const path = fileURLToPath(url);
    if (!sourceRoot(path) || !path.includes(sep + 'src' + sep)) return nextLoad(url, context);
    const name = path.slice(path.lastIndexOf(sep) + 1);
    const marker = generation(path);
    emit({ kind: 'module-import', path, name, generation: marker });
    if (name === 'hotfix-activation.ts' && config.mode !== 'guard') return { format: 'module', source: readerMock, shortCircuit: true };
    if (config.mode !== 'guard' && name === 'app-runtime.ts') return { format: 'module', source: appMock, shortCircuit: true };
    if (config.mode !== 'guard' && name === 'production-runtime.ts') return { format: 'module', source: runtimeMock, shortCircuit: true };
    if (config.mode === 'runtime' && name === 'state-migration-guard.ts') return { format: 'module', source: guardMock, shortCircuit: true };
    if (name === 'production-entry.ts') {
      emit({ kind: 'entry-import', path, generation: marker });
      if (config.importFailure && path.startsWith(config.selectedRoot + sep)) {
        return { format: 'module', source: "throw new Error('Z353_IMPORT_PRIMARY'); export async function runProductionCli() {} export async function withProductionRuntime() {}", shortCircuit: true };
      }
    }
    return nextLoad(url, context);
  }
});
`;

const DRIVER_SOURCE = String.raw`
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { config } = globalThis.__z353;
try {
  const { runProductionCli } = await import(pathToFileURL(config.entryPath).href);
  const result = await runProductionCli(config.argv, {
    orchestratorRoot: config.root,
    homeDirectory: process.env.HOME,
    artifactPath: config.artifactPath
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
}
`;

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: {
    PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
  } });
  assert.equal(result.status, 0, `fixture Git setup failed: ${result.stderr}`);
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(root)) return files;
  function visit(path: string): void {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) visit(child);
      else files[child.slice(root.length)] = readFileSync(child).toString('base64');
    }
  }
  visit(root);
  return files;
}

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'raf-z353-bootstrap-'));
  const root = join(sandbox, 'orchestrator');
  const main = join(root, 'raf-main');
  const develop = join(root, 'raf-develop');
  const hotfix = join(root, 'raf-hotfix');
  const old = join(root, 'generation-old');
  const next = join(root, 'generation-new');
  const prepared = join(root, 'prepared-main');
  const retired = join(root, 'retired-main');
  const workingHome = join(sandbox, 'working-home');
  const qaHome = join(sandbox, 'qa-home');
  mkdirSync(workingHome, { recursive: true });
  mkdirSync(qaHome, { recursive: true });
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  json(join(root, 'package.json'), { name: 'z353-orchestrator-fixture', private: true, type: 'module' });
  git(root, 'add', '--', 'package.json');
  git(root, '-c', 'user.name=Z353 Fixture', '-c', 'user.email=z353@example.invalid', 'commit', '-q', '-m', 'fixture root');
  const roots = [main, develop, hotfix, old, next, prepared];
  for (const codeRoot of roots) {
    mkdirSync(codeRoot, { recursive: true });
    cpSync(join(repository, 'src'), join(codeRoot, 'src'), { recursive: true });
    cpSync(join(repository, 'bin'), join(codeRoot, 'bin'), { recursive: true });
    json(join(codeRoot, 'package.json'), { type: 'module' });
    json(join(codeRoot, 'dist/catalog.json'), compiledCatalog);
    const marker = codeRoot === old ? 'old' : codeRoot === next ? 'new' : codeRoot === prepared ? 'bootstrap-new' : 'bootstrap-old';
    writeFileSync(join(codeRoot, '.z353-generation'), marker);
    writeFileSync(join(codeRoot, 'src/z353-deferred-fixture.mjs'),
      `export const generation = ${JSON.stringify(marker)}; globalThis.__z353.events.push({kind:'deferred-import',generation});`);
    git(codeRoot, 'init', '-q', '-b', codeRoot === develop ? 'develop' : codeRoot === hotfix ? 'hotfix' : 'main');
    git(codeRoot, 'add', '--', 'package.json', '.z353-generation', 'dist/catalog.json', 'src', 'bin');
    git(codeRoot, '-c', 'user.name=Z353 Fixture', '-c', 'user.email=z353@example.invalid', 'commit', '-q', '-m', 'fixture generation');
  }
  const preload = join(sandbox, 'preload.mjs');
  const driver = join(sandbox, 'api.mjs');
  writeFileSync(preload, PRELOAD_SOURCE);
  writeFileSync(driver, DRIVER_SOURCE);
  const projects = {
    version: 1,
    profiles: { raf: { development: 'develop', integration: 'main', candidate: null, production: 'main', environments: { runtime: 'main' } } },
    projects: { raf: { path: 'raf-main', profile: 'raf', usesSharedLibs: false,
      branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } } }
  };
  function configure(kind: Configuration): void {
    rmSync(join(root, 'conf'), { recursive: true, force: true });
    if (kind === 'missing') return;
    mkdirSync(join(root, 'conf'), { recursive: true });
    if (kind === 'malformed') {
      for (const name of ['projects.json', 'raf.json', 'models.json']) writeFileSync(join(root, 'conf', name), '{broken');
      return;
    }
    json(join(root, 'conf/projects.json'), projects);
    if (kind === 'partial') return;
    for (const name of ['raf.json', 'models.json', 'raf-constants.json', 'flow.json']) {
      cpSync(join(orchestrator, 'conf', name), join(root, 'conf', name));
    }
  }
  configure('registered');
  let probeNumber = 0;
  async function probe(options: ProbeOptions): Promise<ProbeResult> {
    const codeRoot = options.codeRoot ?? main;
    const selectedRoot = options.selectedGeneration === 'new' ? next : old;
    const auditPath = join(sandbox, `audit-${++probeNumber}.json`);
    const configPath = join(sandbox, `config-${probeNumber}.json`);
    const mode = options.mode ?? 'lazy';
    json(configPath, { ...options, mode, root, sandbox, workingHome, qaHome, selectedRoot,
      codeRoots: [...roots, retired], auditPath, entryPath: join(codeRoot, 'src/production-entry.ts'),
      artifactPath: join(codeRoot, 'dist/catalog.json') });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) if (/^(RAF_|Z353_|TMUX|NODE_OPTIONS|GIT_)/.test(name)) delete env[name];
    Object.assign(env, { HOME: options.qa ? qaHome : workingHome, Z353_PROBE_CONFIG: configPath,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    if (options.qa) env.RAF_QA_HOME = qaHome;
    const args = ['--import', pathToFileURL(preload).href,
      ...(options.surface === 'public' ? [join(codeRoot, 'bin/raf.ts'), ...options.argv] : [driver])];
    return await new Promise((resolveProbe, reject) => {
      const child = spawn(process.execPath, args, { cwd: main, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: timeoutMs });
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8').on('data', data => { stdout += data; });
      child.stderr!.setEncoding('utf8').on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('message', message => {
        if ((message as { phase?: string }).phase !== 'reader-barrier') return;
        try {
          if (options.switchAtBarrier) {
            renameSync(main, retired);
            renameSync(prepared, main);
          }
          child.send({ generationRoot: selectedRoot });
        } catch (error) { child.kill(); reject(error); }
      });
      child.on('close', (code, signal) => {
        try {
          assert.ok(existsSync(auditPath), `probe setup/transport failure, not a behavioral red: ${stderr}`);
          const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as Audit;
          assert.equal(audit.completed, true, 'probe must publish evidence even on a CLI failure');
          resolveProbe({ code, signal, stdout, stderr, audit });
        } catch (error) { reject(error); }
      });
    });
  }
  return { sandbox, root, main, develop, hotfix, old, next, prepared, workingHome, qaHome, configure, probe,
    dispose() { rmSync(sandbox, { recursive: true, force: true }); } };
}

function noLazyAttempts(result: ProbeResult): void {
  assert.equal(result.signal, null, result.stderr);
  const forbidden = new Set(['conf-access', 'git-access', 'metadata-access', 'state-access', 'child-process',
    'sqlite-open', 'outside-state-attempt', 'reader-acquire', 'reader-retain', 'retained-release', 'reader-release',
    'recovery', 'runtime-create', 'production-services', 'handler']);
  assert.deepEqual(result.audit.events.filter(event => forbidden.has(event.kind)), [],
    'lazy bootstrap must not even attempt runtime/conf/Git/state/reader/metadata access, including caught failures');
}

function errorCode(result: ProbeResult, code: string): void {
  assert.notEqual(result.code, 0, `${code} must fail: ${result.stdout}`);
  assert.match(result.stderr, new RegExp(`\\b(?:${code})\\b`), result.stderr);
}

const lazyCases = [
  { name: 'empty argv', argv: [], code: null },
  { name: 'root help', argv: ['help'], code: null },
  { name: 'root --help', argv: ['--help'], code: null },
  { name: 'command help', argv: ['help', 'runner', 'list'], code: null },
  { name: 'command --help', argv: ['runner', 'list', '--help'], code: null },
  { name: 'unknown path', argv: ['z353-unknown-command'], code: 'UNKNOWN_COMMAND' },
  { name: 'unknown parameter', argv: ['runner', 'list', '--z353-unsupported'], code: 'UNKNOWN_ARGUMENT' },
  { name: 'missing required parameter', argv: ['agent', 'message'], code: 'MISSING_REQUIRED' },
  { name: 'missing option value', argv: ['agent', 'message', '--to'], code: 'MISSING_VALUE|MISSING_REQUIRED|MISSING_ARGUMENT' },
  { name: 'invalid value', argv: ['resource', 'wait', '--level', 'z353-invalid'], code: 'INVALID_VALUE' }
] as const;

for (const surface of ['public', 'api'] as const) {
  test(`Z.353 ${surface}: registered main/generation and all lazy argv avoid every attempted runtime access`, async t => {
    const f = fixture();
    t.after(() => f.dispose());
    for (const codeRoot of [f.main, f.old, f.develop, f.hotfix]) {
      for (const qa of [false, true]) {
        const beforeHome = snapshot(f.workingHome);
        const beforeQa = snapshot(f.qaHome);
        const help = new Map<string, string>();
        for (const item of lazyCases) {
          await t.test(`${codeRoot.slice(f.root.length + 1)} ${qa ? 'QA' : 'working HOME'} ${item.name}`, async () => {
            const result = await f.probe({ surface, codeRoot, argv: [...item.argv], qa });
            noLazyAttempts(result);
            if (surface === 'public') assert.deepEqual(events(result, 'entry-import'), [], 'lazy public bootstrap must finish before executable production entry import');
            if (item.code) errorCode(result, item.code);
            else {
              assert.equal(result.code, 0, result.stderr);
              assert.ok(result.stdout.trim(), 'help must come from the available compiled artifact');
              help.set(item.name, result.stdout);
            }
            assert.deepEqual(snapshot(f.workingHome), beforeHome, 'working HOME must remain byte-for-byte unchanged');
            assert.deepEqual(snapshot(f.qaHome), beforeQa, 'QA HOME must remain byte-for-byte unchanged');
          });
        }
        assert.equal(help.get('root help'), help.get('root --help'));
        assert.equal(help.get('command help'), help.get('command --help'));
      }
    }
  });

  test(`Z.353 ${surface}: missing, partial and malformed conf cannot change lazy parser results`, async t => {
    const f = fixture();
    t.after(() => f.dispose());
    for (const configuration of ['missing', 'partial', 'malformed'] as const) {
      f.configure(configuration);
      for (const item of lazyCases) {
        await t.test(`${configuration}: ${item.name}`, async () => {
          const result = await f.probe({ surface, argv: [...item.argv] });
          noLazyAttempts(result);
          if (item.code) errorCode(result, item.code);
          else assert.equal(result.code, 0, result.stderr);
        });
      }
    }
  });

  test(`Z.353 ${surface}: existing state and compiled-only commands keep the same lazy boundary`, async t => {
    const f = fixture();
    t.after(() => f.dispose());
    mkdirSync(join(f.workingHome, '.raf'), { recursive: true });
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) {
      writeFileSync(join(f.workingHome, '.raf', name), `protected ${name}`);
    }
    const catalog: CompiledCatalog = { ...structuredClone(compiledCatalog), commands: [
      ...compiledCatalog.commands,
      { path: ['z353', 'catalog-only'], handlerName: 'runner list', parameters: [
        { name: 'choice', option: '--choice', required: true, values: [{ id: 'catalog-value' }] }
      ], valueSources: {}, metadata: {} }
    ] };
    json(join(f.main, 'dist/catalog.json'), catalog);
    const before = snapshot(f.workingHome);
    for (const item of [
      { argv: ['help', 'z353', 'catalog-only'], code: null },
      { argv: ['z353', 'catalog-only', '--help'], code: null },
      { argv: ['z353', 'catalog-only'], code: 'MISSING_REQUIRED' },
      { argv: ['z353', 'catalog-only', '--choice', 'other-value'], code: 'INVALID_VALUE' }
    ]) {
      const result = await f.probe({ surface, argv: item.argv });
      noLazyAttempts(result);
      if (item.code) errorCode(result, item.code);
      else {
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /catalog-value/, 'help must use the fixture compiled catalog');
      }
      assert.deepEqual(snapshot(f.workingHome), before);
    }
  });

  test(`Z.353 ${surface}: missing/corrupt compiled artifact fails explicitly without rebuilding from conf`, async t => {
    const f = fixture();
    t.after(() => f.dispose());
    for (const artifact of ['missing', 'corrupt'] as const) {
      const path = join(f.main, 'dist/catalog.json');
      if (artifact === 'missing') rmSync(path);
      else writeFileSync(path, '{broken');
      const before = snapshot(join(f.root, 'conf'));
      const result = await f.probe({ surface, argv: ['help'] });
      noLazyAttempts(result);
      assert.notEqual(result.code, 0, 'artifact failure must not turn into successful help');
      assert.ok(result.stderr.trim(), 'artifact failure needs an explicit diagnostic');
      assert.deepEqual(snapshot(join(f.root, 'conf')), before);
      assert.equal(existsSync(path), artifact === 'corrupt', 'missing artifact must not be reconstructed');
      if (artifact === 'corrupt') assert.equal(readFileSync(path, 'utf8'), '{broken');
    }
  });
}

function events(result: ProbeResult, kind: string): Event[] {
  return result.audit.events.filter(event => event.kind === kind);
}

function requireOrdered(result: ProbeResult, kinds: string[]): void {
  let previous = -1;
  for (const kind of kinds) {
    const index = result.audit.events.findIndex((event, at) => at > previous && event.kind === kind);
    assert.ok(index > previous, `${kinds.join(' → ')} violated: ${JSON.stringify(result.audit.events)}`);
    previous = index;
  }
}

function pinnedImports(result: ProbeResult, root: string, expectDeferred = true): void {
  assert.deepEqual(events(result, 'reader-acquire').length, 1, 'one invocation acquires one lease');
  assert.deepEqual(events(result, 'reader-pinned').map(event => event.path), [root]);
  assert.deepEqual(events(result, 'reader-release').map(event => event.path), [root]);
  const entries = events(result, 'entry-import');
  assert.equal(entries.length, 1, 'moving bootstrap entry must not be imported before pinning');
  assert.equal(entries[0].path, join(root, 'src/production-entry.ts'));
  const deferred = events(result, 'module-import').filter(event =>
    ['app-runtime.ts', 'production-runtime.ts', 'z353-deferred-fixture.mjs'].includes(event.name ?? ''));
  if (expectDeferred) assert.ok(deferred.length > 0, 'probe must exercise deferred generation dependencies');
  for (const event of deferred) assert.ok(event.path?.startsWith(root + '/'), `mixed generation import: ${event.path}`);
  assert.equal(events(result, 'outside-state-attempt').length, 0);
}

test('Z.353 public runtime: parse → lease → generation imports → handler completion → release', async t => {
  const f = fixture();
  t.after(() => f.dispose());
  const result = await f.probe({ surface: 'public', mode: 'runtime', argv: ['runner', 'list'] });
  assert.equal(result.code, 0, result.stderr);
  requireOrdered(result, ['catalog-read', 'reader-acquire', 'reader-pinned', 'entry-import', 'deferred-import', 'handler', 'handler-complete', 'reader-release']);
  pinnedImports(result, f.old);
  assert.equal(events(result, 'handler').length, 1, 'handler must run exactly once');
  assert.equal(events(result, 'handler')[0].generation, 'old');
  assert.equal(JSON.parse(result.stdout).artifactPath, join(f.old, 'dist/catalog.json'));
});

for (const failure of ['import', 'handler'] as const) {
  for (const releaseFailure of [false, true]) {
    test(`Z.353 public runtime: ${failure} failure releases acquired lease, cleanup failure=${releaseFailure}`, async t => {
      const f = fixture();
      t.after(() => f.dispose());
      const result = await f.probe({ surface: 'public', mode: 'runtime', argv: ['runner', 'list'],
        importFailure: failure === 'import', handlerFailure: failure === 'handler', releaseFailure });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, new RegExp(`Z353_${failure.toUpperCase()}_PRIMARY`), 'cleanup must preserve the original cause');
      assert.deepEqual(events(result, 'reader-release').map(event => event.path), [f.old]);
      requireOrdered(result, ['reader-pinned', 'entry-import', ...(failure === 'handler' ? ['handler'] : []), 'reader-release']);
      assert.equal(events(result, 'handler').length, failure === 'import' ? 0 : 1);
      if (releaseFailure) assert.doesNotMatch(result.stderr.split('\n')[0], /^Error: Z353_RELEASE_SECONDARY$/);
    });
  }
}

test('Z.353 public runtime: failed reader cannot import entry, execute handler, open state or release an unacquired lease', async t => {
  const f = fixture();
  t.after(() => f.dispose());
  const result = await f.probe({ surface: 'public', mode: 'runtime', argv: ['runner', 'list'], readerFailure: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Z353_READER_PRIMARY/);
  assert.equal(events(result, 'reader-acquire').length, 1);
  for (const kind of ['entry-import', 'handler', 'sqlite-open', 'reader-pinned', 'reader-release', 'reader-retain']) {
    assert.deepEqual(events(result, kind), [], `reader refusal must not fall back: ${kind}`);
  }
});

function generationCatalog(marker: string, accepted: string[], removeCommand = false): CompiledCatalog {
  const catalog = structuredClone(compiledCatalog);
  const command = catalog.commands.find(command => command.handlerName === 'runner list');
  assert.ok(command, 'fixture requires the compiled runner list command');
  const changed = { ...command, description: marker, parameters: [
    ...command.parameters,
    { name: 'generationValue', option: '--generation-value', required: true, values: accepted.map(id => ({ id })) }
  ] };
  return { ...catalog, commands: catalog.commands.flatMap(item => item === command ? removeCommand ? [] : [changed] : [item]) };
}

for (const catalogChange of ['shared value', 'removed value', 'removed command'] as const) {
  test(`Z.353 switch at reader barrier: intact bootstrap, pinned catalog and modules (${catalogChange})`, async t => {
    const f = fixture();
    t.after(() => f.dispose());
    const before = generationCatalog('catalog-old', ['shared', 'old-only']);
    const after = generationCatalog('catalog-new', ['shared', 'new-only'], catalogChange === 'removed command');
    json(join(f.main, 'dist/catalog.json'), before);
    json(join(f.old, 'dist/catalog.json'), before);
    json(join(f.next, 'dist/catalog.json'), after);
    json(join(f.prepared, 'dist/catalog.json'), after);
    const result = await f.probe({ surface: 'public', mode: 'runtime', selectedGeneration: 'new', switchAtBarrier: true,
      argv: ['runner', 'list', '--generation-value', catalogChange === 'removed value' ? 'old-only' : 'shared'] });
    pinnedImports(result, f.next, catalogChange === 'shared value');
    requireOrdered(result, ['catalog-read', 'reader-acquire', 'reader-barrier', 'reader-pinned', 'entry-import', 'catalog-read', 'reader-release']);
    assert.equal(events(result, 'module-import').filter(event => event.generation === 'bootstrap-new').length, 0,
      'an already running bootstrap must not load dependencies through the switched main pathname');
    if (catalogChange === 'shared value') {
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(events(result, 'handler').map(event => event.generation), ['new']);
      const output = JSON.parse(result.stdout);
      assert.equal(output.generation, 'new');
      assert.equal(output.artifactPath, join(f.next, 'dist/catalog.json'));
      assert.equal(output.params.generationValue, 'shared');
    } else {
      errorCode(result, catalogChange === 'removed command' ? 'UNKNOWN_COMMAND' : 'INVALID_VALUE');
      assert.deepEqual(events(result, 'handler'), [], 'bootstrap acceptance cannot bypass the pinned catalog');
      assert.deepEqual(events(result, 'sqlite-open'), []);
    }
  });
}

for (const branch of ['develop', 'hotfix'] as const) {
  for (const surface of ['public', 'api'] as const) {
    test(`Z.353 ${surface}: ${branch} state command still refuses working HOME before SQLite access`, async t => {
      const f = fixture();
      t.after(() => f.dispose());
      const stateFile = JSON.parse(readFileSync(join(f.root, 'conf/raf.json'), 'utf8')).state.fileName;
      mkdirSync(join(f.workingHome, '.raf'), { recursive: true });
      const statePath = join(f.workingHome, '.raf', stateFile);
      const database = new DatabaseSync(statePath);
      database.exec("CREATE TABLE z353_sentinel(value TEXT); INSERT INTO z353_sentinel VALUES ('unchanged'); PRAGMA user_version=7;");
      database.close();
      writeFileSync(statePath + '-wal', 'protected WAL fixture');
      writeFileSync(statePath + '-shm', 'protected SHM fixture');
      const before = snapshot(f.workingHome);
      const result = await f.probe({ surface, mode: 'guard', codeRoot: f[branch], argv: ['command', 'stats'] });
      errorCode(result, 'STATE_CONTEXT_REFUSED');
      assert.deepEqual(events(result, 'sqlite-open'), [], 'guard must run before opening a database');
      assert.deepEqual(snapshot(f.workingHome), before, 'database/schema/WAL/SHM and HOME must be unchanged');
      assert.deepEqual(snapshot(f.qaHome), {}, 'refusal must not choose another HOME');
    });
  }

  test(`Z.353 API: ${branch} explicit isolated QA still permits a real state command`, async t => {
    const f = fixture();
    t.after(() => f.dispose());
    const before = snapshot(f.workingHome);
    const result = await f.probe({ surface: 'api', mode: 'guard', codeRoot: f[branch], argv: ['command', 'stats'], qa: true });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(events(result, 'sqlite-open').length > 0, 'QA case must exercise a real SQLite open');
    for (const event of events(result, 'sqlite-open')) assert.ok(event.path?.startsWith(join(f.qaHome, '.raf') + '/'));
    assert.deepEqual(snapshot(f.workingHome), before);
    assert.ok(Object.keys(snapshot(f.qaHome)).length > 0, 'only the explicit QA HOME may gain state');
  });
}
