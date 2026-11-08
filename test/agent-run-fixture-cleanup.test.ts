import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const mode of ['passed', 'setup-failed', 'body-failed', 'no-proc'] as const) {
  test(`agent fixture removes temporary directories on two runs: ${mode}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'raf-tmp-cleanup-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scratch = join(root, 'tmp');
    mkdirSync(scratch);
    const sibling = 'raf-lfc-other-run';
    mkdirSync(join(scratch, sibling));
    const script = join(root, 'fixture.test.mjs');
    writeFileSync(script, `
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { agentRunFixture } from ${JSON.stringify(new URL('./agent-run-fixture.ts', import.meta.url).href)};
const mode = ${JSON.stringify(mode)};
if (mode === 'setup-failed') {
  const mkdir = fs.mkdir;
  fs.mkdir = async (path, ...args) => {
    if (String(path).endsWith('/orchestrator/conf')) throw new Error('intentional setup failure');
    return mkdir(path, ...args);
  };
}
if (mode === 'no-proc') {
  const readdir = fs.readdir;
  fs.readdir = async (path, ...args) => {
    if (path === '/proc') throw Object.assign(new Error('no proc filesystem on macOS'), { code: 'ENOENT' });
    return readdir(path, ...args);
  };
}
test('fixture consumer', async t => {
  const fixture = await agentRunFixture(t, 'silent', { startupMs: 1000, transitionMs: 1000, overallMs: 3000 });
  assert.ok((await fs.readdir(${JSON.stringify(scratch)})).some(name => name.startsWith('raf-lfc-') && name !== ${JSON.stringify(sibling)}));
  if (mode === 'no-proc') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { ...process.env, RAF_AGENT_RUN_FIXTURE: fixture.directory + '/fixture.json' }, stdio: 'ignore'
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    t.after(async () => {
      try { assert.equal(child.signalCode, 'SIGKILL', 'cleanup terminates its marked process without /proc'); }
      finally { child.kill('SIGKILL'); await exited; }
    });
  }
  if (mode === 'body-failed') assert.fail('intentional body failure');
});
`);
    for (let run = 1; run <= 2; run++) {
      const environment = { ...process.env, TMPDIR: scratch };
      delete environment.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', script], {
        env: environment, encoding: 'utf8', maxBuffer: 1024 * 1024
      });
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null, child.stderr);
      assert.equal(child.status, mode.endsWith('-failed') ? 1 : 0, child.stdout + child.stderr);
      if (mode.endsWith('-failed')) assert.match(child.stdout, new RegExp(`intentional ${mode.split('-')[0]} failure`));
      assert.deepEqual(readdirSync(scratch), [sibling], `run ${run} leaves no new fixture directories and preserves other runs`);
    }
  });
}
