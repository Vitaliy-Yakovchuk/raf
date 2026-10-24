import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandFixture } from './reminder-fixture.ts';
import type { ReminderCommand } from '../src/reminder-cli.ts';
import type { Reminder } from '../src/reminders.ts';

const execute = promisify(execFile);
const child = `
import { openStateStore } from ${JSON.stringify(new URL('../src/state-store.ts', import.meta.url).href)};
import { createReminderHandlers, settleCommandState } from ${JSON.stringify(new URL('../src/reminder-cli.ts', import.meta.url).href)};
import { loadEventCatalog } from ${JSON.stringify(new URL('../src/event-catalog.ts', import.meta.url).href)};
import { failureContext } from ${JSON.stringify(new URL('../src/cli-contract.ts', import.meta.url).href)};
const input = JSON.parse(process.argv[1]);
const store = openStateStore(input.statePath);
try {
  const attempts = [];
  const ports = {
    store, now: () => input.now, catalog: loadEventCatalog(input.root),
    nextReminderId: () => 'child-' + process.pid,
    deliver: async (request, sender) => {
      attempts.push({ ...request, sender });
      return input.accepted
        ? { accepted: true, receiptId: 'receipt-' + process.pid + '-' + attempts.length }
        : { accepted: false, reason: 'injected unaccepted delivery' };
    },
  };
  let result, error;
  try { result = await createReminderHandlers(ports)[input.name](input.params); }
  catch (caught) {
    const context = failureContext(caught);
    error = { ...context, code: context?.code ?? caught.code, message: caught.message };
  }
  if (input.settle) await settleCommandState(ports);
  process.stdout.write(JSON.stringify({ pid: process.pid, result, error, attempts }));
} finally { store.close(); }
`;

export type ProcessResult = {
  pid: number;
  result?: Reminder | Reminder[];
  error?: { code?: string; message?: string };
  attempts: { to: string; text: string; sender: { kind: string } }[];
};

export async function reminderProcess(
  f: CommandFixture,
  name: ReminderCommand,
  params: Record<string, unknown>,
  options: { accepted?: boolean; settle?: boolean } = {},
): Promise<ProcessResult> {
  const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', child, JSON.stringify({
    statePath: f.statePath, root: f.root, now: f.now(), name, params,
    accepted: options.accepted ?? true, settle: options.settle ?? true,
  })]);
  return JSON.parse(stdout) as ProcessResult;
}
