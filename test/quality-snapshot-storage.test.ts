import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createQualityRuntime } from '../src/test-run-quality-runtime.ts';
import type { TestRunConfig, TestRunContext, TestRunPlan } from '../src/test-runs.ts';

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
  const prepare = () => createQualityRuntime(config)('request.json', plan, context, 'run-storage');
  return { root, workspace, temporary, put, prepare, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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
    fs.copyFileSync = (() => { throw Object.assign(new Error('quota exhausted'), { code: 'EDQUOT', errno: -122, syscall: 'copyfile' }); }) as typeof fs.copyFileSync;
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

test('source changed after seal is rejected during private copy and cleaned up', async () => {
  const f = fixture();
  const original = fs.copyFileSync;
  try {
    fs.copyFileSync = function(source: any, destination: any, mode?: number) {
      if (String(source).endsWith('src/value.ts')) fs.writeFileSync(source, 'export function value() { return false; }');
      return original(source, destination, mode);
    };
    syncBuiltinESMExports();
    await assert.rejects(f.prepare(), /Source changed during snapshot copy/);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.raf-quality-')), false);
  } finally { fs.copyFileSync = original; syncBuiltinESMExports(); f.cleanup(); }
});

test('QA data read through path.join remains available to runtime', async () => {
  const f = fixture();
  try {
    f.put('test/value.test.ts', 'readFileSync(join("docs", "qa", "old-run", "large.json"))');
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
