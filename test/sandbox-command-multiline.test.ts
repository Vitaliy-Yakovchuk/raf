import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSandboxCommand, runSandboxTestCommand } from '../src/sandbox-test-run.ts';
import type { SandboxTestAssignment, SandboxTestRunPorts } from '../src/sandbox-test-run.ts';

const entrypoint = ['/trusted/node', '/trusted/raf/bin/raf.ts'];
const workspace = '/fixture/orchestrator/raf-develop';
const caller = { pid: 310, startedAt: '2026-10-25T12:00:00Z' };
const assignment: SandboxTestAssignment = {
  runId: 'multiline-author-run', agentId: 'multiline-author', type: 'test-scaffold',
  phase: 'test-scaffold', project: 'raf', workspace, branch: 'develop',
  changes: ['add-raf-agent-run'],
};
const prefix = `${entrypoint.join(' ')} agent message --to main --text `;

for (const [label, eol] of [['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n']]) {
  const text = `перший рядок${eol}$(touch /fixture/must-not-exist); \`uname\` | cat > /fixture/also-must-not-exist${eol}останній рядок${eol}`;
  const command = `${prefix}'${text}'`;

  test(`4.1.4 single-quoted ${label} stays in one literal message argument`, () => {
    assert.deepEqual(parseSandboxCommand(command), [
      ...entrypoint, 'agent', 'message', '--to', 'main', '--text', text,
    ]);
  });

  test(`4.1.4 trusted channel delegates ${label} message exactly once without changing bytes`, async () => {
    const deliveries: { argv: readonly string[]; sender: SandboxTestAssignment }[] = [];
    const receipt = { code: 0, stdout: '{"accepted":true,"receiptId":"fixture-receipt"}\n', stderr: '' };
    const ports: SandboxTestRunPorts = {
      caller, entrypoint,
      control: async () => ({
        ancestors: [caller], sessions: [{ process: caller, state: 'running', assignment }],
        workspaces: [], activeChanges: ['add-raf-agent-run'], groups: [],
      }),
      unitContext: async () => { assert.fail('message must not open a unit context'); },
      communicate: async (argv, sender) => {
        deliveries.push({ argv, sender });
        return receipt;
      },
    };
    const result = await runSandboxTestCommand({ command, cwd: workspace }, ports);
    assert.deepEqual(deliveries, [{
      argv: ['agent', 'message', '--to', 'main', '--text', text], sender: assignment,
    }]);
    assert.deepEqual(result, receipt);
  });
}

test('4.1.4 quoted line breaks compose with an escaped apostrophe and adjacent literal segments', () => {
  const command = `${prefix}'first\n'\\''quoted\r\n'last`;
  assert.deepEqual(parseSandboxCommand(command), [
    ...entrypoint, 'agent', 'message', '--to', 'main', '--text', "first\n'quoted\r\nlast",
  ]);
});

test('4.1.4 backslash-n stays distinct from an actual LF', () => {
  assert.deepEqual(parseSandboxCommand(`${prefix}'first\\nlast'`), [
    ...entrypoint, 'agent', 'message', '--to', 'main', '--text', 'first\\nlast',
  ]);
});

for (const [label, suffix] of [
  ['unquoted LF', "'safe'\n/trusted/other"],
  ['unquoted CR', "'safe'\r/trusted/other"],
  ['unquoted CRLF', "'safe'\r\n/trusted/other"],
  ['escaped LF outside quotes', "'safe'\\\n/trusted/other"],
  ['escaped CR outside quotes', "'safe'\\\r/trusted/other"],
  ['semicolon after multiline literal', "'first\nlast'; /trusted/other"],
  ['pipe after multiline literal', "'first\nlast' | /trusted/other"],
  ['NUL inside single quotes', "'first\0last'"],
  ['NUL outside quotes', 'first\0last'],
  ['unterminated multiline literal', "'first\nlast"],
]) {
  test(`4.1.4 rejects ${label}`, () => {
    assert.equal(parseSandboxCommand(`${prefix}${suffix}`), null);
  });
}
