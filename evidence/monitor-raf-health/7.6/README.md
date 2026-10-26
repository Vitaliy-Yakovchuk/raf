# monitor-raf-health:7.6

Аудит: доручення актуальне. `proposal.md` Why/What Changes/Non-goals, tasks 7.6 та delta health-monitoring «Власний CPU за профілем raf» / «Підсумок стану для main» вимагають вимір за фактичний період і чесну неповноту. До виправлення readHealthSources приймав лише cpu.lastAssessment з точними межами підсумку, тоді як observeRafHealthCpu просував baseline кожні cpuWindowMs. Підсумок не мав власного знімка на межі.

Виправлення: окремий baseline і coverage підсумку в наявному JSON raf_health_cpu.payload. Коротке CPU-вікно не скидає coverage підсумку. На завершенні підсумку той самий SQLite commit зберігає його факт, межу та наступний знімок; використано наявний evaluator приростів профілю. Таблиць/стовпців, профайлерів, таймерів чи конфігураційних вимог не додано. Без збереженого початкового знімка після оновлення поточний період чесно unavailable; наступний період має власний baseline. Неповні/скинуті дані лишаються неповними за наявним evaluator.

Регресія використовує SQLite у тимчасовій теці, керовані Date/hrtime і справжній облік профілю без очікувань у реальному часі. CPU-тест перевіряє незалежність короткого вікна та підсумку, включно з інтервалом worker, що перетинає коротку межу, але повністю лежить у періоді підсумку. Summary-тести перевіряють два суміжні періоди, delayed, повторне відкриття SQLite та збереження неповноти до завершення періоду з відновленням наступного.

`runs.json` містить точні команди, SHA/стан workspace, runId, відбір, CLI/child exit, outcome, cleanup/timeout, knownRed/unexecuted/unknown та стан груп/наступну дію. Незмінені повні TestRunResult — `*-red.json` та `*-hotfix.json`; stderr і код CLI — окремими файлами; `*.transport.json` зберігають повну відповідь інструмента. `callerPhase=hotfix` відповідає агенту; `phase=red` у первинних результатах відповідає запитаній фазі.

Red CPU: 66 passed, 1 knownRed, CLI/child 1; red summary: 57 passed, 3 knownRed, CLI/child 1. Setup/import помилок немає. Hotfix CPU: 67 passed; summary: 60 passed. Обидва CLI/child 0, groupState/nextAction complete, knownRed/unexecuted/unknown порожні. У всіх прогонах timedOut=false, timeoutCount=0, cleanup.complete=true. Один незмінний QA HOME для всіх прогонів; групи не перейменовувались, агрегат не скидався.

npm run build, npm run check:comments і git diff --check завершились 0; transport-докази поруч. OpenSpec validate monitor-raf-health --strict --no-interactive завершився 0 перед архівацією. Галочку 7.6 ставить raf після прийняття JSON-звіту. Push/активація не виконувались.
