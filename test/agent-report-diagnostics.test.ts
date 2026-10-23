import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { commandFixture } from './reminder-fixture.ts';
import type { SessionRecord } from '../src/session-state.ts';
import type { PsSessionView } from '../src/launcher-notice.ts';

for (const route of ['main', 'launchedBy', 'delegatedBy', 'notify', 'missingLauncher'] as const) {
  const name = route === 'missingLauncher'
    ? '[Z.373] pending report diagnostic without a saved launcher has no fallback main'
    : `[Z.354] pending report diagnostic reaches ${route} once across reconciliation commands`;
  test(name, async t => {
    const f = await commandFixture(t);
    const main = f.session('main');
    const coordinator = f.session('coordinator');
    const observer = f.session('observer');
    const worker = f.session('diagnostic-worker');
    const link = (row: SessionRecord) => ({ addressId: row.addressId, runId: row.runId });
    const reportPath = join(dirname(f.statePath), 'tmp', worker.runId, `${worker.addressId}.json`);
    const record: SessionRecord = { ...worker, launchContext: {
      assignment: { root: f.root, baselineArchives: [], changes: [{ id: 'diagnostic-change', items: [{ id: 'Z.354', description: 'Diagnose report' }] }] },
      selection: { runner: 'codex', model: 'fixture', effort: 'high', reason: 'fixture' }, reportPath, briefPath: join(f.root, 'brief.txt'),
    }, ...(route === 'missingLauncher' ? {} : { launchedBy: link(route === 'main' ? main : coordinator) }),
    ...(route === 'delegatedBy' ? { delegatedBy: { ...link(coordinator), fence: 'fence' } } : {}),
    ...(route === 'notify' ? { notify: link(observer) } : {}) };
    f.store.sessionRepository.transaction(tx => tx.putSession(record));
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ status: 'succeeded', answer: 'Done', changes: [{ id: 'diagnostic-change', items: [{ id: 'Z.354', status: 'succeeded' }] }] }));
    const stderr: string[] = [];
    t.mock.method(process.stderr, 'write', (chunk: unknown) => { stderr.push(String(chunk)); return true; });
    const firstRows = await f.agentPs() as PsSessionView[];
    const firstStderr = stderr.join('');
    stderr.length = 0;
    await Promise.all([f.agentPs(), f.agentPs()]);
    await f.command('reminder add', { text: 'unrelated reminder', to: 'main', at: '2099-01-01T00:00:00.000Z' });
    await f.agentPs();
    assert.equal(stderr.join(''), '', 'later commands must not print the pending report diagnostic again');
    assert.equal(firstStderr, '', 'diagnostic goes to the event addressee rather than CLI stderr');
    const notices = f.deliveries.filter(row => row.text.includes(reportPath));
    assert.equal(notices.length, route === 'missingLauncher' ? 0 : 1, 'one diagnostic per saved addressee, without fallback main');
    if (route === 'missingLauncher') {
      const diagnostic = firstRows.find(row => row.runId === worker.runId)?.resultNotice;
      assert.ok(diagnostic, 'an unknown recipient remains visible in ps');
      assert.equal(diagnostic.recipient, '', 'an existing main is not a substitute launcher');
      assert.equal(diagnostic.state, 'pending');
      assert.ok(diagnostic.lastError, 'ps explains why the rejection cannot be delivered');
    } else {
      const recipient = route === 'notify' ? observer : route === 'main' ? main : coordinator;
      assert.equal(notices[0].to, recipient.addressId);
      assert.deepEqual(notices[0].sender, { kind: 'system' });
      assert.equal(notices[0].text, [
        'raf event: agent.report-rejected',
        `Agent: ${worker.addressId}`,
        `Run: ${worker.runId}`,
        'Items: diagnostic-change:Z.354',
        `Report: ${reportPath}`,
        'Reason: Task checkbox confirmation failed: : :: Launch task source identity is unavailable',
        'Actual items: []',
        'Archives: []',
        'Remedy: Узгодьте поточний рядок, індекс і HEAD або відновіть доступ до джерела; повторіть підтвердження цього запуску.',
      ].join('\n'), 'the notice preserves the concrete rejection stage and its full reason');
      assert.doesNotMatch(notices[0].text, /foundItems|raf event: agent\.(succeeded|failed)/);
      assert.ok(notices[0].text.length < 2000);
    }
    assert.equal(f.getSession(worker.runId)?.result, undefined, 'a diagnostic must not accept succeeded or invent failed');
    assert.equal(f.store.sessionRepository.transaction(tx => tx.listPending(), 'read').filter(row => ['agent.succeeded', 'agent.failed'].includes(row.event)).length, 0);
    await writeFile(reportPath, JSON.stringify({ status: 'failed', answer: 'Cannot finish', changes: [{ id: 'diagnostic-change', items: [{ id: 'Z.354', status: 'failed', reason: 'Task remains open' }] }] }));
    const finalRows = await f.agentPs() as PsSessionView[];
    assert.equal(f.getSession(worker.runId)?.result?.status, 'failed', 'later valid result remains acceptable');
    assert.equal(f.deliveries.filter(row => row.text.includes(reportPath)).length, route === 'missingLauncher' ? 1 : 2, 'final result has its own once-only notice');
    assert.equal(finalRows.find(row => row.runId === worker.runId)?.resultNotice?.id, `${worker.runId}:result-notice`, 'the diagnostic does not hide final result delivery status');
  });
}
