import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [operation, stageText, report] = process.argv.slice(2);
const stage = Number(stageText), own = path.dirname(report ?? '');
assert.ok(['wait', 'ack', 'report'].includes(operation));
assert.ok(Number.isInteger(stage) && stage >= 0 && stage <= 4);
assert.match(report ?? '', /^\/srv\/dev\/s72-[^/]+\/\.raf\/tmp\/[^/]+\/[^/]+\.json$/);
const atomic = (file, value) => {
  fs.writeFileSync(file + '.part', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.part', file);
};
if (operation === 'wait') {
  atomic(path.join(own, `sym72-ready-${stage}.json`), { stage, runId: path.basename(own), pid: process.pid });
  const deadline = Date.now() + 1200000;
  while (!fs.existsSync(path.join(own, `sym72-go-${stage}`))) {
    assert.ok(Date.now() < deadline, 'Host stage timed out; no retry or fabricated result');
    await delay(300);
  }
} else if (operation === 'ack') {
  atomic(path.join(own, `sym72-ack-${stage}.json`), { stage, runId: path.basename(own) });
} else {
  assert.equal(stage, 3);
  atomic(report, { status: 'succeeded', answer: 'Ізольований native QA актор виконав початковий незмінний план message/ps. Код не змінювався, власних комітів немає; контрольовані докази комітить хостовий QA.',
    changes: [{ id: 'sym72-fixture', items: [{ id: '1.1', status: 'succeeded' }] }], commits: [] });
  atomic(path.join(own, 'sym72-report-written.json'), { report, runId: path.basename(own) });
}
