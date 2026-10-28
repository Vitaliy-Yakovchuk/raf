import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWaitIdentity } from '../src/resource-wait-identity.ts';
import { readMachineBootIdentity } from '../src/os-runtime.ts';
import { testWrapperIdentity, observeReservedTestTree } from '../src/test-run-resource-process.ts';
import { createTestRunPorts } from '../src/test-run-runtime.ts';
import { resolveStateContext } from '../src/state-migration-guard.ts';
import type { TestRunConfig, TestRunContext } from '../src/test-runs.ts';

const supported = ['darwin', 'linux'].includes(process.platform);
const source = fileURLToPath(new URL('../', import.meta.url));

test('native test wrapper uses the OS process start and boot identity', { skip: !supported }, async () => {
  const expected = await readWaitIdentity();
  let identity: string | undefined;
  assert.doesNotThrow(() => { identity = testWrapperIdentity(); }, 'wrapper identity must be available on the host OS');
  assert.deepEqual(JSON.parse(identity!), { pid: process.pid, start: expected.startedAt, boot: expected.bootId });
});

test('native reservation observation preserves start/boot fencing and measures the live process', { skip: !supported }, async () => {
  const current = await readWaitIdentity();
  const root = { pid: process.pid, start: current.startedAt, boot: current.bootId };
  const identity = JSON.stringify(root);
  const observed = observeReservedTestTree(identity);
  assert.equal(observed.state, 'alive', 'a matching live native process cannot be unknown');
  assert.ok(observed.consumed && observed.consumed.ramBytes > 0);
  assert.equal(observeReservedTestTree(JSON.stringify({ ...root, start: root.start + '-reused' })).state, 'unknown');
  assert.equal(observeReservedTestTree(JSON.stringify({ ...root, boot: 'previous-boot' })).state, 'dead');
  assert.equal(observeReservedTestTree('invalid-json').state, 'unknown');
  assert.equal(observeReservedTestTree(null).state, 'unknown');
});

test('Darwin reservation identity survives a different observer timezone', { skip: process.platform !== 'darwin' }, () => {
  const identity = testWrapperIdentity();
  const script = `import {observeReservedTestTree} from ${JSON.stringify(new URL('../src/test-run-resource-process.ts', import.meta.url).href)};
    console.log(JSON.stringify(observeReservedTestTree(${JSON.stringify(identity)})));`;
  for (const TZ of ['UTC', 'Europe/Kyiv']) {
    const result = childProcess.execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ } });
    assert.equal(JSON.parse(result).state, 'alive', TZ + ': a timezone change cannot release a live reservation');
  }
});

test('Darwin scan failure preserves an unknown reservation instead of releasing it', { skip: process.platform !== 'darwin' }, t => {
  const identity = testWrapperIdentity();
  const execute = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof childProcess.execFileSync>) => {
    if (args[0] === 'ps') throw new Error('OS scan unavailable');
    return execute(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(observeReservedTestTree(identity).state, 'unknown');
});

test('native runtime admits, identifies, reconciles and cleans its detached child tree', { skip: !supported, timeout: 30000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raf-native-process-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(source, '../conf'), join(root, 'conf'), { recursive: true });
  const home = join(root, 'qa');
  mkdirSync(home, { mode: 0o700 });
  const environment = { ...process.env, HOME: home, RAF_QA_HOME: home };
  const state = resolveStateContext({ orchestratorRoot: root, modulePath: join(source, 'src/test-run-runtime.ts'), homeDirectory: home,
    operatingSystemHome: join(root, 'operational'), environment, entryPoint: 'cli' });
  const config: TestRunConfig = JSON.parse(readFileSync(join(root, 'conf/test-runs.json'), 'utf8'));
  config.projects = { raf: { profiles: { native: { cwd: '.', executable: process.execPath, argv: [], unitFiles: ['test/test-run-darwin-process.test.ts'],
    exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [] } }, groups: {} } };
  const ports = createTestRunPorts(config, state, () => { throw new Error('No state writes in native process test'); }, environment);
  const context: TestRunContext = { cwd: source, workspace: source, projectWorkspaces: { raf: [source] }, agentPhases: ['hotfix'], activeChanges: [],
    agentId: 'native-process-test', sha: 'fixture', home, statePath: state.statePath, tmpPath: state.tmpRoot, operationalHome: join(root, 'operational') };
  assert.equal((await ports.preflight(context)).treeControlSupported, true, 'native process tree control is supported');
  const children: ReturnType<typeof childProcess.spawn>[] = [];
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    const child = originalSpawn(...args);
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const marker = join(root, 'descendant.json');
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid})));
    setInterval(()=>{},1000);`;
  const child = await ports.spawn({ executable: process.execPath, argv: ['-e', script], cwd: source, shell: false,
    environment: { HOME: home, statePath: state.statePath, tmpPath: state.tmpRoot } }, () => {});
  const identity = JSON.parse(child.identity);
  assert.equal(identity.start, (await readWaitIdentity(identity.pid)).startedAt);
  while (!existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 10));
  const descendant = JSON.parse(readFileSync(marker, 'utf8')).pid;
  assert.equal(observeReservedTestTree(child.identity).state, 'alive');
  const before = await ports.reconcile(child.identity, Date.now() + 60000);
  assert.equal(before.alive, true);
  assert.ok(before.cleanup.remainingPids.includes(descendant), 'descendant is tracked by the OS tree scan');
  const legacy = JSON.stringify({ ...identity, boot: (await readMachineBootIdentity()).bootId });
  assert.equal(observeReservedTestTree(legacy).state, 'alive', 'existing raw boot records retain verified ownership');
  assert.equal((await ports.reconcile(legacy, Date.now() + 60000)).alive, true);
  const reused = await ports.reconcile(JSON.stringify({ ...identity, start: identity.start + '-reused' }), 0);
  assert.equal(reused.cleanup.complete, false);
  assert.equal(reused.deadlineReached, false);
  assert.equal((await readWaitIdentity(descendant)).pid, descendant, 'PID mismatch cannot signal the owned tree');
  assert.deepEqual(await child.cleanup(Date.now(), 'interruption'), { complete: true, remainingPids: [] });
  await child.wait();
  assert.equal(observeReservedTestTree(child.identity).state, 'dead');
  assert.equal((await ports.reconcile(child.identity, Date.now())).alive, false);
});
