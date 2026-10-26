import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  deriveTaskContext,
  type DerivedTaskContext,
  type TaskContextConfiguration,
  type TaskContextRequest,
} from '../src/task-context.ts';

const change = 'z397-source-fixture';
const changeDirectory = `openspec/changes/${change}`;
const contract = 'openspec/specs/projects/raf/agent-run/spec.md';
const changeContract = `${changeDirectory}/specs/projects/raf/agent-run/spec.md`;
const configurationFile = 'conf/raf.json';
const skill = 'skills/start/SKILL.md';
const missingFile = 'conf/z397-missing.json';
const shaMention = 'conf/0123456789abcdef0123456789abcdef01234567';

interface Item {
  readonly id: string;
  readonly description: string;
}

interface Fixture {
  readonly root: string;
  readonly request: TaskContextRequest;
}

async function fixture(
  t: TestContext,
  items: readonly Item[],
  options: {
    readonly unselected?: readonly Item[];
    readonly stageSources?: string;
    readonly omittedFiles?: readonly string[];
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'raf-z397-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files: Readonly<Record<string, string>> = {
    [`${changeDirectory}/tasks.md`]: [
      '# Tasks',
      ...[...items, ...(options.unselected ?? [])].map(item => `- [ ] ${item.id} ${item.description}`),
      options.stageSources ? `\n## Джерела за етапом\n\n${options.stageSources}` : '',
      '',
    ].join('\n'),
    [`${changeDirectory}/proposal.md`]: '## Why\nIsolated source-selection contract.\n## What Changes\nZ.397.\n',
    [`${changeDirectory}/unrelated-design.md`]: '# Unselected design\n',
    [`${changeDirectory}/specs/projects/raf/unrelated/spec.md`]: '# Unselected delta\n',
    [contract]: '# Contract\n## Requirement: Контракт\n## Requirement: Інший\n',
    [changeContract]: '# Change contract\n## Requirement: Контракт\n',
    [configurationFile]: '{}\n',
    [skill]: '# Skill\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    if (options.omittedFiles?.includes(relative)) continue;
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const configuration: TaskContextConfiguration = {
    projects: {
      profiles: { product: { development: 'develop' } },
      projects: {
        raf: { path: 'raf', profile: 'product', branchPaths: { develop: 'raf-develop' } },
      },
    },
    reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }],
    resources: {},
  };
  return {
    root,
    request: {
      root,
      configuration,
      parameters: {
        id: 'z397-unit', type: 'implement', project: 'raf', features: [change],
        phase: 'implement', complexity: 'small', tasks: items.map(item => `${change}:${item.id}`),
      },
      assignment: { root, changes: [{ id: change, items }], baselineArchives: [] },
    },
  };
}

function sourcesFor(context: DerivedTaskContext, root: string, relative: string): readonly string[] {
  const path = join(root, relative);
  return context.sources.filter(source => source.startsWith(path)
    && (source.length === path.length || /[#\s]/u.test(source[path.length]!)));
}

function requireSource(context: DerivedTaskContext, root: string, relative: string): string {
  const matches = sourcesFor(context, root, relative);
  assert.equal(matches.length, 1, `Expected exactly one source for ${relative}: ${JSON.stringify(context.sources)}`);
  return matches[0]!;
}

function requireNoSource(context: DerivedTaskContext, root: string, relative: string): void {
  assert.deepEqual(sourcesFor(context, root, relative), [], `Unexpected source for ${relative}`);
}

function requireNarrowNavigation(context: DerivedTaskContext, root: string): void {
  requireSource(context, root, `${changeDirectory}/tasks.md`);
  requireSource(context, root, `${changeDirectory}/proposal.md`);
  requireNoSource(context, root, `${changeDirectory}/unrelated-design.md`);
  requireNoSource(context, root, `${changeDirectory}/specs/projects/raf/unrelated/spec.md`);
}

test('Z397 S01: plain conf/SHA is text and preserves narrow fallback', async t => {
  const f = await fixture(t, [{ id: '1.1', description: `Звірити ${shaMention} після виправлення` }]);
  const context = await deriveTaskContext(f.request);
  requireNoSource(context, f.root, shaMention);
  requireNarrowNavigation(context, f.root);
});

test('Z397 S02: even existing unformatted paths are not sources', async t => {
  const f = await fixture(t, [{ id: '1.1', description: `Звірити ${configurationFile} та ${contract}.` }]);
  const context = await deriveTaskContext(f.request);
  requireNoSource(context, f.root, configurationFile);
  requireNoSource(context, f.root, contract);
  requireNarrowNavigation(context, f.root);
});

test('Z397 S03: a local Markdown target becomes a source with its item reason', async t => {
  const f = await fixture(t, [{ id: '1.1', description: `Перевірити [контракт](${contract})` }]);
  const context = await deriveTaskContext(f.request);
  const source = requireSource(context, f.root, contract);
  assert.match(source, /1\.1/u, 'The source must retain its selected-item attribution');
});

test('Z397 S04: a file-like link label is not checked as another source', async t => {
  const f = await fixture(t, [{ id: '1.1', description: `[conf/not-a-source.json](${configurationFile})` }]);
  const context = await deriveTaskContext(f.request);
  requireSource(context, f.root, configurationFile);
  requireNoSource(context, f.root, 'conf/not-a-source.json');
});

for (const [label, path, expected] of [
  ['conf', configurationFile, configurationFile],
  ['openspec', contract, contract],
  ['skills', skill, skill],
  ['specs alias with selector', 'specs/projects/raf/agent-run/spec.md#requirement-контракт', contract],
] as const) {
  test(`Z397 S05: whole inline path supports ${label}`, async t => {
    const f = await fixture(t, [{ id: '1.1', description: `Читати \`${path}\`` }]);
    const context = await deriveTaskContext(f.request);
    const source = requireSource(context, f.root, expected);
    if (path.includes('#')) assert.ok(source.includes('#requirement-контракт'), 'Preserve the selector');
  });
}

for (const [label, description] of [
  ['inline command', '`node bin/raf.ts --config conf/raf.json`'],
  ['command targeting a missing file', '`node bin/raf.ts --config conf/z397-missing.json`'],
  ['fenced code', 'Приклад:\n```text\nconf/raf.json\nconf/z397-missing.json\n```'],
  ['fenced explicit syntax', 'Приклад:\n```markdown\n[джерело](conf/raf.json)\n`conf/z397-missing.json`\n```'],
  ['tilde fenced code', 'Приклад:\n~~~text\nconf/raf.json\n~~~'],
  ['external URL', '[сайт](https://example.invalid/conf/raf.json)'],
  ['anchor', '[розділ](#conf/raf.json)'],
  ['URL in inline code', '`https://example.invalid/conf/raf.json`'],
] as const) {
  test(`Z397 S06: ${label} does not supply local sources`, async t => {
    const f = await fixture(t, [{ id: '1.1', description }]);
    const context = await deriveTaskContext(f.request);
    requireNoSource(context, f.root, configurationFile);
    requireNoSource(context, f.root, missingFile);
    requireNarrowNavigation(context, f.root);
  });
}

for (const description of [
  '`згадка conf/raf.json`',
  '`conf/raf.json та skills/start/SKILL.md`',
  '`згадка conf/z397-missing.json`',
]) {
  test(`Z397 S07: a code span containing an explanation is not a whole path: ${description}`, async t => {
    const f = await fixture(t, [{ id: '1.1', description }]);
    const context = await deriveTaskContext(f.request);
    for (const path of [configurationFile, skill, missingFile]) requireNoSource(context, f.root, path);
    requireNarrowNavigation(context, f.root);
  });
}

test('Z397 S08: deduplicate a file without losing selectors or selected-item reasons', async t => {
  const f = await fixture(t, [
    { id: '1.1', description: `[перший контракт](${contract}#requirement-контракт)` },
    { id: '1.2', description: `Читати \`${contract}#requirement-інший\`` },
  ]);
  const context = await deriveTaskContext(f.request);
  const source = requireSource(context, f.root, contract);
  for (const condition of ['#requirement-контракт', '#requirement-інший', '1.1', '1.2']) {
    assert.ok(source.includes(condition), `Lost selector or item attribution: ${condition}`);
  }
});

test('Z397 S10: union only selected items and ignore missing sources of unselected items', async t => {
  const f = await fixture(t, [
    { id: '1.1', description: `[контракт](${contract})` },
    { id: '1.2', description: `Звірити ${shaMention} після виправлення` },
  ], {
    unselected: [{ id: '1.3', description: `[не вибране джерело](${missingFile})` }],
  });
  const context = await deriveTaskContext(f.request);
  requireSource(context, f.root, contract);
  requireNoSource(context, f.root, shaMention);
  requireNoSource(context, f.root, missingFile);
  requireNarrowNavigation(context, f.root);
});

test('Z397 S11: explicit stage sources survive when the description has no links', async t => {
  const f = await fixture(t, [{ id: '1.1', description: `Звірити ${shaMention} після виправлення` }], {
    stageSources: `- **Implement 1.1:** [контракт](${contract}#requirement-контракт); причина: зберегти адресну умову читання.`,
  });
  const context = await deriveTaskContext(f.request);
  const source = requireSource(context, f.root, contract);
  assert.ok(source.includes('#requirement-контракт'), 'Keep the stage selector');
  requireNoSource(context, f.root, shaMention);
  requireNoSource(context, f.root, `${changeDirectory}/unrelated-design.md`);
  requireNoSource(context, f.root, `${changeDirectory}/specs/projects/raf/unrelated/spec.md`);
});

for (const [syntax, description] of [
  ['Markdown', '[контракт](specs/projects/raf/agent-run/spec.md#requirement-контракт)'],
  ['backticks', '`specs/projects/raf/agent-run/spec.md#requirement-контракт`'],
] as const) {
  test(`Z397 S12: ${syntax} specs alias selects canonical despite a matching change delta`, async t => {
    const f = await fixture(t, [{ id: '1.1', description }]);
    const context = await deriveTaskContext(f.request);
    const source = requireSource(context, f.root, contract);
    assert.ok(source.includes('#requirement-контракт'));
    requireNoSource(context, f.root, changeContract);
  });

}

for (const [syntax, description] of [
  ['Markdown', `[delta](${changeContract})`],
  ['backticks', `\`${changeContract}\``],
] as const) {
  test(`Z397 S12: ${syntax} can explicitly select the change delta without a canonical file`, async t => {
    const f = await fixture(t, [{ id: '1.1', description }], { omittedFiles: [contract] });
    const context = await deriveTaskContext(f.request);
    requireSource(context, f.root, changeContract);
    requireNoSource(context, f.root, contract);
  });
}
