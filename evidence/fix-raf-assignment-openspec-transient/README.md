# fix-raf-assignment-openspec-transient:1.1

`validateAssignment` повторно читає лише той список OpenSpec, який не вдалося прочитати. Відновлення охоплює помилку команди, transport exception, невалідний JSON і непридатну структуру активного або архівного списку. Після повторного збою чинний результат `openspec-unavailable` зберігається; невалідне доручення відхиляється як раніше. Нових конфігураційних числових параметрів, таймаутів чи обмежень немає.

Повні незмінені TestRunResult: `red-result.json`, `hotfix-result.json`, `queue-initial-result.json`, `queue-final-result.json`. Для кожного запуску `*-invocation.json` містить точну дозволену CLI-команду та CLI exit code окремо від child exitCode; `*-stderr.txt` зберігає решту merged-виводу інструмента. `*-workspace.json` називає HEAD, незакомічені шляхи спільного дерева й SHA-256 коду/тестів; snapshots/patches показують власні зміни.

- Основна група `fix-raf-assignment-openspec-transient/unit`: red — 10 цільових assertion failures і 101 passed; hotfix — 111 passed. Регресійний тест до виправлення збережено в `red-test.ts.txt`.
- Наявна група `fix-raf-queue-openspec-transient/unit`: перший прогін — 2 assertions через жорстко задані два wait, хоча обидва запуски успішно стартували після повторного читання. Це помилка очікування тесту: такт черги більше не потрібен при відновленні всередині перевірки. Виправлено саме очікування; додано два сценарії, де збій триває до наступного wait, щоб залишити перевірку чинного механізму черги. Імена попередніх knownRed збережені. Фінальний прогін — 5 passed.
- У фінальних результатах обох груп knownRed/unexecuted/unknown порожні, groupState/nextAction — complete, timeoutCount — 0. У всіх прогонах timedOut=false, cleanup.complete=true і remainingPids=[].

Обидві групи використовували той самий перевірений ізольований QA HOME/state з JSON команд; HOME не перемикався для скидання агрегату. Попередній довгий прогін черги чекав ресурсів, що явно відображено у stderr й admission; це не timeout.

Підсумок із runId, статусами й усіма посиланнями — `summary.json`. Валідація OpenSpec `--strict` успішна; `.openspec.yaml` має `skip_specs: true`, delta відсутня. Галочку пункту виконавець не змінює: її ставить raf після прийняття succeeded.
