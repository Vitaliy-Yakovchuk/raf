# Продовження 1.1: occupancy 20

База: 9477e5d687715fb1fe8736cc968d551dafede22e. Власні правки — candidate.patch та src/tmux-pane-screens.ts. SQLite-копія main має 357 сесій, 20 активних, 421 нагадування, 417 result notices, 377 intents; raw state.sqlite* виключено з Git. Інвентар — live-state-inventory.json. Живий main до кандидата: ps 1214 мс, reminder list 387 мс при близько 20 активних агентах (повідомлення main). Живий запуск виконує лише main після активації.

## RED → GREEN

Стабільна група fix-raf-cli-live-latency/live-latency, project raf; команди й повні стани кожного прогону — *.transport.json, незмінені повні результати — *.TestRunResult.json, окремі CLI codes і stderr. Вивід JSON інструмента міг обрізатися; збережені TestRunResult повні. Частина stderr дослівно перенесена з виводу інструмента (явно позначено в transport). QA HOME і агрегат не змінювалися; timeoutCount=1 успадкований.

Початковий наявний тест із п'ятьма агентами проходив: baseline/hotfix. Після вказівки main occupancy піднято до 20 без зміни бюджетів. occupancy-red: run 562d1c65-66ad-47bb-8c60-8d23cfa528b4, ps 2078.26 мс, assertion failure; launch overhead 2780.57 мс. Це потрібний RED, не setup/import failure.

Пакетне читання Codex-екранів знизило ps до 1429.90/1271.52 мс (batch-first/batch-trace), але бюджету ще не було. CPU-профіль batch-cpu виявив 387.65 мс у розбиранні active sessions та 290.69 мс у повному listSessions. Тимчасове трасування і CPU profiler після діагностики прибрано. Адресний пошук running recipient та вибір кандидатів model handoff прибрали повторне розбирання великих launchContext.

occupancy-green: run 797e7481-a8a5-4603-9c9a-797dfe19f7b8, 89 passed, CLI/child 0, ps 648.39 мс <1000, RAF launch overhead 2375.37 мс <3000, reminder list 17.55 мс <500. 20 реальних tmux-агентів, 426 сесій, 130 active changes, 2.17 МБ tasks, selected tasks 235306 bytes, telemetry активна. Зовнішні readiness/delivery 7224 мс виключені з RAF overhead за чинним контрактом; повний launch wall 9599.37 мс. Cleanup complete, timedOut=false, knownRed/unexecuted/unknown=[], groupState complete.

Фінальна перевірка поведінки behavior-final: run a4d6e4a3-ff84-4845-bb25-0b3fb5449197, 135 selected tests passed, child 0, assertions=[], cleanup complete, timeout=false. CLI 1/outcome assertions-failed: агрегат правдиво утримує 4 baseline failures, groupState optimize, nextAction fix-implementation; весь агрегат не називається passed.

## Окремі baseline failures

behavior-expanded і behavior-baseline показують однакові 4 падіння: launcher-notice-durability — retention/ps visibility; handoff-reconcile-z453 — orphan worker closure, dead wrapper closure, unconfirmed termination. Для baseline production-runtime/state-store/session-state/reminder-cli/production-model-handoff тимчасово повернено рівно до HEAD, потім кандидат відновлено. Baseline run c89eb6d4-3368-4ba7-a306-f35ea850f03a, файл test-run-6e21b050-a38c-45da-846f-89cc1790e8e6.json. Main явно прийняв ці чотири на окремий пункт: «4 baseline failures на HEAD 9477e5d не чини в 1.1 — запиши їх у звіт з run 6e21b050; main заведе окремий пункт». Галочки не змінювалися.

## Самоперевірка читабельності і збереження поведінки

Область: база вище → власний candidate.patch і новий tmux-pane-screens.ts. capturePaneScreens виконує одну argv-команду tmux, відділяє порожні/багаторядкові екрани унікальними маркерами; неповна/невдала відповідь повертає порожній кеш і зберігає поштучне читання. sessionTools.scanner.inspectMany групує лише підтверджені живі Codex-панелі за сокетом. AsyncLocalStorage тримає знімок лише поточного виклику. dismissCodexLimitModal використовує знімок лише для початкового виявлення; під lease повторно читає екран і поза кешем перевіряє ownership перед send-keys. Інший виклик отримує свіжий знімок.

findRunningSession та listModelHandoffCandidates виконують тільки SELECT; останній читає сторінки по 50 у rowid-порядку. Optional методи залишають попередній шлях для альтернативних repository. settleResultNotices розгорнуто з вкладеного ternary у явні умови: адресат за runId, заборона перенаправлення report rejection, адресний пошук running. Порядок claim/delivery і writer-транзакції не змінено. SQL-вибірки порівняно з повною JS-фільтрацією, включно з >50 handoffs, finished recipient і відсутньою адресою; writers=0. Тести перевіряють зникнення modal після lease, підтверджене dismissal, argv/stdin без shell, один ps/list-panes/screen batch та свіжі знімки між командами. Видимих користувачу підписів, параметрів, лімітів чи таймаутів не додано.

Копійні profile JSON — додаткова діагностика, не доказ живого бюджету: повне початкове копіювання дало EDQUOT; успішні повтори використовували лише документи OpenSpec без evidence. copy-profile-complete reminder 501.44 мс перевищує бюджет; це холодний окремий CLI на синтетично неактивних адресатах, а не main service. Початковий live-launch-timeline теж не є pass: він містить чергу/admission. Остаточний живий GREEN очікується від main після активації кандидата.

## Стан передачі

Власний коміт кандидата: 35a5b2e4500588fe5bd0f0027e87fd2fd11fdb93. Main прийняв кандидата й повідомив: активація блокується `inactive main slot busy`, два живі читачі старого raf-main-a (sandbox агентів, запущених 3,5 і 5 год тому); їх не зупиняють. Main активує після звільнення слота та передасть живі заміри. Деталі — activation-pending.json. Повного GREEN 1.1 наразі немає: статус передачі failed означає непідтверджений обов'язковий живий критерій, а не відмову latency-фікстури. Галочку 1.1 не ставити, зміну не архівувати; наступне продовження перевіряє активований SHA та живі ps/reminder/RAF overhead.
