import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { before, test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import { openStateStore } from '../src/state-store.ts';
import { sqliteTestRunState } from '../src/test-run-runtime.ts';
import type { TestRunGroup, TestRunGroupKey, TestRunResult, TestRunTransaction } from '../src/test-runs.ts';

const code = fileURLToPath(new URL('..', import.meta.url));
const sourceConf = resolve(code, '../conf');
const change = 'complete-raf-flow-contracts';
const group = `${change}/z409`;
const secondGroup = `${change}/z409-peer`;
const branch = 'qa-z409';
const files = ['socket-a.test.ts', 'socket-b.test.ts', 'unselected.test.ts'];
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
let capacity: number;

function json(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function save(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

before(() => {
  execFileSync('tmux', ['-V'], { encoding: 'utf8' });
  assert.equal(process.platform, 'linux', 'this local pathname regression requires the Linux sockaddr_un declaration');
  const header = ['/usr/include/x86_64-linux-gnu/sys/un.h', '/usr/include/aarch64-linux-gnu/sys/un.h', '/usr/include/sys/un.h'].find(existsSync);
  assert.ok(header, 'setup: install local libc headers; do not classify this as assertion-red');
  const match = readFileSync(header, 'utf8').match(/sun_path\s*\[\s*(\d+)\s*\]/u);
  assert.ok(match, 'setup: cannot establish local sun_path capacity');
  capacity = Number(match[1]);
});

interface Observation {
  pid: number;
  HOME: string;
  RAF_QA_HOME: string;
  TMPDIR: string;
  tmpdir: string;
}

interface Probe extends Observation {
  descendant: Observation;
  fixture: Observation & { TMUX_TMPDIR: string };
  pane: { HOME: string; RAF_QA_HOME: string; TMPDIR: string };
  endpoint: string;
  endpointBytes: number;
  suffixBytes: number;
  commands: { operation: string; code: number; output: string }[];
}

interface Reply {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

interface Invocation {
  driver: ChildProcess;
  reply: Promise<Reply>;
  callerRunId: string;
}

function probeSource(index: number): string {
  return `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const observe = () => ({ pid: process.pid, HOME: process.env.HOME, RAF_QA_HOME: process.env.RAF_QA_HOME, TMPDIR: process.env.TMPDIR, tmpdir: tmpdir() });
test('Z409 nested tmux ${index}', async () => {
  const inherited = observe();
  const base = mkdtempSync(join(tmpdir(), 'f-'));
  const home = join(base, 'h');
  const tmuxTmp = join(home, 't');
  mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  const endpoint = join(tmuxTmp, 's');
  const environment = { ...process.env, HOME: home, TMUX_TMPDIR: tmuxTmp, TMUX: '', TMUX_PANE: '' };
  const commands = [];
  const tmux = (operation, args = [], required = true) => {
    const result = spawnSync('tmux', ['-S', endpoint, operation, ...args], { env: environment, encoding: 'utf8' });
    commands.push({ operation, code: result.status, output: result.stdout + result.stderr });
    if (required) assert.equal(result.status, 0, operation + ': ' + result.stderr);
    return result;
  };
  try {
    const source = 'const os=require("node:os"); process.stdout.write(JSON.stringify({pid:process.pid,HOME:process.env.HOME,RAF_QA_HOME:process.env.RAF_QA_HOME,TMPDIR:process.env.TMPDIR,TMUX_TMPDIR:process.env.TMUX_TMPDIR,tmpdir:os.tmpdir()}))';
    const descendant = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
    assert.equal(descendant.status, 0, descendant.stderr);
    const fixture = spawnSync(process.execPath, ['-e', source], { env: environment, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const suffixBytes = Buffer.byteLength(endpoint.slice(inherited.TMPDIR.length), 'utf8');
    assert.ok(Buffer.byteLength(endpoint, 'utf8') + 1 <= ${capacity}, 'actual pathname including NUL must fit');
    tmux('new-session', ['-d', '-s', 'z409', 'sh']);
    tmux('has-session', ['-t', 'z409']);
    tmux('send-keys', ['-t', 'z409', "printf '%s\\\\n' \\\"$HOME\\\" \\\"$RAF_QA_HOME\\\" \\\"$TMPDIR\\\" > pane-env-${index}.txt; printf 'Z409_%s\\\\n' SOCKET_OK", 'Enter']);
    let captured = '';
    while (!captured.includes('Z409_SOCKET_OK')) {
      captured = tmux('capture-pane', ['-p', '-t', 'z409']).stdout;
      if (!captured.includes('Z409_SOCKET_OK')) await new Promise(done => setTimeout(done, 10));
    }
    const [paneHome, paneQaHome, paneTmp] = readFileSync('pane-env-${index}.txt', 'utf8').trimEnd().split('\\n');
    writeFileSync('probe-${index}.json', JSON.stringify({ ...inherited, descendant: JSON.parse(descendant.stdout), fixture: JSON.parse(fixture.stdout), pane: { HOME: paneHome, RAF_QA_HOME: paneQaHome, TMPDIR: paneTmp }, endpoint, endpointBytes: Buffer.byteLength(endpoint, 'utf8'), suffixBytes, commands }));
    if (existsSync('hold-${index}')) {
      while (!existsSync('release-${index}')) await new Promise(done => setTimeout(done, 10));
    }
    tmux('kill-server');
    writeFileSync('finished-${index}.json', JSON.stringify({ commands, afterKill: tmux('has-session', ['-t', 'z409'], false).status }));
  } finally {
    tmux('kill-server', [], false);
    rmSync(base, { recursive: true, force: true });
  }
});
`;
}

function fixture(t: TestContext) {
  const stand = mkdtempSync('/tmp/z409-');
  const root = join(stand, 'orchestrator');
  const workspace = join(stand, 'workspace');
  const controlHome = join(stand, 'control-home');
  const unitHome = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`, createHash('sha256').update(JSON.stringify([root, 'raf', workspace])).digest('hex'));
  const roots = new Set<string>();
  const invocations: Invocation[] = [];
  t.after(async () => {
    if (existsSync(workspace)) for (const index of [0, 1]) writeFileSync(join(workspace, `release-${index}`), 'cleanup');
    await Promise.allSettled(invocations.map(invocation => invocation.reply));
    for (const index of [0, 1]) {
      const observation = join(workspace, `probe-${index}.json`);
      if (existsSync(observation)) {
        try { execFileSync('tmux', ['-S', json(observation).endpoint, 'kill-server'], { stdio: 'ignore' }); }
        catch {}
      }
    }
    for (const invocation of invocations) if (invocation.driver.connected) invocation.driver.disconnect();
    rmSync(unitHome, { recursive: true, force: true });
    for (const path of roots) rmSync(path, { recursive: true, force: true });
    rmSync(stand, { recursive: true, force: true });
  });
  const cfgPath = join(root, 'conf/test-runs.json');
  const environment = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'Etc/UTC',
    HOME: controlHome, RAF_QA_HOME: controlHome, RAF_ORCHESTRATOR_ROOT: root,
    TMUX: '', TMUX_PANE: '',
  };
  for (const directory of [join(root, 'conf'), join(root, 'openspec/changes', change), workspace, controlHome]) mkdirSync(directory, { recursive: true });
  mkdirSync(unitHome, { recursive: true, mode: 0o700 });
  t.diagnostic(`fixture unitHome mode: 0${(lstatSync(unitHome).mode & 0o7777).toString(8)}`);
  for (const name of ['projects.json', 'raf.json', 'raf-constants.json', 'flow.json', 'test-runs.json']) cpSync(join(sourceConf, name), join(root, 'conf', name));
  const projects = json(join(root, 'conf/projects.json'));
  const raf = projects.projects.raf;
  const production = projects.profiles[raf.profile].production;
  const productionCode = resolve(sourceConf, '..', raf.path);
  projects.projects = { raf: { ...raf, path: productionCode, branchPaths: { [production]: productionCode, develop: code, [branch]: workspace } } };
  save(join(root, 'conf/projects.json'), projects);
  execFileSync('git', ['init', '-q', '-b', branch, workspace]);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--allow-empty', '-qm', 'Z409 isolated caller fixture']);
  const entryObservation = join(workspace, 'runner-entries.jsonl');
  const childPreload = join(stand, 'child-observation.mjs');
  writeFileSync(childPreload, `import { appendFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; appendFileSync(${JSON.stringify(entryObservation)}, JSON.stringify({pid:process.pid,HOME:process.env.HOME,RAF_QA_HOME:process.env.RAF_QA_HOME,TMPDIR:process.env.TMPDIR,tmpdir:tmpdir()})+'\\n');`);
  const resourcePreload = join(stand, 'resource-preload.mjs');
  writeFileSync(resourcePreload, `
import { mock } from 'node:test';
import * as original from ${JSON.stringify(pathToFileURL(join(code, 'src/os-runtime.ts')).href)};
mock.module(${JSON.stringify(pathToFileURL(join(code, 'src/os-runtime.ts')).href)}, { namedExports: {
  ...original,
  createResourceSnapshotReader: ({ machineId, paths }) => ({ read: async () => ({
    measurement: { machineId, loadAverage1m: 0, availableCores: 8, totalRamBytes: 2 ** 40, availableRamBytes: 2 ** 39, memoryPressure: 'normal', fileSystems: [{ id: 'z409-volume', totalBytes: 2 ** 40, availableBytes: 2 ** 39 }] },
    reasons: [], fileSystemByPath: Object.fromEntries(paths.map(path => [path, 'z409-volume'])),
  }) }),
} });
`);
  const driverPath = join(stand, 'caller.mjs');
  writeFileSync(driverPath, `
import { spawn } from 'node:child_process';
process.send({ ready: true });
process.once('message', ({ argv }) => {
  const child = spawn(process.execPath, argv, { cwd: ${JSON.stringify(workspace)}, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  child.once('error', error => { process.send({ error: error.message }); process.exitCode = 1; });
  child.once('close', (code, signal) => { process.send({ code, signal, stdout, stderr }); process.disconnect(); });
});
`);
  const config = json(cfgPath);
  config.projects = { raf: {
    profiles: { node: {
      cwd: '.', executable: process.execPath, argv: ['--import', childPreload, join(code, 'scripts/test-run-node.ts')],
      unitFiles: files, exactIds: 'node-test-name', resultAdapter: 'node-test-events',
      environment: { isolatedHome: true, stateOrigin: true }, checks: [],
      resourceEstimate: { ramBytes: 2147483648, diskBytesPerFileSystem: 10737418240 },
    } },
    groups: { [group]: { profileId: 'node', files: [files[0]] }, [secondGroup]: { profileId: 'node', files: [files[1]] } },
  } };
  const makeRoot = (prefix = '/tmp/ж-'): string => {
    const path = mkdtempSync(prefix);
    roots.add(path);
    return path;
  };
  config.temporaryArtifacts.root = makeRoot();
  save(cfgPath, config);
  for (const index of [0, 1]) writeFileSync(join(workspace, files[index]), probeSource(index));
  writeFileSync(join(workspace, files[2]), "throw new Error('unselected inventory sentinel executed');\n");
  const context = resolveStateContext({ orchestratorRoot: root, modulePath: join(code, 'src/test-run-runtime.ts'), homeDirectory: unitHome, operatingSystemHome: userInfo().homedir, environment: { ...environment, HOME: unitHome, RAF_QA_HOME: unitHome }, entryPoint: 'cli' });
  const state = async <T>(operation: (transaction: TestRunTransaction) => T): Promise<T> => {
    const store = openStateStore(context.statePath, { context });
    try { return await sqliteTestRunState(store).transaction(operation); }
    finally { store.close(); }
  };
  const key = (selectedGroup = group): TestRunGroupKey => ({ project: 'raf', workspace, group: selectedGroup });
  const snapshot = (selectedGroup = group): Promise<TestRunGroup | null> => state(tx => tx.get(key(selectedGroup)));
  const seed = async (selectedGroup = group, index = 0): Promise<void> => {
    const policy = json(join(root, 'conf/flow.json')).unitTests;
    const timeoutCount = Math.min(policy.optimizeAfterTimeouts, policy.maxGroupTimeouts - 1);
    await state(tx => tx.put({ key: key(selectedGroup), testKind: 'unit', profileId: 'node', timeoutCount, state: timeoutCount >= policy.optimizeAfterTimeouts ? 'optimize' : 'idle', selection: { files: [files[index]], testIds: [] }, knownRed: [], unexecuted: [], inFlight: null, lastResult: null }));
  };
  const start = async (phase: 'implement' | 'qa', index = 0, selectedGroup = group): Promise<Invocation> => {
    const driver = fork(driverPath, [], { cwd: workspace, env: environment, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const ready = new Promise<void>((done, fail) => {
      driver.once('error', fail);
      driver.once('message', () => done());
      driver.once('exit', exit => fail(new Error(`fixture caller exited before registration: ${exit}`)));
    });
    try {
      await ready;
      const processRow = execFileSync('ps', ['-ww', '-p', String(driver.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u);
      assert.ok(processRow, 'fixture requires the actual caller process identity');
      const callerRunId = randomUUID();
      const store = openStateStore(join(controlHome, '.raf', json(join(root, 'conf/raf.json')).state.fileName));
      try {
        store.sessionRepository.transaction(tx => tx.putSession({
          runId: callerRunId, addressId: `z409-${callerRunId}`, revision: 0, state: 'running',
          process: { pid: driver.pid!, startedAt: new Date(processRow[1]).toISOString(), runner: 'qa', runnerSessionId: callerRunId, tmuxSession: '', evidence: { command: processRow[2], machineId: readFileSync('/etc/machine-id', 'utf8').trim(), bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } },
          launchContext: {
            assignment: { root, changes: [{ id: change, items: [{ id: 'Z.409.1', description: 'Isolated production socket channel regression' }] }], baselineArchives: [] },
            selection: { runner: 'qa', model: 'fixture', effort: 'fixture', reason: 'Controlled caller ancestry' },
            briefPath: join(stand, `brief-${callerRunId}.md`), reportPath: join(stand, `report-${callerRunId}.json`),
            testAssignment: { runId: callerRunId, agentId: `z409-${callerRunId}`, type: phase, phase, project: 'raf', workspace, branch, changes: [change] },
          },
        }));
      } finally { store.close(); }
      const reply = new Promise<Reply>((done, fail) => {
        driver.once('error', fail);
        driver.once('message', value => value.error ? fail(new Error(value.error)) : done(value as Reply));
        driver.once('exit', exit => fail(new Error(`fixture caller exited without a complete reply: ${exit}`)));
      });
      void reply.catch(() => {});
      const invocation = { driver, reply, callerRunId };
      invocations.push(invocation);
      driver.send({ argv: ['--experimental-test-module-mocks', '--import', resourcePreload, join(code, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', phase, '--group', selectedGroup, '--files', files[index]] });
      return invocation;
    } catch (error) {
      driver.kill();
      if (driver.connected) driver.disconnect();
      throw error;
    }
  };
  return {
    stand, root, workspace, unitHome, context, config, cfgPath, entryObservation, roots, key, snapshot, seed, start,
    probe: (index = 0): Probe => json(join(workspace, `probe-${index}.json`)),
    release: (index = 0): void => { writeFileSync(join(workspace, `release-${index}`), 'release'); },
    hold: (index = 0): void => { writeFileSync(join(workspace, `hold-${index}`), 'hold'); },
    setRoot: (path: string): void => { config.temporaryArtifacts.root = path; save(cfgPath, config); },
    makeRoot,
  };
}

type Fixture = ReturnType<typeof fixture>;

function result(reply: Reply): TestRunResult {
  assert.equal(reply.signal, null, reply.stderr);
  assert.ok(reply.stdout.trim(), `setup: no TestRunResult; ${reply.stderr}`);
  return JSON.parse(reply.stdout) as TestRunResult;
}

function passed(reply: Reply): TestRunResult {
  const output = result(reply);
  assert.equal(reply.code, 0, JSON.stringify({ output, stderr: reply.stderr }));
  assert.equal(output.outcome, 'passed', JSON.stringify(output));
  assert.equal(output.exitCode, 0, 'CLI and runner exit codes are separate evidence');
  assert.equal(output.timedOut, false);
  assert.deepEqual(output.cleanup, { complete: true, remainingPids: [] });
  return output;
}

function delivery(f: Fixture, output: TestRunResult, probe: Probe): void {
  const environment = output.command!.environment;
  assert.equal(environment.HOME, f.unitHome);
  assert.equal(environment.statePath, f.context.statePath);
  assert.equal(environment.tmpPath, f.context.tmpRoot);
  assert.match(f.unitHome, /\/raf-unit-[^/]+\/[a-f0-9]{64}$/u);
  assert.ok(bytes(f.unitHome) > bytes(probe.TMPDIR));
  assert.notEqual(probe.TMPDIR, f.context.tmpRoot);
  assert.equal(probe.TMPDIR, environment.TMPDIR);
  for (const descendant of [probe, probe.descendant, probe.fixture]) {
    assert.equal(descendant.TMPDIR, probe.TMPDIR);
    assert.equal(descendant.tmpdir, probe.TMPDIR);
    assert.equal(descendant.RAF_QA_HOME, f.unitHome);
  }
  assert.equal(probe.HOME, f.unitHome);
  assert.equal(probe.descendant.HOME, f.unitHome);
  assert.notEqual(probe.fixture.HOME, f.unitHome);
  assert.ok(probe.fixture.HOME.startsWith(probe.TMPDIR + '/'));
  assert.equal(probe.pane.HOME, probe.fixture.HOME);
  assert.equal(probe.pane.RAF_QA_HOME, f.unitHome);
  assert.equal(probe.pane.TMPDIR, probe.TMPDIR);
  assert.equal(dirname(probe.endpoint), probe.fixture.TMUX_TMPDIR);
  assert.equal(probe.endpointBytes, bytes(probe.endpoint));
  assert.equal(probe.suffixBytes, bytes(probe.endpoint.slice(probe.TMPDIR.length)));
  assert.ok(probe.suffixBytes <= f.config.temporaryArtifacts.minimumNestedSocketPathBytes);
  assert.ok(probe.endpointBytes + 1 <= capacity, 'actual endpoint plus NUL');
  assert.ok(bytes(probe.TMPDIR) + f.config.temporaryArtifacts.minimumNestedSocketPathBytes + 1 <= capacity, 'created path plus configured suffix reserve plus NUL');
  for (const operation of ['new-session', 'has-session', 'send-keys', 'capture-pane']) assert.ok(probe.commands.some(command => command.operation === operation && command.code === 0), operation);
  assert.ok(probe.commands.some(command => command.operation === 'capture-pane' && command.output.includes('Z409_SOCKET_OK')));
  assert.equal(output.environmentSummary.privateRunTmp, true);
  assert.equal(output.environmentSummary.tmpPathBytes, bytes(probe.TMPDIR));
  for (const name of ['flow', 'testRuns', 'projects'] as const) {
    const path = join(f.root, 'conf', { flow: 'flow.json', testRuns: 'test-runs.json', projects: 'projects.json' }[name]);
    assert.equal(output.environmentSummary.configurationFingerprints[name], createHash('sha256').update(readFileSync(path)).digest('hex'));
  }
  const entries = readFileSync(f.entryObservation, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Observation);
  const matching = entries.filter(entry => entry.TMPDIR === probe.TMPDIR);
  assert.ok(matching.some(entry => entry.pid !== probe.pid), 'actual configured runner must receive this run TMPDIR before its test descendants');
  for (const entry of matching) {
    assert.equal(entry.HOME, f.unitHome);
    assert.equal(entry.RAF_QA_HOME, f.unitHome);
    assert.equal(entry.tmpdir, probe.TMPDIR);
  }
}

function cleaned(f: Fixture, output: TestRunResult, probe: Probe, index = 0): void {
  assert.equal(existsSync(probe.TMPDIR), false, 'production cleanup removes this run temporary directory');
  assert.equal(existsSync(probe.endpoint), false);
  assert.ok(existsSync(f.context.statePath), 'cleanup preserves QA SQLite');
  assert.ok(existsSync(f.unitHome), 'cleanup preserves the stable long HOME');
  const finish = json(join(f.workspace, `finished-${index}.json`));
  assert.ok(finish.commands.some((command: any) => command.operation === 'kill-server' && command.code === 0));
  assert.notEqual(finish.afterKill, 0);
  assert.deepEqual(output.cleanup, { complete: true, remainingPids: [] });
}

async function until(f: Fixture, index: number, invocation: Invocation): Promise<void> {
  let finished = false;
  void invocation.reply.finally(() => { finished = true; }).catch(() => {});
  while (!existsSync(join(f.workspace, `probe-${index}.json`))) {
    if (finished) assert.fail(`fixture terminated before tmux observation: ${JSON.stringify(await invocation.reply)}`);
    await new Promise<void>(done => setTimeout(done, 10));
  }
}

test('Z409.S01 production implement then qa deliver compact TMPDIR with stable long HOME and ledger', async t => {
  const f = fixture(t);
  const cwd = process.cwd();
  const environment = { ...process.env };
  await f.seed();
  const before = (await f.snapshot())!;
  const outputs: TestRunResult[] = [];
  for (const phase of ['implement', 'qa'] as const) {
    const output = passed(await (await f.start(phase)).reply);
    outputs.push(output);
    const probe = f.probe();
    assert.equal(output.phase, phase);
    assert.equal(output.callerPhase, phase, 'trusted caller is the worker phase, not main');
    delivery(f, output, probe);
    cleaned(f, output, probe);
    const after = (await f.snapshot())!;
    assert.deepEqual(after.key, before.key);
    assert.deepEqual(after.selection, before.selection);
    assert.equal(after.timeoutCount, before.timeoutCount, 'changing phase and temporary directory never resets budget');
    assert.deepEqual(after.knownRed, []);
    assert.deepEqual(after.unexecuted, []);
    assert.equal(after.inFlight, null);
    assert.equal(after.lastResult?.runId, output.runId);
    assert.deepEqual(output.selection.files, [files[0]]);
  }
  assert.notEqual(outputs[0].runId, outputs[1].runId);
  assert.equal(outputs[0].command!.environment.HOME, outputs[1].command!.environment.HOME);
  assert.notEqual(outputs[0].command!.environment.TMPDIR, outputs[1].command!.environment.TMPDIR);
  assert.equal(process.cwd(), cwd);
  assert.deepEqual({ ...process.env }, environment);
});

test('Z409.S02 production accepts exact byte capacity including created suffix and NUL with multibyte root', async t => {
  const f = fixture(t);
  await f.seed();
  const warm = passed(await (await f.start('implement')).reply);
  const warmProbe = f.probe();
  const generatedSuffixBytes = bytes(warmProbe.TMPDIR) - bytes(f.config.temporaryArtifacts.root);
  const rootBytes = capacity - f.config.temporaryArtifacts.minimumNestedSocketPathBytes - 1 - generatedSuffixBytes;
  const prefix = '/tmp/ж-' + randomUUID().slice(0, 6);
  const boundaryRoot = prefix + 'a'.repeat(rootBytes - bytes(prefix));
  assert.equal(existsSync(boundaryRoot), false, 'fixture must not claim another directory');
  mkdirSync(boundaryRoot, { mode: 0o700 });
  f.roots.add(boundaryRoot);
  f.setRoot(boundaryRoot);
  const output = passed(await (await f.start('qa')).reply);
  const probe = f.probe();
  delivery(f, output, probe);
  assert.ok(bytes(probe.TMPDIR) > probe.TMPDIR.length, 'byte and JS character lengths differ');
  assert.equal(bytes(probe.TMPDIR) + f.config.temporaryArtifacts.minimumNestedSocketPathBytes + 1, capacity);
  assert.equal(output.timeoutCount, warm.timeoutCount);
  assert.equal(output.command!.environment.HOME, warm.command!.environment.HOME);
  cleaned(f, output, probe);
});

test('Z409.S03 production refuses created multibyte path one byte over capacity before runner spawn', async t => {
  const f = fixture(t);
  await f.seed();
  const warm = passed(await (await f.start('implement')).reply);
  const generatedSuffixBytes = bytes(f.probe().TMPDIR) - bytes(f.config.temporaryArtifacts.root);
  const rootBytes = capacity - f.config.temporaryArtifacts.minimumNestedSocketPathBytes - 1 - generatedSuffixBytes + 1;
  const prefix = '/tmp/ж-' + randomUUID().slice(0, 6);
  const overflowRoot = prefix + 'b'.repeat(rootBytes - bytes(prefix));
  assert.equal(existsSync(overflowRoot), false, 'fixture must not claim another directory');
  mkdirSync(overflowRoot, { mode: 0o700 });
  f.roots.add(overflowRoot);
  const sentinel = join(overflowRoot, 'foreign-sentinel');
  writeFileSync(sentinel, 'preserve');
  f.setRoot(overflowRoot);
  const before = (await f.snapshot())!;
  const entryBefore = readFileSync(f.entryObservation, 'utf8');
  const probeBefore = readFileSync(join(f.workspace, 'probe-0.json'), 'utf8');
  assert.ok(bytes(overflowRoot) + f.config.temporaryArtifacts.minimumNestedSocketPathBytes + 1 <= capacity, 'configured root alone fits; generated suffix causes rejection');
  assert.equal(bytes(overflowRoot) + generatedSuffixBytes + f.config.temporaryArtifacts.minimumNestedSocketPathBytes + 1, capacity + 1);
  const reply = await (await f.start('qa')).reply;
  const output = result(reply);
  assert.notEqual(reply.code, 0);
  assert.equal(output.outcome, 'setup-failed', JSON.stringify(output));
  assert.ok(output.diagnostics.some(diagnostic => /(?:socket|pathname|temporary|tmp)/iu.test(diagnostic.message)));
  assert.deepEqual(output.knownRed, [], 'setup failure cannot fabricate assertion-red');
  assert.equal(readFileSync(f.entryObservation, 'utf8'), entryBefore, 'no actual runner entry after invalid created path');
  assert.equal(readFileSync(join(f.workspace, 'probe-0.json'), 'utf8'), probeBefore);
  const after = (await f.snapshot())!;
  assert.deepEqual(after.key, before.key);
  assert.deepEqual(after.selection, before.selection);
  assert.equal(after.timeoutCount, before.timeoutCount);
  assert.deepEqual(after.knownRed, before.knownRed);
  assert.deepEqual(after.unexecuted, before.unexecuted);
  assert.equal(after.inFlight, null);
  assert.equal(output.timeoutCount, warm.timeoutCount);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
  assert.deepEqual(readdirSync(overflowRoot), ['foreign-sentinel'], 'failed preparation leaves no owned directory');
});

test('Z409.S04 concurrent authorized runIds keep private tmp and same-group guard while cleanup preserves peer', async t => {
  const f = fixture(t);
  await f.seed();
  await f.seed(secondGroup, 1);
  f.hold(0);
  f.hold(1);
  const a = await f.start('implement');
  await until(f, 0, a);
  const b = await f.start('qa', 1, secondGroup);
  await until(f, 1, b);
  const first = f.probe(0);
  const peer = f.probe(1);
  const activeA = (await f.snapshot())!;
  const activeB = (await f.snapshot(secondGroup))!;
  assert.ok(activeA.inFlight?.runId);
  assert.ok(activeB.inFlight?.runId);
  assert.notEqual(activeA.inFlight.runId, activeB.inFlight.runId);
  assert.equal(first.HOME, peer.HOME, 'two authorized groups use the same stable QA HOME');
  assert.notEqual(first.TMPDIR, peer.TMPDIR);
  assert.notEqual(first.endpoint, peer.endpoint);
  for (const probe of [first, peer]) {
    const stat = lstatSync(probe.TMPDIR);
    assert.equal(stat.uid, process.getuid!());
    assert.equal(stat.mode & 0o077, 0);
    assert.equal(stat.isSymbolicLink(), false);
  }
  const entryBefore = readFileSync(f.entryObservation, 'utf8');
  const duplicateReply = await (await f.start('implement')).reply;
  const duplicate = result(duplicateReply);
  assert.notEqual(duplicateReply.code, 0);
  assert.equal(duplicate.outcome, 'refused');
  assert.notEqual(duplicate.errorCode, 'CALLER_UNAUTHORIZED', 'duplicate reaches the group guard with an authorized caller');
  assert.equal(readFileSync(f.entryObservation, 'utf8'), entryBefore, 'same-group guard must prevent a second runner spawn');
  assert.equal((await f.snapshot())!.inFlight?.runId, activeA.inFlight.runId, 'same-group retry cannot replace active run');
  assert.equal((await f.snapshot())!.timeoutCount, activeA.timeoutCount);
  assert.deepEqual((await f.snapshot(secondGroup))!.inFlight, activeB.inFlight);
  f.release(0);
  const outputA = passed(await a.reply);
  delivery(f, outputA, first);
  cleaned(f, outputA, first);
  assert.ok(existsSync(peer.TMPDIR), 'cleanup A preserves B temporary directory');
  assert.ok(existsSync(peer.endpoint), 'cleanup A preserves B socket');
  execFileSync('tmux', ['-S', peer.endpoint, 'has-session', '-t', 'z409'], { encoding: 'utf8' });
  assert.equal((await f.snapshot(secondGroup))!.inFlight?.runId, activeB.inFlight.runId);
  f.release(1);
  const outputB = passed(await b.reply);
  delivery(f, outputB, peer);
  cleaned(f, outputB, peer, 1);
  assert.equal(outputA.runId, activeA.inFlight.runId);
  assert.equal(outputB.runId, activeB.inFlight.runId);
  assert.equal((await f.snapshot())!.timeoutCount, activeA.timeoutCount);
  assert.equal((await f.snapshot(secondGroup))!.timeoutCount, activeB.timeoutCount);
});
