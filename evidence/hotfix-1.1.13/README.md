# 1.1.13 — command-settle без скану груп на handshake

Доручення актуальне: після активації 1.1.12 (`369bde74ea50baa771ab1b07555e7ec0326590b0`) живий `agent run` grok, перший після restart, має raf-overhead 3468 мс при бюджеті < 3 с. Найбільший етап — command-settle 1060 мс (command-settle-start 4417 → command-settle-end 5477). Джерело: `openspec/changes/fix-raf-cli-live-latency/evidence/live-after-1.1.12/`.

Цей доказ закриває фікстуру етапу. Живий бюджет < 3 с і повторний замір після активації залишаються за main.

## Що перекривало command-settle

CLI вже в `runGitFreeCommand`, тож його `settleCommandState` не викликає `pruneArchivedTestGroups`. Worker handshake після `channel.handshake` викликав той самий settle з `orchestratorRoot` і дозволеним git. Скан посилань на групи читає всі файли активних `openspec/changes` (на живому дереві це гігабайти, переважно `.gz`) і збігається з command-settle CLI. Ізольований git-free settle копії живої SQLite лишається десятками мілісекунд; фікстура 1.1.12 не відтворювала скан, бо її тимчасовий корінь не є цим деревом.

Перенесення маркера flush нічого не змінює: власник чекає завершення процесу, а бюджет фікстури міряє wall до виходу. Нового таймауту немає. Сканер і перевірка «група, на яку є посилання, не видаляється» не послаблювались: `test/prune-archived-test-groups.test.ts` лишається зеленим, включно з вкладеними й перекривними ключами.

## Поведінка

`settleCommandState` більше не сканує і не видаляє групи. Доставка нагадувань, нотатки, архівні події, закриття жуків і health summary на цьому шляху без змін.

`pruneArchivedGroupsAfterWorkerSession` викликається з `finally` production worker після завершення сесії, до закриття store. Git-free команда з неї виходить одразу. Помилка скану лишається попередженням і не змінює результат команди. Групи архівованої зміни без посилань і далі видаляються, але не під час відповіді CLI.

## Фікстура

`test/command-settle-live-overlap.test.ts` піднімає тимчасовий git-репозиторій, а не `/srv/dev/work/orchestrator`. У ньому є успішно архівована зміна з зареєстрованою групою і, для бюджету, активна зміна з 48 МіБ тексту, що перекриває ключ групи. Вимірюється саме `settleCommandState` у формі worker handshake (git дозволений, `orchestratorRoot` заданий). Бюджет етапу — 400 мс. Другий тест перевіряє, що settle групу не знімає, а завершення сесії воркера знімає незареєстроване посиланням.

## Прогони

Команда без обгортки: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --group fix-raf-cli-live-latency/live-latency --files test/command-settle-live-overlap.test.ts`. QA HOME не змінювався. Повні JSON — копії файлів, які raf назвав першим рядком stderr `RAF test run result:`. Код CLI окремий від `exitCode` дитини; тут вони збігаються.

- RED `--phase red`, run `c534a8b4-8652-4c3e-a92c-709f8beb7bb5`, CLI 1, child exitCode 1, outcome `assertions-failed`. Два assertions: overlap 1195.4733429999999 мс при бюджеті 400 мс; settle зняв групу `cd/e`. knownRed — ці два тести, unexecuted=[], unknown=[], groupState=idle, nextAction=implement, timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[]. [red.TestRunResult.json](red.TestRunResult.json).
- GREEN `--phase hotfix`, run `b5c2d9a6-11c0-48cb-92ec-787ab8f785c5`, CLI 0, child exitCode 0, outcome `passed`, 2 passed. knownRed=[], unexecuted=[], unknown=[], groupState=complete, nextAction=complete, timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[]. [green.TestRunResult.json](green.TestRunResult.json).

Між RED і GREEN другий тест отримав перевірку видалення на завершенні сесії і нову назву. Агрегат позначив стару назву `removed` / `not-collected`. Це не приховане падіння: заміна зібрана і passed. Повний stderr інструмент обрізав у середині виводу; повний `TestRunResult` збережено. Попередження etchly inventory і `Dash refused the write: invalid-input` були й на RED, і на GREEN; вони не є результатом цього відбору.

Локально до офіційного GREEN ті самі два тести і `test/prune-archived-test-groups.test.ts` (перекривні ключі й видалення архівованої групи) пройшли. Це не заміна прогону raf.

## Читабельність

Область: `settleCommandState` і нова `pruneArchivedGroupsAfterWorkerSession` у `src/reminder-cli.ts`, виклик у `finally` `runProductionWorker` (`src/production-runtime.ts`), фікстура `test/command-settle-live-overlap.test.ts`. База коду `369bde74ea50baa771ab1b07555e7ec0326590b0`; перевірка — власні незакомічені правки цього пункту до коміту.

`pruneArchivedGroupsAfterWorkerSession` називає дію і момент: після сесії воркера. Вхід — корінь, ефект — наявний `pruneArchivedTestGroups`, гілка без git виходить одразу, помилка не підміняє результат сесії. Скан прибрано з settle явним видаленням виклику, а не прапорцем. Довгий `settleCommandState` і однорядковий `finally` воркера не переписувались: зміна там — один іменований виклик на вже існуючому шляху завершення. Фікстура збирає тимчасовий репозиторій окремою функцією і вимірює лише handshake-settle. Нових лімітів, таймаутів і видимих користувачу елементів немає.

## Реєстр і діагностичний коміт

Файл додано в `conf/test-runs.json` до `projects/raf/profiles/node/unitFiles` і `groups/fix-raf-cli-live-latency/live-latency`. Raf записав це комітом `1ffd7f972978cc30325f173960fa352b2e146075` з темою `conf: agent test group registrations (auto)` (автор батьківського коміту). Це не коміт виконавця через hotfix-commit.

Під час діагностики до виправлення окремий прогін `pruneArchivedTestGroups` проти живого кореня створив `304db4c9842148e48e17aeedfaf0066454f13df3` з тією самою темою і зняв незареєстровані групи вже архівованих змін. Коміт не відкочувався. Групи `fix-raf-cli-live-latency` у ньому не зникали. Це не результат 1.1.13.

Пункт 1.1 лишається відкритим. Архівація не виконується. Живий повтор — main.
