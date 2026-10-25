import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [sourceArg, rootArg, rafSha, etchlySha, sharedSha] = process.argv.slice(2);
assert(sourceArg && rootArg && [rafSha, etchlySha, sharedSha].every(s => /^[a-f0-9]{40}$/.test(s ?? '')),
  'Usage: node scripts/qa-etchly-integration-prepare.mjs SOURCE_ROOT NEW_PRIVATE_ROOT RAF_SHA ETCHLY_SHA SHARED_LIBS_SHA');
const sourceRoot = fs.realpathSync(sourceArg), root = path.resolve(rootArg);
const inside = (file, parent) => file === parent || file.startsWith(parent + path.sep);
assert(!inside(root, sourceRoot) && !inside(sourceRoot, root));
assert.equal(fs.realpathSync(path.dirname(root)), path.dirname(root));
const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
fs.mkdirSync(root, { mode: 0o700 });
const marker = { root, sourceRoot, sourceItem: 'add-raf-test-run:6.2.6.3', preparedAt: new Date().toISOString(),
  boundary: 'Clean committed code clones plus a snapshot of preinstalled dependencies and app build. No install, build, operational state or live caller grant is copied.', repositories: [], copied: [], configurations: [] };
write(path.join(root, '.qa-etchly-stand.json'), marker);
function clone(sourceName, name, sha, branch) {
  const source = path.join(sourceRoot, sourceName), destination = path.join(root, name);
  assert.equal(git(source, 'rev-parse', sha + '^{commit}'), sha);
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', source, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(destination, 'checkout', '-B', branch, sha);
  assert.equal(git(destination, 'status', '--porcelain=v1'), '');
  marker.repositories.push({ name, sha, branch, source, sourceHead: git(source, 'rev-parse', 'HEAD'), sourceDirty: git(source, 'status', '--porcelain=v1') });
}
function snapshot(sourceName, targetName, relative, required = true) {
  const from = path.join(sourceRoot, sourceName, relative), to = path.join(root, targetName, relative);
  if (!fs.existsSync(from)) { assert(!required, 'Missing prepared prerequisite: ' + from); return; }
  assert(!fs.lstatSync(from).isSymbolicLink(), 'Dependency snapshot root must be real: ' + from);
  assert(!fs.existsSync(to), 'Snapshot target already exists: ' + to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  execFileSync('cp', ['-a', '--reflink=auto', '--', from, to], { stdio: ['ignore', 'pipe', 'pipe'] });
  marker.copied.push({ from, to });
}
try {
  clone('raf-develop', 'raf-develop', rafSha, 'develop');
  clone('raf-develop', 'raf-main', rafSha, 'main');
  clone('etchly-develop', 'etchly-develop', etchlySha, 'develop');
  clone('shared-libs-develop', 'shared-libs-develop', sharedSha, 'develop');
  for (const name of ['raf-develop', 'raf-main']) snapshot('raf-develop', name, 'node_modules');
  snapshot('etchly-develop', 'etchly-develop', 'node_modules');
  snapshot('etchly-develop', 'etchly-develop', 'app/dist/local');
  snapshot('learning', 'learning', 'concept-base');
  const learning = path.join(sourceRoot, 'learning');
  marker.learning = { sourceHead: git(learning, 'rev-parse', 'HEAD'), sourceDirty: git(learning, 'status', '--porcelain=v1', '--', 'concept-base'),
    scope: 'Only concept-base including its prepared build; no other learning directories are copied.' };
  snapshot('shared-libs-develop', 'shared-libs-develop', 'node_modules', false);
  const shared = path.join(sourceRoot, 'shared-libs-develop');
  function copyNested(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const full = path.join(directory, entry.name);
      if (entry.name === 'node_modules') {
        const relative = path.relative(shared, full);
        if (relative !== 'node_modules') snapshot('shared-libs-develop', 'shared-libs-develop', relative);
      } else copyNested(full);
    }
  }
  copyNested(shared);
  function links(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (path.isAbsolute(link) && inside(link, sourceRoot)) {
          const target = path.join(root, path.relative(sourceRoot, link));
          fs.unlinkSync(file); fs.symlinkSync(path.relative(path.dirname(file), target), file);
        }
        assert(inside(path.resolve(path.dirname(file), fs.readlinkSync(file)), root), 'External dependency symlink: ' + file);
      } else if (entry.isDirectory()) links(file);
    }
  }
  for (const name of ['raf-develop', 'raf-main', 'etchly-develop', 'shared-libs-develop', 'learning']) links(path.join(root, name));
  const corpusHashes = [];
  function hashCorpus(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), relative = path.relative(path.join(root, 'learning'), file);
      if (entry.isDirectory()) hashCorpus(file);
      else if (entry.isSymbolicLink()) corpusHashes.push([relative, 'symlink', fs.readlinkSync(file)]);
      else corpusHashes.push([relative, 'file', hash(file)]);
    }
  }
  hashCorpus(path.join(root, 'learning/concept-base'));
  write(path.join(root, 'learning-corpus-hashes.json'), corpusHashes);
  Object.assign(marker.learning, { files: corpusHashes.length, hashesSha256: hash(path.join(root, 'learning-corpus-hashes.json')) });
  const sharedLink = path.join(root, 'etchly-develop/shared-libs');
  if (!fs.existsSync(sharedLink)) fs.symlinkSync('../shared-libs-develop', sharedLink);
  assert.equal(fs.readlinkSync(sharedLink), '../shared-libs-develop');
  fs.mkdirSync(path.join(root, 'conf'), { mode: 0o700 });
  for (const name of ['projects.json', 'raf.json', 'raf-constants.json', 'flow.json', 'test-runs.json']) {
    const source = path.join(sourceRoot, 'conf', name), destination = path.join(root, 'conf', name);
    fs.copyFileSync(source, destination);
    marker.configurations.push({ name, sourceSha256: hash(source) });
  }
  const projectsPath = path.join(root, 'conf/projects.json'), projects = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
  Object.assign(projects.projects.raf, { path: 'raf-main', branchPaths: { main: 'raf-main', develop: 'raf-develop' } });
  delete projects.projects.raf.mainCopies;
  for (const name of ['etchly', 'shared-libs']) Object.assign(projects.projects[name], { path: name + '-develop', branchPaths: { develop: name + '-develop' } });
  write(projectsPath, projects);
  marker.configurations.find(row => row.name === 'projects.json').standSha256 = hash(projectsPath);
  marker.prerequisites = [
    'etchly-develop/node_modules/vitest/package.json', 'etchly-develop/node_modules/miniflare/package.json',
    'etchly-develop/node_modules/workerd/bin/workerd', 'etchly-develop/node_modules/esbuild/bin/esbuild',
    'etchly-develop/app/dist/local/index.html',
    'learning/concept-base/build/records.jsonl', 'learning/concept-base/build/chunks.jsonl',
    'learning/concept-base/build/manifest-summary.json', 'learning/concept-base/sources/manifest.yaml',
  ].map(relative => ({ relative, sha256: hash(path.join(root, relative)) }));
  for (const name of ['raf-develop', 'raf-main', 'etchly-develop', 'shared-libs-develop']) assert.equal(git(path.join(root, name), 'status', '--porcelain=v1'), '', 'Copied artifacts must be ignored in clean clones: ' + name);
  marker.status = 'prepared';
  console.log(JSON.stringify({ status: marker.status, root, repositories: marker.repositories.map(({ name, sha }) => ({ name, sha })) }));
} catch (error) { marker.status = 'failed'; marker.error = error.message; process.exitCode = 1; console.error(error.stack); }
finally { write(path.join(root, '.qa-etchly-stand.json'), marker); }
