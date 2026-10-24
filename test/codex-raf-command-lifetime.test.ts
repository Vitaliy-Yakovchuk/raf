import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { prepareCodexRafCommandAccess, type PreparedCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';
import { hookCommand, outputFixture, outputTimeout } from './codex-command-output-fixture.ts';

const options = { timeout: outputTimeout };
type Fixture = Awaited<ReturnType<typeof outputFixture>>;

async function effectiveHook(f: Fixture, prepared: PreparedCodexRafCommandAccess): Promise<any> {
  const configuration: string[] = [];
  for (let i = 0; i < prepared.invocation.args.length; i++) {
    if (['-c', '--config'].includes(prepared.invocation.args[i])) configuration.push('-c', prepared.invocation.args[++i]);
  }
  const child = spawn(prepared.invocation.executable, [...configuration, 'app-server', '--listen', 'stdio://'], {
    cwd: f.cwd, env: prepared.environment, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture hooks/list did not finish')), outputTimeout);
      const finish = (error?: Error, value?: any) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once('error', finish);
      child.once('exit', () => finish(new Error('fixture app-server exited before hooks/list')));
      lines.on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.error) return finish(new Error(JSON.stringify(message.error)));
          if (message.id === 1) {
            child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [f.cwd] } }) + '\n');
          } else if (message.id === 2) {
            const entries = message.result.data;
            assert.deepEqual(entries.flatMap((entry: any) => entry.errors), []);
            const hooks = entries.flatMap((entry: any) => entry.hooks).filter((hook: any) => hook.command === hookCommand(prepared));
            assert.equal(hooks.length, 1);
            finish(undefined, hooks[0]);
          }
        } catch (error) { finish(error as Error); }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'raf-lifetime-fixture', version: '1' }, capabilities: { experimentalApi: true } } }) + '\n');
    });
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

test('[codex-command-lifetime] queued admission beyond the execution budget preserves the hook and wrapper owner', options, async t => {
  const f = await outputFixture(t);
  f.request.scope.excludedCommands.push(`${f.rafCommand} test run`);
  const gate = join(f.root, 'admitted');
  const owner = join(f.root, 'owner.json');
  await writeFile(f.commandPath, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(owner)}, JSON.stringify({pid:process.pid}));\n` + await readFile(f.commandPath, 'utf8'));
  const stdout = Buffer.from('{"runId":"queued-owner","outcome":"passed"}\n');
  const stderr = Buffer.from('admission granted\n');
  await f.configure(stdout, stderr, 0, gate);
  const prepared = await f.prepare();
  const definition = await effectiveHook(f, prepared);
  assert.equal(definition.enabled, true);
  assert.equal(definition.trustStatus, 'trusted');
  assert.equal(definition.async, false);
  assert.ok(Number.isSafeInteger(definition.timeoutSec) && definition.timeoutSec > 0);
  const command = `${f.rafCommand} test run --project raf --phase hotfix --group add-raf-test-run/lifetime-fixture`;
  const hook = spawn('/bin/sh', ['-c', hookCommand(prepared)], {
    cwd: f.cwd, env: prepared.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [], err: Buffer[] = [];
  hook.stdout.on('data', chunk => out.push(Buffer.from(chunk)));
  hook.stderr.on('data', chunk => err.push(Buffer.from(chunk)));
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    hook.once('error', reject);
    hook.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    hook.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }));
    while (!(await f.calls()).length) await delay(10);
    const pid = JSON.parse(await readFile(owner, 'utf8')).pid;
    const queuedForMs = BigInt(outputTimeout) * 2n;
    const hookDeadlineMs = BigInt(definition.timeoutSec) * 1000n;
    let timedOut = false;
    if (queuedForMs >= hookDeadlineMs) {
      timedOut = true;
      process.kill(-hook.pid!, 'SIGKILL');
      await completed;
    }
    assert.equal(timedOut, false, `Codex would kill the hook process group (wrapper pid ${pid}) after ${definition.timeoutSec}s while admission still waits`);
    const state = await readFile(`/proc/${pid}/stat`, 'utf8');
    assert.ok(!['Z', 'X'].includes(state.slice(state.lastIndexOf(')') + 2).split(' ')[0]), 'the original wrapper owner remains alive');
    await writeFile(gate, 'release');
    assert.deepEqual(await completed, { code: 0, signal: null }, Buffer.concat(err).toString());
    const response = JSON.parse(Buffer.concat(out).toString());
    const replay = response.hookSpecificOutput?.updatedInput?.command;
    assert.equal(typeof replay, 'string', 'the original command must be replaced with its result reader');
    assert.notEqual(replay, command);
    const result = await f.replay(prepared, replay);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, stdout);
    assert.deepEqual(result.stderr, stderr);
    assert.equal((await f.calls()).length, 1, 'waiting and result delivery cannot start another wrapper');
  } finally {
    await writeFile(gate, 'release');
    try { process.kill(-hook.pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await completed;
  }
});

test('[codex-command-lifetime] unavailable hook protocol refuses launch before the original RAF command can enter the sandbox', options, async t => {
  const f = await outputFixture(t);
  const executable = join(f.root, 'no-hooks');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await assert.rejects(async () => {
    const prepared = await prepareCodexRafCommandAccess({ ...f.request, invocation: { ...f.request.invocation, executable } });
    try {
      assert.equal(prepared.invocation.args.includes('--sandbox'), true);
      assert.equal(prepared.invocation.args.some(arg => arg.startsWith('hooks.PreToolUse=')), false);
    } finally { await prepared.cleanup(); }
  }, /RAF command channel unavailable.*(?:refus|sandbox)/iu);
  assert.deepEqual(await f.calls(), []);
});

test('[codex-command-lifetime] inspection rejects an effective hook deadline that can kill the pending wrapper', options, async t => {
  const f = await outputFixture(t);
  const executable = join(f.root, 'unsafe-hooks');
  await writeFile(executable, `#!${process.execPath}
import {createInterface} from 'node:readline';
const config=process.argv.find(arg=>arg.startsWith('hooks.PreToolUse='));
const command=JSON.parse(config.match(/\\bcommand\\s*=\\s*("(?:\\\\.|[^"\\\\])*")/)[1]);
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 if(request.id===1)console.log(JSON.stringify({id:1,result:{}}));
 if(request.id===2)console.log(JSON.stringify({id:2,result:{data:[{hooks:[{source:'sessionFlags',eventName:'preToolUse',command,key:'raf',currentHash:'fixture',timeoutSec:1,async:false}]}]}}));
}
`, { mode: 0o700 });
  await assert.rejects(async () => {
    const prepared = await prepareCodexRafCommandAccess({ ...f.request, invocation: { ...f.request.invocation, executable } });
    await prepared.cleanup();
  }, /hook.*(?:timeout|deadline|lifetime)/iu);
  assert.deepEqual(await f.calls(), []);
});
