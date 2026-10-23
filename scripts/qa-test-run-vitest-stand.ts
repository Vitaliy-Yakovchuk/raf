import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ChildResult {
  executable: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cleanup: boolean;
}

interface CaseResult {
  label: string;
  environment: 'happy-dom' | 'node';
  direct: ChildResult;
  wrapped: ChildResult;
  directBodies: string[];
  wrappedBodies: string[];
  directPassed: boolean;
  wrappedPassed: boolean;
  missingExternalRunner: boolean;
}

function argumentsOf(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  const allowed = ['source', 'ref', 'dependencies', 'output-dir', 'timeout-ms'];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/u, '');
    const value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--') || key in options) {
      throw new Error('Expected unique --source --ref --dependencies --output-dir --timeout-ms values');
    }
    options[key] = value;
  }
  if (allowed.some(key => !options[key])) throw new Error('All five options are required');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.ref)) throw new Error('--ref must be a full lowercase commit OID');
  const budget = Number(options['timeout-ms']);
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('--timeout-ms must be a positive safe integer');
  return options;
}

function json(path: string, value: unknown): void {
  const temporary = `${path}.pending`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, path);
}

function alive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function main(): Promise<void> {
  const options = argumentsOf(process.argv.slice(2));
  const output = resolve(options['output-dir']);
  const source = realpathSync(options.source);
  const dependencies = realpathSync(options.dependencies);
  mkdirSync(output, { recursive: false, mode: 0o700 });
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'raf-vite-stand-')));
  const stand = join(fixture, 'stand');
  const raf = join(stand, 'raf-develop');
  const workspace = join(stand, 'etchly-develop');
  const home = join(fixture, 'home');
  const privateTmp = join(fixture, 'tmp');
  for (const path of [stand, workspace, home, privateTmp, join(stand, 'conf')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Number(options['timeout-ms']);
  const groups = new Set<number>();
  const allChildren: ChildResult[] = [];
  let interrupted: string | null = null;
  let deadlineReached = false;
  const stop = (): void => {
    for (const pgid of groups) {
      try { process.kill(-pgid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  };
  const onTerm = (): void => { interrupted = 'SIGTERM'; stop(); };
  const onInt = (): void => { interrupted = 'SIGINT'; stop(); };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const timer = setTimeout(() => { deadlineReached = true; stop(); }, Number(options['timeout-ms']));
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    LANG: 'C.UTF-8', HOME: home, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    TEST: 'true', VITEST: 'true', NODE_ENV: 'test', RAF_TEST_RUN_WORKSPACE: workspace,
  };
  async function child(label: string, executable: string, argv: string[], cwd: string, extra: Record<string, string> = {}): Promise<ChildResult> {
    if (interrupted || deadlineReached || Date.now() >= deadline) throw new Error('Harness interrupted or deadline reached');
    const result: ChildResult = { executable, argv, cwd, exitCode: null, signal: null, stdout: `${label}.stdout`, stderr: `${label}.stderr`, timedOut: false, cleanup: false };
    const { openSync, closeSync } = await import('node:fs');
    const stdout = openSync(join(output, result.stdout), 'wx', 0o600);
    const stderr = openSync(join(output, result.stderr), 'wx', 0o600);
    let pid: number | undefined;
    try {
      await new Promise<void>((done, reject) => {
        const processChild = spawn(executable, argv, { cwd, env: { ...env, ...extra }, shell: false, detached: true, stdio: ['ignore', stdout, stderr] });
        pid = processChild.pid;
        if (pid) groups.add(pid);
        processChild.once('error', reject);
        processChild.once('exit', (code, signal) => { result.exitCode = code; result.signal = signal; done(); });
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
      if (pid) {
        try { process.kill(-pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        while (alive(pid) && Date.now() < deadline && !interrupted) {
          await new Promise(done => setTimeout(done, 10));
        }
        result.cleanup = !alive(pid);
        if (result.cleanup) groups.delete(pid);
      }
      result.timedOut = deadlineReached;
      allChildren.push(result);
      json(join(output, `${label}.command.json`), result);
    }
    return result;
  }
  async function prepare(label: string, argv: string[], cwd = stand): Promise<void> {
    const result = await child(label, 'git', ['-c', 'core.hooksPath=/dev/null', ...argv], cwd);
    if (result.exitCode !== 0 || !result.cleanup) throw new Error(`Fixture preparation failed: ${label}`);
  }
  const results: CaseResult[] = [];
  let outcome = 'setup-failed';
  let failure: string | null = null;
  let cleanup = false;
  const versions: Record<string, string> = {};
  try {
    assert(isAbsolute(source) && isAbsolute(dependencies));
    for (const [name, expected] of [['vitest', '4.1.11'], ['happy-dom', '20.14.0']]) {
      versions[name] = JSON.parse(readFileSync(join(dependencies, name, 'package.json'), 'utf8')).version;
      assert.equal(versions[name], expected, `Dependency version differs from QA 83464d4: ${name}`);
    }
    await prepare('source-status', ['status', '--porcelain=v1'], source);
    await prepare('clone', ['clone', '--local', '--no-hardlinks', '--no-checkout', source, raf]);
    await prepare('checkout', ['checkout', '--detach', options.ref], raf);
    await prepare('clone-head', ['rev-parse', 'HEAD'], raf);
    assert.equal(readFileSync(join(output, 'clone-head.stdout'), 'utf8').trim(), options.ref);
    for (const name of ['flow.json', 'test-runs.json']) copyFileSync(join(source, '..', 'conf', name), join(stand, 'conf', name));
    const fileBudget = JSON.parse(readFileSync(join(stand, 'conf/flow.json'), 'utf8')).unitTests.timeoutMs;
    const diagnosticLimits = JSON.parse(readFileSync(join(stand, 'conf/test-runs.json'), 'utf8')).diagnostics;
    assert(diagnosticLimits && typeof diagnosticLimits === 'object', 'Missing configured diagnostic limits');
    assert(Number.isSafeInteger(fileBudget) && fileBudget > 0, 'Missing configured adapter file budget');
    const runner = join(raf, 'src/test-run-vitest-runner.ts');
    const reporter = join(raf, 'src/test-run-vitest-reporter.ts');
    const bridge = join(raf, 'scripts/test-run-vitest-api.ts');
    const wrapper = join(raf, 'scripts/test-run-vitest.ts');
    for (const path of [runner, reporter, bridge, wrapper]) assert(existsSync(path), `Missing trusted adapter artifact: ${path}`);
    assert(!runner.startsWith(`${workspace}/`));
    assert.equal(dirname(raf), dirname(workspace));
    symlinkSync(dependencies, join(workspace, 'node_modules'), 'dir');
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'raf-vitest-stand-fixture', private: true, type: 'module', workspaces: ['app', 'worker', 'shared/ui-core'] }));
    mkdirSync(join(workspace, 'scripts'));
    writeFileSync(join(workspace, 'scripts/shared-library-runtime.mjs'), 'process.env.RAF_SYNTHETIC_PRELOAD = "active";\n');
    function configure(cwd: string, projects: { name: string; environment: string; include: string[] }[]): void {
      const root = join(workspace, cwd);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: `fixture-${cwd.replaceAll('/', '-')}`, private: true, type: 'module' }));
      const test = projects.length === 1 && !projects[0].name
        ? { ...projects[0], pool: 'forks', maxWorkers: 1, fileParallelism: false }
        : { projects: projects.map(project => ({ test: { ...project, pool: 'forks', maxWorkers: 1, fileParallelism: false } })) };
      writeFileSync(join(root, 'vitest.config.ts'), `import { defineConfig } from 'vitest/config';\nexport default defineConfig(${JSON.stringify({ test })});\n`);
    }
    configure('app', [{ name: 'app', environment: 'happy-dom', include: ['admin/sections/product-defaults.test.ts'] }]);
    configure('worker', [
      { name: 'worker-consent-dom', environment: 'happy-dom', include: ['src/cookie-consent-ui.test.ts'] },
      { name: 'worker-unit', environment: 'node', include: ['scripts/node-control.test.ts'] },
    ]);
    configure('shared/ui-core', [{ name: '', environment: 'happy-dom', include: ['src/dom.test.ts'] }]);
    const domChecks = [
      ['document', "expect(document.nodeType).toBe(9)"],
      ['create-element', "expect(document.createElement('button').tagName).toBe('BUTTON')"],
      ['query', "document.body.innerHTML = '<div data-qa=stand></div>'; expect(document.querySelector('[data-qa=stand]')).not.toBeNull()"],
      ['events', "const button = document.createElement('button'); let clicked = false; button.addEventListener('click', () => { clicked = true; }); button.click(); expect(clicked).toBe(true)"],
      ['parser', "expect(new DOMParser().parseFromString('<p>stand</p>', 'text/html').querySelector('p')?.textContent).toBe('stand')"],
      ['preload', "expect(process.env.RAF_SYNTHETIC_PRELOAD).toBe('active'); expect(typeof window).toBe('object')"],
    ];
    function testFile(file: string, checks: string[][]): void {
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      const body = checks.map(([name, code]) => `test(${JSON.stringify(name)}, () => { ${code}; appendFileSync(process.env.RAF_STAND_TRACE, ${JSON.stringify(`${name}\n`)}); });`).join('\n');
      writeFileSync(join(workspace, file), `import { test, expect } from 'vitest';\nimport { appendFileSync } from 'node:fs';\n${body}\n`);
    }
    for (const file of ['app/admin/sections/product-defaults.test.ts', 'worker/src/cookie-consent-ui.test.ts', 'shared/ui-core/src/dom.test.ts']) testFile(file, domChecks);
    testFile('worker/scripts/node-control.test.ts', [['node-control', "expect(typeof document).toBe('undefined'); expect(process.env.RAF_SYNTHETIC_PRELOAD).toBe('active')"]]);
    const cases = [
      { label: 'app', cwd: 'app', project: 'app', files: ['admin/sections/product-defaults.test.ts'], environment: 'happy-dom' },
      { label: 'product-defaults-preset', cwd: 'app', project: 'app', files: ['admin/sections/product-defaults.test.ts'], environment: 'happy-dom' },
      { label: 'worker-consent-dom', cwd: 'worker', project: 'worker-consent-dom', files: ['src/cookie-consent-ui.test.ts'], environment: 'happy-dom' },
      { label: 'ui-core', cwd: 'shared/ui-core', project: '', files: ['src/dom.test.ts'], environment: 'happy-dom' },
      { label: 'duplicate-file', cwd: 'app', project: 'app', files: ['admin/sections/product-defaults.test.ts', 'admin/sections/product-defaults.test.ts'], environment: 'happy-dom' },
      { label: 'node-control', cwd: 'worker', project: 'worker-unit', files: ['scripts/node-control.test.ts'], environment: 'node' },
    ] as const;
    function bodies(path: string): string[] {
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).sort() : [];
    }
    for (const selected of cases) {
      const cwd = join(workspace, selected.cwd);
      const relative = selected.cwd.startsWith('shared/') ? '../../' : '../';
      const preload = `${relative}scripts/shared-library-runtime.mjs`;
      const directTrace = join(output, `${selected.label}.direct.bodies`);
      const wrappedTrace = join(output, `${selected.label}.wrapped.bodies`);
      const cli = ['run', ...selected.files, '--configLoader', 'runner', ...(selected.project ? ['--project', selected.project] : []), '--testTimeout', String(fileBudget), '--hookTimeout', String(fileBudget)];
      const baselineReport = join(output, `${selected.label}.direct.vitest.json`);
      const direct = await child(`${selected.label}.direct`, process.execPath,
        ['--import', preload, `${relative}node_modules/vitest/vitest.mjs`, ...cli, '--reporter', 'json', '--outputFile', baselineReport], cwd, { RAF_STAND_TRACE: directTrace });
      const report = existsSync(baselineReport) ? JSON.parse(readFileSync(baselineReport, 'utf8')) : null;
      const expectedNames = selected.environment === 'node' ? ['node-control'] : domChecks.map(([name]) => name).sort();
      const directBodies = bodies(directTrace);
      const directPassed = direct.exitCode === 0 && direct.cleanup && report?.success === true
        && report.numPassedTests === expectedNames.length && JSON.stringify(directBodies) === JSON.stringify(expectedNames);
      const batches = [{
        executable: process.execPath, argv: ['--import', preload, `${relative}node_modules/vitest/vitest.mjs`, ...cli, '--reporter', reporter],
        cwd, shell: false, environment: { HOME: home, statePath: join(home, '.raf/state.sqlite'), tmpPath: join(home, '.raf/tmp'), TMPDIR: privateTmp },
      }];
      const wrapped = await child(`${selected.label}.wrapped`, process.execPath, [wrapper], cwd, {
        RAF_STAND_TRACE: wrappedTrace, RAF_TEST_RUN_DIAGNOSTICS: JSON.stringify(diagnosticLimits),
        RAF_TEST_RUN_IDS: '[]', RAF_TEST_RUN_VITEST_BATCHES: JSON.stringify(batches),
      });
      const wrappedBodies = bodies(wrappedTrace);
      const wrappedText = readFileSync(join(output, wrapped.stdout), 'utf8') + readFileSync(join(output, wrapped.stderr), 'utf8');
      const wrappedPassed = wrapped.exitCode === 0 && wrapped.cleanup && JSON.stringify(wrappedBodies) === JSON.stringify(expectedNames);
      const missingExternalRunner = /ERR_MODULE_NOT_FOUND/u.test(wrappedText)
        && /Cannot find module[^\n]*test-run-vitest-runner\.ts/u.test(wrappedText);
      results.push({ label: selected.label, environment: selected.environment, direct, wrapped, directBodies, wrappedBodies, directPassed, wrappedPassed, missingExternalRunner });
      if (interrupted || deadlineReached) break;
    }
    if (results.some(result => !result.directPassed)) {
      failure = 'Direct Vitest baseline failed; this is fixture setup failure, not confirmed red';
    } else if (results.some(result => result.environment === 'node' && !result.wrappedPassed)) {
      failure = 'Node control failed; inspect adapter setup before confirming the DOM regression';
    } else if (results.every(result => result.wrappedPassed)) {
      outcome = 'passed';
    } else if (results.some(result => result.environment === 'happy-dom' && !result.wrappedPassed && result.missingExternalRunner)) {
      outcome = 'assertions-failed';
      failure = 'Direct Vitest passed, but the real raf wrapper cannot import its external trusted runner in happy-dom';
    } else {
      failure = 'Wrapped execution failed without the targeted external runner signature; inspect setup before claiming red';
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    stop();
    for (const pgid of groups) {
      while (alive(pgid) && Date.now() < deadline && !interrupted) await new Promise(done => setTimeout(done, 10));
      if (!alive(pgid)) groups.delete(pgid);
    }
    clearTimeout(timer);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    cleanup = groups.size === 0;
    if (cleanup) rmSync(fixture, { recursive: true, force: true });
    if (interrupted) outcome = 'interrupted';
    else if (deadlineReached) outcome = 'timed-out';
    else if (!cleanup) { outcome = 'setup-failed'; failure = 'Incomplete process group cleanup'; }
    const summary = {
      sourceItem: 'add-raf-test-run:5.4.4.4', kind: 'non-unit', source, sha: options.ref, versions,
      command: { executable: process.execPath, argv: [fileURLToPath(import.meta.url), ...process.argv.slice(2)] },
      deadlineMs: Number(options['timeout-ms']), outcome, failure, timedOut: deadlineReached, interrupted,
      cleanup: { complete: cleanup, remainingProcessGroups: [...groups], fixtureRemoved: !existsSync(fixture) },
      fixtureLayout: { stand, raf, workspace },
      cases: results,
      preparation: allChildren.filter(result => !result.stdout.includes('.direct.') && !result.stdout.includes('.wrapped.')),
    };
    json(join(output, 'result.json'), summary);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = outcome === 'passed' && cleanup ? 0 : outcome === 'assertions-failed' ? 1 : 2;
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
