import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCodexRafCommandAccess, type PreparedCodexRafCommandAccess } from '../src/codex-raf-command-access.ts';

const trustHash = 'fixture-hash';
const hookTimeoutSec = Number.MAX_SAFE_INTEGER;

function hookCommand(prepared: PreparedCodexRafCommandAccess): string {
  const config = prepared.invocation.args.find(value => value.startsWith('hooks.PreToolUse='));
  assert.ok(config, 'prepared invocation must install the production PreToolUse hook');
  const match = config.match(/\bcommand\s*=\s*("(?:\\.|[^"\\])*")/);
  assert.ok(match, 'hook command must be a TOML basic string with JSON escapes');
  return JSON.parse(match[1]);
}

function trustState(prepared: PreparedCodexRafCommandAccess): string | undefined {
  return prepared.invocation.args.find(value => value.startsWith('hooks.state='));
}

test('warm Codex launches reuse one inspected trust hash for a stable hook command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'raf-hook-trust-'));
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  const spawns = join(root, 'spawns.log');
  const executable = join(root, 'inspect-codex');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(spawns)}, 'spawn\\n');
const config = process.argv.find(arg => arg.startsWith('hooks.PreToolUse='));
const command = JSON.parse(config.match(/\\bcommand\\s*=\\s*("(?:\\\\.|[^"\\\\])*")/)[1]);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
  if (request.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ hooks: [{ source: 'sessionFlags', eventName: 'preToolUse', command, key: 'raf-hook', currentHash: ${JSON.stringify(trustHash)}, timeoutSec: ${hookTimeoutSec}, async: false }] }] } }));
}
`, { mode: 0o700 });
  const scope = { hidden: [], readable: [], tmuxDirectory: join(root, 'tmux'), excludedCommands: ['raf agent ps'] };
  const args = ['--sandbox', 'workspace-write', '--no-daemon'];
  const prepared: PreparedCodexRafCommandAccess[] = [];
  const prepare = (runId: string) => prepareCodexRafCommandAccess({
    invocation: { executable, args: [...args], liveTaskVerified: false },
    scope,
    cwd,
    runDirectory: join(root, runId),
    environment: { PATH: process.env.PATH ?? '' },
    timeoutMs: 1000,
    publication: { orchestratorRoot: root, homeDirectory: home, runId, agentId: 'agent-a' },
  });
  try {
    prepared.push(await prepare('run-a'), await prepare('run-b'));
    assert.equal(prepared[0].unavailable, undefined);
    assert.equal(prepared[1].unavailable, undefined);
    assert.equal(hookCommand(prepared[0]), hookCommand(prepared[1]));
    assert.notEqual(prepared[0].environment.RAF_CODEX_RESULTS, prepared[1].environment.RAF_CODEX_RESULTS);
    assert.equal(readFileSync(spawns, 'utf8').trim().split('\n').filter(Boolean).length, 1);
    assert.equal(trustState(prepared[0]), trustState(prepared[1]));
    assert.match(trustState(prepared[1]) ?? '', new RegExp(`trusted_hash=${JSON.stringify(trustHash).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(prepared[1].invocation.args.includes('--no-daemon'));
  } finally {
    for (const item of prepared) await item.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
