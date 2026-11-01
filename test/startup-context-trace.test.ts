import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { captureStartupContext, readStartupContextTrace, saveStartupContextTrace } from '../src/startup-context.ts';
import {
  briefParts, captureInput, claudeRead, claudeResult, claudeWrite, contextDatabase,
  estimateTokens, measured, syntheticFileContent, syntheticSecret, unavailable,
} from './startup-context-fixture.ts';

test('startup context: Claude stream yields ordered reads, exposed autoloaded metadata, brief parts and usage', () => {
  const trace = captureStartupContext(captureInput(), { estimateTokens });
  assert.equal(trace.runId, 'run-claude-1');
  assert.equal(trace.runner, 'claude');
  assert.equal(trace.agentType, 'test-scaffold');
  assert.equal(trace.phase, 'test-scaffold');
  assert.deepEqual(trace.reads.map(read => [read.tool, read.target]), [['Read', '/repo/AGENTS.md'], ['Read', '/repo/spec.md']]);
  measured(trace.reads[0].resultBytes, Buffer.byteLength(syntheticFileContent));
  measured(trace.reads[1].resultBytes, Buffer.byteLength('relevant specification'));
  assert.equal(trace.boundary.kind, 'file-write');
  assert.equal(trace.boundary.eventIndex, 5);
  assert.deepEqual(trace.autoloaded.skills.value?.map(source => source.name), ['start', 'dev-start-tokens']);
  assert.deepEqual(trace.autoloaded.mcpServers.value?.map(source => source.name), ['docs']);
  for (const source of [...trace.autoloaded.skills.value!, ...trace.autoloaded.mcpServers.value!]) unavailable(source.tokens);
  unavailable(trace.autoloaded.systemPrompt);
  unavailable(trace.autoloaded.instructions);
  unavailable(trace.autoloaded.memory);
  assert.deepEqual(trace.brief.parts, briefParts.map(part => ({ source: part.source, tokens: estimateTokens(part.text) })));
  assert.equal(trace.brief.tokens, estimateTokens(briefParts.map(part => part.text).join('\n')));
  measured(trace.tokens.startupInput, 280);
  measured(trace.tokens.totalInput, 1060);
  measured(trace.tokens.cacheReadInput, 120);
  measured(trace.tokens.cacheWriteInput, 40);
});

test('startup context: Codex command events are captured without a transcript and stop at file_change start', () => {
  const events = [
    { type: 'thread.started', thread_id: 'codex-thread' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: '/bin/bash -lc "cat /repo/AGENTS.md"', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: '/bin/bash -lc "cat /repo/AGENTS.md"', aggregated_output: syntheticFileContent, exit_code: 0, status: 'completed' } },
    { type: 'item.started', item: { id: 'edit-1', type: 'file_change', changes: [{ path: '/repo/result.ts', kind: 'add' }], status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'late-read', type: 'command_execution', command: 'cat /repo/late.md', aggregated_output: 'late result', exit_code: 0, status: 'completed' } },
    { type: 'turn.completed', usage: { input_tokens: 450, cached_input_tokens: 100, output_tokens: 35 } },
  ];
  const trace = captureStartupContext(captureInput({ runId: 'run-codex-1', runner: 'codex', events }), { estimateTokens });
  assert.deepEqual(trace.reads.map(read => read.target), ['/repo/AGENTS.md']);
  measured(trace.reads[0].resultBytes, Buffer.byteLength(syntheticFileContent));
  assert.equal(trace.boundary.kind, 'file-write');
  assert.equal(trace.boundary.eventIndex, 4);
  measured(trace.tokens.totalInput, 450);
  measured(trace.tokens.cacheReadInput, 100);
  unavailable(trace.tokens.cacheWriteInput);
  unavailable(trace.tokens.startupInput);
  for (const measurement of Object.values(trace.autoloaded)) unavailable(measurement);
  assert.ok(!JSON.stringify(trace).includes(syntheticFileContent));
  assert.ok(!JSON.stringify(trace).includes(syntheticSecret));
});

test('startup context: capture consumes supplied events without opening a transcript or calling a model', t => {
  const deniedRead = t.mock.method(fs, 'readFileSync', () => { assert.fail('Capture must not read a transcript or source file'); });
  const deniedFetch = t.mock.method(globalThis, 'fetch', async () => { assert.fail('Capture must not call an external API or model'); });
  syncBuiltinESMExports();
  try {
    const trace = captureStartupContext(captureInput(), { estimateTokens });
    assert.equal(trace.reads.length, 2);
    assert.equal(deniedRead.mock.callCount(), 0);
    assert.equal(deniedFetch.mock.callCount(), 0);
  } finally {
    deniedRead.mock.restore();
    deniedFetch.mock.restore();
    syncBuiltinESMExports();
  }
});

test('startup context: missing runner data is null with a reason, never an invented zero', () => {
  for (const runner of ['claude', 'codex'] as const) {
    const trace = captureStartupContext(captureInput({ runner, events: [] }), { estimateTokens });
    assert.deepEqual(trace.reads, []);
    for (const measurement of Object.values(trace.autoloaded)) unavailable(measurement);
    for (const measurement of Object.values(trace.tokens)) unavailable(measurement);
    assert.ok(trace.brief.tokens > 0);
  }
});

test('startup context: a measured zero usage or empty exposed skills list remains available', () => {
  const trace = captureStartupContext(captureInput({ events: [
    { type: 'system', subtype: 'init', skills: [], mcp_servers: [] },
    { type: 'result', subtype: 'success', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  ] }), { estimateTokens });
  measured(trace.tokens.totalInput, 0);
  measured(trace.tokens.cacheReadInput, 0);
  measured(trace.tokens.cacheWriteInput, 0);
  measured(trace.autoloaded.skills, []);
  measured(trace.autoloaded.mcpServers, []);
});

test('startup context: Codex totals include all turns while cached input stays separate', () => {
  const trace = captureStartupContext(captureInput({ runner: 'codex', events: [
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'first-write', type: 'file_change', changes: [{ path: '/repo/change.ts', kind: 'update' }], status: 'completed' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 1 } },
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 5, output_tokens: 3 } },
  ] }), { estimateTokens });
  measured(trace.tokens.totalInput, 40);
  measured(trace.tokens.cacheReadInput, 7);
  unavailable(trace.tokens.startupInput);
});

test('startup context: parallel read results are matched by call id while preserving invocation order', () => {
  const trace = captureStartupContext(captureInput({ events: [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'first', name: 'Read', input: { file_path: '/repo/first.md' } },
      { type: 'tool_use', id: 'second', name: 'Read', input: { file_path: '/repo/second.md' } },
    ] } },
    claudeResult('second', 'другий'),
    claudeResult('first', 'first'),
    claudeWrite(),
  ] }), { estimateTokens });
  assert.deepEqual(trace.reads.map(read => read.target), ['/repo/first.md', '/repo/second.md']);
  measured(trace.reads[0].resultBytes, Buffer.byteLength('first'));
  measured(trace.reads[1].resultBytes, Buffer.byteLength('другий'));
});

test('startup context: an unfinished read keeps its position and explains the unavailable result size', () => {
  const trace = captureStartupContext(captureInput({ events: [claudeRead('pending', '/repo/pending.md'), claudeWrite()] }), { estimateTokens });
  assert.equal(trace.reads.length, 1);
  assert.equal(trace.reads[0].target, '/repo/pending.md');
  unavailable(trace.reads[0].resultBytes);
});

test('startup context: reads preceding the first edit in the same message are included, later calls are excluded', () => {
  const trace = captureStartupContext(captureInput({ events: [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'before', name: 'Read', input: { file_path: '/repo/before.md' } },
      { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/repo/change.md', old_string: 'a', new_string: syntheticSecret } },
      { type: 'tool_use', id: 'after', name: 'Read', input: { file_path: '/repo/after.md' } },
    ] } },
    claudeResult('before', 'before result'),
  ] }), { estimateTokens });
  assert.deepEqual(trace.reads.map(read => read.target), ['/repo/before.md']);
  assert.equal(trace.boundary.kind, 'file-write');
});

for (const command of ['node /repo/raf-main/bin/raf.ts agent message --to main --text done', 'node /repo/raf-main/bin/raf.ts reminder close-all --created-for main --reason done', 'printf done > /repo/result.txt']) {
  test(`startup context: first side effect ends startup: ${command}`, () => {
    const trace = captureStartupContext(captureInput({ events: [
      claudeRead('before', '/repo/before.md'), claudeResult('before', 'before'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'action', name: 'Bash', input: { command } }] } },
      claudeRead('after', '/repo/after.md'), claudeResult('after', 'after'),
    ] }), { estimateTokens });
    assert.deepEqual(trace.reads.map(read => read.target), ['/repo/before.md']);
    assert.equal(trace.boundary.kind, command.includes('raf.ts') ? 'raf-side-effect' : 'file-write');
  });
}

test('startup context: read-only raf calls and search queries remain reads until the first response', () => {
  const trace = captureStartupContext(captureInput({ events: [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ps', name: 'Bash', input: { command: 'node /repo/raf-main/bin/raf.ts agent ps' } }] } },
    claudeResult('ps', '[]'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search', name: 'Grep', input: { pattern: 'Requirement', path: '/repo/specs' } }] } },
    claudeResult('search', 'spec.md: Requirement'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The requested explanation.' }] } },
    claudeRead('late', '/repo/late.md'),
  ] }), { estimateTokens });
  assert.equal(trace.reads.length, 2);
  assert.match(trace.reads[0].target, /agent ps/u);
  assert.match(trace.reads[1].target, /Requirement/u);
  assert.match(trace.reads[1].target, /\/repo\/specs/u);
  assert.equal(trace.boundary.kind, 'response');
  assert.equal(trace.boundary.eventIndex, 4);
});

test('startup context: appending reads after a boundary cannot change startup reads or brief metadata', () => {
  const prefix = [claudeRead('first', '/repo/first.md'), claudeResult('first', 'first'), claudeWrite()];
  const original = captureStartupContext(captureInput({ events: prefix }), { estimateTokens });
  for (const count of [1, 3, 9]) {
    const suffix = Array.from({ length: count }, (_, index) => [claudeRead(`late-${index}`, `/repo/late-${index}.md`), claudeResult(`late-${index}`, syntheticSecret)]).flat();
    const extended = captureStartupContext(captureInput({ events: [...prefix, ...suffix] }), { estimateTokens });
    assert.deepEqual(extended.reads, original.reads);
    assert.deepEqual(extended.brief, original.brief);
    assert.deepEqual(extended.boundary, original.boundary);
  }
});

test('startup context: only metadata is serialized; contents, brief text, credentials and arbitrary event fields stay out', () => {
  const trace = captureStartupContext(captureInput({
    briefParts: [{ source: 'conf/briefs/private.md', text: syntheticSecret }],
    events: [
      { type: 'system', subtype: 'init', skills: [], mcp_servers: [], apiKey: syntheticSecret, debug: { body: syntheticFileContent } },
      claudeRead('env', '/repo/.env'), claudeResult('env', `API_KEY=${syntheticSecret}`),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command: `API_KEY=${syntheticSecret} cat /repo/settings.md` } }] } },
      claudeResult('shell', syntheticFileContent), claudeWrite(),
    ],
  }), { estimateTokens });
  const serialized = JSON.stringify(trace);
  for (const forbidden of [syntheticSecret, syntheticFileContent, 'API_KEY=', 'apiKey', 'debug']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.equal(trace.reads[0].target, '/repo/.env');
  assert.ok(trace.reads.some(read => read.target.includes('/repo/settings.md')));
  measured(trace.reads[0].resultBytes, Buffer.byteLength(`API_KEY=${syntheticSecret}`));
});

test('startup context: metadata survives reopening state.sqlite, is keyed by runId and never writes source content to SQLite', t => {
  const fixture = contextDatabase(t);
  const trace = captureStartupContext(captureInput(), { estimateTokens });
  saveStartupContextTrace(fixture.database, trace);
  saveStartupContextTrace(fixture.database, { ...trace, runId: 'another-run' });
  fixture.database.close();
  const reopened = new DatabaseSync(fixture.databasePath);
  try {
    assert.deepEqual(readStartupContextTrace(reopened, trace.runId), trace);
    assert.equal(readStartupContextTrace(reopened, 'another-run')?.runId, 'another-run');
    assert.equal(readStartupContextTrace(reopened, 'unknown-run'), null);
    const rows = reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const stored = rows.flatMap(row => reopened.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all());
    assert.ok(!JSON.stringify(stored).includes(syntheticSecret));
    assert.ok(!JSON.stringify(stored).includes(syntheticFileContent));
  } finally {
    reopened.close();
  }
  assert.ok(!readFileSync(fixture.databasePath).includes(Buffer.from(syntheticSecret)));
});

for (const field of ['phase', 'channel'] as const) {
  for (const end of ['file_change', 'final', 'legacy', 'raf-side-effect'] as const) {
    test(`startup context: Codex ${field} commentary preserves ordered reads until ${end}`, () => {
      const events = [
        { type: 'item.completed', item: { id: 'progress', type: 'agent_message', [field]: 'commentary', text: syntheticSecret } },
        { type: 'item.started', item: { id: 'first', type: 'command_execution', command: 'cat /repo/first.md' } },
        { type: 'item.completed', item: { id: 'second', type: 'command_execution', command: 'cat /repo/second.md', aggregated_output: syntheticFileContent } },
        { type: 'item.completed', item: end === 'raf-side-effect'
          ? { id: 'action', type: 'command_execution', command: 'raf agent message --to main --text done', aggregated_output: '' }
          : end === 'file_change' ? { id: 'action', type: 'file_change' }
          : { id: 'action', type: 'agent_message', ...(end === 'final' ? { [field]: 'final' } : {}), text: syntheticSecret } },
        { type: 'item.completed', item: { id: 'first', type: 'command_execution', command: 'cat /repo/first.md', aggregated_output: syntheticFileContent } },
        { type: 'item.completed', item: { id: 'late', type: 'command_execution', command: 'cat /after-boundary', aggregated_output: syntheticSecret } },
      ];
      const trace = captureStartupContext(captureInput({ runner: 'codex', events }), { estimateTokens });
      assert.deepEqual(trace.boundary, { kind: end === 'file_change' ? 'file-write' : end === 'raf-side-effect' ? 'raf-side-effect' : 'response', eventIndex: 3 });
      assert.deepEqual(trace.reads.map(read => read.target), ['/repo/first.md', '/repo/second.md']);
      for (const read of trace.reads) measured(read.resultBytes, Buffer.byteLength(syntheticFileContent));
      for (const forbidden of [syntheticSecret, syntheticFileContent, '/after-boundary']) assert.equal(JSON.stringify(trace).includes(forbidden), false);
    });
  }
}

test('startup context: Claude cache tokens count in startup and cumulative result without double counting messages', () => {
  const assistant = { type: 'assistant', message: { id: 'cached-start', usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, content: [] } };
  const events = [assistant, assistant, { type: 'assistant', message: { id: 'next', usage: { input_tokens: 3, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }, content: [] } }];
  const capture = (rows: object[]) => captureStartupContext({ ...captureInput(), events: rows }, { estimateTokens });
  const trace = capture(events);
  measured(trace.tokens.startupInput, 122);
  measured(trace.tokens.totalInput, 355);
  measured(trace.tokens.cacheReadInput, 300);
  measured(trace.tokens.cacheWriteInput, 50);
  const final = capture([...events, { type: 'result', usage: { input_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 } }]);
  measured(final.tokens.startupInput, 122);
  measured(final.tokens.totalInput, 355);
});

test('startup context: cache creation marker distinguishes Claude additional cache from Codex inclusive input', () => {
  for (const usage of [{ input_tokens: 7 }, { input_tokens: 7, cache_read_input_tokens: 5 }, { input_tokens: 7, cache_creation_input_tokens: 3 }, { input_tokens: 7, cache_creation_input_tokens: null, cache_read_input_tokens: 'unknown' }]) {
    const trace = captureStartupContext({ ...captureInput(), events: [{ type: 'assistant', message: { usage, content: [] } }] }, { estimateTokens });
    measured(trace.tokens.totalInput, usage.cache_creation_input_tokens === 3 ? 10 : 7);
  }
});
