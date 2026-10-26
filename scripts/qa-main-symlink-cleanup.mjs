import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { guardLiveNativeWait, stopLiveServiceOwner } from './qa-main-symlink-fixture.ts';

const [reviewed, requestedStand] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.match(reviewed ?? '', /^[a-f0-9]{40}$/);
const source = path.resolve(import.meta.dirname, '..');
const head = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
assert.equal(head.status, 0); assert.equal(head.stdout.trim(), reviewed);
const stand = fs.realpathSync(requestedStand);
assert.equal(stand, '/srv/dev/s72-bDaBYe');
const previous = path.join(stand, 'ev-native-retained-captures');
const evidence = path.join(stand, 'ev-native-cleanup-service');
fs.mkdirSync(evidence, { mode: 0o700 });
const read = name => JSON.parse(fs.readFileSync(path.join(previous, name), 'utf8'));
const digest = name => createHash('sha256').update(fs.readFileSync(path.join(previous, name))).digest('hex');
const summary = { status: 'failed', reviewed, stand, previous, startedAt: new Date().toISOString(), scope: 'Complete only unfinished cleanup after all eight Host17 live stages by a verified-owner normal service stop. No CLI, switch, start, actor launch, message, report or gate is replayed.' };
try {
  const original = read('summary.json');
  assert.equal(original.reviewed, '7495b9d5ef65c46bd40d6a8cdc3418485342be90');
  assert.equal(original.status, 'failed'); assert.deepEqual(original.pending, []);
  const stages = ['actual-start', 'develop-main', 'hotfix-main-develop', 'native-channel', 'rollback', 'pending-report-message', 'handover', 'repeat-start'];
  assert.deepEqual(original.completed, stages);
  assert.equal(original.error, undefined); assert.equal(original.archiveError, undefined); assert.equal(original.auditError, undefined);
  assert.equal(original.cleanup.complete, false);
  assert.equal(original.cleanup.actorError, 'Error: Native process lost before cleanup-actor; no dependent retry');
  assert.equal(original.cleanup.serviceError, 'Error: Native process lost before cleanup-service; no dependent retry');
  assert.deepEqual(original.cleanup.services, { complete: true, processes: [], remaining: [] });
  const accepted = read('accepted-session.json');
  assert.equal(accepted.runId, '36182376-28f6-46b4-88ec-66d72f53a0d3');
  assert.equal(accepted.result.status, 'succeeded');
  assert.deepEqual(accepted.reportAcceptance, { runId: accepted.runId, status: 'succeeded', event: 'agent.succeeded' });
  const completion = { released: true, pending: original.pending, actorRunId: accepted.runId, acceptedRunId: accepted.reportAcceptance.runId, acceptedStatus: accepted.result.status };
  const nativeIdentity = original.actorIdentity;
  assert.equal(nativeIdentity.pid, 1749117);
  const inspectNative = () => {
    const stat = fs.readFileSync('/proc/' + nativeIdentity.pid + '/stat', 'utf8');
    assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], nativeIdentity.startTicks);
  };
  assert.throws(inspectNative, { code: 'ENOENT' }, 'The completed native process must actually be gone');
  for (const label of ['cleanup-actor', 'cleanup-service']) guardLiveNativeWait(label, completion, inspectNative);
  const db = new DatabaseSync(path.join(stand, '.raf/state.sqlite'), { readOnly: true });
  let session;
  try { session = db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload)).find(row => row.runId === accepted.runId); }
  finally { db.close(); }
  assert.equal(session?.state, 'finished'); assert.equal(session.result?.status, 'succeeded');
  const priorCleanup = JSON.parse(fs.readFileSync(path.join(stand, 'ev-native-cleanup-only/summary.json'), 'utf8'));
  assert.equal(priorCleanup.reviewed, '1589f5495bc8f8fa245c49e67c490e37086daa5f');
  assert.equal(priorCleanup.status, 'failed'); assert.match(priorCleanup.error.message, /No owned stand process may remain after cleanup/);
  assert.match(priorCleanup.error.message, /2047034/);
  const repeated = read('repeat-start.json'); assert.equal(repeated.cliExitCode, 0);
  const expected = JSON.parse(repeated.stdout);
  assert.equal(expected.pid, 2047034); assert.equal(expected.serviceEpoch, '96a5f62e-6a1b-4637-aff0-7a55763bf21a');
  const prepared = read('service-prepared-101.json');
  assert.equal(expected.pid, prepared.pid); assert.equal(expected.mainPath, prepared.mainPath);
  const currentRecord = JSON.parse(fs.readFileSync(path.join(stand, '.raf/service.json'), 'utf8'));
  assert.equal(currentRecord.state, 'ready'); assert.equal(currentRecord.pid, expected.pid);
  assert.equal(currentRecord.token, expected.serviceEpoch); assert.equal(currentRecord.mainPath, expected.mainPath);
  assert.equal(currentRecord.identity.startedAt, prepared.identity.startTicks);
  assert.equal(currentRecord.identity.bootId, prepared.identity.bootId);
  assert.equal(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), prepared.identity.bootId);
  const serviceStat = fs.readFileSync('/proc/' + expected.pid + '/stat', 'utf8');
  assert.equal(serviceStat.slice(serviceStat.lastIndexOf(')') + 2).split(' ')[19], prepared.identity.startTicks);
  assert.equal(fs.statSync('/proc/' + expected.pid).uid, process.getuid());
  assert.equal(fs.readlinkSync('/proc/' + expected.pid + '/cwd'), expected.mainPath);
  assert.ok(expected.mainPath.startsWith(path.join(stand, 'root/.git/modules/raf-main/raf-hotfix/generations/')));
  assert.equal(fs.realpathSync(expected.mainPath), expected.mainPath);
  const { createBackgroundRuntime } = await import(pathToFileURL(path.join(expected.mainPath, 'src/background-runtime.ts')).href);
  const runtime = createBackgroundRuntime({ stateDirectory: path.join(stand, '.raf'), socketPath: path.join(stand, '.raf/service.sock'), entryRelativePath: 'bin/service.ts', readinessTimeoutMs: 30000 }, {
    resolveMainPath: async () => { throw Error('Cleanup must never resolve or start another owner'); },
    validateMainSnapshot: async () => false, spawn: () => { throw Error('Cleanup must never spawn'); },
  });
  const capture = async (name, operation) => {
    const result = await operation();
    fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  };
  let inspection = 0;
  const normalStop = await stopLiveServiceOwner(expected, {
    status: () => capture('service-status-' + (++inspection), () => runtime.status()),
    stop: () => capture('service-stop', () => runtime.stop()),
  });
  summary.normalStop = { expected, preparedIdentity: prepared.identity, result: normalStop, signalsSent: [], startedServices: false };
  const stoppedRecord = JSON.parse(fs.readFileSync(path.join(stand, '.raf/service.json'), 'utf8'));
  assert.equal(stoppedRecord.state, 'stopped'); assert.equal(stoppedRecord.token, expected.serviceEpoch);
  assert.equal(stoppedRecord.stopReason, 'Service stopped normally');
  summary.stoppedRecord = stoppedRecord;
  const processes = [];
  for (const entry of fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name))) {
    const pid = Number(entry); if (pid === process.pid) continue;
    try {
      if (fs.statSync('/proc/' + pid).uid !== process.getuid()) continue;
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); if (fields[0] === 'Z') continue;
      const cwd = fs.readlinkSync('/proc/' + pid + '/cwd');
      const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean);
      if (cwd === stand || cwd.startsWith(stand + '/') || args.some(arg => arg.startsWith(stand + '/'))) processes.push({ pid, startTicks: fields[19], cwd, executable: args[0] });
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
  }
  assert.deepEqual(processes, [], 'No owned stand process may remain after cleanup');
  summary.original = { summarySha256: digest('summary.json'), completed: original.completed, pending: original.pending, status: original.status, preserved: true };
  summary.accepted = { runId: accepted.runId, status: accepted.result.status, acceptance: accepted.reportAcceptance, sha256: digest('accepted-session.json') };
  summary.currentSession = { runId: session.runId, state: session.state, status: session.result.status };
  summary.cleanup = { complete: true, processes, nativeProcessGone: true, liveStagesReplayed: false, commandsReplayed: false };
  summary.status = 'succeeded';
} catch (error) {
  summary.error = { message: error.message, stack: error.stack, code: error.code ?? null };
  process.stderr.write(error.stack + '\n'); process.exitCode = 1;
} finally {
  summary.finishedAt = new Date().toISOString();
  const target = path.join(evidence, 'summary.json');
  fs.writeFileSync(target + '.part', JSON.stringify(summary, null, 2) + '\n'); fs.renameSync(target + '.part', target);
  console.log(JSON.stringify({ status: summary.status, evidence, cleanup: summary.cleanup ?? { complete: false } }));
}
