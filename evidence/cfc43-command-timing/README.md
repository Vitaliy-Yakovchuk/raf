# command-timing · implement 4.3

Реалізація: `a4dd05b6ace555c12d2559c0408bd6881fd58c7d`. Спільна перевірка alpha та бюджету працює до відкриття runtime store; невалідна тривалість не замінюється нулем, а виняток recordDuration:false обмежений resource wait. Використано наявні атомарний SQL UPSERT, EMA, stats та фіналізатор. Код підготовлених тестів не читався до завершення початкової реалізації; тести не змінено.

[Повний незмінений output TestRunResult](test-run.output.json), [відповідь інструмента](test-run.tool-result.json), [код CLI](cli-exit-code.txt), [окрема доступність stderr та підтвердження main](stderr-availability.json), [команда, SHA, незакомічені чужі шляхи й підсумок](summary.json).

Run `29ae9ce0-ce25-4537-b908-f0f2d95c0459`: **48/48 passed**, CLI/child **0/0**, cleanup complete, timedOut=false, knownRed/unexecuted/unknown порожні, timeoutCount=0, groupState/nextAction=complete. Група та QA HOME збережені; reset/перейменування/повтор не виконувалися. Повний JSON доступний; окремий stderr недоступний і не видається за порожній. Main підтвердив завершення без повторного прогону через відсутність цього capture у чинному каналі (Q97).

Build, check:comments і diff --check: exit 0. Чужі правки спільного workspace не комічено. Незмінені наявні шляхи EMA/помилок/stats перевірено цільовою групою. Атомарність справжньої SQLite, конкурентність і швидкість залишаються інтеграційними сценаріями **4.4**, які тут не виконано. Архівація не потрібна: інші задачі зміни відкриті. Галочку 4.3 ставить raf.
