import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mapVitestFunctionCoverage, verifiedVitestLoads } from '../src/test-run-quality-vitest.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const dependencies = resolve(repository, '../etchly-develop/node_modules');

for (const nested of [false, true]) test(`quality observes executed functions in ${nested ? 'nested projects' : 'root project'}`, () => {
  assert.equal(JSON.parse(readFileSync(join(dependencies, 'vitest/package.json'), 'utf8')).version, '4.1.12');
  const workspace = mkdtempSync(join(tmpdir(), 'raf-quality-projects-'));
  try {
    const app = join(workspace, 'app');
    mkdirSync(join(app, 'src'), { recursive: true });
    symlinkSync(dependencies, join(workspace, 'node_modules'), 'dir');
    const sources = {
      'app/src/library.ts': 'export function cachedLibrary() { return 3; }\nexport function prepareLibrary() { return cachedLibrary() + 1; }\n',
      'app/src/listing.ts': 'export function cachedListing() { return 5; }\n',
    };
    for (const [path, source] of Object.entries(sources)) writeFileSync(join(workspace, path), source);
    writeFileSync(join(app, 'src/check.test.ts'), `import { test, expect } from 'vitest';
import { prepareLibrary } from './library';
import { cachedListing } from './listing';
test('selected functions execute', () => { expect(prepareLibrary()).toBe(4); expect(cachedListing()).toBe(5); });
`);
    const selection = { name: 'app', environment: 'node', include: ['src/check.test.ts'] };
    writeFileSync(join(app, 'vitest.config.ts'), `export default ${JSON.stringify({ root: app, test: nested ? { projects: [{ extends: true, test: selection }] } : selection })};`);
    const evidencePath = join(workspace, 'events.jsonl');
    const coverageRoot = join(workspace, 'coverage');
    const settingsPath = join(workspace, 'settings.json');
    const runId = nested ? 'nested-projects' : 'root-project';
    writeFileSync(settingsPath, JSON.stringify({ runId, executionRoot: workspace, canonicalWorkspace: join(workspace, 'canonical'), targets: Object.keys(sources), evidencePath, coverageRoot }));
    const script = `
const api = await import(${JSON.stringify(join(dependencies, 'vitest/dist/node.js'))});
const { runVitestBatchFromSource } = await import(${JSON.stringify(join(repository, 'src/test-run-etchly.ts'))});
await runVitestBatchFromSource(api, ['run', 'src/check.test.ts', '--root', ${JSON.stringify(app)}, '--config', ${JSON.stringify(join(app, 'vitest.config.ts'))}, '--configLoader', 'runner'], ${JSON.stringify(join(repository, 'src/test-run-vitest-runner.ts'))}, ${JSON.stringify(workspace)});
`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: app, env: { ...process.env, RAF_TEST_RUN_WORKSPACE: workspace, RAF_TEST_RUN_QUALITY_SETTINGS: settingsPath, RAF_TEST_RUN_BASE_RUNNER: '', VITEST: 'true', TEST: 'true', NODE_ENV: 'test' }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const lcov = readFileSync(join(coverageRoot, 'lcov.info'), 'utf8');
    assert.match(lcov, /FNDA:1,cachedLibrary/);
    assert.match(lcov, /FNDA:1,prepareLibrary/);
    assert.match(lcov, /FNDA:1,cachedListing/);
    const inputs = Object.entries(sources).map(([path, bytes]) => ({ path, realpath: join(workspace, path), bytes: Buffer.from(bytes), role: 'source' as const }));
    const events = existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    const loaded = verifiedVitestLoads(events.filter(event => event.kind === 'load').map(event => event.source), inputs as any, runId);
    assert.deepEqual([...new Set(loaded.filter(source => source.loaded).map(source => source.path))].sort(), Object.keys(sources).sort(), 'Executed project must record both source inputs');
    const functions = [
      { id: 'cachedLibrary', path: 'app/src/library.ts', startByte: 0, endByte: sources['app/src/library.ts'].indexOf('\n') },
      { id: 'prepareLibrary', path: 'app/src/library.ts', startByte: sources['app/src/library.ts'].indexOf('\n') + 1, endByte: sources['app/src/library.ts'].length - 1 },
      { id: 'cachedListing', path: 'app/src/listing.ts', startByte: 0, endByte: sources['app/src/listing.ts'].length - 1 },
    ];
    const mapped = mapVitestFunctionCoverage(lcov, app, functions as any, inputs as any, loaded);
    assert.deepEqual(mapped.omissions, [], JSON.stringify({ lcov, functions, loaded }));
    assert.deepEqual(mapped.functions?.map(fn => ({ id: fn.id, hits: fn.hits, mapped: fn.mapped })), functions.map(fn => ({ id: fn.id, hits: 1, mapped: true })));
    assert.equal(mapVitestFunctionCoverage(lcov, app, functions as any, inputs as any, []).functions?.length, 0, 'Unobserved code remains unverified');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
