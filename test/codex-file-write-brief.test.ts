import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { composeAssignmentBrief, type AssignmentBriefContext, type AssignmentSnapshot } from '../src/assignment.ts';

const configuration = new URL('../../conf/', import.meta.url);
const flow = JSON.parse(await readFile(new URL('flow.json', configuration), 'utf8'));
const timeout = flow.unitTests.timeoutMs;
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
const fileSection = /Окремі файли поза дозволеними теками\s*:/iu;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-z369-brief-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const confRoot = join(root, 'conf');
  const cwd = join(root, 'raf-develop');
  const change = join(root, 'openspec', 'changes', 'assigned-change');
  const runDirectory = join(root, 'runs', 'own');
  const files = [
    join(root, 'questions', 'projects', 'project with spaces', 'questions.md'),
    join(root, 'outside workspace', 'owner\'s "review".md'),
    join(root, 'another directory', 'ordinary.txt'),
  ];
  const covered = join(change, 'covered document.md');
  const unassigned = join(dirname(files[0]), 'unassigned.md');
  await Promise.all([confRoot, cwd, change, runDirectory, ...files.map(dirname)].map(path => mkdir(path, { recursive: true })));
  await Promise.all([...files, covered, unassigned].map(path => writeFile(path, 'original\n')));
  await cp(new URL('briefs/', configuration), join(confRoot, 'briefs'), { recursive: true });
  for (const name of ['raf-constants.json', 'models.json']) await cp(new URL(name, configuration), join(confRoot, name));
  const snapshot: AssignmentSnapshot = {
    root, changes: [{ id: 'assigned-change', items: [{ id: '1.1', description: 'Write only assigned documents' }] }], baselineArchives: [],
  };
  const compose = async (runner: 'codex' | 'claude', stage: 'spec' | 'implement', boundaries: readonly string[]) => {
    const context: AssignmentBriefContext = {
      cwd, briefsRoot: join(confRoot, 'briefs'), runner, stage, project: 'raf', agentId: 'z369-brief', sessionName: 'z369-brief',
      features: ['assigned-change'], phase: stage, outcome: 'Write only assigned documents',
      writeBoundaries: boundaries, sources: [], reportPath: join(runDirectory, 'z369-brief.json'),
      reportSchema: { type: 'object', required: ['status', 'answer', 'changes'] },
      rafCommand: 'node /synthetic/raf-main/bin/raf.ts', rafSubcommands: ['agent message', 'agent ps'],
      workspaceWritable: stage === 'implement',
    };
    const brief = await composeAssignmentBrief(snapshot, context, { readText: path => readFile(path, 'utf8') });
    const heading = brief.indexOf('# Конкретне доручення');
    assert.ok(heading >= 0, 'production brief contains its assignment');
    const json = brief.indexOf('{', heading);
    assert.ok(json >= 0, 'production brief contains the JSON assignment envelope');
    const payload = JSON.parse(brief.slice(json));
    assert.deepEqual(payload.write_boundaries, boundaries, 'the exact launch boundaries survive composition');
    return { prose: brief.slice(0, json), payload };
  };
  return { root, cwd, change, runDirectory, files, covered, unassigned, compose };
}

function instruction(prose: string): string {
  const match = fileSection.exec(prose);
  assert.ok(match, 'Codex production brief must explicitly explain standalone file boundaries');
  const tail = prose.slice(match.index);
  const nextHeading = tail.search(/\n#{1,6}\s/u);
  return nextHeading < 0 ? tail : tail.slice(0, nextHeading);
}

function mentions(text: string, path: string): boolean {
  return text.includes(path) || text.includes(JSON.stringify(path));
}

for (const stage of ['spec', 'implement'] as const) {
  test(`[Z.369 brief] ${stage}: real Codex brief names exact standalone files and sandbox shell in-place writes`, { timeout }, async t => {
    const f = await fixture(t);
    const directories = stage === 'implement' ? [f.cwd, f.change] : [f.change];
    const boundaries = [...directories, ...f.files, f.covered];
    const { prose, payload } = await f.compose('codex', stage, boundaries);
    const text = instruction(prose);
    for (const file of f.files) assert.ok(mentions(text, file), `standalone instruction names actual boundary ${file}`);
    for (const path of [f.covered, f.unassigned, join(f.root, 'questions', 'projects', 'raf', 'questions.md')]) {
      assert.equal(mentions(text, path), false, `standalone instruction must not invent or misclassify ${path}`);
    }
    assert.match(text, /shell|оболонк/iu, 'use a shell command');
    assert.match(text, /пісочниц|sandbox/iu, 'shell remains sandboxed');
    assert.match(text, /відкрива[^\n]*(?:сам|безпосеред)[^\n]*файл|open[^\n]*(?:file itself|file directly)|in.place/iu, 'open the bound file itself for an in-place write');
    assert.match(text, /apply_patch[^\n]*(?:не має|немає|не підтрим|недоступ|no native|cannot)|(?:не має|немає|недоступ)[^\n]*apply_patch/iu, 'explain the missing native apply_patch permission');
    assert.match(text, /тимчасов[^\n]*сусід|temporary[^\n]*sibling/iu, 'mention the unsupported temporary sibling');
    assert.match(text, /rename[^\n]*(?:не підтрим|не дозвол|unsupported|not supported)|(?:не підтрим|не дозвол|unsupported)[^\n]*rename/iu, 'do not promise atomic replacement of the file bind');
    assert.equal(payload.report_path, join(f.runDirectory, 'z369-brief.json'));
    assert.equal(mentions(text, payload.report_path), false, 'own writable report directory is not a standalone file exception');
    for (const file of [...f.files, f.covered, f.unassigned]) assert.equal(await readFile(file, 'utf8'), 'original\n');
  });

  test(`[Z.369 brief] ${stage}: a directory-covered file needs no standalone file exception`, { timeout }, async t => {
    const f = await fixture(t);
    const boundaries = [...(stage === 'implement' ? [f.cwd] : []), f.change, f.covered];
    const { prose } = await f.compose('codex', stage, boundaries);
    assert.doesNotMatch(prose, fileSection, 'an explicitly writable ancestor preserves normal native editing');
  });

  test(`[Z.369 brief] ${stage}: directory-only Codex scope does not invent file permissions`, { timeout }, async t => {
    const f = await fixture(t);
    const { prose } = await f.compose('codex', stage, stage === 'implement' ? [f.cwd, f.change] : [f.change]);
    assert.doesNotMatch(prose, fileSection);
    for (const file of f.files) assert.equal(mentions(prose, file), false);
  });

  test(`[Z.369 brief] ${stage}: empty Codex scope does not invent standalone file permissions`, { timeout }, async t => {
    const f = await fixture(t);
    const { prose } = await f.compose('codex', stage, []);
    assert.doesNotMatch(prose, fileSection);
    for (const file of f.files) assert.equal(mentions(prose, file), false);
  });

  test(`[Z.369 brief] ${stage}: Claude does not inherit the Codex standalone-file exception`, { timeout }, async t => {
    const f = await fixture(t);
    const { prose } = await f.compose('claude', stage, [f.change, ...f.files]);
    assert.doesNotMatch(prose, fileSection);
    assert.doesNotMatch(prose, /apply_patch[^\n]*(?:не має|немає|no native)/iu);
  });
}
