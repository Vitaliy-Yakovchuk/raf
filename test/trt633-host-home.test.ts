import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { verifyPreparedHostHome } from './helpers/trt633-host-home.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trt633-guards-'));
  const source = path.join(base, 'owner/raf-develop');
  fs.mkdirSync(path.join(source, 'test/helpers'), { recursive: true });
  fs.copyFileSync(path.join(repository, 'test/trt633-host-qa.mjs'), path.join(source, 'test/trt633-host-qa.mjs'));
  const helper = path.join(repository, 'test/helpers/trt633-host-home.ts');
  if (fs.existsSync(helper)) fs.copyFileSync(helper, path.join(source, 'test/helpers/trt633-host-home.ts'));
  const home = fs.mkdtempSync(path.join(base, 'TRT633-'));
  const evidence = path.join(base, 'evidence');
  const codexHome = path.join(base, 'owner-codex');
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[projects."/ordinary/project"]\ntrust_level = "trusted"\n');
  const env = { ...process.env, HOME: home, RAF_QA_HOME: home, TMPDIR: home, CODEX_HOME: codexHome };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const run = (mode = 'prepare') => spawnSync(process.execPath, [path.join(source, 'test/trt633-host-qa.mjs'), mode, ...(mode === 'host' ? ['a'.repeat(40)] : []), evidence], { env, encoding: 'utf8', timeout: 10000 });
  return { base, source, home, evidence, codexHome, env, run };
}

test('TRT633 H01 prepare isolates HOME and leaves ordinary owner Codex configuration untouched', t => {
  const f = fixture(t);
  const config = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.home, f.home);
  assert.equal(prepared.tmpdir, f.home);
  assert.equal(prepared.codexHome, f.codexHome);
  assert.equal(prepared.provenance.uid, process.getuid!());
  assert.equal(prepared.provenance.emptyAtPreparation, true);
  assert.equal(prepared.provenance.canonicalHome, f.home);
  assert.deepEqual(fs.readdirSync(f.home), ['.trt633-prepared.json']);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), config);
  assert.deepEqual(fs.readdirSync(f.codexHome), ['config.toml']);
  assert.equal(fs.existsSync(f.evidence), false);
});

test('TRT633 H02 selected filesystem may be /srv/dev rather than /tmp', t => {
  const f = fixture(t);
  const selected = fs.mkdtempSync(path.join(repository, 'TRT633-'));
  t.after(() => fs.rmSync(selected, { recursive: true, force: true }));
  Object.assign(f.env, { HOME: selected, RAF_QA_HOME: selected, TMPDIR: selected });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.home, selected);
  assert.equal(prepared.provenance.device, fs.statSync(selected).dev);
});

for (const key of ['HOME', 'RAF_QA_HOME', 'TMPDIR']) test(`TRT633 H03 refuses unequal or missing ${key} before writing`, t => {
  const f = fixture(t);
  f.env[key] = '';
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HOME=RAF_QA_HOME=TMPDIR/);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.equal(fs.existsSync(f.evidence), false);
});

for (const kind of ['symlink', 'ancestor-symlink', 'relative', 'noncanonical', 'missing', 'file', 'nonempty', 'shared', 'prefix', 'source', 'operational', 'long-socket']) test(`TRT633 H04 refuses ${kind} HOME before creating stand state`, t => {
  const f = fixture(t);
  let selected = f.home;
  if (kind === 'symlink') { selected = path.join(f.base, 'TRT633-link01'); fs.symlinkSync(f.home, selected); }
  if (kind === 'ancestor-symlink') { fs.symlinkSync(f.base, path.join(f.base, 'link')); selected = path.join(f.base, 'link', path.basename(f.home)); }
  if (kind === 'relative') selected = path.relative(process.cwd(), f.home);
  if (kind === 'noncanonical') selected += '/';
  if (kind === 'missing') selected = path.join(f.base, 'TRT633-absent');
  if (kind === 'file') { selected = path.join(f.base, 'TRT633-file00'); fs.writeFileSync(selected, 'sentinel'); }
  if (kind === 'shared') fs.chmodSync(selected, 0o755);
  if (kind === 'nonempty') fs.writeFileSync(path.join(selected, 'sentinel'), 'keep');
  if (kind === 'prefix') { selected = path.join(f.base, 'unrelated'); fs.mkdirSync(selected); }
  if (kind === 'source') { selected = path.join(f.source, 'TRT633-source'); fs.mkdirSync(selected); }
  if (kind === 'operational') selected = '/proc/TRT633-unsafe';
  if (kind === 'long-socket') { const parent = path.join(f.base, 'x'.repeat(100)); fs.mkdirSync(parent); selected = fs.mkdtempSync(path.join(parent, 'TRT633-')); }
  Object.assign(f.env, { HOME: selected, RAF_QA_HOME: selected, TMPDIR: selected });
  const before = fs.readdirSync(f.home);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRT633 setup:/);
  assert.deepEqual(fs.readdirSync(f.home), before);
  assert.equal(fs.existsSync(f.evidence), false);
});

for (const kind of ['inside-home', 'same-home', 'existing', 'symlink-parent', 'dangling-symlink']) test(`TRT633 H05 refuses ${kind} evidence`, t => {
  const f = fixture(t);
  if (kind === 'inside-home') f.evidence = path.join(f.home, 'evidence');
  if (kind === 'same-home') f.evidence = f.home;
  if (kind === 'existing') fs.mkdirSync(f.evidence);
  if (kind === 'dangling-symlink') fs.symlinkSync(path.join(f.base, 'missing-target'), f.evidence);
  if (kind === 'symlink-parent') { fs.symlinkSync(f.base, path.join(f.base, 'link')); f.evidence = path.join(f.base, 'link/evidence'); }
  const result = spawnSync(process.execPath, [path.join(f.source, 'test/trt633-host-qa.mjs'), 'prepare', f.evidence], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRT633 setup:.*evidence/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

for (const selector of ['inherited', 'unset']) test(`TRT633 H06 uses ordinary Codex with ${selector} CODEX_HOME without separate login`, t => {
  const f = fixture(t);
  if (selector === 'unset') delete f.env.CODEX_HOME;
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const prepared = verifyPreparedHostHome({ env: f.env, source: f.source, ownerRoot: path.dirname(f.source), evidence: f.evidence });
  assert.equal(prepared.codexHome, selector === 'inherited' ? f.codexHome : path.join(os.userInfo().homedir, '.codex'));
  assert.deepEqual(fs.readdirSync(f.home), ['.trt633-prepared.json']);
  assert.deepEqual(fs.readdirSync(f.codexHome), ['config.toml']);
});

test('TRT633 H07 prepared HOME cannot be prepared again or silently reused with a missing provenance marker', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const repeated = f.run();
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /TRT633 setup:.*empty/);
  fs.unlinkSync(path.join(f.home, '.trt633-prepared.json'));
  const result = f.run('host');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRT633 setup:.*preparation/);
  assert.equal(fs.existsSync(f.evidence), false);
  assert.equal(fs.existsSync(path.join(f.home, 'root')), false);
});

for (const kind of ['uid', 'inode', 'device', 'missing-marker', 'unexpected-entry', 'marker-symlink', 'marker-hardlink', 'marker-public', 'codex-selector']) test(`TRT633 H08 refuses ${kind} after explicit preparation before any live launch`, t => {
  const f = fixture(t);
  const prepared = f.run();
  assert.equal(prepared.status, 0, prepared.stderr);
  const marker = path.join(f.home, '.trt633-prepared.json');
  if (['uid', 'inode', 'device'].includes(kind)) {
    const provenance = JSON.parse(fs.readFileSync(marker, 'utf8'));
    provenance.provenance[kind] += 1;
    fs.writeFileSync(marker, JSON.stringify(provenance));
  }
  if (kind === 'missing-marker') fs.unlinkSync(marker);
  if (kind === 'unexpected-entry') fs.mkdirSync(path.join(f.home, 'root'));
  if (kind === 'marker-symlink') { const moved = path.join(f.base, 'other-marker'); fs.renameSync(marker, moved); fs.symlinkSync(moved, marker); }
  if (kind === 'marker-hardlink') fs.linkSync(marker, path.join(f.base, 'linked-marker'));
  if (kind === 'marker-public') fs.chmodSync(marker, 0o644);
  if (kind === 'codex-selector') f.env.CODEX_HOME = path.join(f.base, 'changed-selector');
  const result = f.run('host');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRT633 setup:/);
  assert.equal(fs.existsSync(f.evidence), false);
  assert.equal(fs.existsSync(path.join(f.home, '.raf')), false);
});

test('TRT633 H09 preparation does not inspect or impose a credentials store on ordinary Codex', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  fs.symlinkSync(path.join(f.base, 'unavailable-auth'), path.join(f.codexHome, 'auth.json'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => verifyPreparedHostHome({ env: f.env, source: f.source, ownerRoot: path.dirname(f.source), evidence: f.evidence }));
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "keyring"\n');
  assert.equal(fs.lstatSync(path.join(f.codexHome, 'auth.json')).isSymbolicLink(), true);
});

test('TRT633 H10 host passes ordinary Codex selector with isolated HOME and never invokes login', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.codexHome, 'config.toml'), '[model_providers.fixture]\ntoken = "fixture-private-setting"\n');
  const config = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  const trustAddedByCodex = '[projects."/new/stand/cwd"]\ntrust_level = "trusted"\n';
  const bin = path.join(f.base, 'bin'), calls = path.join(f.base, 'calls.jsonl');
  fs.mkdirSync(bin);
  const executable = '#!' + process.execPath + '\n' + `
import fs from 'node:fs';
import path from 'node:path';
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool, args, HOME: process.env.HOME, RAF_QA_HOME: process.env.RAF_QA_HOME, TMPDIR: process.env.TMPDIR, CODEX_HOME: process.env.CODEX_HOME }) + '\\n');
if (tool === 'codex') {
  fs.appendFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), ${JSON.stringify(trustAddedByCodex)});
  process.exit(23);
}
if (tool === 'git' && args.includes('rev-parse')) console.log('a'.repeat(40));
`;
  for (const tool of ['git', 'node', 'tmux', 'codex', 'uname']) fs.writeFileSync(path.join(bin, tool), executable, { mode: 0o700 });
  f.env.PATH = bin;
  assert.equal(f.run().status, 0);
  const result = f.run('host');
  assert.notEqual(result.status, 0, 'controlled version probe ends fixture before a live runner');
  assert.equal(result.error, undefined, result.error?.message);
  const rows = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.filter(row => row.tool === 'codex').map(row => row.args), [['--version']]);
  for (const row of rows) {
    assert.equal(row.HOME, f.home);
    assert.equal(row.RAF_QA_HOME, f.home);
    assert.equal(row.TMPDIR, f.home);
    assert.equal(row.CODEX_HOME, f.codexHome);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(f.evidence, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed', 'mock version refusal is setup evidence, never live QA');
  assert.equal(summary.selectedEnvironment.codexHome, f.codexHome);
  assert.equal(summary.codexAuthorization.credentialOrigin, 'ordinary owner Codex; no separate login');
  assert.equal(summary.codexTrust.before.configPath, path.join(f.codexHome, 'config.toml'));
  assert.deepEqual(summary.codexTrust.before.entries, ['[projects."/ordinary/project"]', 'trust_level = "trusted"']);
  assert.deepEqual(summary.codexTrust.after.entries, [...summary.codexTrust.before.entries, '[projects."/new/stand/cwd"]', 'trust_level = "trusted"']);
  assert.equal(JSON.stringify(summary.codexTrust).includes('fixture-private-setting'), false);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), config + trustAddedByCodex, 'host observes Codex trust additions without restoring config');
  assert.equal(fs.existsSync(path.join(f.home, '.codex')), false);
});
