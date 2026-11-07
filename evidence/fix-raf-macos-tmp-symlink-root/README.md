# Mac temporary root hotfix 1.1

Base: fa74f97dfa2a1a5ebcc719a9356fa37748a9c4ef. RED workspace: only imported regression in red.workspace.diff. GREEN workspace: source and regression in green.workspace.diff. No full branch merge.

Equivalent port of 5e5aecce1039c6f854b536bd647d56829fb431c5; source explanatory comment omitted to retain comment-free source style. Root-owned symlink is resolved and the canonical directory passes existing capacity/ownership/mode/protected-context checks. Non-root symlinks and realpath aliases retain rejection. No new validation, limit or timeout.

6f26ac74cb42c4bb1280c9751d4b466b7d1e71ce and f8604216d6b9deab30ab692410c678b9a8d7595d already covered by a09de8b590a4ec1b4ad178b95827bc250d6ffab9: signed UID regex in src/state-migration-darwin.ts:27; paginated reminder traversal in src/archive-events-runtime.ts:52; optional features defaults in src/app-runtime.ts:270,283. db2328f879326449087b5355e097a77715a72313 subsequently moves the database iterator import while preserving paging. Existing tests and prior RED/GREEN evidence reside in evidence/repair-raf-mac-bootstrap/34.6. No reapplication needed.

## Verification

Exact commands: red.command.txt, green.command.txt. Both use the same group and isolated QA HOME recorded in full unchanged red.TestRunResult.json and green.TestRunResult.json.

RED runId 286cae74-b723-4fff-84e8-118a46d0dc58: assertions-failed, CLI 1, child exitCode 1. One knownRed: root-owned system symlink test; failure TEMPORARY_DIRECTORY_INVALID. No setup/import failure. timedOut false, cleanup complete, unexecuted/unknown empty, group idle.

GREEN runId 227637d4-558d-4235-8686-6fbc7f267611: passed, CLI 0, child exitCode 0. knownRed/unexecuted/unknown empty, timeoutCount 0, timedOut false, cleanup complete, group complete. No further test action needed.

RED tool output was truncated; red.stderr-observed.txt explicitly records the retained stderr observations and limitation. Full JSON is preserved, not reconstructed. GREEN full merged tool output is in green.tool.json; green.stderr-observed.txt contains the observed warning/result-path segment. CLI exit codes are separate from child exitCode.

git diff --check passed. Readability self-review: base above to green.workspace.diff, entire prepareRunTemporaryDirectory (src/test-run-diagnostics.ts:352) and added test (test/test-run-diagnostics.test.ts:569). The existing function explicitly validates input, inspects root, resolves only the eligible system link, validates canonical identity, creates and verifies a private child, saves its reservation, and returns environment/state paths. Inputs and state changes remain explicit through configuration/context/ports; copied configuration does not mutate the caller. Added branch is local, names retain domain meaning, no new abstraction or duplicate implementation. Test explicitly constructs canonical identity and verifies canonical creation/TMPDIR. Existing rejection and cleanup coverage remains GREEN. Audit: task remains applicable for 5e5aecc; conditional other ports are already satisfied.

## Orchestrator handoff

Group registered in-place; registry-addition.json names exact addition, no unitFiles addition needed (already registered). Main must commit conf/test-runs.json. tasks.md checkboxes untouched; only verification selection appended. Own root commit blocked by read-only .git/index.lock (root-commit-error.txt). Exact document patch: orchestrator-tasks.patch. Main receives these paths and error through agent message; receipt saved in main-handoff.tool.json. Items 1.2/1.3 remain open; no activation, push or archive performed.
