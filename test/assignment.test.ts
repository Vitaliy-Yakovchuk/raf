import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  composeAssignmentBrief, validateAssignment, verifyAssignmentCompletion,
  type AssignmentBriefContext, type AssignmentPorts, type AssignmentSnapshot,
} from '../src/assignment.ts';

const root = '/work/project';
const selected = [{ change: 'add-widget', items: [{ id: '1.1', expectedDescription: 'Create widget' }] }];
const tasks = [
  { id: '1.1', description: 'Create widget', done: false },
  { id: '1.2', description: 'Publish widget', done: false },
];
const oldArchive = '2026-10-20-add-widget';
const newArchive = '2026-10-21-add-widget';
const archive = (name: string, completedTasks = 2, totalTasks = 2) => ({ name, completedTasks, totalTasks });
const list = (names: string[]) => ({ changes: names.map(name => ({ name, completedTasks: 0, totalTasks: 2 })) });

function harness() {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const reads: string[] = [];
  const replies = new Map<string, unknown>([
    ['list --json', list(['add-widget'])],
    ['list --archived --json', { changes: [archive(oldArchive)] }],
    ['instructions apply --change add-widget --json', { changeName: 'add-widget', tasks: structuredClone(tasks) }],
  ]);
  const files = new Map<string, string>();
  const failures = new Map<string, string>();
  const raw = new Map<string, string>();
  const ports: AssignmentPorts = {
    cli: { async exec(args, cwd) {
      calls.push({ args: [...args], cwd });
      const key = args.join(' ');
      if (failures.has(key)) return { exitCode: 1, stdout: '', stderr: failures.get(key)! };
      assert.ok(replies.has(key) || raw.has(key), `Unexpected command: ${key}`);
      return { exitCode: 0, stdout: raw.get(key) ?? JSON.stringify(replies.get(key)), stderr: '' };
    } },
    fs: { async readText(path) {
      reads.push(path);
      assert.ok(files.has(path), `Unexpected file read: ${path}`);
      return files.get(path)!;
    } },
  };
  return { calls, reads, replies, files, failures, raw, ports };
}

async function initial(h: ReturnType<typeof harness>): Promise<AssignmentSnapshot> {
  const result = await validateAssignment({ root, selections: selected }, h.ports);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Validation must succeed');
  return result.snapshot;
}

const brief: AssignmentBriefContext = {
  cwd: '/work/project/raf-develop', briefsRoot: '/work/conf/briefs', runner: 'codex', stage: 'implement',
  project: 'raf', agentId: 'implement-one', sessionName: 'implement-one',
  features: ['agent-run'], phase: 'implement', outcome: 'Implement selected behavior',
  writeBoundaries: ['/work/project/src/assignment.ts'], sources: ['/work/spec/agent-run/spec.md'],
  reportPath: '/tmp/raf-run-unique/implement-one.json',
  reportSchema: { type: 'object', required: ['status', 'answer', 'assignments'], properties: { status: { enum: ['succeeded', 'failed'] } } },
  rafCommand: 'node /srv/raf-main/bin/raf.ts',
};

function installBriefs(h: ReturnType<typeof harness>) {
  h.files.set('/work/conf/briefs/runners/codex.md', 'RUNNER INSTRUCTIONS');
  h.files.set('/work/conf/briefs/tasks/implement.md', 'STAGE INSTRUCTIONS');
  h.files.set('/work/conf/briefs/completion.md', 'COMPLETION: check all tasks; sync/archive only when all done; write report atomically.');
  h.files.set(`${root}/conf/raf-constants.json`, readFileSync(new URL('../../conf/raf-constants.json', import.meta.url), 'utf8'));
  h.files.set(`${root}/conf/models.json`, readFileSync(new URL('../../conf/models.json', import.meta.url), 'utf8'));
}

function installNewArchive(h: ReturnType<typeof harness>, body = '- [x] 1.1 Create widget\n- [x] 1.2 Publish widget\n') {
  h.replies.set('list --json', list([]));
  h.replies.set('list --archived --json', { changes: [archive(oldArchive), archive(newArchive)] });
  h.files.set(`${root}/openspec/changes/archive/${newArchive}/tasks.md`, body);
}

test('assignment validates all requested changes through OpenSpec and snapshots only selected tasks', async () => {
  const h = harness();
  h.replies.set('list --json', list(['add-widget', 'add-panel']));
  h.replies.set('instructions apply --change add-panel --json', { tasks: [{ id: '2.3', description: 'Create panel', done: false }] });
  const result = await validateAssignment({ root, selections: [...selected, { change: 'add-panel', items: [{ id: '2.3' }] }] }, h.ports);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.changes, [
    { id: 'add-widget', items: [{ id: '1.1', description: 'Create widget' }] },
    { id: 'add-panel', items: [{ id: '2.3', description: 'Create panel' }] },
  ]);
  assert.deepEqual(result.snapshot.baselineArchives, [oldArchive]);
  assert.ok(h.calls.some(call => call.args.join(' ') === 'instructions apply --change add-panel --json'));
  assert.ok(h.calls.every(call => call.cwd === root));
});

test('assignment snapshot is deeply immutable and independent of caller edits', async () => {
  const h = harness();
  const request = { root, selections: structuredClone(selected) };
  const result = await validateAssignment(request, h.ports);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  request.selections[0].items[0].expectedDescription = 'Different work';
  request.selections[0].change = 'other';
  assert.equal(result.snapshot.changes[0].items[0].description, 'Create widget');
  for (const value of [result.snapshot, result.snapshot.changes, result.snapshot.changes[0], result.snapshot.changes[0].items, result.snapshot.changes[0].items[0], result.snapshot.baselineArchives]) assert.equal(Object.isFrozen(value), true);
});

test('missing active change reports root, requested name, archives, and remedy without substituting a similar change', async () => {
  const h = harness();
  h.replies.set('list --json', list(['add-widget-v2']));
  const result = await validateAssignment({ root, selections: selected }, h.ports);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'invalid-assignment');
  assert.equal(result.root, root);
  assert.equal(result.issues[0].change, 'add-widget');
  assert.ok(result.issues[0].archives.includes(oldArchive));
  assert.ok(result.issues[0].remedy.length > 0);
  assert.ok(!h.calls.some(c => c.args.includes('add-widget-v2')));
});

test('validation rejects whole assignment and collects missing items across multiple changes', async () => {
  const h = harness();
  h.replies.set('list --json', list(['add-widget', 'add-panel']));
  h.replies.set('instructions apply --change add-panel --json', { tasks: [{ id: '2.1', description: 'Existing panel', done: true }] });
  const result = await validateAssignment({ root, selections: [
    { change: 'add-widget', items: [{ id: '9.9' }] },
    { change: 'add-panel', items: [{ id: '8.8' }] },
  ] }, h.ports);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'invalid-assignment');
  assert.deepEqual(result.issues.map(x => x.change).sort(), ['add-panel', 'add-widget']);
  assert.deepEqual(result.issues.find(x => x.change === 'add-widget')?.foundItems, tasks);
  assert.deepEqual(result.issues.find(x => x.change === 'add-panel')?.requestedItems, ['8.8']);
});

for (const scenario of ['description drift', 'duplicate item'] as const) test(`prelaunch rejects ${scenario}`, async () => {
  const h = harness();
  h.replies.set('instructions apply --change add-widget --json', { tasks: scenario === 'description drift' ? [{ ...tasks[0], description: 'Different work' }] : [tasks[0], tasks[0]] });
  const result = await validateAssignment({ root, selections: selected }, h.ports);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, 'invalid-assignment');
});

for (const scenario of ['command failure', 'invalid JSON', 'invalid structure'] as const) test(`OpenSpec ${scenario} is unavailable rather than a missing assignment`, async () => {
  const h = harness();
  const command = 'instructions apply --change add-widget --json';
  if (scenario === 'command failure') h.failures.set(command, 'Permission denied reading specs');
  else h.raw.set(command, scenario === 'invalid JSON' ? '{"tasks":' : '{"tasks":"wrong type"}');
  const result = await validateAssignment({ root, selections: selected }, h.ports);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'openspec-unavailable');
  assert.ok(result.issues.some(issue => issue.reason.length > 0));
  if (scenario === 'command failure') assert.match(JSON.stringify(result.issues), /Permission denied/);
});

test('brief composes selected runner, stage, completion, exact immutable assignments and run report contract', async () => {
  const h = harness();
  const snapshot = await initial(h);
  installBriefs(h);
  const output = await composeAssignmentBrief(snapshot, brief, h.ports.fs);
  for (const expected of ['RUNNER INSTRUCTIONS', 'STAGE INSTRUCTIONS', 'COMPLETION:', 'add-widget', '1.1', 'Create widget', brief.project, brief.agentId, brief.sessionName, brief.phase, brief.features[0], brief.outcome, brief.sources[0], brief.writeBoundaries[0], brief.reportPath, 'report_path', 'report_schema', 'succeeded', 'failed', 'assignments']) assert.ok(output.includes(expected), `Missing ${expected}`);
  assert.ok(output.indexOf('RUNNER INSTRUCTIONS') < output.indexOf('STAGE INSTRUCTIONS'));
  assert.ok(output.indexOf('STAGE INSTRUCTIONS') < output.indexOf('COMPLETION:'));
  assert.ok(!output.includes('Publish widget'));
  const assignment = JSON.parse(output.slice(output.indexOf('{', output.indexOf('# Конкретне доручення'))));
  assert.equal(assignment.phase, 'implement');
  assert.deepEqual([...h.reads].sort(), [...h.files.keys()].filter(path => path.startsWith('/work/conf/briefs/')).sort());
});

test('coordinating brief names the exact raf command to run as one simple call; executor briefs limit it to message and ps', async () => {
  const h = harness();
  const snapshot = await initial(h);
  installBriefs(h);
  await assert.rejects(() => composeAssignmentBrief(snapshot, { ...brief, rafCommand: undefined }, h.ports.fs), /rafCommand|raf_command/);
  const output = await composeAssignmentBrief(snapshot, { ...brief, stage: 'implement', rafCommand: 'node /srv/raf-main/bin/raf.ts' }, h.ports.fs);
  const assignment = JSON.parse(output.slice(output.indexOf('{', output.indexOf('# Конкретне доручення'))));
  assert.equal(assignment.raf_command, 'node /srv/raf-main/bin/raf.ts');
  assert.match(output, /raf_command[^\n]*простою командою/);
  assert.equal('raf_subcommands' in assignment, false);
  const scoped = await composeAssignmentBrief(snapshot, { ...brief, stage: 'implement', rafCommand: 'node /srv/raf-main/bin/raf.ts', rafSubcommands: ['agent message', 'agent ps'] }, h.ports.fs);
  const executor = JSON.parse(scoped.slice(scoped.indexOf('{', scoped.indexOf('# Конкретне доручення'))));
  assert.equal(executor.raf_command, 'node /srv/raf-main/bin/raf.ts');
  assert.deepEqual(executor.raf_subcommands, ['agent message', 'agent ps']);
  assert.match(scoped, /raf_command agent message[^\n]*raf_command agent ps[^\n]*простою командою/);
  assert.equal(/raf_command agent run/.test(scoped), false);
});

test('brief of a type with a write boundary names the own-work commit duty under parallel-development, commit hashes in the report and no default push; other briefs stay without it', async () => {
  const h = harness();
  const snapshot = await initial(h);
  installBriefs(h);
  const section = (text: string) => text.slice(text.indexOf('# Конкретне доручення'), text.indexOf('{', text.indexOf('# Конкретне доручення')));
  const committing = await composeAssignmentBrief(snapshot, { ...brief, commitOwnWork: true }, h.ports.fs);
  const duty = section(committing);
  assert.match(duty, /закоміт/i);
  assert.ok(duty.includes('projects/orchestrator/parallel-development'), 'commit rules come from parallel-development');
  assert.match(duty, /хеш/i);
  assert.match(duty, /push[^\n]*(?:не |без |лише )|(?:не |без )[^\n]*push/i);
  const assignment = JSON.parse(committing.slice(committing.indexOf('{', committing.indexOf('# Конкретне доручення'))));
  assert.deepEqual(assignment.write_boundaries, brief.writeBoundaries);
  for (const context of [brief, { ...brief, commitOwnWork: false }]) {
    const plain = await composeAssignmentBrief(snapshot, context, h.ports.fs);
    assert.doesNotMatch(plain, /коміт/i);
    assert.equal(plain.includes('parallel-development'), false);
  }
});

test('runner switch preserves stage and assignments while replacing runner template', async () => {
  const h = harness();
  const snapshot = await initial(h);
  installBriefs(h);
  h.files.set('/work/conf/briefs/runners/claude.md', 'OTHER RUNNER');
  const output = await composeAssignmentBrief(snapshot, { ...brief, runner: 'claude' }, h.ports.fs);
  assert.ok(output.includes('OTHER RUNNER'));
  assert.ok(output.includes('STAGE INSTRUCTIONS'));
  assert.ok(output.includes('Create widget'));
  assert.ok(!h.reads.includes('/work/conf/briefs/runners/codex.md'));
});

test('active completion requires only assigned items and does not mutate original assignment', async () => {
  const h = harness();
  const snapshot = await initial(h);
  const before = JSON.stringify(snapshot);
  h.replies.set('instructions apply --change add-widget --json', { tasks: [{ ...tasks[0], done: true }, tasks[1]] });
  assert.deepEqual(await verifyAssignmentCompletion(snapshot, h.ports), { ok: true, issues: [] });
  assert.equal(JSON.stringify(snapshot), before);
});

test('completion still rejects a unique open assigned ID', async () => {
  const h = harness();
  const snapshot = await initial(h);
  const result = await verifyAssignmentCompletion(snapshot, h.ports);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.requestedItems.includes('1.1')));
});

for (const mode of ['clarified', 'missing', 'renumbered', 'ambiguous'] as const) test('[Z440] completion uses ID and warns for unavailable IDs: ' + mode, async () => {
  const h = harness();
  const snapshot = await initial(h);
  const done = { ...tasks[0], description: 'Clarified work', done: true };
  const current = mode === 'clarified' ? [done] : mode === 'missing' ? [tasks[1]] : mode === 'renumbered' ? [{ ...done, id: '7.1' }] : [done, done];
  h.replies.set('instructions apply --change add-widget --json', { tasks: current });
  const result = await verifyAssignmentCompletion(snapshot, h.ports);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.issues, []);
  if (mode !== 'clarified') assert.ok(result.warnings?.some(issue => issue.requestedItems.includes('1.1')));
});

test('[Z440] completed archive identifies a clarified task by ID', async () => {
  const h = harness();
  const snapshot = await initial(h);
  installNewArchive(h, '- [x] 1.1 Clarified work\n- [x] 1.2 Publish widget\n');
  assert.equal((await verifyAssignmentCompletion(snapshot, h.ports, { 'add-widget': newArchive })).ok, true);
});

test('new exact complete archive with matching task content proves completion', async () => {
  const h = harness();
  const snapshot = await initial(h);
  installNewArchive(h);
  assert.deepEqual(await verifyAssignmentCompletion(snapshot, h.ports, { 'add-widget': newArchive }), { ok: true, issues: [] });
  assert.ok(h.reads.includes(`${root}/openspec/changes/archive/${newArchive}/tasks.md`));
});

for (const scenario of ['old archive', 'no archive', 'incomplete archive', 'unchecked item', 'wrong exact name'] as const) test(`archived completion rejects ${scenario}`, async () => {
  const h = harness();
  const snapshot = await initial(h);
  installNewArchive(h);
  let claim = newArchive;
  if (scenario === 'old archive') { h.replies.set('list --archived --json', { changes: [archive(oldArchive)] }); claim = oldArchive; }
  if (scenario === 'no archive') h.replies.set('list --archived --json', { changes: [] });
  if (scenario === 'incomplete archive') h.replies.set('list --archived --json', { changes: [archive(newArchive, 1, 2)] });
  if (scenario === 'unchecked item') h.files.set(`${root}/openspec/changes/archive/${newArchive}/tasks.md`, '- [ ] 1.1 Create widget\n');
  if (scenario === 'wrong exact name') claim = '2026-10-21-add-widget-extra';
  const result = await verifyAssignmentCompletion(snapshot, h.ports, { 'add-widget': claim });
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
});

test('OpenSpec failure during completion stays unconfirmed even with a claimed archive', async () => {
  const h = harness();
  const snapshot = await initial(h);
  h.failures.set('instructions apply --change add-widget --json', 'CLI unavailable');
  const result = await verifyAssignmentCompletion(snapshot, h.ports, { 'add-widget': newArchive });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.issues), /CLI unavailable/);
});
