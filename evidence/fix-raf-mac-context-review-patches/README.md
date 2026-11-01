# 1.1: Mac attach permission and Claude cached input

Workspace HEAD for all three runs: `58ec849b399d8be66a0e65bea9cb5a1dbbab1f2e`.
The tests were uncommitted in red; production sources remained at HEAD until the accepted red run. `regression-tests.patch` records those tests; `fix.patch` records the later production changes tested in hotfix. Initial red used the stale `observeProcesses` mock inherited from the existing fixture; that fixture failure is not attach regression evidence. Correcting its export to `observeKnownProcesses` restored all existing pane tests without changing production behavior or test assertions. The second red has the targeted darwin permission failure and three cache-count assertion failures, with no fixture failures.

Each run has the complete unmodified TestRunResult JSON, separate CLI stderr and CLI metadata (including command, CLI status and child exitCode). No result or stderr truncation occurred. `callerPhase=hotfix` identifies the caller while `phase=red` identifies the requested initial phase. All runs share the same group and isolated QA HOME; timeoutCount=0 throughout. The root conf group was automatically committed by raf (`ef579e43255c129ad6f501e897fc1c600b999444`), not by this executor.

- red-initial: runId `3e140525-ccdf-4d1b-acb1-c396e79d088e`, CLI/child 1, assertions-failed; 12 knownRed including fixture failures. Not accepted as attach red.
- red: runId `25919785-62c9-4212-a90a-0de7476276f3`, CLI/child 1, assertions-failed; 31 passed, four targeted knownRed; unexecuted/unknown empty, cleanup complete, no timeout; group idle, nextAction implement.
- hotfix: runId `1f463551-012d-49ed-a65b-2ec5ffd09562`, CLI/child 0, passed, 35 passed; knownRed/unexecuted/unknown empty, cleanup complete, no timeout; group complete, nextAction complete.

Audit: the archived attach patch was already present in HEAD, but its nativeWriteScopeArgs grant did not survive the protected/hotfix filesystem.allowWrite replacement. Adding the canonical attach directory to the same writable list preserves both grants. The unit fixture injects platform and getconf on Linux, canonicalizes `/var` to `/private/var`, and exercises the shared protected/hotfix settings block. Linux Claude and Darwin Codex controls do not request the attach grant. No real macOS/JDK execution was performed. Startup tests cover per-message totals, message deduplication, cumulative result replacement, absent/invalid cache counters and existing Codex-inclusive behavior.

Task 1.2 stays open and is outside this assignment; no activation, push, archive or task checkbox changes were performed.
