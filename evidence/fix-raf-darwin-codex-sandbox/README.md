# fix-raf-darwin-codex-sandbox:1.1

Darwin uses the native Codex workspace-write permission profile (Seatbelt); Linux still uses the existing bwrap/seccomp wrapper. The Darwin profile preserves directory grants, exact standalone file grants, read-only paths, hidden lexical/canonical paths (including absent hidden paths), account secrets and scrubbed host environment. Model/effort and the prompt tail remain unchanged.

Official backend reference: https://learn.chatgpt.com/docs/agent-approvals-security (macOS uses Seatbelt via sandbox-exec).

`runs.json` records every command, base SHA, source/test hashes, workspace modifications, selection and result. Each result JSON is complete and unchanged; stderr and CLI exit codes are separate, child exitCode remains in TestRunResult. No transport truncation occurred. The caller phase is hotfix even for the explicit red phase because raf derives it from this agent assignment; the result retains phase=red.

- red: 2 target failures, bwrap unavailable on simulated Darwin; assertions-failed, not import/setup failure.
- hotfix: initial 6 passed.
- linux-expanded: 24 passed, 8 failures in three additional files.
- baseline-failures: original src/codex-sandbox.ts from baseCommit reproduces those same 8 failures: codex-state-access fixture omits commandTiming.sqliteOnlyMeanBudgetMs; codex-file-write-boundaries readOnlyDirectories=[root] removes the requested standalone write grants; production-codex-writes-qa fixtures fail their plain checkout .git assertion.
- baseline-linux: 19 existing Linux checks passed against original source. Removed IDs explicitly preserve the eight out-of-scope failures in the aggregate evidence.
- final: fixed source, 21 passed (2 Darwin + 19 Linux), group complete, no knownRed/unexecuted/unknown, no timeout and complete cleanup.

The same group and QA HOME were retained throughout; no state reset. After baseline comparison, main explicitly directed keeping the three unrelated failing files outside final selection. Their failures are recorded, not fixed or represented as passing. Only task 1.1 is delivered. Task 1.2, activation and live Mac verification remain open for their assigned executor.
