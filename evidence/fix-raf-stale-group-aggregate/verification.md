# fix-raf-stale-group-aggregate:1.1

База: ee3d23ac26b52e6f2d7b16da5336251c7ee55747. Незалежна початкова реалізація завершена до читання тестів. Аудит proposal/tasks та коду підтвердив актуальність unit-багу; integration вже враховував registry contraction.

Команди: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase red --group fix-raf-stale-group-aggregate/unit`; потім двічі та сама команда з `--phase implement` (другий implement після виправлення суперечливої старої фікстури).

Відбір усіх прогонів: test/test-run-stale-group-aggregate.test.ts, test/test-run-selection-aggregate.test.ts, test/test-runs.test.ts, test/test-run-stale-unknown.test.ts. QA HOME незмінний, без reset; повні оригінальні TestRunResult — red.json, implement-first.json, green.json. CLI codes окремо від child exitCode.

RED c92fe4de-be1f-4c57-b64e-5c80bc087ac1: assertions-failed, 98 pass, 2 knownRed саме нової регресії, CLI/child 1. Для RED власний production-файл тимчасово відновлено з HEAD після збереження незалежного кандидата /tmp/frsga-implemented.ts; ізольований /tmp worktree не використовувався. Це відхилення від рекомендованого маршруту RED зазначене явно. Інших production-файлів не змінював. Вивід інструмента обрізав stdout RED, проте TestRunResult збережено повністю. red.stderr збережено з видимого stderr: ті самі чотири inventory warnings і адреса оригінального результату; порядок об'єднаних stdout/stderr не зберігається.

Перший implement 0630004e-f22b-45ab-8e51-bbd126d94bf7: 99 pass, 1 knownRed. Старий тест `complete collection retains IDs from an existing unselected file` помилково не включав gamma до registry. Новий контракт вимагає вилучати такий ID. Уточнено тільки registry фікстури (група містить gamma, --files його тимчасово не вибирає); всі твердження збережено. Власна регресія окремо перевіряє саме вилучення з registry, persisted ledger, CLI, timeoutCount та idempotence.

GREEN ae7433da-f478-4b13-9886-8c3b23f3bb3c: passed, 100 pass, CLI/child 0, knownRed/unexecuted/unknown порожні, timeoutCount 0, groupState complete, nextAction complete. Усі три прогони: timedOut false, cleanup complete, remainingPids []. Діагностика GREEN порожня. Робочі зміни при GREEN: src/test-runs.ts, нова регресія, уточнення старої фікстури; код дорівнює коміту реалізації, що містить цей доказ.

Реалізація: `runTestRun` у src/test-runs.ts, блок фінальної транзакції. Поточний registry preset визначається так само, як у planTestRun; outsideConfiguredSelection явно перевіряє членство файла. Вилучення лишається під completeCollection і не відбувається для --only, setup/protocol error, timeout чи incomplete cleanup. Оптимізований --files зберігає записи інших файлів, що досі входять у registry. Поле removed сумісне; optional removalReasons явно називає outside-configured-selection або not-collected. timeoutCount та reservation не скидаються, нових лімітів немає.

Самоперевірка читабельності: база вище → власна робоча ревізія коміту цього доказу. Переглянуто змінену runTestRun і TestRunResult: registry lookup, predicate, відбір ledger та формування пояснень мають явний послідовний потік; нова перевірка не змінює стан у predicate, не додає вкладених ефектів. Весь змінений шлях runTestRun перевірено разом з існуючими reservation/recovery/timeout/integration тестами (100 GREEN). git diff --check — 0. Сусідній борг поза зміною не розширювався.

Реєстр передано main одним повідомленням: project raf; profiles.node.unitFiles += test/test-run-stale-group-aggregate.test.ts; groups[fix-raf-stale-group-aggregate/unit] = {profileId: node, files: [test/test-run-stale-group-aggregate.test.ts, test/test-run-selection-aggregate.test.ts, test/test-runs.test.ts, test/test-run-stale-unknown.test.ts]}. Внесено in-place; комітить main (реєстрацію вже прийняв auto commit 9384fb1c69).

Залишок поза 1.1: main активує hotfix і підтверджує живу distributions-групу (1.2), далі валідація/archive (9.1). Архівувати зараз не можна: ці пункти відкриті. Галочки 1.1 ставить raf.
