# Hotfix add-raf-test-run 6.3.7 / 6.3.8

Повні незмінені TestRunResult — у *.result.json; команди, CLI status окремо від child exitCode та source snapshot — у *.cli.json. summary.json пов’язує всі спроби, відбір, runId, QA HOME, cleanup, knownRed/залишок і стан групи. stderr-файли порожні: exec_command надав один JSON без додаткового тексту, але не окремі дескриптори потоків; обмеження явно зафіксовано.

Початковий assertion-red: 2c099a8b-addc-4e95-bd03-999254c06a82 (7 failed, 3 passed), до production edits. Після виправлення: 1b374a3b-7dea-46e5-9f63-bb8b638e3211 (10 passed). За прямим рішенням main обидва прогони використовують phase=hotfix для допуску ресурсів; попередні setup/refused не є red. QA HOME та група незмінні. initial-workspace.patch додає preload-тест до коміту 90e5e72; implementation.patch — виправлення після red.

Etchly: перший прогін ed62ec2d-ada3-49cd-99e8-b3f0adefdf87 виявив 2 застарілі assertions timeoutCount=0 до snapshot. Main переніс без змін готовий fix 6.3.6.1 aff3423 → 300db24205dd9bbeebd9c2c485f5561092da1d0e. Повтор тієї самої групи 792ecd58-6175-4c63-a667-9280b533910c: 87 passed; knownRed/unexecuted/unknown порожні. Власної правки Etchly-тестів немає.

Vitest-профіль обирається з request project/group (fallback охоплює всі projects); checks від workspace для всіх проєктів; nested/root cwd і preload збережені. agent run відхиляє фази, що не є фазами запуску агента, на arguments stage до handler/runId/tmux; spec/context-review та hotfix/implement підтримані.

Міграцію checks conf main застосовує одночасно з активацією коду, за окремою прямою вказівкою: точні значення в summary.json#confMigrationAtActivation. argv shared-libs --configLoader runner вже додано main (54441a8116). Реальні чужі Vitest-групи не запускалися. Інші пункти відкриті: галочки ставить raf, sync/archive не виконується.
