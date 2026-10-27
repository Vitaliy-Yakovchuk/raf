import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import type { TestContext } from 'node:test';
import { fixture, eventually } from '../test/production-fixture.ts';
import { readMachineBootIdentity } from '../src/os-runtime.ts';

const cleanups: (() => unknown)[] = [];
const lifecycle = { after: (action: () => unknown) => cleanups.push(action) } as unknown as TestContext;
const f = await fixture(lifecycle, { productionQa: true });
const prefix = process.argv[2];
const testDelivery = process.argv[3] === 'test-delivery';
const queueMode = process.argv[3] === 'queue' || testDelivery;
assert.ok(prefix);
try {
  if (prefix === 'before') {
    const original = spawnSync('git', ['show', '91fdddf05d4b4a325f44bcfe51c34e0fda94f2c5:src/message-delivery.ts'], { encoding: 'utf8' });
    assert.equal(original.status, 0, original.stderr);
    await writeFile(join(f.cwd, 'src/message-delivery.ts'), original.stdout);
  }
  const settings = JSON.parse(await readFile(join(f.confRoot, 'raf.json'), 'utf8'));
  const protocol = settings.runnerProtocols.find((row: any) => row.runner === 'claude');
  protocol.timeouts.pollMs = 100;
  protocol.markers = { ready: ['agent ready'] };
  protocol.native = { ...protocol.native, composer: '^❯(?:\\s|$)', working: '^Working' };
  await writeFile(join(f.confRoot, 'raf.json'), JSON.stringify(settings));
  const recipient = join(f.root, 'fixture-claude.mjs');
  await writeFile(recipient, `
process.stdin.setRawMode(true);
process.stdin.resume();
const show = text => process.stdout.write('\\x1b[2J\\x1b[Hagent ready\\r\\n❯ '+text+'\\r\\nfooter\\r\\n');
show('owner draft');
process.on('SIGUSR1', () => show(''));
process.stdin.on('data', () => {process.stdout.write('\\x1b[2J\\x1b[Hagent ready\\r\\naccepted message\\r\\n❯ \\r\\nfooter\\r\\n');});
`);
  const pane = await f.execute({ executable: 'tmux', args: ['new-session', '-d', '-P', '-F', '#{pane_pid}|#{pane_id}', '-s', 'recipient', process.execPath, recipient] });
  assert.equal(pane.exitCode, 0, pane.stderr);
  console.log(JSON.stringify({ stage: 'pane', pane }));
  const [pidText, paneId] = pane.stdout.trim().split('|');
  const pid = Number(pidText);
  f.trackProcess(pid);
  const boot = await readMachineBootIdentity();
  const identity = (target: number, runner: string, tmux = false) => {
    const scan = spawnSync('ps', ['-ww', '-p', String(target), '-o', 'lstart=,args='], { encoding: 'utf8' });
    assert.equal(scan.status, 0, scan.stderr);
    const row = /^\s*(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(scan.stdout.trim())!;
    assert.ok(row, scan.stdout);
    return { pid: target, startedAt: new Date(row[1]).toISOString(), runner, runnerSessionId: 'cpu-fixture', tmuxSession: 'recipient', evidence: { command: row[2], ...boot, ...(tmux ? { tmuxSocket: f.socket, tmuxPane: paneId } : {}) } };
  };
  f.store.sessionRepository.transaction(tx => {
    for (const [runId, addressId, processIdentity] of [['sender', 'cpu-fixture', identity(process.pid, 'codex')], ['recipient', 'main', identity(pid, 'main', true)]] as const) {
      tx.putSession({ runId, addressId, state: 'running', revision: 0, process: processIdentity, activity: { type: 'hotfix', phase: 'hotfix', project: 'raf', features: ['fixture-launch'], cwd: f.cwd }, launchContext: { testAssignment: { runId, agentId: addressId, type: 'hotfix', phase: 'hotfix', project: 'raf', workspace: f.cwd, branch: 'develop', changes: ['fixture-launch'] }, assignment: f.assignment, selection: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', reason: 'CPU fixture' }, briefPath: 'fixture', reportPath: 'fixture' } });
    }
  });
  if (testDelivery) {
    f.store.sessionRepository.transaction(tx => { const sender = tx.getSession('sender')!; tx.putSession({ ...sender, notify: { addressId: 'main', runId: 'recipient' } }); });
    f.store.resultNotices.stageReportDiagnostic('sender', 'Synthetic pending notice for CPU measurement');
  }
  const env = { ...process.env, HOME: f.home, RAF_QA_HOME: f.home, RAF_ORCHESTRATOR_ROOT: f.root, PATH: f.binRoot + delimiter + process.env.PATH };
  delete env.TMUX; delete env.TMUX_PANE;
  let command = [join(f.cwd, 'bin/raf.ts'), 'agent', 'message', '--to', 'main', '--text', 'CPU fixture delivery'];
  if (queueMode) {
    await writeFile(join(f.confRoot, 'raf-constants.json'), await readFile(new URL('../../conf/raf-constants.json', import.meta.url)));
    const socketPath = join(f.root, 'resource-wait.sock');
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', data => {
        buffer += data;
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (value.kind !== 'resource-wait') continue;
          const ticket = { requestId: 'fixture-request', serviceEpoch: 'fixture-epoch' };
          socket.write(JSON.stringify({ kind: 'ticket', ticket, workload: 'test' }) + '\n');
          socket.write(JSON.stringify({ kind: 'result', result: { ...ticket, kind: 'waiting', admission: { level: 'NO_RESOURCES', allowed: false } } }) + '\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    cleanups.unshift(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const flow = JSON.parse(await readFile(f.flowPath, 'utf8'));
    for (const tier of ['normal', 'hotfix']) flow.resources[tier].minRamBytes = 2 ** 50;
    await writeFile(f.flowPath, JSON.stringify(flow));
    const file = 'test/cpu-wait-stand.test.ts';
    await mkdir(join(f.cwd, 'test'), { recursive: true });
    await writeFile(join(f.cwd, file), "throw new Error('The CPU stand must never launch a test child');\n");
    const configPath = join(f.confRoot, 'test-runs.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.projects.raf.profiles.node.unitFiles = [file];
    config.projects.raf.groups = { 'fixture-launch/cpu-wait': { profileId: 'node', files: [file] } };
    await writeFile(configPath, JSON.stringify(config));
    const hook = join(f.root, 'fixture-service-hook.mjs');
    const protocolUrl = pathToFileURL(join(f.cwd, 'src/resource-wait-protocol.ts')).href;
    const transportUrl = pathToFileURL(join(f.cwd, 'src/resource-wait-transport.ts')).href;
    const source = `import {runResourceWaitCommand} from ${JSON.stringify(protocolUrl)};import {connectResourceWait} from ${JSON.stringify(transportUrl)};
export async function waitForResources(input) {const controller=new AbortController();const abort=()=>controller.abort();process.once('SIGTERM',abort);try{return await runResourceWaitCommand({...input,connectionId:'fixture',clientIdentity:{},signal:controller.signal},{levels:[{id:input.level}]},{ensureReady:async()=>({endpoint:${JSON.stringify(socketPath)},serviceEpoch:'fixture-epoch'}),connect:connectResourceWait,recordDuration:()=>{}})}finally{process.off('SIGTERM',abort)}}`;
    await writeFile(hook, `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='./resource-wait-command.ts'&&context.parentURL.endsWith('/test-run-queue-runtime.ts'))return{url:'cpu-stand:service',shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url==='cpu-stand:service')return{format:'module',source:${JSON.stringify(source)},shortCircuit:true};return next(url,context)}});`);
    command = ['--import', hook, join(f.cwd, 'bin/raf.ts'), 'test', 'run', '--project', 'raf', '--phase', 'red', '--group', 'fixture-launch/cpu-wait', '--files', file];
  }
  const child = spawn(process.execPath, command, { cwd: f.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  f.trackProcess(child.pid!);
  let stdout = '', stderr = '', closed = false;
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  const completion = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', code => { closed = true; resolve(code); }); });
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(closed, false, stdout + stderr);
  const sample = async () => {
    const raw = await readFile(`/proc/${child.pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { at: performance.now(), user: Number(fields[11]), system: Number(fields[12]), start: fields[19] };
  };
  const before = await sample();
  console.log(JSON.stringify({ stage: 'waiting', pid: child.pid, root: f.root }));
  await new Promise(resolve => setTimeout(resolve, 60000));
  const after = await sample();
  assert.equal(closed, false, stdout + stderr);
  assert.equal(before.start, after.start);
  if (queueMode) {
    if (testDelivery) { process.kill(pid, 'SIGUSR1'); await eventually(() => stderr, value => value.includes('NO_RESOURCES'), 'resource queue after completing pending delivery'); }
    assert.match(stderr, /NO_RESOURCES/); child.kill('SIGTERM');
  }
  else process.kill(pid, 'SIGUSR1');
  const cliExitCode = await completion;
  const hz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
  const cpuMs = (after.user - before.user + after.system - before.system) * 1000 / hz;
  const measurement = { command: [process.execPath, ...command], isolatedHome: f.home, waiting: testDelivery ? 'actual test CLI settling a pending main notice before admission; then enters NO_RESOURCES queue' : queueMode ? 'actual CLI and admission; fixture socket replaces service startup, sends NO_RESOURCES, never grants a permit' : 'verified main recipient owns an unfinished draft', pollMs: protocol.timeouts.pollMs, idleIntervalMs: protocol.timeouts.transitionMs, before, after, hz, wallMs: after.at - before.at, cpuMs, cliExitCode, stdout, stderr };
  const name = `${prefix}-${testDelivery ? 'test-delivery' : queueMode ? 'queue' : 'message'}`;
  await writeFile(`evidence/fix-raf-waiting-cli-cpu/${name}-cpu.json`, JSON.stringify(measurement, null, 2) + '\n');
  if (queueMode) {
    const result = JSON.parse(stdout);
    await writeFile(`evidence/fix-raf-waiting-cli-cpu/${name}.TestRunResult.json`, stdout);
    await writeFile(`evidence/fix-raf-waiting-cli-cpu/${name}.stderr.txt`, stderr);
    await import('node:fs/promises').then(fs => fs.rm(result.command.environment.HOME, { recursive: true, force: true }));
  }
  console.log(JSON.stringify({ stage: 'measured', name, wallMs: measurement.wallMs, cpuMs, cliExitCode }));
  assert.equal(cliExitCode, queueMode ? 1 : 0, stderr);
} finally { for (const cleanup of cleanups) await cleanup(); }
