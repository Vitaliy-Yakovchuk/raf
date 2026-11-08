import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentControlService, type AgentControlDependencies } from '../src/agent-control.ts';
import { dismissInactiveRecipientNotices, resultNoticeViews, retainedFinishedSession, settleResultNotices } from '../src/reminder-cli.ts';
import type { SessionRecord } from '../src/session-state.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';

const at = '2026-10-28T00:00:00.000Z';

function finishedRun(root: string, runId: string, addressId: string, notify?: SessionRecord['notify']): SessionRecord {
  return {
    runId, addressId, revision: 1, state: 'finished', finishedAt: at,
    ...(notify ? { notify } : {}),
    result: { status: 'succeeded', response: 'Готово', proof: null },
    launchContext: {
      assignment: { root, changes: [{ id: 'fix-raf-close-finished-undelivered-runs', items: [{ id: '1.1', description: 'Close finished undelivered run' }] }], baselineArchives: [] },
      selection: { runner: 'codex', model: 'fixture', effort: 'high', reason: 'fixture' },
      reportPath: join(root, `${addressId}.json`), briefPath: join(root, 'brief.txt'),
    },
  };
}

function control(store: StateStore): AgentControlService {
  const dependencies: AgentControlDependencies = {
    repository: store.sessionRepository,
    coordinator: {
      async prepareClose(row) { return row; },
      async observe(row) { return row; },
      async updateActivity(row) { return row; },
      async finalize(row) { return row; },
      async publish() {},
      async acceptPendingReport(row) { return row; },
    },
    scanner: { async inspect() { return { state: 'exited', observedAt: at, exitCode: 0, evidence: 'fixture runner exited' }; } },
    authority: { async resolve() { return { kind: 'system' }; } },
    transport: { async deliver() { return { accepted: true, receiptId: 'fixture' }; }, async close() {}, async interrupt() {} },
    reminders: { sessionEnded: () => ({ allowed: true, unfinished: [] }) },
    projects: ['raf'],
    agentTypes: ['implement'],
    resultNotices: {
      retainedFinishedSession: id => retainedFinishedSession(store, id),
      dismissInactive: runId => dismissInactiveRecipientNotices(store, runId),
    },
  };
  return new AgentControlService(dependencies);
}

async function fixture(t: TestContext, recipient: 'inactive' | 'unknown', retainSession: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'raf-close-undelivered-'));
  const store = openStateStore(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const put = (session: SessionRecord) => store.sessionRepository.transaction(tx => tx.putSession(session));
  if (recipient === 'inactive') put({ runId: 'old-main', addressId: 'main', revision: 1, state: 'running' });
  const notify = recipient === 'inactive' ? { addressId: 'main', runId: 'old-main' } : undefined;
  const worker = finishedRun(root, 'worker-run', 'worker', notify);
  const other = finishedRun(root, 'other-run', 'other', notify);
  put(worker);
  put(other);
  if (recipient === 'inactive') put({ runId: 'old-main', addressId: 'main', revision: 2, state: 'finished', finishedAt: at });
  await settleResultNotices({ store, now: () => Date.parse(at), deliver: async () => { throw new Error('inactive main must not receive the result'); } });
  if (!retainSession) store.sessionRepository.transaction(tx => { tx.deleteSession(worker.runId); tx.deleteSession(other.runId); });
  const visible = () => resultNoticeViews(store, []).map(row => row.runId).sort();
  return { store, worker, other, service: control(store), visible };
}

for (const recipient of ['inactive', 'unknown'] as const) {
  for (const retainSession of [true, false]) {
    for (const idOf of ['addressId', 'runId'] as const) {
      test(`[finished-undelivered] close by ${idOf} drops a finished run when main is ${recipient}${retainSession ? '' : ' after session retention'}`, async t => {
        const f = await fixture(t, recipient, retainSession);
        assert.deepEqual(f.visible(), ['other-run', 'worker-run']);
        const closed = await f.service.close(f.worker[idOf]);
        assert.equal(closed.closed, true);
        assert.deepEqual(f.visible(), ['other-run'], 'closing one finished run must not depend on the recipient session and must drop only that run from agent ps');
      });
    }
  }
}
