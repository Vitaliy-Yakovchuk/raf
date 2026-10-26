# Audit of the z393 regression requirement

The idle-worker optimization remains applicable. Its deterministic counter is
green and the existing executor, HOME and Git-index checks still pass.

The required full `complete-raf-flow-contracts/z393` regression contains an
expectation that conflicts with the current recorded owner instruction.

Git commit `c22620eec8f792ef98451d8c8f81ed9cdea9adb6` (2026-10-26), already an
ancestor of this run's base, records verbatim:

> Owner 2026-10-26: remove git calls from validations together with the
> validations that need git; ban git in raf commands at code level; count
> git calls per service/worker process and warn above the conf threshold.

The same commit says:

> hotfix merge and checkbox commit run in the worker/service.

The corresponding implementation is `src/git.ts` (`runGitFreeCommand`,
`gitAllowed`, `GitInCommandError`) and the `gitAllowed()` check in
`src/production-runtime.ts#confirmReportedTasks`.

In `test/reported-commits-acceptance.test.ts`, `production(t, 'reconciliation')`
kills the actual worker with SIGKILL, keeps the native runner alive, publishes a
new report, then invokes `f.ps()` and expects immediate durable acceptance and
a checkbox Git commit. That CLI expectation predates the recorded owner change.
It cannot be restored by allowing Git in `agent ps` without reversing the owner
instruction. A current recovery regression needs the service/worker to confirm
the report, while the CLI observes the result.

During run `e0a3e6ee-96f4-403e-9837-98b419764a94`, the isolated aggregate was
read with SQLite `readOnly: true`: state `running`, timeoutCount 0, configured
deadline approximately 12:52 UTC. No ledger was modified. Its remaining live
fixture was `/tmp/r-3JFztI/raf-lfc-MROfVu`, with the
`control/reported-reconciliation.brief` marker and native runner PID marker.
This identifies the pending reconciliation fixture; it is diagnostic evidence,
not a completed assertion result.

A separate single `agent ps` call also remained pending. Its raw stderr says:

> Checkbox commit is left to the worker; raf commands do not run git

and reports retrying. This observation is consistent with the same policy
boundary. No second `agent ps` was launched, and the worker/CLI policy was not
altered under the idle-worker task.

This audit follows `projects/orchestrator/autonomous-development`, requirement
“Аудит та вилучення неактуальних змін”. Main must reconcile the regression
expectation in `profile-raf-performance:5.1` and the recovery fixture with the
recorded owner change. It does not invalidate or undo the proven removal of redundant origin revalidations.
