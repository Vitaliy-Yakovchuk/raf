import { prepareProductionQaFixture, copyProductionQaDependencies } from './production-qa-fixture.ts';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { cp } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import type { ExecutionResult } from '../src/cli.ts';
import { runServiceEntry } from '../src/service-entry.ts';

const constants = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(await readFile(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')), JSON.parse(await readFile(new URL('../../conf/projects.json', import.meta.url), 'utf8')));

async function fixture(t: TestContext, mode: 'valid' | 'absent' | 'broken' = 'valid') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-entry-')));
  const main = join(root, 'configured-working-main');
  const develop = join(root, 'raf-develop');
  const homeDirectory = join(root, 'home');
  await Promise.all([mkdir(join(root, 'conf'), { recursive: true }), mkdir(join(main, 'bin'), { recursive: true }), mkdir(join(develop, 'bin'), { recursive: true }), mkdir(homeDirectory)]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  execFileSync('git', ['init', '-q', '-b', 'develop', develop]);
  const projects = JSON.parse(await readFile(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
  projects.projects.raf.path = 'configured-working-main';
  projects.projects.raf.branchPaths.main = 'configured-working-main';
  await writeFile(join(root, 'conf', 'projects.json'), JSON.stringify(projects));
  const origin = { configuredMain: main, nonce: 'qa-service-entry-origin-v1' };
  const loaderProofAudit: { root: string; originalDigest: string; instrumentedDigest: string; instrumentation: string }[] = [];
  const runProductionCli = await prepareProductionQaFixture(t, { root, home: homeDirectory }, async () => {
    await cp(join(develop, 'src'), join(main, 'src'), { recursive: true });
    copyProductionQaDependencies(main);
    await writeFile(join(main, 'package.json'), '{"type":"module"}');
    await cp(join(develop, 'bin/raf.ts'), join(main, 'bin/raf.ts'));
    await cp(join(develop, 'scripts'), join(main, 'scripts'), { recursive: true });
    await writeFile(join(main, 'service-fixture-origin.json'), JSON.stringify(origin));
    const serviceModule = join(main, 'src', 'service-entry.ts');
    const original = await readFile(serviceModule, 'utf8');
    const instrumentation = `\nexport const serviceEntryFixtureOrigin = { moduleUrl: import.meta.url, nonce: ${JSON.stringify(origin.nonce)} };\n`;
    await writeFile(serviceModule, original + instrumentation);
    const originalDigest = createHash('sha256').update(original).digest('hex');
    const instrumentedDigest = createHash('sha256').update(original + instrumentation).digest('hex');
    for (const codeRoot of [main, develop]) {
      const copiedProofs = join(codeRoot, 'src/hotfix-runtime-loaders.ts');
      const proofs = await readFile(copiedProofs, 'utf8');
      const rewritten = proofs.replace(/("src\/service-entry\.ts"\s*:\s*\{[^}]*"sha256"\s*:\s*")[a-f0-9]{64}(")/, (_match, prefix, suffix) => prefix + instrumentedDigest + suffix);
      assert.notEqual(rewritten, proofs, 'The independently reviewed fixture export needs a new loader proof before the publisher loads');
      await writeFile(copiedProofs, rewritten);
      loaderProofAudit.push({ root: codeRoot, originalDigest, instrumentedDigest, instrumentation });
    }
  });
  const gitDirectory = execFileSync('git', ['-C', develop, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const { createServiceHandlers }: typeof import('../src/service-entry.ts') = await import(pathToFileURL(join(develop, 'src', 'service-entry.ts')).href);
  const { execute }: typeof import('../src/cli.ts') = await import(pathToFileURL(join(develop, 'src', 'cli.ts')).href);
  const log = join(root, 'service-events.jsonl');
  await writeFile(log, loaderProofAudit.map(proof => JSON.stringify({ event: 'fixture-loader-proof', ...proof })).join('\n') + '\n');
  t.diagnostic(JSON.stringify({ fixtureLoaderProofs: loaderProofAudit }));
  const modulePath = join(root, 'fixture-ports.ts');
  await writeFile(modulePath, `
import { appendFile } from 'node:fs/promises';
const log = async event => appendFile(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
export async function createServicePorts(context) {
  return {
    recover: async () => {
      if (${JSON.stringify(mode)} === 'broken') throw new Error('fixture recovery unavailable');
      await log({ event: 'recover', cwd: process.cwd(), context });
    },
    handle: async request => {
      if (request.operation !== 'fixture.echo') throw new Error('Unsupported service operation: ' + request.operation);
      await log({ event: 'request', operation: request.operation });
      return request.payload;
    },
    shutdown: async () => { await log({ event: 'shutdown' }); },
  };
}
`);
  await writeFile(join(main, 'bin', 'service.ts'), `
import { appendFile } from 'node:fs/promises';
import { runServiceEntry, serviceEntryFixtureOrigin } from '../src/service-entry.ts';
await appendFile(${JSON.stringify(log)}, JSON.stringify({
  event: 'entry', entryUrl: import.meta.url, module: serviceEntryFixtureOrigin,
  cwd: process.cwd(), mainPath: process.env.RAF_MAIN_PATH, argv: process.argv, pid: process.pid,
}) + '\\n');
const host = await runServiceEntry();
await host.closed;
`);
  await writeFile(join(develop, 'bin', 'service.ts'), 'throw new Error("forbidden develop worker");\n');
  execFileSync('git', ['-C', main, 'add', '--', 'bin', 'src', 'scripts', 'service-fixture-origin.json', 'package.json']);
  execFileSync('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'Initialize configured main fixture']);
  const mainCommit = execFileSync('git', ['-C', main, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const committedFile = (path: string): string => execFileSync('git', ['-C', main, 'show', `${mainCommit}:${path}`], { encoding: 'utf8' });
  const children: ChildProcess[] = [];
  const launches: { command: string; args: readonly string[]; cwd: string; mainPath: string | undefined }[] = [];
  const options = {
    orchestratorRoot: root,
    homeDirectory,
    service: { entryRelativePath: 'bin/service.ts', readinessTimeoutMs: 2000 },
    hostModulePath: mode === 'absent' ? undefined : modulePath,
  };
  const settings = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  settings.service = options.service;
  await Promise.all([
    writeFile(join(root, 'conf', 'raf.json'), JSON.stringify(settings)),
    writeFile(join(root, 'conf', 'raf-constants.json'), JSON.stringify(constants)),
    writeFile(join(root, 'conf', 'models.json'), JSON.stringify(models)),
  ]);
  const artifactPath = join(root, 'catalog.json');
  await writeFile(artifactPath, JSON.stringify(catalog));
  const dependencies = {
    nodeExecutable: process.execPath,
    spawn: ((command, args, settings) => {
      launches.push({ command, args: [...args], cwd: settings.cwd, mainPath: settings.env?.RAF_MAIN_PATH });
      const child = spawn(command, args, settings);
      children.push(child);
      return child;
    }) as typeof spawn,
  };
  let handlers: ReturnType<typeof createServiceHandlers> | undefined;
  t.after(async () => {
    try { await handlers?.handlers['service stop']({}); } catch {}
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  handlers = createServiceHandlers(options, dependencies);
  return {
    createServiceHandlers, runProductionCli, root, main, develop, gitDirectory, origin, mainCommit, committedFile, homeDirectory, options, dependencies, children, launches, handlers, artifactPath,
    cli: (argv: string[]) => execute(argv, catalog, handlers!.handlers),
    events: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
}

async function pinnedMain(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const generations = join(f.gitDirectory, 'raf-hotfix', 'generations');
  const candidates: string[] = [];
  for (const directory of await readdir(generations, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const root = join(generations, directory.name, 'raf-main');
    let marker: string;
    try { marker = await readFile(join(root, 'service-fixture-origin.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (marker === f.committedFile('service-fixture-origin.json')) candidates.push(root);
  }
  assert.equal(candidates.length, 1, 'exactly one snapshot must contain the configured main commit marker');
  const root = await realpath(candidates[0]);
  assert.notEqual(root, await realpath(f.main));
  assert.notEqual(root, await realpath(f.develop));
  for (const path of ['service-fixture-origin.json', 'bin/service.ts', 'src/service-entry.ts', 'package.json']) {
    assert.equal(await readFile(join(root, path), 'utf8'), f.committedFile(path), `${path} must come from configured main commit ${f.mainCommit}`);
  }
  return root;
}

async function assertWorkerOrigin(f: Awaited<ReturnType<typeof fixture>>, root: string, pid: number): Promise<void> {
  const entries = (await f.events()).filter(event => event.event === 'entry');
  assert.equal(entries.length, 1, 'idempotent start must not execute another entrypoint');
  const entry = entries[0];
  const entryPath = join(root, f.options.service.entryRelativePath);
  assert.equal(entry.entryUrl, pathToFileURL(entryPath).href);
  assert.equal(entry.module.moduleUrl, pathToFileURL(join(root, 'src', 'service-entry.ts')).href);
  assert.equal(entry.module.nonce, f.origin.nonce);
  assert.equal(entry.cwd, root);
  assert.equal(entry.mainPath, root);
  assert.equal(entry.argv[1], entryPath);
  assert.equal(entry.pid, pid);
  const recovered = (await f.events()).filter(event => event.event === 'recover');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].cwd, root);
  assert.equal(recovered[0].context.orchestratorRoot, f.root);
  assert.equal(recovered[0].context.homeDirectory, f.homeDirectory);
  assert.ok(recovered[0].context.stateDirectory.startsWith(f.homeDirectory));
}

async function advanceConfiguredMain(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await writeFile(join(f.main, 'bin', 'service.ts'), 'throw new Error("new configured main must wait for handover");\n');
  await writeFile(join(f.main, 'service-fixture-origin.json'), JSON.stringify({ configuredMain: f.main, nonce: randomUUID() }));
  execFileSync('git', ['-C', f.main, 'add', '--', 'bin/service.ts', 'service-fixture-origin.json']);
  execFileSync('git', ['-C', f.main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Advance logical main without service handover']);
  assert.notEqual(execFileSync('git', ['-C', f.main, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), f.mainCommit);
}

function success(result: ExecutionResult) {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function diagnostic(result: ExecutionResult) {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  const value = JSON.parse(result.stderr);
  assert.ok(value.code);
  assert.ok(value.details.reason);
  assert.ok(value.remediation.length > 0);
  return value;
}

test('CLI service lifecycle launches configured main entry and stop preserves an unrelated owned agent process', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const agent = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); process.stdin.resume();'], { stdio: ['pipe', 'pipe', 'ignore'] });
  f.children.push(agent);
  await once(agent.stdout!, 'data');
  const started = success(await f.cli(['service', 'start']));
  assert.equal(started.state, 'ready');
  const root = await pinnedMain(f);
  assert.equal(started.mainPath, root);
  const status = success(await f.cli(['service', 'status']));
  assert.equal(status.pid, started.pid);
  assert.equal(status.mainPath, root);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].command, process.execPath);
  assert.ok(f.launches[0].args.includes(join(root, f.options.service.entryRelativePath)));
  assert.equal(f.launches[0].cwd, root);
  assert.equal(f.launches[0].mainPath, root);
  await assertWorkerOrigin(f, root, started.pid);
  await advanceConfiguredMain(f);
  const repeated = success(await f.cli(['service', 'start']));
  assert.equal(repeated.state, 'ready');
  assert.equal(repeated.pid, started.pid);
  assert.equal(repeated.mainPath, root);
  const retained = success(await f.cli(['service', 'status']));
  assert.equal(retained.pid, started.pid);
  assert.equal(retained.mainPath, root);
  assert.equal(f.launches.length, 1);
  await assertWorkerOrigin(f, root, started.pid);
  assert.equal(success(await f.cli(['service', 'stop'])).state, 'stopped');
  assert.equal(agent.exitCode, null);
  assert.equal(agent.signalCode, null);
  assert.doesNotThrow(() => process.kill(agent.pid!, 0));
  assert.equal(success(await f.cli(['service', 'status'])).state, 'stopped');
});

test('help is lazy and remains usable with absent main and absent host ports', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'absent');
  await rm(f.main, { recursive: true });
  const help = await f.cli(['service', 'start', '--help']);
  assert.equal(help.exitCode, 0, help.stderr);
  assert.match(help.stdout, /service/);
  assert.equal(f.children.length, 0);
  await assert.rejects(access(join(f.homeDirectory, '.raf')));
});

test('service requests auto-start one configured worker and reuse it after command completion', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const other = f.createServiceHandlers(f.options, f.dependencies);
  const results = await Promise.all([
    f.handlers.request({ operation: 'fixture.echo', payload: 'first' }),
    other.request({ operation: 'fixture.echo', payload: 'second' }),
  ]);
  assert.deepEqual(results, [{ exitCode: 0, value: 'first' }, { exitCode: 0, value: 'second' }]);
  assert.equal((await f.events()).filter(event => event.event === 'recover').length, 1);
  assert.equal(success(await f.cli(['service', 'status'])).state, 'ready');
});

test('missing configured main never falls back to available develop worker', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await rm(f.main, { recursive: true });
  const failure = diagnostic(await f.cli(['service', 'start']));
  assert.match(JSON.stringify(failure), /main/i);
  assert.equal(f.children.length, 0);
});

test('missing production ports and failed recovery do not claim readiness', { timeout: 10_000 }, async t => {
  const absent = await fixture(t, 'absent');
  assert.match(JSON.stringify(diagnostic(await absent.cli(['service', 'start']))), /port|module|host|оброб|модул/i);
  const broken = await fixture(t, 'broken');
  assert.match(JSON.stringify(diagnostic(await broken.cli(['service', 'start']))), /fixture recovery unavailable/);
});

test('unknown operation cannot masquerade as successful reminder or resource handling', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  for (const operation of ['reminder.activate', 'resource.wait', 'unknown.operation']) {
    const result = await f.handlers.request({ operation, payload: {} });
    assert.notEqual(result.exitCode, 0);
    assert.match(JSON.stringify(result), /Unsupported service operation/);
  }
});

test('child entry validates environment and required ports before declaring readiness', async () => {
  await assert.rejects(runServiceEntry({ environment: {} }), /RAF_|environment|configuration|конфіг/i);
});

test('production CLI binds service handlers and passes the explicit host module to the main child', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const options = {
    orchestratorRoot: f.root,
    homeDirectory: f.homeDirectory,
    artifactPath: f.artifactPath,
    serviceHostModulePath: f.options.hostModulePath,
  };
  const started = success(await f.runProductionCli(['service', 'start'], options));
  assert.equal(started.state, 'ready');
  const root = await pinnedMain(f);
  assert.equal(started.mainPath, root);
  const status = success(await f.runProductionCli(['service', 'status'], options));
  assert.equal(status.pid, started.pid);
  assert.equal(status.mainPath, root);
  await assertWorkerOrigin(f, root, started.pid);
  await advanceConfiguredMain(f);
  const repeated = success(await f.runProductionCli(['service', 'start'], options));
  assert.equal(repeated.state, 'ready');
  assert.equal(repeated.pid, started.pid);
  assert.equal(repeated.mainPath, root);
  const retained = success(await f.runProductionCli(['service', 'status'], options));
  assert.equal(retained.pid, started.pid);
  assert.equal(retained.mainPath, root);
  await assertWorkerOrigin(f, root, started.pid);
  assert.equal(success(await f.runProductionCli(['service', 'stop'], options)).state, 'stopped');
  assert.equal((await f.events()).filter(event => event.event === 'recover').length, 1);
});

test('production help remains available before service wiring or the main service entry is available', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'absent');
  await rm(join(f.main, 'bin', 'service.ts'));
  const result = await f.runProductionCli(['service', 'start', '--help'], {
    orchestratorRoot: f.root,
    homeDirectory: f.homeDirectory,
    artifactPath: f.artifactPath,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  await assert.rejects(access(join(f.homeDirectory, '.raf')));
});
