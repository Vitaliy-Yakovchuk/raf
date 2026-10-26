import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

const timeoutMs = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8')).unitTests.timeoutMs as number;
const fixtureUrl = new URL('./production-fixture.ts', import.meta.url).href;

type Mode = 'setup-failed' | 'body-failed' | 'passed';
type Recorded = { socket?: string; pid?: number };

function runConsumer(t: TestContext, mode: Mode): void {
  const scratch = mkdtempSync(join(tmpdir(), 'l6-'));
  const tracked = join(scratch, 'roots.jsonl');
  const recordPath = join(scratch, 'record.json');
  const script = join(scratch, 'group.test.mjs');
  const roots = (): string[] => existsSync(tracked) ? readFileSync(tracked, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string) : [];
  const recorded = (): Recorded => existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) as Recorded : {};
  t.after(() => {
    const record = recorded();
    if (record.socket) spawnSync('tmux', ['-S', record.socket, 'kill-server'], { encoding: 'utf8' });
    if (record.pid) {
      try { process.kill(record.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    for (const path of roots()) rmSync(path, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });
  writeFileSync(script, String.raw`import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { fixture } from ${JSON.stringify(fixtureUrl)};
const mode = ${JSON.stringify(mode)};
const allocate = fsp.mkdtemp;
fsp.mkdtemp = async (...args) => {
  const path = await allocate(...args);
  fs.appendFileSync(${JSON.stringify(tracked)}, JSON.stringify(path) + '\n');
  return path;
};
if (mode === 'setup-failed') {
  const real = childProcess.spawnSync;
  childProcess.spawnSync = (executable, args, ...rest) => {
    if (executable === 'which' && Array.isArray(args) && args[0] === 'tmux') return { status: 1, stdout: '', stderr: 'L6 intentional setup failure\n' };
    return real(executable, args, ...rest);
  };
}
syncBuiltinESMExports();
test('production fixture consumer', async t => {
  const created = await fixture(t);
  const session = childProcess.spawnSync(created.realTmuxPath, ['-S', created.socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'l6', process.execPath, '-e', 'setInterval(() => {}, 1000)'], { encoding: 'utf8' });
  assert.equal(session.status, 0, session.stderr);
  const record = { socket: created.socket, pid: undefined };
  if (mode === 'body-failed') {
    const owned = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    owned.unref();
    created.trackProcess(owned.pid);
    record.pid = owned.pid;
  }
  fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record));
  if (mode === 'body-failed') assert.fail('L6 intentional body failure');
});
`);
  const environment: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-isolation=none', '--test-reporter=tap', script], {
    env: environment, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, mode === 'passed' ? 0 : 1, child.stdout + child.stderr);
  if (mode === 'setup-failed') assert.match(child.stdout + child.stderr, /L6 intentional setup failure/);
  if (mode === 'body-failed') assert.match(child.stdout + child.stderr, /L6 intentional body failure/);
  const allocated = roots();
  assert.equal(allocated.length, 1, 'the nested group must allocate one production fixture root');
  assert.deepEqual(allocated.filter(path => existsSync(path)), [], 'completed production fixture group must remove its temp root even when the test fails');
  assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('raf-prod-')), [], 'the nested group must leave no raf-prod directories');
  const record = recorded();
  if (mode !== 'setup-failed') assert.equal(typeof record.socket, 'string', 'consumer must record the owned tmux socket');
  if (record.socket) {
    const listed = spawnSync('tmux', ['-S', record.socket, 'list-sessions'], { encoding: 'utf8' });
    assert.notEqual(listed.status, 0, `owned tmux server must be gone after the fixture group\n${listed.stdout}`);
  }
  if (mode === 'body-failed') assert.equal(typeof record.pid, 'number', 'consumer must record the owned process');
  if (record.pid) {
    let alive = true;
    try { process.kill(record.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      alive = false;
    }
    assert.equal(alive, false, `owned process ${record.pid} must be gone after the fixture group`);
  }
}

for (const mode of ['setup-failed', 'body-failed', 'passed'] as const) {
  test(`[L6] production fixture cleanup survives ${mode}`, { timeout: timeoutMs }, t => {
    runConsumer(t, mode);
  });
}
