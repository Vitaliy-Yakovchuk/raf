import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const cwd = process.cwd();
const a = await import(pathToFileURL(path.join(cwd, 'qa-z334/a.mjs')));
const b = await import(pathToFileURL(path.join(cwd, 'qa-z334/b.mjs')));
assert.equal(a.marker, b.marker);
for (const args of [['help'], ['agent', 'ps']]) {
  const r = spawnSync(process.execPath, [path.join(cwd, 'bin/raf.ts'), ...args], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  if (args[0] === 'agent') assert.ok(Array.isArray(JSON.parse(r.stdout)));
}
assert.ok(fs.existsSync(path.join(process.env.HOME, '.raf/state.sqlite')));
console.log(JSON.stringify({ kind: 'stand-integration', marker: a.marker, cli: 'help + agent ps', modelUsed: false }));
