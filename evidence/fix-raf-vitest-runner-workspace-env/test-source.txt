import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runVitestBatchFromSource } from '../src/test-run-etchly.ts';

for (const customBase of [false, true]) {
  test(`staged Vitest runner loads ${customBase ? 'configured' : 'workspace'} base without inherited worker env`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'raf-workspace-env-'));
    const workspace = join(root, 'workspace "quoted"');
    const temporary = join(root, 'private-tmp');
    const vitest = join(workspace, 'node_modules/vitest/dist');
    mkdirSync(vitest, { recursive: true });
    mkdirSync(temporary);
    writeFileSync(join(workspace, 'package.json'), '{"type":"module"}');
    writeFileSync(join(vitest, 'index.js'), 'export class TestRunner { static identity = "workspace"; trace() {} }');
    const base = join(workspace, 'custom-base.mjs');
    writeFileSync(base, 'export default class Runner { static identity = "configured"; trace() {} }');
    const keys = ['RAF_TEST_RUN_WORKSPACE', 'RAF_TEST_RUN_BASE_RUNNER'];
    const previous = keys.map(key => process.env[key]);
    process.env.RAF_TEST_RUN_WORKSPACE = workspace;
    if (customBase) process.env.RAF_TEST_RUN_BASE_RUNNER = base;
    else delete process.env.RAF_TEST_RUN_BASE_RUNNER;
    let staged = '', closed = false;
    try {
      await runVitestBatchFromSource({
        parseCLI: () => ({ filter: ['value.test.ts'], options: {} }),
        async createVitest(_mode, options) {
          staged = options.runner;
          const project = { config: { environment: 'node', runner: staged } };
          return { projects: [project], async start() {
            for (const key of keys) delete process.env[key];
            let loaded: any, failure: unknown;
            try { loaded = (await import(pathToFileURL(project.config.runner).href)).default; }
            catch (error) { failure = error; }
            assert.equal(failure, undefined, 'runner must resolve its base inside a worker without the bridge process env');
            assert.equal(loaded.identity, customBase ? 'configured' : 'workspace');
            assert.ok(new loaded());
          }, async close() { closed = true; } };
        },
      }, ['run', 'value.test.ts'], fileURLToPath(new URL('../src/test-run-vitest-runner.ts', import.meta.url)), temporary);
      assert.equal(closed, true);
      assert.equal(existsSync(staged), false);
      assert.deepEqual(readdirSync(temporary), []);
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      rmSync(root, { recursive: true, force: true });
    }
  });
}
