import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function instrumentAgentRunCli(code) {
  const marker = 'const result = statSync';
  assert.equal(code.split(marker).length, 2);
  return code.replace(marker, "const qaAudit = await import('../qa/ar41-cli-audit.mjs');\nconst qaCall = await qaAudit.begin();\n" + marker)
    .replace('if (result.stdout) {', 'qaAudit.end(qaCall, result);\nif (result.stdout) {');
}
export async function begin() {
  const directory = process.env.AR41_AUDIT;
  if (!directory || process.argv[2] !== 'agent' || process.argv[3] !== 'message') return null;
  assert.match(directory, /^\/srv\/dev\/ar41-[^/]+\/root\/raf-develop\/qa\/ar41-audit$/);
  const argv = process.argv.slice(2), call = { id: randomUUID(), directory, argv, pid: process.pid, enteredAt: Date.now() };
  const text = argv[argv.indexOf('--text') + 1];
  const concurrent = text?.match(/^AR41_RECEIVE:concurrent-([ab]) /);
  if (concurrent) {
    const file = path.join(directory, 'barrier-' + concurrent[1]);
    fs.writeFileSync(file, call.id, { flag: 'wx' });
    const deadline = Date.now() + 120000;
    while (!['a', 'b'].every(a => fs.existsSync(path.join(directory, 'barrier-' + a)))) {
      assert.ok(Date.now() < deadline, 'Concurrent native sender did not reach the host-owned entry barrier');
      await delay(10);
    }
  }
  call.handlerStartedAt = Date.now();
  return call;
}
export function end(call, result) {
  if (!call) return;
  const file = path.join(call.directory, call.id + '.json');
  fs.writeFileSync(file + '.part', JSON.stringify({ ...call, endedAt: Date.now(), result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr } }) + '\n');
  fs.renameSync(file + '.part', file);
}
