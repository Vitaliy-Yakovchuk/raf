import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executeCommand, readMachineBootIdentity } from '../src/os-runtime.ts';
import type { ProcessIdentity, SessionRecord } from '../src/session-state.ts';
import { fixture } from './production-fixture.ts';
import { assertNoSource, expectedOwnContext, fullLaunchContext, sourceForms, syntheticSource } from './agent-ps-projection-contract.ts';

type CliReply = { requestId: string; code: number | null; signal: string | null; spawnError: string | null; stdout: string; stderr: string };

function request(actor: ChildProcess, entry: string, cwd: string): Promise<CliReply> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const onExit = () => { actor.off('message', onMessage); reject(new Error('Fixture actor exited before CLI completion')); };
    const onMessage = (reply: CliReply) => {
      if (reply.requestId !== requestId) return;
      actor.off('message', onMessage); actor.off('exit', onExit); resolve(reply);
    };
    actor.on('message', onMessage); actor.once('exit', onExit);
    actor.send({ requestId, entry, cwd }, error => { if (error) { actor.off('message', onMessage); actor.off('exit', onExit); reject(error); } });
  });
}

function successfulPs(reply: CliReply): SessionRecord[] {
  assert.equal(reply.spawnError, null, 'Public CLI must spawn successfully');
  assert.equal(reply.signal, null, 'Public CLI must complete before outer integration deadline');
  assert.equal(reply.code, 0, 'Successful ps must exit 0 before evaluating output confidentiality');
  const rows = JSON.parse(reply.stdout);
  assert.ok(Array.isArray(rows), 'Public CLI must return complete JSON, not a truncated capture');
  assertNoSource(reply.stdout, reply.stderr);
  return rows;
}

test('Z398 CLI S01-S07 verified real ancestry isolated public ps and complete cleanup', async t => {
  const evidence = fileURLToPath(new URL(`../evidence/z398-ps-projection/qa-resumed/cli/${crypto.randomUUID()}/`, import.meta.url));
  await mkdir(evidence, { recursive: true });
  const f = await fixture(t, { productionQa: true, externalHome: true });
  const entry = join(f.cwd, 'bin/raf.ts');
  const actorPath = fileURLToPath(new URL('./helpers/agent-ps-projection-actor.mjs', import.meta.url));
  const temporary = join(f.home, 'private-tmp');
  await mkdir(temporary);
  const environment = {
    PATH: process.env.PATH!, HOME: f.home, RAF_QA_HOME: f.home, RAF_ORCHESTRATOR_ROOT: f.root, TMPDIR: temporary,
    XDG_CONFIG_HOME: join(f.home, 'config'), XDG_CACHE_HOME: join(f.home, 'cache'), LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  };
  const actors: ChildProcess[] = [];
  const identities: ProcessIdentity[] = [];
  let requestIndex = 0;
  const publicPs = async (child: ChildProcess) => {
    const reply = await request(child, entry, f.cwd);
    const prefix = join(evidence, String(++requestIndex).padStart(2, '0'));
    await Promise.all([writeFile(`${prefix}.stdout`, reply.stdout), writeFile(`${prefix}.stderr`, reply.stderr),
      writeFile(`${prefix}.json`, JSON.stringify({ ...reply, stdout: undefined, stderr: undefined, callerPid: child.pid,
        command: [process.execPath, entry, 'agent', 'ps'], cwd: f.cwd }, null, 2) + '\n')]);
    return successfulPs(reply);
  };
  const cleanup = async () => {
    for (const child of actors) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    assert.ok(actors.every(child => child.exitCode !== null || child.signalCode !== null), 'Every owned actor must exit');
  };
  let cleaned = false;
  try {
    const boot = await readMachineBootIdentity();
    const actor = async (addressId: string, runId: string, role = 'test-scaffold') => {
      const child = spawn(process.execPath, [actorPath, '--synthetic-hook', Buffer.from(syntheticSource).toString('base64')], {
        cwd: f.cwd, env: environment, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      actors.push(child);
      const [ready] = await once(child, 'message');
      assert.equal(ready.ready, true);
      const observed = await executeCommand({ executable: 'ps', args: ['-ww', '-p', String(child.pid), '-o', 'lstart=,command='] });
      assert.equal(observed.exitCode, 0);
      const parsed = observed.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      assert.ok(parsed, 'Fixture actor must have verifiable real OS start time and full command');
      const identity: ProcessIdentity = { pid: child.pid!, startedAt: new Date(parsed[1]).toISOString(), runner: 'codex',
        runnerSessionId: `fixture-${runId}`, tmuxSession: addressId, evidence: { command: parsed[2], runId, ...boot } };
      identities.push(identity);
      const row: SessionRecord = { addressId, runId, revision: 1, state: 'running', process: identity,
        activity: { type: role, project: 'raf', features: ['fixture-launch'], phase: role, cwd: f.cwd },
        launchContext: fullLaunchContext(f.tmpRoot) };
      f.store.sessionRepository.transaction(tx => { tx.putSession(row); tx.putReservation({ runId, resource: 'ram', amount: 1 }); });
      return { child, row };
    };
    const own = await actor('projection-own', 'projection-own-run');
    const foreign = await actor('projection-foreign', 'projection-foreign-run', 'main');
    const get = (row: SessionRecord) => f.store.sessionRepository.transaction(tx => tx.getSession(row.runId))!;
    const first = await publicPs(own.child);
    assert.deepEqual(first.find(row => row.runId === own.row.runId)?.launchContext, expectedOwnContext);
    const other = first.find(row => row.runId === foreign.row.runId)!;
    assert.equal(other.addressId, foreign.row.addressId); assert.equal(other.state, 'running');
    assert.equal(Object.hasOwn(other, 'launchContext'), false);
    assert.deepEqual(get(own.row).launchContext, own.row.launchContext);
    const fromMain = await publicPs(foreign.child);
    assert.equal(Object.hasOwn(fromMain.find(row => row.runId === own.row.runId)!, 'launchContext'), false);
    assert.deepEqual(fromMain.find(row => row.runId === foreign.row.runId)?.launchContext, expectedOwnContext);
    const nested = { ...get(foreign.row), result: { status: 'succeeded', response: syntheticSource, proof: { encoded: sourceForms } },
      modelHandoff: { activity: foreign.row.activity!, launchContext: fullLaunchContext(f.tmpRoot), reason: syntheticSource } };
    Object.assign(nested, { futureContainer: { source: syntheticSource } });
    f.store.sessionRepository.transaction(tx => tx.putSession(nested));
    await publicPs(own.child);
    assert.deepEqual(get(foreign.row).result, nested.result);
    assert.deepEqual(get(foreign.row).modelHandoff, nested.modelHandoff);
    assert.deepEqual(get(foreign.row).launchContext, nested.launchContext);
    const stopped = once(own.child, 'exit'); own.child.kill('SIGTERM'); await stopped;
    const previous = { ...get(own.row), state: 'finished' as const, finishedAt: new Date().toISOString() };
    f.store.sessionRepository.transaction(tx => { tx.putSession(previous); tx.deleteReservation(own.row.runId); });
    const reused = await actor(own.row.addressId, 'projection-reused-run');
    const reusedRows = await publicPs(reused.child);
    assert.equal(reusedRows.some(row => row.runId === previous.runId), false);
    assert.deepEqual(reusedRows.find(row => row.runId === reused.row.runId)?.launchContext, expectedOwnContext);
    assert.deepEqual(get(previous).launchContext, previous.launchContext);
    const unaffiliated = spawn(process.execPath, [actorPath], { cwd: f.cwd, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    actors.push(unaffiliated); await once(unaffiliated, 'message');
    const unknownRows = await publicPs(unaffiliated);
    assert.ok(unknownRows.every(row => !Object.hasOwn(row, 'launchContext')));
    const pending: SessionRecord = { ...reused.row, addressId: 'projection-pending', runId: 'projection-pending-run',
      process: { ...previous.process!, pid: previous.process!.pid }, launchContext: { ...fullLaunchContext(f.tmpRoot), wrapper: foreign.row.process } };
    f.store.sessionRepository.transaction(tx => { tx.putSession(pending); tx.putReservation({ runId: pending.runId, resource: 'ram', amount: 1 }); });
    for (let repeat = 0; repeat < 2; repeat++) {
      const rows = await publicPs(reused.child);
      const publicPending = rows.find(row => row.runId === pending.runId) as SessionRecord & { reconciliation?: { code: string } };
      assert.equal(publicPending?.reconciliation?.code, 'WORKER_RESULT_PENDING');
      assert.deepEqual(get(pending).launchContext, pending.launchContext);
      assert.equal(get(pending).state, 'running');
      assert.equal(f.store.sessionRepository.transaction(tx => tx.listReservations()).some(row => row.runId === pending.runId), true);
    }
    const legacy = { ...get(reused.row) }; delete legacy.launchContext;
    f.store.sessionRepository.transaction(tx => tx.putSession(legacy));
    const legacyRows = await publicPs(reused.child);
    assert.equal(Object.hasOwn(legacyRows.find(row => row.runId === legacy.runId)!, 'launchContext'), false);
    const flow = JSON.parse(await readFile(join(f.confRoot, 'flow.json'), 'utf8'));
    t.diagnostic(JSON.stringify({ entry, caller: { pid: reused.row.process!.pid, runId: reused.row.runId },
      source: 'real public bin/raf.ts; real ancestry and OS observations; explicit synthetic session seed; no sanitizer or CLI mocks',
      timeoutPolicy: { source: 'conf/flow.json#/integrationTests/timeoutMs', timeoutMs: flow.integrationTests.timeoutMs },
      isolation: { home: f.home, state: f.statePath, tmp: temporary }, cliExitCode: 0, childExitCode: 0 }));
  } finally {
    await cleanup(); cleaned = true;
    await writeFile(join(evidence, 'summary.json'), JSON.stringify({ node: process.version, entry, evidence, identities,
      requests: requestIndex, cleanup: { actorsExited: cleaned, remainingPids: actors.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid) },
      isolation: { home: f.home, state: f.statePath, tmp: temporary } }, null, 2) + '\n');
  }
  assert.equal(cleaned, true);
});
