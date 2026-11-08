import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';
import { acquireHotfixReader } from '../src/hotfix-activation.ts';
import { mainRoute } from '../src/hotfix-host.ts';
import { capture, shellQuote } from './codex-command-output-fixture.ts';

const configuration = JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8'));

test('Claude delivers agent commands outside read-only activation control and replays exact results inside it', { skip: process.platform !== 'darwin' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'raf-claude-control-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'raf-main'), home = join(root, 'home'), runDirectory = join(root, 'run');
  for (const path of [main, home, runDirectory, join(root, 'conf')]) await mkdir(path);
  const environment = { ...process.env, HOME: home, RAF_QA_HOME: home, NODE_NO_WARNINGS: '1' };
  execFileSync('git', ['init', '-b', 'main', main], { env: environment, stdio: 'ignore' });
  execFileSync('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], { env: environment, stdio: 'ignore' });
  await writeFile(join(root, 'conf/projects.json'), JSON.stringify({ projects: { raf: { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-main' } } } }));
  await writeFile(join(root, 'conf/raf.json'), JSON.stringify(configuration));
  const host = { orchestratorRoot: root, qaHome: home, environment: {}, sandboxExecutable: 'unused' };
  const control = (await mainRoute(host)).control;
  await (await acquireHotfixReader(host, 'cli')).release();
  const command = join(root, 'raf.mjs');
  await writeFile(command, `import {acquireHotfixReader} from ${JSON.stringify(new URL('../src/hotfix-activation.ts', import.meta.url).href)};
const lease=await acquireHotfixReader(${JSON.stringify(host)},'cli');
try { process.stdout.write(JSON.stringify({argv:process.argv.slice(2),pinned:!!lease.id})+'\\n'); process.stderr.write('recipient detail\\n'); process.exitCode=17; } finally { await lease.release(); }`);
  const rafCommand = `${shellQuote(process.execPath)} ${shellQuote(command)}`;
  const issued = `${rafCommand} agent message`;
  const text = 'literal $() `command` Україна\nsecond line';
  const invocation = `${issued} --to main --text ${shellQuote(text)}`;
  const sandbox = ['-p', `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(control)}))`, '/bin/sh', '-c'];
  const denied = await capture('/usr/bin/sandbox-exec', [...sandbox, invocation], root, environment);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr.toString(), /EPERM/);
  assert.match(denied.stderr.toString(), /activation\.lock/);
  const existingHooks = [{ matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] }];
  const settings = {
    sandbox: { enabled: true, filesystem: { denyWrite: [control] } },
    hooks: { PreToolUse: existingHooks, SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'true' }] }] },
  };
  const request = { runner: 'claude' as const, invocation: { executable: 'claude', liveTaskVerified: true, args: ['--model', 'unchanged-model', '--settings', JSON.stringify(settings)] }, scope: { hidden: [], readable: [], tmuxDirectory: runDirectory, excludedCommands: [issued] }, cwd: root, runDirectory, environment };
  const prepared = await prepareCodexRafCommandAccess(request);
  t.after(() => prepared.cleanup());
  const actual = JSON.parse(prepared.invocation.args[prepared.invocation.args.indexOf('--settings') + 1]);
  assert.deepEqual(actual.sandbox, settings.sandbox);
  assert.deepEqual(actual.hooks.SessionStart, settings.hooks.SessionStart);
  assert.deepEqual(actual.hooks.PreToolUse.slice(0, -1), existingHooks);
  const hook = actual.hooks.PreToolUse?.find((entry: any) => entry.matcher === 'Bash')?.hooks[0];
  assert.ok(hook, 'Claude must install an unsandboxed PreToolUse transport before executing agent message');
  assert.equal(prepared.invocation.args[1], 'unchanged-model');
  const result = await capture('/bin/sh', ['-c', hook.command], root, prepared.environment, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: invocation } }));
  assert.equal(result.code, 0, result.stderr.toString());
  const replay = JSON.parse(result.stdout.toString()).hookSpecificOutput.updatedInput.command;
  assert.notEqual(replay, invocation);
  const delivered = await capture('/usr/bin/sandbox-exec', [...sandbox, replay], root, prepared.environment);
  assert.equal(delivered.code, 17, delivered.stderr.toString());
  assert.deepEqual(JSON.parse(delivered.stdout.toString()), { argv: ['agent', 'message', '--to', 'main', '--text', text], pinned: true });
  assert.equal(delivered.stderr.toString(), 'recipient detail\n');
  assert.deepEqual(await readdir(join(control, 'readers')), []);
  for (const rejected of [`${invocation}; id`, `${rafCommand} agent close --id peer`]) {
    const ignored = await capture('/bin/sh', ['-c', hook.command], root, prepared.environment, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: rejected } }));
    assert.deepEqual(JSON.parse(ignored.stdout.toString()), {});
  }
});
