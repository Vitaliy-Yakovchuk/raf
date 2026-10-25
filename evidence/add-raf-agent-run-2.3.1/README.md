# add-raf-agent-run:2.3.1 — виправлення фікстур

Оновлено лише тести й test-support; реалізації фічі та нового каркаса немає.

- `task-context` та admission отримують валідний `sqliteOnlyMeanBudgetMs` у RuntimeConfiguration.
- `reportSchema` перевіряє зміну reportStatuses через явно переданий перебудований каталог. Усі перевірки enum збережено.
- App-runtime timing failure використовує зареєстрований `PROCESS_SCAN_UNKNOWN` замість вигаданого `SCAN_UNAVAILABLE`. Перевірки коду, структурованої помилки, remediation і приховування секрету збережено.
- Z12 успадковує project ID чинного conf перед локальними overrides. Каталог може перевірити всі чинні CLI-приклади, включно з etchly; assertions Z12 не змінено.
- Git mock task-context більше не повертає назву гілки на `--show-toplevel`: він читає створені самим тестом ізольовані Git-репозиторії через наявний fixture helper. Це дозволяє перевірити нову передумову Git root без обходу перевірок workspace.

Фінальний `raf test run --project raf --phase red --group add-raf-agent-run/contracts`: **608 passed**, CLI/child exit 0, без knownRed/unexecuted/unknown і таймауту; cleanup complete, groupState/nextAction complete. Повний незмінений TestRunResult — `contracts-result.json`; команда, тестований HEAD, власні незакомічені шляхи, передумови профілю та результати діагностики — `verification.json`.

Нових unit-файлів немає. Точні доповнення `conf/test-runs.json` до `projects.raf.profiles.node.unitFiles` і `projects.raf.groups` — порожні списки. Стабільна група наступній стадії: `add-raf-agent-run/contracts`, чинний preset із 15 файлів. Main і raf-ara31-impl отримали результат через підтверджені agent message; реалізатор повторює свій implement після цього red.

Проміжний діагностичний прогін збережено повністю у `diagnostic-result.json`. Найперший прогін був обрізаний інструментом, не заявляється повним доказом і не підміняє фінальний зелений результат. Результати групи є unit-доказом; інші пункти зміни лишаються відкритими, тому sync/archive не виконувався. Галочки tasks.md ставить raf.
