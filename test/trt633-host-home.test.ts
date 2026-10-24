import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

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
  const env = { ...process.env, HOME: home, RAF_QA_HOME: home, TMPDIR: home, CODEX_HOME: path.join(home, '.codex') };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const run = (mode = 'prepare') => spawnSync(process.execPath, [path.join(source, 'test/trt633-host-qa.mjs'), mode, ...(mode === 'host' ? ['a'.repeat(40)] : []), evidence], { env, encoding: 'utf8', timeout: 10000 });
  return { base, source, home, evidence, env, run };
}

test('TRT633 H01 prepare accepts a fresh owned canonical mktemp HOME and creates only private Codex state', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.home, f.home);
  assert.equal(prepared.tmpdir, f.home);
  assert.equal(prepared.codexHome, path.join(f.home, '.codex'));
  assert.equal(prepared.provenance.uid, process.getuid!());
  assert.equal(prepared.provenance.emptyAtPreparation, true);
  assert.equal(prepared.provenance.canonicalHome, f.home);
  assert.equal(fs.statSync(prepared.codexHome).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(prepared.codexHome, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n');
  assert.equal(fs.existsSync(path.join(prepared.codexHome, 'auth.json')), false);
  assert.equal(fs.existsSync(f.evidence), false);
});

test('TRT633 H02 selected filesystem may be /srv/dev rather than /tmp', t => {
  const f = fixture(t);
  const selected = fs.mkdtempSync(path.join(repository, 'TRT633-'));
  t.after(() => fs.rmSync(selected, { recursive: true, force: true }));
  Object.assign(f.env, { HOME: selected, RAF_QA_HOME: selected, TMPDIR: selected, CODEX_HOME: path.join(selected, '.codex') });
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
  Object.assign(f.env, { HOME: selected, RAF_QA_HOME: selected, TMPDIR: selected, CODEX_HOME: path.join(selected, '.codex') });
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

test('TRT633 H06 refuses shared CODEX_HOME without reading or changing it', t => {
  const f = fixture(t);
  f.env.CODEX_HOME = '/home/dev/.codex';
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRT633 setup:.*CODEX_HOME/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('TRT633 H07 prepared HOME cannot be prepared again or silently reused without authorization', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const repeated = f.run();
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /TRT633 setup:.*empty/);
  const result = f.run('host');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRT633 setup:.*authoriz/);
  assert.equal(fs.existsSync(f.evidence), false);
  assert.equal(fs.existsSync(path.join(f.home, 'root')), false);
});

for (const kind of ['uid', 'inode', 'device', 'missing-marker', 'unexpected-entry', 'codex-symlink', 'auth-symlink', 'auth-hardlink', 'config-hardlink', 'keyring-config']) test(`TRT633 H08 refuses ${kind} after explicit preparation before any live launch`, t => {
  const f = fixture(t);
  const prepared = f.run();
  assert.equal(prepared.status, 0, prepared.stderr);
  const codexHome = path.join(f.home, '.codex');
  const auth = path.join(codexHome, 'auth.json');
  fs.writeFileSync(auth, '{}\n', { mode: 0o600 });
  const marker = path.join(f.home, '.trt633-prepared.json');
  if (['uid', 'inode', 'device'].includes(kind)) {
    const provenance = JSON.parse(fs.readFileSync(marker, 'utf8'));
    provenance.provenance[kind] += 1;
    fs.writeFileSync(marker, JSON.stringify(provenance));
  }
  if (kind === 'missing-marker') fs.unlinkSync(marker);
  if (kind === 'unexpected-entry') fs.mkdirSync(path.join(f.home, 'root'));
  if (kind === 'codex-symlink') { const moved = path.join(f.base, 'other-codex'); fs.renameSync(codexHome, moved); fs.symlinkSync(moved, codexHome); }
  if (kind === 'auth-symlink') { const moved = path.join(f.base, 'other-auth'); fs.renameSync(auth, moved); fs.symlinkSync(moved, auth); }
  if (kind === 'auth-hardlink') fs.linkSync(auth, path.join(f.base, 'linked-auth'));
  if (kind === 'config-hardlink') fs.linkSync(path.join(codexHome, 'config.toml'), path.join(f.base, 'linked-config'));
  if (kind === 'keyring-config') fs.writeFileSync(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  const result = f.run('host');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRT633 setup:/);
  assert.equal(fs.existsSync(f.evidence), false);
  assert.equal(fs.existsSync(path.join(f.home, '.raf')), false);
});
