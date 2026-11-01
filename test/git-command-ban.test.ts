import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RafCostRuntime } from '../src/raf-cost-runtime.ts';
import { admitGit, gitCallCount, gitOutput, gitOutputSync, runGitFreeCommand } from '../src/git.ts';
import { executeCommand } from '../src/os-runtime.ts';
import { readPendingAgentReport } from '../src/agent-report.ts';
import type { StateStore } from '../src/state-store.ts';

test('CLI blocks asynchronous, synchronous and adapter git before counting or execution', async () => {
  const before = gitCallCount();
  await runGitFreeCommand('agent ps', async () => {
    await assert.rejects(gitOutput(['--version']), { code: 'GIT_IN_COMMAND' });
    assert.throws(() => gitOutputSync(['--version']), { code: 'GIT_IN_COMMAND' });
    await assert.rejects(executeCommand({ executable: '/usr/bin/git', args: ['--version'] }), { code: 'GIT_IN_COMMAND' });
  });
  assert.equal(gitCallCount(), before);
});

for (const scope of ['worker', 'service'] as const) {
  test(`${scope} counts git and persists a correction event above the configured threshold`, () => {
    const events: any[] = [];
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const store = {
      healthCpu: { interval() {}, domain: () => ({ rafInstanceId: 'test-instance' }) },
      costProfileRepository: { update() {}, readRows: () => [] },
      eventRepository: { transaction: (action: any) => action({ savePending: (event: any) => events.push(event) }) },
    } as unknown as StateStore;
    const runtime = new RafCostRuntime(store, { scope, command: null }, root, 'wait');
    runtime.install();
    try {
      const before = gitCallCount();
      for (let index = 0; index < 51; index++) admitGit(['status']);
      assert.equal(gitCallCount(), before + 51);
      assert.equal(events.length, 1);
      assert.equal(events[0].event.kind, 'raf.git-calls-exceeded');
      assert.equal(events[0].event.id, 'test-instance');
      assert.equal(events[0].data.scope, scope);
      assert.equal(events[0].data.threshold, 50);
      assert.ok(events[0].data.calls > 50);
    } finally { runtime.finish(); }
  });
}

for (const commits of [undefined, [{ repository: '/old', sha: 'evidence' }], { legacy: 'evidence' }]) {
test(`report commits ${JSON.stringify(commits)} are evidence without validation`, async () => {
  const report = { status: 'succeeded', answer: 'done', commits, changes: [{ id: 'change', items: [{ id: '1', status: 'succeeded' }] }] };
  const result = await readPendingAgentReport({ tmpRoot: '/tmp', runId: 'run', address: 'worker', assignment: { root: '/tmp', baselineArchives: [], changes: [{ id: 'change', items: [{ id: '1', description: 'work' }] }] }, reportedCommits: { contract: 'reported-commits-v1', runId: 'old', reportPath: '/old', repositories: [], writeBoundaries: [] } }, {
    fs: { readText: async () => JSON.stringify(report) }, now: () => new Date().toISOString(), diagnostic: async () => {},
    isCurrentReport: async () => { throw new Error('commit freshness must not be checked'); },
    verifyAssignmentCompletion: async () => ({ ok: true, issues: [] }),
  });
  assert.equal(result?.status, 'succeeded');
  assert.deepEqual(result?.report?.commits, report.commits);
});
}
