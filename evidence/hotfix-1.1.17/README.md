# Linux port 1.1.17

Source: `mac-on-4a5724a`, commit `88f4b42508544ba42acd955c61dec3374c57c4e7`.
Audit base: `770a151ff0f112b003f4c9c45b6122b6fd814841`; code commit: `3bc5ffe92f879f1d631e1dbaf7a501d296fbbd32`.
The assigned requirement remains current: base still spawned a live shell placeholder and used `respawn-pane -k`; CLI dynamic import/dispatch had no exception boundary.

## Scope and portability

Production hunks ported to `bin/raf.ts`, `src/cli-output.ts`, `src/agent-adapters.ts`. Linux compile cache and runner session environment forwarding are preserved. Regression test was copied from the source commit, then corrected for Linux dead-pane PID retention as described below. Original `evidence/hotfix-mac-pty-json` is copied unchanged and is Mac evidence only. No new production limits or timeouts.

## RED

Command: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase red --group fix-raf-cli-live-latency/live-latency --files test/hotfix-launch-diagnostics.test.ts`.
Run `c7971d0c-ee9e-4f14-ad7a-81a8a0e74cad`: assertions-failed, all 8 new tests failed, CLI 1, child 1, timeout false, cleanup complete, remainingPids empty, timeoutCount 0, groupState idle, nextAction implement; unexecuted/unknown empty. KnownRed contains the 8 new tests plus the inherited worker-launch-latency budget failure. Real Linux tmux demonstrates that the baseline has a live placeholder PID. The import/dispatch fixtures successfully inject errors; their JSON parse failures demonstrate missing JSON diagnostics, not setup failure.

Full unchanged result: `red.TestRunResult.json`. Combined tool stdout/stderr: `red.cli-output.txt`, truncated by the tool; no complete stderr is claimed. `source.json` records separate CLI and child codes.

## GREEN

Initial command: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-cli-live-latency/live-latency --files test/hotfix-launch-diagnostics.test.ts test/agent-adapters.test.ts test/agent-adapters-contract.test.ts test/launch-wrapper-qa.test.ts test/launch-wrapper.test.ts`.
Run `2e720e38-3cd6-43a5-8123-bc540546804b`: timed-out after 1200802 ms, CLI 1, child exitCode null/SIGKILL, cleanup complete, 38 passed and 2 assertions. Linux tmux 3.3a retains a stale PID for a dead empty pane; the Mac-only expectation of an empty PID was wrong. Corrected only the test: require pane_dead=1 and ESRCH when probing a retained PID. A live placeholder (baseline pane_dead=0) still fails. No production requirement changed.

At timeoutCount=1/nextAction=optimize, removed the newly added agent-adapters-contract.test.ts from the group/selection: it produced no passed tests and begins with unrelated message-receipt tests. Its legacy fixtures use removed transition timeout semantics. These tests are not claimed passed; no new timeout was added. The assigned adapter/launch behavior remains covered by agent-adapters, wrapper and new real-tmux tests.

Final command: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-cli-live-latency/live-latency --files test/hotfix-launch-diagnostics.test.ts test/agent-adapters.test.ts test/launch-wrapper-qa.test.ts test/launch-wrapper.test.ts`.
Run `0a22be49-9331-4c82-93e7-902152fd7942`: **70 passed**, diagnostics empty, child exitCode 0, 7578 ms, timeout false, cleanup complete/remainingPids empty, unexecuted/unknown empty. All 8 assigned regressions passed. CLI exitCode **1**, outcome **assertions-failed**, groupState optimize, timeoutCount 1, nextAction fix-implementation solely because the aggregate retains its pre-existing worker-launch-latency budget knownRed. This is not a claim that the entire group passed. That separate budget work remains open as task 1.1. The same QA HOME and group were retained, with no resets.

Results: `green-initial.TestRunResult.json`, `green-final.TestRunResult.json` copied byte-for-byte from RAF paths. Full combined outputs and stderr tails are stored separately; final and initial GREEN outputs were not truncated. RED combined output was truncated, with full JSON retained. SHA: initial GREEN started on the base with the port as working changes; final GREEN used code commit 3bc5ffe plus the two-line test portability correction. Other executors modified their own files concurrently; no whole-workspace snapshot is claimed.

## Other checks and readability

`npm run build` and `npm run check:comments` passed. `git diff --check -- bin/raf.ts src/agent-adapters.ts src/cli-output.ts test/hotfix-launch-diagnostics.test.ts` passed. Unscoped diff check found a foreign blank line at EOF in test/delivery-evidence.test.ts; foreign changes were not edited.

Self-review compares base `770a151ff0f112b003f4c9c45b6122b6fd814841` with code commit `3bc5ffe92f879f1d631e1dbaf7a501d296fbbd32`. `TmuxAgentAdapter.startWithoutInput` keeps the existing bootstrap -> remain-on-exit -> startPane order; the empty pane removes placeholder state and forced termination from both argv and source-file branches. `runCliEntry` has one caller, the public entrypoint, and explicitly converts import/dispatch exceptions into the existing execution delivery contract. `deliverExecutionResult` retains stdout -> afterDelivery -> stderr order, detects full or line-delimited structured diagnostics, and appends fallback JSON only for nonzero results without stdout or a structured diagnostic. All delivery remains owned by cli-output.ts. No hidden state owner, unused compatibility layer or unrelated refactor was introduced. Behavioral preservation relies on the selected tests, independently of this review.

## Shared files and ownership

Registry additions were made in-place and delivered to main, who owns conf commits: profiles.node.unitFiles adds test/hotfix-launch-diagnostics.test.ts; live-latency.files adds that file and the three selected adapter/wrapper files (the initially added contract file was removed during optimization). tasks.md gained only a verification section, committed by main as `d794074cb0`; this is not an executor commit. Assigned checkboxes are left to raf. Other items remain open, so no archive. Activation and live measurements belong to main.

Final comment-check rerun encountered foreign comments in scripts/qa-forced-close-live.mjs:234 and src/startup-context.ts:370; the earlier check passed before those concurrent edits. No comment was introduced in assigned files. Root final-result docs commit was denied: exit 128, `fatal: Unable to create '/srv/dev/work/orchestrator/.git/index.lock': Read-only file system`. Exact docs patch is `tasks.patch`, delivered to main; receipt and prior registry transfers are recorded in delivery.json. Main commits are not executor commits.
