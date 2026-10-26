import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmReportWithRetry, ConfirmationTransientError } from '../src/report-confirmation-retry.ts';
import type {
  ConfirmationCandidate, ConfirmationFailure, ConfirmationOutcome, ConfirmationPorts,
  ConfirmationRequest, ConfirmationRoute, ConfirmationStage, ConfirmationStepContext,
  ConfirmationStepResult,
} from '../src/report-confirmation-retry.ts';

const routes: ConfirmationRoute[] = ['watcher', 'worker-result', 'reconciliation'];
const stages: ConfirmationStage[] = ['checkbox', 'final-check', 'accept'];
const ok: ConfirmationStepResult = { kind: 'ok' };
const race: ConfirmationStepResult = { kind: 'transient', cause: 'source-read-race', reason: 'guard observed a replaced descriptor', item: 'change:A.1' };
const busy: ConfirmationStepResult = { kind: 'transient', cause: 'writer-busy', reason: 'verified live writer owns the lock', item: 'change:A.1' };

function fixture() {
  const request: ConfirmationRequest = {
    runId: 'run-393', reportPath: '/isolated/reports/run-393.json', runner: 'selected-runner',
    route: 'watcher', trigger: 'snapshot', launchIdentity: 'immutable-launch-identity',
  };
  const original: ConfirmationCandidate = {
    bytes: '{"status":"succeeded","version":1}', status: 'succeeded', items: ['change:A.1', 'change:B.2'],
    commits: [{ repository: '/isolated/repository', sha: 'a'.repeat(40) }],
  };
  const state = {
    time: 0, protocol: { timeouts: { transitionMs: 29, pollMs: 7 } } as unknown,
    candidate: original, reportKind: 'candidate' as 'candidate' | 'absent' | 'invalid',
    runId: request.runId, lifecycle: 'open' as 'open' | 'accepted' | 'closed',
    lease: false, checkboxes: new Set<string>(),
    accepted: [] as string[], rejections: [] as { bytes: string; failure: ConfirmationFailure }[],
    log: [] as { stage: ConfirmationStage; at: number; bytes: string; identity: string; head: string }[],
    scripts: new Map<ConfirmationStage, ConfirmationStepResult[]>(), costs: new Map<ConfirmationStage, number>(),
    sleeps: [] as number[], reads: 0, noReport: 0, releases: 0, protocolReads: [] as string[],
    foreignBytes: 'neighbor [x] with new evidence', foreignIndex: 'staged neighbor edit', foreignLock: 'other writer',
    head: 'head-1', onSleep: undefined as undefined | (() => Promise<void>),
    onStage: undefined as undefined | ((stage: ConfirmationStage, context: ConfirmationStepContext) => void),
  };
  async function step(stage: ConfirmationStage, context: ConfirmationStepContext): Promise<ConfirmationStepResult> {
    assert.equal(context.request.launchIdentity, request.launchIdentity);
    assert.equal(context.request.runId, request.runId);
    assert.equal(context.candidate.bytes, state.candidate.bytes, 'a replaced snapshot must never write');
    if (stage !== 'queue') assert.equal(state.lease, true);
    state.log.push({ stage, at: state.time,
      bytes: context.candidate.bytes, identity: context.request.launchIdentity, head: state.head });
    state.onStage?.(stage, context);
    state.time += state.costs.get(stage) ?? 0;
    return state.scripts.get(stage)?.shift() ?? ok;
  }
  const ports: ConfirmationPorts = {
    now: () => state.time,
    sleep: async milliseconds => {
      assert.equal(state.lease, false, 'release write locks and serialization before polling');
      assert.ok(milliseconds > 0, 'do not busy-spin');
      state.sleeps.push(milliseconds);
      state.time += milliseconds;
      await state.onSleep?.();
    },
    runnerProtocol: runner => { state.protocolReads.push(runner); return state.protocol; },
    currentRun: async () => ({ runId: state.runId, state: state.lifecycle }),
    readReport: async () => {
      state.reads++;
      if (state.reportKind === 'absent') return { kind: 'absent' };
      if (state.reportKind === 'invalid') return { kind: 'invalid', bytes: state.candidate.bytes, failure: { code: 'INVALID_REPORT', reason: 'invalid JSON' } };
      return { kind: 'candidate', candidate: structuredClone(state.candidate) };
    },
    enterAttempt: async context => { const result = await step('queue', context); if (result.kind === 'ok') state.lease = true; return result; },
    releaseAttempt: async () => { state.lease = false; state.releases++; },
    confirmCheckboxes: async context => {
      const result = await step('checkbox', context);
      if (result.kind === 'ok') for (const item of context.candidate.items) state.checkboxes.add(item);
      return result;
    },
    finalCheck: context => step('final-check', context),
    accept: async context => {
      const result = await step('accept', context);
      if (result.kind === 'ok') {
        assert.equal(state.lifecycle, 'open');
        state.accepted.push(context.candidate.status);
        state.lifecycle = 'accepted';
      }
      return result;
    },
    reject: async (_request, snapshotBytes, failure) => { state.rejections.push({ bytes: snapshotBytes, failure }); },
    finishNoReport: async () => { state.noReport++; },
  };
  return { request, original, state, ports, run: () => confirmReportWithRetry(request, ports) };
}

function sequence(f: ReturnType<typeof fixture>, stage: ConfirmationStage, ...results: ConfirmationStepResult[]) {
  f.state.scripts.set(stage, results);
}

function assertAccepted(f: ReturnType<typeof fixture>, result: ConfirmationOutcome, status = 'succeeded') {
  assert.deepEqual(result, { kind: 'accepted', status });
  assert.deepEqual(f.state.accepted, [status]);
  assert.equal(f.state.rejections.length, 0);
  assert.equal(f.state.noReport, 0);
  assert.equal(f.state.lease, false);
}

for (const cause of ['source-read-race', 'index-busy'] as const) {
  test(`Z430 ${cause} retries without a filesystem notification`, async () => {
    const f = fixture();
    let attempts = 0;
    f.ports.confirmCheckboxes = async () => {
      if (++attempts === 1) {
        if (cause === 'source-read-race') throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
        throw new ConfirmationTransientError(cause, 'Git index.lock is busy; retain foreign lock');
      }
      return ok;
    };
    f.ports.waitForChange = async deadline => { f.state.time = deadline; };
    assertAccepted(f, await f.run());
    assert.equal(attempts, 2);
    assert.equal(f.state.time, 7);
  });
}

for (const route of routes) {
  test(`${route}: live writer releases; same JSON is accepted without a file event`, async () => {
    const f = fixture(); f.request.route = route;
    sequence(f, 'checkbox', busy, ok);
    const result = await f.run();
    assertAccepted(f, result);
    assert.equal(f.state.candidate.bytes, f.original.bytes);
    assert.deepEqual([...f.state.checkboxes], f.original.items);
    assert.deepEqual(f.state.sleeps, [7]);
    assert.equal(f.state.log.filter(x => x.stage === 'queue').length, 2);
    assert.ok(f.state.reads >= 2);
    assert.deepEqual(f.state.protocolReads, [f.request.runner]);
  });

  for (const stage of ['checkbox', 'final-check'] as const) {
    test(`${route}: guarded read race at ${stage} discards the attempt and revalidates everything`, async () => {
      const f = fixture(); f.request.route = route;
      sequence(f, stage, race, ok);
      const result = await f.run();
      assertAccepted(f, result);
      const log = f.state.log.map(x => x.stage);
      const first = log.indexOf(stage);
      assert.equal(log[first + 1], 'queue', 'no partial source permission survives the race');
      assert.deepEqual(log.slice(first + 2, first + 3), ['checkbox']);
      assert.deepEqual(log.slice(-stages.length), stages);
      assert.equal(f.state.checkboxes.size, 2);
    });
  }
}

test('unrelated checkbox, evidence, file stat and HEAD changes preserve launch identity and foreign state', async () => {
  const f = fixture(); sequence(f, 'checkbox', race, ok);
  f.state.onSleep = async () => { f.state.head = 'head-2'; };
  assertAccepted(f, await f.run());
  assert.equal(f.state.foreignBytes, 'neighbor [x] with new evidence');
  assert.equal(f.state.foreignIndex, 'staged neighbor edit');
  assert.equal(f.state.foreignLock, 'other writer');
  assert.equal(f.state.head, 'head-2');
  assert.equal(f.request.launchIdentity, 'immutable-launch-identity');
  assert.equal(f.state.log.find(x => x.stage === 'final-check')?.head, 'head-2');
});

for (const reason of ['description changed', 'ID changed', 'duplicate ID', 'item deleted', 'change instance replaced', 'trusted path replaced']) {
  test(`race followed by proven mismatch: ${reason}`, async () => {
    const f = fixture();
    const failure = { code: 'ASSIGNMENT_MISMATCH', reason, item: 'change:A.1' };
    sequence(f, 'checkbox', race, { kind: 'rejected', failure });
    const result = await f.run();
    assert.deepEqual(result, { kind: 'rejected', failure });
    assert.deepEqual(f.state.rejections, [{ bytes: f.original.bytes, failure }]);
    assert.equal(f.state.checkboxes.size, 0);
    assert.deepEqual(f.state.sleeps, [7]);
    assert.equal(f.request.launchIdentity, 'immutable-launch-identity');
  });
}

for (const [stage, code] of [
  ['final-check', 'EACCES'], ['checkbox', 'UNKNOWN_LOCK_OWNER'],
  ['checkbox', 'OWN_LINE_CONFLICT'], ['final-check', 'OPENSPEC_MISMATCH'],
] as const) {
  test(`${code} at ${stage} is rejected even when its message contains busy/race`, async () => {
    const f = fixture(); const failure = { code, reason: 'busy race words are not typed evidence', item: 'change:A.1' };
    sequence(f, stage, { kind: 'rejected', failure });
    assert.deepEqual(await f.run(), { kind: 'rejected', failure });
    assert.deepEqual(f.state.rejections, [{ bytes: f.original.bytes, failure }]);
    assert.deepEqual(f.state.sleeps, []);
    assert.equal(f.state.accepted.length, 0);
    assert.equal(f.state.lease, false);
  });
}

test('polling releases the attempt so a different ready run can progress', async () => {
  const f = fixture(); const other = fixture(); other.request.runId = 'other-run'; other.state.runId = 'other-run';
  sequence(f, 'checkbox', busy, ok);
  f.state.onSleep = async () => { assert.equal(f.state.lease, false); assertAccepted(other, await other.run()); };
  assertAccepted(f, await f.run());
  assert.equal(other.state.accepted.length, 1);
});

for (const protocol of [undefined, {}, { timeouts: {} }, { timeouts: { transitionMs: 0, pollMs: 7 } },
  { timeouts: { transitionMs: 29, pollMs: -1 } }, { timeouts: { transitionMs: '29', pollMs: 7 } },
  { timeouts: { transitionMs: Infinity, pollMs: 7 } }, { timeouts: { transitionMs: 29, pollMs: NaN } }]) {
  test(`invalid selected runner protocol ${JSON.stringify(protocol)} fails explicitly before side effects`, async () => {
    const f = fixture(); f.state.protocol = protocol;
    const result = await f.run();
    assert.equal(result.kind, 'configuration-error');
    if (result.kind === 'configuration-error') assert.match(result.pointer, /runnerProtocols/);
    assert.equal(f.state.log.length, 0);
    assert.equal(f.state.rejections.length, 0);
  });
}

for (const change of ['bytes', 'accepted', 'closed', 'reused-address'] as const) {
  test(`candidate freshness during pause: ${change}`, async () => {
    const f = fixture(); sequence(f, 'queue', race, ok);
    f.state.onSleep = async () => {
      if (change === 'bytes') f.state.candidate = { ...f.original, bytes: '{"status":"succeeded","version":2}' };
      if (change === 'accepted') f.state.lifecycle = 'accepted';
      if (change === 'closed') f.state.lifecycle = 'closed';
      if (change === 'reused-address') f.state.runId = 'new-run';
    };
    const result = await f.run();
    if (change === 'bytes') {
      if (result.kind === 'superseded') {
        f.state.onSleep = undefined;
        assertAccepted(f, await confirmReportWithRetry(f.request, f.ports));
      } else assertAccepted(f, result);
      const writes = f.state.log.filter(x => ['checkbox', 'accept'].includes(x.stage));
      assert.ok(writes.every(x => x.bytes === f.state.candidate.bytes));
      assert.ok(f.state.log.some(x => x.stage === 'final-check' && x.bytes === f.state.candidate.bytes));
    } else {
      assert.equal(result.kind, 'superseded');
      assert.equal(f.state.checkboxes.size, 0);
      assert.equal(f.state.accepted.length, 0);
    }
  });
}

test('report changed immediately before durable acceptance cannot accept cached validated bytes', async () => {
  const f = fixture();
  f.state.onStage = stage => {
    if (stage === 'final-check') {
      f.state.candidate = { ...f.original, bytes: 'invalid replacement' };
      f.state.reportKind = 'invalid';
    }
  };
  f.state.reportKind = 'candidate';
  const result = await f.run();
  assert.notEqual(result.kind, 'accepted');
  assert.equal(f.state.accepted.length, 0);
  assert.equal(f.state.log.filter(x => x.stage === 'accept').length, 0);
});

test('failed with commits retries final verification without new checkboxes', async () => {
  const f = fixture(); f.state.candidate = { ...f.original, status: 'failed', bytes: '{"status":"failed"}' };
  sequence(f, 'final-check', race, ok);
  assertAccepted(f, await f.run(), 'failed');
  assert.equal(f.state.checkboxes.size, 0);
  assert.equal(f.state.log.filter(x => x.stage === 'checkbox').length, 0);
});

test('missing report on runner exit keeps existing no-report handling', async () => {
  const f = fixture(); f.request.trigger = 'runner-exit'; f.state.reportKind = 'absent';
  assert.deepEqual(await f.run(), { kind: 'no-report' });
  assert.equal(f.state.noReport, 1);
});

test('invalid report on runner exit is a real rejection and never pending', async () => {
  const f = fixture(); f.request.trigger = 'runner-exit'; f.state.reportKind = 'invalid';
  const result = await f.run();
  assert.equal(result.kind, 'rejected');
  assert.equal(f.state.log.length, 0);
});

test('last item awaiting archive uses its existing rejection contract without transient retries', async () => {
  const f = fixture(); sequence(f, 'final-check', { kind: 'awaiting-archive', reason: 'exact archive and final executor commits required' });
  assert.deepEqual(await f.run(), { kind: 'awaiting-archive', reason: 'exact archive and final executor commits required' });
  assert.equal(f.state.checkboxes.size, 2);
  assert.equal(f.state.accepted.length, 0);
  assert.deepEqual(f.state.sleeps, []);
});


test('partial checkbox progress is retained while all assigned identities are rechecked', async () => {
  const f = fixture(); sequence(f, 'checkbox', busy, ok);
  let first = true;
  f.state.onStage = stage => {
    if (stage === 'checkbox' && first) {
      first = false;
      f.state.checkboxes.add('change:A.1');
    }
  };
  f.state.onSleep = async () => {
    assert.deepEqual([...f.state.checkboxes], ['change:A.1']);
  };
  assertAccepted(f, await f.run());
  assert.equal(f.state.checkboxes.size, 2);
  assert.equal(f.state.log.filter(x => x.stage === 'checkbox').length, 2);
});

test('a stable mismatch after a partial checkbox does not roll back proven progress or mark remaining items', async () => {
  const failure = { code: 'ASSIGNMENT_MISMATCH', reason: 'second item description changed', item: 'change:B.2' };
  const f = fixture(); sequence(f, 'checkbox', busy, { kind: 'rejected', failure });
  f.state.onStage = stage => { if (stage === 'checkbox') f.state.checkboxes.add('change:A.1'); };
  assert.deepEqual(await f.run(), { kind: 'rejected', failure });
  assert.deepEqual([...f.state.checkboxes], ['change:A.1']);
  assert.equal(f.state.accepted.length, 0);
  assert.deepEqual(f.state.rejections, [{ bytes: f.original.bytes, failure }]);
});

for (const lifecycle of ['accepted', 'closed'] as const) {
  test(`an already ${lifecycle} run never begins a new confirmation attempt`, async () => {
    const f = fixture(); f.state.lifecycle = lifecycle;
    assert.deepEqual(await f.run(), { kind: 'superseded' });
    assert.equal(f.state.log.length, 0);
    assert.equal(f.state.accepted.length, 0);
  });
}
