import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { buildCatalog } from '../src/bootstrap.ts';
import { handoffModelRun, type ModelHandoffPorts } from '../src/model-routing-handoff.ts';
import { selectModel } from '../src/model-routing.ts';
import { observeProcesses, readMachineBootIdentity } from '../src/os-runtime.ts';
import { openStateStore } from '../src/state-store.ts';
import type { ProcessIdentity, SessionRecord } from '../src/session-state.ts';
import { prepareProductionQaFixture } from './production-qa-fixture.ts';

const conf = (name: string) => JSON.parse(readFileSync(new URL(`../../conf/${name}`, import.meta.url), 'utf8'));
const settings = conf('raf.json');
const constants = conf('raf-constants.json');
const models = conf('models.json');
const deadlineMs = conf('flow.json').integrationTests.timeoutMs;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
type Result = { exitCode: number; stdout: string; stderr: string };

async function fixture(t: TestContext) {
  const directory = mkdtempSync('/tmp/mri-');
  const root = join(directory, 'o');
  const home = join(directory, 'h');
  const socket = join(directory, 'control.sock');
  const checkout = join(root, 'raf-develop');
  const stubs = join(directory, 'bin');
  const log = join(directory, 'runner-calls.jsonl');
  const observations: unknown[] = [];
  const env = { ...process.env, HOME: home, RAF_QA_HOME: home, RAF_ORCHESTRATOR_ROOT: root, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${stubs}:/usr/bin:/bin` };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.RAF_RUN_ID;
  delete env.RAF_AGENT_ID;
  for (const path of [join(root, 'conf'), home, stubs]) mkdirSync(path, { recursive: true, mode: 0o700 });
  assert.ok(Buffer.byteLength(socket) + 1 <= 108);
  assert.ok(Buffer.byteLength(join(home, '.raf/service.sock')) + 1 <= 108);
  for (const name of ['raf.json', 'models.json', 'raf-constants.json', 'projects.json']) cpSync(new URL(`../../conf/${name}`, import.meta.url), join(root, 'conf', name));
  const tmux = (args: string[]) => spawnSync('/usr/bin/tmux', ['-S', socket, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  t.after(async () => {
    tmux(['kill-server']);
    const own = join(home, '.raf/tmp/tmux/server.sock');
    if (existsSync(own)) spawnSync('/usr/bin/tmux', ['-S', own, 'kill-server'], { env, timeout: 10_000 });
    for (let attempt = 0; attempt < 50 && existsSync(socket); attempt++) await delay(20);
    assert.equal(existsSync(socket), false, 'owned tmux endpoint must be removed');
    t.diagnostic(JSON.stringify({ kind: 'model-routing-integration-evidence', directory, socket, observations, cleanup: 'owned tmux server stopped; fixture directory removed' }));
    rmSync(directory, { recursive: true, force: true });
  });
  await prepareProductionQaFixture(t, { root, home });
  buildCatalog(join(root, 'conf'), join(checkout, 'dist/catalog.json'), constants.commands.map((row: { path: string[] }) => row.path.join(' ')));
  writeFileSync(log, '');
  for (const protocol of settings.runnerProtocols) writeFileSync(join(stubs, protocol.runner), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({runner:${JSON.stringify(protocol.runner)}, args:process.argv.slice(2)})+'\\n');
if(process.argv[2]!=='--version') process.exit(97);
console.log(${JSON.stringify(`${protocol.runner} ${protocol.version}`)});
`, { mode: 0o700 });
  const bin = join(checkout, 'bin/raf.ts');
  const cli = (argv: string[]) => {
    const result = spawnSync(process.execPath, [bin, ...argv], { cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    const output = { exitCode: result.status!, stdout: result.stdout, stderr: result.stderr };
    observations.push({ argv, ...output });
    return output;
  };
  const actorFile = join(directory, 'actor.mjs');
  writeFileSync(actorFile, `import{existsSync,readFileSync,writeFileSync,renameSync}from'node:fs';
import{spawnSync}from'node:child_process';
const queue=process.argv[2];let index=0;
setInterval(()=>{const path=queue+'/request-'+index+'.json';if(!existsSync(path))return;
const argv=JSON.parse(readFileSync(path,'utf8'));
const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(bin)},...argv],{cwd:${JSON.stringify(root)},env:process.env,encoding:'utf8',timeout:60000,maxBuffer:4194304});
const out=queue+'/result-'+index+'.json';writeFileSync(out+'.tmp',JSON.stringify({exitCode:result.status,stdout:result.stdout,stderr:result.stderr,signal:result.signal,error:result.error?.message}));renameSync(out+'.tmp',out);index++;},20);
`);
  const actor = (name: string) => {
    const queue = join(directory, name);
    mkdirSync(queue);
    const result = tmux(['new-session', '-d', '-s', name, '-P', '-F', '#{pane_id} #{pane_pid}', [process.execPath, actorFile, queue].map(quote).join(' ')]);
    assert.equal(result.status, 0, result.stderr);
    const [pane, pid] = result.stdout.trim().split(' ');
    return { queue, pane, pid: Number(pid), name, index: 0 };
  };
  const runIn = async (target: ReturnType<typeof actor>, argv: string[]): Promise<Result> => {
    const index = target.index++;
    const path = join(target.queue, `request-${index}.json`);
    writeFileSync(path + '.tmp', JSON.stringify(argv));
    renameSync(path + '.tmp', path);
    const out = join(target.queue, `result-${index}.json`);
    const until = Date.now() + 65_000;
    while (!existsSync(out) && Date.now() < until) await delay(30);
    assert.ok(existsSync(out), `fixture CLI did not finish: ${argv.join(' ')}`);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    observations.push({ actor: target.name, argv, ...result });
    return result;
  };
  const statePath = join(home, '.raf', settings.state.fileName);
  const withStore = <T>(use: (store: ReturnType<typeof openStateStore>) => T): T => {
    const store = openStateStore(statePath);
    try { return use(store); } finally { store.close(); }
  };
  const identity = async (target: ReturnType<typeof actor>, runner: string): Promise<ProcessIdentity> => {
    const ps = spawnSync('ps', ['-ww', '-o', 'lstart=,command=', '-p', String(target.pid)], { encoding: 'utf8', env: { ...env, LC_ALL: 'C' } });
    assert.equal(ps.status, 0, ps.stderr);
    const match = ps.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    assert.ok(match, ps.stdout);
    return { pid: target.pid, startedAt: new Date(match[1]).toISOString(), runner, runnerSessionId: `fixture-${target.name}`, tmuxSession: target.name,
      evidence: { command: match[2], tmuxSocket: socket, tmuxPane: target.pane, ...await readMachineBootIdentity() } };
  };
  return { directory, root, home, socket, tmux, cli, actor, runIn, withStore, identity, log, observations };
}

function success(result: Result): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('I1/I2 compiled runner switches persist across CLI processes and preserve a live fixture process', { timeout: deadlineMs }, async t => {
  const f = await fixture(t);
  const first = success(f.cli(['runner', 'list']));
  assert.ok(first.filter((row: any) => row.runner === 'claude').every((row: any) => !row.available));
  const main = f.actor('main');
  const attached = success(await f.runIn(main, ['main', 'attach']));
  assert.equal(attached.pid, main.pid);
  const enabled = success(await f.runIn(main, ['runner', 'enable', '--runner', 'claude']));
  assert.deepEqual(enabled, { runner: 'claude', enabled: true });
  const list = () => success(f.cli(['runner', 'list']));
  const claude = list().filter((row: any) => row.runner === 'claude');
  assert.equal(claude.length, models.models.filter((row: any) => row.runner === 'claude').length);
  assert.ok(claude.every((row: any) => row.available), JSON.stringify(claude));
  success(await f.runIn(main, ['runner', 'enable', '--runner', 'claude']));
  const state = () => f.withStore(store => models.runners.map((row: any) => [row.id, store.getRunnerEnabled(row.id)]));
  const beforeInvalid = state();
  for (const argv of [
    ['runner', 'enable'], ['runner', 'disable', '--runner', 'missing'],
    ['runner', 'enable', '--runner', 'claude', '--runner', 'claude'],
  ]) {
    const result = await f.runIn(main, argv);
    assert.notEqual(result.exitCode, 0);
    assert.ok(JSON.parse(result.stderr).code);
    assert.deepEqual(state(), beforeInvalid);
  }
  const denied = f.cli(['runner', 'disable', '--runner', 'claude']);
  assert.notEqual(denied.exitCode, 0);
  assert.match(JSON.parse(denied.stderr).code, /CALLER|AUTH|MAIN/);
  assert.deepEqual(state(), beforeInvalid);
  const actor = f.actor('fixture-agent');
  const process = await f.identity(actor, 'claude');
  const session: SessionRecord = { runId: 'fixture-live', addressId: 'fixture-live', revision: 1, state: 'running', process,
    activity: { type: 'qa', project: 'raf', features: [], phase: 'qa', cwd: f.root } };
  f.withStore(store => store.sessionRepository.transaction(tx => tx.putSession(session)));
  success(await f.runIn(main, ['runner', 'disable', '--runner', 'claude']));
  assert.equal((await observeProcesses([process]))[0].state, 'alive');
  assert.deepEqual(f.withStore(store => store.sessionRepository.transaction(tx => tx.getSession(session.runId), 'read')), session);
  assert.ok(list().filter((row: any) => row.runner === 'claude').every((row: any) => !row.available));
  f.withStore(store => store.initializeRunners(models.runners.map((row: any) => ({ ...row, initialEnabled: true }))));
  assert.equal(f.withStore(store => store.getRunnerEnabled('claude')), false);
  const snapshot = f.withStore(store => ({ runnerEnabled: Object.fromEntries(models.runners.map((row: any) => [row.id, store.getRunnerEnabled(row.id)])), cliAvailable: Object.fromEntries(models.runners.map((row: any) => [row.id, true])), quotas: [] }));
  const policy = { ...models, models: models.models.filter((row: any) => row.runner === 'claude') };
  assert.equal(selectModel(policy, snapshot, { complexity: 'mechanical' }).status, 'waiting');
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.length > 0);
  assert.ok(calls.every(row => JSON.stringify(row.args) === '["--version"]'), 'list and selection must not invoke quota or model requests');
  f.observations.push({ preservedProcess: process, disabledState: state(), newSelection: 'waiting', noProbe: true });
});

test('I4 SQLite finalization rolls back all effects after an injected domain write failure and is idempotent', { timeout: deadlineMs }, async t => {
  const directory = mkdtempSync('/tmp/mri-tx-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const first = openStateStore(path);
  const second = openStateStore(path);
  t.after(() => { second.close(); first.close(); });
  const old: SessionRecord = { runId: 'old', addressId: 'worker', revision: 3, state: 'exited' };
  first.sessionRepository.transaction(tx => { tx.putSession(old); tx.putReservation({ runId: old.runId, resource: 'fixture', amount: 1 }); });
  const pending = { id: 'old:agent.closed', runId: old.runId, event: 'agent.closed', payload: { id: old.addressId } };
  assert.throws(() => first.finalizeSession(old.runId, old.revision, new Date().toISOString(), {
    pending: [pending], domain: [{ id: 'fault', domain: 'injected-write-failure', payload: null }],
  }), /Unknown domain effect/);
  assert.deepEqual(second.sessionRepository.transaction(tx => tx.getSession(old.runId), 'read'), old);
  assert.equal(second.sessionRepository.transaction(tx => tx.listReservations(), 'read').length, 1);
  assert.deepEqual(second.listPending(), []);
  const attempts = await Promise.all([first, second].map(async store => store.finalizeSession(old.runId, old.revision, new Date().toISOString(), { pending: [pending], domain: [] })));
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(first.sessionRepository.transaction(tx => tx.getSession(old.runId), 'read')!.state, 'finished');
  assert.deepEqual(first.sessionRepository.transaction(tx => tx.listReservations(), 'read'), []);
  assert.deepEqual(first.listPending(), [pending]);
  assert.equal(second.finalizeSession(old.runId, old.revision, new Date().toISOString(), { pending: [pending], domain: [] }), false);
});

test('I3 real process observation keeps a limited predecessor reserved until its exit is confirmed', { timeout: deadlineMs }, async t => {
  const f = await fixture(t);
  success(f.cli(['runner', 'list']));
  const actor = f.actor('limited-agent');
  const process = await f.identity(actor, 'claude');
  const session: SessionRecord = { runId: 'limited', addressId: 'limited', revision: 1, state: 'running', process,
    activity: { type: 'qa', project: 'raf', features: [], phase: 'qa', cwd: f.root } };
  f.withStore(store => store.sessionRepository.transaction(tx => { tx.putSession(session); tx.putReservation({ runId: session.runId, resource: 'fixture', amount: 1 }); }));
  const never = async (): Promise<never> => { assert.fail('live predecessor cannot finalize or launch a successor'); };
  const ports: ModelHandoffPorts = {
    currentSession: async () => f.withStore(store => store.sessionRepository.transaction(tx => tx.getSession(session.runId)!, 'read')),
    checkFinalReport: async () => ({ runId: session.runId, status: 'missing', reason: 'No fixture report' }),
    inspect: async () => (await observeProcesses([process]))[0],
    finalize: never, readCurrentWork: never, readRouting: never, launchNew: never,
  };
  const request = { session, signal: { runId: session.runId, observation: { status: 'limited' as const, reason: 'fixture limit; no provider quota claim' } }, ownerAction: 'continue' as const };
  assert.equal((await handoffModelRun(request, ports)).status, 'waiting');
  assert.equal((await handoffModelRun(request, { ...ports, inspect: async () => ({ state: 'unknown', observedAt: new Date().toISOString(), error: 'injected scanner failure' }) })).status, 'waiting');
  assert.equal(f.withStore(store => store.sessionRepository.transaction(tx => tx.listReservations(), 'read')).length, 1);
  assert.deepEqual(f.withStore(store => store.sessionRepository.transaction(tx => tx.getSession(session.runId), 'read')), session);
  f.observations.push({ signal: request.signal, process, observation: (await observeProcesses([process]))[0], reserved: true });
});
