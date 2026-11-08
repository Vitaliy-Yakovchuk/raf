import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CatalogGenerator } from '../src/catalog-generator.ts';
import { buildCatalog } from '../src/bootstrap.ts';
import { parseCommandArguments } from '../src/cli-arguments.ts';
import { execute } from '../src/cli.ts';
import { planTestRun, validateTestRunConfig } from '../src/test-runs.ts';
import { fixtureConfig, fixtureContext, fixtureEnvironment, policy } from './helpers/test-run-fixture.ts';

const readConf = (name: string) => JSON.parse(readFileSync(new URL(`../../conf/${name}`, import.meta.url), 'utf8'));
const constants = readConf('raf-constants.json');
const phases = constants.agentPhases.map((phase: { id: string }) => phase.id);
const integrationTests = readConf('flow.json').integrationTests;
const file = 'worker/src/database/concept-answer-analysis.test.ts';
const group = 'rebuild-knowledge-model-from-concept-base/analysis-queue-4.2';

for (const source of ['fixture', 'current'] as const) {
  for (const phase of ['implement', 'integration']) {
    test(`${source} etchly registry keeps analysis queue integration in phase ${phase}`, () => {
      const registry = source === 'current' ? readConf('test-runs.json')
        : JSON.parse(readFileSync(new URL('./fixtures/cli-profile-and-phase/test-runs.json', import.meta.url), 'utf8'));
      const input = fixtureConfig();
      input.projects = { etchly: registry.projects.etchly };
      const config = validateTestRunConfig(input, phases, policy, integrationTests);
      const workspace = '/qa/etchly';
      const context = { ...fixtureContext(), cwd: workspace, workspace, projectWorkspaces: { etchly: [workspace] }, integrationTests };
      const isIntegration = !!config.projects.etchly.profiles['vitest-worker-integration'];
      const environment = { ...fixtureEnvironment(), canonicalWorkspace: workspace, canonicalCwd: workspace,
        unitFiles: isIntegration ? [] : [file], files: { [file]: { kind: 'file' as const, realpath: resolve(workspace, file), unit: !isIntegration, testKind: isIntegration ? 'integration' as const : 'unit' as const } } };
      const plan = planTestRun({ project: 'etchly', phase, group, files: [file] }, config, context, environment);
      assert.equal(plan.profileId, 'vitest-worker-integration');
      assert.equal(plan.testKind, 'integration');
      assert.deepEqual(plan.selection.files, [file]);
      assert.equal(plan.timeoutPolicy?.source, 'conf/flow.json#/integrationTests/timeoutMs');
    });
  }
}

for (const builder of ['generator', 'bootstrap'] as const) {
  test(`${builder} rejects phases without task briefs before launch and derives help from files`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'raf-brief-phases-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const conf = join(root, 'conf');
    const briefs = join(conf, 'briefs/tasks');
    mkdirSync(briefs, { recursive: true });
    for (const name of ['raf-constants.json', 'models.json', 'projects.json']) {
      writeFileSync(join(conf, name), JSON.stringify(readConf(name)));
    }
    for (const phase of ['implement', 'hotfix']) writeFileSync(join(briefs, `${phase}.md`), `Stage ${phase}`);
    mkdirSync(join(briefs, 'integration.md'));
    writeFileSync(join(briefs, 'red.txt'), 'Not a task brief');
    const bindings = constants.commands.filter((command: { path: string[] }) => command.path.join(' ') !== 'help')
      .map((command: { path: string[] }) => ({ path: command.path, load: async () => async () => assert.fail('No launch during argument checks') }));
    const outputPath = join(root, 'catalog.json');
    const build = () => {
      if (builder === 'generator') new CatalogGenerator().build({ confDirectory: conf, outputPath, bindings });
      else buildCatalog(conf, outputPath, bindings.map((binding: { path: string[] }) => binding.path.join(' ')));
      return JSON.parse(readFileSync(outputPath, 'utf8'));
    };
    let catalog = build();
    const run = () => catalog.commands.find((command: { handlerName: string }) => command.handlerName === 'agent run');
    const args = ['--id', 'fixture', '--type', 'implement', '--project', 'raf', '--complexity', 'ordinary', '--tasks', 'change:1', '--phase', 'red'];
    let launched = false;
    const result = await execute(['agent', 'run', ...args], catalog, { 'agent run': async () => { launched = true; } });
    assert.equal(launched, false);
    assert.equal(result.exitCode, 1);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.code, 'INVALID_VALUE');
    assert.equal(failure.details.parameter, '--phase');
    assert.deepEqual(failure.details.expected, ['hotfix', 'implement']);
    const help = JSON.parse((await execute(['agent', 'run', '--help'], catalog, {})).stdout);
    assert.deepEqual(help.commands[0].parameters.find((parameter: { name: string }) => parameter.name === 'phase').values.map((value: { id: string }) => value.id), ['hotfix', 'implement']);
    const tests = catalog.commands.find((command: { handlerName: string }) => command.handlerName === 'test run');
    assert.ok(tests.valueSources.phase.some((value: { id: string }) => value.id === 'red'));
    writeFileSync(join(briefs, 'red.md'), 'New stage brief');
    catalog = build();
    assert.ok('params' in parseCommandArguments(args, run()));
    rmSync(join(briefs, 'red.md'));
    catalog = build();
    const rejected = parseCommandArguments(args, run());
    assert.ok('error' in rejected);
    assert.equal(rejected.error.code, 'INVALID_VALUE');
  });
}
