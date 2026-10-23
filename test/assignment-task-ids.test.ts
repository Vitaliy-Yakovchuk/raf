import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readAssignmentTasks, validateAssignment, type AssignmentPorts } from '../src/assignment.ts';

const { unitTests: { timeoutMs } } = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);

type Row = { id?: string; description: string; done?: boolean; indent?: string; section?: string };
type Source = { rows: Row[]; failure?: 'exit' | 'json' | 'shape' | 'throw' };
type Result = Awaited<ReturnType<typeof validateAssignment>>;

function fixture(sources: Record<string, Source>): {
  root: string;
  ports: AssignmentPorts;
  calls: string[][];
} {
  const root = '/virtual/raf-z91';
  const calls: string[][] = [];
  const reply = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });
  const ports: AssignmentPorts = {
    cli: {
      async exec(args, cwd) {
        assert.equal(cwd, root);
        calls.push([...args]);
        if (JSON.stringify(args) === JSON.stringify(['list', '--json'])) {
          return reply({ changes: Object.entries(sources).map(([name, source]) => ({ name, completedTasks: source.rows.filter(row => row.done).length, totalTasks: source.rows.length })) });
        }
        if (JSON.stringify(args) === JSON.stringify(['list', '--archived', '--json'])) {
          return reply({ changes: [] });
        }
        assert.equal(args.length, 5);
        assert.deepEqual([args[0], args[1], args[2], args[4]], ['instructions', 'apply', '--change', '--json']);
        const source = sources[args[3]];
        assert.ok(source, `Unexpected change: ${args[3]}`);
        if (source.failure === 'exit') return { exitCode: 1, stdout: '', stderr: 'OpenSpec fixture read failed' };
        if (source.failure === 'json') return { exitCode: 0, stdout: '{broken-json', stderr: '' };
        if (source.failure === 'shape') return reply({ tasks: null });
        if (source.failure === 'throw') throw new Error('OpenSpec fixture transport unavailable');
        return reply({ tasks: source.rows.map((row, index) => ({
          id: String(index + 1),
          description: row.id === undefined ? row.description : `${row.id} ${row.description}`,
          done: row.done ?? false,
        })) });
      },
    },
    fs: {
      async readText(path) {
        for (const [change, source] of Object.entries(sources)) {
          if (path !== join(root, 'openspec', 'changes', change, 'tasks.md')) continue;
          return source.rows.map(row => [
            row.section ? `## ${row.section}\n` : '',
            `${row.indent ?? ''}- [${row.done ? 'x' : ' '}] ${row.id === undefined ? '' : `${row.id} `}${row.description}`,
          ].filter(Boolean).join('\n')).join('\n');
        }
        throw new Error(`Unexpected fixture read: ${path}`);
      },
    },
  };
  return { root, ports, calls };
}

function selections(change: string, ids: string[]): { change: string; items: { id: string }[] }[] {
  return [{ change, items: ids.map(id => ({ id })) }];
}

function accepted(result: Result): Extract<Result, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) assert.fail('Expected a valid assignment');
  return result;
}

function refused(result: Result, kind: 'invalid-assignment' | 'openspec-unavailable' = 'invalid-assignment'): Extract<Result, { ok: false }> {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) assert.fail('Invalid input must not produce a partial assignment snapshot');
  assert.equal(result.kind, kind);
  assert.ok(result.issues.length > 0);
  return result;
}

function diagnostic(result: Result, change: string, requested: string, found: { id: string; description: string; done: boolean }[]): string {
  const error = refused(result);
  const issue = error.issues.find(issue => issue.change === change && issue.requestedItems.includes(requested));
  assert.ok(issue, JSON.stringify(error));
  assert.ok(issue.reason.trim());
  assert.ok(issue.remedy.trim());
  for (const item of found) assert.ok(issue.foundItems.some(actual =>
    actual.id === item.id && actual.description === item.description && actual.done === item.done,
  ), `Missing full found ID, description or checkbox state: ${JSON.stringify(item)} in ${JSON.stringify(issue)}`);
  return issue.reason;
}

const ids = ['1', '4.6', '4.6.1', 'A.1', 'Z.3.2', 'Z.3.2.10.4.6', '4.6.1.8.2.9'];

test('[Z.91] full explicit numeric and letter IDs replace positional OpenSpec IDs', { timeout: timeoutMs }, async () => {
  const rows = ids.map(id => ({ id, description: `Опис ${id}` }));
  const f = fixture({ 'deep-change': { rows } });
  assert.deepEqual(await readAssignmentTasks(f.root, 'deep-change', f.ports), rows.map(row => ({ ...row, done: false })));
  const result = accepted(await validateAssignment({ root: f.root, selections: selections('deep-change', ids) }, f.ports));
  assert.deepEqual(result.snapshot.changes, [{
    id: 'deep-change', items: rows.map(({ id, description }) => ({ id, description })),
  }]);
});

for (const indent of ['', '  ', '    ', '\t']) {
  test(`[Z.91] indentation ${JSON.stringify(indent)} does not change an explicit checkbox address`, { timeout: timeoutMs }, async () => {
    const f = fixture({ 'nested-change': { rows: [
      { id: 'Z.3', description: 'Батьківський пункт', section: '7. Unrelated heading' },
      { id: 'Z.3.2', description: 'Вкладений пункт', indent },
    ] } });
    const result = accepted(await validateAssignment({ root: f.root, selections: selections('nested-change', ['Z.3.2']) }, f.ports));
    assert.deepEqual(result.snapshot.changes, [{ id: 'nested-change', items: [{ id: 'Z.3.2', description: 'Вкладений пункт' }] }]);
  });
}

for (const done of [false, true]) {
  test(`[Z.91] readAssignmentTasks preserves the ID with checkbox done=${done}`, { timeout: timeoutMs }, async () => {
    const f = fixture({ 'checkbox-change': { rows: [{ id: 'Z.3.2', description: 'Опис пункту', done, indent: '  ' }] } });
    assert.deepEqual(await readAssignmentTasks(f.root, 'checkbox-change', f.ports), [{ id: 'Z.3.2', description: 'Опис пункту', done }]);
  });
}

test('[Z.91] selecting a parent selects only that exact checkbox', { timeout: timeoutMs }, async () => {
  const f = fixture({ 'parent-change': { rows: [
    { id: 'Z.3', description: 'Батьківський пункт' },
    { id: 'Z.3.2', description: 'Дочірній пункт', indent: '  ' },
    { id: 'Z.30', description: 'Схожий номер' },
  ] } });
  const result = accepted(await validateAssignment({ root: f.root, selections: selections('parent-change', ['Z.3']) }, f.ports));
  assert.deepEqual(result.snapshot.changes, [{ id: 'parent-change', items: [{ id: 'Z.3', description: 'Батьківський пункт' }] }]);
});

for (const requested of ['Z.3', 'Z.3.9', 'Z.03.2', '1']) {
  test(`[Z.91] ${requested} cannot alias a child, similar ID, normalized segment or OpenSpec position`, { timeout: timeoutMs }, async () => {
    const found = [
      { id: 'Z.3.2', description: 'Вкладений пункт', done: false },
      { id: 'Z.3.20', description: 'Інший схожий пункт', done: true },
    ];
    const f = fixture({ 'exact-change': { rows: found } });
    const result = await validateAssignment({ root: f.root, selections: selections('exact-change', [requested]) }, f.ports);
    const reason = diagnostic(result, 'exact-change', requested, found);
    assert.match(reason, /missing|not found|absent|відсут|не знайден/i);
  });
}

test('[Z.91] leading zero segments remain distinct when both exact IDs exist', { timeout: timeoutMs }, async () => {
  const f = fixture({ 'literal-change': { rows: [
    { id: 'Z.3.2', description: 'Звичайний сегмент' },
    { id: 'Z.03.2', description: 'Сегмент із нулем' },
  ] } });
  const result = accepted(await validateAssignment({ root: f.root, selections: selections('literal-change', ['Z.03.2']) }, f.ports));
  assert.deepEqual(result.snapshot.changes, [{ id: 'literal-change', items: [{ id: 'Z.03.2', description: 'Сегмент із нулем' }] }]);
});

for (const requested of ['Z..3', 'Z.3.', 'z.3.2', 'Z', 'AB.1', '4..6', '4.6.1.', 'Z.3.2suffix']) {
  test(`[Z.91] malformed request ${requested} is rejected with a format diagnostic`, { timeout: timeoutMs }, async () => {
    const found = [
      { id: 'Z.3.2', description: 'Літерний пункт', done: false },
      { id: '4.6.1', description: 'Числовий пункт', done: false },
    ];
    const f = fixture({ 'format-change': { rows: found } });
    const result = await validateAssignment({ root: f.root, selections: selections('format-change', [requested]) }, f.ports);
    const reason = diagnostic(result, 'format-change', requested, found);
    assert.match(reason, /format|syntax|формат|синтакс|некорект/i);
  });
}

for (const secondDone of [false, true]) {
  test(`[Z.91] duplicate IDs across sections and depths are ambiguous even with done=${secondDone}`, { timeout: timeoutMs }, async () => {
    const found = [
      { id: 'Z.3.2', description: 'Перший збіг', done: false },
      { id: 'Z.3.2', description: 'Другий збіг', done: secondDone },
    ];
    const f = fixture({ 'duplicate-change': { rows: [
      { ...found[0], section: '1. First section' },
      { ...found[1], section: '2. Second section', indent: '    ' },
    ] } });
    const reason = diagnostic(await validateAssignment({ root: f.root, selections: selections('duplicate-change', ['Z.3.2']) }, f.ports), 'duplicate-change', 'Z.3.2', found);
    assert.match(reason, /ambig|duplic|неоднознач|дубл/i);
  });
}

test('[Z.91] the change name scopes uniqueness and identical IDs in two changes can both be assigned', { timeout: timeoutMs }, async () => {
  const f = fixture({
    'first-change': { rows: [{ id: 'Z.3.2', description: 'Перший опис' }] },
    'second-change': { rows: [{ id: 'Z.3.2', description: 'Другий опис' }] },
  });
  const selected = accepted(await validateAssignment({ root: f.root, selections: selections('second-change', ['Z.3.2']) }, f.ports));
  assert.deepEqual(selected.snapshot.changes, [{ id: 'second-change', items: [{ id: 'Z.3.2', description: 'Другий опис' }] }]);
  const both = accepted(await validateAssignment({ root: f.root, selections: [
    ...selections('first-change', ['Z.3.2']), ...selections('second-change', ['Z.3.2']),
  ] }, f.ports));
  assert.deepEqual(both.snapshot.changes, [
    { id: 'first-change', items: [{ id: 'Z.3.2', description: 'Перший опис' }] },
    { id: 'second-change', items: [{ id: 'Z.3.2', description: 'Другий опис' }] },
  ]);
});

test('[Z.91] an unnumbered checkbox keeps its OpenSpec ID without a heading or parent prefix', { timeout: timeoutMs }, async () => {
  const f = fixture({ 'unnumbered-change': { rows: [{ description: 'Пункт без номера', section: 'Z.3 Other heading', indent: '  ' }] } });
  assert.deepEqual(await readAssignmentTasks(f.root, 'unnumbered-change', f.ports), [{ id: '1', description: 'Пункт без номера', done: false }]);
  const result = accepted(await validateAssignment({ root: f.root, selections: selections('unnumbered-change', ['1']) }, f.ports));
  assert.deepEqual(result.snapshot.changes, [{ id: 'unnumbered-change', items: [{ id: '1', description: 'Пункт без номера' }] }]);
});

test('[Z.91] one invalid selection refuses the entire assignment without a partial snapshot', { timeout: timeoutMs }, async () => {
  const f = fixture({
    'valid-change': { rows: [{ id: 'A.1', description: 'Коректний пункт' }] },
    'invalid-change': { rows: [{ id: 'Z.3.2', description: 'Наявний пункт' }] },
  });
  const result = await validateAssignment({ root: f.root, selections: [
    ...selections('valid-change', ['A.1']), ...selections('invalid-change', ['Z.3.9']),
  ] }, f.ports);
  refused(result);
  assert.equal('snapshot' in result, false);
  diagnostic(result, 'invalid-change', 'Z.3.9', [{ id: 'Z.3.2', description: 'Наявний пункт', done: false }]);
});

for (const failure of ['exit', 'json', 'shape', 'throw'] as const) {
  test(`[Z.91] OpenSpec ${failure} failure is unavailable, never a missing ID`, { timeout: timeoutMs }, async () => {
    const f = fixture({ 'unreadable-change': { rows: [{ id: 'Z.3.2', description: 'Пункт' }], failure } });
    const result = refused(await validateAssignment({ root: f.root, selections: selections('unreadable-change', ['Z.3.2']) }, f.ports), 'openspec-unavailable');
    assert.equal('snapshot' in result, false);
    assert.ok(result.issues.some(issue => issue.change === 'unreadable-change' && issue.reason.trim() && issue.remedy.trim()));
    assert.ok(f.calls.every(args => args[0] === 'list' || args[0] === 'instructions'));
  });
}
