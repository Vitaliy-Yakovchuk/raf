import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { commandFixture } from './reminder-fixture.ts';
import type { SessionRecord } from '../src/session-state.ts';

for (const route of ['main', 'launchedBy', 'delegatedBy', 'notify'] as const) {
  test(`[Z.354] pending report diagnostic reaches ${route} once across reconciliation commands`, async t => {
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
    }, ...(route === 'main' ? {} : { launchedBy: link(coordinator) }),
    ...(route === 'delegatedBy' ? { delegatedBy: { ...link(coordinator), fence: 'fence' } } : {}),
    ...(route === 'notify' ? { notify: link(observer) } : {}) };
    f.store.sessionRepository.transaction(tx => tx.putSession(record));
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ status: 'succeeded', answer: 'Done', changes: [{ id: 'diagnostic-change', items: [{ id: 'Z.354', status: 'succeeded' }] }] }));
    const stderr: string[] = [];
    t.mock.method(process.stderr, 'write', (chunk: unknown) => { stderr.push(String(chunk)); return true; });
    await f.agentPs();
    const firstStderr = stderr.join('');
    stderr.length = 0;
    await Promise.all([f.agentPs(), f.agentPs()]);
    await f.command('reminder add', { text: 'unrelated reminder', to: 'main', at: '2099-01-01T00:00:00.000Z' });
    await f.agentPs();
    assert.equal(stderr.join(''), '', 'later commands must not print the pending report diagnostic again');
    assert.equal(firstStderr, '', 'diagnostic goes to the event addressee rather than CLI stderr');
    const notices = f.deliveries.filter(row => row.text.includes(reportPath));
    assert.equal(notices.length, 1, 'one addressed diagnostic across fresh runtime and database handles');
    const recipient = route === 'notify' ? observer : route === 'main' ? main : coordinator;
    assert.equal(notices[0].to, recipient.addressId);
    assert.deepEqual(notices[0].sender, { kind: 'system' });
    assert.match(notices[0].text, /diagnostic-change:Z\.354/);
    assert.match(notices[0].text, /Assignment verification failed|Assignment completion is not confirmed/);
    assert.doesNotMatch(notices[0].text, /foundItems|raf event: agent\.(succeeded|failed)/);
    assert.ok(notices[0].text.length < 2000);
    assert.equal(f.getSession(worker.runId)?.result, undefined, 'a diagnostic must not accept succeeded or invent failed');
    assert.equal(f.query("SELECT id FROM pending_intents WHERE event IN ('agent.succeeded', 'agent.failed')").length, 0);
    await writeFile(reportPath, JSON.stringify({ status: 'failed', answer: 'Cannot finish', changes: [{ id: 'diagnostic-change', items: [{ id: 'Z.354', status: 'failed', reason: 'Task remains open' }] }] }));
    await f.agentPs();
    assert.equal(f.getSession(worker.runId)?.result?.status, 'failed', 'later valid result remains acceptable');
    assert.equal(f.deliveries.filter(row => row.text.includes(reportPath)).length, 2, 'final result has its own once-only notice');
  });
}
