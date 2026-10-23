import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createAgentReportWatcher, readPendingAgentReport,
  type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult,
} from '../src/agent-report.ts';
import { createReportDiagnosticNotice } from '../src/launcher-notice.ts';
import type { ReportRejectionSnapshot } from '../src/report-rejection.ts';
import type { SessionRecord } from '../src/session-state.ts';

const at = '2026-10-23T18:00:00.000Z';
const changeId = 'assignment-reason-change';

function fixture(status: 'succeeded' | 'failed') {
  const request: AgentReportRequest = {
    tmpRoot: '/isolated/z373-d1/tmp', runId: randomUUID(), address: 'worker',
    assignment: {
      root: '/isolated/z373-d1/orchestrator', baselineArchives: [],
      changes: [{ id: changeId, items: [{ id: '1.1', description: 'Original assigned task' }] }],
    },
  };
  const reportPath = join(request.tmpRoot, request.runId, 'worker.json');
  const worker: SessionRecord = {
    runId: request.runId, addressId: request.address, revision: 1, state: 'running',
    launchedBy: { addressId: 'launcher', runId: randomUUID() },
    activity: {
      type: 'implement', project: 'raf', features: [changeId], phase: 'implement',
      cwd: '/isolated/z373-d1/raf-develop',
    },
    launchContext: {
      assignment: request.assignment, reportPath, briefPath: '/isolated/z373-d1/brief.md',
      selection: { runner: 'codex', model: 'fixture', effort: 'fixture', reason: 'Isolated unit dependency' },
    },
  };
  const makeReport = (itemId: string): AgentReport => ({
    status, answer: 'PRIVATE-ANSWER-MUST-NOT-BECOME-DIAGNOSTIC', commits: [],
    changes: [{ id: changeId, items: [{
      id: itemId, status, ...(status === 'failed' ? { reason: 'Expected work failure' } : {}),
    }] }],
  });
  const state: {
    text: string;
    diagnostics: { reason: string; snapshot?: ReportRejectionSnapshot }[];
    results: AgentReportResult[];
    acceptanceCalls: string[];
    listener?: (event: 'create' | 'modify' | 'rename', filename: string) => Promise<void>;
  } = { text: JSON.stringify(makeReport('9.9')), diagnostics: [], results: [], acceptanceCalls: [] };
  const ports: AgentReportPorts = {
    fs: {
      mkdir: async () => {}, removeTree: async () => {},
      readText: async path => { assert.equal(path, reportPath); return state.text; },
      readBytes: async path => { assert.equal(path, reportPath); return Buffer.from(state.text); },
    },
    watch: (_directory, listener) => { state.listener = listener; return () => {}; },
    process: { onExit: () => () => {} },
    now: () => at,
    verifyAssignmentSourceIdentity: async () => {
      state.acceptanceCalls.push('source'); return { ok: true, issues: [] };
    },
    verifyAssignmentCompletion: async () => {
      state.acceptanceCalls.push('completion'); return { ok: true, issues: [] };
    },
    confirmTaskCheckboxes: async () => {
      state.acceptanceCalls.push('checkbox');
      return { ok: true, issues: [], commits: [], awaitingArchive: false };
    },
    reconcileReportedCommitIndex: async () => { state.acceptanceCalls.push('repair'); },
    isCurrentReport: async () => true,
    readTaskCheckboxCommits: async () => [],
    result: async value => { state.results.push(value); },
    diagnostic: async (reason, snapshot) => { state.diagnostics.push({ reason, snapshot }); },
  };
  return { request, reportPath, worker, state, ports, makeReport };
}

function assertSpecificRejection(f: ReturnType<typeof fixture>, rejectedText: string): void {
  assert.equal(f.state.diagnostics.length, 1, 'One rejected read must expose one diagnostic');
  assert.deepEqual(f.state.results, [], 'An assignment mismatch is not a failed or succeeded work result');
  assert.deepEqual(f.state.acceptanceCalls, [], 'Foreign item IDs must be rejected before source/repair/checkbox/completion');
  const diagnostic = f.state.diagnostics[0];
  assert.ok(diagnostic.snapshot, 'The reason must belong to the rejected read snapshot');
  assert.equal(diagnostic.snapshot.reportPath, f.reportPath);
  assert.equal(diagnostic.snapshot.reason, diagnostic.reason);
  assert.ok(diagnostic.snapshot.bytes);
  assert.deepEqual(Buffer.from(diagnostic.snapshot.bytes), Buffer.from(rejectedText));

  const notice = createReportDiagnosticNotice(f.worker, diagnostic.reason);
  assert.ok(notice.text.startsWith('raf event: agent.report-rejected\n'));
  assert.ok(notice.text.includes(`\nItems: ${changeId}:1.1\n`), 'The envelope must retain the trusted original item');
  assert.ok(notice.text.includes(`\nReport: ${f.reportPath}\n`));
  const reasonMarker = '\nReason: ';
  const reasonStart = notice.text.indexOf(reasonMarker);
  assert.notEqual(reasonStart, -1, 'The public notice must expose a Reason field');
  const reason = notice.text.slice(reasonStart + reasonMarker.length);
  assert.ok(reason.includes(`${changeId}:1.1`), 'Reason itself must name the expected change:item; Items is not diagnostic evidence');
  assert.ok(reason.includes(`${changeId}:9.9`), 'Reason must identify the actual foreign change:item');
  assert.match(reason, /\bitems\b[\s\S]*\bid\b/u, 'Reason must identify the mismatching item ID field, without prescribing path punctuation');
  assert.doesNotMatch(reason, /^Invalid report or assignment mismatch\s*$/u, 'A generic boolean-validation message does not explain the mismatch');
  assert.ok(!notice.text.includes('PRIVATE-ANSWER-MUST-NOT-BECOME-DIAGNOSTIC'));
}

for (const status of ['succeeded', 'failed'] as const) {
  test(`[Z.373.6 control] valid ${status} item 1.1 is accepted by reader and watcher`, async t => {
    const reader = fixture(status);
    reader.state.text = JSON.stringify(reader.makeReport('1.1'));
    const accepted = await readPendingAgentReport(reader.request, reader.ports);
    assert.ok(accepted, 'Reader setup must accept the exact assigned item independently of rejection assertions');
    assert.equal(accepted.event, `agent.${status}`);
    assert.deepEqual(reader.state.diagnostics, []);

    const watched = fixture(status);
    watched.state.text = JSON.stringify(watched.makeReport('1.1'));
    const watcher = await createAgentReportWatcher(watched.request, watched.ports);
    t.after(() => watcher.dispose());
    assert.equal(watched.state.results.length, 1, 'Watcher setup must accept the exact assigned item independently of rejection assertions');
    assert.equal(watched.state.results[0].event, `agent.${status}`);
    assert.deepEqual(watched.state.diagnostics, []);
  });

  test(`[Z.373.6 reader] ${status}: foreign 9.9 has a field-specific reason and correction to 1.1 is accepted`, async () => {
    const f = fixture(status);
    const rejectedText = f.state.text;
    assert.equal(await readPendingAgentReport(f.request, f.ports), null);
    assertSpecificRejection(f, rejectedText);

    f.state.text = JSON.stringify(f.makeReport('1.1'));
    const accepted = await readPendingAgentReport(f.request, f.ports);
    assert.ok(accepted, 'A valid control report must reach acceptance through the same fixture');
    assert.equal(accepted.event, `agent.${status}`);
    assert.equal(accepted.report?.changes[0].items[0].id, '1.1');
    assert.equal(f.state.diagnostics.length, 1, 'Correction must not create another rejection');
  });

  test(`[Z.373.6 watcher] ${status}: foreign 9.9 reaches public Reason and corrected report produces only its result`, async t => {
    const f = fixture(status);
    const rejectedText = f.state.text;
    const watcher = await createAgentReportWatcher(f.request, f.ports);
    t.after(() => watcher.dispose());
    assert.equal(watcher.path, f.reportPath);
    assertSpecificRejection(f, rejectedText);

    f.state.text = JSON.stringify(f.makeReport('1.1'));
    assert.ok(f.state.listener, 'The watcher must observe correction through its file event port');
    await f.state.listener('rename', 'worker.json');
    assert.equal(f.state.results.length, 1);
    assert.equal(f.state.results[0].event, `agent.${status}`);
    assert.equal(f.state.results[0].report?.changes[0].items[0].id, '1.1');
    assert.equal(f.state.diagnostics.length, 1);
  });
}
