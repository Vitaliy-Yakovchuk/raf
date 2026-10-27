import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fixture, timeoutMs } from './hotfix-fixture.ts';

for (const mode of ['passed', 'body-failed', 'setup-failed', 'cleanup-failed', 'service-record'] as const) {
  test(`[Z429] completed fixture group removes its own TMPDIR trees: ${mode}`, { timeout: timeoutMs }, t => {
    const root = mkdtempSync(join(tmpdir(), 'z429-'));
    const scratch = join(root, 'tmp');
    const tracked = join(root, 'roots.jsonl');
    const script = join(root, 'group.test.mjs');
    t.after(() => {
      for (const path of roots()) rmSync(path, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    function roots(): string[] {
      return existsSync(tracked) ? readFileSync(tracked, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    }
    const conf = join(root, 'conf');
    cpSync(process.env.HOTFIX_FIXTURE_CONF ?? new URL('../../conf/', import.meta.url), conf, { recursive: true });
    const constantsPath = join(conf, 'raf-constants.json');
    const constants = JSON.parse(readFileSync(constantsPath, 'utf8'));
    const testRun = constants.commands.find((command: { path: string[] }) => command.path.join(' ') === 'test run');
    testRun.examples = testRun.examples.map((example: string) => example.replace(/--project etchly(?=\s|$)/g, '--project raf'));
    writeFileSync(constantsPath, JSON.stringify(constants));
    writeFileSync(script, String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { fixture } from ${JSON.stringify(new URL('./hotfix-fixture.ts', import.meta.url).href)};
const mode=${JSON.stringify(mode)};
const scratch=${JSON.stringify(scratch)};
fs.mkdirSync(scratch);
const allocate=fs.mkdtempSync;
fs.mkdtempSync=(...args)=>{
 const path=allocate(...args);
 fs.appendFileSync(${JSON.stringify(tracked)},JSON.stringify(path)+'\n');
 return path;
};
if(mode==='setup-failed')fs.cpSync=()=>{throw new Error('Z429 intentional setup failure');};
syncBuiltinESMExports();
test('fixture consumer',async t=>{
 const f=await fixture(t);
 if(mode==='cleanup-failed'){
  const execute=childProcess.execFileSync;
  childProcess.execFileSync=(executable,args,...rest)=>{
   if(executable==='tmux'&&args.at(-1)==='kill-server')throw new Error('Z429 intentional cleanup failure');
   return execute(executable,args,...rest);
  };
  syncBuiltinESMExports();
 }
 if(mode==='service-record'){
  const service=childProcess.spawnSync(process.execPath,['--import',f.root+'/fixture-lifecycle.mjs','--input-type=module','--eval','',f.main+'/bin/service.ts'],{
   env:{...f.environment,NODE_OPTIONS:''},encoding:'utf8',timeout:f.budget
  });
  assert.equal(service.error,undefined);
  assert.equal(service.status,0,service.stderr);
  const record=fs.readFileSync(f.root+'/fixture-services.jsonl','utf8');
  assert.ok(record.endsWith('\n'),'the generated preload writes a JSONL newline');
  JSON.parse(record.trim());
 }
 if(mode==='body-failed')assert.fail('Z429 intentional body failure');
});
`);
    const environment = { ...process.env, TMPDIR: scratch, HOTFIX_FIXTURE_CONF: conf };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', script], {
      env: environment, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, mode.endsWith('-failed') ? 1 : 0, child.stdout + child.stderr);
    if (mode.endsWith('-failed')) {
      assert.match(child.stdout, new RegExp(`Z429 intentional ${mode.split('-')[0]} failure`));
    }
    const allocated = roots();
    assert.equal(allocated.filter(path => !path.split('/').at(-1)!.startsWith('hf-builds-')).length, 1, 'the nested test group must allocate a real hotfix fixture');
    assert.equal(allocated.filter(path => path.split('/').at(-1)!.startsWith('hf-builds-')).length, mode === 'setup-failed' ? 0 : 1, 'successful preparation allocates one separately cleaned build seed');
    assert.deepEqual(allocated.filter(path => existsSync(path)), [], 'completed fixture group must remove every owned tree, including failures');
    assert.deepEqual(allocated.map(path => dirname(path)), allocated.map(() => scratch), 'fixture trees and build seeds must stay inside the run TMPDIR');
    assert.deepEqual(readdirSync(scratch), [], 'the nested group must leave no fixture directories in TMPDIR');
  });
}

test('[5.14] unused fixture homes require no service CLI launches during cleanup', { timeout: timeoutMs }, async t => {
  const original = childProcess.execFileSync;
  const originalSpawn = childProcess.spawnSync;
  const commands: { args: string[]; elapsedMs: number }[] = [];
  t.mock.method(childProcess, 'execFileSync', function(executable: string, args: string[], options: any) {
    const started = performance.now();
    try { return original(executable, args, options); }
    finally { commands.push({ args, elapsedMs: performance.now() - started }); }
  });
  t.mock.method(childProcess, 'spawnSync', function(executable: string, args: string[], options: any) {
    const started = performance.now();
    try { return originalSpawn(executable, args, options); }
    finally { commands.push({ args, elapsedMs: performance.now() - started }); }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const hooks: (() => Promise<void>)[] = [];
  const f = await fixture({ after: hook => hooks.push(hook) } as TestContext);
  assert.equal(existsSync(f.root), true);
  const cleanupStarted = performance.now();
  for (const hook of hooks) await hook();
  const stops = commands.filter(entry => entry.args.includes('service') && entry.args.includes('stop'));
  t.diagnostic(JSON.stringify({ cleanupMs: performance.now() - cleanupStarted, stops, commandMs: commands.reduce((sum, entry) => sum + entry.elapsedMs, 0) }));
  assert.equal(existsSync(f.root), false, 'cleanup still removes its own unused home');
  assert.equal(stops.length, 0, 'homes that never owned a service must not launch full service stop commands');
});
