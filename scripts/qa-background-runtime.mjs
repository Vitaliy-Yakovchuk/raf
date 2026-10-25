import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const script = path.resolve(import.meta.filename);
const atomic = (file, value) => { fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(file + '.part', file); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const wait = async (label, operation, budget = 45000) => {
  const end = Date.now() + budget;
  while (Date.now() < end) { const value = await operation(); if (value) return value; await delay(50); }
  throw Error('Incomplete stand precondition: ' + label);
};
const db = (file, action, readOnly = true) => { const value = new DatabaseSync(file, { readOnly }); try { return action(value); } finally { value.close(); } };
const live = pid => { try { return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const load = (code, name) => import(pathToFileURL(path.join(code, 'src', name + '.ts')).href);

if (process.argv[2] === 'pane') {
  const config = read(process.argv[3]);
  let input = '', serial = 0, last = '';
  const draw = () => process.stdout.write('\x1b[?2004h\x1b[2J\x1b[H' + 'CFC34 owned native-screen receiver ' + serial + '\n' + last + '\n' + "don't ask on (shift+tab to cycle)" + '\n$ ' + input);
  draw();
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  process.stdin.on('data', chunk => {
    input += chunk;
    for (;;) {
      const index = input.search(/[\r\n]/); if (index < 0) break;
      const line = input.slice(0, index).replace(/\x1b\[(?:200|201)~/g, ''); input = input.slice(index + 1);
      if (line) { fs.appendFileSync(config.received, JSON.stringify({ text: line, pid: process.pid }) + '\n'); last = line; serial++; }
    }
    draw();
  });
  const run = request => {
    const args = [path.join(config.main, 'bin/raf.ts'), ...request.args];
    const start = performance.now();
    const value = spawnSync(process.execPath, args, { cwd: config.main, env: process.env, encoding: 'utf8', maxBuffer: 16000000, timeout: 120000 });
    const result = { command: [process.execPath, ...args], cwd: config.main, cliExitCode: value.status, signal: value.signal,
      error: value.error?.message ?? null, durationMs: performance.now() - start, stdout: value.stdout ?? '', stderr: value.stderr ?? '' };
    for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(config.output, request.label + '.' + stream), result[stream]);
    atomic(path.join(config.output, request.label + '.json'), result);
  };
  if (config.attach) run({ label: 'main-attach', args: ['main', 'attach'] });
  atomic(config.ready, { pid: process.pid });
  setInterval(() => {
    for (const name of fs.readdirSync(config.commands).filter(name => name.endsWith('.json')).sort()) {
      const file = path.join(config.commands, name), request = read(file);
      fs.renameSync(file, file + '.running'); run(request); fs.renameSync(file + '.running', file + '.done');
    }
  }, 50);
} else if (process.argv[2] === 'upstream') {
  const config = read(process.argv[3]);
  const { createServer } = await import('node:https');
  const server = createServer({ key: fs.readFileSync(config.key), cert: fs.readFileSync(config.cert) }, (request, response) => {
    const state = read(config.control), url = new URL(request.url, 'https://localhost');
    fs.appendFileSync(config.log, JSON.stringify({ pathname: url.pathname, cursor: url.searchParams.get('cursor'), revision:state.revision, repeated:!!state.repeat, at: Date.now() }) + '\n');
    const key = ['qa', 'fixture', '3401'], problem_id = JSON.stringify(key);
    const detail = { problem_id, revision: state.revision, status: 'open', state: 'open', created_at: '2026-10-25T00:00:00Z', comments: state.comment ? [{ id: state.comment, author_id: 'human-fixture', author_kind: 'person', text: 'CFC34 literal $(touch forbidden) `false`', created_at: '2026-10-25T00:00:00Z' }] : [], attachments: [] };
    let value;
    if (url.pathname === '/api/bugs/events') {
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      value = { cursor: String(state.revision), has_more: false, events: (state.revision > cursor || state.repeat) && state.revision > 0 ? [{ cursor: String(state.revision), problem_id, kind: 'changed' }] : [] };
    } else if (url.pathname === '/api/bugs') value = { bugs: state.revision ? [detail] : [], nextCursor: null };
    else value = detail;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1', () => atomic(config.ready, { port: server.address().port }));
} else if (process.argv[2] === 'state') {
  const input = read(process.argv[3]);
  const { openStateStore } = await load(input.code, 'state-store');
  const store = openStateStore(input.state);
  try {
    if (input.op === 'prepare') {
      const {ensureProductionMainStore}=await load(input.code,'main-production-store'); process.stdout.write(JSON.stringify(await ensureProductionMainStore({root:input.root})));
    } else if (input.op === 'seed') {
      store.taskReservationRepository.transaction(tx => { for (const session of input.sessions) { tx.putSession(session); if (input.reserve) { const process = session.process; tx.putReservation({runId:session.runId,resource:'qa-fixture',amount:1,resourceBundle:{machineId:process.evidence.machineId,resources:{ramBytes:1024,diskBytes:{}}}}); tx.putTaskReservation({lease:{owner:{runId:session.runId,addressId:session.addressId,fence:'owned-fixture'},revision:0},boot:{machineId:process.evidence.machineId,bootId:process.evidence.bootId},stage:'running',starter:process,agent:process,tasks:[{key:{project:'raf',changeId:'owned-fixture',taskId:'1'},changeInstance:'owned-fixture-instance',fingerprint:'owned-fixture-fingerprint'}]}); } } });
      process.stdout.write(JSON.stringify({ seeded: input.sessions.map(row => row.addressId) }));
    } else if (input.op === 'identity') {
      const {readWaitIdentity}=await load(input.code,'resource-wait-identity');
      const boot=await readWaitIdentity(input.pid); const ps=spawnSync('ps',['-ww','-p',String(input.pid),'-o','lstart=,args='],{encoding:'utf8'}); assert.equal(ps.status,0); const row=ps.stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/); assert.ok(row);
      process.stdout.write(JSON.stringify({pid:input.pid,startedAt:new Date(row[1]).toISOString(),runner:'main',runnerSessionId:input.pane,tmuxSession:input.name,evidence:{command:row[2],tmuxSocket:input.socket,tmuxPane:input.pane,machineId:boot.machineId,bootId:boot.bootId,runId:input.runId}}));
    } else if (input.op === 'secrets') {
      const { openSecretsStore } = await load(input.code, 'secrets-store');
      const secrets = await openSecretsStore({ home: input.home });
      await secrets.merge([{ name: 'CFC34_FIXTURE', kind: 'env', value: 'fixture-only-cfc34-secret-never-production', source: 'owned QA fixture', updatedAt: new Date().toISOString() }]);
      process.stdout.write('{"fixtureSecretInstalled":true}');
    } else if (input.op === 'system') {
      const { createProductionSystemDelivery } = await load(input.code, 'production-runtime');
      const catalog = read(path.join(input.code, 'dist/catalog.json'));
      const deliver = createProductionSystemDelivery(store, { orchestratorRoot: input.root, confRoot: path.join(input.root, 'conf'), artifactPath: path.join(input.code, 'dist/catalog.json'), statePath: input.state, tmpRoot: input.tmp, mode: 'test', commandStartedAtMs: performance.now(), resolveCaller: async () => undefined }, catalog);
      process.stdout.write(JSON.stringify(await deliver({ to: 'main', text: input.text }, { kind: 'system' })));
    }
  } finally { store.close(); }
} else {
  process.umask(0o077);
  const source = path.resolve(import.meta.dirname, '..');
  const only = process.argv.includes('--only-I6'), noTcp = process.argv.includes('--no-tcp');
  const output = path.resolve(process.argv[2]); fs.mkdirSync(output, { recursive: true });
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'c34-')), root = path.join(base, 'r'), home = path.join(base, 'h'), tmp = path.join(base, 't');
  for (const directory of [root, home, tmp, path.join(base, 'commands')]) fs.mkdirSync(directory, { recursive: true });
  const main = path.join(root, 'raf-main'), state = path.join(home, '.raf/state.sqlite'), bugs = path.join(home, '.raf/bugs.sqlite');
  const env = { PATH: process.env.PATH, HOME: home, RAF_QA_HOME: home, RAF_ORCHESTRATOR_ROOT: root, TMPDIR: tmp, TERM: 'xterm', TZ: 'UTC', LANG: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Background QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'Background QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid' };
  const summary = { assignment: 'complete-raf-flow-contracts:3.4', status: 'failed', base, root, home, state, bugs, output,
    command: [process.execPath, script, ...process.argv.slice(2)], versions: { node: process.version, os: os.release(), platform: process.platform, sqlite: db(':memory:', d => d.prepare('SELECT sqlite_version() AS version').get().version, false) }, scenarios: [], commands: [], cleanup: {}, limitations: ['Live tmux recipient is an owned stdin CLI receiver displaying configured Claude native-screen context and empty composer; this is a controlled screen fixture, not a real AI runner acceptance; no external AI provider credentials are copied or exercised.', 'Fixture service entry records origin and injects recovery/crash only for explicit fault scenarios; I6 uses default production ports without sharedDelivery injection.'] };
  const flush = () => atomic(path.join(output, 'summary.json'), summary);
  let sequence = 0, upstream, servicePid, upstreamErrors = '';
  summary.selection = process.argv.find(arg=>arg.startsWith('--scenarios='))?.slice(12).split(',') ?? (only ? ['I6'] : noTcp ? ['I1','I2','I3','I4','I5','I7'] : ['I1','I2','I3','I4','I5','I6','I7']);
  const sockets = [], processes = [];
  const run = (label, executable, args, cwd = root) => {
    const start = performance.now();
    const value = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 32000000 });
    const result = { command: [executable, ...args], cwd, cliExitCode: value.status, signal: value.signal, error: value.error?.message ?? null, durationMs: performance.now() - start, stdout: value.stdout ?? '', stderr: value.stderr ?? '' };
    for (const stream of ['stdout', 'stderr']) fs.writeFileSync(path.join(output, label + '.' + stream), result[stream]);
    atomic(path.join(output, label + '.json'), result); summary.commands.push({ label, evidence: label + '.json', cliExitCode: result.cliExitCode }); flush(); return result;
  };
  const must = value => { assert.equal(value.error, null, value.error); assert.equal(value.signal, null, value.stderr); assert.equal(value.cliExitCode, 0, value.stderr); return value.stdout.trim() ? JSON.parse(value.stdout) : null; };
  const git = (cwd, ...args) => { const r = run('setup-' + (++sequence), 'git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], cwd); assert.equal(r.cliExitCode, 0, r.stderr); return r.stdout.trim(); };
  const cli = (label, args, extra = {}) => { const old = { ...env }; Object.assign(env, extra); try { return run(label, process.execPath, [path.join(main, 'bin/raf.ts'), ...args], main); } finally { for (const key of Object.keys(env)) delete env[key]; Object.assign(env, old); } };
  const invoke = (label, data) => { const file = path.join(base, 'input-' + (++sequence) + '.json'); atomic(file, { code: main, root, state, home, tmp: path.join(home, '.raf/tmp'), ...data }); return must(run(label, process.execPath, [script, 'state', file])); };
  const sql = () => db(state, d => Object.fromEntries(['sessions', 'reminders', 'admission_reservations', 'task_reservation_runs', 'task_reservations', 'resource_wait_protocol_state'].filter(table => d.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table)).map(table => [table, d.prepare('SELECT * FROM ' + table).all()])));
  const notices = () => fs.existsSync(bugs) ? db(bugs, d => d.prepare('SELECT * FROM notices ORDER BY notice_key').all()) : [];
  const received = () => fs.existsSync(path.join(base, 'received.jsonl')) ? fs.readFileSync(path.join(base, 'received.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const scenario = async (id, action) => { if (!summary.selection.includes(id)) return; try { summary.scenarios.push({ id, status: 'passed', details: await action() }); } catch (error) { summary.scenarios.push({ id, status: 'failed', error: String(error), stack: error.stack }); } flush(); };
  const paneCommand = async (label, args, directory = path.join(base, 'commands')) => {
    atomic(path.join(directory, String(++sequence).padStart(4, '0') + '.json'), { label, args });
    const value = await wait(label, () => fs.existsSync(path.join(output, label + '.json')) && read(path.join(output, label + '.json')), 130000);
    summary.commands.push({ label, evidence: label + '.json', cliExitCode: value.cliExitCode }); flush(); return value;
  };
  const record = () => fs.existsSync(path.join(home,'.raf/service.json')) ? read(path.join(home, '.raf/service.json')) : null;
  const stop = () => { const result = must(cli('service-stop-' + (++sequence), ['service', 'stop'])); servicePid = undefined; return result; };
  const start = () => { const result = must(cli('service-start-' + (++sequence), ['service', 'start'])); servicePid = result.pid; return result; };
  try {
    summary.sha = git(source, 'rev-parse', 'HEAD'); summary.workspace = git(source, 'status', '--porcelain');
    summary.configurationFingerprints = Object.fromEntries(['raf.json', 'flow.json', 'projects.json', 'raf-constants.json', 'models.json', 'test-runs.json'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(source, '../conf', name))).digest('hex')]));
    for (const [exe, args] of [['git', ['--version']], ['tmux', ['-V']]]) { const r = run(exe + '-version', exe, args); assert.equal(r.cliExitCode, 0); summary.versions[exe] = r.stdout.trim(); }
    fs.cpSync(path.join(source, '../conf'), path.join(root, 'conf'), { recursive: true });
    const projects = read(path.join(root, 'conf/projects.json'));
    Object.assign(projects.projects.raf, { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop', hotfix: 'raf-hotfix' } }); delete projects.projects.raf.mainCopies;
    atomic(path.join(root, 'conf/projects.json'), projects);
    const settings = read(path.join(root, 'conf/raf.json'));
    settings.bugs.sections = [{ project: 'raf', env: 'qa', stand: 'qa', secret: 'CFC34_FIXTURE' }]; settings.bugs.pollIntervalMs = 500;
    settings.service.entryRelativePath = 'bin/qa-service.ts';
    const upstreamControl = path.join(base, 'upstream-control.json'); atomic(upstreamControl, { revision: 0, comment: null });
    if (!noTcp) {
    const key = path.join(base, 'tls.key'), cert = path.join(base, 'tls.crt');
    assert.equal(run('fixture-tls', 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']).cliExitCode, 0);
    env.NODE_EXTRA_CA_CERTS = cert;
    const upstreamReady = path.join(base, 'upstream-ready.json'), upstreamConfig = path.join(base, 'upstream.json');
    atomic(upstreamConfig, { key, cert, control: upstreamControl, log: path.join(output, 'upstream-requests.jsonl'), ready: upstreamReady });
    upstream = spawn(process.execPath, [script, 'upstream', upstreamConfig], { env, stdio: ['ignore', 'ignore', 'pipe'] }); processes.push(upstream);
    upstream.stderr.on('data', value => { upstreamErrors += value; });
    const address = await wait('fixture HTTPS upstream', () => fs.existsSync(upstreamReady) && read(upstreamReady)); settings.bugs.origin = 'https://127.0.0.1:' + address.port;
    } else { settings.bugs.origin = 'https://127.0.0.1:9'; summary.limitations.push('I6 excluded: sandbox TCP listen returns EACCES; no fixture credential installed, bug sync does not contact upstream.'); }
    atomic(path.join(root, 'conf/raf.json'), settings);
    fs.mkdirSync(main);
    const entries=git(source,'ls-tree','--name-only',summary.sha).split('\n').filter(name=>!['evidence','docs'].includes(name));
    const archive=path.join(base,'source.tar');const archiveResult=run('source-archive','git',['-C',source,'archive','--format=tar','--output='+archive,summary.sha,...entries]);assert.equal(archiveResult.cliExitCode,0,archiveResult.stderr);assert.equal(run('source-extract','tar',['-xf',archive,'-C',main]).cliExitCode,0);fs.unlinkSync(archive);
    summary.fixtureSource={method:'git archive of exact source SHA; own minimal repository',sha:summary.sha,excludedTrees:['evidence','docs'],entries};
    git(main,'init','-q','-b','main');git(main,'remote','add','origin',source);
    fs.cpSync(path.join(source, 'node_modules'), path.join(main, 'node_modules'), { recursive: true, dereference: true });
    const entry = `import {appendFileSync,readFileSync} from 'node:fs';\nimport {pathToFileURL} from 'node:url';\nimport {runServiceEntry} from '../src/service-entry.ts';\nconst mode=JSON.parse(readFileSync(${JSON.stringify(path.join(base, 'mode.json'))},'utf8')).mode;\nappendFileSync(${JSON.stringify(path.join(output, 'service-entry.jsonl'))},JSON.stringify({pid:process.pid,cwd:process.cwd(),entry:import.meta.url,mainPath:process.env.RAF_MAIN_PATH,mode})+'\\n');\nconst fault=mode==='gated'||mode==='recovery-fail';\nconst host=await runServiceEntry(fault?{loadPorts:async(file,context)=>{const ports=await(await import(pathToFileURL(file).href)).createServicePorts(context);return {...ports,recover:async value=>{if(mode==='recovery-fail')throw Error('CFC34 recovery failure');await new Promise(resolve=>setTimeout(resolve,120000));await ports.recover(value);}};}}:undefined);\nif(mode==='crash')setTimeout(()=>process.exit(17),500);\nawait host.closed;\n`;
    atomic(path.join(base, 'mode.json'), { mode: 'normal' }); fs.writeFileSync(path.join(main, 'bin/qa-service.ts'), entry);
    assert.equal(run('build', process.execPath, ['scripts/build.ts'], main).cliExitCode, 0);
    git(main, 'add', '--', ...entries, 'bin/qa-service.ts'); git(main, 'commit', '-m', 'qa: controlled background runtime stand entry'); summary.fixtureCommit = git(main, 'rev-parse', 'HEAD');
    git(root, 'init', '-q', '-b', 'main'); git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', './raf-main', 'raf-main'); git(root, 'submodule', 'absorbgitdirs');
    git(main, 'worktree', 'add', '-B', 'develop', path.join(root, 'raf-develop'), 'HEAD'); git(main, 'worktree', 'add', '-B', 'hotfix', path.join(root, 'raf-hotfix'), 'HEAD');
    for (const name of ['dist', 'node_modules']) for (const branch of ['develop', 'hotfix']) fs.cpSync(path.join(main, name), path.join(root, 'raf-' + branch, name), { recursive: true, dereference: true });
    git(root, 'add', '--', '.gitmodules', 'raf-main', 'conf'); git(root, 'commit', '-m', 'qa: isolated background orchestrator');
    summary.fixtureConfigurationFingerprints = Object.fromEntries(['raf.json', 'projects.json'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, 'conf', name))).digest('hex')]));
    invoke('prepare-production-store',{op:'prepare'});
    if (!noTcp) invoke('seed-fixture-secret', { op: 'secrets' });
    const socket = path.join(base, 'main.sock'), paneConfig = path.join(base, 'pane.json'); sockets.push(socket);
    atomic(paneConfig, { main, output, attach: true, commands: path.join(base, 'commands'), ready: path.join(base, 'main-ready.json'), received: path.join(base, 'received.jsonl') });
    must(run('tmux-main-start', 'tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'qa-main', '-x', '160', '-y', '40', process.execPath, script, 'pane', paneConfig]));
    await wait('main attach', () => fs.existsSync(path.join(output, 'main-attach.json'))); must(read(path.join(output, 'main-attach.json')));
    const workerSocket=path.join(base,'worker.sock'), workerCommands=path.join(base,'worker-commands'), workerConfig=path.join(base,'worker.json'); fs.mkdirSync(workerCommands); sockets.push(workerSocket);
    atomic(workerConfig,{main,output,attach:false,commands:workerCommands,ready:path.join(base,'worker-ready.json'),received:path.join(base,'worker-received.jsonl')});
    must(run('tmux-worker-start','tmux',['-S',workerSocket,'-f','/dev/null','new-session','-d','-s','qa-worker',process.execPath,script,'pane',workerConfig]));
    const worker=await wait('worker ready',()=>fs.existsSync(path.join(base,'worker-ready.json'))&&read(path.join(base,'worker-ready.json')));
    const pane=run('worker-pane','tmux',['-S',workerSocket,'display-message','-p','-t','qa-worker:0.0','#{pane_id}']).stdout.trim(), workerRun=randomUUID();
    const workerIdentity=invoke('worker-identity',{op:'identity',pid:worker.pid,socket:workerSocket,pane,name:'qa-worker',runId:workerRun});
    invoke('seed-worker',{op:'seed',reserve:true,sessions:[{runId:workerRun,addressId:'cfc34-worker',revision:0,state:'running',process:workerIdentity,activity:{type:'agent',project:'raf',features:[],phase:'qa',cwd:main}}]});
    await scenario('I1', async () => {
      const fresh = must(cli('fresh-status', ['service', 'status'])); assert.deepEqual([fresh.state, fresh.pid, fresh.mainPath, fresh.stopReason, fresh.reasonKnown], ['stopped', null, null, null, false]);
      const clients = [1, 2].map(index => {
        const args = [path.join(main, 'bin/raf.ts'), 'service', 'start']; const child = spawn(process.execPath, args, { cwd: main, env, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(child);
        let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
        return new Promise(resolve => child.on('close', (code, signal) => { const result = { command: [process.execPath, ...args], cliExitCode: code, signal, error: null, stdout, stderr }; atomic(path.join(output, 'concurrent-start-' + index + '.json'), result); resolve(result); }));
      });
      const [first, second] = (await Promise.all(clients)).map(must); servicePid = first.pid;
      assert.equal(first.pid, second.pid); assert.equal(first.serviceEpoch, second.serviceEpoch); assert.equal(first.state, 'ready'); assert.equal(first.mainPath, second.mainPath);
      const again = start(); assert.equal(again.pid, first.pid); assert.equal(again.mainPath, first.mainPath);
      const origin = fs.readFileSync(path.join(output, 'service-entry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); assert.equal(origin.length, 1); assert.equal(origin[0].cwd, first.mainPath); assert.equal(origin[0].mainPath, first.mainPath);
      assert.ok(fs.existsSync(state)); assert.ok(fs.existsSync(bugs)); assert.ok(db(state, d => d.prepare('SELECT * FROM resource_wait_protocol_state').get()));
      atomic(path.join(output, 'I1-origin.json'), { first, second, again, origin, record: record(), processCwd: fs.readlinkSync('/proc/' + first.pid + '/cwd'), sql: sql() });
      git(main, 'commit', '--allow-empty', '-m', 'qa: advance logical main while service pinned');
      const pinned = start(); assert.equal(pinned.pid, first.pid); assert.equal(pinned.mainPath, first.mainPath);
      return { pid: first.pid, epoch: first.serviceEpoch, mainPath: first.mainPath, evidence: 'I1-origin.json', logicalMainAdvancePreservedOwner: true };
    });
    await scenario('I3', async () => {
      must(await paneCommand('add-reminder', ['reminder', 'add', '--to', 'main', '--at', '2099-01-01T00:00:00Z', '--text', 'CFC34 preserved reminder']));
      const before = sql(); const pid = servicePid; const stopped = stop(); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.reasonKnown, true);
      const repeated = stop(); const status = must(cli('status-after-stop', ['service', 'status'])); assert.equal(status.state, 'stopped'); assert.deepEqual(status, repeated);
      const after = sql(); assert.deepEqual(after.sessions, before.sessions); assert.deepEqual(after.reminders, before.reminders); assert.ok(before.task_reservations.length); for(const table of ['task_reservation_runs','admission_reservations','task_reservations']) assert.deepEqual(after[table],before[table]); assert.ok(live(worker.pid));
      await wait('stopped service exit', () => !live(pid));
      atomic(path.join(output, 'I3-state.json'), { before, after, stopped, repeated, status, fixtureMainAlive: true }); return { evidence: 'I3-state.json', pidExited: pid };
    });
    await scenario('I4', async () => {
      atomic(path.join(base, 'mode.json'), { mode: 'crash' }); const known = start(); await wait('controlled crash', () => !live(known.pid));
      const crash = must(cli('known-crash-status', ['service', 'status'])); assert.equal(crash.state, 'failed'); assert.equal(crash.reasonKnown, true); assert.match(crash.stopReason, /17/); assert.equal(stop().stopReason, crash.stopReason);
      atomic(path.join(base, 'mode.json'), { mode: 'normal' }); const killed = start(); process.kill(killed.pid, 'SIGKILL'); await wait('SIGKILL own service', () => !live(killed.pid));
      const unknown = must(cli('unknown-crash-status', ['service', 'status'])); assert.equal(unknown.state, 'failed'); assert.equal(unknown.stopReason, null); assert.equal(unknown.reasonKnown, false); assert.equal(stop().state, 'failed');
      const diagnostic = fs.readFileSync(path.join(home, '.raf/service.json'), 'utf8'); fs.writeFileSync(path.join(home, '.raf/service.json'), '{invalid');
      const unreadable = cli('invalid-record-status', ['service', 'status']); assert.notEqual(unreadable.cliExitCode, 0); fs.writeFileSync(path.join(home, '.raf/service.json'), diagnostic);
      atomic(path.join(output, 'I4-diagnostics.json'), { known: crash, unknown, record: record(), unreadable }); return { evidence: 'I4-diagnostics.json' };
    });
    await scenario('I6', async () => {
      atomic(path.join(base, 'mode.json'), { mode: 'normal' }); start();
      await wait('initial snapshot complete', () => fs.existsSync(bugs) && db(bugs, d => d.prepare("SELECT * FROM sync_state WHERE phase='incremental'").get())); assert.deepEqual(notices(), []);
      atomic(upstreamControl, { revision: 1, comment: null });
      await wait('new bug notification', () => notices().some(row => row.noticed_at));
      await wait('main literal bug marker', () => received().some(row => row.text.includes('bug#3401')));
      const bug = notices(); const mainSession = sql().sessions.find(row => JSON.parse(row.payload).addressId === 'main'); assert.ok(mainSession);
      db(state, d => d.prepare('DELETE FROM sessions WHERE run_id=?').run(mainSession.run_id), false);
      atomic(upstreamControl, { revision: 2, comment: 'cfc34-comment-2' });
      await wait('undelivered human comment', () => notices().some(row => row.comment_server_id === 'cfc34-comment-2' && row.noticed_at === null));
      const pending = notices();
      db(state, d => d.prepare('INSERT INTO sessions(run_id,address_id,state,finished_at,payload) VALUES(?,?,?,?,?)').run(mainSession.run_id, mainSession.address_id, mainSession.state, mainSession.finished_at, mainSession.payload), false);
      await wait('retry accepted', () => notices().some(row => row.comment_server_id === 'cfc34-comment-2' && row.noticed_at !== null));
      await wait('main literal comment marker', () => received().some(row => row.text.includes('cfc34-comment-2')));
      atomic(upstreamControl, {revision:2,comment:'cfc34-comment-2',repeat:true});
      await delay(settings.bugs.pollIntervalMs * 4);
      atomic(upstreamControl, {revision:2,comment:'cfc34-comment-2',repeat:false});
      const texts = received().filter(row => /bug#3401|cfc34-comment-2/.test(row.text)); assert.equal(texts.length, 2); for (const value of texts) { assert.match(value.text, /^\[raf\] /); assert.ok(value.text.includes('projects/raf/bug#3401')); assert.equal(value.text.match(/\[raf\]/g).length, 1); }
      const delivered = notices(); stop(); atomic(path.join(output, 'I6-delivery.json'), { bug, pending, delivered, received: texts, upstreamErrors }); return { evidence: 'I6-delivery.json', defaultProductionDelivery: true };
    });
    await scenario('I7', async () => {
      stop(); const before = record(); const text = 'CFC34 system without service $(touch forbidden) `false`';
      const receipt = invoke('system-no-service', { op: 'system', text }); assert.equal(receipt.accepted, true);
      await wait('system marker consumed', () => received().some(row => row.text.includes(text)));
      assert.deepEqual(record(), before); const mainSent = must(await paneCommand('literal-main-prefix', ['agent', 'message', '--to', 'main', '--text', '[raf] [main] CFC34 literal prefix'],workerCommands)); assert.equal(mainSent.accepted, true);
      await wait('verified main marker', () => received().some(row => row.text.includes('CFC34 literal prefix')));
      const lines = received().filter(row => row.text.includes('CFC34')); assert.ok(lines.some(row => row.text === '[raf] ' + text)); assert.ok(lines.some(row => row.text.startsWith('[cfc34-worker] ') && row.text.includes('[raf] [main] CFC34 literal prefix')));
      atomic(path.join(output, 'I7-messages.json'), { receipt, mainSent, lines, serviceBefore: before, serviceAfter: record() }); return { evidence: 'I7-messages.json', verifiedOrdinaryAgent:'cfc34-worker', systemPassed: true };
    });
    await scenario('I5', async () => {
      atomic(path.join(base, 'mode.json'), { mode: 'normal' }); const first = start();
      const grant = must(cli('grant-before-restart', ['resource', 'wait', '--level', 'normal'])); const before = sql().resource_wait_protocol_state; stop(); const second = start(); const readyAt = performance.now();
      const next = must(cli('grant-after-restart', ['resource', 'wait', '--level', 'normal'])); const elapsed = performance.now() - readyAt;
      assert.ok(elapsed >= settings.resourceWait.grantIntervalMs); assert.notEqual(first.serviceEpoch, second.serviceEpoch); const after = sql().resource_wait_protocol_state;
      const args = [path.join(main, 'bin/raf.ts'), 'resource', 'wait', '--level', 'normal']; const client = spawn(process.execPath, args, { cwd: main, env, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(client);
      let stdout = '', stderr = ''; client.stdout.on('data', value => stdout += value); client.stderr.on('data', value => stderr += value); const exited = new Promise(resolve => client.on('close', (code, signal) => resolve({ cliExitCode: code, signal })));
      await delay(500); assert.equal(client.exitCode, null); stop(); const result = { ...(await exited), stdout, stderr, command: [process.execPath, ...args] }; assert.notEqual(result.cliExitCode, 0); assert.match(stdout + stderr, /service_stopped/);
      atomic(path.join(output, 'I5-grants.json'), { grant, next, before, after, elapsed, interval: settings.resourceWait.grantIntervalMs, abandoned: result }); return { evidence: 'I5-grants.json' };
    });
    await scenario('I5-channel', async () => {
      atomic(path.join(base,'mode.json'),{mode:'normal'});start();const grant=must(cli('channel-initial-grant',['resource','wait','--level','normal']));stop();const owner=start(), before=sql().resource_wait_protocol_state;
      const args=[path.join(main,'bin/raf.ts'),'resource','wait','--level','normal']; const client=spawn(process.execPath,args,{cwd:main,env,stdio:['ignore','pipe','pipe']}); processes.push(client);
      let stdout='',stderr=''; client.stdout.on('data',value=>stdout+=value);client.stderr.on('data',value=>stderr+=value);const exited=new Promise(resolve=>client.on('close',(code,signal)=>resolve({cliExitCode:code,signal})));
      await delay(5000);const pendingFds=fs.existsSync('/proc/'+client.pid+'/fd')?fs.readdirSync('/proc/'+client.pid+'/fd').flatMap(fd=>{try{return[fs.readlinkSync('/proc/'+client.pid+'/fd/'+fd)];}catch{return[];}}):[];
      atomic(path.join(output,'I5-channel-pending.json'),{owner,grant,before,pendingFds,clientExit:client.exitCode,stdout,stderr});assert.equal(client.exitCode,null);assert.ok(live(owner.pid));assert.ok(pendingFds.some(fd=>fd.startsWith('socket:')));
      process.kill(owner.pid,'SIGKILL'); await wait('killed own service',()=>!live(owner.pid));await wait('channel loss client exit',()=>client.exitCode!==null||client.signalCode!==null);const result={...(await exited),stdout,stderr,command:[process.execPath,...args]};atomic(path.join(output,'I5-channel-result.json'),result); assert.notEqual(result.cliExitCode,0);assert.equal(result.signal,null);assert.match(stdout+stderr,/connection.*lost|service_stopped/i);
      const abandoned=sql().resource_wait_protocol_state;assert.deepEqual(abandoned,before);const replacement=start();assert.notEqual(replacement.serviceEpoch,owner.serviceEpoch);assert.equal(client.exitCode,result.cliExitCode);assert.deepEqual(sql().resource_wait_protocol_state[0].grant_json,before[0].grant_json);stop();
      atomic(path.join(output,'I5-channel.json'),{owner,replacement,before,abandoned,result,pendingFds,noRevive:true});return{evidence:'I5-channel.json'};
    });
    await scenario('I2', async () => {
      stop(); const saved = { ...settings.service }; settings.service.entryRelativePath = 'bin/absent.ts'; atomic(path.join(root, 'conf/raf.json'), settings);
      const missing = cli('missing-entry', ['service', 'start']); assert.notEqual(missing.cliExitCode, 0); assert.match(missing.stderr, /entry|missing/i); settings.service = saved; atomic(path.join(root, 'conf/raf.json'), settings);
      atomic(path.join(base, 'mode.json'), { mode: 'recovery-fail' }); const recovery = cli('recovery-failure', ['service', 'start']); assert.notEqual(recovery.cliExitCode, 0); assert.match(recovery.stderr, /CFC34 recovery failure/);
      atomic(path.join(base, 'mode.json'), { mode: 'gated' }); const gated = cli('gated-readiness', ['service', 'start']); assert.notEqual(gated.cliExitCode, 0); assert.ok(gated.durationMs >= settings.service.readinessTimeoutMs - 1000);
      const gatedRecord = record(); if (live(gatedRecord.pid)) process.kill(gatedRecord.pid, 'SIGKILL'); await wait('gated cleanup', () => !live(gatedRecord.pid));
      atomic(path.join(base, 'mode.json'), { mode: 'normal' }); start(); stop();
      const projectFile=path.join(root,'conf/projects.json'), savedProjects=fs.readFileSync(projectFile,'utf8'); let missingMain;
      try { const altered=JSON.parse(savedProjects); altered.projects.raf.path='absent-main'; altered.projects.raf.branchPaths.main='absent-main'; atomic(projectFile,altered); missingMain=cli('missing-main',['service','start']); assert.notEqual(missingMain.cliExitCode,0); assert.ok(missingMain.stderr); } finally {fs.writeFileSync(projectFile,savedProjects);}
      const diagnosticFile=path.join(home,'.raf/service.json'), original=fs.readFileSync(diagnosticFile,'utf8'), socketFile=path.join(home,'.raf/service.sock');
      let stale, unverified, noEnqueue, noStop;
      try {
        fs.writeFileSync(socketFile,'CFC34 owned stale endpoint sentinel'); const inode=fs.statSync(socketFile).ino;
        stale=cli('stale-endpoint',['service','start']); assert.notEqual(stale.cliExitCode,0); assert.equal(fs.statSync(socketFile).ino,inode); assert.equal(fs.readFileSync(socketFile,'utf8'),'CFC34 owned stale endpoint sentinel');
        const forged={...JSON.parse(original),pid:worker.pid,state:'ready',stopReason:null}; delete forged.identity; atomic(diagnosticFile,forged);
        const before=sql().resource_wait_protocol_state;
        unverified=cli('unverifiable-owner',['service','start']); noEnqueue=cli('unverifiable-owner-resource',['resource','wait','--level','normal']); noStop=cli('unverifiable-owner-stop',['service','stop']);
        for(const result of [unverified,noEnqueue,noStop]) {assert.notEqual(result.cliExitCode,0); assert.match(result.stderr,/identity|owner/i); assert.ok(result.durationMs<settings.service.readinessTimeoutMs+5000);}
        assert.ok(live(worker.pid)); assert.deepEqual(record(),forged); assert.deepEqual(sql().resource_wait_protocol_state,before); assert.equal(fs.statSync(socketFile).ino,inode);
      } finally {fs.writeFileSync(diagnosticFile,original); if(fs.existsSync(socketFile))fs.unlinkSync(socketFile);}
      start(); stop(); atomic(path.join(output, 'I2-faults.json'), { missing, missingMain, recovery, gated, gatedRecord, stale, unverified, noEnqueue, noStop }); return { evidence: 'I2-faults.json', foreignOwnerPreserved:true, staleEndpointPreserved:true };
    });
  } catch (error) { summary.setupError = { message: String(error), stack: error.stack }; }
  finally {
    try { if (fs.existsSync(state)) stop(); } catch (error) { summary.cleanup.stopError = String(error); }
    try { const current = record(); if (live(current?.pid)) { process.kill(current.pid, 'SIGKILL'); await wait('own service cleanup', () => !live(current.pid)); } } catch (error) { if (error.code !== 'ENOENT') summary.cleanup.serviceError = String(error); }
    for (const socket of sockets) { const result = run('tmux-cleanup-' + (++sequence), 'tmux', ['-S', socket, 'kill-server']); if (result.cliExitCode !== 0) summary.cleanup.tmuxError = result.stderr; }
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) { const exit = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await exit; }
    const remainingOwned=()=>fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => { try { const cwd = fs.readlinkSync('/proc/' + name + '/cwd'); return cwd.startsWith(base + '/') && live(Number(name)) ? [{ pid: Number(name), cwd, command:fs.readFileSync('/proc/'+name+'/cmdline','utf8').replaceAll('\0',' ') }] : []; } catch { return []; } });
    try {await wait('owned process tree termination',()=>remainingOwned().length===0,5000);}catch(error){summary.cleanup.processExitError=String(error);}
    const remaining=remainingOwned();
    summary.cleanup.remaining = remaining; summary.cleanup.complete = remaining.length === 0 && !summary.cleanup.stopError && !summary.cleanup.serviceError && !summary.cleanup.tmuxError;
    if (fs.existsSync(path.join(home, '.raf/service.log'))) fs.copyFileSync(path.join(home, '.raf/service.log'), path.join(output, 'service.log'));
    fs.writeFileSync(path.join(output,'upstream.stderr'),upstreamErrors);
    for(const [key,action] of Object.entries({received,finalSql:()=>fs.existsSync(state)?sql():null,finalNotices:()=>fs.existsSync(bugs)?notices():null,finalBugState:()=>fs.existsSync(bugs)?db(bugs,d=>Object.fromEntries(['bugs','comments','sync_state'].map(table=>[table,d.prepare('SELECT * FROM '+table).all()]))):null})) {try{summary[key]=action();}catch(error){(summary.evidenceErrors??=[]).push({key,error:String(error)});}}

    summary.status = summary.scenarios.length === summary.selection.length && summary.scenarios.every(row => row.status === 'passed' && !row.details.remaining && !row.details.ordinaryAgent) && summary.cleanup.complete && !summary.setupError && !summary.evidenceErrors ? 'passed' : 'incomplete'; flush();
    fs.rmSync(base, { recursive: true, force: true }); summary.cleanup.fixtureRemoved = !fs.existsSync(base); flush();
  }
  console.log(JSON.stringify({ status: summary.status, evidence: path.join(output, 'summary.json'), scenarios: summary.scenarios.map(({ id, status, error }) => ({ id, status, error })), setupError: summary.setupError, cleanup: summary.cleanup }));
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}
