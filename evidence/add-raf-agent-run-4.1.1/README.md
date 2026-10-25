# add-raf-agent-run:4.1.1 — регресії бюджету звіту

Призначення: лише test-scaffold для дефекту з `evidence/add-raf-agent-run-4.1/report-budget-audit.md`. Задача актуальна: обидва публічні входи досі містять описану передачу `.timeouts` замість повного протоколу. Контракт — пункт 4.1.1 активного tasks.md та вимога «Агент тестів і каркаса» в `openspec/changes/add-raf-test-run/specs/core/process/feature-test-authoring/spec.md`. Реалізацію production-коду не змінено. Нова публічна поверхня не потрібна, тому NotImplemented-каркас не додається.

## Відбір і профіль

Стабільна група для red та наступного етапу: `add-raf-agent-run/report-budget`.

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase red --group add-raf-agent-run/report-budget --files test/production-report-budget.test.ts
```

Точні записи профілю передано main в `conf-test-runs.patch.json`; вони застосовуються лише якщо ще відсутні, без дублювання unitFiles. Автор не має меж запису до `conf/test-runs.json`. Профіль `projects.raf.profiles.node`: cwd `.`, executable `node`, argv `["./scripts/test-run-node.ts"]`, exactIds `node-test-name`, resultAdapter `node-test-events`; `environment.isolatedHome=true`, `environment.stateOrigin=true`. Передумови checks: `node_modules/typescript/package.json`, `src/test-run-reporter.ts`, `scripts/test-run-node.ts`. Потрібен Node з `registerHooks` і виконанням TypeScript; доступний v26.12.1. Відбір повинен виконуватися через довірений канал з ізольованим QA HOME і timeoutPolicy із conf/flow.json#/unitTests; жодного нового профілю, install, живого runner або tmux тестам не потрібно.

## Інваріанти й межі fixture

- Обидва публічні входи `reconcileProductionReports` і `runProductionWorker` повинні передавати до справжнього `readPendingAgentReport` бюджет з повного протоколу вибраного runner; перевіряються і `transitionMs`, і `pollMs`.
- Конфіг fixture походить з `conf/raf.json#/runnerProtocols`; бюджети різних runner робляться відмінними, щоб виявляти сталий fallback або вибір першого протоколу. Очікування порівнює фактичний бюджет із конфігурацією, а не з текстом реалізації.
- Reconcile без файла звіту має завершити справжню перевірку бюджету, повернути порожній retained і залишити сесію без результату. Невалідний бюджет не можна приховувати як відсутній звіт.
- Worker отримує запит і приватний runtime envelope з пам'яті, проходить перевірку reserved-сесії та під час health-повідомлення справжнім `AgentControlService` звіряє іншу running-сесію. Це викликає справжні sessionTools і readPendingAgentReport. Після успішної перевірки відсутнього звіту спостерігач зупиняє подальшу доставку контрольним винятком; окремий cutoff завершує worker перед native launch. Закриття store і release generation lease перевіряються.
- Підміни обмежені зовнішнім I/O, preflight, health-джерелом і контрольованим завершенням. Production runtime, sessionTools, AgentControlService, parser звіту та валідатор confirmation budget виконуються без виправлень чи підміни логіки. Немає subprocess, SQLite, реального HOME, tmux або providers; це unit-перевірка wiring бюджету, а не live acceptance звіту/доставки.

## Базова версія

На початку HEAD = `0bc8d366fd33fc0452c3fc9867437191b40c733c`. `src/production-runtime.ts` байтово тотожний цьому файлу з `1973e882438755c4f322e5ac1690ba30b3e0228f`: SHA256 `80d22978e24385ead0c9f38bbd9a7695b52d1d35fd1cae554e39d4e68a3d40b0`. Регресії додані комітом `fff2ad913831394cc2b8ae484fdb44147c5da111`; спільне дерево не перемикалося на старий HEAD.

`node --check test/production-report-budget.test.ts`, `git diff --check` та адресна перевірка відсутності коментарів у новому файлі — exit 0. Інші пункти зміни залишаються відкритими; sync/archive тут не застосовуються, галочку 4.1.1 ставить raf після прийняття succeeded.

## Фактичні прогони

Main зареєстрував файл і групу в Orchestrator `7327fe0370`. Перший авторський прогін `33a50542-db12-4eb0-8593-c61a131e3f5e` — exit 1, але **не є red цільової поведінки**: `flowEvidencePorts` під час підготовки намагався читати `test-runs.json` із віртуального unit-кореня. Runner назвав помилки assertions, проте це недолік fixture. Повний результат і оцінка збережені в `attempt-1-fixture-failure.json`. Коміт `410ff30190e4d429378aff8e5d9673659602d55d` ізолював eager factory flow-evidence, який не бере участі в обробці відсутнього звіту; production-код і очікування не змінені.

Підтверджений авторський red — `db40563f-5e86-4d4a-befc-ac1d8e88fc4d`, та сама група й `--phase red`, HEAD `410ff30190e4d429378aff8e5d9673659602d55d`. Повний TestRunResult — `red-test-run-result.json`, команда/CLI exit — `red-command.json`. Факти: exit 1, outcome `assertions-failed`, 4 knownRed, 0 passed, unexecuted/unknown порожні, timedOut=false, cleanup.complete=true, durationMs=4907. Усі чотири діагностики прямо містять `Invalid report confirmation budget`; worker-стек проходить справжні readRetryReport → readPendingAgentReport → acceptPendingReport → AgentControlService.message → runProductionWorker. Це падіння цільової поведінки після усунення власної помилки підготовки, а не import/setup або таймаут.

Main повинен перевірити зміст діагностик перед передачею. Наступному виконавцю — та сама група `add-raf-agent-run/report-budget`, без зміни файлів чи профілю. Агент 4.1 виправляє production-код і відкриває підготовлені тести лише після завершення реалізації за дорученням.
