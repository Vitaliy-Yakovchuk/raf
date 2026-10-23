import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureContext } from '../src/cli.ts';
import { parseTestRunArgs } from '../src/test-runs.ts';

const required = ['--project', 'raf', '--phase', 'red', '--group', 'add-raf-test-run/arguments'];
const selectors = [
  { option: '--files', key: 'files', other: 'only', values: ['test/first.test.ts', 'test/second.test.ts', 'test/third.test.ts'] },
  { option: '--only', key: 'only', other: 'files', values: ['test/first.test.ts::name with spaces', 'test/second.test.ts::literal [a].* (b)', 'test/third.test.ts::nested > case'] },
] as const;

for (const { option, key, other, values } of selectors) {
  test(`arguments: ${option} accepts a space-separated list without changing values`, () => {
    const argv = Object.freeze([...required, option, ...values]);
    const parsed = parseTestRunArgs(argv);
    assert.equal(parsed.project, 'raf');
    assert.equal(parsed.phase, 'red');
    assert.equal(parsed.group, 'add-raf-test-run/arguments');
    assert.deepEqual(parsed[key], [...values]);
    assert.equal(parsed[other], undefined);
    assert.deepEqual(argv, [...required, option, ...values]);
  });

  test(`arguments: repeated ${option} selects exactly the same values as one list`, () => {
    const argv = Object.freeze([...required, ...values.flatMap(value => [option, value])]);
    const parsed = parseTestRunArgs(argv);
    assert.deepEqual(parsed[key], [...values]);
    assert.deepEqual(parsed, parseTestRunArgs([...required, option, ...values]));
    assert.deepEqual(argv, [...required, ...values.flatMap(value => [option, value])]);
  });

  test(`arguments: ${option} combines repeated flags and lists in encounter order`, () => {
    const parsed = parseTestRunArgs([...required, option, values[0], values[1], option, values[2]]);
    assert.deepEqual(parsed[key], [...values]);
    assert.deepEqual(parsed, parseTestRunArgs([...required, option, ...values]));
  });

  test(`arguments: ${option} can repeat across intervening singleton options`, () => {
    const parsed = parseTestRunArgs([
      option, values[0], '--project', 'raf',
      option, values[1], '--phase', 'red',
      option, values[2], '--group', 'add-raf-test-run/arguments',
    ]);
    assert.deepEqual(parsed[key], [...values]);
    assert.deepEqual(parsed, parseTestRunArgs([...required, option, ...values]));
  });

  for (const argv of [
    [...required, option, values[0], option],
    [...required, option, option, values[0]],
  ]) {
    test(`arguments: each ${option} occurrence requires a value (${argv.at(-1) === option ? 'trailing' : 'leading'} empty occurrence)`, () => {
      assert.throws(() => parseTestRunArgs(argv));
    });
  }
}

for (const { option, first, second } of [
  { option: '--project', first: 'raf', second: 'another-project' },
  { option: '--phase', first: 'red', second: 'qa' },
  { option: '--group', first: 'add-raf-test-run/arguments', second: 'add-raf-test-run/another-group' },
]) {
  for (const value of [first, second]) {
    test(`arguments: duplicate singleton ${option} is refused even with ${value === first ? 'the same' : 'a different'} value and explains valid syntax`, () => {
      assert.throws(() => parseTestRunArgs([...required, '--files', 'test/first.test.ts', option, value]), error => {
        assert.ok(error instanceof Error);
        const context = failureContext(error);
        const properties = Object.fromEntries(Object.getOwnPropertyNames(error)
          .filter(name => name !== 'stack')
          .map(name => [name, Reflect.get(error, name)]));
        assert.equal(Reflect.get(error, 'code') ?? context?.code, 'DUPLICATE_ARGUMENT');
        const diagnostic = JSON.stringify({ message: error.message, properties, context });
        assert.ok(diagnostic.includes(option), `refusal must name the duplicate ${option}`);
        assert.match(diagnostic, /--project\s+[^\s"]+/u, 'guidance must show the required project value');
        assert.match(diagnostic, /--phase\s+[^\s"]+/u, 'guidance must show the required phase value');
        assert.match(diagnostic, /--group\s+[^\s"]+/u, 'guidance must show the required stable group value');
        assert.match(diagnostic, /--files\s+[^\s"]+/u, 'guidance must show the accepted files syntax');
        assert.match(diagnostic, /--only\s+[^\s"]+/u, 'guidance must show the accepted knownRed IDs syntax');
        return true;
      });
    });
  }
}

test('arguments: accepting repeated selectors does not permit mixing files and only', () => {
  assert.throws(() => parseTestRunArgs([
    ...required,
    '--files', 'test/first.test.ts', '--files', 'test/second.test.ts',
    '--only', 'test/first.test.ts::first', '--only', 'test/second.test.ts::second',
  ]));
});
