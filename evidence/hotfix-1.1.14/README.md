# 1.1.14 — command-settle без спостереження жуків і теплий trust hash Codex

Доручення актуальне після 1.1.13. Живі теплі `agent run` у `openspec/changes/fix-raf-cli-live-latency/evidence/live-after-1.1.13/`: command-settle 1018–1476 мс, raf-overhead 3.3–7.2 с, command-access (лише codex) 423 / 1359 / 3344 мс. `command-settle-end` збігається з `handler-end`. До `cli-response-ready` лишається 77–236 мс. Секунда сидить усередині `settle()`, не в зливі відповіді після handler.

Цей доказ закриває фікстуру етапу. Живий замір після активації залишається за main. Фікстура не доводить живий бюджет agent run < 3 с.

## Що тримає command-settle

`settleCommandState` на кожній відповіді CLI і на worker-health, коли `homeDirectory` заданий і не дорівнює `RAF_QA_HOME`, викликав `closeArchivedBugsForHome`. Той читає успішний `tasks.md` кожної ще не записаної архівованої зміни і, якщо в тексті є ключі жуків, чекає HTTP `setStatus`.

Відкинуто як джерело стабільної секунди:

- Повторний злив після handler. Для `agent run` другого settle немає.
- Повний settle копії живої SQLite без цього виклику: близько 78–131 мс, навіть на живому дереві openspec. Два процеси на одній копії: 70 і 75 мс.
- Доставка нагадувань і `deliveryReady`: у копії 108 активних нагадувань уже мають ключ доставки.
- Скан груп 1.1.13 лишається лише в `pruneArchivedGroupsAfterWorkerSession`.

Прототип поточного коду на тимчасовому корені: один небачений успішний архів на 2_000_000 рядків `- [x] done`, пам’ять `{active:[],archives:[]}`, без ключів жуків (HTTP не викликається). `settleCommandState` тривав 1548 мс. Офіційний RED того самого виклику: 1718 мс при бюджеті 400 мс.

Окреме спостереження копії пам’яті `/home/dev/.raf/archived-bug-close.json` (не запис у живий файл і не виклик Dash): рівно одна успішна небачена зміна `fix-etchly-prod-bug-report-stuck`, файлова робота 47 мс, результат закриття `closed: 2`. На живому HOME це два `setStatus`. Помилка не записує архів у пам’ять, тож наступний settle повторює виклик. `requestTimeoutMs` у `conf/raf.json#/bugs` — 20000, тож зависання було б 20 с, а не 1 с. Під час RED і GREEN процес raf-main (старий код, не цей hotfix) двічі написав `Dash refused the write: invalid-input`. Це не результат фікстури: у фікстурі ключів жуків немає.

## Що тримає стрибки command-access

Етап є лише в codex, між `worker-sandbox-end` і `tmux-spawn-start`. Це `prepareCodexRafCommandAccess`: `codex app-server --listen stdio://` з `--no-daemon`, `hooks/list`, перевірка `timeoutSec` і `async`. Таймер `timeoutMs` лише попереджає і не перериває очікування. Нового таймауту немає.

Два однакові огляди `--no-daemon` на `/home/dev/.local/bin/codex`: 525 і 476 мс, той самий key і той самий hash. Живі 0.4–3.3 с — розкид того самого очікування. Кеш hash не влучав, бо в текст хука входили шлях результатів і `runId`/`agentId` цього запуску.

## Поведінка

`settleCommandState` більше не відкриває closer і не кличе `closeArchivedBugsForHome`. Нагадування, нотатки, архівні події й health summary лишаються. Правило закриття жука не змінювалось: активна зміна з повним ключем усе ще лишає жука відкритим. Змінилось лише коли виконується вже наявний `observeArchivedChangeBugCloses`.

`closeArchivedBugsAfterWorkerSession` викликається з `finally` production worker після `pruneArchivedGroupsAfterWorkerSession` і до health CPU. QA HOME і порожній home виходять одразу. Помилка лишається попередженням. Сервіс `startBugSyncService` як і раніше закриває жуків на своєму циклі. Команда без worker (наприклад `agent ps`) відкладає цю перевірку до кінця наступної сесії воркера — той самий клас переносу, що й скан груп у 1.1.13. Fire-and-forget у процесі CLI не використовується: процес завершується одразу після відповіді.

Для Codex шлях результатів і publication тепер у `RAF_CODEX_RESULTS` і `RAF_CODEX_PUBLICATION`. Текст хука від них не залежить, тож trust hash лишається дійсним між запусками. Пам’ять `{key,currentHash}` лежить у `homeDirectory` як `.raf/codex-hook-trust.json`. Ключ кешу — sha256 шляху executable, mtime, size, cwd, тексту команди й configuration (`--no-daemon` і `-c`). Промах і відсутній home як і раніше викликають `hookIdentity` з `--no-daemon`. Невдалий огляд не кешується. Вигаданого локального hash немає.

## Фікстура

`test/command-settle-bug-close.test.ts` імпортує наявний `settleCommandState`. Тимчасовий корінь, home не дорівнює `RAF_QA_HOME`, пам’ять уже є, один небачений успішний архів без ключів жуків. Бюджет command-settle — 400 мс на списку з 2_000_000 завдань. Другий тест, доданий після RED, перевіряє, що settle пам’ять не дописує, а `closeArchivedBugsAfterWorkerSession` записує ім’я архіву. Dash не викликається.

`test/command-access-trust-cache.test.ts` двічі кличе наявний `prepareCodexRafCommandAccess` з тим самим executable, cwd і home та різними `runId`. Очікування: однакові тексти хуків, різні `RAF_CODEX_RESULTS`, один spawn огляду, той самий `hooks.state`, `--no-daemon` лишається.

Обидва файли в групі `fix-raf-cli-live-latency/live-latency` і в `projects/raf/profiles/node/unitFiles`. `test/command-settle-live-overlap.test.ts` у групі лишився.

## Прогони

Команда без обгортки: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --group fix-raf-cli-live-latency/live-latency --files test/command-settle-bug-close.test.ts test/command-access-trust-cache.test.ts`. QA HOME не змінювався. Повні JSON — копії файлів, які raf назвав першим рядком stderr `RAF test run result:`. Код CLI окремий від `exitCode` дитини; тут вони збігаються. Повний stderr інструмент обрізав у середині JSON; повний `TestRunResult` збережено.

- RED `--phase red`, run `d79a974a-50de-41ad-84c6-9c0534a29f75`, CLI 1, child exitCode 1, outcome `assertions-failed`, durationMs 4051. command-settle 1718.3594329999999 мс при бюджеті 400 мс. Другий тест упав на `assert.equal` текстів хука (рядки різні, тож огляд не може бути одним). knownRed — ці два тести, passed=[], unexecuted=[], unknown=[], groupState=idle, nextAction=implement, timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[]. [red.TestRunResult.json](red.TestRunResult.json). Файл доказу: `/home/dev/.raf/tmp/72f3789b-25d5-4e25-839b-5fe3143bf727/test-run-d249fc22-0c76-45b0-8572-38ea40cc5249.json`.
- GREEN `--phase hotfix`, run `7003590d-7d99-42b9-80f8-5e7e8e7dcf1a`, CLI 0, child exitCode 0, outcome `passed`, durationMs 2293, 3 passed (бюджет, запис пам’яті на кінці сесії, один trust hash). knownRed=[], unexecuted=[], unknown=[], groupState=complete, nextAction=complete, timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[]. [green.TestRunResult.json](green.TestRunResult.json). Файл доказу: `/home/dev/.raf/tmp/72f3789b-25d5-4e25-839b-5fe3143bf727/test-run-2b7617fb-8f84-45f0-8c6b-66f4a258eff7.json`.

Попередження etchly inventory і `Dash refused the write: invalid-input` (двічі, pid процесу raf-main) були й на RED, і на GREEN. Вони не є результатом цього відбору: фікстура жуків не пише, а raf-main ще без цього hotfix.

Реєстр test-runs записав raf комітом `bb0d066b6b` з темою `conf: agent test group registrations (auto)`. Це не коміт виконавця.

## Читабельність

Область: `settleCommandState` і `closeArchivedBugsAfterWorkerSession` у `src/reminder-cli.ts`, один виклик у `finally` `runProductionWorker`, `rememberedHookTrust` у `src/codex-raf-command-access.ts`, дві фікстури. Перевірка — власні незакомічені правки цього пункту до коміту. crapper/dryer/mutator цей пункт не призначає.

`closeArchivedBugsAfterWorkerSession` називає дію і момент. Вхід — корінь і home. Порожній home і QA HOME виходять одразу. Далі один наявний виклик `closeArchivedBugsForHome`. Помилка не підміняє результат сесії. З settle прибрано гілку, а не додано прапорець. Довгий `finally` воркера не переписувався: додано один іменований виклик поруч із уже перенесеним сканом груп.

`rememberedHookTrust` окремо читає, пише і промахується. Коментар біля тексту хука каже, чому шлях результатів і publication стоять у середовищі. Кеш не вигадує hash і не прибирає `--no-daemon`. Фікстури називають бюджет, архів і один spawn. Нових лімітів, таймаутів і видимих користувачу елементів немає.

Пункт 1.1 лишається відкритим. Архівація не виконується. Живий повтор — main.
