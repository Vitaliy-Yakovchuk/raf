import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createAgentReportWatcher, readPendingAgentReport, verifyPendingAgentReportFreshness,
  type AgentReport, type AgentReportPorts, type AgentReportRequest, type AgentReportResult,
} from '../src/agent-report.ts';
import type { AssignmentSnapshot, AssignmentVerification } from '../src/assignment.ts';
import { createEventRegistry, type EventCatalog } from '../src/event-registry.ts';
import { createReportDiagnosticNotice } from '../src/launcher-notice.ts';
import { ReminderService } from '../src/reminders.ts';
import { openStateStore, type StateStore } from '../src/state-store.ts';
import type { SessionRecord } from '../src/session-state.ts';
import { recordReportRejection, type ReportRejectionSnapshot } from '../src/report-rejection.ts';
import { agentRunFixture, until, alive } from './agent-run-fixture.ts';

const at = '2026-10-23T16:00:00.000Z';
const eventKind = 'agent.report-rejected';
const catalogPath = new URL('../../conf/raf-constants.json', import.meta.url);
const ownModule = fileURLToPath(import.meta.url);
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
const assignment: AssignmentSnapshot = {
  root: '/isolated/orchestrator',
  changes: [
    { id: 'first-change', items: [{ id: '1.1', description: 'Original task description' }, { id: '1.2', description: 'Second original task' }] },
    { id: 'second-change', items: [{ id: '2.1', description: 'Third original task' }] },
  ],
  baselineArchives: [],
};
const initialItems = ['first-change:1.1', 'first-change:1.2', 'second-change:2.1'];
const longReason = 'Assignment completion is not confirmed\n' + 'Деталі перевірки. '.repeat(80)
  + '\nfirst-change:1.1 expected="Original task description" actual="Changed task description"'
  + '\nsecond-change:2.1 expected identity=before actual identity=after\nEND-OF-EXACT-REASON';

function report(status: 'succeeded' | 'failed' = 'succeeded'): AgentReport {
  return {
    status, answer: 'PRIVATE-REPORT-ANSWER', commits: [],
    changes: assignment.changes.map(change => ({
      id: change.id,
      items: change.items.map(item => ({ id: item.id, status, ...(status === 'failed' ? { reason: 'Expected work failure' } : {}) })),
    })),
  };
}

function issue(reason: string): AssignmentVerification {
  return {
    ok: false,
    issues: [{
      change: 'first-change', requestedItems: ['1.1'], reason,
      foundItems: [{ id: '1.1', description: 'Changed task description', done: false }],
      archives: [], remedy: 'Restore original source identity',
    }],
  };
}

type Diagnostic = { reason: string; snapshot?: ReportRejectionSnapshot };

function readerFixture() {
  const request: Mutable<AgentReportRequest> = { tmpRoot: '/isolated/tmp', runId: randomUUID(), address: 'worker', assignment };
  const state: {
    text: string | null; readError?: Error; verification: AssignmentVerification;
    diagnostics: Diagnostic[]; results: AgentReportResult[];
    readPaths: string[]; listener?: (event: 'create' | 'modify' | 'rename', filename: string) => Promise<void>;
  } = { text: null, verification: { ok: true, issues: [] }, diagnostics: [], results: [], readPaths: [] };
  const ports: Mutable<AgentReportPorts> = {
    fs: {
      mkdir: async () => {}, removeTree: async () => {},
      readText: async path => { state.readPaths.push(path); if (state.readError) throw state.readError; return state.text; },
    },
    now: () => at,
    watch: (_directory, listener) => { state.listener = listener; return () => {}; },
    process: { onExit: () => () => {} },
    verifyAssignmentCompletion: async () => state.verification,
    confirmTaskCheckboxes: async () => ({ ...state.verification, commits: [], awaitingArchive: false }),
    isCurrentReport: async () => true,
    result: async value => { state.results.push(value); },
    diagnostic: async (reason: string, snapshot?: ReportRejectionSnapshot) => { state.diagnostics.push({ reason, snapshot }); },
  };
  return { request, ports, state };
}

function assertSnapshot(diagnostic: Diagnostic, path: string, bytes: Uint8Array | null) {
  assert.ok(diagnostic.snapshot, 'Rejected reads must expose their own snapshot, not only a stderr string');
  assert.equal(diagnostic.snapshot.reportPath, path);
  assert.equal(diagnostic.snapshot.reason, diagnostic.reason, 'Notice reason and snapshot reason belong to one verification');
  assert.deepEqual(diagnostic.snapshot.bytes === null ? null : Buffer.from(diagnostic.snapshot.bytes), bytes === null ? null : Buffer.from(bytes));
}

test('[Z.373 watcher] changed description preserves all issues past 512 characters and its original bytes', async t => {
  const f = readerFixture();
  f.state.text = JSON.stringify(report());
  f.state.verification = issue(longReason);
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  assert.equal(f.state.results.length, 0, 'A rejected succeeded report must not produce a work result');
  assert.equal(f.state.diagnostics.length, 1);
  assert.ok(f.state.diagnostics[0].reason.includes(longReason), 'The complete reason, including the tail after 512 characters, must survive');
  assertSnapshot(f.state.diagnostics[0], watcher.path, Buffer.from(f.state.text));
});

for (const status of ['succeeded', 'failed'] as const) {
  for (const stage of ['parse', 'schema', 'assignment', 'checkbox', 'OpenSpec', 'archive'] as const) {
    if (status === 'failed' && ['checkbox', 'OpenSpec', 'archive'].includes(stage)) continue;
    test(`[Z.373 rejection stages] ${status}/${stage} retains a structured rejection instead of accepting work`, async () => {
      const f = readerFixture();
      f.state.text = JSON.stringify(report(status));
      const reason = `${stage}: first-change:1.1 exact diagnostic\nsecond-change:2.1 retained detail`;
      if (stage === 'parse') f.state.text = '{"status":';
      if (stage === 'schema') f.state.text = JSON.stringify({ ...report(status), status: 'unknown' });
      if (stage === 'assignment') f.state.text = JSON.stringify({ ...report(status), changes: [{ id: 'foreign-change', items: [{ id: '99', status }] }] });
      if (stage === 'checkbox') f.ports.confirmTaskCheckboxes = async () => { throw new Error(reason); };
      if (stage === 'OpenSpec') f.ports.verifyAssignmentCompletion = async () => { throw new Error(reason); };
      if (stage === 'archive') f.ports.confirmTaskCheckboxes = async () => ({ ...issue(reason), commits: [], awaitingArchive: true });
      const value = await readPendingAgentReport(f.request, f.ports);
      assert.equal(value, null, `${stage} must not yield an acceptable ${status} report`);
      assert.equal(f.state.diagnostics.length, 1, `${stage} must not be a stderr-only or thrown-only exit`);
      assert.ok(f.state.diagnostics[0].reason.length > 0);
      if (['checkbox', 'OpenSpec', 'archive'].includes(stage)) assert.ok(f.state.diagnostics[0].reason.includes(reason));
      assertSnapshot(f.state.diagnostics[0], f.state.readPaths[0], Buffer.from(f.state.text));
    });
  }
}

test('[Z.373 watcher] absent report and unrelated .tmp events are not rejected reports', async t => {
  const f = readerFixture();
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  assert.deepEqual(f.state.diagnostics, []);
  f.state.text = '{partial';
  assert.ok(f.state.listener);
  await f.state.listener('rename', 'worker.json.tmp');
  await f.state.listener('create', 'other-agent.json');
  assert.deepEqual(f.state.diagnostics, []);
  assert.deepEqual(f.state.results, []);
});

test('[Z.373 reader I/O] an existing unreadable report retains the exact read error and unavailable bytes', async () => {
  const f = readerFixture();
  const error = Object.assign(new Error('EACCES: read current report, original diagnostic detail'), { code: 'EACCES' });
  f.state.readError = error;
  assert.equal(await readPendingAgentReport(f.request, f.ports), null);
  assert.equal(f.state.diagnostics.length, 1);
  assert.ok(f.state.diagnostics[0].reason.includes(error.message));
  assertSnapshot(f.state.diagnostics[0], f.state.readPaths[0], null);
});

test('[Z.373 watcher] in-flight verification is not itself rejection and replacement binds to the old snapshot', async () => {
  const f = readerFixture();
  const original = JSON.stringify(report());
  f.state.text = original;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.ports.verifyAssignmentCompletion = async () => { entered(); await waiting; return issue(longReason); };
  const reading = readPendingAgentReport(f.request, f.ports);
  await started;
  assert.deepEqual(f.state.diagnostics, [], 'Verification in progress is not a rejection');
  f.state.text = JSON.stringify({ ...report(), answer: 'replacement' });
  release();
  assert.equal(await reading, null);
  assert.equal(f.state.diagnostics.length, 1);
  assertSnapshot(f.state.diagnostics[0], f.state.readPaths[0], Buffer.from(original));
});

test('[Z.373 freshness] final worker verification rejects a replaced snapshot through the same diagnostic port', async () => {
  const f = readerFixture();
  f.state.text = JSON.stringify(report());
  const checked = await readPendingAgentReport(f.request, f.ports);
  assert.ok(checked, 'Fixture must first obtain an otherwise valid report');
  const original = Buffer.from(f.state.text);
  f.state.text = JSON.stringify({ ...report(), answer: 'changed after verification' });
  await assert.rejects(() => verifyPendingAgentReportFreshness(f.request, checked, f.ports));
  assert.equal(f.state.diagnostics.length, 1, 'Final freshness rejection must also create a structured diagnostic');
  assertSnapshot(f.state.diagnostics[0], f.state.readPaths[0], original);
});

test('[Z.373 durable acceptance] result persistence failure uses the same snapshot and never reports success', async t => {
  const f = readerFixture();
  f.state.text = JSON.stringify(report());
  const reason = 'REPORT_UNVERIFIED: durable acceptance write failed\nfirst-change:1.1 exact SQLite cause';
  f.ports.result = async () => { throw new Error(reason); };
  const watcher = await createAgentReportWatcher(f.request, f.ports);
  t.after(() => watcher.dispose());
  assert.deepEqual(f.state.results, []);
  assert.equal(f.state.diagnostics.length, 1);
  assert.ok(f.state.diagnostics[0].reason.includes(reason));
  assertSnapshot(f.state.diagnostics[0], watcher.path, Buffer.from(f.state.text));
});

test('[Z.373 archive] provisional succeeded rejection does not block the corrected exact archive snapshot', async () => {
  const f = readerFixture();
  const reason = 'Awaiting sync/archive and exact archive in the same report: first-change';
  f.state.text = JSON.stringify(report());
  f.ports.confirmTaskCheckboxes = async () => ({ ...issue(reason), commits: [], awaitingArchive: true });
  assert.equal(await readPendingAgentReport(f.request, f.ports), null);
  assert.equal(f.state.diagnostics.length, 1);
  assert.ok(f.state.diagnostics[0].reason.includes(reason));
  const archive = '2026-10-23-first-change';
  f.state.text = JSON.stringify({ ...report(), changes: report().changes.map(change => change.id === 'first-change' ? { ...change, archive } : change) });
  const claims: Readonly<Record<string, string>>[] = [];
  f.ports.verifyAssignmentCompletion = async (_assignment, archiveClaims) => { claims.push(archiveClaims); return { ok: true, issues: [] }; };
  f.ports.confirmTaskCheckboxes = async () => ({ ok: true, issues: [], commits: [], awaitingArchive: false });
  const accepted = await readPendingAgentReport(f.request, f.ports);
  assert.equal(accepted?.event, 'agent.succeeded');
  assert.ok(claims.some(value => value['first-change'] === archive), 'Corrected archive must reach the existing OpenSpec verifier');
  assert.equal(f.state.diagnostics.length, 1);
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`[Z.373 accepted] valid ${status} is its existing result event, without report-rejected`, async t => {
    const f = readerFixture();
    f.state.text = JSON.stringify(report(status));
    const watcher = await createAgentReportWatcher(f.request, f.ports);
    t.after(() => watcher.dispose());
    assert.deepEqual(f.state.diagnostics, []);
    assert.equal(f.state.results.length, 1);
    assert.equal(f.state.results[0].event, `agent.${status}`);
    assert.ok(f.state.listener);
    await f.state.listener('modify', 'worker.json');
    assert.equal(f.state.results.length, 1, 'Accepted work is never reopened by a repeated read');
    assert.deepEqual(f.state.diagnostics, []);
  });
}

async function durableFixture(t: TestContext) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'raf-z373-'));
  const path = join(directory, 'state.sqlite');
  let store = openStateStore(path);
  t.after(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const runId = randomUUID();
  const reportPath = join(directory, runId, 'worker.json');
  const launcher = { addressId: 'launcher', runId: randomUUID() };
  const notify = { addressId: 'notify', runId: randomUUID() };
  const worker: SessionRecord = {
    runId, addressId: 'worker', revision: 1, state: 'running', launchedBy: launcher,
    activity: { type: 'implement', project: 'raf', features: ['first-change', 'second-change'], phase: 'implement', cwd: directory },
    launchContext: {
      assignment, selection: { runner: 'codex', model: 'fixture', effort: 'fixture', reason: 'isolated test dependency' },
      briefPath: join(directory, 'PRIVATE-BRIEF.md'), reportPath,
    },
  };
  store.sessionRepository.transaction(tx => {
    for (const identity of [launcher, notify, { addressId: 'main', runId: randomUUID() }]) {
      tx.putSession({ ...identity, revision: 1, state: 'running' });
    }
    tx.putSession(worker);
    tx.putReservation({ runId, resource: 'fixture-resource', amount: 1 });
  });
  const catalog: EventCatalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  const registry = () => createEventRegistry(catalog, {
    ...store.eventRepository,
    transaction: operation => store.eventRepository.transaction(tx => operation({
      ...tx,
      applyReminderEvent: (event, eventAt = at) => tx.applyReminderEvent(event, eventAt),
    })),
    validateId: (kind, id) => {
      if (kind === 'agentAddress') return /^[a-z][a-z0-9-]*$/.test(id);
      if (kind === 'reminderId') return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
      return false;
    },
  });
  const reminders = () => new ReminderService({
    repository: store.reminderRepository, now: () => at, nextId: () => randomUUID(),
    approvedEventKinds: catalog.events.map(event => event.id),
  });
  const put = (change: (session: SessionRecord) => SessionRecord) => store.sessionRepository.transaction(tx => {
    const value = tx.getSession(runId);
    assert.ok(value);
    tx.putSession(change(value));
  });
  const snapshot = (reason = longReason, bytes: Uint8Array | null = Buffer.from(JSON.stringify(report()))): ReportRejectionSnapshot => ({ reportPath, bytes, reason });
  const facts = () => store.eventRepository.transaction(tx => tx.listPending());
  const session = () => store.sessionRepository.transaction(tx => tx.getSession(runId));
  return {
    path, directory, runId, reportPath, launcher, notify, worker, catalog, registry, reminders, put, snapshot, facts, session,
    get store() { return store; },
    reopen() { store.close(); store = openStateStore(path); },
  };
}

function expectedNotice(f: Awaited<ReturnType<typeof durableFixture>>, reason: string): string {
  return `raf event: ${eventKind}\nAgent: worker\nRun: ${f.runId}\nItems: ${initialItems.join(', ')}\nReport: ${f.reportPath}\nReason: ${reason}`;
}

function completeNotice(store: StateStore, id: string, error: string | null = null) {
  const owner = { token: randomUUID(), pid: process.pid, processStart: null };
  assert.ok(store.resultNotices.claim(id, owner, at, () => false), 'Pending notice must be claimable');
  store.resultNotices.complete(id, owner.token, error);
}

test('[Z.373 catalog] registered kind and agent address ID are taken from the common catalog', async t => {
  const f = await durableFixture(t);
  assert.deepEqual(f.catalog.events.find(event => event.id === eventKind), {
    id: eventKind, idKind: 'agentAddress', description: 'Записаний звіт поточного запуску агента не прийнято',
  });
  assert.doesNotThrow(() => f.registry().validate({ kind: eventKind, id: 'worker' }));
  assert.throws(() => f.registry().validate({ kind: eventKind, id: '../worker' }));
});

test('[Z.373 notice] original items, trusted path and exact multi-line reason; no report answer or brief', async t => {
  const f = await durableFixture(t);
  recordReportRejection(f.store, f.runId, f.snapshot());
  const notices = f.store.resultNotices.list();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].text, expectedNotice(f, longReason));
  assert.equal(notices[0].recipient, f.launcher.addressId);
  assert.equal(notices[0].recipientRunId, f.launcher.runId);
  assert.ok(!notices[0].text.includes('PRIVATE-REPORT-ANSWER'));
  assert.ok(!notices[0].text.includes('PRIVATE-BRIEF'));
  assert.deepEqual(f.facts().map(fact => fact.event), [{ kind: eventKind, id: 'worker' }]);
  assert.equal(f.session()?.result, undefined);
  assert.equal(f.session()?.reportAcceptance, undefined);
  assert.equal(f.session()?.state, 'running');
  assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).length, 1);
  assert.ok(f.store.sessionRepository.transaction(tx => tx.listPending()).every(intent =>
    !['agent.succeeded', 'agent.failed', 'agent.closed', 'session-ended', 'release'].includes(intent.event)),
  'A rejected report creates no result/closure/release intent');
});

test('[Z.373 address] explicit notify overrides launcher and is pinned to the original recipient run', async t => {
  const f = await durableFixture(t);
  f.put(value => ({ ...value, notify: f.notify }));
  recordReportRejection(f.store, f.runId, f.snapshot());
  const notice = f.store.resultNotices.list()[0];
  assert.equal(notice.recipient, 'notify');
  assert.equal(notice.recipientRunId, f.notify.runId);
  assert.ok(f.store.resultNotices.list().every(value => !['main', 'worker', 'launcher'].includes(value.recipient)));
});

test('[Z.373 address] delegated launch uses its stored identity without looking up main', async t => {
  const f = await durableFixture(t);
  f.put(value => ({ ...value, launchedBy: undefined, delegatedBy: { ...f.launcher, fence: 'fixture-fence' } }));
  recordReportRejection(f.store, f.runId, f.snapshot());
  const notice = f.store.resultNotices.list()[0];
  assert.equal(notice.recipient, f.launcher.addressId);
  assert.equal(notice.recipientRunId, f.launcher.runId);
});

for (const recipient of ['missing', 'closed', 'reused-address'] as const) {
  test(`[Z.373 address] ${recipient} recipient never falls back to main or a replacement session`, async t => {
    const f = await durableFixture(t);
    if (recipient === 'missing') f.put(value => ({ ...value, launchedBy: undefined }));
    else {
      f.put(value => ({ ...value, notify: f.notify }));
      f.store.sessionRepository.transaction(tx => {
        const target = tx.getSession(f.notify.runId)!;
        tx.putSession({ ...target, state: 'finished', finishedAt: at });
        if (recipient === 'reused-address') tx.putSession({ runId: randomUUID(), addressId: 'notify', revision: 1, state: 'running' });
      });
    }
    recordReportRejection(f.store, f.runId, f.snapshot());
    const notices = f.store.resultNotices.list();
    assert.equal(notices.length, 1, 'Undeliverability must remain an observable pending notice');
    assert.equal(notices[0].state, 'pending');
    assert.ok(notices[0].recipient !== 'main');
    assert.ok(notices[0].recipient !== 'worker');
    if (recipient !== 'missing') assert.equal(notices[0].recipientRunId, f.notify.runId);
    assert.ok(notices[0].lastError, 'Unavailable/missing identity must be visible, not silently lost');
    assert.equal(f.facts().length, 1, 'An unavailable recipient does not suppress the event');
  });
}

test('[Z.373 dedup] raw byte/reason pairs survive intervening failures, dispatch, delivery and restart', async t => {
  const f = await durableFixture(t);
  const first = f.snapshot('same reason', Buffer.from('{"status":"succeeded"}'));
  recordReportRejection(f.store, f.runId, first);
  recordReportRejection(f.store, f.runId, first);
  const firstNotice = f.store.resultNotices.list()[0];
  assert.equal(f.store.resultNotices.list().length, 1);
  completeNotice(f.store, firstNotice.id);
  f.registry().dispatch();
  assert.deepEqual(f.facts(), []);
  f.reopen();
  recordReportRejection(f.store, f.runId, first);
  assert.equal(f.store.resultNotices.list().length, 1);
  assert.deepEqual(f.facts(), [], 'Consuming pending must not consume the durable dedup mark');
  recordReportRejection(f.store, f.runId, f.snapshot('same reason', Buffer.from('{ "status":"succeeded" }')));
  recordReportRejection(f.store, f.runId, f.snapshot('different reason', first.bytes));
  recordReportRejection(f.store, f.runId, first);
  assert.equal(f.store.resultNotices.list().length, 3, 'New whitespace or reason is a new pair; an old pair stays old');
  assert.equal(new Set(f.store.resultNotices.list().map(value => value.id)).size, 3);
  assert.equal(f.facts().length, 2);
});

test('[Z.373 dedup] same bytes after mtime-only change remain the same rejection', async t => {
  const f = await durableFixture(t);
  await fs.mkdir(join(f.directory, f.runId));
  const bytes = Buffer.from(JSON.stringify(report()));
  await fs.writeFile(f.reportPath, bytes);
  recordReportRejection(f.store, f.runId, f.snapshot('stable', await fs.readFile(f.reportPath)));
  await fs.utimes(f.reportPath, new Date('2026-10-23T16:00:01Z'), new Date('2026-10-23T16:00:02Z'));
  recordReportRejection(f.store, f.runId, f.snapshot('stable', await fs.readFile(f.reportPath)));
  assert.equal(f.store.resultNotices.list().length, 1);
  assert.equal(f.facts().length, 1);
});

test('[Z.373 bytes] snapshot bytes are never rebound to a later on-disk report', async t => {
  const f = await durableFixture(t);
  await fs.mkdir(join(f.directory, f.runId));
  const oldBytes = Buffer.from('{old snapshot');
  const newBytes = Buffer.from('{new snapshot');
  await fs.writeFile(f.reportPath, newBytes);
  recordReportRejection(f.store, f.runId, f.snapshot('parse failure', oldBytes));
  recordReportRejection(f.store, f.runId, f.snapshot('parse failure', newBytes));
  assert.equal(f.store.resultNotices.list().length, 2, 'A callback must not reread newer bytes for an older rejection');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  assert.notEqual(hash(oldBytes), hash(newBytes));
});

test('[Z.373 I/O] unavailable bytes have a distinct dedup identity and reading later does not stay suppressed', async t => {
  const f = await durableFixture(t);
  const reason = `EACCES: cannot read existing report ${f.reportPath}`;
  recordReportRejection(f.store, f.runId, f.snapshot(reason, null));
  recordReportRejection(f.store, f.runId, f.snapshot(reason, null));
  assert.equal(f.store.resultNotices.list().length, 1);
  assert.equal(f.store.resultNotices.list()[0].text, expectedNotice(f, reason));
  recordReportRejection(f.store, f.runId, f.snapshot(reason, new Uint8Array()));
  assert.equal(f.store.resultNotices.list().length, 2, 'Unavailable bytes must not be represented as a hash of empty bytes');
});

test('[Z.373 bytes] distinct invalid UTF-8 byte sequences cannot collapse through text decoding', async t => {
  const f = await durableFixture(t);
  const first = Buffer.from([0x7b, 0xff]);
  const second = Buffer.from([0x7b, 0xfe]);
  assert.equal(first.toString('utf8'), second.toString('utf8'));
  recordReportRejection(f.store, f.runId, f.snapshot('invalid JSON', first));
  recordReportRejection(f.store, f.runId, f.snapshot('invalid JSON', second));
  assert.equal(f.store.resultNotices.list().length, 2, 'Identity must use raw bytes, including undecodable input');
});

test('[Z.373 metadata] missing durable launch metadata is an observable rejection, not a thrown-only diagnostic', async t => {
  const f = await durableFixture(t);
  f.put(value => ({ ...value, launchContext: undefined }));
  const reason = 'Durable launch metadata missing for current run; assignment/report source cannot be verified';
  assert.doesNotThrow(() => recordReportRejection(f.store, f.runId, f.snapshot(reason)));
  const notices = f.store.resultNotices.list();
  assert.equal(notices.length, 1);
  assert.ok(notices[0].text.includes(reason));
  assert.ok(notices[0].text.includes(`Run: ${f.runId}`));
  assert.ok(notices[0].text.includes(`Report: ${f.reportPath}`));
  assert.equal(notices[0].recipientRunId, f.launcher.runId);
  assert.equal(f.facts().length, 1);
  assert.equal(f.session()?.reportAcceptance, undefined);
});

test('[Z.373 reason data] shell-like reason text is delivered verbatim without evaluation', async t => {
  const f = await durableFixture(t);
  const marker = join(f.directory, 'reason-must-not-execute');
  const reason = `Exact reason: $(touch ${marker}) \`touch ${marker}\`\nsecond line`;
  recordReportRejection(f.store, f.runId, f.snapshot(reason));
  assert.equal(f.store.resultNotices.list()[0].text, expectedNotice(f, reason));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('[Z.373 metadata] unreadable/malformed report cannot supply the assignment items or path', async t => {
  const f = await durableFixture(t);
  for (const bytes of [Buffer.from('{"status":'), Buffer.from('{"changes":[{"id":"foreign","items":[]}],"reportPath":"/forged"}')]) {
    recordReportRejection(f.store, f.runId, f.snapshot('invalid report', bytes));
  }
  assert.equal(f.store.resultNotices.list().length, 2);
  for (const notice of f.store.resultNotices.list()) {
    assert.equal(notice.text, expectedNotice(f, 'invalid report'));
    assert.ok(!notice.text.includes('/forged'));
    assert.ok(!notice.text.includes('foreign'));
  }
});

test('[Z.373 transaction] event/notice failure rolls back dedup and all staged effects; retry can succeed', async t => {
  const f = await durableFixture(t);
  const db = f.store.startupContextDatabase;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  assert.ok(tables.some(value => value.name === 'result_notices'), 'Use the existing durable notice table');
  db.exec("CREATE TEMP TRIGGER z373_fail_notice BEFORE INSERT ON result_notices BEGIN SELECT RAISE(ABORT, 'z373 injected durable failure'); END");
  assert.throws(() => recordReportRejection(f.store, f.runId, f.snapshot()), /z373 injected durable failure/);
  assert.equal(f.store.resultNotices.list().length, 0);
  assert.deepEqual(f.facts(), []);
  assert.equal(f.session()?.result, undefined);
  db.exec('DROP TRIGGER z373_fail_notice');
  recordReportRejection(f.store, f.runId, f.snapshot());
  assert.equal(f.store.resultNotices.list().length, 1, 'Failed transaction must not leave an already-notified mark');
  assert.equal(f.facts().length, 1);
});

test('[Z.373 retry] failed delivery retries the same notice without adding the transport error to Reason', async t => {
  const f = await durableFixture(t);
  recordReportRejection(f.store, f.runId, f.snapshot());
  const notice = f.store.resultNotices.list()[0];
  completeNotice(f.store, notice.id, 'recipient transport unavailable');
  f.reopen();
  recordReportRejection(f.store, f.runId, f.snapshot());
  const retried = f.store.resultNotices.list();
  assert.equal(retried.length, 1);
  assert.equal(retried[0].id, notice.id);
  assert.equal(retried[0].state, 'pending');
  assert.equal(retried[0].text, expectedNotice(f, longReason));
  assert.equal(retried[0].lastError, 'recipient transport unavailable');
  completeNotice(f.store, notice.id);
  f.reopen();
  assert.equal(f.store.resultNotices.list()[0].state, 'delivered');
  assert.equal(f.store.resultNotices.list()[0].attempts, 2);
});

test('[Z.373 claims] a second dispatcher cannot claim an active notice; dead owner can be recovered', async t => {
  const f = await durableFixture(t);
  recordReportRejection(f.store, f.runId, f.snapshot());
  const id = f.store.resultNotices.list()[0].id;
  const first = { token: 'first', pid: process.pid, processStart: null };
  const second = { token: 'second', pid: process.pid, processStart: null };
  assert.ok(f.store.resultNotices.claim(id, first, at, () => true));
  const other = openStateStore(f.path);
  try {
    assert.equal(other.resultNotices.claim(id, second, at, () => true), undefined);
    assert.ok(other.resultNotices.claim(id, second, at, () => false));
    other.resultNotices.complete(id, second.token, null);
  } finally { other.close(); }
  assert.equal(f.store.resultNotices.list()[0].state, 'delivered');
});

test('[Z.373 restart] staged facts and notices remain claimable after restart before dispatch or delivery', async t => {
  const f = await durableFixture(t);
  recordReportRejection(f.store, f.runId, f.snapshot());
  const id = f.store.resultNotices.list()[0].id;
  f.reopen();
  assert.equal(f.facts().length, 1);
  assert.equal(f.store.resultNotices.list()[0].id, id);
  assert.equal(f.store.resultNotices.list()[0].state, 'pending');
  f.registry().dispatch();
  f.reopen();
  assert.deepEqual(f.facts(), []);
  recordReportRejection(f.store, f.runId, f.snapshot());
  assert.equal(f.store.resultNotices.list().length, 1);
  completeNotice(f.store, id);
  assert.equal(f.store.resultNotices.list()[0].state, 'delivered');
});

test('[Z.373 reminders] add/update activate/close use exact agent address independently of notice delivery', async t => {
  const f = await durableFixture(t);
  f.put(value => ({ ...value, notify: { addressId: 'missing-notify', runId: randomUUID() } }));
  const service = f.reminders();
  const add = (id: string, action: 'activate' | 'close') => service.add({
    to: 'launcher', at: '2026-10-24T16:00:00.000Z', text: `Binding ${id}/${action}`,
    binding: { kind: eventKind, id, action },
  });
  const activate = add('worker', 'activate');
  const close = add('worker', 'close');
  const other = add('other-worker', 'activate');
  const updated = add('other-worker', 'activate');
  service.update(updated.id, { binding: { kind: eventKind, id: 'worker', action: 'activate' } });
  const wrongKind = service.add({
    to: 'launcher', at: '2026-10-24T16:00:00.000Z', text: 'Only accepted success closes this',
    binding: { kind: 'agent.succeeded', id: 'worker', action: 'close' },
  });
  recordReportRejection(f.store, f.runId, f.snapshot());
  const dispatched = f.registry().dispatch();
  assert.equal(dispatched.delivered.length, 1);
  assert.deepEqual(f.facts().filter(value => value.kind === eventKind), [], 'Dispatch must consume the rejection fact even when reminder transitions enqueue their own events');
  const all = service.list();
  assert.equal(all.find(value => value.id === activate.id)?.state, 'active');
  assert.equal(all.find(value => value.id === updated.id)?.state, 'active');
  assert.equal(all.find(value => value.id === close.id)?.state, 'closed');
  assert.equal(all.find(value => value.id === other.id)?.state, 'pending');
  assert.equal(all.find(value => value.id === wrongKind.id)?.state, 'pending');
  assert.equal(f.store.resultNotices.list()[0].state, 'pending');
  const closedAt = all.find(value => value.id === close.id)?.closedAt;
  assert.equal(closedAt, at);
  f.reopen();
  assert.doesNotThrow(() => f.registry().validate({ kind: 'reminder.closed', id: close.id }));
  assert.throws(() => f.registry().validate({ kind: 'reminder.closed', id: '../reminder' }));
  recordReportRejection(f.store, f.runId, f.snapshot());
  f.registry().dispatch();
  assert.equal(f.reminders().list().find(value => value.id === close.id)?.closedAt, closedAt);
});

test('[Z.373 stale] accepted results and old run/path callbacks cannot reopen work or rebind an address', async t => {
  const f = await durableFixture(t);
  f.put(value => ({ ...value, result: { status: 'succeeded', response: 'accepted', proof: {} }, reportAcceptance: { runId: f.runId, status: 'succeeded', event: 'agent.succeeded' } }));
  const acceptedNotices = f.store.resultNotices.list();
  assert.ok(acceptedNotices.every(value => !value.text.includes(`raf event: ${eventKind}`)));
  recordReportRejection(f.store, f.runId, f.snapshot());
  assert.deepEqual(f.store.resultNotices.list(), acceptedNotices, 'An accepted result keeps its existing result notice without adding a rejection');
  assert.deepEqual(f.facts(), []);
  assert.equal(f.session()?.result?.status, 'succeeded');
  f.put(value => ({ ...value, state: 'finished', finishedAt: at }));
  const replacement = { ...f.worker, runId: randomUUID(), launchedBy: f.notify };
  f.store.sessionRepository.transaction(tx => tx.putSession(replacement));
  const replacementNotices = f.store.resultNotices.list();
  recordReportRejection(f.store, f.runId, f.snapshot());
  assert.deepEqual(f.store.resultNotices.list(), replacementNotices, 'An old run callback must not add or redirect notices');
  assert.deepEqual(f.facts(), []);
  assert.equal(f.store.sessionRepository.transaction(tx => tx.getSession(replacement.runId))?.result, undefined);
  recordReportRejection(f.store, replacement.runId, { ...f.snapshot(), reportPath: '/foreign/worker.json' });
  assert.deepEqual(f.store.resultNotices.list(), replacementNotices, 'A callback with the wrong trusted path is not a report for this launch');
  assert.deepEqual(f.facts(), []);
});

test('[Z.373 lifecycle] same address and bytes with a new run has its own rejection identity', async t => {
  const f = await durableFixture(t);
  recordReportRejection(f.store, f.runId, f.snapshot());
  f.put(value => ({ ...value, state: 'finished', finishedAt: at }));
  const runId = randomUUID();
  const nextPath = join(f.directory, runId, 'worker.json');
  f.store.sessionRepository.transaction(tx => tx.putSession({ ...f.worker, runId, launchContext: { ...f.worker.launchContext!, reportPath: nextPath } }));
  recordReportRejection(f.store, runId, { ...f.snapshot(), reportPath: nextPath });
  assert.equal(f.store.resultNotices.list().length, 2);
  assert.equal(new Set(f.store.resultNotices.list().map(value => value.runId)).size, 2);
});

test('[Z.373 notices] existing diagnostic notice path also has the registered event envelope and no fallback', async t => {
  const f = await durableFixture(t);
  const notice = createReportDiagnosticNotice(f.worker, longReason);
  assert.equal(notice.text, expectedNotice(f, longReason));
  const unknown = createReportDiagnosticNotice({ ...f.worker, launchedBy: undefined }, longReason);
  assert.ok(unknown.recipient !== 'main', 'Legacy diagnostic wrapper must not silently retain DEFAULT_LAUNCHER');
});

async function childRecord(path: string, runId: string, snapshot: ReportRejectionSnapshot) {
  const child = fork(ownModule, [], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, RAF_Z373_CHILD_RECORD: JSON.stringify({ path, runId, snapshot: { ...snapshot, bytes: snapshot.bytes === null ? null : Buffer.from(snapshot.bytes).toString('base64') } }) },
  });
  let stderr = '';
  child.stderr!.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, stderr);
}

if (process.env.RAF_Z373_CHILD_RECORD) {
  const input = JSON.parse(process.env.RAF_Z373_CHILD_RECORD);
  const store = openStateStore(input.path);
  try {
    recordReportRejection(store, input.runId, { ...input.snapshot, bytes: input.snapshot.bytes === null ? null : Buffer.from(input.snapshot.bytes, 'base64') });
  } finally { store.close(); }
  process.exit(0);
}

test('[Z.373 processes] separate writer processes share durable dedup, including after dispatch/restart', async t => {
  const f = await durableFixture(t);
  await Promise.all([0, 1, 2].map(() => childRecord(f.path, f.runId, f.snapshot())));
  assert.equal(f.store.resultNotices.list().length, 1);
  assert.equal(f.facts().length, 1);
  const notice = f.store.resultNotices.list()[0];
  completeNotice(f.store, notice.id);
  f.registry().dispatch();
  f.reopen();
  await childRecord(f.path, f.runId, f.snapshot());
  assert.equal(f.store.resultNotices.list().length, 1);
  assert.equal(f.store.resultNotices.list()[0].state, 'delivered');
  assert.deepEqual(f.facts(), []);
});

for (const explicitNotify of [false, true]) {
  test(`[Z.373 production] ${explicitNotify ? 'notify' : 'launcher'} receives rejection before ps; correction is accepted once`, async t => {
    const runtime = JSON.parse(await fs.readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
    const { timeouts } = runtime.runnerProtocols.find((value: { runner: string }) => value.runner === 'codex');
    const f = await agentRunFixture(t, 'ready', timeouts, 'codex', {
      tasks: 4, commands: ['reminder add', 'reminder update', 'reminder list'], productionQa: true,
    });
    const launcher = await f.run('launcher', 'implement', ['1.1']);
    assert.equal(launcher.exitCode, 0, JSON.stringify(launcher));
    if (explicitNotify) {
      const notify = await f.run('notify', 'implement', ['1.3']);
      assert.equal(notify.exitCode, 0, JSON.stringify(notify));
    }
    const argv = f.runArgs('worker', 'implement', ['1.2']);
    if (explicitNotify) argv.push('--notify', 'notify');
    const launched = await f.as('launcher', argv);
    assert.equal(launched.exitCode, 0, JSON.stringify(launched));
    const sessions = f.inspect().sessions;
    const worker = sessions.find(value => value.addressId === 'worker')!;
    const target = sessions.find(value => value.addressId === (explicitNotify ? 'notify' : 'launcher'))!;
    assert.ok(worker.launchContext);
    assert.ok(target.process);
    const tasksPath = join(worker.launchContext.assignment.root, 'openspec', 'changes', 'launch-failure-fixture', 'tasks.md');
    const original = await fs.readFile(tasksPath, 'utf8');
    const originalTask = worker.launchContext.assignment.changes[0].items[0];
    await fs.writeFile(tasksPath, original.replace(originalTask.description, `${originalTask.description} changed after launch`));
    await f.git('add', '--', 'openspec/changes/launch-failure-fixture/tasks.md');
    await f.git('commit', '-qm', 'change assigned description after launch');
    const reportPath = worker.launchContext.reportPath;
    const value = {
      status: 'succeeded', answer: 'PRIVATE-PRODUCTION-ANSWER', commits: [],
      changes: [{ id: 'launch-failure-fixture', items: [{ id: '1.2', status: 'succeeded' }] }],
    };
    const bytes = JSON.stringify(value);
    await fs.writeFile(`${reportPath}.tmp`, bytes);
    await fs.rename(`${reportPath}.tmp`, reportPath);
    const delivered = await until(() => f.input(target.process!.pid), text => text.includes(`raf event: ${eventKind}`), 'watcher delivered rejection without any agent ps polling');
    assert.ok(delivered.includes('Agent: worker'));
    assert.ok(delivered.includes(`Run: ${worker.runId}`));
    assert.ok(delivered.includes('Items: launch-failure-fixture:1.2'));
    assert.ok(delivered.includes(`Report: ${reportPath}`));
    assert.match(delivered, /Reason:[\s\S]*(?:identity|description|опис|Assignment)/);
    assert.ok(!delivered.includes('PRIVATE-PRODUCTION-ANSWER'));
    for (const other of sessions.filter(value => value.addressId !== target.addressId && value.process)) {
      assert.ok(!(await f.input(other.process!.pid)).includes(`raf event: ${eventKind}`), `${other.addressId} must not receive a fallback/broadcast rejection`);
    }
    const rejected = f.inspect().sessions.find(value => value.runId === worker.runId)!;
    assert.equal(rejected.result, undefined);
    assert.equal(rejected.reportAcceptance, undefined);
    assert.equal(rejected.state, 'running');
    assert.ok(f.inspect().claims.some(value => value.lease.owner.runId === worker.runId));
    const databasePath = join(f.tmpRoot, '..', 'state.sqlite');
    const notices = () => { const store = openStateStore(databasePath); try { return store.resultNotices.list().filter(value => value.runId === worker.runId); } finally { store.close(); } };
    await f.command(['agent', 'ps']);
    await fs.writeFile(`${reportPath}.tmp`, bytes);
    await fs.rename(`${reportPath}.tmp`, reportPath);
    await f.command(['agent', 'ps']);
    assert.equal(notices().length, 1, 'Worker watcher and reconciliation share one durable rejection');
    assert.equal(notices()[0].recipientRunId, target.runId);
    assert.equal(notices()[0].state, 'delivered');
    await fs.writeFile(tasksPath, original);
    await f.git('add', '--', 'openspec/changes/launch-failure-fixture/tasks.md');
    await f.git('commit', '-qm', 'restore assigned source identity');
    await fs.writeFile(`${reportPath}.tmp`, JSON.stringify({ ...value, answer: 'corrected' }));
    await fs.rename(`${reportPath}.tmp`, reportPath);
    await until(() => f.inspect().sessions.find(value => value.runId === worker.runId), value => value?.result?.status === 'succeeded', 'corrected report accepted while runner remains alive');
    await f.command(['agent', 'ps']);
    const accepted = f.inspect().sessions.find(value => value.runId === worker.runId)!;
    assert.equal(accepted.reportAcceptance?.event, 'agent.succeeded');
    assert.equal(accepted.state, 'running');
    const finalNotices = notices();
    assert.equal(finalNotices.filter(value => value.text.includes(`raf event: ${eventKind}`)).length, 1);
    assert.equal(finalNotices.filter(value => !value.text.includes(`raf event: ${eventKind}`)).length, 1);
  });
}

test('[Z.373 reconciliation] orphan worker rejection is delivered through CLI with the native runner still alive', async t => {
  const runtime = JSON.parse(await fs.readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));
  const { timeouts } = runtime.runnerProtocols.find((value: { runner: string }) => value.runner === 'codex');
  const f = await agentRunFixture(t, 'ready', timeouts, 'codex', { tasks: 3, productionQa: true });
  const launcher = await f.run('launcher', 'implement', ['1.1']);
  assert.equal(launcher.exitCode, 0, JSON.stringify(launcher));
  const launched = await f.as('launcher', f.runArgs('worker', 'implement', ['1.2']));
  assert.equal(launched.exitCode, 0, JSON.stringify(launched));
  const before = f.inspect();
  const worker = before.sessions.find(value => value.addressId === 'worker')!;
  const target = before.sessions.find(value => value.addressId === 'launcher')!;
  const nativePid = Number(await fs.readFile(join(f.control, 'worker.brief'), 'utf8'));
  const wrapper = worker.launchContext?.wrapper
    ?? before.claims.find(value => value.lease.owner.runId === worker.runId)?.wrapper;
  assert.ok(wrapper, 'Fixture must expose the durable worker wrapper identity');
  assert.notEqual(wrapper.pid, nativePid);
  process.kill(wrapper.pid, 'SIGKILL');
  await until(() => alive(wrapper.pid), value => !value, 'only the watcher/worker wrapper has exited');
  assert.ok(alive(nativePid), 'Native runner is still available to reconciliation');
  assert.ok(worker.launchContext);
  const reportPath = worker.launchContext.reportPath;
  const partial = Buffer.from('{"status":"succeeded",');
  await fs.writeFile(`${reportPath}.tmp`, partial);
  await fs.rename(`${reportPath}.tmp`, reportPath);
  const ps = await f.command(['agent', 'ps']);
  assert.equal(ps.exitCode, 0, JSON.stringify(ps));
  assert.ok(target.process);
  const input = await until(() => f.input(target.process!.pid), text => text.includes(`raf event: ${eventKind}`), 'reconciliation delivers the rejection without a watcher');
  assert.ok(input.includes(`Run: ${worker.runId}`));
  assert.ok(input.includes(`Report: ${reportPath}`));
  assert.ok(input.includes('Items: launch-failure-fixture:1.2'));
  assert.match(input, /Reason:[\s\S]*(?:JSON|json|parse|Unexpected|невалід)/);
  const repeated = await f.command(['agent', 'ps']);
  assert.equal(repeated.exitCode, 0, JSON.stringify(repeated));
  for (const byte of [0xff, 0xfe]) {
    await fs.writeFile(`${reportPath}.tmp`, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, byte, 0x7d]));
    await fs.rename(`${reportPath}.tmp`, reportPath);
    const polled = await f.command(['agent', 'ps']);
    assert.equal(polled.exitCode, 0, JSON.stringify(polled));
  }
  const statePath = join(f.tmpRoot, '..', 'state.sqlite');
  const store = openStateStore(statePath);
  try {
    const notices = store.resultNotices.list().filter(value => value.runId === worker.runId);
    assert.equal(notices.length, 3, 'Partial JSON and two different raw invalid UTF-8 snapshots are three facts; repeated ps is not a fourth');
    for (const notice of notices) {
      assert.equal(notice.state, 'delivered');
      assert.equal(notice.recipientRunId, target.runId);
    }
  } finally { store.close(); }
  const pending = f.inspect().sessions.find(value => value.runId === worker.runId)!;
  assert.equal(pending.result, undefined);
  assert.equal(pending.reportAcceptance, undefined);
  assert.ok(alive(nativePid));
});
