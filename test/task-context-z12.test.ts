import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindWorkspaceBoundaries, loadTaskContextConfiguration } from '../src/task-context.ts';
import { failureText, git, productionPreparation, timeout, z12Fixture } from './z12-fixture.ts';

for (const type of ['spec', 'design']) {
  test(`[task-context] Z.12 ${type}: profile main and canonical root reach production preparation without branchPaths`, { timeout }, async t => {
    const f = await z12Fixture(t);
    const before = await f.unchanged();
    const loaded = await loadTaskContextConfiguration(f.confRoot);
    assert.deepEqual(loaded.projects, f.projects, 'profiles must survive the configuration port');
    const task = await f.derive(type);
    assert.equal(task.branch, 'main');
    assert.equal(task.workspaceWritable, false);
    const boundaries = bindWorkspaceBoundaries(task, f.root);
    assert.deepEqual([...boundaries].sort(), [f.change, join(f.root, 'questions/projects/orchestrator/questions.md')].sort());
    const h = await productionPreparation(t, f);
    await assert.rejects(h.run(type), error => /Z12_PREPARATION_COMPLETE/.test(failureText(error)));
    assert.equal(h.prepared.length, 1);
    assert.equal(h.reserved.length, 1);
    for (const launch of [h.prepared[0], h.reserved[0]]) {
      assert.equal(launch.activity.cwd, f.root);
      assert.equal(launch.taskContext?.context.branch, 'main');
      assert.equal(launch.taskContext?.context.workspaceWritable, false);
      assert.deepEqual([...launch.writeBoundaries!].sort(), [...boundaries, join(f.root, '.git')].sort(), 'Z.11 allows the document repository git directory only');
      for (const forbidden of [f.root, f.confRoot, join(f.root, 'raf-develop'), join(f.root, 'raf-develop/.git'), join(f.root, 'openspec/changes')]) assert.ok(!launch.writeBoundaries!.includes(forbidden), forbidden);
    }
    assert.ok(h.calls.every(call => call.startsWith('git ')), 'preparation must not start runners, tmux or quota probes');
    assert.deepEqual(await f.unchanged(), before);
    assert.ok(!(await readdir(f.root)).includes('orchestrator-main'));
  });

  for (const branch of ['develop', 'integration']) {
    test(`[task-context] Z.12 ${type}: product development=${branch} ignores default path, key order and raf branch`, { timeout }, async t => {
      const f = await z12Fixture(t);
      f.projects.profiles.fixture.development = branch;
      await f.persist();
      assert.equal(git(f.root, 'branch', '--show-current'), 'main');
      assert.equal(git(join(f.root, 'raf-develop'), 'branch', '--show-current'), 'develop');
      for (const entries of [Object.entries(f.projects.projects.app.branchPaths!), Object.entries(f.projects.projects.app.branchPaths!).reverse()]) {
        f.projects.projects.app.branchPaths = Object.fromEntries(entries);
        await f.persist();
        assert.equal((await f.derive(type, 'app')).branch, branch);
      }
      const h = await productionPreparation(t, f);
      await assert.rejects(h.run(type, 'app'), error => /Z12_PREPARATION_COMPLETE/.test(failureText(error)));
      assert.equal(h.prepared[0].activity.cwd, join(f.root, `app-${branch}`));
      assert.equal(h.prepared[0].taskContext?.context.branch, branch);
      const route = await h.services.route({ root: f.root, project: 'app', branch });
      assert.equal(route.ok, true, JSON.stringify(route));
      if (route.ok) assert.equal(route.sharedLibrariesPath, join(f.root, `app-${branch}`, 'shared-libs'));
    });
  }

  for (const invalid of ['unknown-profile', 'missing-development', 'null-development', 'empty-development', 'number-development']) {
    test(`[task-context] Z.12 ${type}: ${invalid} is CONFIGURATION_INVALID without an only-branch fallback`, { timeout }, async t => {
      const f = await z12Fixture(t);
      f.projects.projects.app.branchPaths = { main: 'app-main' };
      if (invalid === 'unknown-profile') f.projects.projects.app.profile = 'unregistered';
      else if (invalid === 'missing-development') delete f.projects.profiles.fixture.development;
      else f.projects.profiles.fixture.development = invalid === 'null-development' ? null : invalid === 'empty-development' ? '' : 42;
      await f.persist();
      const before = await f.unchanged();
      const check = (error: unknown) => {
        const text = failureText(error);
        assert.match(text, /CONFIGURATION_INVALID/);
        assert.match(text, /projects\.json/);
        assert.match(text, /fixture|unregistered/);
        return true;
      };
      await assert.rejects(f.derive(type, 'app'), check);
      const h = await productionPreparation(t, f);
      await assert.rejects(h.run(type, 'app'), check);
      assert.deepEqual(h.prepared, []);
      assert.deepEqual(h.reserved, []);
      assert.ok(h.calls.every(call => call.startsWith('git ')));
      assert.deepEqual(await f.unchanged(), before);
    });
  }

  test(`[task-context] Z.12 ${type}: missing configured development route reports source and available routes`, { timeout }, async t => {
    const f = await z12Fixture(t);
    f.projects.projects.app.branchPaths = { main: 'app-main' };
    await f.persist();
    const h = await productionPreparation(t, f);
    const check = (error: unknown) => {
      const text = failureText(error);
      for (const pattern of [/UNKNOWN_BRANCH/, /projects\.json/, /app/, /fixture/, /integration/, /main/]) assert.match(text, pattern);
      return true;
    };
    await assert.rejects(f.derive(type, 'app'), check);
    await assert.rejects(h.run(type, 'app'), check);
    assert.deepEqual(h.prepared, []);
    assert.deepEqual(h.reserved, []);
    assert.deepEqual(h.calls, [], 'unknown mapping must fail before Git or runner access');
    assert.match(await readFile(join(f.root, 'app-main/sentinel.txt'), 'utf8'), /unchanged/);
  });
}

test('[task-context] Z.12 regression: implementation, QA, hotfix and test-scaffold retain their existing branch policy', { timeout }, async t => {
  const f = await z12Fixture(t);
  for (const type of ['implement', 'qa', 'test-scaffold', 'hotfix']) {
    const task = await f.derive(type, 'raf');
    assert.equal(task.branch, type === 'hotfix' ? 'main' : 'develop');
    assert.equal(task.workspaceWritable, true);
  }
});
