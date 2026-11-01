import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { buildCatalog, runCli } from '../src/bootstrap.ts';
import type { CompiledCatalog } from '../src/catalog.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'raf-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const confDir = join(root, 'conf');
  mkdirSync(confDir);
  const artifactPath = join(root, 'catalog.json');
  const constants = {
    reportStatuses: [{ id: 'fixture-done', description: 'Fixture report completed' }],
    commands: [
      {
        path: ['fixture', 'inspect'],
        description: 'Inspect compiled fixture',
        parameters: [{ name: 'runner', option: '--runner', required: true }],
        valueSources: { runner: 'models.json#/runners' },
      },
      { path: ['help'] },
    ],
  };
  writeFileSync(join(confDir, 'raf-constants.json'), JSON.stringify(constants));
  writeFileSync(join(confDir, 'models.json'), JSON.stringify({ runners: [{ id: 'fixture-engine' }] }));
  return { root, confDir, artifactPath, constants };
}

test('buildCatalog writes a compiled catalog JSON artifact', t => {
  const { confDir, artifactPath } = fixture(t);
  buildCatalog(confDir, artifactPath, ['fixture inspect']);
  const compiled = JSON.parse(readFileSync(artifactPath, 'utf8')) as CompiledCatalog;
  assert.ok(Array.isArray(compiled.commands));
  const command = compiled.commands.find(item => item.path.join(' ') === 'fixture inspect');
  assert.ok(command);
  assert.equal(command.handlerName, 'fixture inspect');
  assert.deepEqual(command.valueSources.runner.map(value => value.id), ['fixture-engine']);
  assert.equal(command.parameters.find(parameter => parameter.name === 'runner')?.required, true);
});

test('invalid catalog cannot create an artifact or replace an earlier valid artifact', t => {
  const { confDir, artifactPath, constants } = fixture(t);
  constants.commands[0].valueSources!.runner = 'models.json#/missing';
  writeFileSync(join(confDir, 'raf-constants.json'), JSON.stringify(constants));
  assert.throws(() => buildCatalog(confDir, artifactPath, ['fixture inspect']));
  assert.equal(existsSync(artifactPath), false);

  constants.commands[0].valueSources!.runner = 'models.json#/runners';
  writeFileSync(join(confDir, 'raf-constants.json'), JSON.stringify(constants));
  buildCatalog(confDir, artifactPath, ['fixture inspect']);
  const previous = readFileSync(artifactPath);
  constants.commands.push(structuredClone(constants.commands[0]));
  writeFileSync(join(confDir, 'raf-constants.json'), JSON.stringify(constants));
  assert.throws(() => buildCatalog(confDir, artifactPath, ['fixture inspect']));
  assert.deepEqual(readFileSync(artifactPath), previous);
});

test('runCli help uses only the compiled artifact even after live conf disappears', async t => {
  const { confDir, artifactPath } = fixture(t);
  buildCatalog(confDir, artifactPath, ['fixture inspect']);
  rmSync(confDir, { recursive: true });
  const result = await runCli(['help', 'fixture', 'inspect'], artifactPath, {});
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.includes('Inspect compiled fixture'));
  assert.ok(result.stdout.includes('fixture-engine'));
  assert.deepEqual(await runCli(['fixture', 'inspect', '--help'], artifactPath, {}), result);
});

test('runCli delegates to the known handler with validated parameters', async t => {
  const { confDir, artifactPath } = fixture(t);
  buildCatalog(confDir, artifactPath, ['fixture inspect']);
  const calls: Record<string, unknown>[] = [];
  const result = await runCli(['fixture', 'inspect', '--runner', 'fixture-engine'], artifactPath, {
    'fixture inspect': async params => { calls.push(params); return { inspected: true }; },
    'unrelated command': () => { assert.fail('Unrelated handler invoked'); },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(calls, [{ runner: 'fixture-engine' }]);
});

test('missing artifact yields actionable structured diagnostics without stack or argv secrets', async t => {
  const { artifactPath } = fixture(t);
  let called = false;
  const result = await runCli(['fixture', 'inspect', '--api-key=secret-never-print'], artifactPath, {
    'fixture inspect': () => { called = true; },
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(typeof error.code, 'string');
  assert.ok(error.code.length > 0);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.ok(error.details && typeof error.details === 'object');
  assert.ok(error.remediation);

  assert.ok(JSON.stringify(error.details).includes(artifactPath));
  assert.match(JSON.stringify(error.remediation), /build|збір|зібр|перебуд/i);
  assert.ok(!result.stderr.includes('secret-never-print'));
  assert.ok(!result.stderr.includes('"stack"'));
  assert.doesNotMatch(result.stderr, /\\n\s+at /);
  assert.equal(called, false);
});
