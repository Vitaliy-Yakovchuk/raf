import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs, { readFileSync as boundReadFileSync } from 'node:fs';
import { readFile as boundReadFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import operatingSystem, { tmpdir } from 'node:os';
import { dirname, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { compileCatalog } from '../src/catalog.ts';
import { failureContext } from '../src/cli-contract.ts';
import { hotfixModuleOrigin } from '../src/hotfix-origin.ts';
import { createHotfixRuntimeInventory } from '../src/hotfix-runtime-inventory.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { openStateStore, STATE_SCHEMA_VERSION, type StateStore } from '../src/state-store.ts';
import { TmuxAgentAdapter } from '../src/agent-adapters.ts';
import type { AdapterCommand, AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { ProcessIdentity, ProcessObservation, SessionRecord } from '../src/session-state.ts';
import type { RuntimeConfiguration } from '../src/app-runtime.ts';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const readConf = (name: string) => JSON.parse(fs.readFileSync(join(sourceRoot, 'conf', name + '.json'), 'utf8'));
const settings = readConf('raf');
const models = readConf('models');
const constants = readConf('raf-constants');
const catalog = compileCatalog(constants, models, constants.commands.map((row: { path: string[] }) => row.path.join(' ')), readConf('projects'));
const commit = '1'.repeat(40);
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const bridgeKey = Symbol.for('raf.runtime-verification-cost.fixture');
const fsTargets = [[fs, 'Sync'], [fs.promises, '']] as const;
const fsOperations = ['readFile', 'readdir', 'lstat', 'stat', 'realpath', 'readlink', 'open', 'opendir'];
const realFs = fsTargets.map(([target, suffix]) => {
  const object = target as unknown as Record<string, (...args: any[]) => any>;
  return { target, object, entries: fsOperations.map(name => [name + suffix, object[name + suffix]] as const) };
});
type FsTap = { before?(operation: string, args: any[]): void; after?(operation: string, args: any[], value: any): any };
const fsTaps = new WeakMap<TestContext, FsTap[]>();
function realFsLeaks() {
  const leaks = realFs.flatMap(({ object, entries }) => entries.filter(([operation, original]) => object[operation] !== original).map(([operation]) => operation));
  if (boundReadFileSync !== realFs[0].object.readFileSync) leaks.push('esm:readFileSync');
  if (boundReadFile !== realFs[1].object.readFile) leaks.push('esm:readFile');
  return leaks;
}
function fsInterposition(t: TestContext) {
  const existing = fsTaps.get(t);
  if (existing) return existing;
  assert.deepEqual(realFsLeaks(), [], 'A previous fixture left an fs interposition installed');
  const taps: FsTap[] = [];
  fsTaps.set(t, taps);
  for (const { target, object, entries } of realFs) for (const [operation, original] of entries) {
    const settle = (args: any[], value: any) => taps.reduce((current, tap) => tap.after ? tap.after(operation, args, current) : current, value);
    t.mock.method(object, operation, target === fs.promises
      ? async function (...args: any[]) {
        for (const tap of [...taps].reverse()) tap.before?.(operation, args);
        return settle(args, await Reflect.apply(original, target, args));
      }
      : function (...args: any[]) {
        for (const tap of [...taps].reverse()) tap.before?.(operation, args);
        return settle(args, Reflect.apply(original, target, args));
      });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); assert.deepEqual(realFsLeaks(), [], 'fs interposition restored to module-load originals'); });
  return taps;
}
const runtimeUrl = new URL('../src/production-runtime.ts?runtime-verification-cost', import.meta.url).href;
const entryUrl = new URL('../src/production-entry.ts?runtime-verification-cost', import.meta.url).href;
const osUrl = new URL('../src/os-runtime.ts', import.meta.url).href;
const storeUrl = new URL('../src/state-store.ts', import.meta.url).href;
const appUrl = new URL('../src/app-runtime.ts', import.meta.url).href;
const guardUrl = new URL('../src/state-migration-guard.ts', import.meta.url).href;
const bridge = 'const f=()=>globalThis[Symbol.for("raf.runtime-verification-cost.fixture")];';
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === runtimeUrl && specifier === './os-runtime.ts') return { shortCircuit: true, url: 'verification-unit:os' };
    if (context.parentURL === entryUrl && ['state-store.ts', 'state-migration-guard.ts', 'production-runtime.ts', 'app-runtime.ts'].includes(specifier.slice(2))) return { shortCircuit: true, url: 'verification-unit:' + specifier.slice(2) };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'verification-unit:os') return { shortCircuit: true, format: 'module', source: `export * from ${JSON.stringify(osUrl)}; ${bridge} export const readMachineBootIdentity=async()=>f().boot();` };
    if (url === 'verification-unit:state-store.ts') return { shortCircuit: true, format: 'module', source: `export * from ${JSON.stringify(storeUrl)}; ${bridge} export const openStateStore=(...args)=>f().open(...args);` };
    if (url === 'verification-unit:state-migration-guard.ts') return { shortCircuit: true, format: 'module', source: `export * from ${JSON.stringify(guardUrl)}; ${bridge} export const productionStateContext=()=>f().context();` };
    if (url === 'verification-unit:app-runtime.ts') return { shortCircuit: true, format: 'module', source: `export * from ${JSON.stringify(appUrl)}; import {createAppRuntime as create} from ${JSON.stringify(appUrl)}; export const createAppRuntime=(context,deps)=>create(context,{...deps,resolveGitWriteBoundaries:async()=>[]});` };
    if (url === 'verification-unit:production-runtime.ts') return { shortCircuit: true, format: 'module', source: `export * from ${JSON.stringify(runtimeUrl)}; ${bridge} export const createProductionServices=(...args)=>f().services(...args);` };
    if (url === runtimeUrl) {
      const loaded = next(url, context);
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source as Uint8Array).toString('utf8');
      return { ...loaded, source: source + '\nexport { observeIdentity, observeIdentities, belongsToPane };\n' };
    }
    return next(url, context);
  },
});
const runtime = await import(runtimeUrl) as typeof import('../src/production-runtime.ts') & {
  observeIdentity(identity: ProcessIdentity, execute: AdapterCommandExecutor): Promise<ProcessObservation>;
  observeIdentities(identities: readonly ProcessIdentity[], execute: AdapterCommandExecutor): Promise<ProcessObservation[]>;
  belongsToPane(identity: ProcessIdentity, execute: AdapterCommandExecutor): Promise<boolean>;
};
const { runProductionCli } = await import(entryUrl) as typeof import('../src/production-entry.ts');
hooks.deregister();

function generationFixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'raf-verification-')));
  const common = join(root, 'common');
  const control = join(common, 'raf-hotfix');
  const generation = join(control, 'generations', 'A', 'raf-main');
  const main = join(root, 'raf-main');
  const home = join(root, 'home');
  const write = (path: string, value: string) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, value); };
  for (const path of [main, home, join(root, 'raf-develop')]) fs.mkdirSync(path, { recursive: true });
  fs.cpSync(join(sourceRoot, 'conf'), join(root, 'conf'), { recursive: true });
  write(join(root, 'conf/projects.json'), JSON.stringify({ version: 1,
    projects: { raf: { path: 'raf-main', profile: 'raf', branchPaths: { main: 'raf-main', develop: 'raf-develop' } } },
    profiles: { raf: { production: 'main', environments: { runtime: 'main' } } },
  }));
  const inputs = {
    'bin/raf.ts': "import '../src/state-store.ts';\n",
    'src/state-store.ts': "import './production-entry.ts'; import './production-runtime.ts';\n",
    'src/production-entry.ts': 'export const entry = true;\n',
    'src/production-runtime.ts': 'export const runtime = true;\n',
    'src/unloaded.ts': 'export const unrelated = true;\n',
    'scripts/helper.mjs': 'export const helper = true;\n',
    'dist/catalog.json': '{"commands":[]}\n',
    'package.json': '{"type":"module"}\n',
  };
  for (const [path, value] of Object.entries(inputs)) write(join(generation, path), value);
  write(join(generation, 'evidence/gates.json'), '{"passed":true}');
  write(join(generation, 'docs/readme.md'), '# Fixture');
  const policy = { scopes: ['bin', 'dist', 'scripts', 'src'], rootFiles: ['package.json'], excludedTrees: ['docs', 'evidence'], entrypoints: ['bin/raf.ts'] };
  const inventory = createHotfixRuntimeInventory(generation, commit, policy);
  const record = { root: generation, commit, runtimeInventory: inventory };
  const registry = { current: generation, generations: { [generation]: record } };
  const registryPath = join(control, 'registry.json');
  const save = () => write(registryPath, JSON.stringify(registry));
  save();
  write(join(root, 'catalog.json'), JSON.stringify(catalog));
  const originalGit = childProcess.execFileSync;
  const account = operatingSystem.userInfo();
  t.mock.method(operatingSystem, 'userInfo', () => ({ ...account, homedir: home }));
  t.mock.method(childProcess, 'execFileSync', (executable: string, args: string[], ...rest: unknown[]) => {
    const cwd = args[args.indexOf('-C') + 1];
    if (executable !== 'git' || !cwd?.startsWith(root)) return Reflect.apply(originalGit, childProcess, [executable, args, ...rest]);
    if (args.includes('--git-common-dir')) return common;
    if (args.includes('--show-toplevel')) return cwd;
    if (args.includes('HEAD')) return commit;
    throw new Error('Unexpected unit Git request: ' + args.join(' '));
  });
  syncBuiltinESMExports();
  const context = () => resolveStateContext({ orchestratorRoot: root, modulePath: join(generation, 'src/state-store.ts'),
    homeDirectory: home, operatingSystemHome: home, environment: { HOME: home }, entryPoint: 'cli' });
  const origin = (path = 'src/state-store.ts', tree = generation) => hotfixModuleOrigin(root, main, join(tree, path), false);
  const stores: StateStore[] = [];
  const open = (ctx = context()) => { const store = openStateStore(ctx.statePath, { context: ctx }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) { try { store.close(); } catch {} } });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, generation, home, common, control, record, registry, registryPath, save, write, inventory, context, origin, open };
}
type GenerationFixture = ReturnType<typeof generationFixture>;

function fileMeter(t: TestContext, generation: string) {
  const log: { operation: string; path: string }[] = [];
  fsInterposition(t).push({ before(operation, args) {
    log.push({ operation, path: args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]) });
  } });
  const snapshot = () => {
    const inside = log.filter(row => row.path === generation || row.path.startsWith(generation + '/'));
    return { traversal: inside.filter(row => /^readdir|^opendir/.test(row.operation)),
      metadata: inside.filter(row => /^(?:lstat|stat|realpath|readlink)/.test(row.operation)),
      content: inside.filter(row => /^readFile/.test(row.operation)),
      opens: inside.filter(row => /^open/.test(row.operation)),
      full: inside.filter(row => /^readdir|^opendir/.test(row.operation) && row.path === generation).length };
  };
  return { log, snapshot, reset() { log.length = 0; } };
}
function assertSingleInventory(meter: ReturnType<typeof fileMeter>, f: GenerationFixture, count = 1) {
  const sample = meter.snapshot();
  assert.equal(sample.full, count, 'Exactly one root traversal per declared independent origin boundary');
  assert.equal(sample.traversal.length, count * (1 + f.inventory.directories!.length), 'No hidden repeated subtree traversal');
  assert.equal(sample.content.length, count * f.inventory.files.length, 'Each runtime byte set is read once per boundary');
  for (const row of f.inventory.files) assert.equal(sample.content.filter(op => op.path === join(f.generation, row.path)).length, count, row.path);
  assert.ok(sample.metadata.length >= count * f.inventory.files.length, 'Metadata and alias checks remain real');
}
function refused(action: () => unknown, code: string) {
  assert.throws(action, error => failureContext(error)?.code === code);
}

test('failed guard does not poison retry or preserve success and parallel calls each verify', async t => {
  const f = generationFixture(t);
  const path = join(f.generation, 'src/production-runtime.ts');
  const bytes = fs.readFileSync(path);
  assert.equal(f.origin(), f.generation);
  fs.writeFileSync(path, 'mutated');
  assert.equal(f.origin(), undefined);
  fs.writeFileSync(path, bytes);
  const meter = fileMeter(t, f.generation);
  const results = await Promise.all([Promise.resolve().then(() => f.origin()), Promise.resolve().then(() => f.origin())]);
  assert.deepEqual(results, [f.generation, f.generation]);
  assertSingleInventory(meter, f, 2);
});

test('retained A verifies its own inventory after B activation and cannot borrow B proof', t => {
  const f = generationFixture(t);
  const b = join(f.control, 'generations/B/raf-main');
  fs.cpSync(f.generation, b, { recursive: true });
  const inventory = createHotfixRuntimeInventory(b, '2'.repeat(40), { ...f.inventory, entrypoints: f.inventory.loading.entrypoints });
  (f.registry.generations as Record<string, unknown>)[b] = { root: b, commit: inventory.commit, runtimeInventory: inventory };
  f.registry.current = b; f.save();
  assert.equal(f.origin(), f.generation);
  assert.equal(f.origin('src/state-store.ts', b), b);
  fs.writeFileSync(join(f.generation, 'src/production-runtime.ts'), 'mutation in retained A');
  assert.equal(f.origin(), undefined);
  assert.equal(f.origin('src/state-store.ts', b), b);
});

for (const schema of ['unsupported', 'migration', 'invalid-permit'] as const) {
  test(`single origin optimization preserves ${schema} gate and existing state bytes`, t => {
    const f = generationFixture(t);
    const context = f.context();
    fs.mkdirSync(dirname(context.statePath), { recursive: true });
    const db = new DatabaseSync(context.statePath);
    db.exec(`CREATE TABLE sentinel(value); INSERT INTO sentinel VALUES ('preserve'); PRAGMA user_version=${schema === 'unsupported' ? STATE_SCHEMA_VERSION + 1 : 1};`); db.close();
    const before = hash(fs.readFileSync(context.statePath));
    const code = schema === 'unsupported' || schema === 'invalid-permit' ? 'STATE_SCHEMA_UNSUPPORTED' : 'STATE_MIGRATION_REQUIRED';
    refused(() => openStateStore(context.statePath, { context, ...(schema === 'invalid-permit' ? { transfer: { statePath: context.statePath, fromVersion: 1, toVersion: STATE_SCHEMA_VERSION + 1 } } : {}) }), code);
    assert.equal(hash(fs.readFileSync(context.statePath)), before);
  });
}

type OSMode = 'alive' | 'missing' | 'start' | 'command' | 'denied' | 'malformed' | 'disappeared' | 'reuse-during-read';
function processFixture(t: TestContext) {
  const boot = { machineId: fs.readFileSync('/etc/machine-id', 'utf8').trim(), bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  const identities = [process.pid, process.ppid].map((pid, index): ProcessIdentity => {
    const line = childProcess.execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim();
    const match = line.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
    assert.ok(match, 'fixture has real Linux PID/start/command facts before measurement');
    return { pid, startedAt: new Date(match[1]).toISOString(), runner: 'codex', runnerSessionId: 'native-' + index,
      tmuxSession: 'verification-' + index, evidence: { ...boot, command: match[2], runId: 'run-' + index, tmuxPane: '%' + index } };
  });
  let mode: OSMode = 'alive';
  let reads = 0;
  const commands: AdapterCommand[] = [];
  const procReads: string[] = [];
  const allCommands: AdapterCommand[] = [];
  const allProcReads: string[] = [];
  const procTarget = (path: fs.PathLike) => {
    const name = String(path);
    return identities.some(identity => name.startsWith('/proc/' + identity.pid + '/')) ? name : undefined;
  };
  const beforeRead = (path: fs.PathLike) => {
    const name = procTarget(path);
    if (name) {
      procReads.push(name); allProcReads.push(name); reads++;
      if (mode === 'denied' || mode === 'disappeared' && reads > 1) throw Object.assign(new Error('Controlled OS read refusal'), { code: mode === 'denied' ? 'EACCES' : 'ENOENT' });
      if (mode === 'missing') throw Object.assign(new Error('Controlled missing process'), { code: 'ENOENT' });
    }
  };
  const transformRead = (name: string | undefined, value: Buffer | string) => {
    if (name) {
      const encode = (text: string) => typeof value === 'string' ? text : Buffer.from(text);
      if (mode === 'malformed') return encode('malformed');
      if ((mode === 'command' || mode === 'reuse-during-read' && reads > 1) && name.endsWith('/cmdline')) return encode('foreign\0command\0');
      if ((mode === 'start' || mode === 'reuse-during-read' && reads > 1) && name.endsWith('/stat')) {
        const text = value.toString();
        const end = text.lastIndexOf(')') + 2;
        const fields = text.slice(end).split(' '); fields[19] = String(Number(fields[19]) + 1000);
        return encode(text.slice(0, end) + fields.join(' '));
      }
    }
    return value;
  };
  const isRead = (operation: string) => operation === 'readFile' || operation === 'readFileSync';
  fsInterposition(t).push({
    before(operation, args) { if (isRead(operation)) beforeRead(args[0]); },
    after(operation, args, value) { return isRead(operation) ? transformRead(procTarget(args[0]), value) : value; },
  });
  const execute: AdapterCommandExecutor = async command => {
    commands.push(structuredClone(command));
    allCommands.push(structuredClone(command));
    assert.equal(basename(command.executable), 'ps', 'Unit OS executor must not spawn a runner or polling helper');
    if (mode === 'denied') return { exitCode: 1, stdout: '', stderr: 'Controlled process access denied' };
    if (mode === 'malformed') return { exitCode: 0, stdout: 'malformed', stderr: '' };
    const selected = command.args.includes('-p') ? identities.filter(identity => command.args[command.args.indexOf('-p') + 1].split(',').includes(String(identity.pid))) : identities;
    return { exitCode: 0, stderr: '', stdout: mode === 'missing' || mode === 'disappeared' ? '' : selected.map(identity => {
      const start = mode === 'start' ? new Date(Date.parse(identity.startedAt) + 1000) : new Date(identity.startedAt);
      const stamp = start.toUTCString().replace(',', '').replace(' GMT', '').split(' ');
      const lstart = [stamp[0], stamp[2], stamp[1], stamp[4], stamp[3]].join(' ');
      return `${identity.pid} ${lstart} ${mode === 'command' ? 'foreign command' : identity.evidence.command}`;
    }).join('\n') };
  };
  const previous = (globalThis as any)[bridgeKey];
  const state = { boot: async () => boot };
  (globalThis as any)[bridgeKey] = state;
  t.after(() => { (globalThis as any)[bridgeKey] = previous; });
  const globalScans = (rows: AdapterCommand[]) => rows.filter(command => command.args.includes('-axo') || command.args.includes('-ax') || command.args.includes('-ef')).length;
  const scanCount = () => globalScans(commands);
  const targetedCost = (pid: number) => allProcReads.filter(path => path.startsWith('/proc/' + pid + '/')).length
    + allCommands.filter(command => command.args.includes('-p') && command.args[command.args.indexOf('-p') + 1].split(',').includes(String(pid))).length;
  const targetedPids = () => [...new Set(procReads.flatMap(path => path.match(/^\/proc\/(\d+)\//)?.[1] ?? []).concat(commands.filter(command => command.args.includes('-p')).flatMap(command => command.args[command.args.indexOf('-p') + 1].split(','))))].sort();
  return { boot, identities, execute, commands, procReads, state, scanCount, targetedPids, targetedCost,
    totalScans: () => globalScans(allCommands),
    resetAll() { allCommands.length = 0; allProcReads.length = 0; commands.length = 0; procReads.length = 0; reads = 0; },
    mode(value: OSMode) { mode = value; reads = 0; }, reset() { commands.length = 0; procReads.length = 0; reads = 0; } };
}

test('fixture isolation: layered process and file fixtures restore real fs for the next fixture', { skip: process.platform !== 'linux' }, async t => {
  for (const order of ['process-then-meter', 'meter-then-process'] as const) for (const mode of ['missing', 'denied', 'disappeared'] as const) {
    let pid = 0;
    await t.test(`${order} ${mode}`, async inner => {
      const f = generationFixture(inner);
      const meter = order === 'meter-then-process' ? fileMeter(inner, f.generation) : undefined;
      const os = processFixture(inner);
      const outer = meter ?? fileMeter(inner, f.generation);
      os.mode(mode);
      pid = os.identities[0].pid;
      const reads = mode === 'disappeared' ? 2 : 1;
      for (let i = 1; i < reads; i++) fs.readFileSync(`/proc/${pid}/stat`);
      assert.throws(() => fs.readFileSync(`/proc/${pid}/stat`), /Controlled/);
      os.mode(mode);
      for (let i = 1; i < reads; i++) await fs.promises.readFile(`/proc/${pid}/stat`);
      await assert.rejects(fs.promises.readFile(`/proc/${pid}/cmdline`), /Controlled/);
      fs.readFileSync(join(f.generation, 'src/state-store.ts'));
      assert.equal(outer.snapshot().content.length, 1, 'Meter still observes runtime content through the shared interposition');
    });
    assert.deepEqual(realFsLeaks(), [], `${order} ${mode} leaves no fs wrapper behind`);
    assert.match(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), new RegExp('^' + pid + ' '));
    assert.match(String(await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8')), new RegExp('^' + pid + ' '));
    await t.test(`${order} ${mode} next independent fixture`, async inner => {
      const next = processFixture(inner);
      const meter = fileMeter(inner, tmpdir());
      assert.match(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), new RegExp('^' + pid + ' '));
      assert.match(String(await fs.promises.readFile(`/proc/${pid}/cmdline`)), /\S/);
      assert.deepEqual(next.procReads, [`/proc/${pid}/stat`, `/proc/${pid}/cmdline`], 'The next fixture sees its own alive mode, not the previous refusal');
      assert.equal(meter.log.filter(row => row.path.startsWith('/proc/')).length, 2);
    });
    assert.deepEqual(realFsLeaks(), []);
  }
});

for (const state of ['empty', 'many', 'missing', 'reuse', 'old-machine', 'old-boot', 'unknown'] as const) {
  test(`whole agent ps ${state}: store/profile/finalization and one process pass`, async t => {
    const f = generationFixture(t);
    const os = processFixture(t);
    const setup = f.open();
    const db = setup.startupContextDatabase;
    db.exec(`CREATE TABLE verification_events(payload TEXT NOT NULL);
      CREATE TRIGGER verification_audit AFTER INSERT ON pending_intents BEGIN INSERT INTO verification_events VALUES(NEW.payload); END;`);
    const sessions: SessionRecord[] = [];
    if (state !== 'empty') for (const [index, original] of os.identities.entries()) {
      const identity = structuredClone(original);
      if (index === 1 && state === 'old-machine') identity.evidence.machineId = 'foreign-machine';
      if (index === 1 && state === 'old-boot') identity.evidence.bootId = 'foreign-boot';
      const row: SessionRecord = { runId: 'run-' + index, addressId: 'agent-' + index, revision: 1, state: 'running', process: identity,
        activity: { type: 'hotfix', project: 'raf', features: ['profile-raf-performance'], phase: 'hotfix', cwd: f.generation } };
      sessions.push(row);
      setup.sessionRepository.transaction(tx => { tx.putSession(row); tx.putReservation({ runId: row.runId, resource: 'ram', amount: 1 }); });
    }
    if (state === 'missing') os.mode('missing');
    if (state === 'reuse') os.mode('command');
    if (state === 'unknown') os.mode('denied');
    setup.close();
    let opens = 0, closes = 0, contexts = 0;
    let owned: StateStore | undefined;
    const lifecycle: string[] = [];
    Object.assign(os.state, {
      context: () => { contexts++; return f.context(); },
      open: (path: string, options: any) => {
        opens++; owned = openStateStore(path, options);
        const close = owned.close;
        return { ...owned, close() { closes++; lifecycle.push('close'); close(); },
          recordCommandDuration(...args: Parameters<StateStore['recordCommandDuration']>) { lifecycle.push('ema'); return owned!.recordCommandDuration(...args); } };
      },
      services: (store: StateStore, configuration: RuntimeConfiguration, context: any) => runtime.createProductionServices(store, configuration, context, { execute: os.execute }),
    });
    const meter = fileMeter(t, f.generation);
    const result = await runProductionCli(['agent', 'ps'], { orchestratorRoot: f.root, homeDirectory: f.home, artifactPath: join(f.root, 'catalog.json') });
    assert.equal(result.exitCode, state === 'unknown' ? 1 : 0, result.stderr);
    if (state === 'unknown') assert.equal(JSON.parse(result.stderr).code, 'PROCESS_SCAN_UNKNOWN');
    const output = result.exitCode === 0 ? JSON.parse(result.stdout) : [];
    const expected = state === 'many' ? ['agent-0', 'agent-1'] : ['old-machine', 'old-boot'].includes(state) ? ['agent-0'] : [];
    assert.deepEqual(output.map((row: SessionRecord) => row.addressId).sort(), expected);
    assert.equal(opens, 1, 'One connection for startup, handler, profile and finalization');
    assert.equal(contexts, 1, 'Pure ps does not rebuild the same origin context');
    assert.equal(closes, 1);
    assert.deepEqual(lifecycle, ['ema', 'close']);
    assert.equal(os.scanCount() <= (state === 'empty' ? 0 : 1), true, 'One shared OS snapshot for every consumer in this command pass');
    const observed = output.map((row: SessionRecord) => row.observation?.observedAt);
    assert.equal(new Set(observed).size <= 1, true, 'A pass has one observation time');
    const inspect = openStateStore(join(f.home, '.raf', settings.state.fileName));
    t.after(() => inspect.close());
    assert.ok(inspect.getCommandTiming('agent ps'));
    assert.ok(inspect.readCostProfile().rows.some(row => row.command === 'agent ps'));
    for (const row of sessions) {
      const current = inspect.sessionRepository.transaction(tx => tx.getSession(row.runId))!;
      assert.deepEqual(current.process, row.process);
      if (state === 'unknown') {
        assert.equal(current.state, 'running');
        if (current.observation) assert.equal(current.observation.state, 'unknown');
        assert.equal(inspect.sessionRepository.transaction(tx => tx.listReservations()).some(reservation => reservation.runId === row.runId), true);
        assert.equal(inspect.startupContextDatabase.prepare('SELECT COUNT(*) AS n FROM verification_events').get()!.n, 0);
      }
      if (['missing', 'reuse'].includes(state) || ['old-machine', 'old-boot'].includes(state) && row.addressId === 'agent-1') {
        assert.equal(current.state, 'finished');
        const events = inspect.startupContextDatabase.prepare('SELECT payload FROM verification_events').all().map(row => JSON.parse(row.payload as string));
        assert.equal(events.filter(event => event.event === 'agent.closed' && event.runId === row.runId).length, 1);
      }
    }
    if (['missing', 'reuse', 'old-machine', 'old-boot'].includes(state)) {
      const events = inspect.startupContextDatabase.prepare('SELECT payload FROM verification_events ORDER BY rowid').all();
      const reservations = inspect.sessionRepository.transaction(tx => tx.listReservations());
      os.reset(); meter.reset(); opens = 0; closes = 0; contexts = 0; lifecycle.length = 0;
      const repeated = await runProductionCli(['agent', 'ps'], { orchestratorRoot: f.root, homeDirectory: f.home, artifactPath: join(f.root, 'catalog.json') });
      assert.equal(repeated.exitCode, 0, repeated.stderr);
      assert.deepEqual(JSON.parse(repeated.stdout).map((row: SessionRecord) => row.addressId).sort(), expected);
      assert.deepEqual(inspect.startupContextDatabase.prepare('SELECT payload FROM verification_events ORDER BY rowid').all(), events, 'Recovery events are committed once across repeated commands');
      assert.deepEqual(inspect.sessionRepository.transaction(tx => tx.listReservations()), reservations);
      assert.equal(os.scanCount() <= (expected.length ? 1 : 0), true);
      assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(contexts, 1);
    }
  });
}

for (const count of [1, 3, 7]) {
  test(`Linux ${count} observation-only wait passes: no inventory, SQLite reopen or global process scan`, { skip: process.platform !== 'linux' }, async t => {
    const f = generationFixture(t);
    const os = processFixture(t);
    const store = f.open();
    const meter = fileMeter(t, f.generation);
    let totalTargeted = 0;
    for (let pass = 0; pass < count; pass++) {
      os.reset();
      const rows = await runtime.observeIdentities([os.identities[0], os.identities[1], os.identities[0]], os.execute);
      assert.deepEqual(rows.map(row => row.state), ['alive', 'alive', 'alive']);
      assert.deepEqual(rows[0], rows[2], 'Repeated consumer of a full identity shares state/time/reason');
      assert.equal(os.scanCount(), 0, 'Known runner/worker wait must not enumerate all host processes');
      assert.deepEqual(os.targetedPids(), os.identities.map(identity => String(identity.pid)).sort());
      totalTargeted += os.targetedPids().length;
      await Promise.resolve();
    }
    assert.equal(totalTargeted, count * os.identities.length);
    assert.equal(meter.snapshot().full, 0, 'No origin operation is hidden inside observation-only iterations');
    assert.equal(meter.log.filter(row => /state\.sqlite/.test(row.path) && /^open/.test(row.operation)).length, 0);
    assert.ok(store.startupContextDatabase.prepare('SELECT 1').get());
  });
}

for (const change of ['start', 'command', 'missing', 'denied', 'malformed', 'disappeared', 'machine', 'boot', 'host-machine', 'host-boot'] as const) {
  test(`known identity fresh after wait rejects ${change} without inventing alive`, { skip: process.platform !== 'linux' }, async t => {
    const os = processFixture(t);
    const identity = structuredClone(os.identities[0]);
    assert.equal((await runtime.observeIdentity(identity, os.execute)).state, 'alive');
    await Promise.resolve(); os.reset();
    if (change === 'machine') identity.evidence.machineId = 'foreign-machine';
    else if (change === 'boot') identity.evidence.bootId = 'foreign-boot';
    else if (change === 'host-machine') os.boot.machineId = 'new-machine';
    else if (change === 'host-boot') os.boot.bootId = 'new-boot';
    else os.mode(change);
    const observed = await runtime.observeIdentity(identity, os.execute);
    assert.equal(observed.state, ['denied', 'malformed', 'disappeared'].includes(change) ? 'unknown' : 'exited');
    assert.ok(observed.state === 'unknown' ? observed.error : observed.state === 'exited' && observed.evidence);
    assert.equal(os.scanCount(), 0, 'Linux known-identity check stays targeted on failure too');
  });
}

test('one PID with different full identities cannot share an alive proof', { skip: process.platform !== 'linux' }, async t => {
  const os = processFixture(t);
  const original = os.identities[0];
  const foreign = structuredClone(original);
  foreign.evidence.command = 'foreign command';
  const rows = await runtime.observeIdentities([original, foreign, original], os.execute);
  assert.deepEqual(rows.map(row => row.state), ['alive', 'exited', 'alive']);
  assert.equal(os.scanCount(), 0);
  assert.deepEqual(os.targetedPids(), [String(original.pid)]);
});

test('extra consumers do not multiply real targeted OS reads in one identity pass', { skip: process.platform !== 'linux' }, async t => {
  const os = processFixture(t);
  await runtime.observeIdentities([os.identities[0]], os.execute);
  const single = [...os.procReads]; const helpers = os.commands.length;
  os.reset();
  const rows = await runtime.observeIdentities(Array(5).fill(os.identities[0]), os.execute);
  for (const row of rows) assert.deepEqual(row, rows[0]);
  assert.equal(os.scanCount(), 0);
  assert.deepEqual(os.procReads, single, 'Metadata/content reads cannot grow with duplicate consumers');
  assert.equal(os.commands.length, helpers);
  assert.ok(single.length > 0 || helpers > 0, 'An empty fake observation is not evidence of identity');
});

test('PID reuse between targeted OS reads never becomes an alive identity', { skip: process.platform !== 'linux' }, async t => {
  const os = processFixture(t);
  os.mode('reuse-during-read');
  const observed = await runtime.observeIdentity(os.identities[0], os.execute);
  assert.notEqual(observed.state, 'alive', 'Mixed process-start/command evidence cannot prove ownership');
  assert.ok(observed.state === 'unknown' ? observed.error : observed.state === 'exited' && observed.evidence);
  assert.equal(os.scanCount(), 0);
});

for (const changed of ['pane-id', 'pane-pid', 'process-command', 'pane-denied'] as const) {
  test(`known runner ownership observes fresh ${changed} before delivery without a global scan`, { skip: process.platform !== 'linux' }, async t => {
    const os = processFixture(t);
    let changedNow = false;
    const identity = os.identities[0];
    const execute: AdapterCommandExecutor = async command => {
      if (basename(command.executable) === 'tmux') {
        if (changedNow && changed === 'pane-denied') return { exitCode: 1, stdout: '', stderr: 'Pane inaccessible' };
        const paneId = command.args.at(-1) === '#{pane_id}';
        return { exitCode: 0, stderr: '', stdout: paneId
          ? changedNow && changed === 'pane-id' ? '%999999' : identity.evidence.tmuxPane!
          : String(changedNow && changed === 'pane-pid' ? 99999999 : identity.pid) };
      }
      const result = await os.execute(command);
      if (command.args.some(arg => arg.includes('ppid='))) result.stdout = result.stdout.split('\n').map(line => line.replace(/^(\d+) /, '$1 0 ')).join('\n');
      return result;
    };
    assert.equal(await runtime.belongsToPane(identity, execute), true);
    await Promise.resolve(); changedNow = true; os.reset();
    if (changed === 'process-command') os.mode('command');
    assert.equal(await runtime.belongsToPane(identity, execute), false);
    assert.equal(os.scanCount(), 0, 'Ownership of a known runner does not enumerate the host');
  });
}

for (const reason of ['protected-state', 'launch', 'stop', 'delivery'] as const) {
  test(`wait boundary ${reason} uses fresh process facts`, { skip: process.platform !== 'linux' }, async t => {
    const f = generationFixture(t);
    const os = processFixture(t);
    const context = f.context(); f.open(context).close();
    assert.equal((await runtime.observeIdentity(os.identities[0], os.execute)).state, 'alive');
    await Promise.resolve();
    f.open(context).close();
    os.reset(); os.mode('start');
    assert.equal((await runtime.observeIdentity(os.identities[0], os.execute)).state, 'exited', reason + ' cannot reuse the earlier alive');
    assert.equal(os.scanCount(), 0);
  });
}

for (const argv of [['help'], ['agent', 'ps', '--unknown'], ['unknown-command']]) {
  test(`whole entry ${argv.join(' ')} has zero runtime/state/inventory/process work`, async t => {
    const f = generationFixture(t);
    const os = processFixture(t);
    let calls = 0;
    Object.assign(os.state, { context: () => { calls++; throw new Error('Help/parser must stay lazy'); }, open: () => { calls++; throw new Error('Unexpected state access'); }, services: () => { calls++; throw new Error('Unexpected runtime'); } });
    const meter = fileMeter(t, f.generation);
    const result = await runProductionCli(argv, { orchestratorRoot: f.root, homeDirectory: f.home, artifactPath: join(f.root, 'catalog.json') });
    assert.equal(result.exitCode, argv[0] === 'help' ? 0 : 1);
    assert.equal(calls, 0); assert.equal(os.commands.length, 0); assert.equal(meter.snapshot().full, 0);
    assert.equal(fs.existsSync(join(f.home, '.raf')), false);
  });
}

for (const queued of [false, true]) for (const count of [1, 4]) for (const scenario of ['ready', 'protected-state', 'timeout', 'unknown', 'pane-lost', 'delivery-error', 'ownership-changed'] as const) {
  test(`whole agent run ${queued ? 'queue' : 'legacy'} ${scenario} with ${count} controlled wait passes preserves delivery and total costs`, { skip: process.platform !== 'linux' }, async t => {
    const f = generationFixture(t);
    const os = processFixture(t);
    const selected = { status: 'selected' as const, runner: 'codex' as const, model: 'unit-model', effort: 'unit-effort', reason: 'controlled selection', quota: 'unknown' as const };
    const runner = { ...os.identities[0], tmuxSession: 'unit-launch', runnerSessionId: 'native-ready' };
    assert.deepEqual((await runtime.observeIdentities([runner, os.identities[1]], os.execute)).map(row => row.state), ['alive', 'alive']);
    const costPerPid = os.identities.map(identity => os.targetedCost(identity.pid));
    os.resetAll();
    let currentStore: StateStore;
    let opens = 0, closes = 0, contexts = 0, pass = 0, delivered = 0, aborted = 0, committed = 0, clock = 0;
    const frames: { traversals: number; scans: number; pids: string[]; states: string[] }[] = [];
    const operations: string[] = [];
    const meter = fileMeter(t, f.generation);
    const adapter = new TmuxAgentAdapter({ execute: async command => {
      operations.push(command.args[0]);
      return { exitCode: 0, stdout: '', stderr: '' };
    }, protocols: { codex: { invocation: () => ({ executable: 'unit-runner', args: [] }), observe: () => ({ status: 'starting' }) } } } as any);
    t.mock.method(adapter, 'startWithoutInput', async (request: any) => ({ tmuxSession: request.tmuxSession, selection: request.selection }));
    t.mock.method(adapter, 'inspect', async () => {
      pass++; os.reset();
      const before = meter.snapshot().full;
      if (scenario === 'protected-state' && pass === Math.min(2, count)) {
        const guard = f.context();
        const store = openStateStore(guard.statePath, { context: guard }); store.close();
      }
      const rows = await runtime.observeIdentities([runner, os.identities[1], runner], os.execute);
      frames.push({ traversals: meter.snapshot().full - before, scans: os.scanCount(), pids: os.targetedPids(), states: rows.map(row => row.state) });
      if (scenario === 'unknown' && pass === count) return { status: 'failed', reason: 'unknown ownership' };
      if (scenario === 'pane-lost' && pass === count) return { status: 'exited', exitCode: null };
      if (pass < count || scenario === 'timeout') return { status: 'starting' };
      return { status: 'ready', cliSessionId: runner.runnerSessionId };
    });
    t.mock.method(adapter, 'deliver', async (_session: any, brief: string) => {
      assert.equal(brief, 'literal brief $(never-execute)');
      if (scenario === 'delivery-error') throw new Error('primary delivery failure');
      delivered++;
    });
    const transport = adapter.createLaunchTransport({ reportWrapper: { wrap: command => command }, pollIntervalMs: 1,
      now: () => clock, delay: async () => { clock++; await Promise.resolve(); },
      inspectOwnership: async () => {
        const observation = await runtime.observeIdentity(runner, os.execute);
        if (scenario === 'ownership-changed') return { state: 'mismatch', reason: 'Native runner no longer owns pane' };
        return observation.state === 'alive' ? { state: 'owned', identity: runner, processKind: 'agent' } : { state: observation.state === 'unknown' ? 'unknown' : 'exited', reason: 'Controlled ownership failure' };
      } });
    const launch = { runId: 'unit-run', addressId: 'unit-agent', cwd: join(f.root, 'raf-develop'), tmpRoot: join(f.home, '.raf/tmp'),
      statePath: join(f.home, '.raf', settings.state.fileName), tmuxSession: 'unit-launch', selection: selected, brief: 'literal brief $(never-execute)', readinessTimeoutMs: count,
      assignment: { root: f.root, changes: [{ id: 'profile-raf-performance', items: [{ id: '5.11', description: 'Controlled runtime' }] }], baselineArchives: [] } };
    const services = {
      assignment: { validate: async () => ({ ok: true, snapshot: launch.assignment }), compose: async () => launch.brief },
      resolveTask: async () => ({ branch: 'develop', outcome: 'unit', sources: [], writeBoundaries: [], workspaceWritable: false, requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [], reportSchema: { type: 'object' } }),
      route: async () => ({ ok: true, project: 'raf', branch: 'develop', cwd: launch.cwd }),
      routingSnapshot: async () => ({ runnerEnabled: { codex: true }, cliAvailable: { codex: true }, quotas: [] }),
      selectModel: () => selected,
      prepareReport: async () => ({ reportPath: join(launch.tmpRoot, launch.runId, 'unit-agent.json'), reportWrapper: { wrap: (command: any) => command }, cleanupUnstarted: async () => { operations.push('cleanup'); } }),
      reserve: async () => { operations.push('reserve'); return { admitted: true }; },
      adapter: { start: async () => {
        await transport.startWithoutInput(launch);
        const ready = await transport.waitReady(count);
        if (ready.state !== 'ready') throw new Error('primary readiness ' + ready.state);
        await transport.deliver(launch.brief);
        return { tmuxSession: launch.tmuxSession, selection: selected };
      } },
      verifyStarted: async () => { operations.push('verify'); const row = await runtime.observeIdentity(runner, os.execute); assert.equal(row.state, 'alive'); return runner; },
      commitStarted: async () => { committed++; return true; },
      compensate: async () => { operations.push('compensate'); return { stopped: true }; },
      abortLaunch: async () => { aborted++; },
      control: { ps: async () => [], message: async () => ({ accepted: false, reason: 'No unit recipient' }) },
    };
    const queueOwner = { runId: launch.runId, fence: 'unit-fence' };
    const clientRun = 'unit-launch-client';
    const clientIdentity = { pid: os.identities[1].pid, startedAt: os.identities[1].startedAt, ...os.boot };
    const queueRecord = { queueId: 'unit-queue', requestId: 'unit-request', agentId: launch.addressId, owner: queueOwner,
      clientIdentity, coordinator: null, eventHandle: null };
    const validation = { assignment: launch.assignment, fingerprint: 'unit-assignment', requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [] };
    const admission = { level: 'ANY_RUN', requestedTier: 'normal', allowed: true, reasons: [], measurement: { machineId: os.boot.machineId,
      loadAverage1m: null, availableCores: null, totalRamBytes: null, availableRamBytes: null, memoryPressure: null, fileSystems: [] },
      thresholds: null, reservation: { requested: validation.requested, unused: { ramBytes: 0, diskBytes: {} } }, remaining: null,
      estimate: { status: 'KNOWN', sources: ['unit-port'], reason: null }, queueId: queueRecord.queueId };
    const claim = () => currentStore.sessionRepository.transaction(tx => tx.listReservations().map(row => row.runId).sort());
    const checkOwner = (record: unknown) => assert.deepEqual(record, queueRecord, 'Queue fence and launch client remain unchanged');
    if (queued) Object.assign(services, { agentQueue: async () => ({
      request: { orchestratorRoot: f.root, homeDirectory: f.home, developmentDirectory: launch.cwd, project: 'raf', agentId: launch.addressId,
        agentType: 'implement', owner: queueOwner, clientIdentity, selections: [{ change: 'profile-raf-performance', items: ['5.11'] }], coordinator: null },
      ports: {
        validate: async () => ({ ok: true, validation }),
        claimAndAdmit: async () => {
          operations.push('reserve');
          currentStore.sessionRepository.transaction(tx => tx.putReservation({ runId: clientRun, resource: 'ram', amount: 1 }));
          return { kind: 'reserved', record: queueRecord, admission };
        },
        transition: async (record: unknown, phase: string) => { checkOwner(record); operations.push(phase); return true; },
        waitForResources: async () => { throw new Error('Readiness must not become a resource polling loop'); },
        recheckAndReserve: async () => { throw new Error('An admitted request must not claim twice'); },
        commitReady: async (record: unknown) => {
          checkOwner(record); assert.deepEqual(claim(), [clientRun]);
          currentStore.sessionRepository.transaction(tx => {
            tx.deleteReservation(clientRun); tx.putReservation({ runId: launch.runId, resource: 'ram', amount: 1 });
          });
          committed++; return true;
        },
        cleanup: async (record: unknown) => {
          checkOwner(record); assert.deepEqual(claim(), [clientRun]);
          currentStore.sessionRepository.transaction(tx => tx.deleteReservation(clientRun));
          aborted++;
          return { state: 'released', reason: 'Verified controlled stop', completed: ['release-client-claims'], pending: [] };
        },
        observe: async () => ({ owner: 'client', client: 'alive', agent: 'unknown', reason: 'Controlled owner' }),
        writeStderr: () => { throw new Error('An admitted request has no waiting progress'); },
      },
    }) });
    Object.assign(os.state, {
      context: () => { contexts++; return f.context(); },
      open: (path: string, options: any) => {
        opens++; const store = openStateStore(path, options); currentStore = store;
        const close = store.close;
        return { ...store, close() { closes++; close(); } };
      }, services: async () => services,
    });
    const result = await runProductionCli(['agent', 'run', '--id', 'unit-agent', '--type', 'implement', '--project', 'raf', '--features', 'profile-raf-performance', '--phase', 'implement', '--complexity', models.routing.complexityOrder[0], '--tasks', 'profile-raf-performance:5.11'],
      { orchestratorRoot: f.root, homeDirectory: f.home, artifactPath: join(f.root, 'catalog.json'), runIdentity: { runId: 'unit-run', tmuxSession: 'unit-launch' } });
    const successful = scenario === 'ready' || scenario === 'protected-state';
    assert.equal(result.exitCode, successful ? 0 : 1, result.stderr);
    assert.equal(pass, count, 'The fixture, not implementation, chooses the number of wait passes');
    assert.equal(delivered, successful ? 1 : 0);
    assert.equal(committed, successful ? 1 : 0);
    assert.equal(aborted, successful ? 0 : 1);
    assert.equal(operations.filter(operation => operation === 'reserve').length, 1);
    if (!successful) assert.match(result.stderr, scenario === 'ownership-changed' ? /Verified runner ownership is required/ : /primary (?:readiness|delivery)/, 'Cleanup and profiling preserve the primary failure');
    if (successful) {
      const output = JSON.parse(result.stdout);
      assert.equal(output.runId, 'unit-run'); assert.equal(output.addressId, 'unit-agent'); assert.deepEqual(output.process, runner);
    }
    const check = openStateStore(launch.statePath); t.after(() => check.close());
    assert.ok(check.getCommandTiming('agent run')); assert.ok(check.readCostProfile().rows.some(row => row.command === 'agent run'));
    if (queued) {
      assert.deepEqual(check.sessionRepository.transaction(tx => tx.listReservations().map(row => row.runId)), successful ? [launch.runId] : []);
      assert.equal(operations.filter(operation => operation === 'starting').length, 1);
      if (successful) assert.deepEqual(JSON.parse(result.stdout).queue, { queueId: queueRecord.queueId, waited: false });
    }
    assert.equal(os.totalScans(), 0, 'The entire known-identity command, including delivery and final verification, has no global ps');
    const ownershipChecks = successful || scenario === 'delivery-error' || scenario === 'ownership-changed' ? 1 : 0;
    const finalChecks = successful ? (queued ? 2 : 1) : 0;
    assert.equal(os.targetedCost(runner.pid), costPerPid[0] * (count + ownershipChecks + finalChecks), 'Runner OS reads scale with actual waits and independent ownership boundaries');
    assert.equal(os.targetedCost(os.identities[1].pid), costPerPid[1] * count, 'Worker OS reads scale with waits, not duplicate consumers');
    assert.equal(opens, 1, 'One command store serves handler and profile');
    assert.equal(contexts, 1, 'Observation iterations do not rebuild production context');
    assert.equal(closes, 1);
    for (const [index, frame] of frames.entries()) {
      assert.equal(frame.scans, 0, 'Known runner/worker observations use no Linux global scan');
      assert.deepEqual(frame.pids, os.identities.map(identity => String(identity.pid)).sort());
      assert.deepEqual(frame.states, ['alive', 'alive', 'alive']);
    }
    assert.equal(frames.reduce((sum, frame) => sum + frame.pids.length, 0), count * os.identities.length);
    assert.equal(operations.some(operation => ['spawn', 'exec', 'poll-helper'].includes(operation)), false);
  });
}
