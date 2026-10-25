# add-raf-agent-run 2.3

## Result

The production regression is fixed: close now reconciles the retired run when inspection detects that its PID belongs to a different process, then refuses control of the foreign process. The existing reused-PID regression is green. No tests were modified by this executor.

Main split the remaining 38 stale-fixture failures into item 2.3.1 ([test-scaffold]) and instructed this executor to finish 2.3 with the close fix and this handoff. The full contracts group is still red, not passed.

## Verification

Command for both runs:
`node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase implement --group add-raf-agent-run/contracts`

- Initial run 994b35e8-7e9e-4a6a-bc47-bf9074b646ef: setup-failed, CLI 1, child 1. An unsupported TypeScript parameter property introduced in the initial fix prevented parsing. It was corrected before verification; this run is retained unchanged.
- Verification 6849d8a3-a0eb-4b79-9ec4-b090827799e2: assertions-failed, CLI 1, child 1, 570 passed / 38 knownRed. unknown=[], unexecuted=[], timedOut=false, timeoutCount=0, cleanup complete with no remaining PIDs, groupState=idle, nextAction=fix-implementation. Group snapshot loaded.
- Same configured contracts group (15 files, no --files or --only), same QA HOME, no counter reset. Exact selection, identifiers and timeout policy are in the complete TestRunResult.
- Tested HEAD 6465b8bb1036a92c43f9f482218111c6795fe5a9 plus dirty source captured in verify-workspace.txt: own close/ownership fix and concurrent 3.1 message fencing. Both former 2.1 message race tests were green from the other executor's 3.1 work; this executor does not claim those changes.
- npm run build: exit 0; git diff --check: exit 0.
- The exec transport exposes combined output. Each complete output consists of the stdout JSON emitted by runTestRunCli; no additional stderr bytes were observed. The stderr files record this empty observed remainder, not an independently captured file descriptor. Raw command output, unchanged full result, CLI exit code and child exit code are preserved separately.

## Exact fixture handoff (38)

1. 15 task-context assertions and 3 admission assertions: mock RuntimeConfiguration.commandTiming omits required sqliteOnlyMeanBudgetMs (test/task-context.test.ts:202 and test/agent-run-admission-snapshot.test.ts:355). Runtime preflight validation now rejects these before the intended behavior. Keep production validation; provide a valid positive budget in fixtures.
2. 1 task-context reportSchema assertion (test/task-context.test.ts:446-474): mutates source reportStatuses after build but loadTaskContextConfiguration now consumes the compiled catalog snapshot by default. Inject a freshly compiled fixture snapshot for the changed constants; preserve the consistent compiled-catalog contract.
3. 1 app-runtime timing write failure assertion (test/app-runtime.test.ts:360-373): budget already valid. Synthetic SCAN_UNAVAILABLE is absent from the actual compiled errorCodes; src/cli.ts normalizes it to HANDLER_FAILED. Use a registered code or explicit fixture catalog declaring the code to test primary failure/redaction preservation. Do not weaken unknown-code normalization.
4. 18 task-context-z12 setup failures: test/z12-fixture.ts:109 compiles real examples with narrow fixture projects; newer etchly test-run example references a project absent from that inventory, producing INVALID_VALUE before routing assertions. Make fixture examples/project inventory consistent, preserving intentionally invalid routing profiles separately and keeping catalog example validation.

The first broad budget diagnosis was corrected by the exact breakdown above, delivered to main (receipt 8964e45e-cecd-4f2f-b55f-77eec00a5f00). Subsequent failures after fixture repair are not yet known.

Foreign test-scaffold changes appeared in the shared worktree after verification. They are neither part of this tested snapshot nor this executor's commit. Foreign message changes remain uncommitted for raf-ara31-impl to commit separately.

