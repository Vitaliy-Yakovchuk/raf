Second fixture finding for 7.2: missing registered hotfix worktree

Main supplied contracts-retry run ce13e2d8 (foreign regression is not rerun without a regressionGroups grant). Own real filesystem/Git regression executes the fixture and actual store/layout helper up to the entry boundary, checks registered develop/hotfix branches sharing source store and a separate production store. No product validator is weakened.

Own red: --phase red --group switch-raf-main-by-symlink/production-start-layout --files test/production-start-layout.test.ts; run 31211d45-5cac-4d7f-81d5-4a8980f0ed7c; CLI/child 1/1; 14 passed, one knownRed, no unknown/unexecuted, cleanup complete, no timeout, idle/implement.

Fix: register permanent hotfix worktree before production layout. Own qa same group/files/HOME: run 077e413d-0c8b-4960-a1cc-e181f2b5fe3b; CLI/child 0/0; all 15 passed, no knownRed/unknown/unexecuted, complete/complete. This is a unit regression using real Git, not the required native live stand.
