import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const directory = import.meta.dirname;
const before = JSON.parse(fs.readFileSync(directory + '/workspace-before.json'));
const prefix = 'node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/99a1b3a9-27b7-4628-a053-ca81250d95b2/raf-main/bin/raf.ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runs = [];
const unitPolicy = JSON.parse(fs.readFileSync('/srv/dev/work/orchestrator/conf/flow.json')).unitTests;
for (const name of ['module-origin-cost', 'agent-ps']) {
  const path = directory + '/' + name;
  const bytes = fs.readFileSync(path + '/stdout.json');
  const stderr = fs.readFileSync(path + '/stderr.txt');
  const captureBytes = fs.readFileSync(path + '/capture-result.json');
  const capture = JSON.parse(captureBytes);
  const delivery = JSON.parse(fs.readFileSync(path + '/delivery.json'));
  const result = JSON.parse(bytes);
  const group = 'profile-raf-performance/' + name;
  const invocation = fs.existsSync(path + '/workspace-at-invocation.json') ? JSON.parse(fs.readFileSync(path + '/workspace-at-invocation.json')) : before;
  assert.equal(capture.stdoutBytes, bytes.length);
  assert.equal(capture.stderrBytes, stderr.length);
  assert.equal(delivery.stdoutSha256, hash(bytes));
  assert.equal(delivery.stderrSha256, hash(stderr));
  assert.equal(delivery.captureResultSha256, hash(captureBytes));
  assert.equal(delivery.cliCode, capture.code);
  assert.equal(delivery.runId, result.runId);
  assert.equal(result.project, 'raf');
  assert.equal(result.workspace, '/srv/dev/work/orchestrator/raf-hotfix');
  assert.equal(result.phase, 'hotfix');
  assert.equal(result.callerPhase, 'hotfix');
  assert.equal(result.testKind, 'unit');
  assert.equal(result.group, group);
  assert.deepEqual([...result.selection.files].sort(), [...before.groups[group].files].sort());
  assert.deepEqual(result.selection.testIds, []);
  const counts = Object.fromEntries(['passed', 'knownRed', 'unexecuted', 'unknown', 'removed'].map(key => [key, result[key].length]));
  const passed = result.outcome === 'passed' && capture.code === 0 && result.exitCode === 0
    && !result.timedOut && result.cleanup.complete && result.cleanup.remainingPids.length === 0
    && counts.passed > 0 && ['knownRed', 'unexecuted', 'unknown'].every(key => counts[key] === 0)
    && result.groupState === 'complete' && result.nextAction === 'complete';
  const unitCompletionAllowed = result.testKind === 'unit' && result.outcome === 'timed-out' && result.timedOut
    && result.timeoutCount >= unitPolicy.maxGroupTimeouts && counts.knownRed === 0 && counts.unknown === 0
    && result.cleanup.complete && result.cleanup.remainingPids.length === 0 && result.groupState === 'unverified-remainder';
  runs.push({ sourceChange: 'profile-raf-performance', sourceItem: '5.11.1', targetGroup: group,
    issuedCommand: prefix + ' test run --project raf --phase hotfix --group ' + group,
    workspaceEvidence: fs.existsSync(path + '/workspace-at-invocation.json') ? name + '/workspace-at-invocation.json' : 'workspace-before.json', headAtInvocation: invocation.head,
    evidence: name + '/stdout.json', stderr: name + '/stderr.txt', capture: name + '/capture-result.json', delivery: name + '/delivery.json',
    runId: result.runId, selection: result.selection, command: result.command, profileId: result.profileId,
    cliExitCode: capture.code, childExitCode: result.exitCode, outcome: result.outcome, timedOut: result.timedOut,
    durationMs: result.durationMs, timeoutPolicy: result.timeoutPolicy, cleanup: result.cleanup, counts,
    groupSnapshot: result.groupSnapshot, groupState: result.groupState, timeoutCount: result.timeoutCount,
    nextAction: result.nextAction, failureKinds: result.failureKinds, verifiedPassed: passed, unitCompletionAllowed, completionBasis: passed ? 'verified-passed' : unitCompletionAllowed ? 'core/process/unit-test-runs: allowed completion after maxGroupTimeouts without known red; remainder stays unverified and is not rerun' : 'incomplete' });
}
const after = { recordedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' }),
  confSha256: Object.fromEntries(Object.keys(before.confSha256).map(file => [file, hash(fs.readFileSync(file))])),
  testHashes: Object.fromEntries(Object.keys(before.testHashes).map(file => [file, hash(fs.readFileSync(file))])) };
assert.deepEqual(after.testHashes, before.testHashes, 'Regression tests changed during runs');
fs.writeFileSync(directory + '/workspace-after.json', JSON.stringify(after, null, 2) + '\n');
fs.writeFileSync(directory + '/runs.json', JSON.stringify({ sourceChange: 'profile-raf-performance', sourceItem: '5.11.1', runs }, null, 2) + '\n');
console.log(JSON.stringify(runs.map(({ targetGroup, runId, outcome, cliExitCode, childExitCode, counts, verifiedPassed, unitCompletionAllowed }) =>
  ({ targetGroup, runId, outcome, cliExitCode, childExitCode, counts, verifiedPassed, unitCompletionAllowed })), null, 2));
