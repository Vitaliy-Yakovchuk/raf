# fix-raf-handler-failed-refusals:1.1

## Historical attribution

`historical-refusals.json` preserves ten original health-summary events from the production SQLite outbox (`/home/dev/.raf/state.sqlite`, `pending_intents`) and the matching CLI diagnostics from Claude transcripts. Each match has its transcript path, result/call line numbers and tool-use ID; message bodies are excluded. Summary `matches` indexes refer to `records`.

All 48 accounted HANDLER_FAILED/handler refusals are `agent message` to main: 42 screen-cannot-confirm-acceptance, 3 no-recognized-empty-composer, 3 unrelated-composer-input. They originate in `AgentControlService.message` (`src/agent-control.ts`), where `accepted:false` previously threw an ordinary Error; `src/app-runtime.ts` then normalized it to HANDLER_FAILED/handler with null sourceCode. No bug operation is a source of these 48 events.

Counts by closing time UTC: Nov 3 21:09=5, 22:09=9, 23:09=9; Nov 4 00:09=4, 01:09=3, 02:09=7, 03:09=3, 04:09=3, 05:09=2, 06:09=3. The first event covers 20:09:37.936–21:09:38.563; its actual count is 5 (the proposal says 9). This is a correction from primary evidence, not an omitted event. The 06:09–07:00 tail has no matching transcript refusals; the next event closes after the assigned cutoff.

Two other transcript HANDLER_FAILED results are sandbox SQLITE_READONLY failures (records indexed by `outsideHealthAccounting`); they could not update health accounting and are excluded from the 48. Historical health storage contained only code/stage counters. Command/reason attribution therefore required transcript correlation; the fix persists aggregate diagnostic tuples within the same SQLite window and outbox event.

## Behavior

Unaccepted transport receipts now produce the registered MESSAGE_NOT_ACCEPTED code, stage message, source agent-control.transport, sourceCode MESSAGE_NOT_ACCEPTED and the actual transport reason. They retain unknown retry safety, no claimed completion, and pending message acceptance. Health diagnostics keep only command, code/stage, source/sourceCode, reason and count; repeats aggregate, secrets are scrubbed, and legacy counters without diagnostics are explicitly partial. Window rollover resets diagnostics and counters together while retaining the completed event.

## Test evidence

`red.TestRunResult.json` is the complete unmodified result, not a reconstruction. `red.cli-output.txt` retains the complete adapter output; `red.stderr.txt` extracts its diagnostic prefix. The adapter merges OS streams, so separate original OS stderr handles were unavailable. CLI exit status is recorded separately from child exitCode. `red.metadata.json` records exact command, HEAD, dirty workspace, knownRed and next action.

RED is assertions-failed: 37 passed, three executed regression failures; no setup/import failure, no unknown/unexecuted IDs, cleanup complete. Stable group: fix-raf-handler-failed-refusals/unit. Original code HEAD: 98ae484d654794a73f388b3179c9335a7c137a32.

The first hotfix run (`green1.*`, run c12cf007-03da-4911-a275-a9cd4533ca53) timed out after 1200000 ms with complete cleanup. All original three knownRed executed and passed but remained in the aggregate until a complete confirmation. It stalled on an existing summary fixture that permanently threw SQLite lock errors, while the current retry contract waits for recovery. Optimization replaces permanent fake failure with two failed writes followed by recovery, checks durable delivered receipt and no resend across restart; no production timeout/retry policy changed. The renamed test appears as one removed old ID and one passed new ID in the final result.

Final hotfix run (`green.*`, run 038ea087-496e-4afb-8536-2b962ccc89a0): passed, CLI/child exit 0, 100 passed, no knownRed/unexecuted/unknown, cleanup complete, timedOut false, groupState/nextAction complete. Same group and QA HOME throughout; timeoutCount remains 1. Final duration 3807 ms. Metadata and dirty workspace patch accompany each result.

Root changes register the regression inventory/group and record exact selections/results in tasks.md without ticking boxes. Root Git is read-only in this sandbox: the commit attempt failed before creating index.lock. `root-own-changes.patch` preserves only our root changes; concurrent unrelated test registrations are excluded. Main must commit these two root paths with its own concurrency coordination. Task 9.1 remains open; no archive or activation was attempted.
