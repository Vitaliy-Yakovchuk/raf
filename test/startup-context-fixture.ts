import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import type { ContextMeasurement, StartupContextCapture, StartupContextTrace } from '../src/startup-context.ts';

export const flowConfiguration = JSON.parse(readFileSync(new URL('../../conf/flow.json', import.meta.url), 'utf8'));
export const briefParts = [
  { source: 'conf/briefs/base.md', text: 'synthetic brief base' },
  { source: 'conf/briefs/test-scaffold.md', text: 'synthetic stage instructions' },
];
export const syntheticSecret = 'SYNTHETIC_SECRET_MUST_NEVER_BE_PERSISTED_47';
export const syntheticFileContent = `private file contents: ${syntheticSecret}`;
export const estimateTokens = (text: string): number => text.split(/\s+/u).filter(Boolean).length;

export function unavailable<T>(measurement: ContextMeasurement<T>): void {
  assert.equal(measurement.value, null);
  assert.equal(typeof measurement.reason, 'string');
  assert.ok(measurement.reason!.trim().length > 0);
}

export function measured<T>(measurement: ContextMeasurement<T>, expected: T): void {
  assert.deepEqual(measurement.value, expected);
  assert.equal(measurement.reason, null);
}

export function claudeRead(id: string, path: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] } };
}

export function claudeResult(id: string, content: string): Record<string, unknown> {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } };
}

export function claudeWrite(): Record<string, unknown> {
  return { type: 'assistant', message: { usage: { input_tokens: 240, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }, content: [{ type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: '/repo/result.txt', content: syntheticSecret } }] } };
}

export function captureInput(overrides: Partial<StartupContextCapture> = {}): StartupContextCapture {
  return {
    runId: 'run-claude-1', agentType: 'test-scaffold', runner: 'claude', phase: 'test-scaffold', briefParts,
    events: [
      { type: 'system', subtype: 'init', session_id: 'cli-session', skills: ['start', 'dev-start-tokens'], mcp_servers: [{ name: 'docs', status: 'connected' }] },
      claudeRead('read-1', '/repo/AGENTS.md'),
      claudeResult('read-1', syntheticFileContent),
      claudeRead('read-2', '/repo/spec.md'),
      claudeResult('read-2', 'relevant specification'),
      claudeWrite(),
      claudeRead('read-after-write', '/repo/after-write.md'),
      claudeResult('read-after-write', 'must not enter the startup reads'),
      { type: 'result', subtype: 'success', usage: { input_tokens: 900, output_tokens: 70, cache_read_input_tokens: 120, cache_creation_input_tokens: 40 } },
    ],
    ...overrides,
  };
}

export function traceFixture(runId: string, phase = 'implement'): StartupContextTrace {
  const missing = { value: null, reason: 'Runner did not expose this field' } as const;
  return {
    runId, agentType: phase === 'context-review' ? 'spec' : 'implement', runner: 'codex', phase,
    autoloaded: { systemPrompt: missing, instructions: missing, skills: missing, mcpServers: missing, memory: missing },
    reads: [{ tool: 'command_execution', target: '/repo/AGENTS.md', resultBytes: { value: 18, reason: null } }],
    brief: { tokens: 7, parts: [{ source: 'conf/briefs/base.md', tokens: 7 }] },
    tokens: { startupInput: missing, totalInput: { value: 120, reason: null }, cacheReadInput: missing, cacheWriteInput: missing },
    boundary: { kind: 'response', eventIndex: 2 }, context: null,
  };
}

export function contextDatabase(t: TestContext): { directory: string; databasePath: string; database: DatabaseSync; flowPath: string; writeFlow: (runsPerReview: unknown, finishedSessionsMs?: number) => void } {
  const directory = mkdtempSync(join(tmpdir(), 'raf-startup-context-'));
  const databasePath = join(directory, 'state.sqlite');
  const database = new DatabaseSync(databasePath);
  const flowPath = join(directory, 'flow.json');
  t.after(() => {
    if (database.isOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const writeFlow = (runsPerReview: unknown, finishedSessionsMs = flowConfiguration.retention.finishedSessionsMs): void => {
    writeFileSync(flowPath, JSON.stringify({ ...flowConfiguration, retention: { ...flowConfiguration.retention, finishedSessionsMs }, startupContextReview: { runsPerReview } }));
  };
  writeFlow(flowConfiguration.startupContextReview.runsPerReview);
  return { directory, databasePath, database, flowPath, writeFlow };
}
