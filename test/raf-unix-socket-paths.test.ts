import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { command, runCase, type CaseInput } from './raf-unix-socket-paths-fixture.ts';

const variants = ['short', 'long-run', 'long-tmpdir', 'long-both', 'long-home-tmproot', 'multibyte'] as const;
const endpoints = ['hotfix', 'wrapper', 'runtime-tmux', 'tool-tmux', 'quota-leader'] as const;
type Variant = typeof variants[number];
const processBefore = { cwd: process.cwd(), home: process.env.HOME, tmpdir: process.env.TMPDIR };
const orchestrationRoot = resolve(import.meta.dirname, '../..');

function abiLimit(): number {
  if (process.platform === 'linux') return 108;
  if (process.platform === 'darwin') return 104;
  throw new Error(`setup: no pathname sun_path ABI specified for ${process.platform}`);
}

async function budgetMs(): Promise<number> {
  const flow = JSON.parse(await readFile(join(orchestrationRoot, 'conf/flow.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(flow.unitTests.timeoutMs) && flow.unitTests.timeoutMs > 0, 'setup: valid conf/flow.json#/unitTests/timeoutMs required');
  return flow.unitTests.timeoutMs;
}

function longPath(root: string, label: string, multibyte = false): string {
  return multibyte ? join(root, label, 'ї'.repeat(30), 'ш'.repeat(20)) : join(root, label, 'a'.repeat(70), 'b'.repeat(70));
}

async function fixture(t: TestContext, variant: Variant, endpoint: CaseInput['endpoint'], action: CaseInput['action']) {
  const root = await mkdtemp('/tmp/z390-');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const home = variant === 'long-home-tmproot' ? longPath(root, 'home') : join(root, 'home');
  const runDirectory = ['long-run', 'long-both', 'multibyte'].includes(variant) ? longPath(root, 'run', variant === 'multibyte') : join(root, 'run');
  const tmpdir = ['long-tmpdir', 'long-both', 'multibyte'].includes(variant) ? longPath(root, 'tmp', variant === 'multibyte') : join(root, 'tmp');
  const tmpRoot = variant === 'long-home-tmproot' ? join(home, '.raf', 'tmp', 'generations', '13837be3-924d-4ed7-8c8e-0fce1e15bb79') : variant === 'multibyte' ? longPath(root, 'раф', true) : join(root, 'state-tmp');
  const workspace = join(root, 'workspace');
  await Promise.all([home, runDirectory, tmpdir, tmpRoot, workspace].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(home, 'state-sentinel'), 'unchanged state');
  const input: CaseInput = { root, home, runDirectory, tmpdir, tmpRoot, workspace, runId: `z390-${endpoint}-${variant}`, budgetMs: await budgetMs(), endpoint, action };
  const canonical = endpoint === 'hotfix' ? join(runDirectory, 'hotfix-commit.sock') : endpoint === 'wrapper' ? join(tmpdir, 'rw-control', 'h.sock') : endpoint === 'tool-tmux' ? join(runDirectory, `tmux-${process.getuid?.() ?? 0}`, 'default') : endpoint === 'runtime-tmux' ? join(tmpRoot, 'tmux/server.sock') : join(tmpRoot, 'quota/grok-owned/leader.sock');
  const applies = variant === 'multibyte' || (variant === 'long-home-tmproot' && ['runtime-tmux', 'quota-leader'].includes(endpoint)) || (['long-run', 'long-both'].includes(variant) && ['hotfix', 'tool-tmux'].includes(endpoint)) || (['long-tmpdir', 'long-both'].includes(variant) && endpoint === 'wrapper');
  if (applies) assert.ok(Buffer.byteLength(canonical) + 1 > abiLimit(), `fixture must really exceed sun_path: ${canonical}`);
  if (variant === 'multibyte' && endpoint === 'hotfix') {
    assert.ok(canonical.length + 1 <= abiLimit(), 'multibyte control must fit as characters while overflowing as bytes');
    assert.ok(Buffer.byteLength(canonical) > canonical.length, 'fixture must distinguish UTF-8 bytes from JS characters');
  }
  return { input, canonical, applies };
}

async function proof(t: TestContext, input: CaseInput) {
  const result = await runCase(input);
  t.diagnostic(JSON.stringify({ runId: input.runId, endpoint: input.endpoint, roots: { runDirectory: input.runDirectory, tmpdir: input.tmpdir, tmpRoot: input.tmpRoot, home: input.home }, result: { ok: result.ok, phase: result.phase, failureKind: result.failureKind, reason: result.reason, code: result.code, result: result.result, trace: result.trace } }));
  if (!result.ok && result.failureKind === 'setup') throw new Error(`setup/environment failure: ${result.reason}`);
  assert.equal(result.ok, true, `IPC behavior failed (${input.action}): ${result.reason ?? result.exit.stderr}`);
  assert.equal(result.exit.code, 0);
  const tracedIpc = (input.action === 'exchange' && !input.endpoint.endsWith('tmux')) || ['hotfix-ingress', 'wrapper-ingress', 'wrapper-reject', 'wrapper-peer'].includes(input.action);
  if (tracedIpc) {
    assert.ok(result.trace.some((event: { event: string }) => event.event === 'listen-ready'), 'real server listen must be observed');
    assert.ok(result.trace.some((event: { event: string }) => event.event === 'connect-ready'), 'real client connect must be observed');
  }
  for (const event of result.trace) {
    if (event.event === 'listen-ready' || event.event === 'connect-ready') bounded(event, event.event);
  }
  assert.equal(await readFile(join(input.home, 'state-sentinel'), 'utf8'), 'unchanged state');
  assert.deepEqual({ cwd: process.cwd(), home: process.env.HOME, tmpdir: process.env.TMPDIR }, processBefore);
  return result.result;
}

function bounded(scope: { address: string; cwd: string }, label: string) {
  assert.ok(scope.address.length > 0, `${label}: pathname required`);
  assert.ok(!scope.address.includes('\0'), `${label}: abstract socket is not a portable pathname`);
  assert.ok(isAbsolute(scope.cwd), `${label}: explicit absolute cwd required`);
  assert.ok(Buffer.byteLength(scope.address, 'utf8') + 1 <= abiLimit(), `${label}: actual address must fit bytes INCLUDING NUL: ${Buffer.byteLength(scope.address) + 1}/${abiLimit()}`);
}

test('[Z390 control] real short Unix listen connect and payload', async t => {
  const { input } = await fixture(t, 'short', 'hotfix', 'exchange');
  const path = join(input.root, 'control.sock');
  const server = createServer(socket => socket.end('short-control'));
  server.listen(path);
  await once(server, 'listening');
  try {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    let payload = '';
    socket.on('data', chunk => { payload += chunk; });
    await once(socket, 'close');
    assert.equal(payload, 'short-control');
    bounded({ address: path, cwd: input.workspace }, 'short control');
  } finally { await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())); }
});

test('[Z390 control] real private tmux is available', async t => {
  const { input } = await fixture(t, 'short', 'runtime-tmux', 'exchange');
  const socket = join(input.root, 'control-tmux.sock');
  const env = { ...process.env, HOME: input.home, TMPDIR: input.tmpdir, TMUX: '', TMUX_PANE: '' };
  try {
    const start = await command('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'control', 'cat'], { cwd: input.workspace, env });
    assert.equal(start.code, 0, `setup: tmux unavailable: ${start.stderr}`);
    const live = await command('tmux', ['-S', socket, 'list-sessions', '-F', '#{session_name}'], { cwd: input.workspace, env });
    assert.equal(live.code, 0, live.stderr);
    assert.match(live.stdout, /control/);
  } finally { await command('tmux', ['-S', socket, 'kill-server'], { cwd: input.workspace, env }); }
});

for (const endpoint of endpoints) for (const variant of variants) {
  test(`[Z390 endpoint ${endpoint}] ${variant}: real listen connect payload and owned cleanup`, async t => {
    const { input } = await fixture(t, variant, endpoint, 'exchange');
    const result = await proof(t, input);
    bounded(result.endpoint.bind, 'bind');
    bounded(result.endpoint.connect, 'connect');
    assert.equal(result.endpoint.connect.cwd, input.workspace, 'client workspace must survive endpoint compaction');
    for (const fact of result.facts) {
      assert.equal(fact.uid, process.getuid?.(), 'compact resource must belong to current uid');
      assert.equal(fact.mode & 0o077, 0, 'compact routing resources must have private parents');
    }
    assert.ok(result.cleanup.every((entry: { absent: boolean }) => entry.absent), 'owned aliases/helpers must be gone');
    if (endpoint.endsWith('tmux')) {
      assert.ok(result.response.capture.includes(`z390:${input.runId}:дані`));
      assert.ok(result.response.commands.some((entry: { args: string[] }) => entry.args[0] === 'capture-pane'));
      assert.ok(result.response.commands.some((entry: { args: string[] }) => entry.args[0] === 'list-sessions'));
      for (const entry of result.response.commands) {
        bounded(entry, `tmux ${entry.args[0]}`);
        assert.equal(entry.code, 0, `tmux ${entry.args[0]} must succeed, including cleanup`);
      }
    } else assert.equal(result.response.payload, `z390:${input.runId}:дані`);
  });
}

for (const endpoint of endpoints) {
  test(`[Z390 ownership ${endpoint}] two concurrent runIds preserve cwd env and surviving peer`, async t => {
    const { input } = await fixture(t, 'long-both', endpoint, 'concurrent');
    const result = await proof(t, input);
    bounded(result.a, 'run A');
    bounded(result.b, 'run B');
    assert.notEqual(resolve(result.a.cwd, result.a.address), resolve(result.b.cwd, result.b.address), 'distinct runIds must not share a live endpoint');
    bounded(result.shared, 'shared runtime');
    assert.equal(result.sharedRuntimeAlive, true);
    assert.equal(result.stillAlive, true);
    assert.equal(result.isolated, true);
  });
  test(`[Z390 ownership ${endpoint}] setup and connect failure retain foreign resources`, async t => {
    const { input } = await fixture(t, 'multibyte', endpoint, 'failures');
    const result = await proof(t, input);
    assert.match(result.connectError, /ENOENT|ECONNREFUSED/);
    assert.ok(result.setupError);
    assert.equal(result.foreignAlive, true);
    assert.ok(result.cleanup.every((entry: { absent: boolean }) => entry.absent));
  });
}

for (const variant of variants) {
  test(`[Z390 hotfix ingress] ${variant}: generated client commits only own paths from hotfix cwd`, async t => {
    const { input } = await fixture(t, variant, 'hotfix', 'hotfix-ingress');
    const result = await proof(t, input);
    assert.equal(result.committed, true);
    assert.equal(result.gitBoundaries, true);
    assert.equal(result.workspace, join(input.root, 'orchestrator/raf-hotfix'));
  });
  test(`[Z390 wrapper ingress] ${variant}: real parent child handshake preserves report and identity`, async t => {
    const { input } = await fixture(t, variant, 'wrapper', 'wrapper-ingress');
    const result = await proof(t, input);
    assert.equal(result.ready, true);
    assert.equal(result.launch.runId, input.runId);
    assert.equal(result.capture.request.tmpRoot, input.tmpRoot);
  });
}

test('[Z390 wrapper ingress] another process cannot consume an inherited handshake request', async t => {
  const { input } = await fixture(t, 'long-tmpdir', 'wrapper', 'wrapper-peer');
  const result = await proof(t, input);
  assert.equal(result.capture.peerRejected, true);
  assert.equal(result.ready, true);
});

test('[Z390 wrapper ingress] forged handshake identity is refused', async t => {
  const { input } = await fixture(t, 'long-both', 'wrapper', 'wrapper-reject');
  const result = await proof(t, input);
  assert.equal(result.rejected, true);
});

for (const variant of ['short', 'long-run', 'long-both', 'multibyte'] as const) {
  test(`[Z390 sandbox ingress] ${variant}: own tool tmux payload while registered socket and state stay denied`, async t => {
    const { input } = await fixture(t, variant, 'tool-tmux', 'sandbox-ingress');
    const result = await proof(t, input);
    assert.equal(result.prepared, true);
    assert.equal(result.ownTmux, true);
    assert.equal(result.hostDenied, true);
    assert.equal(result.aliasDenied, true);
    assert.equal(result.stateWriteDenied, true);
    assert.equal(result.actualSockets.length, 2);
    for (const address of result.actualSockets) bounded({ address, cwd: input.workspace }, 'sandbox tmux actual endpoint');
    assert.equal(result.stateDenied, true);
    assert.equal(result.tmuxInherited, false);
  });
}
