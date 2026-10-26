import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { childMessage, fixture, git, timeoutMs } from './hotfix-fixture.ts';
import { fixtureSeed } from './hotfix-fixture-seed.ts';

test('[5.13] identical hotfix fixtures build once across fixtures and nested regression processes while retaining independent files and Git state', { timeout: timeoutMs }, async t => {
  const original = childProcess.execFileSync;
  const timings: { command: string; elapsedMs: number }[] = [];
  t.mock.method(childProcess, 'execFileSync', function(executable: string, args: string[], options: any) {
    const started = performance.now();
    try { return original(executable, args, options); }
    finally { timings.push({ command: [executable, ...args].join(' '), elapsedMs: performance.now() - started }); }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = await fixture(t);
  const second = await fixture(t);
  const catalogPath = join('dist', 'catalog.json');
  const baseline = readFileSync(join(second.main, catalogPath), 'utf8');
  assert.equal(readFileSync(join(first.main, catalogPath), 'utf8'), baseline);
  for (const path of ['src/catalog.ts', 'scripts/build.ts', catalogPath]) {
    assert.notEqual(statSync(join(first.main, path)).ino, statSync(join(second.main, path)).ino, path);
  }
  writeFileSync(join(first.main, catalogPath), 'mutated catalog');
  writeFileSync(join(first.hotfix, 'hotfix-fixture/a.mjs'), 'independent change\n');
  git(first.hotfix, first.environment, 'add', '--', 'hotfix-fixture/a.mjs');
  git(first.hotfix, first.environment, 'commit', '-m', 'independent fixture commit');
  assert.equal(readFileSync(join(second.main, catalogPath), 'utf8'), baseline);
  assert.equal(git(second.hotfix, second.environment, 'rev-parse', 'HEAD'), second.baseCommit);
  assert.equal(git(second.hotfix, second.environment, 'status', '--porcelain'), '');
  const child = second.forkModule(`
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fixture} from ${JSON.stringify(join(second.main, 'test/hotfix-fixture.ts'))};
const original=childProcess.execFileSync;
let builds=0;
childProcess.execFileSync=function(executable,args,options){if(args[0]==='scripts/build.ts')builds++;return original(executable,args,options);};
syncBuiltinESMExports();
const hooks=[];
const f=await fixture({after:hook=>hooks.push(hook)});
const catalog=fs.readFileSync(f.main+'/dist/catalog.json','utf8');
for(const hook of hooks)await hook();
await new Promise((resolve,reject)=>process.send({kind:'fixture-built',builds,catalogHash:createHash('sha256').update(catalog).digest('hex')},error=>error?reject(error):resolve()));
process.disconnect();`, {});
  const nested = await childMessage(child, value => value.kind === 'fixture-built', timeoutMs);
  assert.equal(nested.catalogHash, createHash('sha256').update(baseline).digest('hex'));
  const builds = timings.filter(entry => entry.command.endsWith(' scripts/build.ts'));
  t.diagnostic(JSON.stringify({ builds, nestedBuilds: nested.builds, totalCommandMs: timings.reduce((sum, entry) => sum + entry.elapsedMs, 0) }));
  assert.equal(builds.length + nested.builds, 1, `one actual scripts/build.ts execution for unchanged fixture inputs in a run: ${JSON.stringify({ builds, nestedBuilds: nested.builds, totalCommandMs: timings.reduce((sum, entry) => sum + entry.elapsedMs, 0) })}`);
});

test('[5.13] fixture build reuse invalidates changed source, dependency and configuration bytes and never accepts a failed build', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hf-seed-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const conf = join(root, 'conf');
  for (const path of ['src', 'node_modules/dependency']) mkdirSync(join(source, path), { recursive: true });
  mkdirSync(conf);
  const paths = [join(source, 'src/input.ts'), join(source, 'node_modules/dependency/index.js'), join(conf, 'settings.json')];
  for (const path of paths) writeFileSync(path, '{}');
  let builds = 0;
  const build = (main: string) => {
    builds++;
    writeFileSync(join(main, 'artifact'), String(builds));
  };
  let seed = await fixtureSeed(source, conf, build);
  assert.equal(readFileSync(join(seed.main, 'artifact'), 'utf8'), '1');
  assert.equal((await fixtureSeed(source, conf, build)).main, seed.main);
  assert.equal(builds, 1);
  for (const path of paths) {
    writeFileSync(path, '{"changed":true}');
    const changed = await fixtureSeed(source, conf, build);
    assert.notEqual(changed.main, seed.main, path);
    assert.equal(readFileSync(join(changed.main, 'artifact'), 'utf8'), String(builds));
    seed = changed;
  }
  assert.equal(builds, 4);
  writeFileSync(paths[0], 'failed input');
  await assert.rejects(fixtureSeed(source, conf, () => { throw new Error('controlled build failure'); }), /controlled build failure/);
  await assert.rejects(fixtureSeed(source, conf, build), /controlled build failure/);
  assert.equal(builds, 4, 'failed build state must not publish or reuse an artifact');
});
