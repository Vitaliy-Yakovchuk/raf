import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';

const constants = JSON.parse(readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
const handlers = Object.fromEntries(constants.commands.map((c: { path: string[] }) => [c.path.join(' '), (params: unknown) => params]));
const production = compileCatalog(constants, models, Object.keys(handlers), JSON.parse(readFileSync(new URL('../../conf/projects.json', import.meta.url), 'utf8')));

test('production public API: all command help variants agree without handlers', async () => {
  for (const command of production.commands) {
    const help = await execute(['help', ...command.path], production, {});
    assert.equal(help.exitCode, 0);
    assert.deepEqual(await execute([...command.path, '--help'], production, {}), help);
  }
});

test('production public API: required scalar and multi-value parameters preserve catalog and free-text values', async () => {
  const freeText: Record<string, string> = {
    id: 'qa-smoke', project: 'raf', features: 'cli-catalog',
    tasks: 'complete-raf-flow-contracts:1.1', to: 'qa-smoke',
    notify: 'qa-smoke',
    text: 'Перевірити довідку CLI', at: '2026-10-21T12:00:00Z',
    'event-id': 'qa-smoke', 'event-action': 'activate',
    reason: 'Перевірку завершено', 'created-for': 'qa-smoke',
    file: '/synthetic/qa-secrets-source.json',
  };
  for (const command of production.commands.filter(c => c.parameters.length)) {
    const required = command.parameters.filter(p => p.required);
    if (required.length) assert.equal(JSON.parse((await execute(command.path, production, handlers)).stderr).code, 'MISSING_REQUIRED');
    const inputs = command.parameters.map(p => {
      const value = p.values
        ? p.values.find(v => !(command.handlerName === 'agent run' && p.name === 'type' && v.launchableByRaf === false))?.id
        : freeText[p.name];
      assert.equal(typeof value, 'string', `Missing valid smoke input: ${command.handlerName} ${p.option}`);
      return { parameter: p, value: value! };
    });
    const args = inputs.flatMap(({ parameter, value }) => [parameter.option, value]);
    const result = await execute([...command.path, ...args], production, handlers);
    assert.equal(result.exitCode, 0, result.stderr);
    for (const { parameter, value } of inputs) assert.deepEqual(JSON.parse(result.stdout)[parameter.name], parameter.multiple ? [value] : value);
    if (command.handlerName === 'agent run') {
      const blockedArgs = inputs.flatMap(({ parameter, value }) => [parameter.option, parameter.name === 'type' ? 'main' : value]);
      const blocked = await execute([...command.path, ...blockedArgs], production, handlers);
      assert.equal(blocked.exitCode, 1);
      assert.equal(JSON.parse(blocked.stderr).code, 'TYPE_NOT_LAUNCHABLE');
    }
  }
});

function fixture(defaultType: string) {
  const data = { agentTypes: [{ id: 'main', launchableByRaf: false }, { id: 'qa-worker', launchableByRaf: true }], commands: [{ path: ['agent', 'run'], parameters: [{ name: 'type', option: '--type', required: true, default: defaultType }], valueSources: { type: 'raf-constants.json#/agentTypes' } }] };
  return compileCatalog(data, {}, ['agent run']);
}

test('default type cannot bypass the same launchability restriction as explicit type', async () => {
  let called = false;
  const registry = { 'agent run': () => { called = true; } };
  const catalog = fixture('main');
  const explicit = await execute(['agent', 'run', '--type', 'main'], catalog, registry);
  const implicit = await execute(['agent', 'run'], catalog, registry);
  assert.equal(implicit.exitCode, 1);
  assert.equal(JSON.parse(implicit.stderr).code, JSON.parse(explicit.stderr).code);
  assert.equal(called, false);
});

test('invalid enum diagnostic provides a concrete corrected invocation', async () => {
  const result = await execute(['agent', 'run', '--type', 'mistyped'], fixture('qa-worker'), {});
  const error = JSON.parse(result.stderr);
  assert.match(JSON.stringify(error), /raf agent run --type qa-worker/);
});

test('handler failures and unknown arguments never echo secrets or private prompt', async () => {
  const secret = 'qa-private-token-123';
  const catalog = fixture('qa-worker');
  for (const args of [[], ['--api-key=' + secret], [secret]]) {
    const result = await execute(['agent', 'run', ...args], catalog, { 'agent run': () => { throw new Error(secret); } });
    assert.equal(result.exitCode, 1);
    assert.ok(!result.stderr.includes(secret));
    assert.ok(!result.stdout.includes(secret));
  }
});
