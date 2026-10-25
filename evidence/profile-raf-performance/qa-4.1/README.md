QA 4.1 — baseline збережено, до оптимізації

Main виконав перевірений host-скрипт на чистому клоні raf-develop `1212a1330a2b097620bd491e5cc8d2f549c774b9` після закриття 2.4/3.4. Команда:

    node scripts/qa-agent-ps-baseline.mjs 1212a1330a2b097620bd491e5cc8d2f549c774b9 /srv/dev/work/orchestrator/conf 5

Host CLI=0 за підтвердженням main; stdout містить `status: passed`, stderr порожній. Запуск `p41-03l048`: 2026-10-25T02:24:01.154Z — 02:29:38.580Z. Повний незмінений host-артефакт — [host/](host/), початковий read-only оригінал `/srv/dev/prp41-baseline-ev`, manifest [host.sha256](host.sha256), повний стенд `/srv/dev/p41-03l048`. Main повідомив secret scan 0. Усі 490 файлів скопійовано побайтово; зайвих, відсутніх або обрізаних файлів немає. [review.json](review.json) відокремлює підтверджений main код host CLI від кодів кожного дочірнього CLI в `host/ev/<label>.json`.

Офлайн-перевірка доказів, без повтору стенда або unit-груп:

    node evidence/profile-raf-performance/qa-4.1/verify.mjs

Перевірено 135 CLI-викликів: 60 `command stats` CLI0, 60 штатних `agent ps` CLI0, 12 навмисних `agent ps` CLI1 (`PROCESS_SCAN_UNKNOWN`), 3 service-команди CLI0. Усі signal/error null, stdout/stderr відповідають записаним byte counts. Для кожного із 30 вимірів повторно обчислено delta сирих profile rows, self wall/CPU, середнє, min/max і стандартне відхилення; перевірено семантику результатів і SQLite. Host також перевірив повторний `ps` після кожного виміру: нових close/failure-подій немає. Нових функціональних дефектів не виявлено. Зайві сканування нижче — предмет уже запланованих 4.2–4.4, цей пункт не змінює production-код. Unit-прогонів у 4.1 немає: TestRunResult/runId/knownRed/group state непридатні для цього інтеграційного стенда й не вигадуються.

Підготовка й порівнянність

Власні HOME/TMPDIR/SQLite під `/srv/dev/p41-03l048`, ізольований Git-root `bdc617b2dda7fecee74516086d5a9b4f1f01b783`. Реальна служба: start → status ready/resourceWaitReady=true → stop. Під час серій службу зупинено, щоб вона не звіряла ті самі сесії конкурентно. Процеси — реальні idle Node actors; записи сесій внесено через репозиторії SQLite. Моделі, авторизацію провайдерів і runner payload не запускали. Типи main/hotfix перевірені як activity живих сесій; доставка й реальний запуск провайдерів не є предметом baseline `ps`.

Кожний warmup/вимір/діагностика починається зі свого початкового стану; перед кожним виміром і діагностикою відновлюється незмінний `host/ev/<case>-seed.sqlite` з hash у summary. Warmup запускається після створення того самого seed. Вимір: restore → stats-before → ps → state-after → stats-after → idempotent ps. Початкові записи/резерви/нагадування й audit trigger збережені в `<case>-seed.json`, seed SQLite та `summary.cases[].initial`. Audit trigger фіксує INSERT pending_intents до їх споживання в тому самому CLI. Для зниклого PID actor завершено й дочікувано reap; PID-reused моделюється застарілою командою ідентичності реального живого PID, без примусового повторного виділення PID ОС. Unverifiable має порожнє command evidence.

Linux `7.0.0-30-generic`, Ubuntu 26.04.1, Node v26.12.1, 8 доступних CPU; git 2.53.0, tmux 3.6, procps-ng 4.0.4. Новий CLI-процес на кожний виклик, теплий файловий кеш після збереженого warmup, без скидання кешів і штучного навантаження. Спільний host: load1 під час вимірів 2.55–3.93; усі три load averages і число процесів є для кожного sample. Це опис середовища, не ізольований CPU benchmark. SHA, Node/ОС/версії, source/fixture conf SHA256 (6 файлів), catalog fingerprint та зміни conf збережені у [summary.json](host/summary.json). Власна conf залишає лише raf/orchestrator, штатний main route, окремий state.sqlite; optional bugs вилучено. Число 5 — обсяг цієї експериментальної серії, не flow-поріг або умова приймання.

Результати, ms; n=5 у кожному рядку. Wall профілю — сума неперетинних self-етапів, без додавання child wall. Self CPU — сума user+system; на багатопотоковому процесі вона може перевищувати wall. Середні є арифметичними за delta накопичених totals/samples, не EMA зі старою історією. σ — population standard deviation.

| Стан; записів / активних | Self wall mean | Self wall min–max; σ | Зовнішній CLI wall mean | Self CPU mean | Self CPU min–max; σ |
| --- | ---: | ---: | ---: | ---: | ---: |
| empty; 0 / 0 | 2299.4 | 2224.4–2373.5; 62.1 | 2431.5 | 2691.3 | 2416.9–2852.0; 151.3 |
| live main+hotfix + finished; 3 / 2 | 2551.6 | 2391.7–2744.2; 114.2 | 2707.2 | 2915.8 | 2657.5–3182.6; 174.2 |
| finished; 1 / 0 | 2205.7 | 2075.0–2358.7; 91.9 | 2346.7 | 2599.5 | 2409.3–2831.6; 168.8 |
| missing + finished; 2 / 1 | 2460.0 | 2286.8–2549.8; 96.2 | 2617.6 | 2900.7 | 2686.7–3026.1; 122.7 |
| pid-reused + finished; 2 / 1 | 2438.2 | 2148.9–2608.4; 168.6 | 2594.5 | 2855.0 | 2432.1–3084.8; 230.0 |
| unverifiable + finished; 2 / 1 | 2381.9 | 2180.0–2577.6; 147.2 | 2526.6 | 2756.3 | 2589.5–2992.1; 190.2 |

Неокруглені значення, зовнішній wall min/max/σ, CPU user/system поетапно та samples є в summary і `<case>-<n>-sample.json`. Для helper `ps` профіль чесно повертає CPU unavailable/null: `Per-child OS CPU accounting unavailable from spawn`. Empty/finished не мають instrumented child interval; це також не доказ нульових зовнішніх startup-витрат. Повний CPU raf тут невідомий у всіх сценаріях. Baseline 4.1 допускає явну неповноту; приймання незростання повного CPU у 4.5 потребує окремого коректного обліку helper. Немає висновку про прискорення або відповідність SQLite-only budget.

Семантика й зайва робота

Live повертає лише `main` і `qa-hotfix`, обидва alive. Empty/finished повертають `[]`. Missing/PID mismatch закривають лише відповідну сесію як failed, звільняють її резерв, записують рівно по одному agent.failed/agent.closed та передають pending reminder на main зі збереженими createdFor/at. Finished не оживає. Unverifiable зберігає running, observation unknown і резерв, не створює agent.closed; навмисний CLI1 не є невідомим результатом стенда. Первинний `state-after.json` збережений для кожного виміру, сирі stdout/stderr — окремо від CLI-коду.

| Стан | Найдорожчий self stage | Mean stage wall | Mean reconciliation wall | Повних `ps` у незалежній діагностиці |
| --- | --- | ---: | ---: | ---: |
| empty | startup/config | 1093.7 | 24.4 | 0 |
| live | startup/config | 973.4 | 305.8 | 2 |
| finished | startup/config | 970.6 | 8.3 | 0 |
| missing | startup/config | 1076.4 | 169.7 | 1 |
| pid-reused | startup/config | 1049.5 | 187.3 | 1 |
| unverifiable | startup/config | 1016.7 | 153.7 | 1 |

Найдорожчий виміряний етап — startup/config для всієї матриці. Профіль не деталізує операції всередині нього, тому повторне hashing дерева/імпорти не оголошуються доведеним джерелом цієї вартості. Для оптимізації найбільшого етапу потрібне подальше адресне вимірювання.

Конкретно доведена зайва операція в reconciliation: двічі отримана повна таблиця процесів `ps -ww -axo pid=,lstart=,command=` у межах одного live `agent ps` для двох ідентичностей. Доказ — `host/ev/live-ps-scans.jsonl` і окремий diagnostic CLI. PATH tracer рахує тільки справжні виклики `ps`, делегує системному executable, не входить у timed series. Source на reviewed SHA: `AgentControlService.ps()` послідовно reconcile кожну активну сесію (`src/agent-control.ts`); `observeIdentity()` викликає `observeProcesses([identity])` (`src/production-runtime.ts`); `observeProcesses()` кожного разу запитує всю таблицю, хоча його API вже приймає масив (`src/os-runtime.ts`). Спільне спостереження в межах виклику може усунути повторну таблицю зі збереженням перевірки кожного PID/start/command/boot. Не йдеться про кеш між викликами або пропуск процесної звірки. Це напрямок детермінованого лічильника 4.2, а не вже доведений спосіб прискорити empty/finished. Саме усунення другого scan не пояснить 971–1094 ms startup/config; порівняння 4.5 має перевірити всю матрицю без обіцянки результату.

Worker polling не вимірювався цим CLI baseline й не реалізовувався повторно. Перетин із fix-raf-load-admission 9.1.1 / profile-raf-performance 5.1 передано main повідомленнями; їхні worker-витрати не підміняють витрати `command agent ps`.

Cleanup підтверджено: служба stopped, усі три actors exit0, remainingProcesses=[], SQLite integrity_check=ok, complete=true. Timeout/signal/setup failure немає; невиконаних сценаріїв 4.1 немає. Наступні 4.2–4.5 і 5.1 залишаються відкритими. tasks.md не змінювався; галочку 4.1 ставить raf. Sync/archive не виконуються, бо інші задачі зміни відкриті.
