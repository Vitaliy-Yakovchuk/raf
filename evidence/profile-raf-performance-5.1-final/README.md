# profile-raf-performance:5.1, continuation 2026-10-26

The assigned CPU fix is already present at base `f5a19cac579047d38f28a8a63fadb59bc24715c2`.
The original genuine red is run `07aa27a8-63ba-4a4d-b4fd-a53006942be8`,
recorded in `../profile-raf-performance-5.1/red.stdout.json`: 29 redundant origin
revalidations across first and repeated report confirmation. The fix is
`f4eeb215458de4fbf54f7ede45a9e06fa2cd2626`, with identity-executor preservation
in `61f5ef0a9fa442fec476f7951e2d231baa5ed40e`.
The production profile is in `../profile-raf-performance-5.1/production-profile-summary.json`.
This continuation preserves that implementation and its original red aggregate.

## Regression execution after archival

Direct execution of configured `fix-raf-load-admission/worker-idle` was refused
before child spawn: run `5575ed64-6eb9-488a-91dc-38728d7b461f`,
`CALLER_UNAUTHORIZED: Test authorization changed while waiting`.
Main explicitly directed removal of the post-wait authorization recheck on
2026-10-26. The initial caller resolution and execution-environment/configuration
checks are retained. No new runtime threshold, interval or restriction was added.

The stable group is `profile-raf-performance/worker-idle-cost`; its HOME remains
`/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`.
Each `*.result.json` contains the full, unchanged TestRunResult JSON line;
`*.stderr` retains the other output; `*.cli.json` records command, SHA/workspace
context, CLI exit separately from child exit, and the unmodified tool envelope.
The trusted bridge reports `callerPhase: hotfix` even for requested `--phase red`;
the exact requested command is preserved without rewriting the returned result.

| Evidence prefix | Run | Interpretation |
| --- | --- | --- |
| worker-idle-refused | 5575ed64 | Archived-group preflight refusal, CLI 1, child null; not red |
| selection-skipped | 349b997d | Only the existing counter test executed; the new standalone file was outside configured inventory; not red |
| fixture-error | 5a541188 | New tests reached a fixture configuration error; not target red |
| red | 0cfff0cc | Genuine assertion failures: archived and removed-during-wait groups both hit the unwanted CALLER_UNAUTHORIZED; CLI/child 1 |
| hotfix | 31704d8b | All three tests passed after removal of the production gate; CLI/child 0 |
| final-group | c646387e | Both changed test files: 61 passed, CLI/child 0; includes configuration dependency checks after removing the two revoked-caller expectations |

Every recorded run cleaned up completely and did not time out. The final group
has no knownRed, unexecuted or unknown tests, groupState `complete`, nextAction
`complete`. The worker counter reports 21 first-call Git operations and 10
repeated-call Git operations, 31 operations through the identity executor and
zero redundant origin revalidations. HOME and scratch Git index checks pass.
The obsolete standalone file remains in the requested file list to preserve
the growing selection; the runner normalizes the final selection to the two
configured files shown in its result.

An earlier baseline pass `204e4b15-99fc-4068-8da5-26a9e1154a80` was observed,
but its complete raw result was not retained. It is not used as acceptance
evidence; the later complete results cover the same counter assertion.

`build.json` and `check-comments.json` preserve command stdout/stderr and exit 0,
with isolated HOME `RAF_QA_HOME=/tmp/raf-prp51-build-0ed3ce56`.

## Live CPU comparison

The stand `scripts/profile-worker-report-wait.ts` accepts a third positional
measurement duration in milliseconds and now reports Linux clock ticks, CPU
milliseconds and percentage of one core. This only changes the measurement
harness, not production timing. For this task the duration is 60000.
Both sides launch an actual isolated production worker, synthetic native UI,
real tmux and Git; capture quiet/report/blocked waits and CPU profiles; verify
brief delivery, worker exit, session finalization, reservation release and
cleanup. The baseline source is the immediate parent of the original fix,
`9a8c851bed373bd78bd62858449b946bd73fc0fc`; the fixed source is
`a71120f7b474688dcb692d55dce7bdf20b9f1855`.

Host execution was requested from main because the sandbox cannot create the
standard shared IPC root `/tmp/raf-ipc-1000`; the earlier limitation is recorded
in `../profile-raf-performance-5.1-d/cpu-before.stderr`. No sandbox bypass or
change to production socket policy was attempted.

Other tasks in the change remain open. This agent does not mark the assigned
checkbox and does not archive the change.
