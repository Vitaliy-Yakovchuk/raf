import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCatalog } from '../src/catalog.ts';
import { execute } from '../src/cli.ts';
import { commandFailure } from '../src/cli-contract.ts';
import type { CommandFailureContext } from '../src/cli-contract.ts';




function fixture() {
  return {
    version: 1,
    modes: [{ id: 'safe', description: 'Only validated operations' },
      { id: 'fast', description: 'Use accelerated operations' }],
    commands: [{
      path: ['sample', 'apply'], description: 'Apply a sample operation',
      parameters: [
        { name: 'target', option: '--target', required: true, multiple: false, description: 'Destination identifier' },
        { name: 'mode', option: '--mode', required: false, multiple: false, default: 'safe', description: 'Execution policy' },
        { name: 'labels', option: '--labels', required: false, multiple: true, default: ['one', 'two'], description: 'Labels to attach' },
      ],
      valueSources: { mode: 'raf-constants.json#/modes' },
      examples: ['raf sample apply --target demo --mode safe'],
      prerequisites: 'Destination must already exist',
      sideEffects: 'Writes the destination record',
      output: 'JSON with the updated destination',
      errors: 'JSON with code, message, details and remediation',
    }],
    reportStatuses: [],
  };
}
const models = { version: 1, runners: [], models: [], routing: { complexityOrder: [] } };
function catalog() { return compileCatalog(fixture(), models, ['sample apply']); }
function diagnostic(result: {exitCode: number; stdout: string; stderr: string}) {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(typeof error.code, 'string');
  assert.ok(error.code.length > 0);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.equal(error.details.command, 'sample apply');
  assert.equal(typeof error.details.stage, 'string');
  assert.ok(error.details.stage.length > 0);
  assert.match(JSON.stringify(error.remediation), /raf help sample apply/);
  return error;
}
function failure(overrides: Partial<CommandFailureContext> = {}): CommandFailureContext {
  return {
    code: 'DESTINATION_WRITE_FAILED', message: 'Could not finish destination update',
    stage: 'persist', source: 'sqlite', sourceCode: 'SQLITE_BUSY',
    reason: 'Destination database is locked', received: { target: 'demo' },
    expected: { writable: true }, found: { locked: true },
    completed: ['Validated destination'], pending: ['Commit destination record'],
    retrySafe: true, remediation: ['Release the database lock and retry'], ...overrides,
  };
}

test('operation diagnostics preserve reported facts and partial completion', async () => {
  const context = failure();
  const result = await execute(['sample', 'apply', '--target', 'demo'], catalog(), {
    'sample apply': () => { throw commandFailure(context); },
  });
  const error = diagnostic(result);
  assert.equal(error.code, context.code);
  assert.equal(error.message, context.message);
  for (const key of ['stage', 'source', 'sourceCode', 'reason', 'received', 'expected', 'found', 'completed', 'pending', 'retrySafe'] as const) {
    assert.deepEqual(error.details[key], context[key], key);
  }
  assert.ok(error.remediation.includes(context.remediation[0]));
});

for (const source of ['tmux', 'runner', 'openspec', 'filesystem', 'sqlite']) {
test(`${source}: unsafe retry and unknown external exit code remain distinct from success`, async () => {
  const context = failure({ source, sourceCode: null, reason: null,
    completed: ['Created session'], pending: ['Confirm runner startup'], retrySafe: false });
  const error = diagnostic(await execute(['sample', 'apply', '--target', 'demo'], catalog(), {
    'sample apply': async () => { throw commandFailure(context); },
  }));
  assert.equal(error.details.source, source);
  assert.equal(error.details.sourceCode, null);
  assert.equal(error.details.reason, null);
  assert.equal(error.details.retrySafe, false);
  assert.deepEqual(error.details.completed, ['Created session']);
  assert.deepEqual(error.details.pending, ['Confirm runner startup']);
});
}

test('diagnostics redact explicitly supplied secrets recursively in all fields', async () => {
  const secret = 'secret-value-do-not-disclose-178';
  const context = failure({ message: `Failure ${secret}`, reason: `Token ${secret}`,
    received: { nested: [{ value: secret }] }, expected: [secret], found: { secret },
    completed: [`Connect with ${secret}`], pending: [secret],
    remediation: [`Replace ${secret}`], secrets: [secret] });
  const result = await execute(['sample', 'apply', '--target', 'demo'], catalog(), {
    'sample apply': () => { throw commandFailure(context); },
  });
  diagnostic(result);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('unclassified throws do not invent cause or operation state and do not expose raw credentials', async () => {
  for (const thrown of [new Error('token=private-token-178 password=private-password-179'),
    { message: 'private-password-179', token: 'private-token-178' }, null]) {
    const result = await execute(['sample', 'apply', '--target', 'demo'], catalog(), {
      'sample apply': () => { throw thrown; },
    });
    const error = diagnostic(result);
    for (const key of ['reason', 'found', 'completed', 'pending', 'retrySafe']) {
      assert.equal(error.details[key], null, `${key} must remain unknown`);
    }
    assert.ok(!JSON.stringify(result).includes('private-token-178'));
    assert.ok(!JSON.stringify(result).includes('private-password-179'));
  }
});

test('invalid input diagnostics retain parameter context without dispatching', async () => {
  let calls = 0;
  const error = diagnostic(await execute(['sample', 'apply', '--target', 'demo', '--mode', 'unsupported'], catalog(), {
    'sample apply': () => { calls++; },
  }));
  assert.equal(calls, 0);
  assert.match(JSON.stringify(error.details), /mode/);
  assert.match(JSON.stringify(error.details), /unsupported/);
  assert.match(JSON.stringify(error.details), /safe/);
  assert.match(JSON.stringify(error.details), /fast/);
  assert.deepEqual(error.details.completed, []);
  assert.equal(error.details.retrySafe, true);
});

test('invalid-input diagnostics redact credential-shaped values before rendering', async () => {
  let calls = 0;
  const result = await execute(['sample', 'apply', '--target', 'demo', '--mode', 'token=private-input-178'], catalog(), {
    'sample apply': () => { calls++; },
  });
  diagnostic(result);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(result).includes('private-input-178'));
});

test('undeclared prototype-shaped options cannot reach a handler', async () => {
  let calls = 0;
  for (const option of ['--__proto__', '--constructor', '--toString']) {
    const result = await execute(['sample', 'apply', '--target', 'demo', option, 'polluted'], catalog(), {
      'sample apply': () => { calls++; },
    });
    assert.notEqual(result.exitCode, 0, option);
    JSON.parse(result.stderr);
  }
  assert.equal(calls, 0);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('parameter help includes individual descriptions, requiredness, defaults and multiplicity', async () => {
  const result = await execute(['help', 'sample', 'apply'], catalog(), {});
  assert.equal(result.exitCode, 0);
  const text = result.stdout;
  for (const parameter of fixture().commands[0].parameters) {
    const at = text.indexOf(parameter.option);
    assert.notEqual(at, -1);

    const descriptionAt = text.indexOf(parameter.description);
    assert.notEqual(descriptionAt, -1);
  }
  assert.match(text, /required|обов[’']?язков/i);
  assert.match(text, /optional|необов[’']?язков/i);
  assert.match(text, /default|за замовчуванням/i);
  assert.match(text, /multiple|repeat|кілька|повтор|множин/i);
  assert.match(text, /one/);
  assert.match(text, /two/);
  for (const value of fixture().modes) assert.ok(text.includes(value.description));
  for (const field of ['prerequisites', 'sideEffects', 'output', 'errors'] as const) {
    assert.ok(text.includes(fixture().commands[0][field]), field);
  }
  assert.ok(text.includes(fixture().commands[0].examples[0]));
});

test('declared scalar and list defaults reach handler with the documented shapes', async () => {
  let received: Record<string, unknown> | undefined;
  const result = await execute(['sample', 'apply', '--target', 'demo'], catalog(), {
    'sample apply': params => { received = params; return { ok: true }; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(received?.mode, 'safe');
  assert.deepEqual(received?.labels, ['one', 'two']);
});



const schemaCases: Array<[string, (input: ReturnType<typeof fixture>) => void, RegExp]> = [
  ['duplicate parameter name', f => { f.commands[0].parameters.push({ ...f.commands[0].parameters[0], option: '--destination' }); }, /target/],
  ['duplicate option', f => { f.commands[0].parameters[1].option = '--target'; }, /target/],
  ['non-array parameters', f => { (f.commands[0] as any).parameters = {}; }, /parameters/],
  ['invalid boolean declaration', f => { (f.commands[0].parameters[0] as any).required = 'false'; }, /target|required/],
  ['default outside enum', f => { f.commands[0].parameters[1].default = 'unsupported'; }, /mode|default/],
  ['array default for scalar', f => { f.commands[0].parameters[1].default = ['safe']; }, /mode|default/],
  ['scalar default for list', f => { f.commands[0].parameters[2].default = 'one'; }, /labels|default/],
  ['duplicate source value ID', f => { f.modes.push({ id: 'safe', description: 'Ambiguous second meaning' }); }, /modes|safe/],
  ['non-string source ID', f => { (f.modes[0] as any).id = 7; }, /modes|id/],
];
for (const [name, mutate, context] of schemaCases) {
  test(`schema rejects ${name} with concrete source`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => compileCatalog(input, models, ['sample apply']), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /raf-constants\.json/);
      assert.match(error.message, context);
      return true;
    });
  });
}
