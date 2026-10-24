import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStateStore } from '../src/state-store.ts';
import { sqliteTestRunState } from '../src/test-run-runtime.ts';
import { observeReservedTestTree } from '../src/test-run-resource-process.ts';
import { recoverTestRun, type RecoveryGroup, type RecoveryStatePort } from '../src/test-run-state-recovery.ts';

const script = fileURLToPath(import.meta.url);
const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const identity = (pid: number) => {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  assert.notEqual(fields[0], 'Z');
  return JSON.stringify({ pid, start: fields[19], boot });
};

if (process.argv[2] === 'recover') {
  const root = resolve(process.argv[3]);
  const fixture = json(join(root, 'fixture.json')) as RecoveryGroup;
  const store = openStateStore(join(root, '.raf/state.sqlite'));
  const state = sqliteTestRunState(store) as RecoveryStatePort;
  try {
    const reply = await recoverTestRun({ key: fixture.key, authorized: true, nowMs: Date.now() }, {
      state,
      observe: async flight => {
        const owner = observeReservedTestTree(flight.ownerIdentity ?? flight.wrapperIdentity ?? null);
        const tree = observeReservedTestTree(flight.processIdentity);
        return { owner: owner.state === 'dead' ? 'lost' : owner.state === 'alive' ? 'alive' : 'unknown', tree: tree.state, identity: tree.processIdentity, finishedAtMs: null, deadlineObservedAtMs: null, interrupted: false };
      },
      cleanup: async flight => {
        const tree = observeReservedTestTree(flight.processIdentity);
        assert.equal(tree.state, 'dead');
        return { complete: true, remainingPids: [] };
      },
      release: async (runId, processIdentity) => {
        assert.equal(observeReservedTestTree(processIdentity).state, 'dead');
        const saved = await state.transaction(tx => tx.get(fixture.key));
        assert.equal(saved!.lastResult!.runId, runId);
        appendFileSync(join(root, 'releases.jsonl'), JSON.stringify({ runId, processIdentity, at: Date.now() }) + '\n');
        return true;
      },
      returnResult: async () => ({ returned: false }),
      messageMain: async () => ({ accepted: false, receiptId: null, forwarded: false }),
    });
    process.stdout.write(JSON.stringify(reply) + '\n');
    process.exitCode = reply.cliCode;
  } finally { store.close(); }
} else {
  const evidence = resolve(process.argv[2]);
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'z410-stand-'));
  const environment = { PATH: process.env.PATH, HOME: root, RAF_QA_HOME: root, TMPDIR: root, LANG: 'C.UTF-8' };
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); process.on("message", () => process.exit(0));'], {
    detached: true, env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const childStderr: Buffer[] = [];
  child.stderr!.on('data', chunk => childStderr.push(chunk));
  const childClosed = once(child, 'close');
  let childIdentity: string | undefined;
  let failure: unknown;
  const summary: Record<string, unknown> = {
    kind: 'local component integration stand; actual Linux process and production SQLite/recovery/observation adapters',
    root, node: process.version, platform: process.platform, workspace: process.cwd(),
    operationalStateOpened: false,
    limits: 'No production CLI authorization, resource reservation service, tmux, transferred raf or agent-queue exercised. Resource release and delivery are stand adapters. Cleanup is verified dead-only; no live process is killed by recovery.',
  };
  const readGroup = async () => {
    const store = openStateStore(join(root, '.raf/state.sqlite'));
    try { return await (sqliteTestRunState(store) as RecoveryStatePort).transaction(tx => tx.get(json(join(root, 'fixture.json')).key)); }
    finally { store.close(); }
  };
  const recover = async (name: string) => {
    const worker = spawn(process.execPath, [script, 'recover', root], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    worker.stdout.on('data', bytes => stdout.push(bytes));
    worker.stderr.on('data', bytes => stderr.push(bytes));
    const [cliCode, signal] = await once(worker, 'close');
    const output = Buffer.concat(stdout).toString('utf8');
    writeFileSync(join(evidence, name + '.stdout.json'), output);
    writeFileSync(join(evidence, name + '.stderr.txt'), Buffer.concat(stderr));
    save(join(evidence, name + '.execution.json'), { command: [process.execPath, script, 'recover', root], cliCode, signal });
    assert.equal(cliCode, 1);
    assert.equal(signal, null);
    return JSON.parse(output);
  };
  try {
    await once(child, 'message');
    childIdentity = identity(child.pid!);
    assert.equal(observeReservedTestTree(childIdentity).state, 'alive');
    const fixture = {
      key: { project: 'raf', workspace: process.cwd(), group: 'complete-raf-flow-contracts/z410' },
      testKind: 'unit', profileId: 'node', state: 'running', timeoutCount: 1,
      selection: { files: ['test/test-run-legacy-in-flight.test.ts'], testIds: [] },
      knownRed: [{ file: 'stand.test.ts', name: 'synthetic known red to preserve' }],
      unexecuted: [{ file: 'stand.test.ts', name: 'synthetic unexecuted to preserve' }],
      unknown: [{ file: 'stand.test.ts', name: 'synthetic unknown to preserve' }],
      inFlight: { runId: randomUUID(), deadlineMs: Date.now() - 1, processIdentity: childIdentity },
      lastResult: null, delivery: null,
    };
    summary.originalRunId = fixture.inFlight.runId;
    save(join(root, 'fixture.json'), fixture);
    save(join(evidence, 'fixture.json'), fixture);
    const store = openStateStore(join(root, '.raf/state.sqlite'));
    try { await sqliteTestRunState(store).transaction(tx => tx.put(fixture as any)); }
    finally { store.close(); }
    const alive = await recover('alive-after-deadline');
    assert.equal(alive.result, null);
    assert.equal(alive.recovery.runId, fixture.inFlight.runId);
    assert.equal(alive.recovery.needsMain, true);
    assert.deepEqual(await readGroup(), fixture);
    assert.equal(existsSync(join(root, 'releases.jsonl')), false);
    assert.equal(observeReservedTestTree(childIdentity).state, 'alive');
    child.send('finish');
    assert.deepEqual(await childClosed, [0, null]);
    assert.equal(observeReservedTestTree(childIdentity).state, 'dead');
    const recovered = await recover('dead-after-deadline');
    const result = recovered.result;
    assert.equal(result.runId, fixture.inFlight.runId);
    assert.equal(result.outcome, 'setup-failed');
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.timeoutCount, 1);
    assert.equal(result.groupState, 'reconcile');
    assert.equal(result.nextAction, 'reconcile');
    assert.deepEqual(result.knownRed, fixture.knownRed);
    assert.deepEqual(result.unexecuted, fixture.unexecuted);
    assert.deepEqual(result.unknown, fixture.unknown);
    assert.deepEqual(result.cleanup, { complete: true, remainingPids: [] });
    const persisted = await readGroup();
    assert.equal(persisted!.inFlight, null);
    assert.deepEqual(persisted!.lastResult, result);
    assert.equal(persisted!.delivery!.pending, true);
    save(join(evidence, 'persisted-recovered-group.json'), persisted);
    const repeated = await recover('restart-repeat');
    assert.deepEqual(repeated.result, result);
    assert.deepEqual(await readGroup(), persisted);
    const releases = readFileSync(join(root, 'releases.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].runId, fixture.inFlight.runId);
    save(join(evidence, 'releases.json'), releases);
    summary.scenarios = ['live tree retained unchanged after deadline', 'dead legacy tree recovered with original non-pass result and unchanged budget/IDs', 'new worker returns identical persisted result without another release'];
    summary.outcome = 'passed';
  } catch (error) {
    summary.outcome = 'failed';
    summary.error = error instanceof Error ? error.stack : String(error);
    failure = error;
  } finally {
    if (childIdentity && observeReservedTestTree(childIdentity).state === 'alive') child.send('finish');
    await childClosed;
    writeFileSync(join(evidence, 'child.stderr.txt'), Buffer.concat(childStderr));
    summary.cleanup = { complete: childIdentity ? observeReservedTestTree(childIdentity).state === 'dead' : child.exitCode === 0, remainingPids: childIdentity && observeReservedTestTree(childIdentity).state !== 'dead' ? [child.pid] : [] };
    save(join(evidence, 'summary.json'), summary);
  }
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (failure) process.exitCode = 1;
}
