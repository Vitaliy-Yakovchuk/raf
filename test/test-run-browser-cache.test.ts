import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { TmuxAgentAdapter } from '../src/agent-adapters.ts';
import type { AdapterCommand, AgentRunner, RunnerProtocol } from '../src/agent-adapters.ts';
import { verifyEtchlyDependencies } from '../src/test-run-runtime.ts';
import { prepareEtchlyEnvironment } from '../src/test-run-etchly.ts';
import type { TestRunContext, TestRunProfile } from '../src/test-runs.ts';

const runners: AgentRunner[] = ['codex', 'claude', 'grok', 'agy'];

function setEnvironment(t: TestContext, name: string, value: string | undefined): void {
  const previous = process.env[name];
  const set = (next: string | undefined) => { if (next === undefined) delete process.env[name]; else process.env[name] = next; };
  set(value);
  t.after(() => set(previous));
}

async function launch(runner: AgentRunner) {
  const commands: AdapterCommand[] = [];
  const protocol: RunnerProtocol = {
    invocation: () => ({ executable: runner, args: ['--fixture'] }),
    observe: () => ({ status: 'starting' }),
  };
  const adapter = new TmuxAgentAdapter({
    execute: async command => { commands.push(command); return { exitCode: 0, stdout: '', stderr: '' }; },
    protocols: Object.fromEntries(runners.map(id => [id, protocol])) as Record<AgentRunner, RunnerProtocol>,
  });
  await adapter.startWithoutInput({ selection: { runner, model: 'fixture', effort: 'high' }, tmuxSession: 'browser-cache-fixture', cwd: '/qa/workspace', reportWrapper: { wrap: value => value } });
  const start = commands.find(command => command.executable === 'tmux' && command.args[0] === 'new-session');
  assert.ok(start);
  return start;
}

function sessionCache(command: AdapterCommand): string | undefined {
  return command.args.find((value, index, args) => args[index - 1] === '-e' && value.startsWith('PLAYWRIGHT_BROWSERS_PATH='));
}

for (const runner of runners) {
  test(`browser cache: ${runner} launch supplies host default with no tmux server environment`, async t => {
    setEnvironment(t, 'PLAYWRIGHT_BROWSERS_PATH', undefined);
    setEnvironment(t, 'XDG_CACHE_HOME', undefined);
    setEnvironment(t, 'HOME', '/qa/isolated-home');
    const hostHome = userInfo().homedir;
    const expected = process.platform === 'darwin' ? join(hostHome, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(hostHome, 'AppData', 'Local'), 'ms-playwright')
        : join(hostHome, '.cache', 'ms-playwright');
    assert.equal(sessionCache(await launch(runner)), `PLAYWRIGHT_BROWSERS_PATH=${expected}`);
    assert.equal(sessionCache(await launch(runner)), `PLAYWRIGHT_BROWSERS_PATH=${expected}`, 'a fresh launch must supply the path again after a server restart');
  });

  test(`browser cache: ${runner} launch carries the explicit trusted host path as one tmux argument`, async t => {
    const cache = '/host/browser cache/$literal;value';
    setEnvironment(t, 'PLAYWRIGHT_BROWSERS_PATH', cache);
    setEnvironment(t, 'XDG_CACHE_HOME', '/host/other-cache');
    assert.equal(sessionCache(await launch(runner)), `PLAYWRIGHT_BROWSERS_PATH=${cache}`);
  });
}

test('browser cache: Linux launch respects the host XDG cache directory despite isolated HOME', { skip: process.platform !== 'linux' }, async t => {
  setEnvironment(t, 'PLAYWRIGHT_BROWSERS_PATH', undefined);
  setEnvironment(t, 'HOME', '/qa/isolated-home');
  setEnvironment(t, 'XDG_CACHE_HOME', '/host/xdg-cache');
  assert.equal(sessionCache(await launch('codex')), 'PLAYWRIGHT_BROWSERS_PATH=/host/xdg-cache/ms-playwright');
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-browser-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'etchly-develop');
  const library = join(root, 'shared-libs-develop');
  const cache = join(root, 'host-cache');
  const write = (file: string, value = '', mode = 0o600) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, { mode });
  };
  write(join(root, 'conf/projects.json'), JSON.stringify({ projects: {
    etchly: { branchPaths: { develop: 'etchly-develop' } },
    'shared-libs': { branchPaths: { develop: 'shared-libs-develop' } },
  } }));
  mkdirSync(library);
  execFileSync('git', ['init', '-q', '-b', 'develop', library]);
  mkdirSync(workspace);
  symlinkSync(library, join(workspace, 'shared-libs'));
  for (const name of ['shared-library-runtime.mjs', 'shared-library-aliases.ts', 'shared-libs-path.mjs']) write(join(workspace, 'scripts', name));
  const file = 'worker/scripts/browser.test.ts';
  write(join(workspace, file), "import { chromium } from 'playwright'; chromium.launch();\n");
  const profile: TestRunProfile = {
    cwd: '.', executable: process.execPath, argv: [], unitFiles: [file], exactIds: 'node-test-name', resultAdapter: 'node-test-events',
    environment: { isolatedHome: true, stateOrigin: true }, checks: [],
  };
  const home = join(root, 'qa-home');
  const context: TestRunContext = { cwd: workspace, workspace, projectWorkspaces: { etchly: [workspace] }, agentPhases: ['hotfix'], activeChanges: ['add-raf-test-run'],
    agentId: 'fixture', sha: 'fixture', home, statePath: join(home, '.raf/state.sqlite'), tmpPath: join(home, '.raf/tmp'), operationalHome: join(root, 'host-home') };
  return { cache, write, check: (path: string | undefined = cache) => verifyEtchlyDependencies(context, [profile], [file], path === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: path }) };
}

for (const executable of [
  'chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell',
  'chromium_headless_shell-1200/chrome-linux/headless_shell',
  'chromium-1248/chrome-linux64/chrome',
]) test(`browser cache: preflight accepts executable ${executable}`, t => {
  const f = fixture(t);
  f.write(join(f.cache, executable), '', 0o700);
  assert.doesNotThrow(() => f.check());
});

for (const invalid of ['absent', 'disabled', 'relative', 'missing-directory', 'non-executable', 'directory', 'wrong-engine']) {
  test(`browser cache: preflight refuses ${invalid} cache as setup`, t => {
    const f = fixture(t);
    let cache = f.cache;
    const binary = join(cache, 'chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell');
    if (invalid === 'absent') cache = '';
    if (invalid === 'disabled') cache = '0';
    if (invalid === 'relative') cache = 'relative/cache';
    if (invalid === 'non-executable') { f.write(binary); chmodSync(binary, 0o600); }
    if (invalid === 'directory') mkdirSync(binary, { recursive: true });
    if (invalid === 'wrong-engine') f.write(join(cache, 'firefox-1248/firefox/firefox'), '', 0o700);
    assert.throws(() => f.check(cache), error => (error as any).code === 'ENVIRONMENT_INVALID' && /browser cache/.test((error as Error).message));
  });
}

test('browser cache: a requested executor override cannot replace the trusted host cache', () => {
  assert.throws(() => prepareEtchlyEnvironment({
    workspace: '/workspace', branch: 'develop', expectedLibrary: '/library', actualLibrary: '/library', libraryBranch: 'develop',
    nodeAvailable: true, vitestAvailable: true, adapterCompatible: true, preloadAvailable: true, aliasesAvailable: true, configAvailable: true,
    happyDomRequired: false, happyDomAvailable: true, isolatedHome: true, stateOrigin: true, privateTmpWritable: true,
    browserRequired: true, browserAvailable: true, trustedBrowserCache: '/host/cache', requestedBrowserCache: '/executor/cache',
  }, { home: '/qa/home', tmp: '/qa/tmp' }), error => (error as any).code === 'ENVIRONMENT_INVALID' && /untrusted PLAYWRIGHT_BROWSERS_PATH/.test((error as Error).message));
});
