# Mac Claude result notice acknowledgement — 2026-10-28

Owner assignment: `/Users/val/.raf/mac-start/20261028/briefs/raf-mac-notice.md`.
Existing requirement: projects/raf/agent-message, «Вставка без прийняття» and «Спостережене прийняття без semantic ack». No new requirement, limit or timeout.

Baseline `de80118d45af63151878c2182bdd6175b3220245` already includes the parallel raf-mac-codex work. Test commit `dc6aeebf`; minimal implementation `96893a88`.

Claude Code 2.1.312 on Darwin temporarily replaces its ready footer with `paste again to expand` while the composer contains `[Pasted text #1 +12 lines]`. Captured native non-screen-reader panel tail is frozen verbatim in `test/fixtures/mac-claude-notice/pending.txt`. `deliverCheckedMessage` rejected this `unknown_screen` before examining the matching pending paste. The transport had already sent Enter, so main could receive the message despite the false refusal.

Fix permits this transient frame only when the configured mode hint and the exact pending message match, and observation has no permission/auth/trust blocker. It continues the existing bounded verification and single Enter retry. The hint alone is never a receipt. Changed recognized screen, cleared composer and reverified identity still determine acceptance. Durable result notice settlement then prevents any second send, including after store reopen.

RED: 3 assertion failures / 1 pass, exit 1, not setup/import errors (`red.*`). GREEN: 50/50, exit 0 (`targeted-layout.*`); includes new delivery/durable no-resend regression, draft/identity/permission controls, Claude protocol/context, inactive recipient, durability and agent close. `npm run build` exit 0 (`build-deps.*`). Initial dependency and conventional-layout setup failures are preserved privately, not counted as assertion failures or passes; npm ci and a temporary sibling raf-main symlink to this exact worktree supplied the existing fixture layout, then the symlink was removed.

Native probe used its own tmux socket `raf-mac-notice-probe`, not the owner's pane. A 13-line probe in screen-reader mode on the same installed 2.1.312 captured the pending placeholder/hint (`native-pending.txt`), followed by changed history and empty composer (`native-accepted.txt`); real deliverCheckedMessage returned accepted:true (`native-result.json`). The runner subsequently answered RAF_MAC_NOTICE_ACK. Main's existing duplicated messages were observed read-only in its %0 pane; private full captures remain at `/Users/val/.raf/mac-start/20261028/artifacts/raf-mac-notice/`.

Assigned direct fallback: raf_command/TestRunResult unavailable in this launch; exact native node commands, stdout/stderr and child exit codes are retained instead. No claim of a managed raf test-run aggregate.
