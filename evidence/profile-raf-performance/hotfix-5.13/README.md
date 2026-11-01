# profile-raf-performance:5.13 — partial optimization, failed verification

The fixture optimization is committed as `f29bbc00fa357052cc84f04ae545a5779736312e`. Three identical fixture instances (including a nested process) now perform one actual build, while independent files and Git state remain isolated. Before optimization, builds consumed 87% of measured parent subprocess time. Source/dependency/configuration changes invalidate reuse; failed builds do not publish ready artifacts. Production activation gates and the 1,200,000 ms timeout are unchanged.

The assigned item remains incomplete: both explicitly authorized full-group attempts timed out. The first encountered EDQUOT; main cleaned the host /tmp and authorized one repeat. The repeat had no new diagnostics but still timed out. No third attempt, ledger reset, HOME change, checkbox update or archive was performed.

| Artifact | Run ID | Outcome | CLI / child | Duration ms | passed / knownRed / unexecuted / unknown |
|---|---|---|---|---:|---|
| red-initial | 758cc04f-9a5b-45a0-ba48-47b026196332 | assertions-failed | 1 / 1 | 43369 | 0 / 1 / 0 / 0 |
| red | 0bc87796-f86c-4067-8177-2c19ddd3056d | assertions-failed | 1 / 1 | 61095 | 0 / 1 / 0 / 0 |
| hotfix-initial | 49c77377-b151-4ff6-a5f2-f6e8d2d3f2f8 | passed | 0 / 0 | 13800 | 1 / 0 / 0 / 0 |
| hotfix | 312304c7-a8d2-470b-8407-abf4265c1441 | passed | 0 / 0 | 25608 | 2 / 0 / 0 / 0 |
| module-origin-cost | ef0965d7-6b49-4207-99a0-cd5d6cac6659 | timed-out | 1 / None | 1209327 | 127 / 19 / 13 / 0 |
| module-origin-cost-retry | 0f92d862-b888-4600-abcb-e415e785df04 | timed-out | 1 / None | 1209886 | 121 / 19 / 38 / 0 |

`red-initial` exposed an IPC test defect, not the product regression. It was corrected before the intended assertion red (`3 !== 1`) and implementation. `hotfix` is the final two-test green.

The retry retains prior knownRed IDs: 5 also passed in that attempt and 14 were unexecuted. These are overlapping ledger categories, not disjoint new failures. Its groupState and nextAction are `confirm-known-red`; timeoutCount is 7. All six runs report complete cleanup. Raw TestRunResult, stderr, CLI exit and the full tool transport are separate files for every attempt. CLI output itself is complete; the first configured-group result explicitly marks some internal diagnostics truncated. No missing diagnostics are invented.

`runs.json` records exact commands, selection, outcomes and group state. `workspace-state.json` records code hashes, observed shared HEADs, dirty-workspace limitations, build/check verification and timestamps. `profiling.json` records measured build cost, audit, owner messages authorizing the two attempts and the unresolved full-group result.
