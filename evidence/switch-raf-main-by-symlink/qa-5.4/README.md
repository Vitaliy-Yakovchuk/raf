# QA switch-raf-main-by-symlink:5.4

Пункт 5.4 перевірено на ізольованому процесному стенді. Фінальний запуск: `node scripts/qa-main-generation-handover.ts evidence/switch-raf-main-by-symlink/qa-5.4/live-final`, CLI exit 0, runId `0cc01624-83c4-419d-bf4e-0206932de300`, outcome `passed`, cleanup complete, remainingPids []. Повний доказ: [live-final/summary.json](live-final/summary.json), точний результат CLI: [live-final/tool.json](live-final/tool.json).

База всіх запусків — raf-develop `cbe8a257da0a5743667fb995872cc9e75cc991c6`. Запуски виконані з незакоміченими власними змінами: [workspace.patch](workspace.patch), статус і точні команди/відбори — [runs.json](runs.json). Red містить лише додані регресійні тести до виправлення handover: [rollback-red.workspace.patch](rollback-red.workspace.patch). Початкова база була чиста. Fixture та assertion виправлені після відповідних невдалих запусків; послідовність нижче. Власні нові файли — цей каталог доказів і `scripts/qa-main-generation-handover.ts`; їхні фінальні байти зберігає коміт. Live summary містить SHA, workspaceStatus, SHA-256 engine/script, версії Node/SQLite/OS та час завершення.

Стенд запускає окремі живі service/worker/notice процеси й окремий runner, атомарно перемикає фізичний `raf-main` symlink A/B, виконує API `src/main-generation-handover.ts` в окремих CLI-процесах і зберігає стан у справжній SQLite. Покоління A/B мають різні виконувані generation-модулі, каталоги/модулі та протоколи 1/2; обидва використовують перевірений поточний handover engine. Це дві контрольовані версії стенду, а не два історичні повні релізи raf. Filesystem watcher реально читає report, атомарно записаний runner. Доставка — транзакційний SQLite adapter з fencing/idempotency key; після аварії повторюється спроба, а не зовнішній ефект.

Підтверджені сценарії:

- A→B: worker B неготовий → exit 1 з причиною readiness; відкладений import читає A, pin черги й import утримують перехід. Report `during` з'являється на межі handover. Перезапис зайнятого A відхилено з `SLOT_IN_USE`. Після drain і SIGKILL старого спостерігача recovery завершується з exit 0.
- SIGKILL нового спостерігача після durable delivery до acknowledgement: дві спроби, одна доставка, новий owner epoch, recovery exit 0. Старий owner не може підтвердити факт після втрати ownership.
- B→A rollback: report/event/message/reminder протоколів обох версій прийняті; report після rollback також оброблений. Позитивні команди exit 0.
- Несумісний report-протокол B → exit 1 з `MAIN_PROTOCOL_INCOMPATIBLE`, старий A продовжує спостереження; handoverConfirmable=false. Неготовий handover також не підтверджений, старий слот утриманий.
- Rollback незавершеного A→B зберігає первісних A owners, виводить B, приймає pending report і завершується з exit 0. Саме цей сценарій виявив дефект реалізації.
- У фіналі 8 facts зі status=accepted і рівно 8 deliveries, є фактична доставка обома версіями. Runner PID/startTicks/bootId, address/runId/session/runnerSessionId/tmp/report незмінні; runner весь час живий, його tmp існує. Черга resourceWait, lastGrant і bugSync cursor збережені. У кожної ролі один активний owner. Повні PID identities, сигнали, stdout/stderr, коди команд, readiness, snapshots і recovery записані в summary.

Стенд не запускає native model, tmux чи повний production service/worker; main підтвердив у цій сесії, що це не передумова 5.4. Production wiring та наскрізний rollout залишаються існуючим 7.1/7.2. Початковий процесний запуск до посилення перевірок причин відмов також passed: [live-local-1/summary.json](live-local-1/summary.json), runId `46d33d61-a1ae-42ca-9117-4350e441d051`; fingerprint скрипту відрізняється навмисно. Для нового запуску потрібен новий output directory: скрипт відмовляє при вже наявному summary. Guard стенду 180 секунд не є unit timeout policy. Cleanup стосується власних процесів; temp SQLite/filesystem fixture збережений для аналізу, production HOME не відкривався.

## Unit evidence

Кожний `<name>.json` — повний незмінений JSON TestRunResult; `<name>.stderr` — окремий stderr CLI, `<name>.tool.json` — повний результат exec із кодом CLI. Child exitCode залишається окремим полем TestRunResult. [runs.json](runs.json) містить точну команду, SHA/dirty patch, runId, selection, outcome, cleanup/timeout, knownRed/unexecuted/unknown, groupState/nextAction. Stderr launch-queue.waiting збережено, коли він був. Результат z393-subset відновлений без змін із власного tool-output журналу сесії; повторного запуску для відновлення доказу не було.

| Доказ | runId | CLI / child | Пройшло | Стан |
| --- | --- | --- | --- | --- |
| [baseline-qa](baseline-qa.json) | 5bd8a5cd-5337-4b76-afbe-1c30c710a30b | 0 / 0 | 33 | passed, complete |
| [rollback-red](rollback-red.json) | ecc7da90-aa87-406b-a99f-3c15f68f347e | 1 / 1 | 33 | 2 behavioral red, HANDOVER_IN_PROGRESS |
| [rollback-qa](rollback-qa.json) | c2670037-bad4-422f-b390-6f17561b0df6 | 0 / 0 | 35 | passed, complete, немає knownRed/залишку |
| [reminders-qa](reminders-qa.json) | a23ebb11-aeb5-4dc4-97c4-ce466c45709b | 1 / 1 | 0 | 14 fixture ENOENT + 5 interrupt knownRed |
| [reminders-fixture-qa](reminders-fixture-qa.json) | 2d99438d-2294-4b98-809f-73a8c6898d01 | 1 / 0 | 14 | вибрані тести passed; агрегат зберіг 5 interrupt knownRed |
| [z393-refused](z393-refused.json) | 7824a7a0-6121-4a90-bb24-e26376dd4064 | 1 / null | 0 | GROUP_RENAME_REFUSED, child не запускався |
| [z393-subset-qa](z393-subset-qa.json) | 8cb1a3fc-3c62-457d-a647-a4928ba25dc5 | 1 / 1 | 105 | 1 assertion red + успадкований залишок |
| [z393-fixed-qa](z393-fixed-qa.json) | 55688de2-8d5b-4d43-8af9-381456979f85 | 1 / 0 | 106 | вибрані тести passed; 11 успадкованих knownRed + 1 unexecuted |

Обидва нові behavioral red для rollback запущені з phase qa за прямою вказівкою main в цій сесії, потім виправлення перевірене тією ж групою/QA HOME. Виправлення дозволяє повернення до вже опублікованого вихідного покоління, поки forward handover чекає readiness або завершення старих readers. Первісні активні owners зберігаються, якщо ownership ще не передано; після передачі виділяються нові epochs початкового покоління, stale owners лишаються fenced.

Fixture ENOENT був setup-дефектом, не behavioral red. Вузький фікс створює codeRoot перед retain/rename у prepareProductionQaFixture. У report-confirmation-runtime дефект тесту полягав у перевірці кількості JS аргументів: optional snapshot=undefined помилково вважався rejection snapshot. Тест тепер перевіряє pending reason та відсутність snapshot значення; acceptance/retry assertions збережені.

Чужі регресії дозволені кінцевою декларацією source item `switch-raf-main-by-symlink:5.4`: target groups `add-raf-reminders/unit` та `complete-raf-flow-contracts/z393`. Стабільні групи і спільний QA HOME збережені, timeoutCount=0 в усіх результатах; немає unknown, cleanup complete. Refused preset z393 містив два файли групи z3939; після повідомлення main вибрано лише report/confirmation файли чинного z393. z3939 не запускалася.

Останні результати чужих груп НЕ є повним group pass: CLI 1 / assertions-failed / group idle / nextAction fix-implementation. П'ять interrupt knownRed — підтверджений main баг робочої raf, винесений ним у наявний add-raf-reminders:8.1 (Orchestrator `7088e004c7`); 5.4 його не змінює. Одинадцять reported-commits knownRed та один identity-qa unexecuted успадковані ще до цього QA, не входили до адресного відбору й не оголошуються перевіреними. Початковий один progress knownRed після адресного виконання пройшов і був прибраний агрегатором. Жодних скидань агрегату, перейменування груп чи зміни HOME не виконано. Детальні точні IDs є в JSON.

`node --check scripts/qa-main-generation-handover.ts`, `node scripts/check-comments.ts`, `npm run build` → 0: [build.tool.json](build.tool.json). Зміна має відкриті 7.1/7.2/7.3, тому sync/archive не виконуються; tasks.md і галочки не змінені. Нових follow-up задач не потрібно: production wiring і відомий main interrupt hotfix уже мають власні пункти.
