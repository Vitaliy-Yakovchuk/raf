# Evidence: fix-raf-service-restart-hang (Task 1.1)

## 1. Red Run (`--phase red`)

- **Command**: `node /srv/dev/work/orchestrator/raf-main-a/bin/raf.ts test run --project raf --phase red --group fix-raf-service-restart-hang/unit --files test/background-runtime-unit.test.ts test/background-runtime.test.ts`
- **Workspace**: `/srv/dev/work/orchestrator/raf-hotfix`
- **HEAD SHA**: `4d700c43ea0091a93accc33ff6c1b8164358cc9b`
- **Uncommitted workspace changes**: `M test/background-runtime-unit.test.ts`, `M test/background-runtime.test.ts`
- **CLI exitCode**: `1`
- **Child exitCode**: `1`
- **runId**: `5940fe46-fa59-4752-86a4-3523f5aff5d1`
- **Selection**: `{"files":["test/background-runtime-unit.test.ts","test/background-runtime.test.ts"],"testIds":[]}`
- **Outcome**: `"assertions-failed"`
- **Timeout / Cleanup**: `timedOut: false`, `cleanup: {"complete":true,"remainingPids":[]}`
- **knownRed**:
  1. `test/background-runtime-unit.test.ts` — `U5: service stop during startup recovery interrupts recovery and leaves service stopped instead of stopping`
  2. `test/background-runtime-unit.test.ts` — `U6: producer shutdown during startup recovery interrupts recovery without waiting for blocked start`
  3. `test/background-runtime.test.ts` — `service stop during startup recovery on isolated QA HOME interrupts recovery and leaves service stopped instead of stopping`
- **unexecuted**: `[]`
- **unknown**: `[]`
- **groupState / nextAction**: `groupState: "idle"`, `nextAction: "implement"`
- **Artifacts**:
  - Full unmodified `TestRunResult` JSON: [red-test-run-result.json](./red-test-run-result.json)
  - Separate stderr: [red-stderr.txt](./red-stderr.txt)
  - Metadata & CLI exit code: [red-meta.json](./red-meta.json)

## 2. Green Run (`--phase hotfix`)

- **Command**: `node /srv/dev/work/orchestrator/raf-main-a/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-service-restart-hang/unit`
- **Workspace**: `/srv/dev/work/orchestrator/raf-hotfix`
- **HEAD SHA**: `4d700c43ea0091a93accc33ff6c1b8164358cc9b`
- **Uncommitted workspace changes**:
  - `M src/background-runtime.ts`
  - `M src/bug-sync.ts`
  - `M src/production-service-ports.ts`
  - `M src/service-lifecycle.ts`
  - `M test/background-runtime-unit.test.ts`
  - `M test/background-runtime.test.ts`
- **CLI exitCode**: `0`
- **Child exitCode**: `0`
- **runId**: `5bac469b-6c09-45f5-bf9d-25e131021927`
- **Selection**: `{"files":["test/background-runtime-unit.test.ts","test/background-runtime.test.ts"],"testIds":[]}`
- **Outcome**: `"passed"` (59 passed, including the 3 new regression tests)
- **Timeout / Cleanup**: `timedOut: false`, `cleanup: {"complete":true,"remainingPids":[]}`
- **knownRed**: `[]`
- **unexecuted**: `[]`
- **unknown**: `[]`
- **groupState / nextAction**: `groupState: "complete"`, `nextAction: "complete"`
- **Artifacts**:
  - Full unmodified `TestRunResult` JSON: [hotfix-test-run-result.json](./hotfix-test-run-result.json)
  - Separate stderr: [hotfix-stderr.txt](./hotfix-stderr.txt)
  - Metadata & CLI exit code: [hotfix-meta.json](./hotfix-meta.json)
