# 1.2: Codex test-run activation control

The regression is unit-level: real prepareCodexSandbox policy generation and public CLI bootstrap, with activation access/retain ports constrained by that generated policy. It covers qa and implement routing. It does not claim a live Codex process integration run.

The trusted generation entry already retains an activation reader. Its sandbox invocation still checks W_OK and retains its own reader; therefore the control directory needs write access. The fix derives that directory from the issued raf command prefix and preserves all other read-only paths. No new validation, limits or timeouts.

## Commands and results

Every command used this exact prefix:
`node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/b2053018-dea5-48d2-a46c-d88ba4d6e82a/raf-main/bin/raf.ts`

| Artifact prefix | Arguments after prefix | runId | Outcome | CLI / child |
| --- | --- | --- | --- | --- |
| initial-fixture | test run --project raf --phase red --group fix-raf-codex-sandbox-network/test-entry --files test/codex-test-entry.test.ts | 0d539011-38ee-4e67-a2ed-c4f6d6587767 | assertions-failed, fixture catalog import problem; **not target red** | 1 / 1 |
| red | test run --project raf --phase red --group fix-raf-codex-sandbox-network/test-entry --files test/codex-test-entry.test.ts | 8cfc9ef3-5903-4fcc-8e5e-2d12016b96ee | assertions-failed, 2 target PRODUCTION_ENTRY_FAILED/EROFS assertions | 1 / 1 |
| hotfix-first | test run --project raf --phase hotfix --group fix-raf-codex-sandbox-network/test-entry --files test/codex-test-entry.test.ts test/test-run-cli.test.ts test/codex-directory-permissions.test.ts | 5c7a52b9-dc18-4495-a95f-4504c9a453f4 | 97 passed, 2 directory argument expectations failed | 1 / 1 |
| hotfix | test run --project raf --phase hotfix --group fix-raf-codex-sandbox-network/test-entry --files test/codex-test-entry.test.ts test/test-run-cli.test.ts test/codex-directory-permissions.test.ts | 1093eea3-6b56-4770-911d-b0a78a977e97 | passed, 99/99 | 0 / 0 |

Each prefix has the full unmodified TestRunResult JSON, stderr lines separately, CLI exit code separately from child exitCode, and the complete exec transport. The exec transport combines stdout/stderr; the single JSON result line is extracted intact and remaining lines saved as stderr. Initial fixture failure is retained honestly; it is not the regression proof.

## Workspace and aggregate

Target red was observed at HEAD `9181dd781ff75504d3f24590588613f2e7f3e3c4`, with the new test and bootstrap helper uncommitted; production sandbox implementation was still unchanged from the committed network fix. The fixture now mocks compiled-catalog.ts explicitly because concurrent commit `61a0925414b200dcea627f5fd359a89e74ab73e5` moved catalog reads there. The test and helper content in this commit matches genuine red. The implementation diff was applied only after that run.

hotfix-first-workspace.txt and hotfix-workspace.txt record the pre-run HEAD, relevant uncommitted diffs and shared workspace status. Untracked test content is committed beside this evidence. Other agents' dirty paths are not part of this task or commit.

The first hotfix confirms both new tests and all CLI tests passed. The two remaining failures were stale argument-prefix assertions: existing commit `c69b2e6` prepends --no-daemon. Only the expected prefix was corrected; no production behavior was changed for those assertions. The same three-file selection was rerun.

Stable group: `fix-raf-codex-sandbox-network/test-entry`. HOME remained `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685` across all phases and SHAs. No aggregate reset or group rename. Selection expanded in the same --files list. Red had 2 knownRed, no unknown/unexecuted, idle / implement. First hotfix had 2 knownRed, no unknown/unexecuted, idle / fix-implementation. Final has no knownRed/unexecuted/unknown/removed, groupSnapshot loaded, groupState complete, nextAction complete, timeoutCount 0. All runs have timedOut false, cleanup.complete true, no remaining PIDs.

The first hotfix waited in the normal resource queue; no duplicate run was started while pending. ResourceUsage sampling is partial and disk attribution unknown, as reported; this is not claimed to be complete measurement.

`openspec validate fix-raf-codex-sandbox-network --strict`: exit 0, valid, skip_specs true. No deltas or requirements changed. Assignment checkbox remains raf-owned.
