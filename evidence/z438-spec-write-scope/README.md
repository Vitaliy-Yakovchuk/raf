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

## Handoff state

Discovery in `src/test-run-runtime.ts` collects the configured profile files;
the host generation's `src/test-runs.ts` filters the selection against those
observed facts before checking profile membership. Committing the new test does
not change that configuration, so the refused command was not blindly retried.

The authorized `agent ps` did not return an address list. Its captured stderr
reports pending confirmation of unrelated run
`4f3c44bb-7576-4c56-b36c-95adba2da500` at the checkbox stage for
`monitor-raf-health:7.6`. `agent-ps.pending.json` and its separate stderr preserve
this observation; no exit code or complete ps result was received. No recipient
was guessed and no direct host-state access was attempted. A request for main
registration and the address list was sent through the user clarification tool.

The regression suite passed syntax checking (`node --check
test/spec-write-scope-z438.test.ts`, exit 0). This is not a unit pass. Production
code remains unchanged, no hotfix confirmation ran, and Z.438 remains open.
The report therefore uses `failed`, not `succeeded`. There are other open tasks
in the change, so no sync/archive applies.

Next: main registers this exact file in the raf unit profile (and optionally the
`complete-raf-flow-contracts/z438` preset), resolves the pending coordination
result, and resumes the same group/QA HOME. First obtain actual assertion-red;
then grant spec's document boundaries `openspec/` and `conf/briefs/` and update
the existing task-context scope assertions to the authorized requirement. Keep
the questions-file boundary and the existing secret masks, code-workspace and
Git isolation; confirm through `--phase hotfix` and the same cumulative file
selection. No new restriction, timeout, flow stage or budget reset is proposed.
