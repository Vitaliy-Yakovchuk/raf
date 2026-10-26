import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [report, manifestPath] = process.argv.slice(2);
assert.ok(path.isAbsolute(report) && path.isAbsolute(manifestPath));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schema, 'cfc24-native-document-v1');
assert.ok(['spec', 'design'].includes(manifest.phase));
const own = path.dirname(report);
const atomic = (target, value) => { fs.writeFileSync(target + '.part', JSON.stringify(value, null, 2) + '\n'); fs.renameSync(target + '.part', target); };
const checks = [];
const check = (id, fn) => { try { checks.push({ id, status: 'passed', evidence: fn() }); } catch (error) { checks.push({ id, status: 'failed', error: error.message }); } };
const hash = target => createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const git = args => {
  const result = spawnSync('git', ['-c', 'user.name=Native document QA', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', manifest.root, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const record = { command: ['git', ...args], cliCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
  assert.equal(result.status, 0, JSON.stringify(record)); assert.equal(result.signal, null, JSON.stringify(record)); return record;
};
check('L4-document-code-readable', () => { assert.equal(hash(manifest.code), manifest.codeSha256); return { path: manifest.code, sha256: manifest.codeSha256 }; });
check('L4-document-code-write-denied', () => {
  let code;
  try { const fd = fs.openSync(manifest.code, 'r+'); fs.closeSync(fd); } catch (error) { code = error.code; }
  assert.ok(['EACCES', 'EPERM', 'EROFS'].includes(code), 'Existing readable code must refuse opening for write: ' + code);
  return { path: manifest.code, code };
});
check('L4-document-child-code-write-denied', () => {
  const source = "import fs from 'node:fs';let code;try{const fd=fs.openSync(process.argv[1],'r+');fs.closeSync(fd);}catch(e){code=e.code;}console.log(JSON.stringify({code}));process.exit(['EACCES','EPERM','EROFS'].includes(code)?0:1);";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, manifest.code], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, JSON.stringify({ code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
  return { cliCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
});
let documentCommit;
check('L4-document-own-commit', () => {
  assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), manifest.beforeHead);
  assert.equal(hash(manifest.tasks), manifest.tasksSha256, 'No manual checkbox or task edit');
  assert.equal(fs.existsSync(manifest.document), false, 'New assigned document only');
  const literal = 'Native ' + manifest.phase + ' document 🧪 "quotes" $() `literal`\n';
  fs.writeFileSync(manifest.document, literal, { flag: 'wx' });
  assert.equal(fs.readFileSync(manifest.document, 'utf8'), literal);
  const relative = path.relative(manifest.root, manifest.document);
  const commands = [git(['add', '--', relative]), git(['commit', '-qm', 'Native ' + manifest.phase + ' document only']), git(['rev-parse', 'HEAD'])];
  documentCommit = commands.at(-1).stdout.trim(); assert.match(documentCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(git(['rev-parse', documentCommit + '^']).stdout.trim(), manifest.beforeHead);
  assert.deepEqual(git(['diff-tree', '--no-commit-id', '--name-only', '-r', documentCommit]).stdout.trim().split('\n'), [relative]);
  assert.equal(hash(manifest.tasks), manifest.tasksSha256);
  assert.equal(hash(manifest.code), manifest.codeSha256);
  return { repository: manifest.root, sha: documentCommit, relative, commands };
});
const result = { phase: manifest.phase, checks, pid: process.pid, cwd: process.cwd(), report, manifestPath, documentCommit,
  boundary: 'Executed by the actual native CLI inside its issued spec/design sandbox. Host must verify immutable probe/code, exact commit tree and accepted report. This does not prove other transport/UI scenarios.' };
atomic(path.join(own, 'native-document-probes.json'), result);
const status = checks.every(value => value.status === 'passed') ? 'succeeded' : 'failed';
atomic(report, { status, answer: 'Private native document and read-only code probe', commits: documentCommit ? [{ repository: manifest.root, sha: documentCommit }] : [],
  changes: [{ id: 'launch-failure-fixture', items: [{ id: '1.1', status, ...(status === 'failed' ? { reason: 'Native document/read-only assertion failed' } : {}) }] }] });
console.log(JSON.stringify(result)); process.exitCode = status === 'succeeded' ? 0 : 1;
