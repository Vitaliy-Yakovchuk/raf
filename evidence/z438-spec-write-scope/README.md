# Z.438 — spec write scope

Assignment: `complete-raf-flow-contracts:Z.438`; executor `raf-z438-hotfix`.

## Audit

The selected task remains open and applicable. Its explicit owner instruction
authorizes spec agents to write throughout the Orchestrator `openspec/` and
`conf/briefs/`. The change proposal's Why/What Changes describe completing raf
contracts. No new flow rule, timeout, or secret permission is needed.

Before the fix, `src/task-context.ts:deriveTaskContext` grants only the selected
change directories or the paths calculated for final archive, plus the project's
questions file. `bindWorkspaceBoundaries` does not add the code workspace for
spec/design. The same boundaries feed the assignment, launch, sandbox and
reported-commit context through `src/app-runtime.ts` and
`src/production-runtime.ts`. Secret masking is separate in `src/codex-sandbox.ts`.

Regression coverage: spec for projects Orchestrator and raf, with both remaining
work and final selected work; exact document roots and questions file; code/root
cwd does not widen the scope; selected tasks remain unchanged; implement retains
its previous scope. Trailing directory separators identify directories even when
they do not yet exist, following the existing archive-boundary convention.

## Initial setup refusal (not red)

`red-refused.command.txt` records the exact authorized command. The host returned
runId `ffc927a5-fd8c-43f0-9b68-af0f72f60f09`, outcome `refused`, error
`EMPTY_SELECTION`, CLI exit 1, child exitCode null, no timeout and complete cleanup.
The complete original JSON, stderr and CLI code are separate adjacent files.
There are no knownRed, unexecuted or unknown IDs; group snapshot is unavailable,
and nextAction is `fix-setup`. No assertion ran, so this does not establish red.

The active host profile did not discover the new test file. Registration in
`conf/test-runs.json` is outside this executor's write boundaries. The current
test-runs delta explicitly permits existing files supplied through `--files`
without unitFiles registration, so this refusal is a runtime/configuration
discrepancy, not a new requirement for Z.438. Registration was requested from
main; the group and QA HOME must remain stable.

`red.workspace-head.txt`, `red.workspace-status.txt`, `red.workspace.patch` and
`red.regression.ts` record the workspace before that attempt. Other agents' dirty
paths are not owned by this executor. No production fix preceded assertion-red.
