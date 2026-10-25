import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  prepareStateRecoveryHost, type HostIdentity, type HostCheckpoint,
  type HostSnapshot, type StateRecoveryHost, type HostExecution,
} from './helpers/state-recovery-host.ts';

async function identity(pid: number): Promise<HostIdentity | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z') return null;
    return { pid, start: fields[19], boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function checkpoint(path: string, name: HostCheckpoint['name'], deadlineMs: number): Promise<HostCheckpoint> {
  while (Date.now() < deadlineMs) {
    try {
      const data = JSON.parse(await readFile(path, 'utf8')) as HostCheckpoint;
      if (data.name === name) return data;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(10);
  }
  throw new Error(`Missing host checkpoint ${name}`);
}
function inside(path: string, root: string) {
  assert.ok(resolve(path).startsWith(resolve(root) + sep), `Path outside owned stand: ${path}`);
}
function original(after: HostExecution, before: HostSnapshot) {
  const flight = before.originalRun;
  assert.equal(after.result.runId, flight.runId);
  assert.equal(after.result.phase, flight.phase);
  assert.equal(after.result.callerPhase, flight.callerPhase);
  assert.deepEqual(after.result.selection, flight.selection);
  const command = before.group.lastResult?.runId === flight.runId ? before.group.lastResult.command : flight.command;
  assert.deepEqual(after.result.command, command);
  assert.deepEqual(after.result.timeoutPolicy, flight.timeoutPolicy);
  assert.deepEqual(after.result.knownRed, before.group.knownRed);
  assert.deepEqual(after.result.unexecuted, before.group.unexecuted);
  assert.deepEqual(after.result.unknown, before.group.unknown);
  assert.equal(after.result.testKind, flight.testKind);
  assert.ok(after.argv.length > 0);
  assert.ok(after.cwd);
  assert.equal(typeof after.stderr, 'string');
}

for (const testKind of ['unit', 'integration'] as const) {
  for (const name of ['after-spawn', 'before-commit', 'after-commit-before-delivery'] as const) {
    for (const child of name === 'after-commit-before-delivery' ? ['early-exit'] as const : ['early-exit', 'alive-through-deadline'] as const) {
      test(`S09/S10 real ${testKind} CLI loss ${name}, child=${child}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'raf-state-recovery-host-'));
        let host: StateRecoveryHost | undefined;
        let wrapperIdentity: HostIdentity | null = null;
        let cli: ReturnType<typeof spawn> | undefined;
        const evidence: Record<string, unknown> = { testKind, checkpoint: name, child, root };
        try {
          host = await prepareStateRecoveryHost({ root, testKind, checkpoint: name, child, initialTimeoutCount: 1 });
          assert.ok(Number.isFinite(host.deadlineMs) && host.deadlineMs > Date.now());
          inside(host.home, root); inside(host.checkpointPath, root); inside(host.childReleasePath, root);
          inside(host.evidencePath, process.env.RAF_STATE_RECOVERY_EVIDENCE_ROOT || root);
          assert.equal(host.command.env.HOME, host.home);
          assert.equal(host.command.env.RAF_QA_HOME, host.home);
          assert.ok(host.command.argv.includes('test') && host.command.argv.includes('run'));
          assert.ok(host.command.argv.includes(testKind === 'unit' ? 'qa' : 'integration'));
          await host.setMainAvailability('unavailable');
          await Promise.all(['stdout', 'stderr'].map(stream => writeFile(join(host!.evidencePath, `original.${stream}`), '')));
          cli = spawn(host.command.executable, host.command.argv, {
            cwd: host.command.cwd, env: host.command.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
          });
          const stdout: Buffer[] = [], stderr: Buffer[] = [];
          let outputBytes = 0;
          let outputOverflow = false;
          const collect = (target: Buffer[], stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
            outputBytes += chunk.length;
            if (outputBytes <= 1024 * 1024) {
              target.push(chunk);
              appendFileSync(join(host!.evidencePath, `original.${stream}`), chunk);
            }
            else outputOverflow = true;
          };
          cli.stdout!.on('data', collect(stdout, 'stdout')); cli.stderr!.on('data', collect(stderr, 'stderr'));
          const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
            cli!.once('error', reject); cli!.once('exit', (code, signal) => {
              appendFileSync(join(host!.evidencePath, 'original.cli-exit.json'), JSON.stringify({ code, signal }) + '\n');
              accept({ code, signal });
            });
          });
          assert.ok(cli.pid);
          wrapperIdentity = await identity(cli.pid!);
          assert.ok(wrapperIdentity);
          const point = await checkpoint(host.checkpointPath, name, host.deadlineMs);
          const before = await host.snapshot();
          evidence.command = { executable: host.command.executable, argv: host.command.argv, cwd: host.command.cwd, HOME: host.home }; evidence.before = before; evidence.point = point;
          inside(before.controlStatePath, root); inside(before.unitStatePath, root);
          assert.notEqual(before.controlStatePath, before.unitStatePath);
          assert.deepEqual(before.wrapper, wrapperIdentity);
          assert.ok(before.caller.agentId && before.caller.runId && before.generation && before.sha);
          assert.equal(before.group.timeoutCount, 1);
          assert.equal(before.spawnCount, 1);
          assert.equal(point.runId, before.originalRun.runId);
          assert.ok(point.atMs < before.originalRun.deadlineMs);
          for (const member of before.tree) assert.deepEqual(await identity(member.pid), member);
          if (name === 'after-commit-before-delivery') {
            assert.ok(before.group.lastResult);
            assert.equal(before.group.lastResult!.runId, point.runId);
            assert.equal(before.group.delivery!.pending, true);
          } else assert.equal(before.group.lastResult, null);
          assert.deepEqual(await identity(cli.pid!), wrapperIdentity);
          process.kill(cli.pid!, 'SIGKILL');
          evidence.cliExit = await closed;
          evidence.stdout = Buffer.concat(stdout).toString('utf8');
          evidence.stderr = Buffer.concat(stderr).toString('utf8');
          assert.equal(outputOverflow, false);
          assert.equal(await identity(cli.pid!), null);
          if (child === 'early-exit') {
            await writeFile(host.childReleasePath, 'exit-before-deadline');
            await host.awaitTreeExit();
            if (name !== 'after-commit-before-delivery') await host.awaitOriginalDeadline();
          } else await host.awaitOriginalDeadline();
          const first = await host.reconcile(); evidence.first = first;
          original(first, before);
          if (name === 'after-commit-before-delivery') assert.deepEqual(first.result, before.group.lastResult);
          else if (child === 'early-exit') {
            assert.equal(first.result.outcome, 'setup-failed');
            assert.equal(first.result.exitCode, null);
            assert.equal(first.result.timedOut, false);
            assert.equal(first.result.timeoutCount, 1);
            assert.ok(first.result.diagnostics.some(d => Boolean(d.unavailableReason)));
          } else {
            assert.equal(first.result.outcome, 'timed-out');
            assert.equal(first.result.timedOut, true);
            assert.equal(first.result.timeoutCount, 2);
          }
          if (testKind === 'integration' && name !== 'after-commit-before-delivery') {
            assert.equal(first.result.groupState, 'incomplete');
            assert.equal(first.result.nextAction, 'complete-integration');
            assert.notEqual(first.cliCode, 0);
          }
          const pending = await host.snapshot(); evidence.pending = pending;
          assert.equal(pending.group.delivery!.pending, true);
          assert.equal(pending.spawnCount, before.spawnCount);
          await host.cleanupClosedChange();
          assert.equal((await host.snapshot()).group.lastResult!.runId, point.runId);
          await host.restartRecipient();
          await host.setMainAvailability('accepted');
          const accepted = await host.reconcile(); evidence.accepted = accepted;
          assert.deepEqual(accepted.result, first.result);
          const withReceipt = await host.snapshot();
          assert.equal(withReceipt.group.delivery!.pending, true);
          assert.ok(withReceipt.group.delivery!.receiptId);
          assert.equal(withReceipt.group.delivery!.forwardedToMain, false);
          const repeated = await Promise.all([host.reconcile(), host.reconcile()]); evidence.concurrent = repeated;
          assert.deepEqual(repeated.map(x => x.result), [first.result, first.result]);
          const repeatedSnapshot = await host.snapshot(); evidence.repeated = repeatedSnapshot;
          assert.equal(repeatedSnapshot.group.timeoutCount, first.result.timeoutCount);
          assert.equal(repeatedSnapshot.spawnCount, before.spawnCount);
          assert.equal(repeatedSnapshot.releaseCount, 1);
          assert.equal(repeatedSnapshot.group.delivery!.receiptId, withReceipt.group.delivery!.receiptId);
          await host.setMainAvailability('forwarded');
          const delivered = await host.reconcile(); evidence.delivered = delivered;
          assert.deepEqual(delivered.result, first.result);
          assert.equal((await host.snapshot()).group.delivery!.pending, false);
        } finally {
          if (cli?.pid && wrapperIdentity && JSON.stringify(await identity(cli.pid)) === JSON.stringify(wrapperIdentity)) {
            process.kill(cli.pid, 'SIGKILL');
          }
          if (host) {
            const cleanup = await host.finish(); evidence.cleanup = cleanup;
            await mkdir(host.evidencePath, { recursive: true });
            await writeFile(join(host.evidencePath, 'scenario.json'), JSON.stringify(evidence, null, 2));
            assert.deepEqual(cleanup.remainingOwned, []);
            assert.equal(cleanup.operationalStateOpened, false);
          }
        }
      });
    }
  }
}

test('S09 real dead tree with unknown finishedAt never becomes timeout after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raf-state-recovery-unknown-'));
  const host = await prepareStateRecoveryHost({ root, testKind: 'unit', checkpoint: 'after-spawn', child: 'early-exit', initialTimeoutCount: 1 });
  let cli: ReturnType<typeof spawn> | undefined;
  let owned: HostIdentity | null = null;
  try {
    inside(host.home, root);
    cli = spawn(host.command.executable, host.command.argv, { cwd: host.command.cwd, env: host.command.env, shell: false, stdio: 'ignore' });
    const closed = new Promise<void>((resolve, reject) => { cli!.once('error', reject); cli!.once('close', () => resolve()); });
    assert.ok(cli.pid); owned = await identity(cli.pid!); assert.ok(owned);
    await checkpoint(host.checkpointPath, 'after-spawn', host.deadlineMs);
    const before = await host.snapshot();
    assert.deepEqual(await identity(cli.pid!), owned);
    process.kill(cli.pid!, 'SIGKILL'); await closed;
    await writeFile(host.childReleasePath, 'exit-before-deadline');
    await host.awaitTreeExit(); await host.markExitTimeUnknown(); await host.awaitOriginalDeadline();
    const first = await host.reconcile(); original(first, before);
    assert.equal(first.result.outcome, 'setup-failed'); assert.equal(first.result.timeoutCount, 1);
    await host.restartRecipient();
    const again = await host.reconcile(); assert.deepEqual(again.result, first.result);
    assert.equal((await host.snapshot()).group.timeoutCount, 1);
    await mkdir(host.evidencePath, { recursive: true });
    await writeFile(join(host.evidencePath, 'unknown-finished-at.json'), JSON.stringify({ before, first, again }, null, 2));
  } finally {
    if (cli?.pid && owned && JSON.stringify(await identity(cli.pid)) === JSON.stringify(owned)) process.kill(cli.pid, 'SIGKILL');
    const cleanup = await host.finish();
    assert.deepEqual(cleanup.remainingOwned, []); assert.equal(cleanup.operationalStateOpened, false);
  }
});

for (const testKind of ['unit', 'integration'] as const) {
  for (const mode of ['passed', 'refused'] as const) {
    test(`S10 normal real ${testKind} ${mode} preserves delivery and phase policy`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'raf-state-recovery-normal-'));
      const host = await prepareStateRecoveryHost({ root, testKind, checkpoint: 'after-spawn', child: 'early-exit', initialTimeoutCount: 1 });
      try {
        const execution = await host.normal(mode);
        const rejectedPreset = testKind === 'integration' && mode === 'refused';
        assert.equal(execution.result.outcome, mode);
        assert.equal(execution.result.stateAccess, null);
        assert.equal(execution.result.testKind, rejectedPreset ? null : testKind);
        assert.equal(execution.result.phase, testKind === 'unit' ? 'qa' : 'integration');
        assert.equal(execution.result.timedOut, false);
        if (rejectedPreset) {
          assert.equal(execution.result.errorCode, 'CALLER_UNAUTHORIZED');
          assert.equal(execution.result.groupSnapshot, 'unavailable');
          assert.equal(execution.result.callerPhase, null);
          assert.equal(execution.result.timeoutPolicy, null);
          assert.equal(execution.result.timeoutCount, null);
          assert.deepEqual(execution.result.selection, { files: [], testIds: [] });
        }
        if (mode === 'passed') {
          assert.equal(execution.cliCode, 0);
          assert.equal(execution.result.exitCode, 0);
          assert.equal(execution.result.cleanup.complete, true);
          assert.equal(execution.result.groupState, 'complete');
        } else {
          assert.notEqual(execution.cliCode, 0);
          assert.equal(execution.result.exitCode, null);
          assert.equal((await host.snapshot()).spawnCount, 0);
        }
        await mkdir(host.evidencePath, { recursive: true });
        await writeFile(join(host.evidencePath, 'normal.json'), JSON.stringify(execution, null, 2));
      } finally {
        const cleanup = await host.finish();
        assert.deepEqual(cleanup.remainingOwned, []); assert.equal(cleanup.operationalStateOpened, false);
      }
    });
  }
}
