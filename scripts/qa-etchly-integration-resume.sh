#!/usr/bin/env bash
set -eu
source_root=$1
stand_root=$2
raf_sha=$3
node --input-type=module - "$source_root" "$stand_root" "$raf_sha" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [source, root, sha] = process.argv.slice(2);
assert(/^[a-f0-9]{40}$/.test(sha));
assert.equal(fs.realpathSync(source), source);
assert.equal(fs.realpathSync(root), root);
assert.equal(fs.statSync(root).uid, process.getuid());
assert.equal(fs.statSync(root).mode & 0o077, 0);
const marker = JSON.parse(fs.readFileSync(path.join(root, '.qa-etchly-stand.json'), 'utf8'));
assert.equal(marker.root, root);
assert.equal(marker.sourceRoot, source);
assert.equal(marker.sourceItem, 'add-raf-test-run:6.2.6.3');
assert.equal(marker.status, 'prepared');
for (const name of ['raf-develop', 'etchly-develop', 'shared-libs-develop']) {
  const repo = path.join(root, name);
  assert.equal(fs.realpathSync(repo), repo);
  assert.equal(execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v1'], { cwd: repo, encoding: 'utf8' }).trim(), '');
}
assert.equal(fs.existsSync(path.join(root, 'results-readiness-regression')), false);
assert.equal(fs.existsSync(path.join(root, 'readiness-regression-capture')), false);
NODE
mkdir -m 700 -- "$stand_root/readiness-regression-capture"
git -C "$stand_root/raf-develop" fetch --no-tags -- "$source_root/raf-develop" "$raf_sha"
git -C "$stand_root/raf-develop" checkout -B develop "$raf_sha"
set +e
node "$stand_root/raf-develop/scripts/qa-etchly-integration-host.mjs" "$stand_root" "$stand_root/results-readiness-regression" d08-remainder 60000 900000 >"$stand_root/readiness-regression-capture/driver.stdout" 2>"$stand_root/readiness-regression-capture/driver.stderr"
driver_rc=$?
set -e
printf '%s\n' "$driver_rc" >"$stand_root/readiness-regression-capture/driver.rc"
printf 'D08 continuation rc=%s; artifacts=%s/results-readiness-regression\n' "$driver_rc" "$stand_root"
exit "$driver_rc"
