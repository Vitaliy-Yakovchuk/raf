# Hotfix 1.3: bounded completed-test cleanup

Доручення `fix-raf-test-run-selection-aggregate:1.3` актуальне: на HEAD `fda157e7d88717dc3355feda3a807f8bfd36716c` обидва cleanup SELECT необмежені. Чинний read guard і ліміт 50 залишено без змін; нових вимог або обмежень немає.

`src/test-run-runtime.ts` використовує наявні keyset-сторінки `rowid > cursor ORDER BY rowid LIMIT 50`: для агрегатів читає сторінки через `readDatabaseTable`, для resource usage обходить їх через `iterateDatabaseTable`. Видалення під час обходу не пропускає наступних сторінок. Збережено перевірки kind, resultStatePath, finishedAt, lastResult/inFlight runId та порівняння payload перед DELETE.

Регресія викликає справжній `runConfiguredTestRun` на приватних файлових SQLite, підміняючи caller, ресурсний admission/чергу та child runner. Два випадки містять 120 або 3 агрегати й 125 usage-записів (124 test + 1 agent). Перевіряються видалення всіх 120 завершених test-записів, збереження lastResult, inFlight (в останньому агрегаті, за межами першої сторінки), незавершеного, чужого statePath та agent-запису, незмінність отриманого результату CLI. Observer перевіряє всі SQL cleanup: чинний limit=50, rowsRead≤50, наявність повної сторінки. Контрольний стан raf не використовується фікстурою.

## Прогони

Повні незмінені `TestRunResult`: [red-result.json](red-result.json), [hotfix-result.json](hotfix-result.json). Копії побайтово звірені з файлами, названими у stderr; оригінальні адреси й SHA-256 наведено в [runs.json](runs.json). Там само точні команди, CLI exit code окремо від child exitCode, відбір, runId, outcome, cleanup, timeout, knownRed/unexecuted/unknown, стан групи й наступна дія.

- RED `fdd6b686-7119-41e5-a592-fbc4b0eedfa9`: CLI 1 / child 1, assertions-failed, 2 knownRed. Відтворені саме `DB_ROWS_READ_LIMIT_EXCEEDED` на рядках 493 (120 > 50) і 498 (124 > 50), через assertion поверненого коду CLI; це не setup/import failure тестового процесу.
- Hotfix `6a31b4db-2bdf-45de-8da7-f0b684854332`: CLI 0 / child 0, passed 2/2, groupState=complete, nextAction=complete, knownRed/unexecuted/unknown порожні.
- Обидва: cleanup.complete=true, timedOut=false, timeoutCount=0; одна група `fix-raf-test-run-selection-aggregate/completed-cleanup` та той самий QA HOME/statePath. Час очікування ресурсної черги включено в durationMs.

Повні captures: [red-tool.json](red-tool.json), [hotfix-tool.json](hotfix-tool.json); stderr окремо: [red-stderr.txt](red-stderr.txt), [hotfix-stderr.txt](hotfix-stderr.txt). Вивід інструмента не обрізано. Попередження про чужі профілі, Dash і ресурсне очікування збережені; вони не підміняють outcome.

SHA й незакомічені зміни на момент виконання: [red-workspace.json](red-workspace.json), [red-workspace.patch](red-workspace.patch), [hotfix-workspace.json](hotfix-workspace.json), [hotfix-workspace.patch](hotfix-workspace.patch). Після RED виправлено помилку допоміжного observer assertion: queryId є хешем SQL, тому відбір метрик перенесено на момент після повернення child runner. Твердження потрібної поведінки cleanup не змінювалися.

Реєстрація групи й unitFiles передана main для коміту: [registry.json](registry.json). `git diff --check` і `node scripts/check-comments.ts` пройшли з кодом 0. Пункт 9.1 залишається main: активація й archive до цього доручення не входять. Галочки 1.3 ставить raf після прийняття JSON-звіту.
