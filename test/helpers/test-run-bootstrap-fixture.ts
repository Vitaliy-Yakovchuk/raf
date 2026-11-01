import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { TestContext } from 'node:test';
import { fixtureConfig } from './test-run-fixture.ts';

let sequence = 0;

export async function bootstrapFixture(t: TestContext, failure: 'read-only' | 'reader-race' | 'state-open' | 'state-result' | 'healthy', options: { control?: string; phase?: string; accessControl?: () => void; permissionCode?: 'EROFS' | 'EACCES' } = {}) {
  const root = '/unit/bootstrap/orchestrator';
  const previousRoot = process.env.RAF_ORCHESTRATOR_ROOT;
  process.env.RAF_ORCHESTRATOR_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.RAF_ORCHESTRATOR_ROOT;
    else process.env.RAF_ORCHESTRATOR_ROOT = previousRoot;
  });
  const control = options.control ?? root + '/.git/modules/raf/raf-hotfix';
  const codeRoot = root + '/raf-main-a';
  const catalog = readFileSync(new URL('../../dist/catalog.json', import.meta.url), 'utf8');
  const config = fixtureConfig();
  const calls = { access: [] as string[], retain: 0, release: 0, runtime: 0 };
  const execution = { exitCode: 0, stdout: '{"fixture":"original result"}', stderr: '' };
  const key = `raf.bootstrap-unit.${++sequence}`;
  const cliUrl = new URL(`../../src/cli.ts?${sequence}`, import.meta.url).href;
  const globals = globalThis as Record<string, unknown>;
  globals[key] = {
    calls, execution,
    statSync: () => ({ nlink: 1, dev: 1n, ino: 1n, ctimeNs: 1n }),
    readFileSync(path: string) {
      if (String(path).endsWith('/dist/catalog.json')) return catalog;
      if (String(path).endsWith('/conf/projects.json')) return JSON.stringify({ projects: { raf: { branchPaths: { main: 'raf-main' }, mainCopies: ['raf-main-a', 'raf-main-b'] } } });
      if (String(path).endsWith('/conf/test-runs.json')) return JSON.stringify(config);
      throw new Error(`Unexpected bootstrap read: ${path}`);
    },
    accessSync(path: string) {
      calls.access.push(path);
      options.accessControl?.();
      if (failure === 'read-only') throw Object.assign(new Error('read-only activation control'), { code: options.permissionCode ?? 'EROFS' });
    },
    async acquireHotfixReader() {
      calls.retain++;
      options.accessControl?.();
      if (failure === 'read-only') throw Object.assign(new Error('read-only activation control'), { code: options.permissionCode ?? 'EROFS' });
      if (failure === 'reader-race') throw new Error('Generation changed during reader registration');
      return { generationRoot: codeRoot, release: async () => { calls.release++; } };
    },
    async runProductionCli() {
      calls.runtime++;
      if (failure === 'state-open') throw new Error('Incomplete SQLite header');
      if (failure === 'state-result') return { exitCode: 1, stdout: '', stderr: JSON.stringify({ code: 'HANDLER_FAILED', message: 'Incomplete SQLite header' }) };
      return execution;
    },
  };
  const bridge = `const f = globalThis[${JSON.stringify(key)}];`;
  const doubles: Record<string, string> = {
    './compiled-catalog.ts': `${bridge} export const readCatalogArtifact = () => JSON.parse(f.readFileSync('/dist/catalog.json'));`,
    'node:fs': `export * from 'node:fs'; ${bridge}
      export const realpathSync = () => '/unit/bootstrap/orchestrator/raf-main-a';
      export const statSync = (...args) => f.statSync(...args);
      export const readFileSync = (...args) => f.readFileSync(...args);
      export const accessSync = (...args) => f.accessSync(...args);`,
    [new URL('src/hotfix-activation.ts', 'file://' + codeRoot + '/').href]: `${bridge}
      export const acquireHotfixReader = (...args) => f.acquireHotfixReader(...args);`,
    [new URL('src/production-entry.ts', 'file://' + codeRoot + '/').href]: `${bridge}
      export const runProductionCli = (...args) => f.runProductionCli(...args);`,
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === cliUrl && Object.hasOwn(doubles, specifier)) return { url: `bootstrap-unit:${key}:${Object.keys(doubles).indexOf(specifier)}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      const prefix = `bootstrap-unit:${key}:`;
      if (url.startsWith(prefix)) return { format: 'module', source: Object.values(doubles)[Number(url.slice(prefix.length))], shortCircuit: true };
      return next(url, context);
    },
  });
  t.after(() => { hooks.deregister(); delete globals[key]; });
  const { runPublicCli } = await import(cliUrl);
  return { calls, control, execution,
    run: () => runPublicCli('file://' + codeRoot + '/bin/raf.ts', ['test', 'run', '--project', 'raf', '--phase', options.phase ?? 'hotfix', '--group', 'add-raf-test-run/bootstrap-refusal', '--files', 'test/test-run-cli.test.ts']),
  };
}
