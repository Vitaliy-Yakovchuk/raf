import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { execute, type ExecutionResult } from '../src/cli.ts';
import { createServiceHandlers, runServiceEntry } from '../src/service-entry.ts';
import { runProductionCli } from '../src/production-entry.ts';

const entryUrl = new URL('../src/service-entry.ts', import.meta.url).href;
const constants = JSON.parse(await readFile(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(await readFile(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const catalog = compileCatalog(constants, models, constants.commands.map((command: { path: string[] }) => command.path.join(' ')));

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
  const log = join(root, 'service-events.jsonl');
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
import { runServiceEntry } from ${JSON.stringify(entryUrl)};
const host = await runServiceEntry();
await host.closed;
`);
  await writeFile(join(develop, 'bin', 'service.ts'), 'throw new Error("forbidden develop worker");\n');
  const children: ChildProcess[] = [];
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
    root, main, develop, homeDirectory, options, dependencies, children, handlers, artifactPath,
    cli: (argv: string[]) => execute(argv, catalog, handlers!.handlers),
    events: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
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
  assert.equal(started.mainPath, f.main);
  const status = success(await f.cli(['service', 'status']));
  assert.equal(status.pid, started.pid);
  const recovered = (await f.events()).filter(event => event.event === 'recover');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].cwd, f.main);
  assert.equal(recovered[0].context.orchestratorRoot, f.root);
  assert.equal(recovered[0].context.homeDirectory, f.homeDirectory);
  assert.ok(recovered[0].context.stateDirectory.startsWith(f.homeDirectory));
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
  const other = createServiceHandlers(f.options, f.dependencies);
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
  assert.equal(success(await runProductionCli(['service', 'start'], options)).state, 'ready');
  assert.equal(success(await runProductionCli(['service', 'status'], options)).mainPath, f.main);
  assert.equal(success(await runProductionCli(['service', 'stop'], options)).state, 'stopped');
  assert.equal((await f.events()).filter(event => event.event === 'recover').length, 1);
});

test('production help remains available before service wiring or main checkout is available', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'absent');
  await rm(f.main, { recursive: true });
  const result = await runProductionCli(['service', 'start', '--help'], {
    orchestratorRoot: f.root,
    homeDirectory: f.homeDirectory,
    artifactPath: f.artifactPath,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  await assert.rejects(access(join(f.homeDirectory, '.raf')));
});

test('configured main path on the wrong Git branch is rejected before spawning', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  execFileSync('git', ['-C', f.main, 'checkout', '-q', '-b', 'develop']);
  assert.match(JSON.stringify(diagnostic(await f.cli(['service', 'start']))), /main|branch|гіл/i);
  assert.equal(f.children.length, 0);
});
