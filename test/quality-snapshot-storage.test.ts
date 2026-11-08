import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createQualityRuntime } from '../src/test-run-quality-runtime.ts';
import type { TestRunConfig, TestRunContext, TestRunPlan, TestRunResult } from '../src/test-runs.ts';

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'quality-storage-test-'));
  const workspace = join(root, 'workspace');
  const temporary = join(root, 'reserved-tmp');
  fs.mkdirSync(workspace); fs.mkdirSync(temporary);
  const put = (path: string, content: string) => { const target = join(workspace, path); fs.mkdirSync(dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  const source = 'export function value() { return true; }';
  put('.gitignore', 'node_modules/\n');
  put('src/value.ts', source);
  put('test/value.test.ts', 'import { value } from "../src/value.ts";');
  put('docs/qa/old-run/large.json', 'historical evidence');
  put('node_modules/tool/bin/tool', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(join(workspace, 'node_modules/tool/bin/tool'), 0o755);
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const request = { version: 1, mode: 'baseline', source: { baseRevision: revision, revision, files: [{ path: 'src/value.ts', sha256: createHash('sha256').update(source).digest('hex') }] }, changedFunctions: [{ id: 'value', path: 'src/value.ts', startByte: 0, endByte: Buffer.byteLength(source) }] };
  put('request.json', JSON.stringify(request));
  const profile = { cwd: '.', resultAdapter: 'node-test-events', quality: { sourceAdapter: { id: 'node-source', version: process.version }, siteSelector: { id: 'typescript-function', version: '1' }, coverage: { producer: 'node-v8', version: process.version, adapter: 'v8', format: 'v8' } } };
  const config = { projects: { fixture: { profiles: { node: profile } } } } as unknown as TestRunConfig;
  const context = { workspace, tmpPath: temporary, home: root } as TestRunContext;
  const plan = { request: { project: 'fixture', group: 'change/storage' }, profileId: 'node', selection: { files: ['test/value.test.ts'], testIds: [] }, command: { executable: process.execPath, argv: [], cwd: workspace, shell: false, environment: { HOME: root, tmpPath: temporary, statePath: join(root, 'state'), TMPDIR: temporary } } } as unknown as TestRunPlan;
  const commitInputs = () => {
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'runtime fixture');
    const committed = git('rev-parse', 'HEAD');
    request.source.revision = committed;
    put('request.json', JSON.stringify(request));
  };
  const prepare = (runId = 'run-storage') => createQualityRuntime(config)('request.json', plan, context, runId);
  return { root, workspace, temporary, put, prepare, commitInputs, git, source, revision, plan, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('quality copy uses workspace data volume and omits unread QA evidence without deleting it', async () => {
  const f = fixture();
  try {
    const execution = await f.prepare();
    const copy = execution.command.cwd;
    try {
      assert.equal(dirname(copy), dirname(f.workspace));
      assert.equal(fs.existsSync(join(copy, 'docs/qa/old-run/large.json')), false);
      assert.equal(fs.readFileSync(join(f.workspace, 'docs/qa/old-run/large.json'), 'utf8'), 'historical evidence');
      assert.equal(fs.statSync(join(copy, 'node_modules/tool/bin/tool')).mode & 0o777, 0o755);
      fs.writeFileSync(join(copy, 'src/value.ts'), 'mutated');
      assert.match(fs.readFileSync(join(f.workspace, 'src/value.ts'), 'utf8'), /return true/);
    } finally { await execution.cleanup(true); }
    assert.equal(fs.existsSync(copy), false);
  } finally { f.cleanup(); }
});

test('quality copy keeps QA data explicitly read by a selected runtime input', async () => {
  const f = fixture();
  try {
    f.put('test/value.test.ts', 'readFileSync("docs/qa/old-run/large.json")');
    f.commitInputs();
    const execution = await f.prepare();
    try { assert.equal(fs.readFileSync(join(execution.command.cwd, 'docs/qa/old-run/large.json'), 'utf8'), 'historical evidence'); }
    finally { await execution.cleanup(true); }
  } finally { f.cleanup(); }
});

test('dependency snapshot and copy do not materialize full-file buffers', async () => {
  const f = fixture();
  const original = fs.readFileSync;
  try {
    fs.readFileSync = function(path: any, ...args: any[]) {
      if (typeof path === 'string' && path.endsWith('node_modules/tool/bin/tool')) assert.fail('dependency buffered in RAM');
      return (original as any)(path, ...args);
    } as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const execution = await f.prepare();
    await execution.cleanup(true);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); f.cleanup(); }
});

test('copy errors identify operation, input, destination and original errno', async () => {
  const f = fixture();
  const original = fs.copyFileSync;
  try {
    fs.copyFileSync = ((source: any, destination: any, mode?: number) => {
      if (String(source).includes('node_modules')) throw Object.assign(new Error('quota exhausted'), { code: 'EDQUOT', errno: -122, syscall: 'copyfile' });
      return original(source, destination, mode);
    }) as typeof fs.copyFileSync;
    syncBuiltinESMExports();
    await assert.rejects(f.prepare(), error => {
      assert.match(String(error), /EDQUOT/);
      assert.match(String(error), /src\/value\.ts|docs\/qa|node_modules|request\.json|test\/value/);
      assert.match(String(error), /copy/);
      assert.match(String(error), new RegExp(f.workspace));
      assert.equal((error as NodeJS.ErrnoException).errno, -122);
      return true;
    });
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.raf-quality-')), false);
  } finally { fs.copyFileSync = original; syncBuiltinESMExports(); f.cleanup(); }
});

test('parallel source writes during copy cannot change the committed snapshot', async () => {
  const f = fixture();
  const original = fs.copyFileSync;
  try {
    fs.copyFileSync = function(source: any, destination: any, mode?: number) {
      if (String(source).endsWith('src/value.ts')) {
        const writer = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "export function value() { return false; }")', join(f.workspace, 'src/value.ts')]);
        assert.equal(writer.status, 0);
      }
      return original(source, destination, mode);
    };
    syncBuiltinESMExports();
    const execution = await f.prepare();
    try {
      assert.equal(fs.readFileSync(join(execution.command.cwd, 'src/value.ts'), 'utf8'), f.source);
      assert.match(fs.readFileSync(join(f.workspace, 'src/value.ts'), 'utf8'), /return false/);
    }
    finally { await execution.cleanup(true); }
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.raf-quality-')), false);
  } finally { fs.copyFileSync = original; syncBuiltinESMExports(); f.cleanup(); }
});

test('QA data read through path.join remains available to runtime', async () => {
  const f = fixture();
  try {
    f.put('test/value.test.ts', 'readFileSync(join("docs", "qa", "old-run", "large.json"))');
    f.commitInputs();
    const execution = await f.prepare();
    try { assert.equal(fs.readFileSync(join(execution.command.cwd, 'docs/qa/old-run/large.json'), 'utf8'), 'historical evidence'); }
    finally { await execution.cleanup(true); }
  } finally { f.cleanup(); }
});

test('unrelated QA producer references do not pull its historical output into unit runtime', async () => {
  const f = fixture();
  try {
    f.put('tools/browser-qa.ts', 'writeFileSync("docs/qa/old-run/large.json", output)');
    const execution = await f.prepare();
    try { assert.equal(fs.existsSync(join(execution.command.cwd, 'docs/qa/old-run/large.json')), false); }
    finally { await execution.cleanup(true); }
  } finally { f.cleanup(); }
});


test('moving branch HEAD and dirty source/test/config do not change the requested commit', async () => {
  const f = fixture();
  try {
    f.put('src/value.ts', 'export function value() { return false; }');
    f.git('add', '.');
    f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'parallel agent');
    f.put('test/value.test.ts', 'throw new Error("dirty test")');
    f.put('.gitignore', 'dirty config');
    f.put('src/untracked.ts', 'untracked source');
    const execution = await f.prepare();
    try {
      assert.equal(fs.readFileSync(join(execution.command.cwd, 'src/value.ts'), 'utf8'), f.source);
      assert.equal(fs.readFileSync(join(execution.command.cwd, 'test/value.test.ts'), 'utf8'), 'import { value } from "../src/value.ts";');
      assert.equal(fs.readFileSync(join(execution.command.cwd, '.gitignore'), 'utf8'), 'node_modules/\n');
      assert.equal(fs.existsSync(join(execution.command.cwd, 'src/untracked.ts')), false);
    } finally { await execution.cleanup(true); }
  } finally { f.cleanup(); }
});


test('an existing commit outside the canonical branch history remains unauthorized', async () => {
  const f = fixture();
  try {
    f.git('checkout', '--orphan', 'unrelated');
    f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'unrelated history');
    await assert.rejects(f.prepare(), /Source\/base revision does not match canonical Git workspace/);
  } finally { f.cleanup(); }
});


test('seal uses committed bytes for node_modules aliases while another process writes tracked source', async () => {
  const f = fixture();
  const originalOpen = fs.openSync;
  let wrote = false;
  try {
    fs.symlinkSync('../src', join(f.workspace, 'node_modules/linked-source'));
    fs.openSync = function(path: any, ...args: any[]) {
      if (!wrote && String(path).endsWith('node_modules/tool/bin/tool')) {
        wrote = true;
        const writer = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "export function value() { return false; }")', join(f.workspace, 'src/value.ts')]);
        assert.equal(writer.status, 0);
      }
      return (originalOpen as any)(path, ...args);
    } as typeof fs.openSync;
    syncBuiltinESMExports();
    const execution = await f.prepare();
    try {
      assert.equal(wrote, true);
      assert.match(fs.readFileSync(join(f.workspace, 'src/value.ts'), 'utf8'), /return false/);
      for (const path of ['src/value.ts', 'node_modules/linked-source/value.ts']) {
        assert.equal(fs.readFileSync(join(execution.command.cwd, path), 'utf8'), f.source);
      }
    } finally { await execution.cleanup(true); }
  } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); f.cleanup(); }
});

test('seal still rejects parallel changes to dependencies absent from the commit', async () => {
  const f = fixture();
  const originalOpen = fs.openSync;
  let reads = 0;
  try {
    fs.openSync = function(path: any, ...args: any[]) {
      if (String(path).endsWith('node_modules/tool/bin/tool')) {
        reads += 1;
        if (reads === 2) fs.writeFileSync(join(f.workspace, 'node_modules/tool/bin/tool'), 'changed dependency');
      }
      return (originalOpen as any)(path, ...args);
    } as typeof fs.openSync;
    syncBuiltinESMExports();
    await assert.rejects(f.prepare(), /Source changed during snapshot seal/);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.raf-quality-')), false);
  } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); f.cleanup(); }
});


for (const shared of [false, true]) test('overlay reuses the sealed baseline inputs after live dependencies and branch move' + (shared ? ' with shared-libs' : ''), async () => {
  const f = fixture();
  try {
    const library = join(f.root, 'libraries');
    if (shared) {
      fs.mkdirSync(library);
      fs.writeFileSync(join(library, 'value.js'), 'export const value = 7;');
      fs.symlinkSync('../libraries', join(f.workspace, 'shared-libs'));
      f.commitInputs();
      fs.mkdirSync(join(f.root, 'conf'));
      fs.writeFileSync(join(f.root, 'conf/projects.json'), JSON.stringify({ projects: {
        fixture: { usesSharedLibs: true, branchPaths: { main: 'workspace' } },
        'shared-libs': { branchPaths: { main: 'libraries' } },
      }, layout: { sharedLibrariesLink: 'shared-libs', sharedLibrariesTarget: '../shared-libs-{branch}' } }));
    }
    const baseline = await f.prepare();
    const settings = JSON.parse(fs.readFileSync(baseline.command.environment.qualitySettings!, 'utf8'));
    const target = join(baseline.command.cwd, 'src/value.ts');
    fs.writeFileSync(join(settings.coverageRoot, 'coverage.json'), JSON.stringify({ result: [{ url: new URL('file://' + target).href, functions: [{ ranges: [{ startOffset: 0, endOffset: f.source.length, count: 1 }] }] }] }));
    const result = { runId: 'run-storage', outcome: 'passed', exitCode: 0, timedOut: false, cleanup: { complete: true, remainingPids: [] }, unknown: [], unexecuted: [], startedAt: new Date().toISOString() } as unknown as TestRunResult;
    await baseline.finish(result, [{ kind: 'complete', expected: [{ file: 'test/value.test.ts', name: 'value' }] }]);
    assert.equal(result.quality!.reason, null);
    await baseline.cleanup(true);
    if (shared) fs.rmSync(library, { recursive: true });
    f.put('node_modules/tool/bin/tool', 'changed dependency');
    f.put('node_modules/new-package/index.js', 'new dependency');
    f.put('test/value.test.ts', 'dirty tests');
    f.git('add', 'test/value.test.ts');
    f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'parallel tests');
    const request = JSON.parse(fs.readFileSync(join(f.workspace, 'request.json'), 'utf8'));
    const startByte = f.source.indexOf('true');
    Object.assign(request, { mode: 'mutant', baselineRunId: 'run-storage', mutant: { siteId: `src/value.ts:${startByte}:${startByte + 4}:false`, functionId: 'value', path: 'src/value.ts', startByte, endByte: startByte + 4, beforeBase64: Buffer.from('true').toString('base64'), afterBase64: Buffer.from('false').toString('base64') } });
    f.put('request.json', JSON.stringify(request));
    fs.rmSync(join(f.temporary, 'quality-loads.ndjson'));
    fs.rmSync(join(f.temporary, 'quality-settings.json'));
    fs.rmSync(join(f.temporary, 'quality-coverage'), { recursive: true });
    const overlay = await f.prepare('overlay');
    try {
      if (shared) assert.equal(fs.readFileSync(join(overlay.command.cwd, 'shared-libs/value.js'), 'utf8'), 'export const value = 7;');
      assert.equal(fs.readFileSync(join(overlay.command.cwd, 'src/value.ts'), 'utf8'), f.source.replace('true', 'false'));
      assert.equal(fs.readFileSync(join(overlay.command.cwd, 'node_modules/tool/bin/tool'), 'utf8'), '#!/bin/sh\nexit 0\n');
      assert.equal(fs.existsSync(join(overlay.command.cwd, 'node_modules/new-package')), false);
      assert.equal(fs.readFileSync(join(overlay.command.cwd, 'test/value.test.ts'), 'utf8'), 'import { value } from "../src/value.ts";');
    } finally { await overlay.cleanup(true); }
    f.plan.selection.files = ['test/another.test.ts'];
    await assert.rejects(f.prepare('changed-selection'), /Baseline provenance mismatch/);
    f.plan.selection.files = ['test/value.test.ts'];
    const snapshots = join(f.root, '.raf-baselines');
    const sealedRoot = join(snapshots, fs.readdirSync(snapshots)[0], 'run-storage');
    fs.writeFileSync(join(sealedRoot, 'inputs/node_modules/tool/bin/tool'), 'corrupted seal');
    await assert.rejects(f.prepare('corrupted'), /Baseline snapshot input changed/);
  } finally { f.cleanup(); }
});
