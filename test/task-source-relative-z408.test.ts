import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deriveTaskContext, type DerivedTaskContext, type TaskContextRequest } from '../src/task-context.ts';

const suffix = 'projects/raf/z408-contract/spec.md';
const canonical = `openspec/specs/${suffix}`;
const delta = (change: string): string => `openspec/changes/${change}/specs/${suffix}`;
const relative = (change: string): string => `../${change}/specs/${suffix}`;
const syntaxes = ['markdown', 'backtick'] as const;
type Syntax = typeof syntaxes[number];
type Selection = TaskContextRequest['assignment']['changes'][number];

function link(path: string, syntax: Syntax): string {
  return syntax === 'markdown' ? `[контракт](${path})` : `\`${path}\``;
}

async function fixture(
  t: TestContext,
  changes: readonly Selection[],
  files: readonly string[],
): Promise<{ root: string; request: TaskContextRequest }> {
  const root = await mkdtemp(join(tmpdir(), 'raf-z408-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path: string, body: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  };
  for (const change of changes) {
    await write(`openspec/changes/${change.id}/tasks.md`, [
      '# Tasks',
      ...change.items.map(item => `- [ ] ${item.id} ${item.description}`),
      '- [ ] 99.99 [невибраний](../unselected/specs/missing/spec.md)',
    ].join('\n'));
    await write(`openspec/changes/${change.id}/proposal.md`, '## Why\nIsolated Z.408 contract.\n## What Changes\nTask-relative sources.\n');
    await write(`openspec/changes/${change.id}/specs/unrelated/spec.md`, '# Unselected delta\n');
    await write(`openspec/changes/${change.id}/unrelated-design.md`, '# Unselected design\n');
  }
  for (const file of files) {
    await write(file, '### Requirement: Контракт\n### Requirement: Інший\n');
  }
  await mkdir(join(root, 'raf-develop'), { recursive: true });
  await mkdir(join(root, 'elsewhere'), { recursive: true });
  return {
    root,
    request: {
      root,
      configuration: {
        projects: {
          profiles: { product: { development: 'develop' } },
          projects: { raf: { path: 'raf', profile: 'product', branchPaths: { develop: 'raf-develop' } } },
        },
        reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }],
        resources: {},
      },
      parameters: {
        id: 'z408-unit', type: 'implement', project: 'raf', phase: 'implement', complexity: 'small',
        features: changes.map(change => change.id),
        tasks: changes.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)),
      },
      assignment: { root, changes, baselineArchives: [] },
    },
  };
}

function entries(context: DerivedTaskContext, root: string, path: string): readonly string[] {
  const absolute = join(root, path);
  return context.sources.filter(source => source.startsWith(absolute)
    && (source.length === absolute.length || /[#\s]/u.test(source[absolute.length]!)));
}

function source(context: DerivedTaskContext, root: string, path: string, tokens: readonly string[]): string {
  const found = entries(context, root, path);
  assert.equal(found.length, 1, `Expected one exact file source ${path}: ${JSON.stringify(context.sources)}`);
  for (const token of tokens) assert.ok(found[0]!.includes(token), `Lost source condition ${token}: ${found[0]}`);
  return found[0]!;
}

function onlySources(context: DerivedTaskContext, root: string, paths: readonly string[]): void {
  const unmatched = context.sources.filter(entry => !paths.some(path => entries({ ...context, sources: [entry] }, root, path).length === 1));
  assert.deepEqual(unmatched, [], 'Relative normalization must not add unrelated sources or retain an unresolved address');
}

function navigation(changes: readonly string[]): string[] {
  return changes.flatMap(change => [`openspec/changes/${change}/tasks.md`, `openspec/changes/${change}/proposal.md`]);
}

async function underCwd<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  try {
    process.chdir(cwd);
    return await action();
  } finally {
    process.chdir(original);
  }
}

test('Z408 S01: own relative delta resolves from tasks.md in both explicit syntaxes without canonical', async t => {
  for (const syntax of syntaxes) await t.test(syntax, async t => {
    const f = await fixture(t, [{ id: 'change-a', items: [{ id: '11.1', description: link(`${relative('change-a')}#requirement-контракт`, syntax) }] }], [delta('change-a')]);
    const context = await deriveTaskContext(f.request);
    source(context, f.root, delta('change-a'), ['11.1', '#requirement-контракт']);
    onlySources(context, f.root, [...navigation(['change-a']), delta('change-a')]);
  });
});

test('Z408 S02: dependency delta is the sole target in both syntaxes despite same-name alternatives', async t => {
  for (const syntax of syntaxes) await t.test(syntax, async t => {
    const f = await fixture(t, [{ id: 'change-a', items: [{ id: '12.1', description: link(relative('change-b'), syntax) }] }], [delta('change-a'), delta('change-b'), canonical]);
    const context = await deriveTaskContext(f.request);
    source(context, f.root, delta('change-b'), ['12.1']);
    onlySources(context, f.root, [...navigation(['change-a']), delta('change-b')]);
    assert.deepEqual(f.request.parameters.tasks, ['change-a:12.1'], 'Reading dependency delta does not assign its tasks');
  });
});

test('Z408 S03: each selected change retains its source attribution across cwd and selection order', async t => {
  const changes: readonly Selection[] = [
    { id: 'change-a', items: [{ id: '13.1', description: link(`${relative('change-a')}#requirement-контракт`, 'markdown') }] },
    { id: 'change-b', items: [{ id: '14.1', description: link(`${relative('change-b')}#requirement-інший`, 'backtick') }] },
  ];
  const f = await fixture(t, changes, [delta('change-a'), delta('change-b')]);
  let baseline: string[] | undefined;
  for (const cwd of [f.root, join(f.root, 'raf-develop'), join(f.root, 'elsewhere')]) {
    for (const selected of [changes, [...changes].reverse()]) {
      const request: TaskContextRequest = {
        ...f.request,
        parameters: { ...f.request.parameters, features: selected.map(change => change.id), tasks: selected.flatMap(change => change.items.map(item => `${change.id}:${item.id}`)) },
        assignment: { ...f.request.assignment, changes: selected },
      };
      const context = await underCwd(cwd, () => deriveTaskContext(request));
      const exact = [
        source(context, f.root, delta('change-a'), ['13.1', '#requirement-контракт']),
        source(context, f.root, delta('change-b'), ['14.1', '#requirement-інший']),
      ].sort();
      assert.ok(!exact[0]!.includes('14.1') && !exact[1]!.includes('13.1'), 'Each reason belongs to its selected item');
      onlySources(context, f.root, [...navigation(['change-a', 'change-b']), delta('change-a'), delta('change-b')]);
      if (baseline) assert.deepEqual(exact, baseline);
      else baseline = exact;
    }
  }
});

test('Z408 S04: relative and root-relative addresses deduplicate without losing selectors or item reasons', async t => {
  for (const syntax of syntaxes) await t.test(syntax, async t => {
    const f = await fixture(t, [{ id: 'change-a', items: [
      { id: '15.1', description: link(`${relative('change-a')}#requirement-контракт`, syntax) },
      { id: '15.2', description: link(`${delta('change-a')}#requirement-інший`, syntax === 'markdown' ? 'backtick' : 'markdown') },
    ] }], [delta('change-a')]);
    const context = await deriveTaskContext(f.request);
    source(context, f.root, delta('change-a'), ['15.1', '15.2', '#requirement-контракт', '#requirement-інший']);
    onlySources(context, f.root, [...navigation(['change-a']), delta('change-a')]);
  });
});

test('Z408 S05: relative-looking prose commands fences and link labels do not widen source selection', async t => {
  const ignored = relative('not-a-source');
  const f = await fixture(t, [{ id: 'change-a', items: [{ id: '16.1', description: [
    `Звичайна згадка ${ignored}`,
    `\`cat ${ignored}\``,
    `\`пояснення ${ignored}\``,
    `\`\`\`sh\ncat ${ignored}\n\`\`\``,
    `[${ignored}](#local-heading)`,
    `[${ignored}](${delta('change-a')}#requirement-контракт)`,
    `\`../change-b/conf/secret.json\``,
    `\`../change-b/specs/../../conf/secret.json\``,
  ].join('\n') }] }], [delta('change-a'), 'openspec/changes/change-b/conf/secret.json', 'openspec/changes/conf/secret.json']);
  const context = await deriveTaskContext(f.request);
  source(context, f.root, delta('change-a'), ['16.1', '#requirement-контракт']);
  onlySources(context, f.root, [...navigation(['change-a']), delta('change-a')]);
});
