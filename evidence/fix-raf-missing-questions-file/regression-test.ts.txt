import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindWorkspaceBoundaries, deriveTaskContext } from '../src/task-context.ts';

for (const initial of ['missing tree', 'missing project directory', 'missing file', 'existing questions']) {
  test(`question write boundary supports ${initial}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'raf-missing-questions-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'questions', 'projects', 'raf');
    const file = join(directory, 'questions.md');
    if (initial === 'missing project directory') await mkdir(join(root, 'questions', 'projects'), { recursive: true });
    if (initial === 'missing file' || initial === 'existing questions') await mkdir(directory, { recursive: true });
    if (initial === 'existing questions') await writeFile(file, '# Existing question\n');
    const derive = () => deriveTaskContext({
      root,
      parameters: { id: 'missing-questions', type: 'hotfix', phase: 'hotfix', project: 'raf', features: ['fix-raf-missing-questions-file'], tasks: ['fix-raf-missing-questions-file:1.1'], complexity: 'ordinary' },
      assignment: { root, changes: [{ id: 'fix-raf-missing-questions-file', items: [{ id: '1.1', description: 'Allow an absent questions file' }] }], baselineArchives: [] },
      configuration: {
        projects: { projects: { raf: { path: 'raf-main', branchPaths: { hotfix: 'raf-hotfix' } } } },
        reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }], resources: {},
      },
    }, { deriveSources: async () => [], archiveWriteBoundaries: async () => [] });
    const context = await derive();
    const boundaries = bindWorkspaceBoundaries(context, join(root, 'raf-hotfix'));
    assert.ok(boundaries.includes(directory), 'bind the project questions directory');
    assert.equal(boundaries.includes(file), false, 'an optional file cannot be a bind source');
    assert.equal(boundaries.includes(join(root, 'questions', 'projects')), false);
    assert.ok((await stat(directory)).isDirectory(), 'the bind source exists before launch');
    if (initial === 'existing questions') assert.equal(await readFile(file, 'utf8'), '# Existing question\n');
    else await assert.rejects(stat(file), { code: 'ENOENT' }, 'preparation does not create an empty channel');
    await writeFile(join(directory, 'question.tmp'), '# New question\n');
    await rename(join(directory, 'question.tmp'), file);
    assert.equal(await readFile(file, 'utf8'), '# New question\n');
    await rm(file);
    assert.deepEqual((await derive()).writeBoundaries, context.writeBoundaries, 'a subsequent launch supports deletion of the empty channel');
    await assert.rejects(stat(file), { code: 'ENOENT' });
  });
}
