import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { release, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [codeInput, outputInput, confInput] = process.argv.slice(2);
const code = resolve(codeInput), output = resolve(outputInput), confSource = resolve(confInput);
assert.ok(existsSync(join(code, 'dist/catalog.json')), 'Build clean-clone catalog before process QA');
assert.ok(existsSync(join(code, '../conf/test-runs.json')), 'Reporter needs adjacent conf/test-runs.json');
const load = (file: string) => import(pathToFileURL(join(code, 'src', file)).href);
const { openStateStore } = await load('state-store.ts');
const { createResourceSnapshotReader, readMachineBootIdentity } = await load('os-runtime.ts');
const { deriveResourceAdmissionVolumes } = await load('home-disk-admission.ts');
const { loadFlowPolicy } = await load('flow-policy.ts');
const { createTestRunResourcePort } = await load('test-run-resource-runtime.ts');
const { reconcileTestRunResources } = await load('test-run-reservations.ts');
const { createTestRunPorts } = await load('test-run-runtime.ts');
const { productionStateContext } = await load('state-migration-guard.ts');
const { observeReservedTestTree } = await load('test-run-resource-process.ts');

mkdirSync(output, { recursive: true });
const stand = mkdtempSync('/tmp/raf-reserve-qa-');
const root = join(stand, 'orchestrator'), workspace = join(stand, 'workspace'), home = join(stand, 'control-home');
for (const path of [join(root, 'conf'), join(root, 'openspec/changes/fix-raf-load-admission'), workspace, home]) mkdirSync(path, { recursive: true });
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const file of ['projects.json', 'raf.json', 'raf-constants.json', 'flow.json', 'test-runs.json']) cpSync(join(confSource, file), join(root, 'conf', file));
const projects = read(join(root, 'conf/projects.json'));
const productionBranch = projects.profiles[projects.projects.raf.profile].production;
const productionCode = resolve(confSource, '..', projects.projects.raf.path);
projects.projects = { raf: { ...projects.projects.raf, path: productionCode, branchPaths: { [productionBranch]: productionCode, develop: code, 'qa-reservations': workspace } } };
write(join(root, 'conf/projects.json'), projects);
execFileSync('git', ['init', '-q', '-b', 'qa-reservations', workspace]);
execFileSync('git', ['-C', workspace, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--allow-empty', '-qm', 'Process QA fixture']);
const policy = loadFlowPolicy(join(root, 'conf/flow.json'));
const machine = await readMachineBootIdentity();
const paths = { orchestratorRoot: root, workspace, home: userInfo().homedir };
const measure = () => createResourceSnapshotReader({ machineId: machine.machineId, paths: Object.values(paths) }).read();
const measured = await measure();
assert.deepEqual(measured.reasons, []);
const volumes = deriveResourceAdmissionVolumes(paths, measured.fileSystemByPath);
const minimumRam = Math.max(policy.resources.normal.minRamBytes, measured.measurement.totalRamBytes * policy.resources.normal.minRamFraction);
const availableSlot = measured.measurement.availableRamBytes - minimumRam;
assert.ok(availableSlot > 256 * 1024 * 1024, 'Stand needs normal admission headroom');
const estimate = { ramBytes: Math.floor(availableSlot * 0.7), diskBytesPerFileSystem: 0 };
const config = read(join(root, 'conf/test-runs.json'));
const group = (name: string) => `fix-raf-load-admission/${name}`;
const names = ['first', 'second', 'after-crash', 'post-cleanup', 'agent-blocked', 'agent-released', 'test-blocks-agent', 'race-a', 'race-b'];
const inventory = [...names.map(name => `${name}.test.ts`), 'sentinel.test.ts'];
config.projects = { raf: { profiles: { node: { cwd: '.', executable: process.execPath, argv: [join(code, 'scripts/test-run-node.ts')], unitFiles: inventory, exactIds: 'node-test-name', resultAdapter: 'node-test-events', environment: { isolatedHome: true, stateOrigin: true }, checks: [], resourceEstimate: estimate } }, groups: Object.fromEntries(names.map(name => [group(name), { profileId: 'node', files: [`${name}.test.ts`] }])) } };
config.temporaryArtifacts.root = mkdtempSync('/tmp/q-');
write(join(root, 'conf/test-runs.json'), config);
const gate = (name: string) => join(workspace, `${name}.gate`);
const ready = (name: string) => join(workspace, `${name}.ready`);
for (const name of [...names, 'sentinel']) {
  writeFileSync(join(workspace, `${name}.test.ts`), `import {test} from 'node:test';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
test(${JSON.stringify(name)}, async () => {
  writeFileSync(${JSON.stringify(ready(name))}, JSON.stringify({pid:process.pid, HOME:process.env.HOME, RAF_QA_HOME:process.env.RAF_QA_HOME, RAF_STATE_DIRECTORY:process.env.RAF_STATE_DIRECTORY, TMPDIR:process.env.TMPDIR, stat:readFileSync('/proc/self/stat','utf8')}));
  while (!existsSync(${JSON.stringify(gate(name))})) await new Promise(done=>setTimeout(done,25));
});\n`);
}
const statePath = join(home, '.raf', read(join(root, 'conf/raf.json')).state.fileName);
const store = openStateStore(statePath);
const processRow = execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)!;
const ownerId = randomUUID();
store.sessionRepository.transaction((tx: any) => tx.putSession({ runId: ownerId, addressId: 'reserve-qa-fixture', revision: 0, state: 'running', process: { pid: process.pid, startedAt: new Date(processRow[1]).toISOString(), runner: 'qa', runnerSessionId: ownerId, tmuxSession: '', evidence: { command: processRow[2] } }, launchContext: { testAssignment: { runId: ownerId, agentId: 'reserve-qa-fixture', type: 'qa', phase: 'qa', project: 'raf', workspace, branch: 'qa-reservations', changes: ['fix-raf-load-admission'] } } }));
const evidence: any = { environment: { code, sha: execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['-C', code, 'status', '--porcelain'], { encoding: 'utf8' }), node: process.version, platform: process.platform, os: release(), stand, root, workspace, controlHome: home, machine }, configuration: { source: confSource, hashes: Object.fromEntries(['flow.json', 'projects.json', 'test-runs.json', 'raf.json'].map(file => [file, hash(join(root, 'conf', file))])), policy: policy.unitTests, resourceEstimate: estimate, initialMeasurement: measured, flowUnmodified: hash(join(root, 'conf/flow.json')) === hash(join(confSource, 'flow.json')) }, scenarios: [], invocations: [], limitations: ['Synthetic light fixture workloads use real CLI wrappers, OS process trees, Linux proc identities, resource measurements and SQLite transactions. Agent contention uses production createLaunchState in an independent real process, without invoking an AI provider or tmux agent launcher.', 'Isolated QA state and environment are verified; this is not an OS sandbox penetration test.'] };
assert.equal(evidence.environment.dirty, '');
const children: any[] = [];
const launchTimes = new Map<string, number>();
const treeIdentities = new Set<string>();
let unitPath: string | undefined;
const reservations = () => store.sessionRepository.transaction((tx: any) => tx.listReservations(), 'read');
const groups = () => {
  if (!unitPath || !existsSync(unitPath)) return [];
  const unit = openStateStore(unitPath);
  try { return unit.startupContextDatabase.prepare('SELECT payload FROM test_run_groups').all().map((row: any) => JSON.parse(row.payload)); } finally { unit.close(); }
};
async function until(predicate: () => boolean, label: string, duration = 15000) {
  const deadline = Date.now() + duration;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Stand guard expired: ${label}`); await new Promise(done => setTimeout(done, 30)); }
}
function cli(label: string, name: string) {
  const argv = [join(code, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', 'qa', '--group', group(name)];
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', HOME: home, RAF_QA_HOME: home, RAF_ORCHESTRATOR_ROOT: root, TMUX: '', TMUX_PANE: '' };
  launchTimes.set(name, Date.now());
  const child = spawn(process.execPath, argv, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let guardFired = false;
  const guard = setTimeout(() => { guardFired = true; child.kill('SIGKILL'); }, 20000);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise<any>((done, fail) => {
    child.once('error', fail);
    child.once('close', (cliExitCode, signal) => {
      clearTimeout(guard);
      writeFileSync(join(output, `${label}.stdout.json`), stdout); writeFileSync(join(output, `${label}.stderr`), stderr);
      writeFileSync(join(output, `${label}.cli-code`), String(cliExitCode) + '\n');
      let result; try { result = JSON.parse(stdout); } catch {}
      unitPath ??= result?.command?.environment?.statePath;
      const record = { label, command: { executable: process.execPath, argv, cwd: workspace, environment: env }, pid: child.pid, cliExitCode, signal, guardFired, childExitCode: result?.exitCode ?? null, result };
      evidence.invocations.push(record); done(record);
    });
  });
  return { child, completed };
}
async function active(name: string) {
  await until(() => existsSync(ready(name)), `${name} descendant ready`);
  const row = reservations().find((row: any) => row.testRun?.claim.groupKey.group === group(name));
  assert.ok(row?.testRun?.committed); assert.ok(row.testRun.claim.processIdentity);
  treeIdentities.add(row.testRun.claim.processIdentity);
  const actual = read(ready(name));
  assert.notEqual(actual.HOME, home); assert.equal(actual.HOME, actual.RAF_QA_HOME);
  assert.equal(actual.RAF_STATE_DIRECTORY, join(actual.HOME, '.raf'));
  assert.ok(actual.TMPDIR.startsWith(config.temporaryArtifacts.root + '/'));
  assert.ok(!Object.values(actual).includes(statePath));
  unitPath = join(actual.HOME, '.raf', read(join(root, 'conf/raf.json')).state.fileName);
  const aggregate = groups().find((item: any) => item.key.group === group(name));
  assert.equal(aggregate.inFlight.runId, row.runId);
  assert.equal(aggregate.inFlight.deadlineMs, row.testRun.claim.deadlineMs);
  assert.ok(aggregate.inFlight.deadlineMs >= launchTimes.get(name)! + policy.unitTests.timeoutMs);
  assert.ok(aggregate.inFlight.deadlineMs <= Date.now() + policy.unitTests.timeoutMs);
  return { reservation: row, aggregate, descendant: actual };
}
function passed(row: any) {
  assert.equal(row.cliExitCode, 0); assert.equal(row.signal, null); assert.equal(row.result?.outcome, 'passed');
  assert.deepEqual(row.result.cleanup, { complete: true, remainingPids: [] });
  assert.equal(row.result.timedOut, false); assert.equal(row.result.timeoutCount, 0);
  for (const field of ['knownRed', 'unexecuted', 'unknown']) assert.deepEqual(row.result[field], []);
  assert.equal(row.result.admission.allowed, true);
}
function refused(row: any) {
  assert.equal(row.cliExitCode, 1); assert.equal(row.result?.outcome, 'refused');
  assert.equal(row.result.errorCode, 'RESOURCE_UNAVAILABLE'); assert.equal(row.result.exitCode, null);
  assert.equal(row.result.admission.allowed, false); assert.equal(row.result.timeoutCount, 0);
  assert.deepEqual(row.result.knownRed, []); assert.equal(row.result.timedOut, false);
}
async function scenario(label: string, body: () => Promise<any>) {
  const startedAt = Date.now();
  try { const details = await body(); evidence.scenarios.push({ label, exitCode: 0, durationMs: Date.now() - startedAt, details }); console.log(`PASS ${label}`); }
  catch (error) { evidence.scenarios.push({ label, exitCode: 1, durationMs: Date.now() - startedAt, error: String(error), stack: (error as Error).stack }); console.log(`FAIL ${label}: ${error}`); throw error; }
  finally { write(join(output, 'process.json'), evidence); }
}
async function reconcile() {
  assert.ok(unitPath);
  const unitStore = openStateStore(unitPath!);
  try {
    const resources = createTestRunResourcePort(store, { root, workspace, home: userInfo().homedir, machineId: machine.machineId, config });
    const unitHome = resolve(unitPath!, '../..');
    const environment = { HOME: unitHome, RAF_QA_HOME: unitHome, PATH: process.env.PATH };
    const stateContext = productionStateContext(root, join(code, 'src/test-run-runtime.ts'), unitHome, 'cli', environment);
    const ports = Object.assign(createTestRunPorts(config, stateContext, () => unitStore, environment), { machineId: machine.machineId, resources });
    const context = { cwd: workspace, workspace, projectWorkspaces: { raf: [workspace] }, agentPhases: Object.keys(config.phases), activeChanges: ['fix-raf-load-admission'], agentId: 'qa-recovery', sha: evidence.environment.sha, home: unitHome, statePath: unitPath, tmpPath: stateContext.tmpRoot, operationalHome: userInfo().homedir };
    return await reconcileTestRunResources(context, policy.unitTests, ports);
  } finally { unitStore.close(); }
}
const agentScript = join(stand, 'agent-reserve.ts');
writeFileSync(agentScript, `import {openStateStore} from ${JSON.stringify(pathToFileURL(join(code, 'src/state-store.ts')).href)};
import {createLaunchState} from ${JSON.stringify(pathToFileURL(join(code, 'src/launch-state.ts')).href)};
import {evaluateResourceAdmission} from ${JSON.stringify(pathToFileURL(join(code, 'src/resource-admission.ts')).href)};
import {createResourceSnapshotReader} from ${JSON.stringify(pathToFileURL(join(code, 'src/os-runtime.ts')).href)};
import {loadFlowPolicy} from ${JSON.stringify(pathToFileURL(join(code, 'src/flow-policy.ts')).href)};
import {existsSync,writeFileSync} from 'node:fs';
const store=openStateStore(${JSON.stringify(statePath)});
const policy=loadFlowPolicy(${JSON.stringify(join(root, 'conf/flow.json'))});
const launch=createLaunchState({repository:store.sessionRepository,measure:async()=>({measurement:(await createResourceSnapshotReader(${JSON.stringify({ machineId: machine.machineId, paths: Object.values(paths) })}).read()).measurement,observedProcesses:[]}),evaluateAdmission:input=>evaluateResourceAdmission(input,policy)});
const runId=process.argv[2];
const result=await launch.reserveLaunch({runId,addressId:runId,activity:{type:'qa',project:'raf',phase:'qa',features:['fix-raf-load-admission']},launchContext:{},resource:'agent',amount:${estimate.ramBytes},requested:${JSON.stringify({ ramBytes: estimate.ramBytes, diskBytes: Object.fromEntries(volumes.requiredFileSystemIds.map((id: string) => [id, 0])) })},requiredFileSystemIds:${JSON.stringify(volumes.requiredFileSystemIds)},homeFileSystemId:${JSON.stringify(volumes.homeFileSystemId)},mode:'normal'});
writeFileSync(process.argv[3],JSON.stringify({pid:process.pid,result}));
if(result.reserved){while(!existsSync(process.argv[4]))await new Promise(done=>setTimeout(done,25));store.sessionRepository.transaction(tx=>{tx.deleteReservation(runId);tx.deleteSession(runId);});}
store.close();process.exitCode=0;
`);
async function agent(label: string) {
  const id = randomUUID(), resultPath = join(stand, `${label}.json`), finish = join(stand, `${label}.done`);
  const child = spawn(process.execPath, [agentScript, id, resultPath, finish], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise<any>((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal, stderr })); });
  await until(() => existsSync(resultPath), `${label} agent reservation`);
  return { id, child, result: read(resultPath), completed, finish: () => writeFileSync(finish, '') };
}
try {
  await scenario('simultaneous-independent-cli-groups', async () => {
    const a = cli('race-a', 'race-a'), b = cli('race-b', 'race-b');
    await until(() => existsSync(ready('race-a')) || existsSync(ready('race-b')), 'one race winner ready');
    const winnerName = existsSync(ready('race-a')) ? 'race-a' : 'race-b';
    const loserName = winnerName === 'race-a' ? 'race-b' : 'race-a';
    const winner = winnerName === 'race-a' ? a : b, loser = winnerName === 'race-a' ? b : a;
    const activeWinner = await active(winnerName);
    const denied = await loser.completed; refused(denied);
    assert.equal(existsSync(ready(loserName)), false); assert.equal(reservations().length, 1);
    writeFileSync(gate(winnerName), ''); const completed = await winner.completed; passed(completed);
    assert.equal(activeWinner.reservation.testRun.claim.deadlineMs, Date.parse(completed.result.startedAt) + policy.unitTests.timeoutMs);
    return { winner: winnerName, loser: loserName, activeWinner, deniedRunId: denied.result.runId, completedRunId: completed.result.runId, reservationsAfter: reservations() };
  });
  await scenario('two-groups-and-killed-wrapper-reconciliation', async () => {
    const first = cli('first-holder', 'first');
    const initial = await active('first');
    const refusedBefore = await cli('second-refused', 'second').completed; refused(refusedBefore);
    assert.equal(existsSync(ready('second')), false); assert.equal(reservations().length, 1);
    first.child.kill('SIGKILL');
    const killed = await first.completed; assert.equal(killed.signal, 'SIGKILL'); assert.equal(killed.result, undefined);
    assert.equal(observeReservedTestTree(initial.reservation.testRun.claim.processIdentity).state, 'alive');
    const liveReconciliation = await reconcile(); assert.equal(liveReconciliation.retained.length, 1); assert.equal(liveReconciliation.released.length, 0);
    const afterCrash = await cli('after-crash-refused', 'after-crash').completed; refused(afterCrash);
    assert.equal(existsSync(ready('after-crash')), false);
    const retained = reservations()[0]; assert.deepEqual(retained.testRun.claim, initial.reservation.testRun.claim);
    assert.equal(groups().find((row: any) => row.key.group === group('first')).inFlight.deadlineMs, initial.aggregate.inFlight.deadlineMs);
    const identity = initial.reservation.testRun.claim.processIdentity;
    process.kill(-JSON.parse(identity).pid, 'SIGKILL');
    await until(() => observeReservedTestTree(identity).state === 'dead', 'orphan tree death');
    const deadReconciliation = await reconcile(); assert.equal(deadReconciliation.released.length, 1); assert.deepEqual(reservations(), []);
    const after = groups().find((row: any) => row.key.group === group('first'));
    assert.equal(after.inFlight, null); assert.equal(after.timeoutCount, initial.aggregate.timeoutCount);
    writeFileSync(gate('post-cleanup'), '');
    const next = await cli('post-cleanup-passed', 'post-cleanup').completed; passed(next);
    return { initial, refusedBefore: refusedBefore.result.runId, killedWrapper: { pid: first.child.pid, signal: killed.signal }, liveObservationAfterKill: 'alive', liveReconciliation, afterCrash: afterCrash.result.runId, deadReconciliation, after, reservationsAfter: reservations() };
  });
  await scenario('agent-reservation-blocks-test-across-processes', async () => {
    const holder = await agent('agent-holder'); assert.equal(holder.result.result.reserved, true);
    const denied = await cli('agent-blocked-test', 'agent-blocked').completed; refused(denied);
    assert.equal(existsSync(ready('agent-blocked')), false); assert.equal(reservations()[0].runId, holder.id);
    holder.finish(); const completion = await holder.completed; assert.equal(completion.code, 0);
    writeFileSync(gate('agent-released'), '');
    const accepted = await cli('agent-released-test', 'agent-released').completed; passed(accepted);
    return { agent: holder.result, completion, deniedRunId: denied.result.runId, acceptedRunId: accepted.result.runId, reservationsAfter: reservations() };
  });
  await scenario('test-reservation-blocks-agent-across-processes', async () => {
    const holder = cli('test-blocks-agent', 'test-blocks-agent'); const activeTest = await active('test-blocks-agent');
    const denied = await agent('agent-denied'); assert.equal(denied.result.result.reserved, false);
    const completion = await denied.completed; assert.equal(completion.code, 0);
    writeFileSync(gate('test-blocks-agent'), ''); const completed = await holder.completed; passed(completed);
    assert.equal(activeTest.reservation.testRun.claim.deadlineMs, Date.parse(completed.result.startedAt) + policy.unitTests.timeoutMs);
    const accepted = await agent('agent-after-test'); assert.equal(accepted.result.result.reserved, true);
    accepted.finish(); const acceptedCompletion = await accepted.completed; assert.equal(acceptedCompletion.code, 0);
    return { activeTest, denied: denied.result, completion, completedRunId: completed.result.runId, accepted: accepted.result, acceptedCompletion, reservationsAfter: reservations() };
  });
  evidence.status = 'passed';
} catch (error) { evidence.status = 'failed'; evidence.error = String(error); process.exitCode = 1; }
finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const identity of treeIdentities) if (observeReservedTestTree(identity).state !== 'dead') { try { process.kill(-JSON.parse(identity).pid, 'SIGKILL'); } catch {} }
  await new Promise(done => setTimeout(done, 100));
  evidence.cleanup = { observations: [...treeIdentities].map(identity => observeReservedTestTree(identity)), reservations: reservations(), groups: groups(), flowUnchanged: hash(join(root, 'conf/flow.json')) === evidence.configuration.hashes['flow.json'], codeDirty: execFileSync('git', ['-C', code, 'status', '--porcelain'], { encoding: 'utf8' }) };
  store.sessionRepository.transaction((tx: any) => tx.deleteSession(ownerId));
  store.close();
  evidence.cleanup.complete = evidence.cleanup.observations.every((row: any) => row.state === 'dead') && evidence.cleanup.reservations.length === 0 && evidence.cleanup.groups.every((row: any) => !row.inFlight);
  if (!evidence.cleanup.complete) { evidence.status = 'failed'; process.exitCode = 1; }
  write(join(output, 'process.json'), evidence);
}
