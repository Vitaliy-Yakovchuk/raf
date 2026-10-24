import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import { runLaunchWrapper } from '../src/launch-wrapper.ts';
import type { LaunchWrapperRequest, LaunchWrapperPorts, LaunchReadiness, LaunchOwnership } from '../src/launch-wrapper.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
async function fixture(t: test.TestContext) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'raf-wrapper-'));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));
  const request: LaunchWrapperRequest = {
    tmpRoot, statePath: join(tmpRoot, 'state.sqlite'), runId: 'run-one', address: 'worker-one', cwd: tmpRoot,
    tmuxSession: 'owned-one', selection: { runner: 'codex', model: 'synthetic-model', effort: 'high' },
    brief: 'Literal brief\n$(touch forbidden) `command` "quotes"', readinessTimeoutMs: 50,
    assignment: { root: tmpRoot, baselineArchives: [], changes: [{ id: 'change-one', items: [{ id: '1.1', description: 'Work' }] }] },
  };
  const events: string[] = [];
  const exit = deferred<{ code: number | null; signal: string | null }>();
  const handshaken = deferred<void>();
  const identity = { pid: process.pid, startedAt: new Date().toISOString(), runner: 'codex', runnerSessionId: 'native-session-one', tmuxSession: request.tmuxSession, evidence: { runId: request.runId, command: process.execPath } };
  let ready: LaunchReadiness = { state: 'ready', runnerSessionId: identity.runnerSessionId };
  let ownership: LaunchOwnership = { state: 'owned', identity, processKind: 'agent' };
  let valid = true;
  let reportPath = '';
  const results: unknown[] = [];
  const ports: LaunchWrapperPorts = {
    transport: {
      startWithoutInput: async (_request, path) => { events.push('start'); reportPath = path; },
      waitReady: async timeout => { assert.equal(timeout, 50); events.push('ready'); return ready; },
      ownership: async () => { events.push('ownership'); return ownership; },
      deliver: async brief => { assert.equal(brief, request.brief); events.push('deliver'); },
      waitExit: () => exit.promise,
      stop: async value => { assert.deepEqual(value, identity); events.push('stop'); exit.resolve({ code: null, signal: 'SIGTERM' }); },
    },
    report: {
      fs: {
        mkdir: async path => { await mkdir(path, { recursive: true }); },
        readText: async path => { try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
        removeTree: async path => { events.push('cleanup'); await rm(path, { recursive: true, force: true }); },
      },
      watch: () => () => {}, now: () => new Date().toISOString(),
      verifyAssignmentCompletion: async (snapshot, archives) => { assert.deepEqual(snapshot, request.assignment); assert.deepEqual(archives, {}); events.push('verify'); return { ok: valid, issues: [] }; },
      diagnostic: async () => { events.push('diagnostic'); },
    },
    lifecycle: {
      started: async value => { assert.deepEqual(value.identity, identity); events.push('started'); },
      acceptReport: async result => { results.push(result); events.push(`result:${result.status}`); },
      finish: async () => { events.push('finish'); },
      failed: async (_run, _reason, recoverable) => { events.push(`failed:${recoverable}`); },
    },
    handshake: async value => { assert.deepEqual(value.identity, identity); events.push('handshake'); handshaken.resolve(); },
  };
  return { request, ports, events, exit, identity, results, handshaken,
    setReady: (value: LaunchReadiness) => { ready = value; },
    setOwnership: (value: LaunchOwnership) => { ownership = value; },
    setValid: (value: boolean) => { valid = value; },
    writeReport: () => writeFile(reportPath, JSON.stringify({ status: 'succeeded', answer: 'Done', changes: [{ id: 'change-one', items: [{ id: '1.1', status: 'succeeded' }] }] })),
  };
}

test('known readiness and verified native process precede literal brief, committed start and handshake', async t => {
  const f = await fixture(t);
  const running = runLaunchWrapper(f.request, f.ports);
  await Promise.race([f.handshaken.promise, running]);
  assert.deepEqual(f.events.slice(0, 7), ['start', 'ready', 'ownership', 'deliver', 'ownership', 'started', 'handshake']);
  await f.writeReport();
  f.exit.resolve({ code: 7, signal: null });
  await running;
  assert.equal(f.results.length, 1);
  assert.equal((f.results[0] as { status: string }).status, 'succeeded');
  assert.ok(f.events.indexOf('verify') < f.events.indexOf('result:succeeded'));
  assert.ok(f.events.indexOf('result:succeeded') < f.events.indexOf('finish'));
});

for (const state of ['auth_required', 'permission_required', 'unknown_screen', 'timeout', 'exited'] as const) {
  test(`${state} never receives a brief or submission and stops only an owned process`, async t => {
    const f = await fixture(t);
    f.setReady({ state, reason: state });
    await assert.rejects(runLaunchWrapper(f.request, f.ports));
    assert.ok(!f.events.includes('deliver'));
    assert.ok(!f.events.includes('handshake'));
    if (f.events.includes('stop')) assert.ok(f.events.indexOf('ownership') < f.events.indexOf('stop'));
  });
}

for (const state of ['mismatch', 'unknown', 'exited'] as const) {
  test(`${state} ownership cannot publish running or kill a process`, async t => {
    const f = await fixture(t);
    f.setOwnership({ state, reason: 'identity not proved' });
    await assert.rejects(runLaunchWrapper(f.request, f.ports));
    assert.ok(!f.events.includes('stop'));
    assert.ok(!f.events.includes('deliver'));
    assert.ok(!f.events.includes('handshake'));
    if (state === 'unknown') assert.ok(f.events.includes('failed:true'));
  });
}

for (const field of ['runnerSessionId', 'startedAt', 'runId', 'command'] as const) {
  test(`missing ${field} cannot stand in for owned agent identity`, async t => {
    const f = await fixture(t);
    if (field === 'runId' || field === 'command') f.identity.evidence[field] = '';
    else f.identity[field] = '';
    await assert.rejects(runLaunchWrapper(f.request, f.ports));
    assert.ok(!f.events.includes('handshake'));
    assert.ok(!f.events.includes('deliver'));
  });
}

test('native session identity mismatch is refused', async t => {
  const f = await fixture(t);
  f.setReady({ state: 'ready', runnerSessionId: 'unrelated-native-session' });
  await assert.rejects(runLaunchWrapper(f.request, f.ports));
  assert.ok(!f.events.includes('deliver'));
});

test('unverified succeeded is never accepted and missing valid result fails before lifecycle finalization', async t => {
  const f = await fixture(t);
  f.setValid(false);
  const running = runLaunchWrapper(f.request, f.ports);
  await Promise.race([f.handshaken.promise, running]);
  await f.writeReport();
  f.exit.resolve({ code: 0, signal: null });
  await running;
  assert.equal(f.results.length, 1);
  assert.equal((f.results[0] as { status: string }).status, 'failed');
  assert.ok(f.events.indexOf('result:failed') < f.events.indexOf('finish'));
});

test('sink failure cannot acknowledge accepted report or finalize the session', async t => {
  const f = await fixture(t);
  f.ports.lifecycle.acceptReport = async () => { throw new Error('result sink unavailable'); };
  const running = runLaunchWrapper(f.request, f.ports);
  await Promise.race([f.handshaken.promise, running]);
  await f.writeReport();
  f.exit.resolve({ code: 0, signal: null });
  await assert.rejects(running, /result sink unavailable/);
  assert.ok(!f.events.includes('finish'));
});

test('persistent wrapper outlives launching CLI and finalizes a real child through private socket and files', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const request = { ...f.request, readinessTimeoutMs: 5000 };
  const moduleUrl = pathToFileURL(resolve('src/launch-wrapper.ts')).href;
  const workerPath = join(f.request.tmpRoot, 'worker.mjs');
  const launcherPath = join(f.request.tmpRoot, 'launcher.mjs');
  const resultPath = join(f.request.tmpRoot, 'receipt.json');
  const runnerSocket = join(f.request.tmpRoot, 'runner.sock');
  const workerSource = `
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { runLaunchWrapper } from ${JSON.stringify(moduleUrl)};
const request = JSON.parse(await readFile(process.env.RAF_WRAPPER_REQUEST_PATH, 'utf8'));
const events = [];
let child;
let identity;
let exit;
let result;
let ready;
const readyPromise = new Promise(resolve => { ready = resolve; });
const ports = {
  transport: {
    async startWithoutInput(request, reportPath) {
      const runnerSource = ${JSON.stringify(`
const { createServer } = require('node:net');
const { writeFileSync } = require('node:fs');
const server = createServer(socket => { socket.once('data', () => {
writeFileSync(process.argv[1], JSON.stringify({status:'succeeded',answer:'Done',changes:[{id:'change-one',items:[{id:'1.1',status:'succeeded'}]}]}));
socket.end(); server.close(() => process.exit(7));
}); });
server.listen(process.argv[2], () => process.send({ready:true,session:'native-local-fixture'}));
`)};
      child = spawn(process.execPath, ['-e', runnerSource, reportPath, ${JSON.stringify(runnerSocket)}], { stdio: ['ignore','ignore','ignore','ipc'] });
      identity = { pid: child.pid, startedAt: new Date().toISOString(), runner:'codex',runnerSessionId:'native-local-fixture',tmuxSession:request.tmuxSession,evidence:{runId:request.runId, command:process.execPath+' -e '+runnerSource} };
      child.once('message', () => ready({state:'ready',runnerSessionId:'native-local-fixture'}));
      exit = new Promise(resolve => child.once('exit', (code,signal) => resolve({code,signal})));
    },
    waitReady: () => readyPromise,
    ownership: async () => ({state:'owned',identity,processKind:'agent'}),
    deliver: async brief => { if (brief !== request.brief) throw Error('brief changed'); events.push('delivered'); },
    waitExit: () => exit,
    stop: async expected => { if(expected.pid !== child.pid) throw Error('foreign pid'); child.kill(); },
  },
  report: {
    fs: {
      mkdir: async path => { await mkdir(path,{recursive:true}); },
      readText: async path => { try{return await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;} },
      removeTree: async path => { await rm(path,{recursive:true,force:true}); },
    },
    watch: () => () => {}, now: () => new Date().toISOString(),
    verifyAssignmentCompletion: async () => {events.push('verified');return {ok:true,issues:[]};},
    diagnostic: async () => {},
  },
  lifecycle: {
    started: async () => { events.push('started'); },
    acceptReport: async value => { result=value;events.push('accepted'); },
    finish: async (_handshake, finalExit) => { events.push('finished');await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({result,events,finalExit,wrapperPid:process.pid})); },
    failed: async (_id, reason) => {throw Error(reason);},
  },
  handshake: async value => {
    const socket = connect(process.env.RAF_WRAPPER_HANDSHAKE_SOCKET);
    await new Promise((resolve,reject) => {socket.once('error',reject);socket.once('connect',resolve);});
    socket.end(JSON.stringify(value)+'\\n');
  },
};
await runLaunchWrapper(request,ports);
`;
  await writeFile(workerPath, workerSource);
  await writeFile(launcherPath, `
import { launchPersistentWrapper } from ${JSON.stringify(moduleUrl)};
const result=await launchPersistentWrapper(${JSON.stringify(request)},{workerCommand:{executable:process.execPath,args:[${JSON.stringify(workerPath)}]},timeoutMs:5000});
process.stdout.write(JSON.stringify(result));
`);
  const launcher = spawn(process.execPath, [launcherPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  launcher.stdout.on('data', chunk => { stdout += chunk; });
  launcher.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(launcher, 'exit');
  assert.equal(code, 0, stderr);
  const handshake = JSON.parse(stdout);
  t.after(() => {
    for (const pid of [handshake.identity.pid, handshake.wrapperPid]) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  });
  assert.notEqual(handshake.wrapperPid, launcher.pid);
  assert.notEqual(handshake.identity.pid, handshake.wrapperPid);
  assert.equal(handshake.identity.runnerSessionId, 'native-local-fixture');
  assert.equal(handshake.identity.evidence.runId, f.request.runId);
  assert.equal(handshake.reportPath, join(f.request.tmpRoot, f.request.runId, `${f.request.address}.json`));
  process.kill(handshake.wrapperPid, 0);
  process.kill(handshake.identity.pid, 0);
  await assert.rejects(readFile(resultPath), { code: 'ENOENT' });
  const socket = connect(runnerSocket);
  await once(socket, 'connect');
  socket.end('finish');
  let receipt;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { receipt = JSON.parse(await readFile(resultPath, 'utf8')); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(receipt, 'detached wrapper must process exit after launching CLI exits');
  assert.equal(receipt.result.status, 'succeeded');
  assert.equal(receipt.finalExit.code, 7);
  assert.deepEqual(receipt.events, ['delivered', 'started', 'verified', 'accepted', 'finished']);
});

test('same address in a later run gets a distinct report path and cannot consume old success', async t => {
  const f = await fixture(t);
  await mkdir(join(f.request.tmpRoot, 'old-run'), { recursive: true });
  const oldPath = join(f.request.tmpRoot, 'old-run', `${f.request.address}.json`);
  await writeFile(oldPath, JSON.stringify({ status: 'succeeded', answer: 'Old', changes: [] }));
  const running = runLaunchWrapper(f.request, f.ports);
  await Promise.race([f.handshaken.promise, running]);
  f.exit.resolve({ code: 1, signal: null });
  await running;
  assert.equal((f.results[0] as { status: string }).status, 'failed');
  assert.equal(JSON.parse(await readFile(oldPath, 'utf8')).answer, 'Old');
});

test('delivery failure rechecks ownership before stopping and retains recoverable state if identity changed', async t => {
  const f = await fixture(t);
  f.ports.transport.deliver = async () => {
    f.events.push('deliver');
    f.setOwnership({ state: 'mismatch', reason: 'PID was reused after readiness' });
    throw new Error('delivery failed');
  };
  await assert.rejects(runLaunchWrapper(f.request, f.ports), /delivery failed/);
  assert.equal(f.events.filter(event => event === 'ownership').length, 2);
  assert.ok(f.events.indexOf('ownership') < f.events.indexOf('deliver'));
  assert.ok(f.events.lastIndexOf('ownership') > f.events.indexOf('deliver'));
  assert.ok(!f.events.includes('stop'));
  assert.ok(!f.events.includes('handshake'));
  assert.ok(f.events.includes('failed:true'));
});

test('failed start commit never acknowledges running and terminates only its verified owned process', async t => {
  const f = await fixture(t);
  f.ports.lifecycle.started = async () => { throw new Error('start commit rejected'); };
  await assert.rejects(runLaunchWrapper(f.request, f.ports), /start commit rejected/);
  assert.ok(!f.events.includes('handshake'));
  assert.equal(f.events.filter(event => event === 'ownership').length, 3);
  assert.ok(f.events.lastIndexOf('ownership') > f.events.indexOf('started'));
  assert.ok(f.events.lastIndexOf('ownership') < f.events.indexOf('stop'));
  assert.ok(f.events.includes('stop'));
});
