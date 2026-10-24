import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { release } from 'node:os';
import { agentRunFixture, until, exists } from '../test/agent-run-fixture.ts';
import { openStateStore } from '../src/state-store.ts';

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const code = resolve(import.meta.dirname, '..');
const source = resolve(code, '..');
const cleanup: (() => Promise<void>)[] = [];
const evidence: any = {
  assignment: 'enforce-flow-approaches:2.3', runId: '4bdf642e-5adb-4ccd-9a04-7b21fcf91859',
  command: [process.execPath, ...process.argv.slice(1)], startedAt: new Date().toISOString(),
  environment: { node: process.version, os: release(), platform: process.platform, arch: process.arch, browser: null, device: 'Linux CLI/process stand with synthetic Codex runner' },
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: code, encoding: 'utf8' }),
  scenarios: [], commands: [], cleanup: { complete: false },
  limitations: ['Synthetic runner, real production launch/watcher/reconciliation/close and OpenSpec/Git/SQLite. No model provider or working main service.', 'Manual regression admission has an explicit descriptive evidence boundary; existing implement machine unit proof is accepted separately without repetition.', 'Fixture resource thresholds permit the lightweight stand; these results do not validate resource admission limits.'],
};
const save = () => writeFile(join(output, 'stand.json'), JSON.stringify(evidence, null, 2) + '\n');
let f: Awaited<ReturnType<typeof agentRunFixture>>;
let root: string, changeRoot: string, tasksPath: string;
const change = 'launch-failure-fixture';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function scenario(name: string, body: () => Promise<any>) {
  const startedAt = new Date().toISOString();
  try { const details = await body(); evidence.scenarios.push({ name, startedAt, status: 'succeeded', details }); }
  catch (error) { evidence.scenarios.push({ name, startedAt, status: 'failed', reason: String(error), stack: (error as Error).stack }); }
  await save();
}
async function command(argv: string[]) {
  const result = await f.command(argv);
  evidence.commands.push({ argv, ...result });
  await save();
  return result;
}
const session = (runId: string) => f.inspect().sessions.find(row => row.runId === runId)!;
async function notices(runId: string) {
  const store = openStateStore(join(f.directory, 'home/.raf/state.sqlite'));
  try { return store.resultNotices.list().filter((row: any) => row.runId === runId); } finally { store.close(); }
}
async function launch(item: string) {
  const address = 'flow-' + item.replaceAll('.', '-');
  const result = await command(f.runArgs(address, 'qa', [item]));
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const runId = JSON.parse(result.result.stdout).runId;
  await until(() => exists(join(f.control, address + '.brief')), Boolean, 'synthetic runner consumed assignment');
  const record = session(runId);
  const brief = await readFile(record.launchContext!.briefPath, 'utf8');
  await writeFile(join(output, address + '.brief.txt'), brief);
  const marker = brief.lastIndexOf('\n{\n  "project"');
  const payload = JSON.parse(brief.slice(marker + 1));
  assert.ok(payload.report_schema.required.includes('qa'));
  assert.deepEqual(payload.report_schema.properties.qa.required, ['scenarios', 'findings', 'followUps']);
  for (const capability of ['core/process/user-qa', 'projects/raf/agent-report', 'projects/raf/agent-run']) {
    assert.ok(payload.sources.some((path: string) => path.includes('enforce-flow-approaches/specs/' + capability + '/spec.md')));
  }
  const addressRow = { change, item, scenario: payload.assignments[0].items[0].description };
  const proofPath = join(changeRoot, address + '.json');
  const report: any = { status: 'succeeded', answer: 'Isolated stand evidence; proposedTasks заборонено.', commits: [], changes: [{ id: change, items: [{ id: item, status: 'succeeded' }] }],
    qa: { scenarios: [{ ...addressRow, status: 'succeeded', evidence: [proofPath] }], findings: [], followUps: [] } };
  return { address, runId, record, payload, addressRow, proofPath, report };
}
async function publish(run: Awaited<ReturnType<typeof launch>>) {
  await writeFile(run.proofPath, JSON.stringify({ runId: run.runId, qa: run.report.qa }, null, 2) + '\n');
  await f.git('add', '--', run.proofPath);
  await f.git('commit', '-qm', 'Own stand QA evidence ' + run.address);
  run.report.commits = [...run.report.commits, { repository: root, sha: (await f.git('rev-parse', 'HEAD')).trim() }];
  const path = run.record.launchContext!.reportPath;
  await writeFile(path + '.next', JSON.stringify(run.report));
  await rename(path + '.next', path);
  await writeFile(join(output, run.address + '.report.json'), JSON.stringify(run.report, null, 2) + '\n');
}
async function accepted(run: Awaited<ReturnType<typeof launch>>, status = 'succeeded') {
  await until(() => session(run.runId), row => row?.result?.status === status, 'report durably accepted', 30000);
  const tasks = await readFile(tasksPath, 'utf8');
  assert.equal(tasks.includes(`- [x] ${run.addressRow.item} `), status === 'succeeded');
  const record = session(run.runId);
  await writeFile(join(output, run.address + '.accepted.json'), JSON.stringify(record, null, 2) + '\n');
  return { runId: run.runId, status: record.result!.status, tasks, proof: record.result!.proof };
}
async function rejected(run: Awaited<ReturnType<typeof launch>>, field: string) {
  await until(() => notices(run.runId), rows => JSON.stringify(rows).includes(field), 'addressed report rejection', 30000);
  const before = await readFile(tasksPath, 'utf8');
  const ps = await command(['agent', 'ps']);
  assert.equal(ps.exitCode, 0, JSON.stringify(ps));
  assert.ok(!session(run.runId).result);
  assert.equal(await readFile(tasksPath, 'utf8'), before);
  assert.ok(before.includes(`- [ ] ${run.addressRow.item} `));
  const rows = await notices(run.runId);
  await writeFile(join(output, run.address + '.rejected.json'), JSON.stringify(rows, null, 2) + '\n');
  return { runId: run.runId, field, tasksUnchanged: true, notices: rows };
}

try {
  const settings = await json(join(source, 'conf/raf.json'));
  const timeouts = settings.runnerProtocols.find((row: any) => row.runner === 'codex').timeouts;
  f = await agentRunFixture({ after(fn: () => Promise<void>) { cleanup.push(fn); } }, 'flow-qa', timeouts, 'codex', { productionQa: true, tasks: 14, stages: ['qa'] });
  root = join(f.directory, 'orchestrator');
  changeRoot = join(root, 'openspec/changes', change);
  tasksPath = join(changeRoot, 'tasks.md');
  evidence.stand = { directory: f.directory, root, home: join(f.directory, 'home'), tmpRoot: f.tmpRoot, statePath: join(f.directory, 'home/.raf/state.sqlite') };
  const socketModule = join(root, 'raf-develop/src/raf-temporary-socket.ts');
  const socketOriginal = await readFile(socketModule, 'utf8');
  const socketAdapted = socketOriginal
    .replace('`/tmp/raf-ipc-${process.getuid?.() ?? 0}`', JSON.stringify(join(f.directory, 'ipc')))
    .replace('`/tmp/raf-tools-${process.getuid?.() ?? 0}`', JSON.stringify(join(f.directory, 'tools')));
  assert.notEqual(socketOriginal, socketAdapted);
  await writeFile(socketModule, socketAdapted);
  evidence.transportFixturePatch = { file: 'src/raf-temporary-socket.ts', reason: 'Shared host IPC roots are denied; private stand roots only', beforeSha256: createHash('sha256').update(socketOriginal).digest('hex'), afterSha256: createHash('sha256').update(socketAdapted).digest('hex'), roots: [join(f.directory, 'ipc'), join(f.directory, 'tools')] };
  await writeFile(join(output, 'transport-fixture.patch'), ['--- src/raf-temporary-socket.ts (source)', '+++ src/raf-temporary-socket.ts (stand copy)', ...socketOriginal.split('\n').flatMap((line, index) => line === socketAdapted.split('\n')[index] ? [] : ['-' + line, '+' + socketAdapted.split('\n')[index]])].join('\n') + '\n');
  await cp(join(source, 'conf/briefs'), join(root, 'conf/briefs'), { recursive: true });
  for (const capability of ['core/process/user-qa', 'projects/raf/agent-report', 'projects/raf/agent-run']) {
    const destination = join(root, 'openspec/changes/enforce-flow-approaches/specs', capability);
    await mkdir(destination, { recursive: true });
    await cp(join(source, 'openspec/changes/enforce-flow-approaches/specs', capability, 'spec.md'), join(destination, 'spec.md'));
  }
  evidence.fixtureConfigurationHashes = Object.fromEntries(await Promise.all(['flow.json', 'raf.json', 'projects.json'].map(async name => [name, createHash('sha256').update(await readFile(join(root, 'conf', name))).digest('hex')])));
  await save();
  let fixedRun: Awaited<ReturnType<typeof launch>>;
  await scenario('own manual red → immediate fix → green report accepted; current assembled brief', async () => {
    const run = fixedRun = await launch('1.1');
    const redPath = join(changeRoot, 'manual-red.txt'), greenPath = join(changeRoot, 'manual-green.txt');
    await writeFile(redPath, 'Synthetic report input: manual red fact for admission testing. This file is fixture data, not a claim of live regression execution.\n');
    await writeFile(greenPath, 'Synthetic report input: same-run manual green fact for admission testing. This file is fixture data, not broker machine proof.\n');
    await f.git('add', '--', redPath, greenPath);
    await f.git('commit', '-qm', 'Synthetic manual correction facts for admission scenario');
    const fixCommit = { repository: root, sha: (await f.git('rev-parse', 'HEAD')).trim() };
    run.report.commits = [fixCommit];
    run.report.qa.scenarios[0].status = 'failed'; run.report.qa.scenarios[0].reason = 'Injected stand defect corrected in same run';
    run.report.qa.findings = [{ ...run.addressRow, requirement: 'openspec/specs/core/process/user-qa/spec.md', fixed: true, evidence: [run.proofPath], commits: [fixCommit], regression: { kind: 'manual', redEvidence: [redPath], greenEvidence: [greenPath] } }];
    await publish(run);
    const result = await accepted(run);
    assert.equal((await json(run.proofPath)).qa.scenarios[0].status, 'failed');
    assert.ok((result.proof as any).flowEvidence.length === 1);
    return { ...result, manualEvidenceBoundary: true, brief: run.address + '.brief.txt', failedScenarioPreserved: true };
  });
  for (const [item, purpose] of [['1.2', 'proposedTasks'], ['1.3', 'defect-fix'], ['1.4', 'repeat-qa']] as const) {
    await scenario('reject QA handoff ' + purpose + ' before mutation', async () => {
      const run = await launch(item);
      if (purpose === 'proposedTasks') run.report.proposedTasks = [{ description: 'Delegate QA fix' }];
      else run.report.qa.followUps = [{ ...run.addressRow, item: '1.14', sourceItem: item, purpose, reason: 'Transfer this scenario', evidence: [run.proofPath] }];
      await publish(run);
      const result = await rejected(run, purpose === 'proposedTasks' ? purpose : 'followUps');
      if (purpose === 'proposedTasks') {
        const close = await f.as(run.address, ['agent', 'close', '--id', run.address]);
        evidence.commands.push({ sender: run.address, argv: ['agent', 'close', '--id', run.address], ...close });
        assert.ok(session(run.runId).result?.status !== 'succeeded');
        assert.ok((await readFile(tasksPath, 'utf8')).includes(`- [ ] ${item} `));
        return { ...result, close, finalSessionState: session(run.runId).state };
      }
      return result;
    });
  }
  await scenario('truthful failed is accepted without checkbox', async () => {
    const run = await launch('1.5');
    run.report.status = 'failed'; run.report.changes[0].items[0] = { id: '1.5', status: 'failed', reason: 'Stand device unavailable' };
    run.report.qa.scenarios[0] = { ...run.report.qa.scenarios[0], status: 'failed', reason: 'Stand device unavailable' };
    await publish(run); return accepted(run, 'failed');
  });
  for (const [item, purpose] of [['1.6', 'first-execution'], ['1.7', 'deployment']] as const) await scenario('allow open ' + purpose, async () => {
    const run = await launch(item);
    run.report.qa.followUps = [{ ...run.addressRow, item: '1.14', sourceItem: item, purpose, reason: purpose === 'deployment' ? 'Deployment has not occurred' : 'First scenario was unavailable earlier', evidence: [run.proofPath] }];
    await publish(run); const result = await accepted(run);
    assert.ok(result.tasks.includes('- [ ] 1.14 ')); return result;
  });
  await scenario('develop cannot claim working main exception', async () => {
    const run = await launch('1.8');
    run.report.status = 'failed'; run.report.changes[0].items[0] = { id: '1.8', status: 'failed', reason: 'Unfixed stand defect' };
    run.report.qa.scenarios[0] = { ...run.report.qa.scenarios[0], status: 'failed', reason: 'Unfixed stand defect' };
    run.report.qa.findings = [{ ...run.addressRow, requirement: 'core/process/user-qa', fixed: false, reason: 'Unfixed stand defect', evidence: [run.proofPath], mainHotfix: { workspace: join(root, 'raf-develop'), branch: 'develop', requirement: 'projects/orchestrator/flow-approval', evidence: [run.proofPath] } }];
    await publish(run); return rejected(run, 'mainHotfix');
  });
  await scenario('ambiguous plan warning permits launch and does not prove success', async () => {
    const tasks = await readFile(tasksPath, 'utf8');
    await writeFile(tasksPath, tasks.replace(/(- \[ \] 1\.9 )[^\n]+/, '$1[qa] Повторити QA — джерело виконання невідоме'));
    const run = await launch('1.9');
    const launchResult = evidence.commands.at(-1);
    assert.match(launchResult.result.stdout, /warning|попереджен|Flow plan/i);
    assert.ok(!session(run.runId).result);
    assert.ok((await readFile(tasksPath, 'utf8')).includes('- [ ] 1.9 '));
    return { runId: run.runId, launchResult, noSuccessWithoutReport: true };
  });
  await scenario('accepted addressed repeat plan rejected before new session', async () => {
    assert.ok(fixedRun!);
    const tasks = await readFile(tasksPath, 'utf8');
    const line = `[qa] Повторити QA; source ${change}:1.1; scenario "${fixedRun.addressRow.scenario}"; evidence ${fixedRun.proofPath}`;
    await writeFile(tasksPath, tasks.replace(/(- \[ \] 1\.10 )[^\n]+/, '$1' + line));
    const before = f.inspect().sessions.length;
    const result = await command(f.runArgs('flow-repeat-plan', 'qa', ['1.10']));
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.match(JSON.stringify(result), /Flow plan/);
    assert.equal(f.inspect().sessions.length, before);
    assert.ok((await readFile(tasksPath, 'utf8')).includes('- [ ] 1.10 '));
    return { result, noSessionCreated: true, acceptedEvidence: fixedRun.proofPath };
  });
  await writeFile(join(output, 'tasks.final.md'), await readFile(tasksPath, 'utf8'));
  evidence.finalSessions = f.inspect().sessions;
  evidence.outcome = evidence.scenarios.every((row: any) => row.status === 'succeeded') ? 'passed' : 'failed';
} catch (error) {
  evidence.setupOrDriverFailure = { error: String(error), stack: (error as Error).stack };
  evidence.outcome = 'incomplete';
} finally {
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch (error) { evidence.cleanup.error = String(error); }
  }
  evidence.cleanup.complete = !evidence.cleanup.error;
  evidence.finishedAt = new Date().toISOString();
  await save();
}
console.log(JSON.stringify({ outcome: evidence.outcome, scenarios: evidence.scenarios.map(({ name, status, reason }: any) => ({ name, status, reason })), cleanup: evidence.cleanup, setupOrDriverFailure: evidence.setupOrDriverFailure }));
process.exitCode = evidence.outcome === 'passed' && evidence.cleanup.complete ? 0 : 1;
