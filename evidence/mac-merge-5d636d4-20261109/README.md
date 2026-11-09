# Mac integration of Linux hotfix 5d636d4 — rolled back

Slot: /Users/val/Documents/orchestrator/raf-main-a. Symlink raf-main remains raf-main-a; raf-main-b was not accessed or modified. No pushes, service restart, agent stop, or manual state migration/removal.

## Merge and decisions

Base: f95058c4f659a95ae44c1a20e47ba1f4cbbd9b7c (mac-merge-ca5852d).
Merge: 4bceaebe174611eb4840ca7ae2f117c749d5f74a, on mac-merge-5d636d4.
Linux remote: dev@37.27.178.216:/srv/dev/work/orchestrator/raf-hotfix.
Merged linux/hotfix = 5d636d42c1065d0127b848b3bd05509a8e818855.
9e571042ba44059e8d6d9b7120d7d28140d7d49f is already an ancestor of that hotfix; no additional main merge required.

No conflicts or manual merge resolutions. Verified automatic preservation of Mac behavior:
- 5e5aecce: canonicalize root-owned /tmp symlink before temporary-root validation.
- 6f26ac74: accept negative Darwin process UID values; retain paginated archive reminder reads (Linux now imports iterateDatabaseTable from database-table.ts).
- f8604216: absent agent run features becomes an empty array in launch and brief construction.

package-lock.json unchanged; npm ci not run. No Orchestrator conf changes, including models.json.

## Verification

Node v26.12.1. node scripts/build.ts succeeded on merge HEAD and updated ignored dist/catalog.json. git diff --check passed.
No typecheck npm script or tsconfig is configured; no typecheck pass is claimed.

Sequential Node unit run (TMPDIR=/private/tmp, subprocess timeout 1200 seconds) covered 26 files: all package.json test groups plus Darwin migration, browser QA, startup context, app runtime and notices. Duration 102.087 seconds; 421 tests, 408 passed, 13 failed, no skipped/cancelled.

Fixture repairs on the candidate branch:
- cli-qa.test.ts: provide required reportStatuses; support boolean options without treating them as string values; supply smoke values for current CLI parameters. Existing assertions remain in force.
- codex-darwin-sandbox.test.ts: /usr/bin/true exists on Darwin and Linux; /bin/true does not exist on this Mac.
- reminder-fixture.ts: exact sysctl -n kern.boottime mock enables Darwin boot identity in the isolated process fixture; all other unexpected commands remain forbidden.

Targeted rerun of cli-qa, codex-darwin-sandbox and launcher-notice: 17 tests, 16 passed, 1 failed, duration 6.175 seconds. All Darwin sandbox and notice assertions now pass. Remaining failure: test/cli-qa.test.ts, handler failures and unknown arguments never echo secrets or private prompt. src/cli.ts HANDLER_FAILED diagnostic includes arbitrary Error.message in details.found, exposing the synthetic secret. src/cli.ts and src/cli-arguments.ts are unchanged between base and merge. No assertion was weakened. This existing production behavior is outside the merge; candidate was rejected and rollback selected per owner instruction.

Live commands on merge HEAD:
- node bin/raf.ts agent ps: exit 0, 0.88s, stderr empty.
- node bin/raf.ts reminder list: exit 0, 0.36s, stderr empty.
- node bin/raf.ts test run --help: exit 0, integration present.
Full live inventories were not committed. Normal raf reconciliation was allowed; no direct state writes were performed.

## Outcome

Candidate remains available on mac-merge-5d636d4, including fixture repairs and this report. Activation rejected because the verification suite is not green. Rollback command: git checkout mac-merge-ca5852d && node scripts/build.ts. Final rollback outcome and HEAD are recorded in /tmp/raf-mac-5d636d4-report.md by the activation session.

Diagnostic logs remain outside Git under /tmp/raf-mac-5d636d4-{build,tests,failures,retest}.log.
