import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { composeAssignmentBrief, type AssignmentBriefContext, type AssignmentSnapshot } from '../src/assignment.ts';
import { deriveTaskContext, loadTaskContextConfiguration } from '../src/task-context.ts';

const confRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../conf');
const constants = JSON.parse(await readFile(join(confRoot, 'raf-constants.json'), 'utf8'));
const models = JSON.parse(await readFile(join(confRoot, 'models.json'), 'utf8'));
const phaseTemplates = await Promise.all(constants.agentPhases.map(async (phase: { id: string }) => {
  try {
    await readFile(join(confRoot, 'briefs/tasks', `${phase.id}.md`), 'utf8');
    return phase.id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}));
const stages = phaseTemplates.filter((stage): stage is string => stage !== null);
type BriefInput = AssignmentBriefContext & { cwd: string };
type SelectedChange = AssignmentSnapshot['changes'][number];

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'raf-c2-brief-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['flow.json', 'raf-constants.json', 'models.json', 'projects.json']) {
    await put(root, `conf/${name}`, await readFile(join(confRoot, name), 'utf8'));
  }
  await cp(join(confRoot, 'briefs'), join(root, 'conf/briefs'), { recursive: true });
  await mkdir(join(root, 'raf-develop'), { recursive: true });
  await put(root, 'openspec/reading.md', 'C2_UNRELATED_FULL_FLOW_BODY');
  await put(root, 'openspec/changes/brief-work/contract.md', '## Достатність\nC2_SUBJECT_CONTRACT\n');
  await put(root, 'openspec/specs/projects/orchestrator/autonomous-development/spec.md', '### Requirement: Архівація останнім виконавцем\n#### Scenario: Зміна завершена\nC2_ARCHIVE_DETAIL\n');
  const reads: string[] = [];
  const fs = {
    async readText(path: string): Promise<string> {
      reads.push(path);
      assert.ok(path.startsWith(`${root}/`), `Composition read outside fixture: ${path}`);
      return readFile(path, 'utf8');
    },
  };
  const configuration = await loadTaskContextConfiguration(join(root, 'conf'));
  return { root, reads, fs, configuration };
}

function snapshot(root: string, changes: readonly SelectedChange[] = [
  { id: 'brief-work', items: [{ id: '1.1', description: 'Виконати лише перевірку достатності брифа C2_SELECTED_ITEM' }] },
]): AssignmentSnapshot {
  return { root, changes, baselineArchives: [] };
}

function briefInput(root: string, runner = 'codex', stage = 'test-scaffold'): BriefInput {
  return {
    briefsRoot: join(root, 'conf/briefs'),
    runner,
    stage,
    project: 'raf',
    agentId: 'c2-worker',
    sessionName: 'c2-session',
    features: ['brief-work'],
    phase: stage,
    cwd: join(root, 'raf-develop'),
    outcome: 'C2_GOAL. Передумова C2_READY: контракт погоджено. Перевірка C2_ACCEPT: адресна група дає очікуваний код. Передача C2_HANDOFF: координатору з доказами.',
    writeBoundaries: [join(root, 'raf-develop'), join(root, 'openspec/changes/brief-work')],
    sources: [
      `${root}/openspec/changes/brief-work/contract.md — секція «Достатність» зі сценаріями; причина C2_SUBJECT; читати зараз`,
      `${root}/conf/flow.json#/unitTests/timeoutMs — причина C2_TIMEOUT; читати лише коли координатор запускає unit-тести`,
      `${root}/openspec/specs/projects/orchestrator/autonomous-development/spec.md — вимога «Архівація останнім виконавцем» зі сценаріями; причина C2_LAST_ITEM; читати коли закрито останній пункт усієї зміни`,
    ],
    reportPath: join(root, 'run-tmp/c2-session.json'),
    reportSchema: {
      type: 'object', required: ['status', 'answer', 'changes'], additionalProperties: true,
      properties: { status: { enum: constants.reportStatuses.map((status: { id: string }) => status.id) } },
    },
    rafCommand: `node ${root}/raf-main/bin/raf.ts`,
    rafSubcommands: ['agent message', 'agent ps'],
    commitOwnWork: true,
    commitRepositories: [join(root, 'raf-develop')],
    commitPaths: [join(root, 'raf-develop/test/own-c2.test.ts')],
    workspaceWritable: true,
  };
}

function assignmentJson(brief: string): Record<string, any> {
  const candidates = [...brief.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)].map(match => match[1]);
  candidates.push(brief.slice(brief.indexOf('\n{') + 1).trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.report_path && parsed.assignments) return parsed;
    } catch {}
  }
  assert.fail('The brief must carry its assignment JSON with report_path and assignments');
}

function withoutAssignmentJson(brief: string): string {
  return brief.replace(/```(?:json)?\s*([\s\S]*?)```/gu, (block, candidate: string) => {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.report_path && parsed.assignments) return '';
    } catch {}
    return block;
  });
}

function contains(text: string, expected: string, message = expected): void {
  assert.ok(text.includes(expected), `Missing ${message}`);
}

function sourceFor(sources: readonly string[], path: string): string {
  const matches = sources.filter(source => source.includes(path));
  assert.ok(matches.length > 0, `Missing selected source ${path}`);
  return matches.join('\n');
}

async function derive(f: Awaited<ReturnType<typeof fixture>>, changes: readonly SelectedChange[], phase: string) {
  return deriveTaskContext({
    root: f.root,
    parameters: {
      id: 'c2-worker', type: phase === 'context-review' ? 'spec' : phase, project: 'raf',
      features: changes.map(change => change.id), phase, complexity: 'ordinary',
      tasks: changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)),
    },
    assignment: snapshot(f.root, changes),
    configuration: f.configuration,
  });
}

async function change(f: Awaited<ReturnType<typeof fixture>>, id: string, items: readonly { id: string; description: string }[], sourceRows: readonly string[]) {
  await put(f.root, `openspec/changes/${id}/proposal.md`, `## Why\nМета ${id}\n## What Changes\nЛише вибрані пункти\n`);
  await put(f.root, `openspec/changes/${id}/tasks.md`, [
    '## Джерела за етапом', '', ...sourceRows, '', '## Робота', '',
    ...items.map(item => `- [ ] ${item.id} ${item.description}`), '',
  ].join('\n'));
  return { id, items };
}

for (const runner of models.runners as { id: string; initialEnabled: boolean }[]) {
  for (const stage of stages) {
    test(`[C.2 sufficient] ${runner.id}/${stage}: common instructions, catalogue guide and conditional sources`, async t => {
      const f = await fixture(t);
      const input = briefInput(f.root, runner.id, stage);
      const selected = snapshot(f.root);
      const brief = await composeAssignmentBrief(selected, input, f.fs);
      const payload = assignmentJson(brief);
      assert.equal(payload.root, f.root);
      assert.equal(payload.agent_id, input.agentId);
      assert.equal(payload.project, input.project);
      assert.equal(payload.phase, stage);
      assert.equal(payload.report_path, input.reportPath);
      assert.deepEqual(payload.report_schema, input.reportSchema);
      assert.deepEqual(payload.assignments, selected.changes);
      assert.deepEqual(payload.write_boundaries, input.writeBoundaries);
      contains(brief, input.cwd, 'actual cwd separately from OpenSpec root');
      for (const marker of ['C2_GOAL', 'C2_READY', 'C2_ACCEPT', 'C2_HANDOFF']) contains(brief, marker);
      contains(brief, (await readFile(join(f.root, 'conf/briefs/runners', `${runner.id}.md`), 'utf8')).trim());
      contains(brief, (await readFile(join(f.root, 'conf/briefs/tasks', `${stage}.md`), 'utf8')).trim());
      contains(brief, (await readFile(join(f.root, 'conf/briefs/completion.md'), 'utf8')).trim());
      for (const source of input.sources) contains(brief, source, 'precise source, selector, reason and trigger');
      const prose = withoutAssignmentJson(brief);
      contains(prose, `${input.rafCommand} agent message`, 'usable message command outside assignment JSON');
      contains(prose, '--to');
      contains(prose, '--text');
      contains(prose, `${input.rafCommand} agent ps`);
      assert.ok(prose.includes(`${input.rafCommand} help agent ps`) || prose.includes(`${input.rafCommand} agent ps --help`), 'Addressed help must be usable');
      assert.match(prose, /(?:ненульов|non.zero|exit code)/iu, 'Error handling must retain unsuccessful exit status');
      assert.match(brief, /(?:українськ|Ukrainian)/iu);
      assert.match(brief, /(?:атомар|atomic)/iu);
      assert.match(brief, /(?:skip_specs)/u);
      contains(brief, 'conf/raf-constants.json#/reportStatuses');
      assert.ok(!brief.includes('C2_UNRELATED_FULL_FLOW_BODY'));
      for (const other of models.runners as { id: string }[]) {
        if (other.id !== runner.id) assert.ok(!f.reads.includes(join(f.root, 'conf/briefs/runners', `${other.id}.md`)));
      }
      for (const other of stages) {
        if (other !== stage) assert.ok(!f.reads.includes(join(f.root, 'conf/briefs/tasks', `${other}.md`)));
      }
      assert.ok(!f.reads.includes(join(f.root, 'openspec/reading.md')), 'The full flow is not eagerly read');
      assert.ok(!f.reads.includes(join(f.root, 'conf/flow.json')), 'An on-demand timeout pointer is not an eager policy load');
      if (stage === 'test-scaffold') {
        contains(brief, 'feature-test-authoring');
        contains(brief, 'NotImplemented');
        assert.match(brief, /(?:сліп|blind)/iu);
        assert.match(brief, /(?:координатор|coordinator)/iu);
      }
      if (stage === 'implement') assert.match(brief, /(?:не читай підготовлені тести|do not read.*tests)/iu);
    });
  }
}

test('[C.2 catalogue] every requested command uses current parameters and metadata without dumping unrelated commands', async t => {
  const f = await fixture(t);
  const input = { ...briefInput(f.root, 'codex', 'coordinator'), rafSubcommands: ['agent run', 'agent update', 'runner list', 'agent message', 'agent ps'] };
  const brief = await composeAssignmentBrief(snapshot(f.root), input, f.fs);
  const prose = withoutAssignmentJson(brief);
  for (const path of input.rafSubcommands) {
    const command = constants.commands.find((entry: { path: string[] }) => entry.path.join(' ') === path);
    assert.ok(command, `Requested command ${path} must be catalogued`);
    contains(prose, `${input.rafCommand} ${path}`);
    contains(prose, command.description);
    for (const parameter of command.parameters) {
      contains(prose, parameter.option);
      contains(prose, parameter.description, `${path} ${parameter.option} contract`);
    }
    contains(prose, command.output);
    contains(prose, command.errors);
    contains(prose, command.prerequisites);
    contains(prose, command.sideEffects);
  }
  assert.ok(!prose.includes('--runner'), 'No fabricated runner switch');
  const unrequested = constants.commands.find((entry: { path: string[] }) => entry.path[0] === 'bug');
  if (unrequested) assert.ok(!prose.includes(unrequested.description), 'No complete CLI catalogue dump');
});

test('[C.2 catalogue] a catalogue edit changes generated guide, required/multiple semantics and resolved values', async t => {
  const f = await fixture(t);
  const edited = structuredClone(constants);
  const message = edited.commands.find((entry: { path: string[] }) => entry.path.join(' ') === 'agent message');
  message.description = 'C2_FRESH_COMMAND_DESCRIPTION';
  message.parameters.find((parameter: { name: string }) => parameter.name === 'text').option = '--c2-body';
  message.parameters.push({ name: 'tag', option: '--c2-tag', required: true, multiple: true, description: 'C2_REQUIRED_REPEATABLE_TAG' });
  message.valueSources = { tag: 'raf-constants.json#/c2Tags' };
  edited.c2Tags = [{ id: 'c2-tag-value', description: 'C2_RESOLVED_VALUE' }];
  message.examples = ['raf agent message --to main --c2-body hello --c2-tag c2-tag-value'];
  await put(f.root, 'conf/raf-constants.json', JSON.stringify(edited));
  const input = briefInput(f.root);
  const brief = await composeAssignmentBrief(snapshot(f.root), input, f.fs);
  const prose = withoutAssignmentJson(brief);
  for (const marker of ['C2_FRESH_COMMAND_DESCRIPTION', '--c2-body', '--c2-tag', 'C2_REQUIRED_REPEATABLE_TAG', 'c2-tag-value']) contains(prose, marker);
  assert.match(prose, /(?:обов[’ʼ']?язков|required)/iu);
  assert.match(prose, /(?:кілька|множин|повтор|multiple|repeat)/iu);
  assert.ok(!prose.includes('--text'), 'Superseded option is not shown');
});

for (const axis of ['runner', 'stage'] as const) {
  test(`[C.2 validation] safe but unregistered ${axis} is rejected even when a matching template exists`, async t => {
    const f = await fixture(t);
    const input = { ...briefInput(f.root), [axis]: 'c2-unregistered', ...(axis === 'stage' ? { phase: 'c2-unregistered' } : {}) };
    await put(f.root, `conf/briefs/${axis === 'runner' ? 'runners' : 'tasks'}/c2-unregistered.md`, 'C2_UNREGISTERED_TEMPLATE');
    await assert.rejects(() => composeAssignmentBrief(snapshot(f.root), input, f.fs), error => {
      contains(String(error), 'c2-unregistered');
      return true;
    });
  });
}

test('[C.2 validation] inconsistent stage and phase do not silently select another task', async t => {
  const f = await fixture(t);
  const input = { ...briefInput(f.root), phase: 'implement' };
  await assert.rejects(() => composeAssignmentBrief(snapshot(f.root), input, f.fs), /(?:stage|phase|стаді|фаз)/iu);
});

test('[C.2 validation] missing cwd is diagnosed instead of substituting OpenSpec root', async t => {
  const f = await fixture(t);
  const input: AssignmentBriefContext = briefInput(f.root);
  delete (input as Partial<BriefInput>).cwd;
  await assert.rejects(() => composeAssignmentBrief(snapshot(f.root), input, f.fs), /(?:cwd|робоч|working)/iu);
});

test('[C.2 validation] a missing requested command is diagnosed rather than inventing a recipe', async t => {
  const f = await fixture(t);
  const input = { ...briefInput(f.root), rafSubcommands: ['agent c2-unknown'] };
  await assert.rejects(() => composeAssignmentBrief(snapshot(f.root), input, f.fs), /c2-unknown/u);
});

test('[C.2 identity] identical item numbers from different changes retain exact authoritative descriptions', async t => {
  const f = await fixture(t);
  const selected = snapshot(f.root, [
    { id: 'first-change', items: [{ id: '1.1', description: 'C2_FIRST_AUTHORITATIVE' }] },
    { id: 'second-change', items: [{ id: '1.1', description: 'C2_SECOND_AUTHORITATIVE' }] },
  ]);
  const input = { ...briefInput(f.root), features: selected.changes.map(change => change.id) };
  const brief = await composeAssignmentBrief(selected, input, f.fs);
  assert.deepEqual(assignmentJson(brief).assignments, selected.changes);
});

async function broadChange(f: Awaited<ReturnType<typeof fixture>>) {
  for (const name of ['git-sandbox-design.md', 'quota-design.md', 'command-output-design.md', 'transport-design.md']) {
    await put(f.root, `openspec/changes/wide-change/${name}`, `# ${name}\n## Потрібний контракт\nУмови ${name}\n`);
  }
  await put(f.root, 'openspec/changes/wide-change/specs/projects/raf/model-routing/spec.md', '### Requirement: Попередження версії в огляді виконавців\n#### Scenario: Огляд\n- WHEN запитано огляд\n- THEN показано версію\n');
  await put(f.root, 'openspec/changes/wide-change/specs/projects/raf/quota/spec.md', 'C2_UNSELECTED_QUOTA_DELTA');
  await put(f.root, 'openspec/specs/projects/orchestrator/parallel-development/spec.md', '### Requirement: Коміти в спільному робочому дереві\n#### Scenario: Власні шляхи\nЛише власні шляхи\n');
  const allItems = [
    { id: 'H.1', description: '[hotfix] Виправити Git permissions без зміни quota' },
    { id: 'Z.341', description: '[test-scaffold] Версії CLI та передумови fixture' },
    { id: 'Q.1', description: '[implement] Змінити quota і транспорт' },
  ];
  await change(f, 'wide-change', allItems, [
    '- H.1: `openspec/changes/wide-change/git-sandbox-design.md` — секція «Потрібний контракт»; причина C2_GIT_SAFETY; читати зараз. `openspec/specs/projects/orchestrator/parallel-development/spec.md` — вимога «Коміти в спільному робочому дереві» зі сценаріями; причина C2_OWN_COMMITS; читати перед власним комітом.',
    '- Z.341: `openspec/changes/wide-change/specs/projects/raf/model-routing/spec.md` — вимога «Попередження версії в огляді виконавців» зі сценаріями; причина C2_VERSION; читати зараз.',
    '- Q.1: `openspec/changes/wide-change/quota-design.md`, `openspec/changes/wide-change/command-output-design.md`, `openspec/changes/wide-change/transport-design.md`, `openspec/changes/wide-change/specs/projects/raf/quota/spec.md` — причина C2_OTHER_ITEM; читати зараз.',
  ]);
  return allItems;
}

for (const phase of ['hotfix', 'test-scaffold', 'implement', 'spec']) {
  test(`[C.2 sources 59a2e199/d283bd7a] ${phase} one Git item excludes other quota/transport/design/delta`, async t => {
    const f = await fixture(t);
    const items = await broadChange(f);
    const context = await derive(f, [{ id: 'wide-change', items: [items[0]] }], phase);
    for (const excluded of ['quota-design.md', 'transport-design.md', 'command-output-design.md', '/quota/spec.md', '/model-routing/spec.md', 'C2_OTHER_ITEM']) {
      assert.ok(!context.sources.join('\n').includes(excluded), `Unselected ${excluded} must not become required context`);
    }
    const git = sourceFor(context.sources, join(f.root, 'openspec/changes/wide-change/git-sandbox-design.md'));
    for (const marker of ['Потрібний контракт', 'C2_GIT_SAFETY', 'читати зараз']) contains(git, marker);
    const commits = sourceFor(context.sources, join(f.root, 'openspec/specs/projects/orchestrator/parallel-development/spec.md'));
    for (const marker of ['Коміти в спільному робочому дереві', 'C2_OWN_COMMITS', 'перед власним комітом']) contains(commits, marker);
  });
}

test('[C.2 sources 59a2e199] cron test-scaffold keeps audit/test-budget contract without unrelated worker/quality delta', async t => {
  const f = await fixture(t);
  const base = 'openspec/changes/cron-work';
  for (const file of ['test-budget-measurement-design.md', 'cron-audit.md', 'specs/projects/raf/worker-test-runtime/spec.md', 'specs/projects/raf/quality-attributes/spec.md']) {
    await put(f.root, `${base}/${file}`, `# ${file}\n## Cron\nПоведінка cron\n`);
  }
  const authoring = 'openspec/specs/core/process/feature-test-authoring/spec.md';
  await put(f.root, authoring, '### Requirement: Агент тестів і каркаса\n#### Scenario: Передача до реалізації\nСліпий режим; red виконує координатор\n');
  const items = ['3.11', '3.14', '3.15'].map(id => ({ id, description: '[test-scaffold] Cron без штучного бюджету' }));
  const selected = await change(f, 'cron-work', [...items, { id: '4.1', description: '[implement] Інший runtime' }], [
    ...items.map(item => `- ${item.id}: \`${base}/test-budget-measurement-design.md\` — секція «Cron»; причина C2_CRON_BUDGET; читати зараз. \`${base}/cron-audit.md\` — секція «Cron»; причина C2_CRON_AUDIT; читати зараз. \`${authoring}\` — вимога «Агент тестів і каркаса» зі сценаріями; причина C2_BLIND; читати зараз.`),
    `- 4.1: \`${base}/specs/projects/raf/worker-test-runtime/spec.md\`, \`${base}/specs/projects/raf/quality-attributes/spec.md\` — інший пункт; читати зараз.`,
  ]);
  const context = await derive(f, [{ ...selected, items }], 'test-scaffold');
  for (const excluded of ['worker-test-runtime', 'quality-attributes']) assert.ok(!context.sources.join('\n').includes(excluded), `Unselected cron ${excluded} must not become required context`);
  for (const file of ['test-budget-measurement-design.md', 'cron-audit.md']) sourceFor(context.sources, join(f.root, base, file));
  const blind = sourceFor(context.sources, join(f.root, authoring));
  contains(blind, 'Агент тестів і каркаса');
  contains(blind, 'читати зараз');
});

test('[C.2 sources dependency] erase-by-email keeps identity normalization and wait-rule keeps full signature/limits', async t => {
  const f = await fixture(t);
  const paths = {
    identity: 'openspec/specs/platforms/web/identity/spec.md',
    limits: 'openspec/specs/core/design-system/wait-limits/spec.md',
    contract: 'openspec/changes/dependency-work/wait-contract.md',
  };
  await put(f.root, paths.identity, '### Requirement: Первинний ключ — внутрішній ідентифікатор\n#### Scenario: Перший вхід\nНормалізація email\n');
  await put(f.root, paths.limits, '### Requirement: Межі очікування\n#### Scenario: Ліміт\nОбмежити очікування\n');
  await put(f.root, paths.contract, '## Погоджена сигнатура\nexport async function waitForReady(id: string, signal: AbortSignal): Promise<void>;\n');
  const items = [{ id: 'E.1', description: '[implement] Erase за email' }, { id: 'W.1', description: '[implement] Wait-rule' }];
  const selected = await change(f, 'dependency-work', items, [
    `- E.1: \`${paths.identity}\` — вимога «Первинний ключ — внутрішній ідентифікатор», сценарій «Перший вхід»; причина C2_EMAIL_NORMALIZATION; читати зараз.`,
    `- W.1: \`${paths.limits}\` — вимога «Межі очікування» зі сценаріями; причина C2_WAIT_LIMITS; читати зараз. \`${paths.contract}\` — секція «Погоджена сигнатура»; причина C2_FULL_SIGNATURE; читати до реалізації.`,
  ]);
  const context = await derive(f, [selected], 'implement');
  const identity = sourceFor(context.sources, join(f.root, paths.identity));
  for (const marker of ['Первинний ключ — внутрішній ідентифікатор', 'Перший вхід', 'C2_EMAIL_NORMALIZATION']) contains(identity, marker);
  contains(sourceFor(context.sources, join(f.root, paths.limits)), 'C2_WAIT_LIMITS');
  contains(sourceFor(context.sources, join(f.root, paths.contract)), 'Погоджена сигнатура');
});

test('[C.2 sources union] multiple selected items union exact sources without expanding to the entire change', async t => {
  const f = await fixture(t);
  const items = await broadChange(f);
  const context = await derive(f, [{ id: 'wide-change', items: items.slice(0, 2) }], 'test-scaffold');
  for (const excluded of ['quota-design.md', 'transport-design.md', 'command-output-design.md', '/quota/spec.md']) assert.ok(!context.sources.join('\n').includes(excluded), `Union must not include unselected ${excluded}`);
  sourceFor(context.sources, join(f.root, 'openspec/changes/wide-change/git-sandbox-design.md'));
  contains(sourceFor(context.sources, join(f.root, 'openspec/changes/wide-change/specs/projects/raf/model-routing/spec.md')), 'Попередження версії в огляді виконавців');
});

test('[C.2 sources union] same item ID in different changes keeps both selectors and conditions for a shared dependency', async t => {
  const f = await fixture(t);
  const shared = 'openspec/specs/projects/raf/shared-contract/spec.md';
  await put(f.root, shared, '### Requirement: Запис\n#### Scenario: Записати\nЗапис\n### Requirement: Читання\n#### Scenario: Прочитати\nЧитання\n');
  const first = await change(f, 'first-change', [{ id: '1.1', description: '[implement] Запис' }], [
    `- 1.1: \`${shared}\` — вимога «Запис» зі сценаріями; причина C2_WRITE_DEPENDENCY; читати зараз.`,
  ]);
  const second = await change(f, 'second-change', [{ id: '1.1', description: '[implement] Читання' }], [
    `- 1.1: \`${shared}\` — вимога «Читання» зі сценаріями; причина C2_READ_DEPENDENCY; читати коли перевіряєш читання.`,
  ]);
  const context = await derive(f, [first, second], 'implement');
  const sharedSource = sourceFor(context.sources, join(f.root, shared));
  for (const marker of ['Запис', 'Читання', 'C2_WRITE_DEPENDENCY', 'C2_READ_DEPENDENCY', 'читати зараз', 'коли перевіряєш читання']) contains(sharedSource, marker);
});

test('[C.2 sources fallback] no explicit row gives task/proposal navigation rather than all design/delta', async t => {
  const f = await fixture(t);
  const items = await broadChange(f);
  const selected = await change(f, 'wide-change', [items[0]], []);
  const context = await derive(f, [selected], 'hotfix');
  for (const excluded of ['quota-design.md', 'transport-design.md', 'command-output-design.md', 'git-sandbox-design.md', '/quota/spec.md']) assert.ok(!context.sources.join('\n').includes(excluded), `Fallback must not require ${excluded}`);
  sourceFor(context.sources, join(f.root, 'openspec/changes/wide-change/tasks.md'));
  sourceFor(context.sources, join(f.root, 'openspec/changes/wide-change/proposal.md'));
});

