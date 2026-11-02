# Перевірка 1.2: нововиявлені жуки з кінцевим статусом

Аудит: пункт 1.2 актуальний — noticeCandidates створював new-bug незалежно від detail.status. Предметний контракт: tasks.md 1.2 і пряме доручення власника уточнюють сповіщення projects/raf/bug-sync. Межі: тільки rejected/fixed/verified під час першого incremental виявлення; коментарі людей та сповіщення відкритих жуків перевірені без зміни поведінки.

Обидва прогони на HEAD 4eda03739431c7f2e561b8605690f4eacdd81b6a. RED: новий незакомічений test/bug-sync-terminal-notices.test.ts (точна копія red-test.ts), production без змін (red-workspace.patch порожній). GREEN: той самий тест і production diff hotfix-workspace.patch. Спільний незареєстрований node_modules не змінювався.

RED:
`node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase red --group fix-raf-duplicate-event-delivery/terminal-bugs --files test/bug-sync-terminal-notices.test.ts test/bug-sync-notices.test.ts`

GREEN:
`node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-duplicate-event-delivery/terminal-bugs --files test/bug-sync-terminal-notices.test.ts test/bug-sync-notices.test.ts`

Повні незмінені JSON з довіреного порту: red-TestRunResult.json, hotfix-TestRunResult.json. Stderr з повернення інструмента збережено окремо без обрізання; CLI exit codes у *-cli-exit-code.txt відокремлені від child exitCode у JSON.

RED runId 54f27167-5340-4928-9372-2ffbcda78c21: assertions-failed, CLI 1 / child 1, 3 knownRed (rejected/fixed/verified), 11 passed; unexecuted/unknown порожні, groupState idle, nextAction implement.
GREEN runId 711edc26-e8a1-42fc-a105-24599000e064: passed, CLI 0 / child 0, 14 passed; knownRed/unexecuted/unknown порожні; groupState complete, nextAction complete. Обидва: timedOut false, cleanup.complete true, remainingPids [], timeoutCount 0; незмінний ізольований QA HOME наведений у JSON.

Попередження inventory про явно переданий новий файл допустиме за projects/raf/test-runs; результат містить його фактично виконані тестові ID. Побічне попередження Dash invalid-input повернуто портом у stderr, setup failure відсутній. Часткова ресурсна телеметрія чесно збережена в JSON.
