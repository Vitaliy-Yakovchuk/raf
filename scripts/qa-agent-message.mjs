import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const source = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[2]);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
if (process.argv[3] !== 'child') {
  fs.mkdirSync(output, { recursive: true });
  const base = fs.mkdtempSync('/tmp/cfc24-');
  for (const dir of ['home', 'tmp', 'root']) fs.mkdirSync(path.join(base, dir));
  fs.cpSync(path.join(source, '../conf'), path.join(base, 'root/conf'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: path.join(base, 'home'), RAF_QA_HOME: path.join(base, 'home'),
    TMPDIR: path.join(base, 'tmp'), TERM: 'xterm-256color', LANG: 'C.UTF-8', TZ: 'UTC', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const commands = [];
  const run = (name, command, args, timeout = 30000) => {
    const result = spawnSync(command, args, { cwd: source, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    fs.writeFileSync(path.join(output, name + '.stdout'), result.stdout ?? '');
    fs.writeFileSync(path.join(output, name + '.stderr'), result.stderr ?? '');
    commands.push({ name, command: [command, ...args], cwd: source, cliExitCode: result.status, signal: result.signal,
      error: result.error?.message ?? null, stdout: name + '.stdout', stderr: name + '.stderr' });
    return result;
  };
  const sha = run('sha', 'git', ['rev-parse', 'HEAD']).stdout.trim();
  const workspace = run('workspace', 'git', ['status', '--porcelain']).stdout;
  const diff = run('diff', 'git', ['diff', '--', 'src/production-runtime.ts', 'test/agent-adapters-contract.test.ts']).stdout;
  const hashes = Object.fromEntries(['src/message-delivery.ts', 'src/production-runtime.ts', 'test/agent-adapters-contract.test.ts', 'scripts/qa-agent-message.mjs']
    .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex')]));
  const build = run('build', process.execPath, ['scripts/build.ts']);
  for (const cli of ['tmux', 'codex', 'grok', 'agy', 'claude']) run(cli + '-version', cli, [cli === 'tmux' ? '-V' : '--version'], 10000);
  const child = build.status === 0 ? run('stand', process.execPath, [import.meta.filename, output, 'child', base], 60000) : null;
  write(path.join(output, 'stand.json'), { assignment: 'complete-raf-flow-contracts:2.4', base, sha, workspace, diff, hashes,
    env: { HOME: env.HOME, RAF_QA_HOME: env.RAF_QA_HOME, TMPDIR: env.TMPDIR }, commands, passed: child?.status === 0,
    limitations: ['Controlled native-screen fixture, not a real AI runner acceptance.', 'Production services with built catalog; not public compiled agent run/report integration.',
      'No credentials copied into stand. Real runner versions alone do not close L1-L3.', 'Automated integration preset/file not present; no authorized test run attempted.'] });
  process.exitCode = child?.status === 0 ? 0 : 1;
} else {
  const base = process.argv[4], root = path.join(base, 'root'), tmp = path.join(base, 'tmp');
  const db = path.join(base, 'state.sqlite'), socket = path.join(base, 'tmux.sock');
  const mode = path.join(base, 'mode'), log = path.join(base, 'received.jsonl'), receiver = path.join(base, 'receiver.mjs');
  fs.writeFileSync(mode, 'accept');
  fs.writeFileSync(receiver, `import fs from 'node:fs';
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
let input='', current='', serial=0, prev='';
const draw=()=>{const mode=fs.readFileSync(process.argv[2],'utf8');if(mode!==prev){input=mode==='foreign'?'other draft':'';prev=mode;}
process.stdout.write('\\x1b[?2004h\\x1b[2J\\x1b[H'+(mode==='shell'?'shell':'agent ready')+' '+mode+' '+serial+'\\n$ '+input);};
process.stdin.on('data',chunk=>{current+=chunk;current=current.replace(/\\x1b\\[(200|201)~/g,'');
for(const char of current){if(char==='\\r'||char==='\\n'){if(prev==='accept'){fs.appendFileSync(process.argv[3],JSON.stringify(input)+'\\n');input='';serial++;}}else input+=char;}current='';draw();});
setInterval(draw,30);draw();`);
  const tmux = args => { const r = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const results = [];
  let store;
  let pid;
  try {
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'recipient', '-x', '160', '-y', '30', process.execPath, receiver, mode, log]);
    const [pane, pidText] = tmux(['display-message', '-p', '-t', 'recipient:0.0', '#{pane_id}|#{pane_pid}']).trim().split('|'); pid = Number(pidText);
    const capture = () => tmux(['capture-pane', '-p', '-t', pane]);
    for (let n = 0; !capture().includes('agent ready') && n < 100; n++) await delay(20);
    const { readWaitIdentity } = await import('../src/resource-wait-identity.ts');
    const boot = await readWaitIdentity(pid);
    const row = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'args='], { encoding: 'utf8' }).stdout.trim();
    const match = row.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/); assert.ok(match);
    const identity = { pid, startedAt: new Date(match[1]).toISOString(), runner: 'main', runnerSessionId: pane, tmuxSession: 'recipient',
      evidence: { command: match[2], tmuxSocket: socket, tmuxPane: pane, machineId: boot.machineId, bootId: boot.bootId } };
    const { openStateStore } = await import('../src/state-store.ts'); store = openStateStore(db);
    store.sessionRepository.transaction(tx => tx.putSession({ runId: randomUUID(), addressId: 'main', state: 'running', revision: 0, process: identity }));
    const catalog = JSON.parse(fs.readFileSync(path.join(source, 'dist/catalog.json')));
    const { readConfiguration } = await import('../src/production-entry.ts');
    const { createProductionServices, rafSystemCaller } = await import('../src/production-runtime.ts');
    const protocolSettings = JSON.parse(fs.readFileSync(path.join(root, 'conf/raf.json'))).runnerProtocols;
    const claude = protocolSettings.find(row => row.runner === 'claude');
    claude.markers = { ready: ['agent ready'] }; claude.native.composer = '^\\$(?:\\s|$)'; claude.timeouts.transitionMs = 300; claude.timeouts.pollMs = 20;
    const services = await createProductionServices(store, { catalog, ...readConfiguration(root, catalog) }, {
      orchestratorRoot: root, confRoot: path.join(root, 'conf'), artifactPath: path.join(source, 'dist/catalog.json'), statePath: db, tmpRoot: tmp,
      mode: 'test', commandStartedAtMs: Date.now(), resolveCaller: async () => undefined,
    }, { protocolSettings });
    const message = text => services.control.message({ to: 'main', text }, rafSystemCaller);
    const change = async value => { fs.writeFileSync(mode, value); await delay(80); };
    const literal = 'literal $(touch ' + path.join(base, 'forbidden') + ') `false` "quoted" 🧪';
    const accepted = await message(literal); assert.equal(accepted.accepted, true);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), ['[raf] ' + literal]); assert.equal(fs.existsSync(path.join(base, 'forbidden')), false);
    results.push({ id: 'accepted-literal-main', receipt: accepted, screen: capture(), identity });
    for (const value of ['hold', 'foreign', 'shell']) {
      await change(value); const before = capture(); let error;
      try { await message('must not silently succeed'); } catch (caught) { error = String(caught); }
      assert.ok(error); const after = capture(); if (value !== 'hold') assert.equal(after, before);
      results.push({ id: value, error, before, after });
    }
    await change('hold');
    const concurrent = await Promise.allSettled([message('parallel one'), message('parallel two')]);
    assert.ok(concurrent.every(row => row.status === 'rejected'));
    assert.ok(concurrent.some(row => String(row.reason).includes('Another delivery')));
    results.push({ id: 'concurrent-delivery', results: concurrent.map(row => ({ status: row.status, reason: String(row.reason) })), screen: capture() });
    write(path.join(output, 'scenarios.json'), { results, sqlite: store.startupContextDatabase.prepare('SELECT sqlite_version() AS version').get(), identity });
  } finally {
    store?.close();
    const stop = spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8' });
    for (let n = 0; pid && fs.existsSync('/proc/' + pid + '/stat') && !/\) [ZX] /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')) && n < 100; n++) await delay(20);
    const remaining = pid && fs.existsSync('/proc/' + pid + '/stat') && !/\) [ZX] /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'));
    write(path.join(output, 'cleanup.json'), { cliExitCode: stop.status, stderr: stop.stderr, remainingPids: remaining ? [pid] : [], complete: stop.status === 0 && !remaining });
    assert.equal(remaining, false);
  }
}
