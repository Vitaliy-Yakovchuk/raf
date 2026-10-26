import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import type { ExecutionResult, Handler } from '../src/cli.ts';
import { readFileSync } from 'node:fs';


function fixture() {
  return {
    constants: {
      agentTypes: [
        { id: 'main', description: 'Accounted coordinator', launchableByRaf: false },
        { id: 'fixture-worker', description: 'Fixture worker', launchableByRaf: true },
      ],
      reportStatuses: [{ id: 'fixture-done', description: 'Fixture report completed' }],
      commands: [
        {
          path: ['agent', 'run'], description: 'Launch a fixture agent',
          parameters: [
            { name: 'type', option: '--type', required: true, description: 'Agent type' },
            { name: 'phase', option: '--phase', description: 'Current phase' },
            { name: 'complexity', option: '--complexity', default: 'fixture-light' },
            { name: 'prompt', option: '--prompt', description: 'Task text' },
          ],
          valueSources: {
            type: 'raf-constants.json#/agentTypes',
            phase: 'raf-constants.json#/agentTypes',
            complexity: 'models.json#/routing/complexityOrder',
          },
          examples: ['raf agent run --type fixture-worker'],
          prerequisites: ['Fixture prerequisite'],
          sideEffects: ['Fixture side effect'],
          output: 'Fixture output format',
          errors: 'Fixture remediation description',
        },
        {
          path: ['runner', 'inspect'], description: 'Inspect a fixture runner',
          parameters: [{ name: 'runner', option: '--runner', required: true }],
          valueSources: { runner: 'models.json#/runners' },
        },
        { path: ['service', 'status'] },
        { path: ['help'], description: 'Catalog help' },
      ],
    },
    models: {
      runners: [{ id: 'fixture-runner', initialEnabled: false }],
      routing: { complexityOrder: ['fixture-light', 'fixture-deep'] },
    },
  };
}

function setup(data = fixture()) {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  const handlers: Record<string, Handler> = Object.fromEntries(
    ['agent run', 'runner inspect', 'service status'].map(name => [name, async (params) => {
      calls.push({ name, params });
      return { ok: true };
    }]),
  );
  const catalog = compileCatalog(data.constants, data.models, Object.keys(handlers));
  return { calls, handlers, catalog };
}

function diagnostic(result: ExecutionResult) {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(typeof error.code, 'string');
  assert.ok(error.code.length > 0);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.ok(error.details && typeof error.details === 'object');
  assert.ok(error.remediation);
  assert.match(JSON.stringify(error.remediation), /help/);
  return error;
}

test('ARA 2.1 run uses every approved launchable type from agentTypes, without a command-local list', async () => {
  const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
  const projects = JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8'));
  const handlers = Object.fromEntries(constants.commands.filter((command: { path: string[] }) => command.path.join(' ') !== 'help').map((command: { path: string[] }) => [command.path.join(' '), async (params: Record<string, unknown>) => params]));
  const catalog = compileCatalog(constants, models, Object.keys(handlers), projects);
  const args = (type: string) => ['agent', 'run', '--id', 'hotfix-xxxx', '--type', type, '--project', 'raf', '--features', 'add-raf-agent-run', '--phase', 'test-scaffold', '--complexity', models.routing.complexityOrder[0], '--tasks', 'add-raf-agent-run:2.1'];
  const launchable = constants.agentTypes.filter((entry: { launchableByRaf: boolean }) => entry.launchableByRaf);
  assert.ok(launchable.length > 0);
  for (const entry of constants.agentTypes) {
    const result = await execute(args(entry.id), catalog, handlers);
    if (entry.launchableByRaf) {
      assert.equal(result.exitCode, 0, `${entry.id}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).type, entry.id);
    } else diagnostic(result);
  }
  for (const missing of ['--id', '--type', '--project', '--phase', '--complexity', '--tasks']) {
    const argv = args(launchable[0].id);
    argv.splice(argv.indexOf(missing), 2);
    assert.match(diagnosticText(await execute(argv, catalog, handlers)), new RegExp(missing.slice(2)));
  }
  diagnostic(await execute(args('unapproved-ARA-type'), catalog, handlers));
});

function diagnosticText(result: ExecutionResult): string {
  return JSON.stringify(diagnostic(result));
}

test('help and --help agree, expose catalog metadata, and invoke no runtime handlers', async () => {
  const { catalog, handlers, calls } = setup();
  const help = await execute(['help', 'agent', 'run'], catalog, handlers);
  assert.equal(help.exitCode, 0);
  assert.equal(help.stderr, '');
  assert.deepEqual(await execute(['agent', 'run', '--help'], catalog, handlers), help);
  for (const text of [
    'Launch a fixture agent', '--type', '--phase', '--complexity', '--prompt',
    'fixture-worker', 'Fixture worker', 'main', 'Accounted coordinator',
    'fixture-light', 'fixture-deep', 'fixture-done', 'Fixture report completed',
    'raf agent run --type fixture-worker', 'Fixture prerequisite',
    'Fixture side effect', 'Fixture output format', 'Fixture remediation description',
  ]) assert.ok(help.stdout.includes(text), `Missing help text: ${text}`);
  assert.deepEqual(calls, []);

  assert.deepEqual(await execute(['help', 'agent', 'run'], catalog, {}), help);
});

test('token parsing preserves spaces, supports --option=value, defaults, and awaits only the matching handler', async () => {
  const { catalog, handlers, calls } = setup();
  const result = await execute([
    'agent', 'run', '--type=fixture-worker', '--prompt', 'a task with spaces = literal', '--phase', 'main',
  ], catalog, handlers);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(calls, [{ name: 'agent run', params: {
    type: 'fixture-worker', prompt: 'a task with spaces = literal', phase: 'main', complexity: 'fixture-light',
  } }]);
});

test('an explicit optional value overrides its default', async () => {
  const { catalog, handlers, calls } = setup();
  assert.equal((await execute(['agent', 'run', '--type', 'fixture-worker', '--complexity', 'fixture-deep'], catalog, handlers)).exitCode, 0);
  assert.equal(calls[0].params.complexity, 'fixture-deep');
});

test('a command without declared required parameters executes without invented requirements', async () => {
  const { catalog, handlers, calls } = setup();
  assert.equal((await execute(['service', 'status'], catalog, handlers)).exitCode, 0);
  assert.deepEqual(calls, [{ name: 'service status', params: {} }]);
});

test('main cannot launch but may be used as a phase', async () => {
  const { catalog, handlers, calls } = setup();
  const error = diagnostic(await execute(['agent', 'run', '--type', 'main'], catalog, handlers));
  assert.match(JSON.stringify(error.details), /main/);
  assert.deepEqual(calls, []);
  assert.equal((await execute(['agent', 'run', '--type', 'fixture-worker', '--phase', 'main'], catalog, handlers)).exitCode, 0);
  assert.equal(calls[0].params.phase, 'main');
});

test('recompilation updates parsing and help from both JSON catalogs', async () => {
  const data = fixture();
  data.constants.agentTypes[1].id = 'replacement-worker';
  data.constants.commands[0].examples = ['raf agent run --type replacement-worker'];
  data.models.routing.complexityOrder = ['replacement-complexity'];
  data.constants.commands[0].parameters![2].default = 'replacement-complexity';
  data.models.runners[0].id = 'replacement-runner';
  const { catalog, handlers, calls } = setup(data);
  const help = await execute(['agent', 'run', '--help'], catalog, handlers);
  assert.ok(help.stdout.includes('replacement-worker'));
  assert.ok(help.stdout.includes('replacement-complexity'));
  assert.ok((await execute(['runner', 'inspect', '--help'], catalog, handlers)).stdout.includes('replacement-runner'));
  assert.equal((await execute(['agent', 'run', '--type', 'replacement-worker'], catalog, handlers)).exitCode, 0);
  assert.equal((await execute(['runner', 'inspect', '--runner', 'replacement-runner'], catalog, handlers)).exitCode, 0);
  assert.equal(calls.length, 2);
  diagnostic(await execute(['agent', 'run', '--type', 'fixture-worker'], catalog, handlers));
  diagnostic(await execute(['runner', 'inspect', '--runner', 'fixture-runner'], catalog, handlers));
  assert.equal(calls.length, 2);
});

test('invalid enum diagnostics identify the argument, received value, and catalog alternatives', async () => {
  const { catalog, handlers, calls } = setup();
  const error = diagnostic(await execute(['agent', 'run', '--type', 'fixture-worker', '--complexity', 'not-a-level'], catalog, handlers));
  for (const text of ['complexity', 'not-a-level', 'fixture-light', 'fixture-deep']) {
    assert.ok(JSON.stringify(error.details).includes(text));
  }
  assert.deepEqual(calls, []);
});

for (const secretArgument of [
  ['--api-key', 'fixture-secret-never-print'],
  ['--api-key=fixture-secret-never-print'],
]) {
  test(`unknown option diagnostics omit potential secrets (${secretArgument.length} tokens)`, async () => {
    const { catalog, handlers, calls } = setup();
    const result = await execute([
      'agent', 'run', '--type', 'fixture-worker', '--prompt', 'private-task-never-print', ...secretArgument,
    ], catalog, handlers);
    const error = diagnostic(result);
    assert.ok(JSON.stringify(error).includes('--api-key'));
    assert.ok(!result.stderr.includes('fixture-secret-never-print'));
    assert.ok(!result.stderr.includes('private-task-never-print'));
    assert.deepEqual(calls, []);
  });
}

for (const argv of [
  ['unknown', 'command'], ['help', 'unknown', 'command'],
  ['agent', 'run'], ['agent', 'run', '--type'],
  ['agent', 'run', '--type', '--phase', 'main'],
  ['agent', 'run', '--type', 'fixture-worker', '--surprise', 'value'],
  ['agent', 'run', '--type', 'fixture-worker', 'unexpected-positional'],
]) {
  test(`invalid invocation has structured diagnostics and no side effects: ${argv.join(' ')}`, async () => {
    const { catalog, handlers, calls } = setup();
    diagnostic(await execute(argv, catalog, handlers));
    assert.deepEqual(calls, []);
  });
}

test('duplicate command paths fail compilation with the offending path', () => {
  const data = fixture();
  data.constants.commands.push(structuredClone(data.constants.commands[0]));
  assert.throws(() => setup(data), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /agent/);
    assert.match(error.message, /run/);
    return true;
  });
});

test('missing handlers fail compilation with the offending command', () => {
  const data = fixture();
  assert.throws(() => compileCatalog(data.constants, data.models, ['runner inspect', 'service status']), /agent.*run/);
});

for (const reference of [
  'models.json#/routing/nonexistent', 'unknown.json#/runners', 'models.json#/routing',
]) {
  test(`invalid value reference identifies the source: ${reference}`, () => {
    const data = fixture();
    data.constants.commands[0].valueSources!.complexity = reference;
    assert.throws(() => setup(data), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(reference), error.message);
      return true;
    });
  });
}
