import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { bindWorkspaceBoundaries, deriveTaskContext, type TaskContextRequest } from '../src/task-context.ts';

async function fixture(t: TestContext, project: string, final: boolean): Promise<TaskContextRequest> {
  const root = await mkdtemp(join(tmpdir(), 'raf-z438-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'openspec', 'changes', 'audit-process-rules');
  const description = 'Audit canonical specs, other changes, archives and brief templates';
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'tasks.md'), `- [ ] 1.1 ${description}\n${final ? '' : '- [ ] 1.2 Remaining work\n'}`);
  return {
    root,
    parameters: {
      id: 'z438-spec', type: 'spec', project, phase: 'spec', complexity: 'small',
      features: ['audit-process-rules'], tasks: ['audit-process-rules:1.1'],
    },
    assignment: { root, changes: [{ id: 'audit-process-rules', items: [{ id: '1.1', description }] }], baselineArchives: [] },
    configuration: {
      projects: {
        profiles: { product: { development: 'develop' }, orchestrator: { development: 'develop' } },
        projects: {
          raf: { path: 'raf-main', profile: 'product', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } },
          orchestrator: { path: '.', profile: 'orchestrator', branchPaths: { develop: '.' } },
        },
      },
      reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }], resources: {},
    },
  };
}

for (const project of ['orchestrator', 'raf']) {
  for (const final of [false, true]) {
    test(`Z438 spec ${project}, final=${final}: all OpenSpec and brief templates are writable with exact scope`, async t => {
      const request = await fixture(t, project, final);
      const context = await deriveTaskContext(request);
      assert.deepEqual(context.writeBoundaries, [
        join(request.root, 'openspec') + sep,
        join(request.root, 'conf', 'briefs') + sep,
        join(request.root, 'questions', 'projects', project, 'questions.md'),
      ]);
      assert.equal(context.workspaceWritable, false);
      assert.deepEqual(bindWorkspaceBoundaries(context, join(request.root, 'raf-develop')), context.writeBoundaries);
      assert.deepEqual(bindWorkspaceBoundaries(context, request.root), context.writeBoundaries);
      assert.deepEqual(request.parameters.tasks, ['audit-process-rules:1.1']);
      assert.deepEqual(request.assignment.changes.map(change => change.id), ['audit-process-rules']);
    });
  }
}

test('Z438 implement keeps its selected change scope and code workspace', async t => {
  const request = await fixture(t, 'raf', false);
  const context = await deriveTaskContext({ ...request, parameters: { ...request.parameters, type: 'implement', phase: 'implement' } });
  const cwd = join(request.root, 'raf-develop');
  assert.deepEqual(bindWorkspaceBoundaries(context, cwd), [
    cwd, join(request.root, 'openspec', 'changes', 'audit-process-rules'),
    join(request.root, 'questions', 'projects', 'raf', 'questions.md'),
  ]);
});
