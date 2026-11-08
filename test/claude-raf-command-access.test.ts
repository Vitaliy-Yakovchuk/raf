import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';

async function run(command: string, environment: NodeJS.ProcessEnv, input = '') {
  const child = spawn('/bin/sh', ['-c', command], { env: environment });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

test('Claude agent message executes outside read-only control and replays once inside sandbox', async t => {
  const root = await mkdtemp('/tmp/raf-claude-channel-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = join(root, 'control');
  await mkdir(control);
  const entry = join(root, 'raf.mjs');
  const guard = join(root, 'read-only.mjs');
  const count = join(root, 'deliveries');
  await writeFile(entry, `import {mkdir,appendFile} from 'node:fs/promises';
await mkdir(${JSON.stringify(join(control, 'activation.lock.owner-fixture'))});
await appendFile(${JSON.stringify(count)}, 'delivered\\n');
process.stdout.write('receipt\\n'); process.stderr.write('diagnostic\\n'); process.exitCode=7;`);
  await writeFile(guard, `import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const mkdir=fs.mkdir.bind(fs);
fs.mkdir=async (path,...args)=>{
 if(String(path).startsWith(${JSON.stringify(control)})) throw Object.assign(new Error('EPERM read-only control'),{code:'EPERM'});
 return mkdir(path,...args);
}; syncBuiltinESMExports();`);
  const command = `${process.execPath} ${entry} agent message --to main --text 'fixture'`;
  const environment = { ...process.env, HOME: root, RAF_QA_HOME: root };
  const sandboxEnvironment = { ...environment, NODE_OPTIONS: `--import=${guard}` };
  const direct = await run(command, sandboxEnvironment);
  assert.notEqual(direct.code, 0);
  assert.match(direct.stderr, /EPERM read-only control/, direct.stderr);
  const request = {
    runner: 'claude' as const,
    invocation: { executable: 'claude', args: ['--settings', JSON.stringify({ sandbox: { enabled: true }, hooks: { Stop: [] } })], liveTaskVerified: false },
    scope: { hidden: [], readable: [], tmuxDirectory: root, excludedCommands: [`${process.execPath} ${entry} agent message:*`] },
    cwd: root, runDirectory: root, environment,
  };
  const prepared = await prepareCodexRafCommandAccess(request);
  t.after(() => prepared.cleanup());
  const settings = JSON.parse(prepared.invocation.args[1]);
  assert.equal(settings.sandbox.enabled, true);
  assert.deepEqual(settings.hooks.Stop, []);
  const hook = settings.hooks.PreToolUse?.find((item: any) => item.matcher === 'Bash')?.hooks[0];
  assert.ok(hook, 'Claude requires an unsandboxed PreToolUse command channel');
  const captured = await run(hook.command, { ...environment, ...prepared.environment }, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }));
  assert.equal(captured.code, 0, captured.stderr);
  const response = JSON.parse(captured.stdout).hookSpecificOutput;
  assert.equal(response.permissionDecision, 'allow');
  const replay = await run(response.updatedInput.command, { ...sandboxEnvironment, ...prepared.environment, NODE_OPTIONS: sandboxEnvironment.NODE_OPTIONS });
  assert.equal(replay.code, 7, replay.stderr);
  assert.equal(replay.stdout, 'receipt\n');
  assert.equal(replay.stderr, 'diagnostic\n');
  assert.equal(await readFile(count, 'utf8'), 'delivered\n');
  const repeated = await run(response.updatedInput.command, sandboxEnvironment);
  assert.notEqual(repeated.code, 0);
  assert.equal(await readFile(count, 'utf8'), 'delivered\n');
  for (const rejected of [`${command}; echo injected`, `${process.execPath} ${entry} agent ps`]) {
    const result = await run(hook.command, { ...environment, ...prepared.environment }, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: rejected } }));
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
});
