# 1.1.8: приватні часові мітки запуску та зайве очікування worker-health

Кандидат коду: `8fc6092aa564e7d0eaea9edd7e035fa3d52a62cc`, репозиторій `/srv/dev/work/orchestrator/raf-hotfix`.
Доручений лише пункт `fix-raf-cli-live-latency:1.1.8`; галочки не змінено, архівація не застосовується.

Доручений етап **succeeded** за підтвердженим прийманням main: фікстура RAF 4.49 → 0.90 с, GREEN `0443fecf`, гарантії збережено. **Живий GREEN Codex і Claude не доведено; це окрема наступна дія main, а не критерій цього етапу.** Старі 11.39/9.93 с не можна розкласти ретроспективно: тоді service-side міток не було. Знайдено зайвий бар'єр RAF, але його фактичний внесок саме в ці два запуски невідомий. Потрібен повтор main після активації кандидата, з новим `launch-timeline.jsonl` та клієнтським wall.

## Чинний контракт і зміна

Main уточнив у цій сесії 2026-11-08: «Гарантії agent-adapters (native identity перед brief, brief прийнято через native.working/finished до handshake) — чинні вимоги, не послаблюй і раннє succeeded не вводь». Бюджет <3 с застосовується до власного часу RAF, runner readiness/nativeId враховуються окремо; live repeat виконує main. Це уточнення обліку, а не підстава вважати неперевірений live запуск успішним.

`runProductionWorker` перед запуском tmux синхронно виконував загальний `settleCommandState`: notices/reminders/health delivery та узгодження всіх сесій HOME. Батьківська команда також виконує власний `settle()` у `finally`. Порожній synthetic HOME не відтворював затримку загальної доставки. Початковий worker settle перенесено після передавання вже перевіреного handshake; періодичний health summary збережено. Батьківський settle залишається на своєму місці. Жодних нових timeout, лімітів або умов раннього success немає.

Ідентичність runner, native readiness, ownership після доставки, підтверджене прийняття brief та durable lifecycle лишилися перед handshake. Тексти й публічний JSON CLI не доповнювалися діагностикою.

## Приватна часова шкала

Файл кожного нового запуску: `~/.raf/tmp/<runId>/launch-timeline.jsonl`, створюється з mode `0600` у наявній приватній теці запуску. Кожний рядок має `runId`, `stage`, `atMs`, UTC `at`, PID джерела; optional runner та PID/OS startedAt. Brief, screen і credentials сюди не записуються. Помилка запису діагностики не змінює поведінку команди.

Мітки: `cli-start`; `brief-start/end`; `admission-start/end`; `worker-start`; `command-access-start/end` для Codex; `tmux-spawn-start/end`; `readiness-start/end`; `native-screen-ready`; `native-id-visible`; `runner-process-observed`; `delivery-start/end`; `lifecycle-start/end`; `handshake-start/sent/received`; `worker-health-start/end`; `command-settle-start/end`; `handler-end`; `cli-response-ready/flushed`.

`cli-start` відновлюється від monotonic boundary початку CLI; інші мітки — спостереження на межах викликів. `cli-response-flushed` записується після callback stdout. OS `runnerStartedAt` має секундну точність, а `runner-process-observed` позначає момент перевірки ownership, не точний момент spawn процесу. PID можуть бути з різних namespace; для об'єднання використовується runId. `readiness-end` означає завершення спостереження, тому за failed readiness його не можна віднімати як успішний runner startup.

Для живого повтору main має зберегти повну шкалу, wall CLI та installed runner version. Readiness/nativeId observations включають дискретність наявного polling; це не точний CPU-профіль самого runner. Не слід автоматично віднімати весь readiness interval і називати залишок доведеним чистим overhead: затримки polling RAF треба розглянути окремо. Очікування доставки до native.working/finished залишається обов'язковим і вимірюється окремо.

## Фікстура повільної загальної доставки

`profile-worker.mjs` запускає ізольований production worker з synthetic Codex і додає 3500 мс лише до copied worker health settle. Baseline повертає цей settle перед tmux; candidate залишає його після handshake. Це діагностичний профіль, окремий від unit-прогонів.

| Варіант | adapter.start до handshake | readiness | залишок |
| --- | ---: | ---: | ---: |
| baseline | 5116.69 мс | 624 мс | 4492.69 мс |
| candidate | 1530.77 мс | 626 мс | 904.77 мс |

Докази: [fixture-baseline.json](fixture-baseline.json), [fixture-green.json](fixture-green.json). Candidate handshake отримано о `04:01:28.838Z`; health завершується о `04:01:32.385Z`. Виміряно adapter handshake, не повний зовнішній CLI wall. Unit-регресія перевіряє як повний цей interval <3000 мс, так і його залишок, а також порядок прийняття brief і handshake. Число 3500 — затримка фікстури, не новий production timeout і не вимір старого live запуску.

Відтворення діагностики: `node evidence/hotfix-1.1.8/profile-worker.mjs --baseline` та `node evidence/hotfix-1.1.8/profile-worker.mjs`. Скрипт сам створює QA HOME, приватний tmux і прибирає свої worker/runner процеси.

## Справжні встановлені runner

Найповніший окремий native профіль: [native-delivery-writable.json](native-delivery-writable.json), скрипт `profile-native-delivery.mjs`. Приватний writable CODEX_HOME містив лише копії config/auth; модель/effort не перевизначалися. Codex отримав нешкідливий OK-only prompt із padding ~48 КБ, без tools або змін файлів. Claude prompt не отримував.

| Runner | raw ready від старту профілю | native ID | прийняття prompt |
| --- | ---: | ---: | ---: |
| Codex 0.166.0 | 816.39 мс | 1852.09 мс | 2398.05 мс |
| Claude Code 2.1.319 | 3571.41 мс | 4603.72 мс | не перевірялося |

Codex hook inspection займає 283.94 мс і входить у ці cumulative значення; tmux spawn — 19.34 мс. Native UI виміри не охоплюють production service, повний ownership/delivery gate та повернення CLI, тому це не GREEN вимоги. Claude показував `Not logged in · Run /login`: native ID у status не доводить можливість прийняття доручення. Частини readiness/nativeId визначає runner, але наведені observation значення також включають polling RAF. Перші `native-start-*` файли — діагностичні невдалі/неповні спостереження, не альтернативні pass.

Повний production worker перевірено на read-only backup SQLite, скопійованих conf/OpenSpec і приватному QA HOME: [real-codex.json](real-codex.json), [real-codex-home.json](real-codex-home.json) та відповідні `*.launch-timeline.jsonl`. У копії 364 sessions, 452 notices, 331 pending intents. Assignment/context/routing/report/brief/admission разом ~744 мс у першій спробі. Обидва запуски завершилися до native ID помилкою Codex nested filesystem sandbox: `app-server socket directory must be a user-owned directory with mode 0700 (code -32603)`. Перенесення QA HOME з /tmp до власної run-теки проблему не усунуло. Це конкретний blocker повного QA спостереження, не pass і не доказ, що старий live startup мав ту саму причину. Скрипт `profile-copy.mjs` є історичним діагностичним harness; наявність його result JSON або CLI code 0 не означає успіх, поле `error` обов'язкове до перевірки.

Живі state.sqlite не змінювалися; усі приватні tmux зупинено. Копії credentials і тимчасові QA дані видалено: [diagnostic-cleanup.json](diagnostic-cleanup.json). CPU sampling artifacts не включено: вони не дають повного профілю worker і не є доказом live бюджету.

## Адресні unit-прогони

Незалежну початкову реалізацію завершено до читання підготовлених startup/readiness тестів. Новий початковий тест часової шкали написано до production змін; RED — assertion mismatch без setup/import failure. Тести іншого пункту 1.1.7 не змінювалися.

Стабільна група: `fix-raf-cli-live-latency/live-latency`, той самий QA HOME і агрегат. Повні незмінені TestRunResult, stderr та окремі CLI codes збережено. Команди, selection, SHA зі спільного reflog на startedAt, стан workspace, cleanup/timeout, knownRed/unexecuted/unknown та nextAction — [test-executions.json](test-executions.json).

| Доказ | runId | outcome | CLI / child | Результат |
| --- | --- | --- | --- | --- |
| red | 1cb2a5f2-da43-4d3e-83b3-75cf01509678 | assertions-failed | 1 / 1 | відсутні мітки, правильний RED |
| hotfix-1 | 40dc103c-6ac5-4b32-94a3-6609155abd10 | assertions-failed | 1 / 1 | неправильний tmux socket у новій фікстурі |
| hotfix-2 | da4d97f9-5208-4d3f-bb35-5e2be8473dce | setup-failed | 1 / 1 | cleanup ENOTEMPTY, не був tracked worker |
| hotfix-3 | a01c580b-db45-4e8e-b259-ff16d7f1d161 | setup-failed | 1 / 1 | повторне ім'я worker у тесті |
| hotfix-4 | 583cc69f-3c77-48a6-a454-6aed62ac2d75 | passed | 0 / 0 | 18 passed |
| hotfix-5 | 0443fecf-81c6-4849-994b-d81c8ed84206 | passed | 0 / 0 | 18 passed, додано assert повного adapter interval <3 с |

Фінальна команда: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-cli-live-latency/live-latency --files test/launch-timeline.test.ts test/cli-agent-run-startup.test.ts test/production-runner-readiness-qa.test.ts`.
Фінальний результат: [hotfix-5.TestRunResult.json](hotfix-5.TestRunResult.json), [stderr](hotfix-5.stderr), [CLI code](hotfix-5.cli-exit-code); knownRed/unexecuted/unknown порожні, timeout false, cleanup complete без remaining PIDs, group complete, nextAction complete. Tool stdout деяких спроб обрізаний; повні TestRunResult скопійовано з automatic RAF result path, stderr повний. Повторів лише заради повного stderr не було. Непредметні warnings реєстру Etchly не приховано.

`node scripts/build.ts` і `git diff --check` пройшли; [build.json](build.json). Readability self-review: один малий helper відповідає за приватний append; stage-виклики стоять біля відповідних існуючих операцій; переміщено лише одну існуючу worker-health операцію, без нового загального orchestration framework, рекурсії або нових користувацьких умов. Приймання зберегло чинний lifecycle/native identity контракт. Частина про повний live бюджет залишається неперевіреною.

## Передача main

Реєстр уже доповнено in-place лише новим `test/launch-timeline.test.ts` у profiles.node.unitFiles та files цієї групи. Повний запис передачі — [registry-handoff.json](registry-handoff.json); main комітить спільний conf/test-runs.json. Доставка підтверджена receipt `329f403b-85f9-4392-a589-9b2073909221`.

Доповнення tasks.md без checkbox — [tasks.patch](tasks.patch). Власний root commit неможливий: [root-document-commit.json](root-document-commit.json), CLI 128, `Read-only file system` для `.git/index.lock`; main уже закомітив цей документ: `789b97ab490a986339e80463bca557f8080bc8b8` (перевірено в Git). Це чужий commit і до власного commits звіту не додається. Відмова доступу не обходилася, lock не видалявся.

Про завершення RED і GREEN та звільнення спільної групи main повідомлено підтвердженими receipts. Окремі повідомлення про candidate та root-document blocker не доставлено (`MESSAGE_NOT_ACCEPTED`, unrelated input); main згодом сам підтвердив candidate, коміт документа та приймання через повідомлення цієї сесії; [communication.json](communication.json) містить ненульові codes, completed/pending і remediation. Відсутність delivery не замінено твердженням про прийняття.

Наступне предметне завдання main: активувати перевірений candidate за власним контрактом, виконати справжні Codex і Claude запуски, зіставити wall та приватні stages, довести RAF overhead <3 с або передати наступному виконавцю конкретний повільний етап. Main прямо підтвердив у цій сесії: «Живий повтор за текстом 1.1.8 належить main після активації — це не твій критерій приймання, не позначай його failed. Заверши 1.1.8 succeeded: фікстура з етапами (RAF 4.49→0.90 с), GREEN 0443fecf, гарантії збережені; живий повтор Codex+Claude — main за launch-timeline.jsonl після активації 8fc6092a». Цей наступний live крок не видається за вже виконаний.
