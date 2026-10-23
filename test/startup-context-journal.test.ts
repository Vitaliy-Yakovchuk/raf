import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { TmuxAgentAdapter, type AdapterCommand, type RunnerProtocol } from '../src/agent-adapters.ts';
import { captureStartupContextJournal, collectStartupContextJournal, normalizeStartupContextJournal, startupContextRunnerEnvironment } from '../src/startup-context-journal.ts';
import { captureStartupContext } from '../src/startup-context.ts';
import { claudeNativeLines, codexNativeLines, nativeSecret } from './startup-context-native-fixture.ts';

const estimateTokens = (text: string) => text.length;
const captureInput = { runId: 'raf-run', agentType: 'implement', phase: 'implement', briefParts: [{ source: 'brief.txt', text: 'task brief' }] };

function normalizedTrace(runner: 'claude' | 'codex', lines: readonly string[]) {
  const journal = normalizeStartupContextJournal({ runner, version: runner === 'claude' ? '2.1.308' : '0.163.0', lines });
  assert.equal(journal.unavailableReason, null);
  return captureStartupContext({ ...captureInput, runner, events: journal.events }, { estimateTokens });
}

test('native normalization consumes supplied lines without reading files or calling a model', t => {
  const forbidden = () => { throw new Error('Normalizer attempted external IO'); };
  const read = t.mock.method(fs, 'readFileSync', forbidden);
  const fetch = t.mock.method(globalThis, 'fetch', forbidden);
  syncBuiltinESMExports();
  try {
    for (const runner of ['claude', 'codex'] as const) {
      const lines = Object.freeze(runner === 'claude' ? [...claudeNativeLines] : [...codexNativeLines]);
      const before = [...lines];
      const journal = normalizeStartupContextJournal({ runner, version: runner === 'claude' ? '2.1.308' : '0.163.0', lines });
      assert.ok(journal.events.length > 0);
      assert.deepEqual(lines, before);
    }
    assert.equal(read.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    read.mock.restore(); fetch.mock.restore(); syncBuiltinESMExports();
  }
});

test('native claude 2.1.308: attachments, tool results, unique message usage, no result row', () => {
  const trace = normalizedTrace('claude', claudeNativeLines);
  assert.equal(trace.autoloaded.systemPrompt.value, estimateTokens('system prompt'));
  assert.deepEqual(trace.autoloaded.instructions.value?.map(source => source.path ?? source.name), ['/workspace/CLAUDE.md']);
  assert.deepEqual(trace.autoloaded.skills.value?.map(source => source.name), ['plan', 'review']);
  assert.deepEqual(trace.autoloaded.mcpServers.value?.map(source => source.name), ['docs']);
  assert.deepEqual(trace.reads, [{ tool: 'Read', target: '/workspace/requirements.md', resultBytes: { value: Buffer.byteLength(nativeSecret), reason: null } }]);
  assert.equal(trace.tokens.startupInput.value, 120);
  assert.equal(trace.tokens.totalInput.value, 150);
  assert.equal(trace.tokens.cacheReadInput.value, 23);
  assert.equal(trace.tokens.cacheWriteInput.value, 7);
  assert.equal(trace.boundary.kind, 'file-write');
  assert.equal(trace.autoloaded.memory.value, null);
  assert.ok(trace.autoloaded.memory.reason);
  for (const forbidden of [nativeSecret, '/sidechain-only', '/after-boundary', 'system prompt']) assert.equal(JSON.stringify(trace).includes(forbidden), false);
});

test('native codex 0.163.0: session metadata, injected messages, completed items and cumulative token_count', () => {
  const trace = normalizedTrace('codex', codexNativeLines);
  assert.equal(trace.autoloaded.systemPrompt.value, estimateTokens('system prompt'));
  assert.ok(trace.autoloaded.instructions.value?.some(source => (source.path ?? source.name) === '/workspace/AGENTS.md'));
  assert.deepEqual(trace.autoloaded.skills.value?.map(source => source.name), ['plan', 'review']);
  assert.equal(trace.autoloaded.mcpServers.value, null);
  assert.ok(trace.autoloaded.mcpServers.reason);
  assert.equal(trace.reads.length, 1);
  assert.equal(trace.reads[0].target, '/workspace/requirements.md');
  assert.equal(trace.reads[0].resultBytes.value, Buffer.byteLength(nativeSecret));
  assert.equal(trace.tokens.startupInput.value, 140);
  assert.equal(trace.tokens.totalInput.value, 220);
  assert.equal(trace.tokens.cacheReadInput.value, 60);
  assert.equal(trace.tokens.cacheWriteInput.value, null);
  assert.ok(trace.tokens.cacheWriteInput.reason);
  assert.equal(trace.boundary.kind, 'file-write');
  for (const forbidden of [nativeSecret, '/after-boundary', 'Read requirements before editing.', 'system prompt']) assert.equal(JSON.stringify(trace).includes(forbidden), false);
});

test('native codex: AgentMessage ends startup reads even without FileChange', () => {
  const lines = [
    { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'reply', type: 'AgentMessage', text: 'Answer ready' } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'late', type: 'CommandExecution', command: 'cat /late', aggregated_output: nativeSecret } } },
  ].map(row => JSON.stringify(row));
  const trace = normalizedTrace('codex', lines);
  assert.equal(trace.boundary.kind, 'response');
  assert.deepEqual(trace.reads, []);
});

test('native codex: Extension read is bounded by the first raf side effect', () => {
  const lines = [
    { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'ext', type: 'Extension', server: 'docs', tool: 'lookup', arguments: { query: 'startup' }, result: nativeSecret } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'send', type: 'CommandExecution', command: 'raf agent message --to main --text done', aggregated_output: '' } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { id: 'late', type: 'CommandExecution', command: 'cat /late', aggregated_output: nativeSecret } } },
  ].map(row => JSON.stringify(row));
  const trace = normalizedTrace('codex', lines);
  assert.equal(trace.boundary.kind, 'raf-side-effect');
  assert.equal(trace.reads.length, 1);
  assert.match(trace.reads[0].tool, /docs.*lookup/);
  assert.equal(trace.reads[0].target, 'startup');
  assert.equal(trace.reads[0].resultBytes.value, Buffer.byteLength(nativeSecret));
  assert.equal(JSON.stringify(trace).includes(nativeSecret), false);
});

for (const runner of ['claude', 'codex'] as const) {
  test(`native ${runner}: normalization ignores unknown rows without mutating supplied lines`, () => {
    const lines = Object.freeze([JSON.stringify({ type: 'unknown', arbitrary: nativeSecret })]);
    const journal = normalizeStartupContextJournal({ runner, version: runner === 'claude' ? '2.1.308' : '0.163.0', lines });
    assert.deepEqual(journal.events, []);
    assert.equal(journal.unavailableReason, null);
    assert.equal(lines[0], JSON.stringify({ type: 'unknown', arbitrary: nativeSecret }));
  });

  for (const location of ['default-home', 'environment-override'] as const) {
    test(`collector ${runner}: ${location} locates exact native session and preserves every file`, async t => {
      const home = mkdtempSync(join(tmpdir(), 'raf-native-journal-'));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const config = join(home, location === 'default-home' ? `.${runner}` : 'custom-config');
      const relative = runner === 'claude' ? 'projects/unpredictable-project/native-id.jsonl' : 'sessions/2026/10/22/rollout-2026-10-22-native-id.jsonl';
      const transcript = join(config, relative);
      const other = join(dirname(transcript), runner === 'claude' ? 'unrelated-session.jsonl' : 'rollout-2026-10-22-unrelated-session.jsonl');
      mkdirSync(dirname(transcript), { recursive: true });
      const lines = runner === 'claude' ? claudeNativeLines : codexNativeLines;
      writeFileSync(transcript, `${lines.join('\n')}\n`);
      writeFileSync(other, nativeSecret);
      const before = [transcript, other].map(path => ({ path, bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
      const files = readdirSync(home, { recursive: true }).sort();
      const environment = location === 'default-home' ? {} : { [runner === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: config };
      const journal = await collectStartupContextJournal({ runner, runnerSessionId: 'native-id', homeDirectory: home, environment });
      assert.equal(journal.unavailableReason, null);
      const trace = captureStartupContextJournal({ ...captureInput, runner, journal }, { estimateTokens });
      assert.equal(trace.reads[0].target, '/workspace/requirements.md');
      assert.ok(trace.tokens.totalInput.value! > 0);
      assert.equal(JSON.stringify(trace).includes(nativeSecret), false);
      for (const file of before) {
        assert.deepEqual(readFileSync(file.path), file.bytes);
        assert.equal(statSync(file.path).mtimeMs, file.mtime);
      }
      assert.deepEqual(readdirSync(home, { recursive: true }).sort(), files);
    });
  }

  test(`collector ${runner}: reads only the one matched transcript, once, and never its referenced paths`, async () => {
    const calls: string[] = [];
    const path = runner === 'claude' ? '/config/projects/random/native-id.jsonl' : '/config/sessions/2026/10/22/rollout-date-native-id.jsonl';
    const journal = await collectStartupContextJournal({ runner, runnerSessionId: 'native-id', homeDirectory: '/home/fixture', environment: { CLAUDE_CONFIG_DIR: '/config', CODEX_HOME: '/config' } }, {
      async findFiles(pattern) {
        assert.equal(pattern, runner === 'claude' ? '/config/projects/*/native-id.jsonl' : '/config/sessions/*/*/*/rollout-*-native-id.jsonl');
        return [path];
      },
      async readText(file) { calls.push(file); assert.equal(file, path); return (runner === 'claude' ? claudeNativeLines : codexNativeLines).join('\n'); },
    });
    assert.deepEqual(calls, [path]);
    assert.equal(journal.unavailableReason, null);
    assert.equal(captureStartupContextJournal({ ...captureInput, runner, journal }, { estimateTokens }).reads.length, 1);
    assert.deepEqual(calls, [path]);
  });

  for (const scenario of ['missing', 'ambiguous', 'unreadable'] as const) {
    test(`collector ${runner}: ${scenario} produces empty reads and explained null measurements`, async () => {
      let reads = 0;
      const journal = await collectStartupContextJournal({ runner, runnerSessionId: 'native-id', homeDirectory: '/fixture', environment: {} }, {
        async findFiles() { return scenario === 'missing' ? [] : scenario === 'ambiguous' ? ['/a/native-id.jsonl', '/b/native-id.jsonl'] : ['/a/native-id.jsonl']; },
        async readText() { reads++; throw new Error(`EACCES ${nativeSecret}`); },
      });
      assert.equal(reads, scenario === 'unreadable' ? 1 : 0);
      assert.deepEqual(journal.events, []);
      assert.ok(journal.unavailableReason);
      assert.equal(JSON.stringify(journal).includes(nativeSecret), false);
      const trace = captureStartupContextJournal({ ...captureInput, runner, journal }, { estimateTokens });
      assert.deepEqual(trace.reads, []);
      for (const field of [...Object.values(trace.autoloaded), ...Object.values(trace.tokens)]) {
        assert.equal(field.value, null);
        assert.ok(field.reason);
      }
      assert.equal(trace.brief.tokens, estimateTokens('task brief'));
      assert.deepEqual(trace.brief.parts, [{ source: 'brief.txt', tokens: estimateTokens('task brief') }]);
      assert.equal(JSON.stringify(trace).includes(nativeSecret), false);
    });
  }
}

test('claude launch environment forces persistence and keeps inherited child-session marker', () => {
  const inherited = Object.freeze({ CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '0', PATH: '/bin', CODEX_HOME: '/codex' });
  const actual = startupContextRunnerEnvironment('claude', inherited);
  assert.deepEqual(actual, { ...inherited, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' });
  assert.equal(inherited.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '0');
});

test('codex launch environment preserves inherited values', () => {
  const inherited = Object.freeze({ CODEX_HOME: '/codex', PATH: '/bin' });
  assert.deepEqual(startupContextRunnerEnvironment('codex', inherited), inherited);
});

test('actual tmux claude launch carries the persistence override to the runner command', async () => {
  const commands: AdapterCommand[] = [];
  const protocol: RunnerProtocol = {
    invocation: () => ({ executable: '/fixture/claude', args: [] }),
    observe: () => ({ status: 'starting' }),
  };
  const adapter = new TmuxAgentAdapter({
    async execute(command) { commands.push(command); return { exitCode: 0, stdout: '', stderr: '' }; },
    protocols: { claude: protocol, codex: protocol, grok: protocol, agy: protocol },
  });
  await adapter.startWithoutInput({
    selection: { runner: 'claude', model: 'fixture-model', effort: 'fixture-effort' },
    tmuxSession: 'fixture-context-persistence', cwd: '/fixture', reportWrapper: { wrap: command => command },
  });
  const launch = commands.find(command => command.executable === 'tmux' && command.args.includes('new-session'));
  assert.ok(launch, 'the real adapter issues a tmux launch command');
  assert.ok(JSON.stringify(launch).includes('CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1'));
});
