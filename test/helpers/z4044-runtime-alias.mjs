import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const sameIdentity = (actual, expected, label) => {
  for (const field of ['dev', 'ino', 'uid', 'mode']) assert.equal(actual[field], expected[field], `${label} ${field} identity retained`);
};

export async function withRuntimeHostAlias({ directory, actor, endpoint }, probe) {
  assert.ok(['a', 'b'].includes(actor), 'runtime alias actor a/b required');
  assert.ok(path.isAbsolute(directory) && path.normalize(directory) === directory, 'absolute normalized runtime directory required');
  assert.ok(path.isAbsolute(endpoint) && path.normalize(endpoint) === endpoint, 'absolute normalized host endpoint required');
  const parent = await fs.lstat(directory);
  assert.ok(parent.isDirectory(), 'runtime alias parent is a directory, not a symlink');
  assert.equal(parent.uid, process.getuid(), 'runtime alias parent belongs to this worker');
  assert.equal(parent.mode & 0o022, 0, 'runtime alias parent is not writable by other users');
  const alias = path.join(directory, `z4044-main-alias-${actor}.sock`);
  await fs.symlink(endpoint, alias);
  let identity;
  try {
    identity = await fs.lstat(alias);
    assert.ok(identity.isSymbolicLink(), 'runtime alias is a symlink');
    assert.equal(identity.uid, process.getuid(), 'runtime alias belongs to this worker');
    assert.equal(await fs.readlink(alias), endpoint, 'runtime alias targets the confirmed host endpoint');
    return await probe(alias);
  } finally {
    assert.ok(identity, 'runtime alias identity must be captured before cleanup');
    const currentParent = await fs.lstat(directory);
    sameIdentity(currentParent, parent, 'runtime alias parent');
    assert.ok(currentParent.isDirectory(), 'runtime alias parent type retained');
    const current = await fs.lstat(alias);
    sameIdentity(current, identity, 'runtime alias');
    assert.ok(current.isSymbolicLink(), 'runtime alias type retained');
    assert.equal(await fs.readlink(alias), endpoint, 'runtime alias target retained');
    await fs.unlink(alias);
    await assert.rejects(fs.lstat(alias), { code: 'ENOENT' }, 'runtime alias removed');
  }
}
