# complete-raf-flow-contracts:9.4

QA found a real Git/fs defect: a directory without its own Git repository was accepted as a product workspace when Git discovered the matching branch in its parent Orchestrator repository. Shared libraries had the same unchecked-root path. The resolver now checks the canonical repository root for both through the existing production Git ports.

`non-git-live-before-fix.json` records the erroneous acceptance. `non-git-live-after-fix.json`, its separate stderr/exit files and `non-git-probe.mjs` record refusal after the fix with unchanged Git observations. See `probe-provenance.json` for the original ad hoc source capture limitation.

`unit-runs.json` links the exact authorized commands, full unchanged TestRunResult JSON, CLI envelopes, separate CLI/child exit codes and workspace snapshots. The stable group and QA HOME were preserved across baseline (68 passed), assertion red (four new failures, 68 passed) and QA (72 passed). All runs report complete cleanup, no timeout and no unknown or unexecuted tests. The final group is complete. The executor provided only merged output; independent stderr was unavailable and is explicitly recorded as unknown in each stderr capture record.

`build.stdout`, `build.stderr` and `build.exit.json` record the successful catalogue build and repository comment check. `versions-and-source.json` records tool versions and exact source hashes.

`test/workspace-routing-integration.test.ts` adds I1 scenarios using production services without injected ports, real Git repositories, actual local symlinks and a real isolated SQLite database. Each scenario compares complete repository file hashes (including Git metadata, index, refs, dirty/staged/untracked files and links) and database rows before/after routing, then records fixture cleanup. Its deadline comes from the integration timeout configuration. This file is integration-only and must run through the audited integration preset; syntax validation and the unit result do not establish its execution or acceptance.

I2–I6 require additional live runner/native sandbox/provider/handover stands and matching current-code evidence. No assigned checkbox has been changed; no foreign regression group has been executed.

The integration preset was registered after this agent launched. Its single authorized `--phase qa` attempt was refused with `CALLER_UNAUTHORIZED` before spawn because the integration profile differs from the immutable assignment. Run `157eb270-7123-4f5a-aa22-3086f7c804a2` has CLI exit 1, child exit null, complete preflight cleanup and no group snapshot. `integration-run.json` links the complete raw result and command. The empty preflight test arrays do not establish acceptance. No retry or alternate runner was used. A new verified assignment is required.

`acceptance.json` records failed item 9.4: partial manual I1 evidence, all 23 integration cases unexecuted and I2–I6 unverified. `dependency-source-audit.json` compares historical native evidence to the current sources; changed routing/runtime inputs prevent accepting those old stands as complete current-code scenarios. `dependency-evidence-review.json` identifies the narrower reusable facts and their limits. `final-workspace.json` records current own source hashes and unrelated shared edits.
