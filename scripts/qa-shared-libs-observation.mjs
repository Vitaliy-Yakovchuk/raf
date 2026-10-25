import assert from 'node:assert/strict';

// Observe persisted SessionRecord payloads, rather than CLI presentation objects.
export function assertSharedLibraryLaunch(actor, layout, dependent) {
  assert.equal(actor.activity.cwd, layout.product);
  assert.ok(actor.process?.runnerSessionId && actor.process.pid, 'Real native identity required');
  const contract = actor.launchContext?.reportedCommits;
  assert.ok(contract?.repositories);
  assert.equal(contract.repositories.some(row => row.repositoryRoot === layout.library), dependent);
  for (const directory of [layout.library, layout.libraryGit, layout.libraryCommon]) {
    assert.equal(contract.writeBoundaries.includes(directory), dependent, directory);
  }
}

export function assertSharedLibraryAcceptance(accepted, probe) {
  assert.equal(accepted.reportAcceptance?.status, 'succeeded');
  assert.deepEqual(accepted.result.proof.commits, [probe.commit]);
  assert.ok(accepted.result.proof.checkboxCommits?.length, 'Raf checkbox commit required');
  return accepted.result.proof.checkboxCommits;
}
