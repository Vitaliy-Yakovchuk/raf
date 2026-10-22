import type { Invocation, NativeSandboxScope } from './runner-protocols.ts';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';

export interface CodexRafCommandAccessRequest {
  readonly invocation: Invocation;
  readonly scope: NativeSandboxScope;
  readonly cwd: string;
  readonly runDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

export interface PreparedCodexRafCommandAccess {
  readonly invocation: Invocation;
  readonly environment: Readonly<Record<string, string>>;
  cleanup(): Promise<void>;
}

const hookProgram = String.raw`
const { spawn } = await import('node:child_process');
const parse = source => {
  const words = [];
  let word = '', started = false, quote = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = ''; else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '$' || char === '\x60') return null;
      else if (char === '\\') {
        const next = source[++i];
        if (next === undefined || next === '\n' || next === '\r') return null;
        word += ['$', '\x60', '"', '\\'].includes(next) ? next : '\\' + next;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char; started = true;
    } else if (char === '\\') {
      const next = source[++i];
      if (next === undefined || next === '\n' || next === '\r') return null;
      word += next; started = true;
    } else if (char === ' ' || char === '\t') {
      if (started) words.push(word);
      word = ''; started = false;
    } else if (/[\r\n\0;&|<>$\x60(){}*?\[\]~#]/u.test(char)) return null;
    else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
};
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const command = request.tool_input?.command;
const words = typeof command === 'string' ? parse(command) : null;
const allowed = access.commands.map(parse).find(prefix => prefix?.length && words?.length >= prefix.length && prefix.every((word, index) => words[index] === word));
if (request.hook_event_name === 'PreToolUse' && request.tool_name === 'Bash' && allowed) {
  const result = await new Promise(resolve => {
    const child = spawn(allowed[0], words.slice(1), { cwd: access.cwd, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { stderr += error.message; });
    child.on('close', code => resolve({ stdout, stderr, code: code ?? 1 }));
  });
  const literal = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const replay = 'printf %s ' + literal(result.stdout) + '; printf %s ' + literal(result.stderr) + ' >&2; exit ' + result.code;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: replay } } }));
} else process.stdout.write('{}');
`;

const literal = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function hookIdentity(executable: string, args: string[], cwd: string, environment: Record<string, string>, command: string, timeoutMs: number): Promise<{ key: string; currentHash: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args, 'app-server', '--listen', 'stdio://'], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (error?: Error, value?: { key: string; currentHash: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Codex RAF hook inspection timed out')), timeoutMs);
    child.stderr.resume();
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Codex RAF hook inspection exited before returning its definition')));
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.error) return finish(new Error(`Codex RAF hook inspection failed: ${message.error.message}`));
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } }) + '\n');
        } else if (message.id === 2) {
          const hooks = message.result?.data?.flatMap((entry: { hooks: unknown[] }) => entry.hooks) ?? [];
          const matches = hooks.filter((hook: Record<string, unknown>) => hook.source === 'sessionFlags' && hook.eventName === 'preToolUse' && hook.command === command);
          if (matches.length !== 1 || typeof matches[0].key !== 'string' || typeof matches[0].currentHash !== 'string') return finish(new Error('Codex did not expose the exact RAF hook definition'));
          finish(undefined, matches[0]);
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'raf-command-access', version: '1' }, capabilities: { experimentalApi: true } } }) + '\n');
  });
}

export async function prepareCodexRafCommandAccess(
  request: CodexRafCommandAccessRequest,
): Promise<PreparedCodexRafCommandAccess> {
  const environment = Object.fromEntries(Object.entries(request.environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const invocation = { ...request.invocation, args: [...request.invocation.args] };
  if (request.scope.excludedCommands.length) {
    const commands = request.scope.excludedCommands.map(command => {
      if (!command.trim() || command === ':*') throw new Error('Invalid Codex RAF command scope');
      return command.endsWith(':*') ? command.slice(0, -2) : command;
    });
    const source = `const access = ${JSON.stringify({ commands, cwd: request.cwd })};\n${hookProgram}`;
    const command = `${literal(process.execPath)} --input-type=module -e ${literal(source)}`;
    const hook = `hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command=${JSON.stringify(command)}}]}]`;
    const configuration: string[] = [];
    for (let i = 0; i < invocation.args.length; i++) {
      if (['-c', '--config'].includes(invocation.args[i])) configuration.push('-c', invocation.args[++i]);
    }
    configuration.push('-c', hook);
    const timeoutMs = request.timeoutMs ?? JSON.parse(await readFile(new URL('../../conf/raf.json', import.meta.url), 'utf8')).runnerProtocols.find((protocol: { runner: string }) => protocol.runner === 'codex')?.timeouts.transitionMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Codex RAF hook inspection requires a configured deadline');
    const identity = await hookIdentity(invocation.executable, configuration, request.cwd, environment, command, timeoutMs);
    const end = invocation.args.indexOf('--');
    invocation.args.splice(end < 0 ? invocation.args.length : end, 0, '-c', hook, '-c', `hooks.state={${JSON.stringify(identity.key)}={trusted_hash=${JSON.stringify(identity.currentHash)}}}`);
  }
  return { invocation, environment, cleanup: async () => {} };
}
