# audit-process-rules:1.11

Scope: CLI Git prohibition; worker/service Git accounting and warning event; removal of report commit validation.

Base workspace HEAD for every recorded run: `6ce252dd47c643f4437ef9cfe958cc59da7e104d`. Runs used this shared hotfix worktree with the assigned uncommitted source/tests. No QA HOME reset or group rename occurred. Final code and these evidence files are committed together.

The existing central Git guard/counting path is covered by the new regression. This patch connects nonblocking threshold warnings to the durable `raf.git-calls-exceeded` event for worker and service, removes commit shape/run-context/freshness acceptance checks, and preserves generic report/session atomicity for checkbox writes. CLI reconciliation diagnoses invalid reports without invoking Git and leaves successful checkbox commits to workers.

Main-authorized description-only rejection tests were removed/replaced with invalid JSON rejection coverage. The synthetic Codex runner now acknowledges subsequent messages after its initial assignment. The existing orphan-reconciliation regression exposed lossy UTF-8 re-encoding of rejected snapshots; retry diagnostics now retain the raw bytes.

## Reproduction

Prefix for every CLI invocation below: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts`.

- Initial red: `test run --project raf --phase red --group audit-process-rules/git-command-ban --files test/git-command-ban.test.ts`.
- Report shape red: the same red command after adding omitted/legacy commit regression cases.
- Expanded hotfix: `test run --project raf --phase hotfix --group audit-process-rules/git-command-ban --files test/git-command-ban.test.ts test/agent-report-freshness.test.ts test/report-rejected-events.test.ts test/report-confirmation-deadline-z39398.test.ts test/report-confirmation-committed-z39393.test.ts`.
- Baseline confirmation: configured group with `--only` for the four known red IDs listed in `baseline-four-failures.TestRunResult.json`; source files git.ts, agent-report.ts, production-runtime.ts and raf-cost-runtime.ts were temporarily restored to HEAD, then restored to the assigned patch.
- Final full selection: `test run --project raf --phase hotfix --group audit-process-rules/git-command-ban`. The seven exact files, child executable/argv, isolated HOME and timeout policy are recorded in each full TestRunResult.

## Evidence interpretation

Each `*.TestRunResult.json` is the complete unchanged first-line JSON from the CLI, including runId, selection, outcome, knownRed/unexecuted/unknown, cleanup/timeout, group state and next action. Corresponding stderr and CLI exit metadata are separate files; child exitCode is inside TestRunResult. Captured stdout/stderr share one tool stream; the complete first JSON line is stdout and following warning lines are stderr. No TestRunResult was truncated. Console summaries may be truncated; stored JSON is complete.

`selection-refused` records a refused attempt to combine files and only; it is not a regression red or pass. `baseline-four-failures` confirms the old four failures before this patch. `hotfix-before-fixture-correction` is not a pass: main sent SIGTERM to its hung inner fixture CLI, leaving the test runner intact. `hotfix-fixture-receipts` leaves one raw-byte dedup failure; that failure drove the byte-preservation correction.

Group configuration was autocommitted by raf in Orchestrator `d0d472dc8f1b2c2559a144df53871ae05e30a5d5`; main registered the event in `5d29e729751a96803c4a9635078aa7de25c6ab94`. These are dependencies, not this executor's commits. The task checkbox remains owned by raf. Other tasks remain open, so no archive or activation is performed.


## Final verification

Final full run `8f23508e-e2e9-4835-9e3e-7034b09f4c36`: 83 passed, 0 knownRed, 0 unexecuted, 0 unknown; CLI/child exit 0; no timeout; cleanup complete without remaining PIDs. Group state and next action: `complete`. Duration: 107473 ms. See `hotfix-final.TestRunResult.json`, `hotfix-final.stderr.txt` and `hotfix-final.cli.json`. `git diff --check` passed. No source/test edits occurred during this final run.
