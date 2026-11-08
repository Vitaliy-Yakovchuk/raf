# raf-coordinator-project-change-scope 1.1 — unit evidence

Group: `raf-coordinator-project-change-scope/coordinator-scope`, file `test/coordinator-project-change-scope.test.ts`, base SHA `7db18c16828030cb23324b5a1c619705b8c97c80`.

| Run | Command | Workspace | runId | Outcome | CLI code |
| --- | --- | --- | --- | --- | --- |
| RED | `raf test run --project raf --phase red --group raf-coordinator-project-change-scope/coordinator-scope` | base SHA + new test, without the `src/task-context.ts` fix | `40a94bef-0472-4e5c-afa8-4006dc334ba8` | assertions-failed: knownRed = coordinator test; 4 other-type tests passed; cleanup complete | 1 |
| GREEN | `raf test run --project raf --phase implement --group raf-coordinator-project-change-scope/coordinator-scope` | base SHA + test + fix (uncommitted) | `568a936e-4efc-474f-b861-be6aad5ce0c2` | passed 5/5; knownRed/unexecuted/unknown empty; cleanup complete; group complete | 0 |

Full `TestRunResult`: [red-test-run-result.json](red-test-run-result.json), [green-test-run-result.json](green-test-run-result.json). Stderr was not captured separately; the full results are kept.

Scope: coordinator gets `openspec/changes/` (all active changes of its project plus new change folders). Sandbox boundaries are directories, so a folder with an unknown new name is allowed only through the changes root. Other types keep only their assigned changes.
