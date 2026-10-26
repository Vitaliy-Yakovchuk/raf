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

Host6 on `c2c294699fc9abc13ec7237731289d24299f5cb8` verified native Claude UUID `7d5f21f6-8690-4d90-806d-615f4ad3d33b` (PID 4193219), empty composer and actual `main attach` (coordinator PID 4193184). It stopped because the fixture attempted to close the known failed first actor using `--force` without required `--reason`. The production CLI refused arguments before action with `INVALID_VALUE`, empty completed/pending and `retrySafe:true`. The close now supplies a factual reason; the final successful actor cleanup also supplies its reason. Production validation is unchanged.

Preserve the verified live main and coordinator; do not stop or reattach them. Continue with:

```
env -u CLAUDE_CONFIG_DIR LC_ALL=C node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA --resume-after-close-refusal /srv/dev/s72-bDaBYe
```

This checks the exact failed command and argument refusal, existing UUID/process command lines/boot identity, live tmux session, successful attach and absence of unknown queued requests or actor launch. It creates exclusive `ev-native-close-reason` and `commands-native-close-reason`; commands go through the retained coordinator's existing queue with unique `close-resume-` labels. Original result JSON/stdout/stderr are copied unchanged to the new evidence paths. Completed startup, main readiness, attachment and original failed request are not replayed. All old artifacts are preserved, with newly completed commands added to the retained control directory. Only the old accepted failed actor can be closed by the continuation helper; the first two-switch actor has not been launched yet.

The fixture first registers a clean ordinary legacy production main with actual `service start`, while `mainCopies` is absent. This establishes the existing immutable generation through the real CLI, rather than making an unverified dirty clone its first generation. That real service stays alive. The fixture then enables `mainCopies`, writes staged/unstaged/untracked sentinels, and invokes actual `service start` for conversion. Both before/after Git states are captured; there is no direct layout/store call or injected registry in setup. The release engine uses real verification/activation gates, cross-store fetches and real compatibility probes on an isolated SQLite snapshot. The host registers complete immutable generations as the publication storage adapter; it never substitutes release gates with hand-built success objects. Native agents retain their original launch identity. The hotfix worktree remains permanent.

Handover is deliberately an assertion, not an always-true port: actual `service start` must return readiness in the newly registered generation. An old ready service does not prove handover and stops the dependent scenario with failure. No forced service restart or agent kill is used to manufacture a passing transition. During the second transition the same native actor writes its actual report, and production must accept it exactly once. A full pass additionally needs review of the returned native transcript and pending/report/ownership artifacts against the delta; the driver's exit zero alone is not the final QA verdict.

On failure, `summary.json` retains completed and unexecuted steps plus the original failure. Review the exact artifacts before any continuation; do not replay completed scenarios or blindly rerun unknown commands. A failed continuation retains the stand and live processes, marks cleanup incomplete, and remains failed. Successful completion cleans up only this stand's registered actor, tmux endpoints and verified stand-owned service processes. All artifacts remain available; credentials are never archived. These files prepare a reviewable host action and do not claim that the remaining live QA has run.

Host7 on `d193d87c3ccf9cc72c5373de4af8fd68945f704c` closed the original failed attempt, launched the first two-switch actor `sym72-native-2` (run `f1d4c6ce-6be9-4662-abe6-b38ed61f174d`, PID 65430, runner session `01a175b4-8fe8-7943-8752-7bcbc3b50a9b`), and verified its stage-0 original-prefix ps/message/ACK. The first release stopped before publication: build returned 0, but the snapshot fingerprint changed because the copied legacy `dist/catalog.json` lacked current `mainCopies`. The exact fingerprint validator correctly rejected it. Source build now happens before sealing, so the sealed artifact already describes the current configuration; verification still rebuilds and checks exact bytes.

The initially prepared catalog continuation (never executed, now inapplicable because the actor already has an accepted failed report) was:

```
env -u CLAUDE_CONFIG_DIR LC_ALL=C node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA --resume-after-catalog-build /srv/dev/s72-bDaBYe
```

It creates exclusive `ev-native-catalog-build` and `commands-native-catalog-build` evidence. It verifies the exact Host7 failure, unchanged original main/coordinator, the existing running actor's runId/PID/start time/runner session/boot identity/brief, its original stage-0 ACK, the single `A-before` SQLite row, unchanged active main and already prepared develop commit. It refuses any report or later stage marker, unknown queue request or publication intent. It skips actor launch, stage-0 ps/message/ACK, database setup and the already committed release marker. New command labels start `catalog-resume-` in the retained coordinator queue. It builds only the nonactive release source before beginning a newly sealed candidate; it does not overwrite the active main or weaken any gate. A lost identity stops this continuation rather than replacing a live actor. The initial failed build and all earlier artifacts remain evidence.

Read-only inspection subsequently found the actor's original report, written at 2026-10-26T00:56:45 and accepted as failed by production. The report SHA256 is `7e455c2a4fe355ba6dac017b3e880ccf4fb7853d8c04f4153c2395bf3f1bbda3`. It explicitly says that wait 1 yielded after 30 seconds without an exit code, and incorrectly treats the yielded exec session as unknown. This failed attempt remains failed. Its namespace helper PID 2 is not a host process identity. The catalog continuation correctly refuses this state and must not be executed.

The fixture instruction now explicitly requires polling the same exec session through write_stdin/session_id or wait/cell ID until the final exit code, including every wait 0..4. A tool yield alone is not a final result. This is a manual native regression: syntax/build and the catalog unit test cannot prove the corrected actor follows that instruction.

Use only this newly addressed continuation after the reviewed fix is committed:

```
env -u CLAUDE_CONFIG_DIR LC_ALL=C node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA --resume-after-native-wait-report /srv/dev/s72-bDaBYe
```

It creates exclusive `ev-native-wait-report` and `commands-native-wait-report`, uses unique `wait-resume-` commands through the retained coordinator and verifies the same Host7 no-publication boundary. It requires the exact actor 2 report digest and production failed acceptance, archives the original report/session/transcript before closing only that known failed actor, and verifies the archived failed report after close (the temporary source may be deleted by production). It patches and commits only `qa/sym72-instructions.txt` in the isolated develop fixture. Active main, native Claude main, coordinator, service, prior artifacts, SQLite data and the completed conversion are preserved. Actor `sym72-native-3` runs the first complete chain of two switches; no switch has yet completed. The already inserted `A-before` row and existing release-marker commit are reused. Actor 2's partial stage-0 actions remain evidence of its failed attempt; actor 3 has its own original prefix, runId, PID and runner session to check across both switches. The full host transcript and accepted successful JSON are still required for green.

Host8 (830994e) closed actor2 successfully and failed at the subsequent source-report hash because close removed its run tmp. Its archived original report/session/native evidence and exact failed summary remain in ev-native-wait-report. That continuation cannot be repeated. Use the newly addressed boundary only:

```
env -u CLAUDE_CONFIG_DIR LC_ALL=C node scripts/qa-main-symlink-live.mjs FULL_REVIEWED_COMMIT_SHA --resume-after-report-close /srv/dev/s72-bDaBYe
```

Exclusive evidence directories are ev-native-report-close and commands-native-report-close; request labels start report-close-resume-. The continuation validates exact Host8 SHA/ENOENT, completed/pending boundary, CLI 0/closed:true failed close, compacted finished actor record against its archived full identity and failed acceptance, unchanged report archive SHA and absent original run tmp. It never reissues close or probes the finished process. It reuses the original full pre-close archive solely as historical evidence; live state must say finished with failed result, cleared response/proof and matching forced-close reason. Main/coordinator identity, active slot, no-publication boundary, queued requests, develop SHA and existing SQLite data remain guarded. It then patches only isolated fixture instructions and launches actor3 once for the first complete chain. Unit green verifies archive lifetime only; actual native evidence remains required.
