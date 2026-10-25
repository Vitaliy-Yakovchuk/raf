import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogGenerator } from '../src/catalog-generator.ts';
import type { CatalogHandlerBinding, CatalogSources, GeneratedCatalog } from '../src/catalog-generator.ts';
import { parseCommandArguments } from '../src/cli-arguments.ts';
import { execute } from '../src/cli.ts';
import { runCli } from '../src/bootstrap.ts';

function fixture() {
  return {
    constants: {
      version: 1,
      agentTypes: [
        { id: 'main', description: 'Coordinator account', launchableByRaf: false },
        { id: 'fixture-worker', description: 'Worker description', launchableByRaf: true },
      ],
      agentPhases: [{ id: 'fixture-phase', description: 'Phase description' }],
      reportStatuses: [{ id: 'fixture-done', description: 'Done description', event: 'agent.fixture-done' }],
      eventIdKinds: { agent: 'Agent identity' },
      events: [{ id: 'agent.fixture-done', description: 'Done event', idKind: 'agent' }],
      reminderBindingActions: [{ id: 'fixture-action', description: 'Action description' }],
      resourceWaitLevels: [{ id: 'fixture-level', description: 'Level description', priority: 0 }],
      errorCodes: [
        { id: 'INVALID_VALUE', description: 'Invalid parameter', exitCode: 1 },
        { id: 'COMMAND_UNAVAILABLE', description: 'Command unavailable', exitCode: 1 },
      ],
      commands: [
        {
          path: ['agent', 'run'], description: 'Launch an agent',
          parameters: [
            { name: 'type', option: '--type', description: 'Agent type', required: true },
            { name: 'phase', option: '--phase', description: 'Phase' },
            { name: 'complexity', option: '--complexity', description: 'Complexity', default: 'fixture-light' },
            { name: 'project', option: '--project', description: 'Project' },
          ],
          valueSources: {
            type: 'raf-constants.json#/agentTypes', phase: 'raf-constants.json#/agentPhases',
            complexity: 'models.json#/routing/complexityOrder', project: 'projects.json#/projects',
          },
          prerequisites: 'An approved task', sideEffects: 'Launches the selected agent',
          output: 'Launch result', errors: 'Invalid values are rejected before launch',
          errorCodes: ['INVALID_VALUE'], examples: ['raf agent run --type fixture-worker'],
        },
        {
          path: ['runner', 'list'], description: 'List runners', parameters: [],
          valueSources: { runner: 'models.json#/runners' },
          prerequisites: 'Readable state', sideEffects: 'Reads runner state',
          output: 'Runner state', errors: 'State may be unavailable', errorCodes: ['COMMAND_UNAVAILABLE'],
        },
        {
          path: ['help'], description: 'Show help', prerequisites: 'Compiled artifact',
          sideEffects: 'None', output: 'Command help', errors: 'Unknown path', errorCodes: ['INVALID_VALUE'],
        },
      ],
    },
    models: {
      runners: [{ id: 'fixture-runner', description: 'Runner description', launchableByRaf: false }],
      routing: { complexityOrder: ['fixture-light', 'fixture-deep'] },
    },
    projects: { projects: { 'fixture-project': { description: 'Project description' } } },
  };
}

type Fixture = ReturnType<typeof fixture>;

function bindings(onLoad: () => void = () => {}): CatalogHandlerBinding[] {
  return [
    { path: ['agent', 'run'], load: async () => { onLoad(); return async params => params; } },
    { path: ['runner', 'list'], load: async () => { onLoad(); return async () => []; } },
  ];
}

function compile(source: CatalogSources = fixture(), registry = bindings()): GeneratedCatalog {
  let result: GeneratedCatalog;
  assert.doesNotThrow(() => { result = new CatalogGenerator().compile(source, registry); },
    'A valid catalog must compile before parser/help or semantic assertions');
  return result!;
}

function command(catalog: GeneratedCatalog) {
  const found = catalog.commands.find(entry => entry.handlerName === 'agent run');
  assert.ok(found, 'The artifact must contain the approved command');
  return found;
}

function rejects(source: CatalogSources, pointers: readonly string[], registry = bindings(), reference?: string) {
  assert.throws(() => new CatalogGenerator().compile(source, registry), error => {
    assert.ok(error instanceof Error);
    for (const pointer of pointers) assert.ok(error.message.includes(pointer), `Missing source pointer ${pointer}: ${error.message}`);
    if (reference) assert.ok(error.message.includes(reference), `Missing reference ${reference}: ${error.message}`);
    return true;
  });
}

function diskFixture(t: TestContext, source = fixture()) {
  const directory = mkdtempSync(join(tmpdir(), 'raf-catalog-generator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const confDirectory = join(directory, 'conf');
  mkdirSync(confDirectory);
  const outputPath = join(directory, 'catalog.json');
  writeSources(confDirectory, source);
  return { directory, confDirectory, outputPath };
}

function writeSources(directory: string, source: CatalogSources) {
  for (const [name, value] of [
    ['raf-constants.json', source.constants], ['models.json', source.models], ['projects.json', source.projects],
  ] as const) writeFileSync(join(directory, name), JSON.stringify(value));
}

test('CFC123.S01 parser and help share every resolved value and its original metadata', async () => {
  const source = fixture();
  const catalog = compile(source);
  const target = command(catalog);
  const result = await execute(['agent', 'run', '--help'], catalog, {});
  assert.equal(result.exitCode, 0);
  const help = JSON.parse(result.stdout).commands[0];
  for (const parameter of target.parameters) {
    const shown = help.parameters.find((entry: { name: string }) => entry.name === parameter.name);
    assert.deepEqual(shown.values, parameter.values);
    for (const value of parameter.values ?? []) {
      const parsed = parseCommandArguments(['--type', 'fixture-worker', ...(parameter.name === 'type' ? [] : [parameter.option, value.id])], target);
      if (parameter.name === 'type' && value.launchableByRaf === false) continue;
      const selected = parameter.name === 'type' ? parseCommandArguments(['--type', value.id], target) : parsed;
      assert.ok('params' in selected, `${parameter.name}=${value.id} must parse`);
      assert.equal(selected.params[parameter.name], value.id);
    }
    assert.ok('error' in parseCommandArguments(['--type', 'fixture-worker', ...(parameter.name === 'type' ? [] : [parameter.option, 'unknown-value'])].map((value, index) => parameter.name === 'type' && index === 1 ? 'unknown-value' : value), target));
  }
  assert.deepEqual(target.valueSources.type, source.constants.agentTypes);
  assert.deepEqual(target.valueSources.complexity, [{ id: 'fixture-light' }, { id: 'fixture-deep' }]);
  assert.deepEqual(target.valueSources.project, [{ id: 'fixture-project' }]);
  assert.deepEqual(catalog.reportStatuses, source.constants.reportStatuses);
});

test('CFC123.S02 rebuild replaces parser help and validator constants without a second enum', async () => {
  const source = fixture();
  const before = compile(source);
  source.constants.agentTypes[1] = { id: 'replacement-worker', description: 'Replacement description', launchableByRaf: true };
  source.constants.commands[0].examples = ['raf agent run --type replacement-worker'];
  source.models.routing.complexityOrder = ['replacement-complexity'];
  source.constants.commands[0].parameters![2].default = 'replacement-complexity';
  source.models.runners[0].id = 'replacement-runner';
  Object.assign(source.projects, { projects: { 'replacement-project': { description: 'Replacement project' } } });
  source.constants.reportStatuses[0].id = 'replacement-status';
  source.constants.events[0].id = 'agent.replacement';
  source.constants.reportStatuses[0].event = 'agent.replacement';
  const after = compile(source);
  for (const id of ['replacement-worker', 'replacement-complexity', 'replacement-project']) {
    const parameter = command(after).parameters.find(entry => entry.values?.some(value => value.id === id));
    assert.ok(parameter);
    const argv = ['--type', 'replacement-worker', ...(parameter.name === 'type' ? [] : [parameter.option, id])];
    assert.ok('params' in parseCommandArguments(argv, command(after)));
    assert.ok((await execute(['help', 'agent', 'run'], after, {})).stdout.includes(id));
  }
  assert.ok('error' in parseCommandArguments(['--type', 'fixture-worker'], command(after)));
  assert.deepEqual(after.constants, source.constants);
  assert.deepEqual(after.models, source.models);
  assert.deepEqual(after.projects, source.projects);
  assert.equal(before.reportStatuses[0].id, 'fixture-done');
  assert.equal(command(before).valueSources.type[1].id, 'fixture-worker');
  assert.equal(after.reportStatuses[0].id, 'replacement-status');
  assert.ok((await execute(['runner', 'list', '--help'], after, {})).stdout.includes('replacement-runner'));
});

test('CFC123.S03 compile is deterministic and never mutates the source snapshot', () => {
  const source = fixture();
  const snapshot = structuredClone(source);
  const first = compile(source);
  const second = compile(source);
  assert.deepEqual(source, snapshot);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(command(first).valueSources.complexity.map(value => value.id), source.models.routing.complexityOrder);
});

test('CFC123.S04 help-only runner values do not invent a parser option or load runtime', async () => {
  let loads = 0;
  const catalog = compile(fixture(), bindings(() => { loads++; throw new Error('Runtime must remain lazy'); }));
  for (const argv of [[], ['--help'], ['help'], ['help', 'runner'], ['runner', 'list', '--help'], ['help', 'runner', 'list']]) {
    assert.equal((await execute(argv, catalog, {})).exitCode, 0);
  }
  assert.deepEqual(await execute(['runner', 'list', '--help'], catalog, {}), await execute(['help', 'runner', 'list'], catalog, {}));
  const target = catalog.commands.find(entry => entry.handlerName === 'runner list')!;
  assert.deepEqual(target.parameters, []);
  assert.ok('error' in parseCommandArguments(['--runner', 'fixture-runner'], target));
  assert.equal(loads, 0);
});

test('CFC123.S05 JSON Pointer decodes ~1 and ~0 and preserves external attributes', () => {
  const source = fixture();
  Object.assign(source.models, { 'slash/key': { 'tilde~key': source.models.runners } });
  source.constants.commands[1].valueSources = { runner: 'models.json#/slash~1key/tilde~0key' } as typeof source.constants.commands[1]['valueSources'];
  const compiled = compile(source);
  assert.deepEqual(compiled.commands.find(entry => entry.handlerName === 'runner list')!.valueSources.runner, source.models.runners);
});

test('CFC123.S06 missing independent handler binding cannot be inferred from commands', () => {
  rejects(fixture(), ['raf-constants.json#/commands/0', 'agent run'], bindings().slice(1));
});

test('CFC123.S07 duplicate independent handler bindings are rejected', () => {
  rejects(fixture(), ['agent run'], [...bindings(), bindings()[0]]);
});

test('CFC123.S08 an explicit unavailable binding is accepted without loading it at build time', () => {
  let loads = 0;
  const registry = bindings();
  registry[0] = { path: ['agent', 'run'], load: async () => {
    loads++;
    return async () => { throw new Error('COMMAND_UNAVAILABLE'); };
  } };
  assert.equal(command(compile(fixture(), registry)).handlerName, 'agent run');
  assert.equal(loads, 0);
});

const invalid: { id: string; name: string; mutate: (source: Fixture) => void; pointers: string[]; reference?: string }[] = [
  { id: 'S09', name: 'duplicate command paths cite both entries', mutate: s => { s.constants.commands.push(structuredClone(s.constants.commands[0])); }, pointers: ['#/commands/0/path', '#/commands/3/path'] },
  { id: 'S10', name: 'duplicate agent ids with different descriptions', mutate: s => { s.constants.agentTypes[1].id = 'main'; }, pointers: ['#/agentTypes/0/id', '#/agentTypes/1/id'] },
  { id: 'S11', name: 'duplicate parameter names', mutate: s => { s.constants.commands[0].parameters![1].name = 'type'; }, pointers: ['#/commands/0/parameters/0/name', '#/commands/0/parameters/1/name'] },
  { id: 'S12', name: 'duplicate parameter options', mutate: s => { s.constants.commands[0].parameters![1].option = '--type'; }, pointers: ['#/commands/0/parameters/0/option', '#/commands/0/parameters/1/option'] },
  { id: 'S13', name: 'unknown reference field', mutate: s => { s.constants.commands[0].valueSources!.type = 'raf-constants.json#/missing'; }, pointers: ['#/commands/0/valueSources/type'], reference: 'raf-constants.json#/missing' },
  { id: 'S14', name: 'invalid pointer escape', mutate: s => { s.constants.commands[0].valueSources!.type = 'models.json#/runners~2'; }, pointers: ['#/commands/0/valueSources/type'], reference: 'models.json#/runners~2' },
  { id: 'S15', name: 'external URL reference', mutate: s => { s.constants.commands[0].valueSources!.type = 'https://example.invalid/models.json#/runners'; }, pointers: ['#/commands/0/valueSources/type'] },
  { id: 'S16', name: 'traversal reference', mutate: s => { s.constants.commands[0].valueSources!.type = '../models.json#/runners'; }, pointers: ['#/commands/0/valueSources/type'] },
  { id: 'S17', name: 'empty resolved source', mutate: s => { s.models.routing.complexityOrder = []; }, pointers: ['#/commands/0/valueSources/complexity'], reference: 'models.json#/routing/complexityOrder' },
  { id: 'S18', name: 'heterogeneous resolved source', mutate: s => { (s.models.routing.complexityOrder as unknown[]).push({ id: 'object-entry' }); }, pointers: ['#/commands/0/valueSources/complexity'], reference: 'models.json#/routing/complexityOrder' },
  { id: 'S19', name: 'duplicate external ids', mutate: s => { s.models.runners.push({ ...s.models.runners[0], description: 'Other description' }); }, pointers: ['#/commands/1/valueSources/runner'], reference: 'models.json#/runners' },
  { id: 'S20', name: 'arbitrary object is not a projects enum', mutate: s => { Object.assign(s.projects, { other: { key: {} } }); s.constants.commands[0].valueSources!.project = 'projects.json#/other'; }, pointers: ['#/commands/0/valueSources/project'], reference: 'projects.json#/other' },
  { id: 'S21', name: 'inherited pointer fields are not resolved', mutate: s => { Object.setPrototypeOf(s.models, { inherited: ['fixture-light'] }); s.constants.commands[0].valueSources!.complexity = 'models.json#/inherited'; }, pointers: ['#/commands/0/valueSources/complexity'], reference: 'models.json#/inherited' },
  { id: 'S22', name: 'default outside resolved set', mutate: s => { s.constants.commands[0].parameters![2].default = 'missing-default'; }, pointers: ['#/commands/0/parameters/2/default'] },
  { id: 'S23', name: 'typo in valueSources cannot silently become help-only', mutate: s => { Object.assign(s.constants.commands[0].valueSources!, { typoo: 'raf-constants.json#/agentTypes' }); }, pointers: ['#/commands/0/valueSources/typoo'] },
  { id: 'S24', name: 'parameter enum is a forbidden duplicate catalog', mutate: s => { Object.assign(s.constants.commands[0].parameters![0], { enum: ['fixture-worker'] }); }, pointers: ['#/commands/0/parameters/0/enum'] },
  { id: 'S25', name: 'parameter values cannot replace a reference', mutate: s => { Object.assign(s.constants.commands[0].parameters![0], { values: [{ id: 'fixture-worker' }] }); }, pointers: ['#/commands/0/parameters/0/values'] },
  { id: 'S26', name: 'event references an unknown idKind', mutate: s => { s.constants.events[0].idKind = 'unknown-kind'; }, pointers: ['#/events/0/idKind'] },
  { id: 'S27', name: 'status references an unknown event', mutate: s => { s.constants.reportStatuses[0].event = 'unknown-event'; }, pointers: ['#/reportStatuses/0/event'] },
  { id: 'S28', name: 'command references an unknown error code', mutate: s => { s.constants.commands[0].errorCodes = ['UNKNOWN_CODE']; }, pointers: ['#/commands/0/errorCodes/0'] },
  { id: 'S29', name: 'required description cannot be blank', mutate: s => { s.constants.commands[0].description = '   '; }, pointers: ['#/commands/0/description'] },
  { id: 'S30', name: 'unknown root property is rejected by the schema', mutate: s => { Object.assign(s.constants, { agentTypo: [] }); }, pointers: ['#/agentTypo'] },
  { id: 'S31', name: 'missing root metadata is rejected by the schema', mutate: s => { delete (s.constants as Partial<Fixture['constants']>).errorCodes; }, pointers: ['#/errorCodes'] },
  { id: 'S32', name: 'an invalid example is checked without dispatch', mutate: s => { s.constants.commands[0].examples = ['raf agent run --type fixture-worker --unknown value']; }, pointers: ['#/commands/0/examples/0'] },
  { id: 'S33', name: 'boolean default must have boolean type', mutate: s => { Object.assign(s.constants.commands[0].parameters![1], { type: 'boolean', default: 'false' }); delete (s.constants.commands[0].valueSources as Record<string, string>).phase; }, pointers: ['#/commands/0/parameters/1/default'] },
  { id: 'S34', name: 'multiple default cannot be an empty list', mutate: s => { Object.assign(s.constants.commands[0].parameters![2], { multiple: true, default: [] }); }, pointers: ['#/commands/0/parameters/2/default'] },
  { id: 'S35', name: 'boolean cannot reference a value set', mutate: s => { Object.assign(s.constants.commands[0].parameters![1], { type: 'boolean' }); }, pointers: ['#/commands/0/parameters/1'] },
  { id: 'S36', name: 'reserved global help cannot be an ordinary option', mutate: s => { s.constants.commands[0].parameters![0].option = '--help'; }, pointers: ['#/commands/0/parameters/0/option'] },
];

for (const scenario of invalid) {
  test(`CFC123.${scenario.id} ${scenario.name}`, () => {
    const source = fixture();
    scenario.mutate(source);
    rejects(source, scenario.pointers.map(pointer => `raf-constants.json${pointer}`), bindings(), scenario.reference);
  });
}

test('CFC123.S37 build publishes a deterministic reloadable artifact without serializing lazy bindings', async t => {
  const source = fixture();
  const disk = diskFixture(t, source);
  let loads = 0;
  const request = { ...disk, bindings: bindings(() => { loads++; throw new Error('No runtime at build time'); }) };
  const generator = new CatalogGenerator();
  assert.doesNotThrow(() => generator.build(request));
  const first = readFileSync(disk.outputPath, 'utf8');
  const artifact = JSON.parse(first);
  assert.deepEqual(artifact.constants, source.constants);
  assert.deepEqual(artifact.models, source.models);
  assert.deepEqual(artifact.projects, source.projects);
  assert.ok(!first.includes('No runtime at build time'));
  assert.doesNotThrow(() => generator.build(request));
  assert.equal(readFileSync(disk.outputPath, 'utf8'), first);
  const help = await runCli(['agent', 'run', '--help'], disk.outputPath, {});
  assert.equal(help.exitCode, 0);
  assert.ok(help.stdout.includes('fixture-worker'));
  assert.equal(loads, 0);
  assert.deepEqual(readdirSync(disk.directory).sort(), ['catalog.json', 'conf']);
});

for (const failure of ['schema', 'reference', 'binding', 'json'] as const) {
  test(`CFC123.S38.${failure} failed build preserves the previous bytes and removes temporary files`, t => {
    const source = fixture();
    const disk = diskFixture(t, source);
    const previous = Buffer.from('previous artifact bytes\n');
    writeFileSync(disk.outputPath, previous);
    let registry = bindings();
    let expected = 'raf-constants.json';
    if (failure === 'schema') source.constants.commands[0].description = '';
    if (failure === 'reference') source.constants.commands[0].valueSources!.type = 'models.json#/missing';
    if (failure === 'binding') { registry = registry.slice(1); expected = 'agent run'; }
    writeSources(disk.confDirectory, source);
    if (failure === 'json') writeFileSync(join(disk.confDirectory, 'raf-constants.json'), '{');
    assert.throws(() => new CatalogGenerator().build({ ...disk, bindings: registry }), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(expected), `Build must identify ${expected}: ${error.message}`);
      return true;
    });
    assert.deepEqual(readFileSync(disk.outputPath), previous);
    assert.deepEqual(readdirSync(disk.directory).sort(), ['catalog.json', 'conf']);
  });
}

test('CFC123.S39 source changes remain invisible to parser and help until a successful rebuild', async t => {
  const source = fixture();
  const disk = diskFixture(t, source);
  const request = { ...disk, bindings: bindings() };
  const generator = new CatalogGenerator();
  assert.doesNotThrow(() => generator.build(request));
  source.constants.agentTypes[1].id = 'replacement-worker';
  source.constants.commands[0].examples = ['raf agent run --type replacement-worker'];
  writeSources(disk.confDirectory, source);
  const handlers = { 'agent run': async (params: Record<string, unknown>) => params };
  assert.equal((await runCli(['agent', 'run', '--type', 'fixture-worker'], disk.outputPath, handlers)).exitCode, 0);
  assert.notEqual((await runCli(['agent', 'run', '--type', 'replacement-worker'], disk.outputPath, handlers)).exitCode, 0);
  const before = await runCli(['help', 'agent', 'run'], disk.outputPath, {});
  assert.ok(before.stdout.includes('fixture-worker'));
  assert.ok(!before.stdout.includes('replacement-worker'));
  assert.doesNotThrow(() => generator.build(request));
  assert.equal((await runCli(['agent', 'run', '--type', 'replacement-worker'], disk.outputPath, handlers)).exitCode, 0);
  assert.notEqual((await runCli(['agent', 'run', '--type', 'fixture-worker'], disk.outputPath, handlers)).exitCode, 0);
  assert.ok((await runCli(['help', 'agent', 'run'], disk.outputPath, {})).stdout.includes('replacement-worker'));
});
