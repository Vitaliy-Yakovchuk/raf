import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { digest, filesBelow, outputFixture, outputTimeout, shellQuote } from './codex-command-output-fixture.ts';

const options = { timeout: outputTimeout };
const marker = 'Z101-PAYLOAD-NEVER-IN-ARGV-OR-ENV';
function payload(size: number, suffix: string): Buffer {
  const unit = Buffer.from(`${marker}: Україна ' " $() \`backticks\` ; | & > < \\ \n`);
  return Buffer.concat([Buffer.concat(Array.from({ length: Math.ceil(size / unit.length) }, () => unit)), Buffer.from(`\n${suffix}\n\n`)]);
}
function requireReplay(result: Awaited<ReturnType<Awaited<ReturnType<typeof outputFixture>>['hook']>>): string {
  assert.equal(result.result.code, 0, `hook failed: ${result.result.stderr}`);
  assert.equal(result.response?.hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal(typeof result.replay, 'string', 'allowed command must yield a replay');
  return result.replay!;
}
async function absent(path: string): Promise<boolean> {
  try { await access(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

test('[codex-command-output] real hook and spawned replay carry >=1 MiB without payload in argv/env', options, async t => {
  const f = await outputFixture(t, { instrumentation: true });
  const prepared = await f.prepare();
  await f.configure(Buffer.from('small\n'));
  const smallReplay = requireReplay(await f.hook(prepared));
  assert.equal((await f.replay(prepared, smallReplay)).code, 0);
  const large = payload(1024 * 1024, 'Z101-LARGE-TAIL');
  assert.ok(large.length >= 1024 * 1024);
  await f.configure(large);
  const replay = requireReplay(await f.hook(prepared));
  const result = await f.replay(prepared, replay);
  assert.equal(result.code, 0, result.stderr.toString());
  assert.equal(result.signal, null);
  assert.equal(result.stdout.length, large.length);
  assert.equal(digest(result.stdout), digest(large));
  assert.ok(result.stdout.subarray(-64).includes(Buffer.from('Z101-LARGE-TAIL\n\n')));
  assert.equal(result.stderr.length, 0);
  assert.ok(Buffer.byteLength(replay) <= Buffer.byteLength(smallReplay) + 256, 'replay size must be independent of payload size');
  assert.ok(!replay.includes(marker));
  const traces = [...f.traces, ...(await readFile(f.tracePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))];
  assert.ok(traces.length >= 4, 'host hook and actual replay spawns must be observed');
  for (const trace of traces) assert.ok(!JSON.stringify(trace).includes(marker), 'payload must not cross argv/env in any observed process');
});

test('[codex-command-output] exact large stdout/stderr, UTF-8, metacharacters, trailing newlines and code 17', options, async t => {
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  const sentinel = join(f.root, 'SHELL-MUST-NOT-EXECUTE');
  const dangerous = Buffer.from(`\n$(touch ${shellQuote(sentinel)})\n\`touch ${shellQuote(sentinel)}\`\n'"; exit 0; #\n\n`);
  const stdout = Buffer.concat([payload(256 * 1024, 'STDOUT-END'), dangerous]);
  const stderr = Buffer.concat([payload(256 * 1024, 'STDERR-END'), dangerous]);
  assert.ok(stdout.length > 128 * 1024 && stderr.length > 128 * 1024);
  await f.configure(stdout, stderr, 17);
  const replay = requireReplay(await f.hook(prepared));
  const result = await f.replay(prepared, replay);
  assert.equal(result.code, 17);
  assert.deepEqual(result.stdout, stdout);
  assert.deepEqual(result.stderr, stderr);
  assert.equal(await absent(sentinel), true, 'output is data, including substitutions and backticks');
  assert.equal((await f.calls()).length, 1, 'nonzero raf result must not trigger a second raf execution');
});

for (const [stdout, stderr, code] of [[Buffer.alloc(0), Buffer.alloc(0), 0], [Buffer.from('\n\n'), Buffer.alloc(0), 17], [Buffer.alloc(0), Buffer.from('помилка\n\n'), 17]] as const) {
  test(`[codex-command-output] empty stream fidelity ${stdout.length}/${stderr.length}/${code}`, options, async t => {
    const f = await outputFixture(t);
    const prepared = await f.prepare();
    await f.configure(stdout, stderr, code);
    const result = await f.replay(prepared, requireReplay(await f.hook(prepared)));
    assert.equal(result.code, code);
    assert.deepEqual(result.stdout, stdout);
    assert.deepEqual(result.stderr, stderr);
  });
}

test('[codex-command-output] production agent ps preserves every visible running session through hook/replay', options, async t => {
  const f = await outputFixture(t, { production: true });
  const control = await f.hostPs();
  assert.equal(control.code, 0, control.stderr.toString());
  assert.ok(control.stdout.length > 128 * 1024, `production fixture too small: ${control.stdout.length}`);
  const expected = JSON.parse(control.stdout.toString());
  const ids = JSON.stringify(expected);
  assert.equal(f.runIds.length, 512);
  for (const runId of f.runIds) assert.ok(ids.includes(runId), `${runId} must survive production reconciliation`);
  assert.ok(!ids.includes('z101-finished-must-stay-hidden'), 'fixture must use the production running-only filter');
  const prepared = await f.prepare();
  const replay = requireReplay(await f.hook(prepared));
  const result = await f.replay(prepared, replay);
  assert.equal(result.code, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), expected);
  assert.deepEqual(result.stdout, control.stdout, 'quiet isolated fixture must match host bytes');
  assert.deepEqual(result.stderr, control.stderr);
  assert.ok(!replay.includes(f.runIds.at(-1)!));
  assert.ok(result.stdout.includes(Buffer.from(f.runIds.at(-1)!)));
});

test('[codex-command-output] parallel results in one and two runs never mix or delete a peer result', options, async t => {
  const f = await outputFixture(t);
  const first = await f.prepare(), second = await f.prepare(join(f.cwd, 'run-other'));
  const firstBaseline = await filesBelow(f.runDirectory);
  const secondDirectory = join(f.cwd, 'run-other');
  const secondBaseline = await filesBelow(secondDirectory);
  const entries = ['same-A', 'same-B', 'other-C'];
  const outputs = entries.map(key => payload(256 * 1024, `${key}-TAIL`));
  for (let i = 0; i < entries.length; i++) await f.configure(outputs[i], Buffer.from(entries[i] + '\n\n'), i === 1 ? 17 : 0, undefined, entries[i]);
  const hooks = await Promise.all(entries.map((key, index) => f.hook(index === 2 ? second : first, `${f.rafCommand} agent message --to main --text ${shellQuote(key)}`)));
  const replays = hooks.map(requireReplay);
  const firstResult = await f.replay(first, replays[0]);
  assert.deepEqual(firstResult.stdout, outputs[0]);
  const results = await Promise.all([f.replay(first, replays[1]), f.replay(second, replays[2])]);
  for (let i = 0; i < results.length; i++) {
    assert.deepEqual(results[i].stdout, outputs[i + 1]);
    assert.deepEqual(results[i].stderr, Buffer.from(entries[i + 1] + '\n\n'));
    assert.equal(results[i].code, i === 0 ? 17 : 0);
  }
  assert.deepEqual(await filesBelow(f.runDirectory), firstBaseline, 'consumed call files must be removed');
  assert.deepEqual(await filesBelow(secondDirectory), secondBaseline);
  assert.equal((await f.calls()).length, 3, 'each message is delivered exactly once');
  const pending = requireReplay(await f.hook(second, `${f.rafCommand} agent message --to main --text 'other-C'`));
  await first.cleanup(); await first.cleanup();
  assert.deepEqual((await f.replay(second, pending)).stdout, outputs[2], 'run cleanup cannot delete another run result');
  await second.cleanup(); await second.cleanup();
});

test('[codex-command-output] unavailable raf executable reports spawn failure, cleans up and never retries message', options, async t => {
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  const baseline = await filesBelow(f.runDirectory);
  await rename(f.commandPath, `${f.commandPath}.disabled`);
  const hook = await f.hook(prepared, `${f.rafCommand} agent message --to main --text 'one delivery only'`);
  const result = hook.replay ? await f.replay(prepared, hook.replay) : hook.result;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr.toString(), /ENOENT|MODULE_NOT_FOUND|spawn|not found|cannot find/i);
  assert.equal((await f.calls()).length, 0);
  assert.deepEqual(await filesBelow(f.runDirectory), baseline);
  await prepared.cleanup(); await prepared.cleanup();
});

test('[codex-command-output] true executable spawn failure is nonzero with a concrete reason', options, async t => {
  const f = await outputFixture(t, { rafExecutable: 'raf-z101-missing-executable' });
  const prepared = await f.prepare();
  const baseline = await filesBelow(f.runDirectory);
  const hook = await f.hook(prepared, `${f.rafCommand} agent message --to main --text 'spawn'`);
  const result = hook.replay ? await f.replay(prepared, hook.replay) : hook.result;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr.toString(), /spawn|ENOENT|not found/i);
  assert.equal((await f.calls()).length, 0);
  assert.deepEqual(await filesBelow(f.runDirectory), baseline);
  await prepared.cleanup(); await prepared.cleanup();
});

test('[codex-command-output] result read failure cannot become success or repeat agent message', options, async t => {
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  const baseline = await filesBelow(f.runDirectory);
  const stdout = payload(256 * 1024, 'READ-FAILURE');
  await f.configure(stdout);
  const replay = requireReplay(await f.hook(prepared, `${f.rafCommand} agent message --to main --text 'once'`));
  const artifacts = (await filesBelow(f.runDirectory)).filter(path => !baseline.includes(path));
  let damaged = false;
  for (const path of artifacts) {
    if ((await readFile(path)).equals(stdout)) { await rm(path); damaged = true; break; }
  }
  assert.ok(damaged, 'file transport must expose its own captured data, rather than embedding it in replay');
  const result = await f.replay(prepared, replay);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr.toString(), /ENOENT|read|missing|result|transport/i);
  assert.equal((await f.calls()).length, 1, 'read failure cannot redeliver a message');
  await prepared.cleanup(); await prepared.cleanup();
  assert.deepEqual(await filesBelow(f.runDirectory), []);
});

test('[codex-command-output] result write failure is explicit and does not run a message twice', options, async t => {
  assert.notEqual(process.getuid?.(), 0, 'permission-fault fixture requires an unprivileged user');
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  await f.configure(payload(256 * 1024, 'WRITE-FAILURE'));
  await f.replay(prepared, requireReplay(await f.hook(prepared)));
  const baseline = await filesBelow(f.runDirectory);
  const directories = [...new Set([f.runDirectory, ...baseline.map(path => dirname(path))])];
  for (const directory of directories) await chmod(directory, 0o500);
  const callsBefore = (await f.calls()).length;
  try {
    const hook = await f.hook(prepared, `${f.rafCommand} agent message --to main --text 'once'`);
    const result = hook.replay ? await f.replay(prepared, hook.replay) : hook.result;
    assert.notEqual(result.code, 0, 'failed result creation must not report success');
    assert.match(result.stderr.toString(), /EACCES|EPERM|read.only|write|directory|result|transport/i);
    assert.ok((await f.calls()).length - callsBefore <= 1);
  } finally {
    for (const directory of directories) await chmod(directory, 0o700);
  }
  await prepared.cleanup(); await prepared.cleanup();
  assert.deepEqual(await filesBelow(f.runDirectory), []);
});

test('[codex-command-output] abandoned replay is removed by idempotent run cleanup', options, async t => {
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  const baseline = await filesBelow(f.runDirectory);
  await f.configure(payload(1024 * 1024, 'ABANDONED'));
  requireReplay(await f.hook(prepared));
  assert.ok((await filesBelow(f.runDirectory)).some(path => !baseline.includes(path)), 'pending output must be held outside argv/env');
  await prepared.cleanup(); await prepared.cleanup();
  assert.deepEqual(await filesBelow(f.runDirectory), []);
  assert.equal((await f.calls()).length, 1);
});

test('[codex-command-output] symlink and host-code tampering cannot redirect result writes or execute on host', options, async t => {
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  await f.configure(payload(256 * 1024, 'SYMLINK'));
  const stateBefore = await readFile(f.statePath);
  const secret = join(f.stateDirectory, 'secrets.json'), secretBefore = await readFile(secret);
  const baseline = await filesBelow(f.runDirectory);
  requireReplay(await f.hook(prepared));
  const artifacts = (await filesBelow(f.runDirectory)).filter(path => !baseline.includes(path));
  assert.ok(artifacts.length > 0);
  for (const path of artifacts) { await rm(path); await symlink(secret, path); }
  const target = join(f.root, 'HOST-CODE-MUST-NOT-EXECUTE');
  for (const path of baseline.filter(path => /\.(?:[cm]?js|ts)$/.test(path))) {
    await chmod(path, 0o600);
    await writeFile(path, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(target)},'pwned');process.exit(0);`);
  }
  const hook = await f.hook(prepared);
  if (hook.replay) {
    const result = await f.replay(prepared, hook.replay);
    assert.ok(!result.stdout.includes(Buffer.from('Z101-HIDDEN-SECRET')));
  }
  assert.equal(await absent(target), true, 'host hook cannot load agent-writable modules');
  assert.deepEqual(await readFile(secret), secretBefore);
  assert.deepEqual(await readFile(f.statePath), stateBefore);
  await prepared.cleanup(); await prepared.cleanup();
  assert.deepEqual(await readFile(secret), secretBefore, 'cleanup must unlink own symlinks without following them');
});

test('[codex-command-output] X.1 allowlist denies compound requests without host execution', options, async t => {
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  await f.configure(Buffer.from('delivered exactly once\n'));
  const command = `${f.rafCommand} agent message --to main --text 'literal text'`;
  const baseline = await filesBelow(f.runDirectory);
  for (const denied of [
    `${f.rafCommand} agent run --id injected`, `${f.rafCommand} agent close --id main`,
    `RAF_PREFIX=1 ${command}`, `${command} && ${f.rafCommand} agent ps`, `${command} | cat`,
    `${command} > ${shellQuote(join(f.runDirectory, 'redirect'))}`, `${command}; true`,
    `${f.rafCommand} agent message --to main --text "$(echo injected)"`,
    `${f.rafCommand} agent message --to main --text \`echo injected\``,
  ]) {
    const result = await f.hook(prepared, denied);
    assert.equal(result.result.code, 0);
    assert.equal(result.replay, undefined, denied);
    assert.equal(result.response?.hookSpecificOutput?.permissionDecision, undefined, 'denied requests must receive no host permission');
  }
  assert.equal((await f.calls()).length, 0);
  assert.deepEqual(await filesBelow(f.runDirectory), baseline);
  const result = await f.replay(prepared, requireReplay(await f.hook(prepared, command)));
  assert.equal(result.code, 0);
  assert.deepEqual(await f.calls(), [['agent', 'message', '--to', 'main', '--text', 'literal text']]);
  assert.equal(await readFile(join(f.codexHome, 'config.toml'), 'utf8'), f.configText);
  for (const value of ['--model', 'gpt-6.1-sol', 'model_reasoning_effort="high"']) {
    if (f.request.invocation.args.includes(value)) assert.ok(prepared.invocation.args.includes(value));
  }
  assert.ok(!prepared.invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!prepared.invocation.args.includes('danger-full-access'));
});


test('[codex-command-output] cleanup preserves an active replay and interrupted replay leaves no artifacts', options, async t => {
  const f = await outputFixture(t);
  const prepared = await f.prepare();
  const stdout = payload(8 * 1024 * 1024, 'ACTIVE-TAIL');
  const stderr = payload(256 * 1024, 'ACTIVE-ERROR-TAIL');
  await f.configure(stdout, stderr, 17);
  const command = requireReplay(await f.hook(prepared));
  const child = spawn('/bin/sh', ['-c', command], { cwd: f.cwd, env: prepared.environment, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const timer = setTimeout(() => child.kill('SIGKILL'), outputTimeout);
  t.after(() => clearTimeout(timer));
  const errors: Buffer[] = [];
  child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
  const closed = once(child, 'close');
  await Promise.race([
    once(child.stdout, 'readable'),
    closed.then(() => assert.fail('replay exited before producing output')),
  ]);
  await prepared.cleanup();
  const chunks: Buffer[] = [];
  child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
  child.stdout.resume();
  const [code, signal] = await closed;
  clearTimeout(timer);
  assert.equal(code, 17);
  assert.equal(signal, null);
  assert.deepEqual(Buffer.concat(chunks), stdout);
  assert.deepEqual(Buffer.concat(errors), stderr);
  await prepared.cleanup();
  assert.deepEqual(await filesBelow(f.runDirectory), []);

  const nextDirectory = join(f.cwd, 'run-interrupted');
  const next = await f.prepare(nextDirectory);
  await f.configure(stdout);
  const interrupted = spawn('/bin/sh', ['-c', requireReplay(await f.hook(next))], { cwd: f.cwd, env: next.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(interrupted, 'close');
  const interruptTimer = setTimeout(() => { if (interrupted.pid) { try { process.kill(-interrupted.pid, 'SIGKILL'); } catch {} } }, outputTimeout);
  t.after(() => clearTimeout(interruptTimer));
  t.after(() => { if (interrupted.exitCode === null && interrupted.pid) { try { process.kill(-interrupted.pid, 'SIGKILL'); } catch {} } });
  await Promise.race([
    once(interrupted.stdout, 'readable'),
    exited.then(() => assert.fail('fixture replay must still be active when interrupted')),
  ]);
  assert.ok(interrupted.pid);
  process.kill(-interrupted.pid, 'SIGKILL');
  const [interruptedCode, interruptedSignal] = await exited;
  clearTimeout(interruptTimer);
  assert.equal(interruptedCode, null);
  assert.equal(interruptedSignal, 'SIGKILL');
  await next.cleanup(); await next.cleanup();
  assert.deepEqual(await filesBelow(nextDirectory), []);
  assert.equal((await f.calls()).length, 2, 'cleanup and interrupted replay must never retry the raf operation');
});
