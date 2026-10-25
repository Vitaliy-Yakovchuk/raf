import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const [operation, report, value] = process.argv.slice(2);
assert.ok(path.isAbsolute(report));
const own = path.dirname(report);
assert.match(own, /^\/tmp\/ar41-[^/]+\/\.raf\/tmp\/[a-f0-9-]+$/);
const write = (name, data) => {
  const file = path.join(own, 'ar41-' + name + '.json');
  fs.writeFileSync(file + '.part', JSON.stringify(data) + '\n');
  fs.renameSync(file + '.part', file);
};
const identity = { runId: path.basename(own), cwd: process.cwd(), pid: process.pid };
if (operation === 'plan') {
  assert.ok(['1', '2', '3'].includes(value));
  write('ready-' + value, identity);
  const file = path.join(own, 'ar41-plan-' + value + '.json');
  const end = Date.now() + 900000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < end, 'Host plan deadline exceeded; do not retry');
    await delay(200);
  }
  console.log(fs.readFileSync(file, 'utf8'));
} else if (operation === 'done' || operation === 'receive') {
  assert.match(value ?? '', /^[a-z0-9-]+$/);
  write(operation + '-' + value, identity);
  console.log(JSON.stringify({ operation, token: value, ...identity }));
} else throw Error('Unknown actor operation');
