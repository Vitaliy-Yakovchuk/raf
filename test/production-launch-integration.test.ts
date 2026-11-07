import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openStateStore } from '../src/state-store.ts';
import { fixture, writeJson, json, exists, until, change, descriptions } from './production-launch-fixture.ts';

test('[production-launch] default entry derives task context, ignores a legacy context file and fences actual runner before first brief', async t => {
  const f = await fixture(t);
  await writeJson(join(f.tmpRoot, 'task-context', 'entry.json'), { version: 1, parameters: f.parameters('entry'), assignment: { root: f.root, changes: [{ id: change, items: [{ id: '1.1', description: descriptions['1.1'] }] }], baselineArchives: [] }, context: { branch: 'main', outcome: 'FOREIGN_OUTCOME', writeBoundaries: [f.root], sources: ['/FOREIGN — чуже; завжди'], requested: { ramBytes: 1, diskBytes: {} }, requiredFileSystemIds: [], reportSchema: { foreign: true } } });
  const { brief, session, invocation } = await f.launched('entry');
  assert.equal(invocation.child.exitCode, 0);
  process.kill(brief.pid, 0);
  assert.equal(session.state, 'running');
  assert.equal(session.process!.pid, brief.pid);
  assert.equal(session.process!.runnerSessionId, brief.nativeId);
  assert.match(brief.nativeId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.doesNotMatch(JSON.stringify(brief.assignment), /FOREIGN/);
  assert.equal(brief.assignment.outcome, `${change}:1.1 — ${descriptions['1.1']}`);
  const boundaries = [f.workspace, f.changeDir, f.questionsPath, join(f.workspace, '.git'), join(f.root, '.git')].sort();
  assert.deepEqual([...brief.assignment.write_boundaries].sort(), boundaries);
  assert.deepEqual([...session.launchContext!.writeBoundaries!].sort(), boundaries);
  const diagnostic = await json(join(f.tmpRoot, session.runId, 'task-context.json'));
  assert.equal(diagnostic.runId, session.runId);
  assert.deepEqual(diagnostic.parameters, f.parameters('entry'));
  assert.equal(diagnostic.context.outcome, brief.assignment.outcome);
  const claim = brief.claims.find((x: any) => x.lease.owner.runId === session.runId);
  assert.equal(claim?.stage, 'running');
  assert.equal(claim.agent.pid, brief.pid);
  assert.equal(claim.agent.runnerSessionId, brief.nativeId);
  assert.ok(claim.lease.owner.fence);
  assert.ok(claim.lease.revision > 1);
  assert.ok(brief.admission.some((x: any) => x.runId === session.runId));
  const task = claim.tasks[0];
  const canonicalRoot = await fs.realpath(f.root);
  const expected = createHash('sha256').update(JSON.stringify(['raf-task-fingerprint-v1', 'raf', canonicalRoot, change, task.changeInstance, '1.1', descriptions['1.1']])).digest('hex');
  assert.equal(task.fingerprint, expected);
  assert.equal(brief.assignment.report_path, join(f.tmpRoot, session.runId, 'entry.json'));
  assert.equal(session.launchContext!.selection.model, 'gpt-6.1-sol');
  assert.equal(session.launchContext!.selection.effort, 'high');
});

test('[production-launch] invalid assignment and assignment changed between derivation and start create no runner or claims; forged main rejected', async t => {
  const f = await fixture(t);
  const bad = f.parameters('bad-assignment', ['99.9']);
  const result = await f.spawnChild('command', [JSON.stringify(f.argv(bad))]).done;
  assert.notEqual(result.exitCode, 0, JSON.stringify(result));
  const forged = 'Write forged fixture alpha';
  await writeJson(join(f.control, 'mutate-after-validation.json'), { from: `- [ ] 1.1 ${descriptions['1.1']}`, to: `- [ ] 1.1 ${forged}` });
  const changedResult = await f.spawnChild('command', [JSON.stringify(f.argv(f.parameters('changed-assignment')))]).done;
  assert.deepEqual(await json(join(f.control, 'mutated')), { from: `- [ ] 1.1 ${descriptions['1.1']}`, to: `- [ ] 1.1 ${forged}` });
  assert.notEqual(changedResult.exitCode, 0, JSON.stringify(changedResult));
  const failure = JSON.parse(JSON.parse(changedResult.stdout).stderr);
  assert.equal(failure.details.stage, 'reservation', changedResult.stdout);
  assert.match(failure.details.reason, new RegExp(`${change}/1\\.1 is missing, ambiguous, changed or completed`));
  const leftovers = [];
  for (const entry of await fs.readdir(f.tmpRoot)) if (await exists(join(f.tmpRoot, entry, 'task-context.json'))) leftovers.push(entry);
  assert.deepEqual(leftovers, [], 'cleanupUnstarted має прибрати каталог запуску з виведеним контекстом');
  const snapshot = await f.inspect();
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.claims.length, 0);
  assert.equal(snapshot.admission.length, 0);
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 0);
});

test('[production-launch] concurrent overlapping real entry is all-or-none and independent item remains launchable', async t => {
  const f = await fixture(t);
  const attempts = await Promise.all([f.run('left', ['1.1', '1.2']), f.run('right', ['1.2', '1.3'])]);
  const results = await Promise.all(attempts.map(x => x.done));
  assert.equal(results.filter(x => x.exitCode === 0).length, 1, JSON.stringify(results));
  const loser = results[0].exitCode === 0 ? 1 : 0;
  const winnerId = loser === 0 ? 'right' : 'left';
  const diagnostic = results[loser].stdout + results[loser].stderr;
  assert.match(diagnostic, /conflict|reserved|зайнят|конфлікт/i);
  assert.ok(diagnostic.includes('1.2'), diagnostic);
  assert.ok(diagnostic.includes(winnerId), diagnostic);
  const snapshot = await f.inspect();
  assert.equal(snapshot.sessions.filter(x => x.state !== 'finished').length, 1);
  assert.equal(snapshot.claims.length, 1);
  assert.equal(snapshot.claims[0].tasks.length, 2);
  assert.equal(snapshot.claims[0].lease.owner.addressId, winnerId);
  assert.equal(snapshot.admission.length, 1);
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 1);
  await f.launched('independent', [loser === 0 ? '1.1' : '1.3']);
  assert.equal((await f.inspect()).claims.length, 2);
});

test('[production-launch] accepted succeeded answer is visible while running and survives deterministic exit17 with minimal retention', async t => {
  const f = await fixture(t);
  const { session } = await f.launched('report');
  await f.gate('report.report');
  await until(f.inspect, x => x.sessions.some(s => s.runId === session.runId && s.state === 'running' && s.result?.status === 'succeeded'), 'Actual watcher має підтвердити succeeded до exit gate');
  const active = (await f.inspect()).sessions.find(x => x.runId === session.runId)!;
  assert.equal(active.result!.response, 'synthetic answer report');
  process.kill(active.process!.pid, 0);
  assert.ok((await f.inspect()).admission.some(x => x.runId === session.runId));
  await f.gate('report.exit');
  const finished = await until(f.inspect, x => x.sessions.some(s => s.runId === session.runId && s.state === 'finished'), 'Persistent worker має завершити lifecycle');
  const retained = finished.sessions.find(x => x.runId === session.runId)!;
  assert.equal(await fs.readFile(join(f.control, 'report.exit17'), 'utf8'), '17');
  assert.equal(retained.result?.status, 'succeeded');
  assert.equal(retained.result?.response, '');
  assert.equal(retained.result?.proof, null);
  assert.equal(retained.launchContext, undefined);
  assert.equal(finished.claims.length, 0);
  assert.equal(finished.admission.length, 0);
});

test('[production-launch] default service refresh/recover cannot finalize exit while persistent report verification is gated', async t => {
  const f = await fixture(t);
  const { session } = await f.launched('race');
  const before = await f.inspect();
  const claim = before.claims.find(x => x.lease.owner.runId === session.runId)!;
  assert.ok(claim.wrapper?.pid);
  await fs.writeFile(join(f.control, 'verify.peer'), String(claim.wrapper!.pid));
  await f.gate('verify.block');
  await f.gate('race.report');
  await until(() => exists(join(f.control, 'verify.entered')), Boolean, 'Actual OpenSpec verification має досягти gate');
  assert.equal((await f.inspect()).sessions.find(x => x.runId === session.runId)!.result?.status, undefined);
  await f.gate('race.exit');
  await until(() => exists(join(f.control, 'race.exit17')), Boolean, 'Actual runner має вийти під час перевірки');
  await until(async () => { try { process.kill(session.process!.pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; } }, Boolean, 'OS має підтвердити завершення runner');
  const service = await f.startService('race-service', true);
  service.child.stdin!.write('refresh\n');
  await until(service.output, x => x.stdout.includes('refreshed'), 'Default service refresh має завершитися');
  const pending = (await f.inspect()).sessions.find(x => x.runId === session.runId)!;
  assert.notEqual(pending.state, 'finished', 'Живий verified wrapper ще перевіряє звіт цього run');
  assert.notEqual(pending.result?.status, 'failed');
  assert.deepEqual(pending.launchContext, session.launchContext);
  assert.ok((await f.inspect()).admission.some(x => x.runId === session.runId));
  assert.ok((await f.inspect()).claims.some(x => x.lease.owner.runId === session.runId));
  await f.gate('verify.release');
  const finished = await until(f.inspect, x => x.sessions.some(s => s.runId === session.runId && s.state === 'finished'), 'Confirmed report має виграти race після actual OpenSpec');
  assert.equal(finished.sessions.find(x => x.runId === session.runId)!.result?.status, 'succeeded');
  assert.equal(finished.claims.length, 0);
  assert.equal(finished.admission.length, 0);
  assert.equal(finished.pending.filter(x => x.runId === session.runId && x.event === 'agent.failed').length, 0);
});

test('[production-launch] default service startup releases real SIGKILL starter before spawn without manual cleanup', async t => {
  const f = await fixture(t);
  const params = f.parameters('starter');
  const starter = f.spawnChild('starter', [JSON.stringify(params)]);
  const seeded = await until(async () => await exists(join(f.control, 'starter.seeded')) ? json(join(f.control, 'starter.seeded')) : null, Boolean, 'Public production reserve має зафіксувати starter');
  const before = await f.inspect();
  assert.equal(before.claims[0].stage, 'starting');
  assert.equal(before.claims[0].starter.pid, starter.child.pid);
  assert.equal(before.admission.length, 1);
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 0);
  starter.child.kill('SIGKILL');
  assert.equal((await starter.done).signal, 'SIGKILL');
  const service = await f.startService('starter-recovery');
  const after = await f.inspect();
  assert.equal(after.claims.length, 0, 'recover має викликати shared OS claims reconciliation');
  assert.equal(after.admission.length, 0);
  assert.equal(after.sessions.find(x => x.runId === seeded.runId)?.state, 'finished');
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 0);
  service.child.stdin!.end('stop\n');
  assert.equal((await service.done).exitCode, 0);
});

test('[production-launch] live actual runner and its lease survive default service restart without respawn', async t => {
  const f = await fixture(t);
  const { session } = await f.launched('survivor');
  const before = await f.inspect();
  const service = await f.startService('first-service');
  service.child.stdin!.end('stop\n');
  assert.equal((await service.done).exitCode, 0);
  const restarted = await f.startService('second-service', true);
  restarted.child.stdin!.write('refresh\n');
  await until(restarted.output, x => x.stdout.includes('refreshed'), 'Restarted default host refresh');
  const after = await f.inspect();
  assert.deepEqual(after.claims, before.claims);
  assert.equal(after.sessions.find(x => x.runId === session.runId)?.state, 'running');
  assert.deepEqual(after.sessions.find(x => x.runId === session.runId)?.process, session.process);
  process.kill(session.process!.pid, 0);
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 1);
});

test('[production-launch] incomplete persisted process evidence stays conservative during default startup recovery', async t => {
  const f = await fixture(t);
  const params = f.parameters('unknown');
  const starter = f.spawnChild('starter', [JSON.stringify(params)]);
  await until(() => exists(join(f.control, 'unknown.seeded')), Boolean, 'Real starter reserve');
  const store = openStateStore(f.statePath);
  try {
    store.taskReservationRepository.transaction(tx => {
      const claim = tx.listTaskReservations()[0];
      tx.putTaskReservation({ ...claim, starter: { ...claim.starter, startedAt: '', evidence: { ...claim.starter.evidence, command: '' } } });
    });
  } finally { store.close(); }
  const before = await f.inspect();
  const context = { orchestratorRoot: f.root, homeDirectory: f.home, stateDirectory: f.stateDirectory, socketPath: f.serviceSocket };
  for (const create of [f.productionPorts, f.defaultHost]) {
    const ports = await create(context);
    try {
      await assert.rejects(ports.recover(), /TASK_LIVENESS_UNKNOWN|unknown|identity|evidence|невідом/i);
      const after = await f.inspect();
      assert.deepEqual(after.claims, before.claims);
      assert.deepEqual(after.admission, before.admission);
      assert.notEqual(after.sessions[0].state, 'finished');
      process.kill(starter.child.pid!, 0);
    } finally { await ports.shutdown(); }
  }
  assert.equal((await fs.readdir(f.control)).filter(x => x.startsWith('spawn-')).length, 0);
});


