# Hotfix 1.1.5: selective session history reads

База `704867d0115583a379571398adcdff297fe10a20`; production-кандидат — SHA256 файлів у `unit-runs.json`. Аудит proposal/tasks перед реалізацією: пункт чинний, конфлікту з актуальними вимогами не виявлено. Main у цій сесії уточнив живу базу: agent ps приблизно 0.95–1.09 с, потрібен стабільний час <1 с; активацію й живі заміри виконує main. Інші пункти й галочки не змінювалися.

## Service-side профіль копії

Read-only SQLite consistent backup `/home/dev/.raf/state.sqlite` через Python sqlite3.backup у приватний каталог запуску `live-copy/state.sqlite`. Копія містить 361 sessions, 443 result notices, 329 pending intents; сирі дані не комітяться. `profile-copy.mjs` створює окремий QA HOME і backup для кожного варіанта; переписує лише brief/report paths на власний tmp. Конфігурація та OpenSpec читаються з чинного кореня Orchestrator. Профілюється безпосередньо production `services.control.ps()`, без CLI/socket startup. Дозволено лише читальні ps/tmux child commands; інші виклики відхиляються. Профіль не надсилає клавіш живим агентам.

Команди з cwd raf-hotfix:

```
node evidence/hotfix-1.1.5/profile-copy.mjs /home/dev/.raf/tmp/4058897b-fcb1-4ba2-86c8-e5614a9b9898/live-copy baseline
node evidence/hotfix-1.1.5/profile-copy.mjs /home/dev/.raf/tmp/4058897b-fcb1-4ba2-86c8-e5614a9b9898/live-copy candidate
```

Baseline виконано до production-правок, candidate після незалежної початкової реалізації, до читання підготовлених тестів. `baseline.cpuprofile`/`candidate.cpuprofile` і відповідні JSON: 9 повних listSessions (116.81 мс) → 1 (13.39 мс); нові listExpiredSessions: 8 викликів/11.44 мс, listSessionsByRunIds: 1/4.04 мс. Обидва повернули 89 рядків без service error. Wall 1603.14 → 1524.03 мс — спостереження, а не ізольована оцінка причинності: процеси між запусками змінюються. Копія фіналізує вже завершені процеси, має відсутні startup-context файли, відхиляє доставки, тому не є живим сервісом і не доводить бюджет <1 с. Залишкове одне повне читання не приховано.

`before.*` — перший діагностичний запуск до нормалізації brief/report paths: service зупинився через Startup context run directory identity mismatch. Це неповний профіль, не pass. Після виправлення підготовки копії виконано baseline вище; production-код ще не змінювався.

## RED/GREEN на однаковій копії стану

`compare-copy.mjs` дістає дві базові функції через git show HEAD у `.test-evidence/session-history-baseline`, перенаправляє лише відносні imports на незмінні спільні модулі й порівнює з кандидатом. Обидві версії використовують незалежні backups одного snapshot, однаковий `now`, production StateStore. `compare-copy.json`: вивід 36 рядків notices і всі 361 збережені sessions точно однакові, включно з порядком та payload (assert.deepEqual і SHA256). Видалень 0 в обох. Стара версія: перший виклик 73.18 мс, 2 full-history reads/1 writer; повторний retention 20.00 мс, 1 full read/1 writer. Кандидат: 22.55 мс, 0 full reads/0 writers; повторний retention 0.96 мс, 0/0. Регресія доводить відсутність повної десеріалізації та no-op writer, не зміну retention. Сирі рядки не публікуються.

```
node evidence/hotfix-1.1.5/compare-copy.mjs /home/dev/.raf/tmp/4058897b-fcb1-4ba2-86c8-e5614a9b9898/live-copy
```

## Unit RED/GREEN

Незалежну реалізацію завершено до відкриття підготовлених тестів. Для первинного RED кандидат збережено приватно, три власні production-файли тимчасово відновлено до бази; після RED повернено той самий кандидат. Main повідомив, що інших raf hotfix-виконавців немає. Тести не послаблювалися.

Повний відбір, команди, runId, hashes, CLI/child коди й стан групи — `unit-runs.json`. `red.TestRunResult.json`: a17c7c9d-0dcc-4577-a904-85ff993a52a2, assertions-failed, три цільові падіння (повна історія notices, no-op writer retention, відсутнє адресне читання), один сценарій збереження поведінки passed; CLI/child 1/1. `green.TestRunResult.json`: 52267499-c6a9-4013-a742-f82c66f2d681, 403 passed у всіх 23 файлах стабільної групи live-latency, CLI/child 0/0; cleanup.complete=true, timedOut=false, knownRed/unexecuted/unknown порожні, groupState/nextAction complete/complete. QA HOME і агрегат не змінювалися.

Фікстура full CLI: ps 413.23 мс, reminder list 437.21 мс, agent run 2344.88 мс. Це не живі бюджети. Нові регресії перевіряють порядок/пріоритет stored sessions та fallback sources, відсутність десеріалізації не пов'язаних сесій, no-op writer, точну межу retention, timestamp offsets, invalid dates, збереження handoff/active, повторний відбір усередині writer після зміни між транзакціями, повноту сторінок і duplicate/missing IDs. Старі тести перевіряють незмінні доставки й lifecycle.

Повні незмінені TestRunResult скопійовано з raf tmp-файлів. `.tool.json` зберігає відповідь інструмента. GREEN tool output обрізано; JSON-доказ повний. `.stderr.txt` — повний доступний блок warning/result-path із combined output; окремого stream stderr інструмент не надає. `.cli-exit.txt` відокремлено від child exitCode. Повтор заради stderr не виконувався.

## Реєстр і перевірка читабельності

`registry-additions.json` — повна передача main: project raf; один unitFiles і три files-доповнення стабільної групи, внесено in-place. Спільний conf/test-runs.json комітить main. Інші паралельні правки цього файла не належать цій роботі.

Самоперевірка від 704867d до кандидата з unit-runs.json охоплює всю `resultNoticeViews` у src/reminder-cli.ts, `cleanupCompleted` і додані контракти у src/session-state.ts, обидва нові методи транзакції у src/state-store.ts та чотири нові регресійні сценарії. Потік notices → унікальні недоставлені run IDs → адресний SELECT → попередній порядок stored rows → fallback source явний; delivered notices лишаються доступні для видимих активних rows. SQL не пов'язаний із UI notices: контракт приймає run IDs. Retention читає вузькі SQL-метадані, використовує той самий Date.parse і чинний cutoff із flow, десеріалізує лише потенційно прострочене; доменний фільтр зберігає handoff. За порожнього відбору немає запису; інакше відбір повторюється всередині writer, видалення й результат явні. Optional repository capabilities мають чинний in-memory fallback. Сторінки 50 повторюють наявний механізм SQLite читання, не додають загального ліміту результатів, вимог чи таймаутів. Схему стану та користувацький вивід не змінено. Вся змінена функція переглянута, сусідній незмінений борг не розширював область. Предметне приймання main/QA залишається за чинним flow; самоперевірка його не замінює.

`npm run build`, `node scripts/check-comments.ts`, `git diff --check` — exit 0. Потрібна наступна дія main: активувати кандидат, перезапустити сервіс і виміряти живі ps/list/дозволений run. До того живі бюджети не підтверджені. Інші пункти зміни відкриті, sync/archive не виконується.
