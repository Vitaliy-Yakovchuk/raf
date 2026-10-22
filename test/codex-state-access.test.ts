import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';
import type { PreparedCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';
import { buildRunnerInvocation, nativeSandboxArgs } from '../src/runner-protocols.ts';
import type { ProtocolSettings } from '../src/runner-protocols.ts';

const confRoot = fileURLToPath(new URL('../../conf/', import.meta.url));
const rafConfiguration = JSON.parse(await readFile(join(confRoot, 'raf.json'), 'utf8'));
const flowConfiguration = JSON.parse(await readFile(join(confRoot, 'flow.json'), 'utf8'));
const timeout = flowConfiguration.unitTests.timeoutMs;
const settings: ProtocolSettings = rafConfiguration.runnerProtocols.find(
  (entry: ProtocolSettings) => entry.runner === 'codex',
);
assert.ok(settings, 'the configured codex protocol is required');

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function execute(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function fixture(channelEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'raf-codex-state-access-'));
  const cwd = join(root, 'workspace');
  const runDirectory = join(cwd, 'run');
  const home = join(root, 'home');
  const codexHome = join(root, 'codex-home');
  const stateDirectory = join(home, '.raf');
  const statePath = join(stateDirectory, rafConfiguration.state.fileName);
  await Promise.all([cwd, runDirectory, codexHome, stateDirectory].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(codexHome, 'config.toml'), 'sandbox_mode = "workspace-write"\n');
  const database = new DatabaseSync(statePath);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE deliveries(text TEXT); CREATE TABLE calls(command TEXT);');
  const commandPath = join(root, 'raf-command-fixture.mjs');
  await writeFile(commandPath, `
import { DatabaseSync } from 'node:sqlite';
const args = process.argv.slice(2);
const database = new DatabaseSync(${JSON.stringify(statePath)});
database.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
database.prepare('INSERT INTO calls VALUES (?)').run(args.join(' '));
if (args[0] === 'agent' && args[1] === 'message') {
  if (args[2] !== '--to' || args[3] !== 'main' || args[4] !== '--text') throw new Error('invalid fixture argv');
  database.prepare('INSERT INTO deliveries VALUES (?)').run(args[5]);
  database.exec('COMMIT');
  console.log(JSON.stringify({ delivered: true, text: args[5] }));
} else if (args[0] === 'agent' && args[1] === 'ps') {
  database.exec('COMMIT');
  console.log(JSON.stringify({ agents: ['main', 'sender'] }));
} else {
  database.exec('COMMIT');
  console.log('FORBIDDEN_COMMAND_EXECUTED');
}
database.close();
`);
  const rafCommand = `${quote(process.execPath)} ${quote(commandPath)}`;
  const invocation = buildRunnerInvocation(settings, { model: 'gpt-6.1-sol', effort: 'high' });
  const scope = {
    hidden: [stateDirectory],
    readable: [],
    tmuxDirectory: join(runDirectory, 'tmux'),
    excludedCommands: channelEnabled ? [`${rafCommand} agent message`, `${rafCommand} agent ps`] : [],
  };
  const environment = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: runDirectory,
    LANG: 'C.UTF-8',
  };
  return {
    root, cwd, runDirectory, home, codexHome, database, statePath, commandPath, rafCommand, environment,
    request: {
      invocation: { ...invocation, args: nativeSandboxArgs(settings, invocation.args, scope) },
      scope, cwd, runDirectory, environment,
    },
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

test('[codex-state-access] preparing the channel preserves sandbox, selection and user config', { timeout }, async t => {
  const f = await fixture();
  let prepared: PreparedCodexRafCommandAccess | undefined;
  t.after(async () => {
    try { await prepared?.cleanup(); } finally { await f.cleanup(); }
  });
  const originalConfiguration = await readFile(join(f.codexHome, 'config.toml'), 'utf8');
  const before = structuredClone(f.request);
  prepared = await prepareCodexRafCommandAccess(f.request);
  assert.deepEqual(f.request, before, 'preparing access must not mutate caller-owned inputs');
  assert.equal(prepared.environment.HOME, f.home);
  assert.equal(prepared.environment.CODEX_HOME, f.codexHome);
  const args = prepared.invocation.args;
  assert.equal(prepared.invocation.executable, f.request.invocation.executable);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never');
  for (const flag of [settings.modelFlag, settings.effortFlag]) {
    const index = f.request.invocation.args.indexOf(flag);
    assert.equal(args[args.indexOf(flag) + 1], f.request.invocation.args[index + 1]);
  }
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('danger-full-access'));
  assert.equal(await readFile(join(f.codexHome, 'config.toml'), 'utf8'), originalConfiguration);
  await prepared.cleanup();
  await prepared.cleanup();
  assert.equal(await readFile(join(f.codexHome, 'config.toml'), 'utf8'), originalConfiguration);
  assert.deepEqual(f.database.prepare('SELECT * FROM calls').all(), []);
});

type ToolOutput = { call_id: string; output: unknown };

const shellToolNames = ['exec_command', 'shell_command', 'shell'];

function flattenTools(tools: readonly any[]): any[] {
  return tools.flatMap((tool: any) => tool.type === 'namespace' ? flattenTools(tool.tools ?? []) : [tool]);
}

function shellCall(body: any, callId: string, index: number, command: string): object {
  const direct = flattenTools(body.tools ?? []).find((entry: any) => shellToolNames.includes(entry.name));
  if (direct) {
    return {
      id: `fc_${index}`, type: 'function_call', status: 'completed', call_id: callId,
      name: direct.name,
      arguments: JSON.stringify(direct.name === 'shell'
        ? { command: ['bash', '-c', command] }
        : direct.name === 'shell_command'
          ? { command, login: false }
          : { cmd: command, login: false, yield_time_ms: 10000 }),
    };
  }
  const additional = (body.input ?? []).filter((input: any) => input.type === 'additional_tools').flatMap((input: any) => flattenTools(input.tools ?? []));
  const exec = additional.find((entry: any) => entry.type === 'custom' && entry.name === 'exec');
  assert.ok(exec, 'the installed Codex must expose a shell execution tool');
  const nested = ['exec_command', 'shell_command'].find(name => String(exec.description).includes(`${name}(`));
  assert.ok(nested, 'the code-mode exec tool must expose a nested shell execution tool');
  const args = nested === 'exec_command'
    ? { cmd: command, login: false, yield_time_ms: 10000 }
    : { command, login: false };
  return {
    id: `ct_${index}`, type: 'custom_tool_call', status: 'completed', call_id: callId, name: exec.name,
    input: `const r = await tools.${nested}(${JSON.stringify(args)}); text(typeof r === 'string' ? r : \`exit_code: \${r.exit_code}\\n\${r.output}\`);`,
  };
}

function outputText(output: ToolOutput | undefined): string {
  const value = output?.output;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part: any) => typeof part?.text === 'string' ? part.text : JSON.stringify(part)).join('\n');
  return JSON.stringify(value);
}

async function scriptedProvider(commands: readonly string[]) {
  const outputs = new Map<string, ToolOutput>();
  const issued = new Set<string>();
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for (const input of body.input ?? []) {
        if (input.type === 'function_call_output' || input.type === 'custom_tool_call_output') outputs.set(input.call_id, input);
      }
      const index = outputs.size;
      const callId = `x1-call-${index}`;
      const item = index < commands.length ? shellCall(body, callId, index, commands[index]) : {
        id: 'msg_done', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'X.1 protocol fixture complete', annotations: [] }],
      };
      if (index < commands.length) issued.add(callId);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const emit = (type: string, extra: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      const envelope = { id: `resp_${index}`, object: 'response', model: body.model, status: 'in_progress', output: [] };
      emit('response.created', { response: envelope });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: { ...envelope, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    } catch (error) {
      failures.push(String(error));
      response.writeHead(500).end('scripted provider failed');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/v1`, outputs, issued, failures,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

for (const channelEnabled of [true, false]) {
  test(`[codex-state-access] native Codex with channel ${channelEnabled ? 'enabled' : 'absent'} enforces SQLite access`, { timeout }, async t => {
    const f = await fixture(channelEnabled);
    let prepared: PreparedCodexRafCommandAccess | undefined;
    let provider: Awaited<ReturnType<typeof scriptedProvider>> | undefined;
    t.after(async () => {
      try {
        await provider?.close();
      } finally {
        try { await prepared?.cleanup(); } finally { await f.cleanup(); }
      }
    });
    const direct = `${quote(process.execPath)} -e ${quote(`const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(f.statePath)}); db.exec("INSERT INTO calls VALUES ('DIRECT_WRITE_EXECUTED')");`)}`;
    const message = `${f.rafCommand} agent message --to main --text 'X.1 delivered from Codex'`;
    const commands = [
      direct,
      message,
      `${f.rafCommand} agent ps`,
      `${f.rafCommand} agent close --id main`,
      `${f.rafCommand} agent run --id intruder`,
      `RAF_X1=1 ${message}`,
      `${message} > ${quote(join(f.runDirectory, 'redirected'))}`,
      `${message} && ${f.rafCommand} agent ps`,
      `${message} | cat`,
      `${f.rafCommand} agent message --to main --text "$(echo substitution)"`,
      `${f.rafCommand} agent message --to main --text \`echo backtick\``,
      direct,
    ];
    prepared = await prepareCodexRafCommandAccess(f.request);
    provider = await scriptedProvider(commands);
    const args = [
      ...prepared.invocation.args,
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c', 'features.plugins=false',
      '-c', 'model_provider="raf_x1_fixture"',
      '-c', `model_providers.raf_x1_fixture={name="X.1 local fixture",base_url=${JSON.stringify(provider.url)},wire_api="responses",requires_openai_auth=false}`,
      'exec', '--json', '--ephemeral', '--skip-git-repo-check',
      'Execute the supplied protocol fixture tool calls.',
    ];
    const result = await execute(prepared.invocation.executable, args, f.cwd, prepared.environment);
    assert.deepEqual(provider.failures, [], 'scripted API failures are fixture failures');
    assert.equal(result.code, 0, `native Codex failed: ${result.stderr}\n${result.stdout}`);
    assert.equal(provider.issued.size, commands.length);
    assert.equal(provider.outputs.size, commands.length, 'every native tool result must reach the scripted API');
    const output = (index: number) => outputText(provider!.outputs.get(`x1-call-${index}`));
    if (channelEnabled) {
      assert.match(output(1), /(?:exit_code|Process exited with code|code)[^\d]*0/, 'agent message must exit 0 through the native tool');
      assert.match(output(1), /X\.1 delivered from Codex/);
      assert.match(output(2), /(?:exit_code|Process exited with code|code)[^\d]*0/, 'agent ps initializes state and must exit 0');
      assert.match(output(2), /sender/);
      for (const index of [0, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
        assert.doesNotMatch(output(index), /FORBIDDEN_COMMAND_EXECUTED|"delivered":true/, `command ${index} escaped its assigned channel`);
      }
      assert.deepEqual(f.database.prepare('SELECT text FROM deliveries').all().map(row => row.text), ['X.1 delivered from Codex']);
      assert.deepEqual(f.database.prepare('SELECT command FROM calls').all().map(row => row.command), [
        'agent message --to main --text X.1 delivered from Codex', 'agent ps',
      ], 'only the two allowed simple commands may change the shared database');
    } else {
      assert.deepEqual(f.database.prepare('SELECT * FROM deliveries').all(), []);
      assert.deepEqual(f.database.prepare('SELECT * FROM calls').all(), [], 'no excluded commands means no state access');
    }
    assert.ok((await readFile(`${f.statePath}-wal`)).length > 0, 'allowed commands really wrote the isolated WAL');
    assert.ok((await readFile(`${f.statePath}-shm`)).length > 0, 'the shared-memory sidecar exists while the parent connection remains open');
    assert.equal(await readFile(join(f.codexHome, 'config.toml'), 'utf8'), 'sandbox_mode = "workspace-write"\n');
    await prepared.cleanup();
    assert.deepEqual(f.database.prepare('SELECT text FROM deliveries').all().map(row => row.text), channelEnabled ? ['X.1 delivered from Codex'] : []);
  });
}
