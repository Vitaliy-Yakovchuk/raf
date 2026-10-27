import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAssignment, type AssignmentPorts } from '../src/assignment.ts';

const root = '/work/project';
const change = 'valid-change';
const item = { id: '1.1', description: 'Valid selected work', done: false };
const selections = [{ change, items: [{ id: item.id, expectedDescription: item.description }] }];
const archive = '2026-10-26-old-change';
const modes = ['nonzero', 'throw', 'invalid-json', 'malformed-changes'] as const;
type Mode = typeof modes[number];

function fixture(command: string, mode: Mode) {
  let attempts = 0;
  const state = { active: true, items: [item] };
  const ports: AssignmentPorts = {
    fs: { async readText() { throw new Error('Validation must read OpenSpec'); } },
    cli: { async exec(args, cwd) {
      assert.equal(cwd, root);
      const key = args.join(' ');
      if (key === command && ++attempts === 1) {
        if (mode === 'throw') throw new Error('Transient OpenSpec transport error');
        if (mode === 'nonzero') return { exitCode: 1, stdout: '', stderr: 'Transient OpenSpec list failure' };
        return { exitCode: 0, stdout: mode === 'invalid-json' ? '{' : '{"changes":null}', stderr: '' };
      }
      const data = key === 'list --json'
        ? { changes: state.active ? [{ name: change, completedTasks: 0, totalTasks: 1 }] : [] }
        : key === 'list --archived --json'
          ? { changes: [{ name: archive, completedTasks: 1, totalTasks: 1 }] }
          : key === `instructions apply --change ${change} --json` ? { tasks: state.items } : undefined;
      assert.ok(data, `Unexpected OpenSpec command: ${key}`);
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: '' };
    } },
  };
  return { ports, state, attempts: () => attempts };
}

for (const command of ['list --json', 'list --archived --json']) for (const mode of modes) {
  test(`assignment recovers when ${command} has one ${mode} failure`, async () => {
    const f = fixture(command, mode);
    const result = await validateAssignment({ root, selections }, f.ports);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.snapshot.changes, [{ id: change, items: [{ id: item.id, description: item.description }] }]);
    assert.deepEqual(result.snapshot.baselineArchives, [archive]);
    assert.ok(f.attempts() > 1);
  });
}

for (const missing of ['change', 'item'] as const) test(`assignment still rejects a missing ${missing} after list recovers`, async () => {
  const f = fixture('list --json', 'nonzero');
  if (missing === 'change') f.state.active = false;
  else f.state.items = [];
  const result = await validateAssignment({ root, selections }, f.ports);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'invalid-assignment');
  assert.equal(result.issues[0].change, change);
  assert.ok(f.attempts() > 1);
});
