import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z12Fixture } from './z12-fixture.ts';

for (const type of ['implement', 'qa', 'test-scaffold', 'coordinator']) {
  test(`[writer-routing] ${type} uses profile development for main and develop projects`, async t => {
    const fixture = await z12Fixture(t);
    for (const [project, expectedBranch] of [['orchestrator', 'main'], ['raf', 'develop']]) {
      const context = await fixture.derive(type, project);
      assert.equal(context.branch, expectedBranch);
    }
  });
}

test('[writer-routing] hotfix keeps raf on hotfix and other projects on main', async t => {
  const fixture = await z12Fixture(t);
  fixture.projects.projects.raf.branchPaths!.hotfix = 'raf-hotfix';
  assert.equal((await fixture.derive('hotfix', 'raf')).branch, 'hotfix');
  assert.equal((await fixture.derive('hotfix', 'orchestrator')).branch, 'main');
});
