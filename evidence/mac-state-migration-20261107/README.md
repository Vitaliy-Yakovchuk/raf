# Mac state maintenance hotfix, 2026-11-07

Baseline: `fced331e`, branch `mac-test-run-fixes`, Node v26.12.1, Darwin.

The existing production state was schema 18. Ordinary opens intentionally do not migrate; `scripts/migrate-state.ts` is the explicit, path-bound maintenance entry on both Linux and Darwin. Schema 19 adds `result_notices_run_id`; schema 20 adds `sessions_address_state`. The original `BOOTSTRAP.md` describes the first increment, not the current maintenance procedure. The current contract is Orchestrator `openspec/specs/projects/raf/state-store/spec.md`, requirement «Явне перенесення схеми».

Two code defects were reproduced with RED tests:

- Darwin migration inspection rejected signed UIDs such as `-2` in the system process inventory, returning `unknown` even after the service had stopped. The parser now accepts a signed UID and retains the same account filtering and descriptor checks. RED returned `unknown` instead of `quiescent`; GREEN also verifies that a same-account state holder remains `incompatible`.
- Archive observation loaded all pending/active reminders in one statement. RED reproduced `DB_ROWS_READ_LIMIT_EXCEEDED`, 65 > 50, on the current schema. The observer now uses the existing rowid keyset iterator and filters each page. GREEN retains the binding after 121 closed and 64 other live reminders, emits the archive event once, and preserves all 186 reminder records.

No read budget, timeout, guard bypass or schema version was introduced.

The live previous service had a legacy Darwin identity. The current identity observer intentionally requires that live legacy owner to drain. Its inactive-slot CLI refused production bootstrap; its existing `createBackgroundRuntime(...).stop()` lifecycle API stopped it normally without starting that slot or altering ownership files. The current slot then ran `scripts/migrate-state.ts --state <canonical production state> --from 18 --to 20 --backup <new canonical backup>` with the default Darwin client inspector, followed by `service start`. No symlink rollback or manual PID/socket/lock removal was used.

Validation:

```sh
TMPDIR=/private/tmp node --test --test-concurrency=1 \
  test/archive-events-read-limit.test.ts test/archive-without-reminder.test.ts \
  test/state-migration-darwin-quiescence-z477.test.ts test/state-migration-cli.test.ts \
  test/mac-state-migration.test.ts test/result-notices-run-index.test.ts \
  test/test-run-selection-aggregate.test.ts test/service-host.test.ts test/service-entry.test.ts
npm run build
node scripts/check-comments.ts
git diff --check
```

61/61 tests passed, none skipped. Build, comment check and diff check passed. The canonical TMPDIR avoids an existing fixture assertion that compares `/var` against `/private/var`. Sequential execution avoids unrelated test Node processes appearing during the default migration inspector's quiet interval; an initial parallel run correctly refused the uncertain inventory.

Live `agent ps` and `reminder list` returned exit 0 with empty stderr; service status was `ready`, `resourceWaitReady=true`, mainPath `raf-main-a`. Source backup schema 18 and production schema 20 both passed integrity checks. All existing session, reminder, pending intent and result notice IDs remained present; launch queue tables were unchanged. Normal CLI reconciliation finalized one already-exited run and released its admission reservation; no running session was closed. Existing reminders kept their states.

Full host evidence and the migration backup remain outside Git. No real AI agents were launched. Linux execution and the complete test suite were outside this hotfix's validation scope.
