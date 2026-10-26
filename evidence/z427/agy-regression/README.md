# Z.427 follow-up: preserve absolute agy balance trust

Main's pre-activation regression at `764c3b7` found `test/agy-quota-credits.test.ts:155` failed, while the same file passed on working `ec8d770`. The earlier Z.427 change removed the version predicate from `parseQuotaCredits` as well as removing the general quota refusal. That broadened absolute balance trust incorrectly. The applicable contract is `specs/projects/raf/quota-collection/spec.md`, requirement “Баланс кредитів agy”: absolute credit validity remains independent of measured windows. The existing regression test is correct and unchanged.

The fix retains the version-mismatch warning and continued window parsing, and restores the original version predicate solely to agy's absolute `credits.reliable` input. No collection/refusal gate is restored. No test files were edited; `unchanged-tests.json` records SHA-256 equality with HEAD for both selected agy test files.

The trusted prefix was:

```
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/9281a828-9083-4ebb-85d1-d129c1411c4f/raf-main/bin/raf.ts
```

Exact argument lists:

```
test run --project raf --phase red --group complete-raf-flow-contracts/agy-credits
test run --project raf --phase hotfix --group complete-raf-flow-contracts/agy-credits
test run --project raf --phase hotfix --group complete-raf-flow-contracts/z390-regress --files test/quota-collection.test.ts test/quota-screens.test.ts
```

| Run | runId | CLI / child | Result | Group / next action |
| --- | --- | --- | --- | --- |
| red | 0e595821-a6a5-45ec-8d67-d71a53ac0fb4 | 1 / 1 | assertions-failed, 39 passed, 1 knownRed at the reported credit assertion | loaded, idle / implement |
| hotfix | 198c7570-f8b7-4b04-93b8-2e29626e96c1 | 0 / 0 | passed, 40 passed, 0 knownRed | loaded, complete / complete |
| z390 hotfix | 4a4a3a40-e56d-4611-8795-4d173852723d | 0 / 0 | passed, 37 passed, 0 knownRed | loaded, complete / complete |

All runs have unknown/unexecuted empty, timeoutCount 0, no timeout and complete cleanup with no remaining PIDs. Resource queue waits are preserved in the separated stderr and complete transport. The agy preset selects `test/agy-quota-credits.test.ts` and `test/agy-quota-credits-pipeline.test.ts`; it is in the same assigned change, as main explicitly confirmed. Stable group aggregates and QA HOME were retained:

`/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`

Full unchanged TestRunResult JSON, extracted stderr, separate CLI exit code and complete tool transport are stored for each run. `*-head.txt`, `*-workspace.patch`, and `*-status.txt` record the exact shared workspace state, including unrelated changes owned by other executors. Only `src/quota-screens.ts` and this executor's evidence are committed here. `npm run build` and `git diff --check` passed; build output is preserved in `build.transport.json`.

The previous live Claude proof remains applicable to the unchanged Claude path; the new z390 run verifies its warning/collection behavior after this correction. No additional live probe was needed for this agy absolute-balance predicate.
