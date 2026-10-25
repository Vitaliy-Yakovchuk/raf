Host channel for `switch-raf-main-by-symlink:7.2`, authorized by main in this session.

Run once from a clean reviewed raf clone. The clone needs installed ignored `node_modules`; its parent needs a copy of Orchestrator `conf`. Use the existing host provider selector, without copying credentials or changing models/effort:

```
LC_ALL=C CODEX_HOME=/home/dev/.codex node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA
```

The first stdout record names `/srv/dev/s72-*/ev`. Preserve complete stdout, stderr and host exit code separately, and return that evidence directory. No unit commands run. The setup's committed QA instructions and CLI output audit do not modify validators, sandbox, routing, native grants or report acceptance. All native RAF commands must be separate direct tools using the original brief prefix. Native tool transcripts, sessions, original brief, exact CLI results, real service output, release gates and Git/state snapshots are archived.

The conversion starts with an ordinary registered main directory and actual `service start`; there is no direct layout/store call in setup. The release engine uses real verification/activation gates, cross-store fetches and real compatibility probes on an isolated SQLite snapshot. The host registers complete immutable generations as the publication storage adapter; it never substitutes release gates with hand-built success objects. Native agents retain their original launch identity. The hotfix worktree remains permanent.

Handover is deliberately an assertion, not an always-true port: actual `service start` must return readiness in the newly registered generation. An old ready service does not prove handover and stops the dependent scenario with failure. No forced service restart or agent kill is used to manufacture a passing transition. During the second transition the same native actor writes its actual report, and production must accept it exactly once. A full pass additionally needs review of the returned native transcript and pending/report/ownership artifacts against the delta; the driver's exit zero alone is not the final QA verdict.

On failure, `summary.json` retains completed and unexecuted steps plus the original failure. Review the exact artifacts before any continuation; do not replay completed scenarios or blindly rerun unknown commands. Cleanup targets only this stand's registered actor, tmux endpoints and verified stand-owned service processes. All artifacts remain available; credentials are never archived. These files prepare a reviewable host action and do not claim that live QA has already run.
