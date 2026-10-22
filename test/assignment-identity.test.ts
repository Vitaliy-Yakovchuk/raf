import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BigIntStats } from 'node:fs';
import type { AdapterCommandExecutor } from '../src/agent-adapters.ts';
import type { AssignmentSnapshot } from '../src/assignment.ts';
import type { ReservedTaskResolution, ReservedTaskSnapshot } from '../src/task-reservations.ts';
import { readAssignmentTasks } from '../src/assignment.ts';
import { createAssignmentIdentityAdapter } from '../src/assignment-identity.ts';

type Row = { id: string; description: string; done: boolean };
const task = (description = 'Зберегти точну ідентичність', done = false): Row => ({ id: '1', description: `1.1 ${description}`, done });
const proposal = (marker: string) => `# Identity fixture\n\n## Why\n${marker}\n\n## What Changes\nInternal fixture only.\n\n## Impact\nNo product API.\n`;
const execFileAsync = promisify(execFile);

async function fixture(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'raf-assignment-identity-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'project');
  const change = 'identity-fixture';
  const dir = join(root, 'openspec', 'changes', change);
  const context = proposal('original change');
  await mkdir(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
  await mkdir(dir);
  await writeFile(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await writeFile(join(dir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-22\nskip_specs: true\n');
  await writeFile(join(dir, 'proposal.md'), context);
  await writeFile(join(dir, 'design.md'), '# Design\n\nUse immutable local directory identity.\n');
  await writeFile(join(dir, 'tasks.md'), '## 1. Identity\n\n- [ ] 1.1 Зберегти точну ідентичність\n');
  const sources = new Map<string, Row[]>([[context, [task()]]]);
  const calls: { cwd: string; args: readonly string[] }[] = [];
  let duringRead: (() => Promise<void>) | undefined;
  let sourceFailure: 'exit' | 'json' | 'shape' | 'throw' | undefined;
  const execute: AdapterCommandExecutor = async command => {
    assert.equal(command.executable, 'openspec');
    assert.equal(command.stdin, undefined);
    if (command.args.length === 1 && command.args[0] === '--version') return { exitCode: 0, stdout: '1.14.3\n', stderr: '' };
    assert.deepEqual(command.args, ['instructions', 'apply', '--change', change, '--json']);
    assert.ok(command.cwd);
    calls.push({ cwd: command.cwd, args: [...command.args] });
    if (duringRead) {
      const action = duringRead;
      duringRead = undefined;
      await action();
    }
    if (sourceFailure === 'throw') throw new Error('authoritative CLI transport unavailable');
    if (sourceFailure === 'exit') return { exitCode: 7, stdout: '', stderr: 'authoritative OpenSpec unavailable' };
    if (sourceFailure === 'json') return { exitCode: 0, stdout: '{broken', stderr: '' };
    if (sourceFailure === 'shape') return { exitCode: 0, stdout: JSON.stringify({ tasks: [{ id: '1' }] }), stderr: '' };
    const marker = await readFile(join(command.cwd, 'openspec', 'changes', change, 'proposal.md'), 'utf8');
    const rows = sources.get(marker);
    assert.ok(rows, `Unexpected source context ${marker}`);
    return { exitCode: 0, stdout: JSON.stringify({ tasks: rows }), stderr: '' };
  };
  const assignment: AssignmentSnapshot = {
    root,
    changes: [{ id: change, items: [{ id: '1.1', description: 'Зберегти точну ідентичність' }] }],
    baselineArchives: [],
  };
  return {
    home, root, change, dir, context, sources, calls, execute, assignment,
    adapter: () => createAssignmentIdentityAdapter({ raf: root }, { execute }),
    setRows(rows: Row[]) { sources.set(context, rows); },
    onRead(action: () => Promise<void>) { duringRead = action; },
    fail(mode: typeof sourceFailure) { sourceFailure = mode; },
    async archive(name = `2026-10-22-${change}`) {
      const target = join(root, 'openspec', 'changes', 'archive', name);
      await rename(dir, target);
      return target;
    },
    async reuse(done = true) {
      await mkdir(dir);
      const marker = proposal('new instance using the old name');
      await writeFile(join(dir, 'proposal.md'), marker);
      await writeFile(join(dir, 'tasks.md'), '- [x] 1.1 Зберегти точну ідентичність\n');
      sources.set(marker, [task(undefined, done)]);
    },
  };
}

async function contract(name: string, action: () => Promise<void>) {
  await assert.doesNotReject(action, name);
}

function resolved(results: readonly ReservedTaskResolution[], tasks: readonly ReservedTaskSnapshot[], state: 'open' | 'completed', location: 'active' | 'archive') {
  assert.deepEqual(results, tasks.map(task => ({ state, task, location })));
}

function refused(results: readonly ReservedTaskResolution[], requested: readonly ReservedTaskSnapshot[], state: 'mismatch' | 'unknown') {
  assert.equal(results.length, requested.length);
  for (let index = 0; index < requested.length; index++) {
    const result = results[index];
    assert.equal(result.state, state);
    assert.ok('requested' in result);
    assert.deepEqual(result.requested, requested[index]);
    assert.ok(result.reason.trim());
  }
}

for (const [name, input, expected] of [
  ['numbered CLI descriptions', [{ id: '1', description: '1.1 Exact CLI description', done: false }], [{ id: '1.1', description: 'Exact CLI description', done: false }]],
  ['native nonordinal CLI ids', [{ id: 'R.3', description: 'Implement reservations', done: true }], [{ id: 'R.3', description: 'Implement reservations', done: true }]],
] as const) {
  test(`[identity-parser] reusable reader preserves ${name}`, async () => {
    await contract('Existing authoritative CLI parser is reused', async () => {
      const calls: unknown[] = [];
      const rows = await readAssignmentTasks('/explicit/root', 'fixture', {
        cli: { async exec(args, cwd) { calls.push({ args, cwd }); return { exitCode: 0, stdout: JSON.stringify({ tasks: input }), stderr: '' }; } },
        fs: { async readText() { assert.fail('CLI task reader must not parse tasks.md'); } },
      });
      assert.deepEqual(rows, expected);
      assert.deepEqual(calls, [{ args: ['instructions', 'apply', '--change', 'fixture', '--json'], cwd: '/explicit/root' }]);
    });
  });
}

test('[identity-fs] capture uses canonical project, exact assignment and immutable snapshots', async t => {
  const f = await fixture(t);
  await contract('Capture produces immutable task reservation snapshots', async () => {
    const adapter = f.adapter();
    const result = await adapter.capture('raf', f.assignment);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].key, { project: 'raf', changeId: f.change, taskId: '1.1' });
    assert.ok(result[0].changeInstance);
    assert.ok(result[0].fingerprint);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result[0]));
    assert.ok(Object.isFrozen(result[0].key));
    const source = await lstat(f.dir, { bigint: true });
    assert.deepEqual(JSON.parse(result[0].changeInstance), ['raf-local-change-v1', f.root, String(source.dev), String(source.ino), String(source.birthtimeNs)]);
    assert.match(result[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(result[0].fingerprint, createHash('sha256').update(JSON.stringify([
      'raf-task-fingerprint-v1', 'raf', f.root, f.change, result[0].changeInstance,
      f.assignment.changes[0].items[0].id, f.assignment.changes[0].items[0].description,
    ])).digest('hex'));
    assert.equal(f.calls.length, 1);
    resolved(await adapter.resolveTasks(result), result, 'open', 'active');
    assert.deepEqual(await f.adapter().capture('raf', structuredClone(f.assignment)), result);
  });
});

test('[identity-fs] authoritative CLI rows win over contradictory raw markdown', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'tasks.md'), '- [x] 9.9 Markdown decoy must not become source authority\n');
  await contract('Only the existing CLI parser supplies task id, description and done', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', f.assignment);
    assert.equal(captured[0].key.taskId, '1.1');
    resolved(await adapter.resolveTasks(captured), captured, 'open', 'active');
    f.setRows([task(undefined, true)]);
    resolved(await adapter.resolveTasks(captured), captured, 'completed', 'active');
  });
});

test('[identity-fs] checkbox and unrelated task edits preserve original fingerprint', async t => {
  const f = await fixture(t);
  await contract('Mutable completion and other task rows do not alter the assigned task identity', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', f.assignment);
    await writeFile(join(f.dir, 'tasks.md'), '- [x] 1.1 Зберегти точну ідентичність\n- [ ] 1.2 A newly added unrelated item\n');
    f.setRows([task(undefined, true), { id: '2', description: '1.2 A newly added unrelated item', done: false }]);
    resolved(await adapter.resolveTasks(captured), captured, 'completed', 'active');
    f.setRows([task(), { id: '2', description: '1.2 Unrelated revised text', done: true }]);
    const again = await adapter.capture('raf', f.assignment);
    assert.equal(again[0].changeInstance, captured[0].changeInstance);
    assert.equal(again[0].fingerprint, captured[0].fingerprint);
  });
});

for (const [label, rows] of [
  ['description', [task('Змінений опис', true)]],
  ['exact whitespace', [task('Зберегти точну ідентичність ', true)]],
  ['number', [{ id: '1', description: '1.2 Зберегти точну ідентичність', done: true }]],
  ['missing original item', []],
  ['ambiguous original item', [task(undefined, true), { id: '1.1', description: 'Зберегти точну ідентичність', done: true }]],
] as const) {
  test(`[identity-fs] ${label} change never binds the old reservation to a different task`, async t => {
    const f = await fixture(t);
    await contract('Changed original item returns mismatch', async () => {
      const adapter = f.adapter();
      const captured = await adapter.capture('raf', f.assignment);
      f.setRows(structuredClone(rows) as Row[]);
      refused(await adapter.resolveTasks(captured), captured, 'mismatch');
    });
  });
}

for (const file of ['proposal.md', 'design.md', '.openspec.yaml', 'specs/identity/spec.md']) {
  test(`[identity-fs] legitimate assigned artifact edit of ${file} preserves task identity`, async t => {
    const f = await fixture(t);
    await contract('An assigned agent may edit artifacts and complete the exact original task', async () => {
      const adapter = f.adapter();
      const captured = await adapter.capture('raf', f.assignment);
      const original = structuredClone(captured);
      await mkdir(join(f.dir, 'specs', 'identity'), { recursive: true });
      const text = file === 'proposal.md' ? proposal('legitimate assigned proposal edit')
        : file === '.openspec.yaml' ? 'schema: spec-driven\ncreated: 2026-10-22\nskip_specs: true\n\n'
        : '# Assigned artifact\n\nLegitimate design or spec task result.\n';
      await writeFile(join(f.dir, file), text);
      const marker = file === 'proposal.md' ? text : f.context;
      f.sources.set(marker, [task()]);
      resolved(await adapter.resolveTasks(captured), captured, 'open', 'active');
      assert.deepEqual(await adapter.capture('raf', f.assignment), original);
      f.sources.set(marker, [task(undefined, true)]);
      await writeFile(join(f.dir, 'tasks.md'), '- [x] 1.1 Зберегти точну ідентичність\n');
      resolved(await adapter.resolveTasks(captured), original, 'completed', 'active');
      assert.deepEqual(captured, original);
    });
  });
}

for (const file of ['config.yaml', 'schemas/local/schema.yaml']) {
  test(`[identity-fs] ${file} edit with unchanged authoritative task preserves identity`, async t => {
    const f = await fixture(t);
    await contract('Configuration bytes are not semantic components of the task fingerprint', async () => {
      const adapter = f.adapter();
      const captured = await adapter.capture('raf', f.assignment);
      await mkdir(join(f.root, 'openspec', 'schemas', 'local'), { recursive: true });
      await writeFile(join(f.root, 'openspec', file), file === 'config.yaml'
        ? 'schema: spec-driven\ncontext: |\n  Legitimate updated project context.\n'
        : 'name: local\nversion: 1\ndescription: Unrelated local schema\nartifacts: []\n');
      resolved(await adapter.resolveTasks(captured), captured, 'open', 'active');
      assert.deepEqual(await adapter.capture('raf', f.assignment), captured);
      f.setRows([task(undefined, true)]);
      resolved(await adapter.resolveTasks(captured), captured, 'completed', 'active');
    });
  });
}

test('[identity-fs] selected task context includes canonical project scope', async t => {
  const f = await fixture(t);
  await contract('Project scopes cannot share interchangeable snapshots', async () => {
    const adapter = createAssignmentIdentityAdapter({ raf: f.root, other: f.root }, { execute: f.execute });
    const left = await adapter.capture('raf', f.assignment);
    const right = await adapter.capture('other', f.assignment);
    assert.notDeepEqual(left[0].key, right[0].key);
    assert.notEqual(left[0].fingerprint, right[0].fingerprint);
    const forged = [{ ...left[0], key: { ...left[0].key, project: 'other' } }];
    refused(await adapter.resolveTasks(forged), forged, 'mismatch');
  });
});

test('[identity-fs] exact original identity follows archive while an old archive and reused active name coexist', async t => {
  const f = await fixture(t);
  const old = join(f.root, 'openspec', 'changes', 'archive', `2026-10-21-${f.change}`);
  await cp(f.dir, old, { recursive: true });
  await contract('Archive selection uses the original directory tuple rather than name, dates or baseline list', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', { ...f.assignment, baselineArchives: [`2026-10-21-${f.change}`] });
    f.setRows([task(undefined, true)]);
    await f.archive();
    await f.reuse();
    const serialized = JSON.parse(JSON.stringify(captured));
    resolved(await f.adapter().resolveTasks(serialized), captured, 'completed', 'archive');
    assert.ok(await readFile(join(old, 'tasks.md'), 'utf8'));
  });
});

test('[identity-fs] arbitrary archive rename preserves same-source identity', async t => {
  const f = await fixture(t);
  await contract('Filesystem identity is not an archive pathname heuristic', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', f.assignment);
    f.setRows([task(undefined, true)]);
    await f.archive('retained-original-directory');
    resolved(await adapter.resolveTasks(captured), captured, 'completed', 'archive');
  });
});

test('[identity-fs] reuse active name without exact original archive is mismatch', async t => {
  const f = await fixture(t);
  await contract('Newly created same-name completed task cannot complete original work', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', f.assignment);
    await rename(f.dir, join(f.home, 'original-outside-project'));
    await f.reuse();
    refused(await adapter.resolveTasks(captured), captured, 'mismatch');
  });
});

test('[identity-fs] byte-identical copied archive cannot replace original identity', async t => {
  const f = await fixture(t);
  await contract('Copied archive has different dev/inode/birthtime identity', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', f.assignment);
    const copy = join(f.root, 'openspec', 'changes', 'archive', `2026-10-22-${f.change}`);
    await cp(f.dir, copy, { recursive: true, preserveTimestamps: true });
    await rename(f.dir, join(f.home, 'original-removed-from-source'));
    f.setRows([task(undefined, true)]);
    refused(await adapter.resolveTasks(captured), captured, 'mismatch');
  });
});

test('[identity-fs] archived incomplete source is invalid even for a completed selected subset', async t => {
  const f = await fixture(t);
  await contract('All archived source tasks must be complete', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', f.assignment);
    f.setRows([task(undefined, true), { id: '2', description: '1.2 Still open', done: false }]);
    await f.archive();
    refused(await adapter.resolveTasks(captured), captured, 'mismatch');
  });
});

for (const mode of ['exit', 'json', 'shape', 'throw'] as const) {
  test(`[identity-fs] source ${mode} failure returns unknown without completing tasks`, async t => {
    const f = await fixture(t);
    await contract('OpenSpec read failure cannot imply completion', async () => {
      const adapter = f.adapter();
      const captured = await adapter.capture('raf', f.assignment);
      f.fail(mode);
      refused(await adapter.resolveTasks(captured), captured, 'unknown');
      f.fail(undefined);
      resolved(await adapter.resolveTasks(captured), captured, 'open', 'active');
    });
  });
}

for (const kind of ['directory', 'tasks', 'cli-metadata', 'archive'] as const) {
  test(`[identity-fs] symlink ${kind} is rejected without trusting target identity`, async t => {
    const f = await fixture(t);
    await contract('Only regular local source directories and files may prove identity', async () => {
      const adapter = f.adapter();
      const captured = await adapter.capture('raf', f.assignment);
      if (kind === 'directory') {
        const outside = join(f.home, 'outside-change');
        await rename(f.dir, outside);
        await symlink(outside, f.dir);
      } else if (kind === 'archive') {
        const target = await f.archive();
        const outside = join(f.home, 'outside-archive');
        await rename(target, outside);
        await symlink(outside, target);
      } else {
        const path = join(f.dir, kind === 'tasks' ? 'tasks.md' : '.openspec.yaml');
        const outside = join(f.home, `${kind}-target`);
        await rename(path, outside);
        await symlink(outside, path);
      }
      refused(await adapter.resolveTasks(captured), captured, 'unknown');
    });
  });
}

test('[identity-fs] missing source is unknown rather than completed', async t => {
  const f = await fixture(t);
  await contract('Missing source does not prove task completion', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', f.assignment);
    await rm(f.dir, { recursive: true });
    refused(await adapter.resolveTasks(captured), captured, 'unknown');
  });
});

for (const mode of ['birthtime', 'filesystem', 'stat-error'] as const) {
  test(`[identity-fs] unsupported ${mode} never produces a snapshot`, async t => {
    const f = await fixture(t);
    await contract('Missing filesystem identity evidence fails closed', async () => {
      const adapter = createAssignmentIdentityAdapter({ raf: f.root }, {
        execute: f.execute,
        async lstat(path) {
          if (mode === 'stat-error') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          const actual = await lstat(path, { bigint: true });
          if (mode !== 'birthtime') return actual;
          return new Proxy(actual, { get(target, key) {
            if (key === 'birthtimeNs') return 0n;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        },
        async statfs(path) {
          const actual = await statfs(path, { bigint: true });
          return mode === 'filesystem' ? { ...actual, type: 0x6969n } : actual;
        },
      });
      await assert.rejects(() => adapter.capture('raf', f.assignment), { code: 'TASK_SOURCE_UNKNOWN' });
      assert.equal(f.calls.length, 0);
    });
  });
}

for (const mode of ['dev', 'ino', 'birthtimeNs', 'unsupported-birthtime'] as const) {
  test(`[identity-fs] changed ${mode} evidence after capture cannot match the original source`, async t => {
    const f = await fixture(t);
    await contract('All bigint OS identity components remain necessary at resolution', async () => {
      let changed = false;
      const adapter = createAssignmentIdentityAdapter({ raf: f.root }, {
        execute: f.execute,
        async lstat(path) {
          const actual = await lstat(path, { bigint: true });
          if (!changed || path !== f.dir) return actual;
          return new Proxy(actual, { get(target, key) {
            if (mode === 'unsupported-birthtime' && key === 'birthtimeNs') return 0n;
            if (key === mode) return Reflect.get(target, key) + 1n;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        },
      });
      const captured = await adapter.capture('raf', f.assignment);
      changed = true;
      const result = await adapter.resolveTasks(captured);
      assert.equal(result.length, 1);
      assert.ok(result[0].state === 'mismatch' || result[0].state === 'unknown');
      if (mode === 'unsupported-birthtime') refused(result, captured, 'unknown');
      else {
        assert.ok('requested' in result[0]);
        assert.deepEqual(result[0].requested, captured[0]);
        assert.ok(result[0].reason.trim());
      }
    });
  });
}

for (const mode of ['replacement', 'rename-away-and-back', 'tasks', 'cli-metadata'] as const) {
  test(`[identity-fs] ${mode} race across authoritative read is detected`, async t => {
    const f = await fixture(t);
    await contract('Before/after validation refuses concurrent source mutation', async () => {
      const adapter = f.adapter();
      const captured = await adapter.capture('raf', f.assignment);
      f.onRead(async () => {
        if (mode === 'replacement') {
          await rename(f.dir, join(f.home, 'original-during-read'));
          await f.reuse();
        } else if (mode === 'rename-away-and-back') {
          const outside = join(f.home, 'temporarily-moved');
          await rename(f.dir, outside);
          await rename(outside, f.dir);
        } else if (mode === 'tasks') {
          await writeFile(join(f.dir, 'tasks.md'), '- [x] 1.1 Зберегти точну ідентичність\n');
          f.setRows([task(undefined, true)]);
        } else {
          await writeFile(join(f.dir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-10-22\nskip_specs: true\n\n');
        }
      });
      refused(await adapter.resolveTasks(captured), captured, 'unknown');
    });
  });
}

test('[identity-fs] capture also rejects mutation during source read', async t => {
  const f = await fixture(t);
  await contract('Capture cannot silently bind an assignment to a replacement directory', async () => {
    const adapter = f.adapter();
    f.onRead(async () => {
      await rename(f.dir, join(f.home, 'original-during-capture'));
      await f.reuse(false);
    });
    await assert.rejects(() => adapter.capture('raf', f.assignment), { code: 'TASK_SOURCE_UNKNOWN' });
  });
});

for (const mode of ['unknown-project', 'wrong-root', 'empty', 'traversal', 'duplicate', 'description', 'completed'] as const) {
  test(`[identity-fs] capture rejects ${mode} before returning any partial assignment`, async t => {
    const f = await fixture(t);
    await contract('Invalid capture inputs cannot create reservation identity', async () => {
      const input = structuredClone(f.assignment) as { root: string; changes: { id: string; items: { id: string; description: string }[] }[]; baselineArchives: string[] };
      if (mode === 'wrong-root') input.root = join(f.home, 'other-root');
      if (mode === 'empty') input.changes = [];
      if (mode === 'traversal') input.changes[0].id = '../escape';
      if (mode === 'duplicate') input.changes[0].items.push({ ...input.changes[0].items[0] });
      if (mode === 'description') input.changes[0].items[0].description = 'Forged description';
      if (mode === 'completed') f.setRows([task(undefined, true)]);
      await assert.rejects(() => f.adapter().capture(mode === 'unknown-project' ? 'RAF' : 'raf', input), { code: 'TASK_IDENTITY_INVALID' });
    });
  });
}

test('[identity-fs] resolver returns exactly one ordered result per requested task', async t => {
  const f = await fixture(t);
  await contract('Partial source failure does not drop or reorder original requests', async () => {
    f.setRows([task(), { id: '2', description: '1.2 Another task', done: false }]);
    const assignment: AssignmentSnapshot = { ...f.assignment, changes: [{ id: f.change, items: [...f.assignment.changes[0].items, { id: '1.2', description: 'Another task' }] }] };
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', assignment);
    f.setRows([task(undefined, true), { id: '2', description: '1.2 Changed task', done: true }]);
    const requested = [captured[1], captured[0]];
    const result = await adapter.resolveTasks(requested);
    assert.equal(result.length, 2);
    refused([result[0]], [requested[0]], 'mismatch');
    resolved([result[1]], [requested[1]], 'completed', 'active');
  });
});

test('[identity-fs] malformed serialized identity does not access paths from untrusted strings', async t => {
  const f = await fixture(t);
  await contract('Invalid original identities produce explicit mismatch diagnostics', async () => {
    const adapter = f.adapter();
    const captured = await adapter.capture('raf', f.assignment);
    const forged = [{ ...captured[0], changeInstance: '../../outside', fingerprint: 'forged' }];
    const before = f.calls.length;
    refused(await adapter.resolveTasks(forged), forged, 'mismatch');
    assert.equal(f.calls.length, before);
  });
});

test('[identity-live] installed OpenSpec actual archive preserves identity through name reuse without model tasks', async t => {
  const f = await fixture(t);
  await contract('Default OS and CLI path resolves the actual archived source after active-name reuse', async () => {
    const version = await execFileAsync('openspec', ['--version'], { cwd: f.root });
    assert.equal(version.stdout.trim(), '1.14.3');
    const original = await lstat(f.dir, { bigint: true });
    assert.ok(original.birthtimeNs > 0n);
    const adapter = createAssignmentIdentityAdapter({ raf: f.root });
    const captured = await adapter.capture('raf', f.assignment);
    await writeFile(join(f.dir, 'tasks.md'), '## 1. Identity\n\n- [x] 1.1 Зберегти точну ідентичність\n');
    const outcome = await execFileAsync('openspec', ['archive', f.change, '--yes', '--skip-specs', '--json'], { cwd: f.root });
    assert.ok(outcome.stdout.trim());
    const names = await readdir(join(f.root, 'openspec', 'changes', 'archive'));
    assert.equal(names.length, 1);
    const archived = await lstat(join(f.root, 'openspec', 'changes', 'archive', names[0]), { bigint: true });
    const tuple = (stat: BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs];
    assert.deepEqual(tuple(archived), tuple(original));
    await f.reuse();
    assert.notDeepEqual(tuple(await lstat(f.dir, { bigint: true })), tuple(original));
    const restarted = createAssignmentIdentityAdapter({ raf: f.root });
    resolved(await restarted.resolveTasks(JSON.parse(JSON.stringify(captured))), captured, 'completed', 'archive');
  });
});
