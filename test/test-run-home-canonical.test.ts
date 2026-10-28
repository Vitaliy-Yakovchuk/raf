import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareUnitTestState } from '../src/test-run-unit-state.ts';
import { productionStateContext } from '../src/state-migration-guard.ts';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));

async function probe(t: test.TestContext, owner?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raf-home-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(source, '../conf'), join(root, 'conf'), { recursive: true });
  const home = join(root, 'control');
  mkdirSync(home, { mode: 0o700 });
  const runtimeUrl = new URL(`../src/test-run-runtime.ts?home=${encodeURIComponent(root)}`, import.meta.url).href;
  const sandbox = `export async function runSandboxTestCommand(request, ports) {
    try {
      await ports.unitContext({ project: 'raf', workspace: ${JSON.stringify(source)}, group: 'mac-home/canonical' }, { agentId: 'home-test', phase: 'hotfix' });
      throw new Error('Expected the state preparation boundary');
    } catch (error) {
      if (error.code === 'HOME_OBSERVED') return { code: 0, stdout: JSON.stringify(error.observed), stderr: '' };
      return { code: 1, stdout: '', stderr: error.message };
    }
  }`;
  const doubles: Record<string, string> = {
    './production-runtime.ts': `export const sandboxTestControlSnapshot = async () => ({ ancestors: [{ pid: ${process.pid} }], activeChanges: [] });`,
    './state-store.ts': 'export const openStateStore = () => ({ close() {} });',
    './test-run-unit-state.ts': `export async function prepareUnitTestState(state) { throw Object.assign(new Error('Observed isolated state'), { code: 'HOME_OBSERVED', observed: { home: state.homeDirectory, state: state.statePath, tmp: state.tmpRoot } }); }`,
    './sandbox-test-run.ts': sandbox,
  };
  if (owner) doubles['node:path'] = `export * from 'node:path'; import { join as actualJoin } from 'node:path'; export const join = (...parts) => parts.length === 2 && (parts[0] === '/tmp' || parts[0] === ${JSON.stringify(realpathSync('/tmp'))}) && parts[1] === ${JSON.stringify(`raf-unit-${process.getuid?.() ?? 'user'}`)} ? ${JSON.stringify(owner)} : actualJoin(...parts);`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === runtimeUrl && doubles[specifier]) return { url: `home-test:${encodeURIComponent(root)}:${specifier}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      const prefix = `home-test:${encodeURIComponent(root)}:`;
      if (url.startsWith(prefix)) return { format: 'module', source: doubles[url.slice(prefix.length)], shortCircuit: true };
      return next(url, context);
    },
  });
  const previousHome = process.env.HOME, previousQa = process.env.RAF_QA_HOME;
  process.env.HOME = home;
  process.env.RAF_QA_HOME = home;
  try {
    const runtime = await import(runtimeUrl);
    return await runtime.runConfiguredTestRun(['--project', 'raf', '--phase', 'hotfix', '--group', 'mac-home/canonical'],
      { orchestratorRoot: root, homeDirectory: home, commandTimingOwner: 'production' });
  } finally {
    hooks.deregister();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousQa === undefined) delete process.env.RAF_QA_HOME; else process.env.RAF_QA_HOME = previousQa;
  }
}

test('unit HOME accepts the system temporary-directory alias and uses canonical isolated paths', async t => {
  const owner = join('/tmp', `raf-unit-${process.getuid?.() ?? 'user'}`);
  const result = await probe(t);
  assert.equal(result.exitCode, 0, result.stderr + result.stdout);
  const observed = JSON.parse(result.stdout);
  t.after(() => rmSync(observed.home, { recursive: true, force: true }));
  assert.equal(observed.home, realpathSync(observed.home));
  assert.equal(join(observed.home, '..'), realpathSync(owner));
  assert.ok(observed.state.startsWith(observed.home + '/'));
  assert.ok(observed.tmp.startsWith(observed.home + '/'));
  assert.equal(lstatSync(observed.home).mode & 0o077, 0);
  if (process.platform === 'darwin') assert.notEqual(owner, realpathSync(owner), 'exercise the actual macOS /tmp alias');
});

for (const kind of ['canonical', 'public', 'symlink', 'file'] as const) {
  test(`unit HOME root preserves ${kind} directory policy`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'raf-home-policy-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const owner = join(root, 'owner');
    if (kind === 'file') writeFileSync(owner, 'not a directory');
    else if (kind === 'symlink') { mkdirSync(join(root, 'target'), { mode: 0o700 }); symlinkSync(join(root, 'target'), owner); }
    else mkdirSync(owner, { mode: kind === 'public' ? 0o755 : 0o700 });
    const result = await probe(t, owner);
    assert.equal(result.exitCode, kind === 'canonical' ? 0 : 1, result.stderr + result.stdout);
    if (kind !== 'canonical') assert.equal(JSON.parse(result.stdout).outcome, 'refused');
  });
}

test('unit state preparation accepts the same canonical private HOME as the wrapper', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'raf-home-state-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(source, '../conf'), join(root, 'conf'), { recursive: true });
  const key = { project: 'raf', workspace: source, group: 'mac-home/canonical' };
  const owner = join(realpathSync('/tmp'), `raf-unit-${process.getuid?.() ?? 'user'}`);
  const home = join(owner, createHash('sha256').update(JSON.stringify([root, key.project, key.workspace])).digest('hex'));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = productionStateContext(root, join(source, 'src/test-run-runtime.ts'), home, 'cli', { HOME: home, RAF_QA_HOME: home });
  await assert.doesNotReject(() => prepareUnitTestState(state, key));
});
