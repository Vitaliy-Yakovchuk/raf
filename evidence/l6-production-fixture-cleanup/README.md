# L.6: передача test-scaffold

Доручення: complete-raf-flow-contracts:L.6, лише стадія test-scaffold. Джерела: tasks.md L.6, proposal.md Why/What Changes, чинні delta feature-test-authoring/unit-test-runs/test-runs зміни add-raf-test-run. Аудит 2026-10-26: пункт відкритий і актуальний. У test/production-fixture.ts реєстрація t.after відбувається після mkdir/which/version/openStateStore; винятки читання PID або перевірки процесу/close можуть обійти rm(base). Суперечності з чинним контрактом не виявлено.

## Відбір до прогону

Стабільна unit-група для red → implement → qa: `complete-raf-flow-contracts/l6-production-fixture-cleanup`.

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/31c49695-8224-4d89-bb1f-ac811a920aba/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/l6-production-fixture-cleanup --files test/production-fixture-cleanup.test.ts
```

У наступних стадіях змінюється лише phase відповідно до стадії; group/files/облік не скидати. Deadline і timeout-політика — conf/flow.json#/unitTests, без власних таймаутів.

Профіль `/projects/raf/profiles/node`: cwd `.`, executable `node`, argv `["./scripts/test-run-node.ts"]`, exactIds `node-test-name`, resultAdapter `node-test-events`; environment isolatedHome/stateOrigin = true. Передумови: Node >=25.4.0, локальний TypeScript, src/test-run-reporter.ts і scripts/test-run-node.ts, зареєстрований develop workspace та ізольований QA HOME/state/tmp wrapper. Потрібне Node registerHooks; unit не запускає реальні tmux/OpenSpec/git/SQLite/моделі, не копіює код і не створює /tmp/raf-prod-*.

Точні записи unitFiles/groups збережено в conf-test-runs.additions.json; внесено in-place до conf/test-runs.json за повідомленням main про Z.451. Main має перевірити ці записи перед наступною стадією.

## Контракт тестів

Перевіряється наявна публічна функція fixture(t, options), її зареєстровані after callbacks та зовнішні ефекти. Production-фікстура і production-код не змінюються. Новий публічний API/методи не потрібні, тому штучного NotImplemented API немає. Повні наявні сигнатури зберігаються; test doubles містять лише модель середовища, без реалізації lifecycle виправлення.

- Ранній setup failure після створення base: mkdir (externalHome), пошук tmux, пошук OpenSpec, відкриття state — корінь має видалятися.
- Пізній setup failure: initializeRunners або підготовка productionQa — відкритий store закривається, корінь видаляється.
- Падіння тіла тесту: обидва власні tmux socket очищаються, store закривається, base видаляється у звичайному й productionQa/externalHome розташуванні.
- Неочікувана помилка читання PID, спостереження процесу чи close SQLite не обходить решту незалежного очищення.
- Відсутній PID-файл і підтверджено відсутній процес не заважають очищенню.
- Cleanup однієї fixture не видаляє чужий корінь/socket і ресурси іншої ще активної fixture; після завершення модельованої групи власних серверів/каталогів немає.

Очікування взято з L.6: кожен тест прибирає своє навіть при падінні; unit не стверджує живого процесного приймання. Для implement потрібне фактичне виправлення production-fixture.ts і окреме підтвердження після production-групи, що власні реальні tmux/process/tmp ресурси відсутні. Не знищувати чужі ресурси за glob. Галочку L.6 цей scaffold сам не ставить, tasks.md не редагує; решта зміни має відкриті пункти, archive не застосовується.

## Походження реєстрації

Додані мною записи conf під час очікування red були включені main до коміту Orchestrator `23acf608b56fec9cb83df2fd5ab5c7b7c29f86a5` разом із незалежним Z.403. Це не власний коміт виконавця L.6 і він не входить до commits мого звіту. Main повідомлено через agent message, receipt `973b5694-8e2c-4fa1-9f7c-0185795f1bc9`; попередня доставка відмовила HANDLER_FAILED із retrySafe=true, повтор підтверджено. Робочий conf після цього чистий.
