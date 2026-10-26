Host channel for `switch-raf-main-by-symlink:7.2`, authorized by main in this session.

Run once from a clean reviewed raf clone. The clone needs installed ignored `node_modules`; its parent needs a copy of Orchestrator `conf`. Use the existing host provider selector, without copying credentials or changing models/effort:

```
LC_ALL=C node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA
```

The first stdout record names `/srv/dev/s72-*/ev`. Preserve complete stdout, stderr and host exit code separately, and return that evidence directory. No unit commands run. The setup's committed QA instructions and CLI output audit do not modify validators, sandbox, routing, native grants or report acceptance. All native RAF commands must be separate direct tools using the original brief prefix. Native tool transcripts, sessions, original brief, exact CLI results, real service output, release gates and Git/state snapshots are archived.

The host must retain its existing absolute `CODEX_HOME` and `HOME` selectors in the invocation environment. `CLAUDE_CONFIG_DIR` is optional: when set, its absolute path is passed through; when unset, only the actual Claude invocation receives the original host `HOME`, allowing its existing default profile. The coordinator and RAF commands retain the isolated stand HOME. The selectors are passed explicitly to the new tmux session, and an unset Claude selector is removed from the pane environment even if the existing tmux server retained an old value. The fixture neither reads nor copies authentication files. Main's pane runs the configured genuine Claude executable and base arguments, with an assigned UUID confirmed through the native `/status` UI and an empty composer confirmed with the actual runner protocol. Its default model and effort are not overridden. The Node coordinator owns only the host command queue; Claude owns terminal input and receives actual messages through the production delivery validator.

Host3 on `da07afe4a1bd13a2cc56389bd56d03eb7502b4d4` already completed `actual-start` on `/srv/dev/s72-bDaBYe`. Do not run that scenario again. The first actor failed on its first message because the former Node stdin receiver had no recognized Claude composer. Main stopped only the driver with SIGTERM/15 and retained the stand. Use this addressed continuation from a clean reviewed clone with dependencies; its parent conf is not copied over the preserved stand:

```
LC_ALL=C node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA --resume-after-start /srv/dev/s72-bDaBYe
```

This verifies the original completed/pending boundary, requires no publication or earlier continuation, retains the existing product code/build/Git/SQLite and real service, and replaces only the invalid fixture main pane. It closes the accepted failed actor attempt before launching the first actor for the still unexecuted two-switch chain. The continuation driver SHA and preserved product SHA are recorded separately. It creates fresh `ev-native-main` and `commands-native-main` directories and refuses existing paths instead of repeating an unknown invocation. Return the complete new evidence directory plus host stdout/stderr/exit. The original `ev` and its initial failure remain evidence.

Host4 on `ae1d7cce7a8f572eb0e01d50c5b16a0d2c1334ed` stopped before native main spawn because the fixture incorrectly required version equality. Z.335 makes a successfully parsed mismatch a warning. The fixture now uses the shared RAF availability probe, records the actual version and warnings in `native-main-version.json`, and passes the observed version to screen observation without changing the configured protocol. Missing, failed and unparseable binaries still refuse; native UUID, readiness and delivery checks remain required.

Continue that exact known preflight boundary with:

```
LC_ALL=C node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA --resume-after-version-check /srv/dev/s72-bDaBYe
```

This checks Host4's original failed summary, exact failure and absence of native readiness or launch, then creates exclusive `ev-native-main-version` and `commands-native-main-version` directories. It preserves both previous evidence directories, the existing service, product snapshot and the completed conversion. An already exited fixture pane is accepted only after an explicit tmux session inspection. No live actor or release from the two-switch chain has run yet.

Host5 on `9652907463e32d1b4026d15bf0f7a835de51229b` successfully admitted actual Claude 2.1.310 with a version warning, then stopped at the theme onboarding screen because the host selected a profile without onboarding state. Main confirmed that its default host profile is already configured. Do not repeat the version-check continuation: its evidence paths exist. Use the new addressed boundary:

```
env -u CLAUDE_CONFIG_DIR LC_ALL=C node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA --resume-after-main-onboarding /srv/dev/s72-bDaBYe
```

This requires the exact Host5 failed startup summary, available native version, theme screen and absence of readiness/launch artifacts. It creates exclusive `ev-native-main-home` and `commands-native-main-home`, preserves all previous evidence and leaves the completed actual-start untouched. The fallback host HOME is supplied only to the genuine native Claude child. Unit proof of environment selection does not prove native composer readiness, delivery or any of the seven pending live scenarios.

The fixture first registers a clean ordinary legacy production main with actual `service start`, while `mainCopies` is absent. This establishes the existing immutable generation through the real CLI, rather than making an unverified dirty clone its first generation. That real service stays alive. The fixture then enables `mainCopies`, writes staged/unstaged/untracked sentinels, and invokes actual `service start` for conversion. Both before/after Git states are captured; there is no direct layout/store call or injected registry in setup. The release engine uses real verification/activation gates, cross-store fetches and real compatibility probes on an isolated SQLite snapshot. The host registers complete immutable generations as the publication storage adapter; it never substitutes release gates with hand-built success objects. Native agents retain their original launch identity. The hotfix worktree remains permanent.

Handover is deliberately an assertion, not an always-true port: actual `service start` must return readiness in the newly registered generation. An old ready service does not prove handover and stops the dependent scenario with failure. No forced service restart or agent kill is used to manufacture a passing transition. During the second transition the same native actor writes its actual report, and production must accept it exactly once. A full pass additionally needs review of the returned native transcript and pending/report/ownership artifacts against the delta; the driver's exit zero alone is not the final QA verdict.

On failure, `summary.json` retains completed and unexecuted steps plus the original failure. Review the exact artifacts before any continuation; do not replay completed scenarios or blindly rerun unknown commands. A failed continuation retains the stand and live processes, marks cleanup incomplete, and remains failed. Successful completion cleans up only this stand's registered actor, tmux endpoints and verified stand-owned service processes. All artifacts remain available; credentials are never archived. These files prepare a reviewable host action and do not claim that the remaining live QA has run.
