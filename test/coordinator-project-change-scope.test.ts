import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { deriveTaskContext } from '../src/task-context.ts';
import type { RuntimeRunParameters } from '../src/app-runtime.ts';

const root = '/fixture/orchestrator';
const changesRoot = join(root, 'openspec', 'changes');
const assigned = join(changesRoot, 'add-ramus-sidebar-account-menu');

async function writeBoundaries(type: string) {
  const derived = await deriveTaskContext({
    root,
    parameters: { id: 'scope', type, phase: type, project: 'ramus-enterprise', features: [], tasks: ['add-ramus-sidebar-account-menu:1.1'], complexity: 'ordinary' } as RuntimeRunParameters,
    assignment: { root, changes: [{ id: 'add-ramus-sidebar-account-menu', items: [{ id: '1.1', description: 'Coordinate the menu' }] }], baselineArchives: [] },
    configuration: {
      projects: { profiles: { fixture: { development: 'develop' } }, projects: { 'ramus-enterprise': { path: 'ramus-main', profile: 'fixture', branchPaths: { main: 'ramus-main', develop: 'ramus-develop' } } } },
      reportStatuses: [{ id: 'succeeded' }, { id: 'failed' }], resources: {},
    },
  }, { deriveSources: async () => [], archiveWriteBoundaries: async () => [] });
  return derived.writeBoundaries;
}

test('coordinator may write every change of its project and create new ones', async () => {
  const boundaries = await writeBoundaries('coordinator');
  assert.ok(boundaries.includes(changesRoot + sep), 'the changes root covers other active changes and new change folders');
});

for (const type of ['implement', 'test-scaffold', 'qa', 'design']) {
  test(`${type} keeps write access to its assigned change only`, async () => {
    const boundaries = await writeBoundaries(type);
    assert.ok(boundaries.includes(assigned));
    assert.equal(boundaries.some(path => path === changesRoot || path === changesRoot + sep), false);
  });
}
