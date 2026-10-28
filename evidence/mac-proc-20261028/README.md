# Darwin test-run process hotfix — 2026-10-28

Owner brief: `/Users/val/.raf/mac-start/20261028/briefs/raf-mac-proc.md`.
Baseline: `f8328d66e2cf5f9caa30f71b413380a1e800630e`, branch `mac`, shared branch directory, no new worktree.

- RED: `node --test test/test-run-darwin-process.test.ts`, exit 1, three behavioral assertion failures: `/proc/<pid>/stat` unavailable; live reservation unknown; treeControlSupported false. Test imports/setup succeeded. The three original assertions remain; GREEN additionally checks scan failure and PID mismatch cannot release/signal a live tree.
- GREEN: same command, exit 0, 4/4. Actual native `ps`/`sysctl`, real detached Node child with a live descendant, process start checked against readWaitIdentity, cleanup and recovery confirmed dead. Malformed identity, changed boot/start and scan failure preserve fencing semantics.
- Fix: Darwin-only synchronous process adapter reuses the existing readWaitIdentity start normalizer (`darwin-utc:`). Boot representation matches readMachineBootIdentity. Native process/parent/group/RSS observation replaces `/proc` only on Darwin; runtime preflight, spawn identity, reconciliation and cleanup use the same adapter. Linux branches retained. No new product policy, limits or timeout.
- `node scripts/build.ts`: exit 0.
- Targeted recovery/reservation/HOME suite: 44/44 exit 0. Requested nonexistent resource-wait-identity.test.ts matched no file; actual identity controls are covered in the following suite.
- `node --test test/resource-wait-runtime.test.ts test/mac-bootstrap.test.ts test/test-run-admission-z465.test.ts`: 21 pass/1 fail. All 7 Darwin bootstrap tests and all 9 admission tests passed. Unrelated startup lease cancellation assertion fails unchanged with baseline resource-wait-identity.ts loaded from f8328d66 (baseline-lease logs). Baseline loader initially lacked TS stripping: setup failure preserved separately; it is not baseline assertion evidence. Loader is `/Users/val/.raf/mac-start/20261028/artifacts/raf-mac-proc/baseline-loader.mjs`.
- Direct node:test is authorized by the brief because raf_command is unavailable. These logs are not TestRunResult. Physical Linux verification was not performed.

Deployment and real etchly CLI results are recorded separately in `/Users/val/.raf/mac-start/20261028/artifacts/raf-mac-proc/` and the final report. Same existing stand HOME/state/group are retained from raf-mac-home; budgets are not reset.
