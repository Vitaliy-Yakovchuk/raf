# 2.10 — доказ RED/GREEN

- Група: `remove-artificial-workspace-restrictions/d1-private-tmpdir`, файл `test/test-run-d1-private-tmpdir.test.ts`.
- RED (`red-test-run.json`, runId 4946ef52-729c-4c13-a25e-1d349411f665, SHA бази 3fc362a + незакомічені зміни): outcome assertions-failed, exit code CLI 1; knownRed — «accepts a suitable private TMPDIR longer than 50 bytes», падіння на `src/test-run-runtime.ts:265` (ENVIRONMENT_INVALID).
- GREEN (`green-test-run.json`, runId 2d127d0d-8aa2-4a06-ab79-61f121ed445b, phase hotfix): outcome passed, 3/3, cleanup complete, groupState complete.
- Повні TestRunResult збережено без змін; stderr містить лише попередження conf про чужі групи etchly.
