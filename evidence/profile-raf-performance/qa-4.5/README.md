# QA 4.5 — порівняння agent ps

Живе приймання ще не завершено. Перша пара не довела прискорення. Виявлений у цьому проході дефект подвійного відкриття SQLite виправлено за QA red → green у 535441d79f5b18d70442c9a7374c1037c428fee7. Окрема діагностика підтвердила причину. Пара stand26 має менші середні в усіх випадках, але малий wall-виграш PID reuse не відділяється від шуму; це не pass. Друге побудування production context усунено за QA red → green у a592802c693130c26460fd7b82645636bf3c2882. Main виконає нову пару; unit не замінює ці результати.

## Перша пара: прискорення не підтверджене

Контроль — початковий source SHA 1212a1330a2b097620bd491e5cc8d2f549c774b9; після 4.4 — 1451bbe3f9521a0da486ec3b9cd94de3a5e863ba. Той самий scripts/qa-agent-ps-comparison.mjs, конфігурація /srv/dev/work/orchestrator/conf, шість випадків і п'ять незалежно відновлених seed SQLite на випадок. Main зафіксував конфігурацію на час обох серій, sourceConfiguration і fixtureConfiguration збігаються, helper CPU обліковує Linux wait4 rusage. Актори/служба не входять у виміряний CPU CLI; всі дочірні helper-процеси завершуються й обліковуються. Калібрування self+helper — cpu-accounting-calibration.json, calibrate-rusage.py.

| Випадок | wallMs mean до → після | Повний CPU ms mean до → після | wallMs SD до / після | CPU SD до / після |
| --- | ---: | ---: | ---: | ---: |
| empty | 2352.65 → 2443.77 | 2891.19 → 2979.45 | 172.94 / 137.72 | 227.62 / 180.06 |
| live | 2713.09 → 2745.35 | 3264.12 → 3204.94 | 71.39 / 151.97 | 188.96 / 28.74 |
| finished | 2227.94 → 2388.74 | 2839.64 → 2852.51 | 125.72 / 94.34 | 215.34 / 63.91 |
| missing | 2499.10 → 2779.88 | 3004.59 → 3378.68 | 101.15 / 138.73 | 215.10 / 156.70 |
| pid-reused | 2382.50 → 2802.74 | 2919.75 → 3367.91 | 173.41 / 92.69 | 244.47 / 99.10 |
| unverifiable | 2356.26 → 2705.78 | 2748.46 → 3212.76 | 174.94 / 209.18 | 106.57 / 168.37 |

Усі окремі samples, min/max, зовнішній wall, self CPU, повний CPU, стадії й перетин діапазонів — attempt-1/comparison.json. Значення wall тут — сума self-стадій профілю; externalWallMs з незалежного wait4-вимірювання наведений поруч у JSON. Розкид не приховано. Менший середній wall не отримано в жодному випадку; зменшення CPU live не закриває решту матриці.

Обидві серії виконали сценарії без неочікуваних CLI-помилок: у кожній 135 команд, із них 12 навмисних PROCESS_SCAN_UNKNOWN (unverifiable); решта ps/stats/service CLI 0. Повторний ps і звірка SQLite підтверджують збереження результатів, резервувань, нагадувань і подій. Missing/PID reuse закривають сесію атомарно та без дублювання подій; unknown зберігає running/reservation і не вигадує closure. Cleanup: service stopped, актори завершені, remainingProcesses порожній, integrity_check ok.

Офлайн-перевірка всіх raw stdout/stderr, rusage, профільних дельт, семантичних таблиць SQLite і зіставлення серій: `node evidence/profile-raf-performance/qa-4.5/verify-comparison.mjs evidence/profile-raf-performance/qa-4.5/attempt-1/before/summary.json evidence/profile-raf-performance/qa-4.5/attempt-1/after/summary.json /tmp/p45-comparison.json` → CLI 0, evidenceIntegrity verified, allCasesHaveFavorableMeans false. Її збережені stdout/stderr/CLI — attempt-1/verification.*; локальні 651+651 файлів повторно звірені з selected.sha256, portable-sha256-review.json.

Повні незмінні read-only host-архіви main: /srv/dev/p45-wzWK2O (13454 файли, MANIFEST.sha256 9539a749311f33dedc8e5e6aa4553abf98ec33f916ab4585c98641b8f7bf54c5) та /srv/dev/p45-q27DT6 (14696, fa1dbfc2454c4c5dc52f4f86a79fa7f53c353885919503ef1bff5f1858da3b81). У репозиторії збережено байт-у-байт усі ev, summary, stdout/stderr та fixture conf, а також повні host manifests. Git/source/node_modules залишаються на host; перевірено всі скопійовані файли, не заявляється повторний hash усіх Git objects. Main повідомив CLI обох стендів 0 і secscan ev/summary 0; джерело й межі цієї перевірки — archive-review.json.

## Зіставлення з початковим 4.1

Початкову 4.1 повторно перевірено офлайн: baseline-reverification.* → 0. Там повний CPU був unknown, а три файли conf відрізнялися від актуальних. Тому його середні не підміняють контроль: baseline-conditions.json показує точні SHA/fingerprints і різниці; для чесного порівняння source 4.1 запущено знову за однаковою конфігурацією й повним wait4 CPU. Оригінальні докази 4.1 не змінювались.

## Знайдені дефекти та unit

Стара profile health-фікстура після зміни контракту: QA-red 75882e6a-67e7-4764-b4ef-44a53958be4a (30 passed / 1 failed, CLI/child 1) → фікстура 2047779a3e740cca4872dee1cfb31c8565375062 → QA-green 227ec585-9457-4a7f-bcd2-8a4d4bc271fe (31 passed, CLI/child 0). Початковий додатковий red-фазовий прогін також збережено, але QA red є окремим власним провальним QA-прогоном. Повні TestRunResult/stderr/CLI поруч, unit-review.json пояснює групу, HOME й workspace snapshots.

Подвійне відкриття: double-open-review.md; QA-red 523fb23b-905f-4bc6-8adb-1d7901d835e4 → виправлення → QA-green 134bde56-2aa0-409c-a912-0b93804a0bcd (21 passed, CLI/child 0). Повні незмінені TestRunResult, stderr, CLI transport, SHA/dirty diff та перевірки build/comments збережені. Невідомих/невиконаних тестів немає, cleanup завершено, timeout false, groupState complete/nextAction complete. Група й QA HOME не скидалися.

Статичний аудит source-scope.* відділяє batch process scan від 13 інших src-змін між baseline та першою післясерією. Саме зменшення кількості process scans live 2 → 1 не доводить загального прискорення. Живі дельти показали переважні startup/config, handler і sqlite витрати; друге відкриття тієї самої SQLite усунено лише для agent ps без зміни перевірок ідентичності чи нових кешів/таймерів/порогів.

workspace-uncommitted.json зберігає точний попередній dirty patch як JSON-рядок замість raw patch-файла, щоб кодовий diff-check не трактував пробіли контексту сторонніх правок як нові помилки. Чужі зміни не комітилися. tasks.md не змінено; 4.5 не позначено виконаним. 5.1 лишається окремим відкритим пунктом, архівація не застосовується.

Повтор host-стенду з read-only conf спочатку завершився setup EACCES: fs.cpSync зберіг права джерела у новій копії. Власний QA-red 99afbdfe-ee90-49ad-a269-0b96755e3b24 (21 passed / 1 assertion failed, CLI/child 1) → зміна прав лише нової власної копії → QA-green 7bfe3c89-dea6-455d-b6a0-0e2a97764b54 (22 passed, CLI/child 0). Джерело залишається незмінним. Повні TestRunResult/stderr/CLI і workspace proofs — conf-copy-*. Група та HOME ті самі, timeout false, cleanup complete, knownRed/unexecuted/unknown порожні у green, groupState complete/nextAction complete. Діагностика тепер активує звичайну нову генерацію у свіжому root і відновлює вихідний empty seed після warmup; перенесена копія активної генерації не використовується. Це setup-виправлення, не доказ прискорення.

Нова ціль 535441d має productionStorePaths, що вимагає справжнього develop worktree зареєстрованого module store. Host setup service start відмовив ENOENT raf-develop до samples; це не red і не швидкісні дані. Перший unit layout-fixture-failure 36a19580 з тим самим ENOENT також не використано як цільовий red. Окремий власний QA-red 867d32ca-55f5-463e-9225-d4c85f379f8f довів лічильником 0 !== 1 відсутність зареєстрованого develop worktree; після додавання справжнього git worktree після absorbgitdirs QA-green 57ad4c30-a4d3-41be-9c7a-a7deb5ab35f5 — 23 passed, CLI/child 0. Тест також перевіряє productionStorePaths/resolveProductionStore, branch, SHA, спільний module store і незмінну main branch. Той самий setup застосовано до обох SHA; жодного послаблення production guard. Повні TestRunResult/stderr/CLI/workspace — layout-*. Група/HOME незмінні, cleanup complete, timeout false, knownRed/unexecuted/unknown порожні, groupState complete/nextAction complete.

## Жива діагностика причини

Main запустив окремі CPU-діагностики з чистого клону fc2bd476aebb79101272b3f467c6fecc888361b5; обидві CLI 0, stdout [], stderr порожній. Нові root активували звичайні генерації та відновили вихідний empty seed після warmup. Архіви /srv/dev/p45-diag-q9rZeo і /srv/dev/p45-diag-XSTgEr read-only, secscan 0 за повідомленням main. Повні manifests, command/stdout/stderr, operation wrappers і V8 CPU profiles збережено в diagnostic/before та diagnostic/after-4.4, hashes і provenance — diagnostic/archive-review.json.

Baseline: два реальні openStateStore (531 + 481 ms, разом 1012 ms inclusive wall), вісім вкладених verifyStateContext (1008 ms). Після 4.4: два відкриття (607 + 602 ms, разом 1208 ms), вісім вкладених verify (1203 ms). V8 стек показує openStateStore → checkContext/verifyStateContext → resolveStateContext → hotfixModuleOrigin → inventory/walk; домінують читання/lstat/hash файлів походження генерації. Це пояснює вартість другого власника SQLite і підкріплює детермінований QA red/fix 535441d. Вкладені store/guard суми не додаються. V8 timeDeltas — інтервали семплювання для локалізації роботи, не незалежний повний CPU; діагностика не входить у приймальні швидкісні серії. Відтворюваний аналіз — analyze-diagnostic.mjs, збережені analysis.json у кожній фікстурі.

Спроби setup не приховано: setup-failed-attempts зберігає відмови fingerprint при перенесенні активної генерації й EACCES копії read-only conf; attempt-2 — after service-start ENOENT raf-develop (0 samples) та повний окремий контроль 1212a13 (30 samples, 135 commands, CLI 0), що не має matched after тим самим harness і не використовується для приймання. Raw summary/commands/rusage/logs і manifests перевірено за SHA; archive-review.json називає джерела CLI/secscan. Matched пара з f9abba613502a94e0be66aba26fcea8018c5369c завершена; див. наступний розділ.

## Stand26 після 535441d: середні кращі, шум ще заважає прийманню

Однаковий harness f9abba613502a94e0be66aba26fcea8018c5369c, pinned conf /srv/dev/p45-wzWK2O/root/conf, по 5 відновлених samples кожного випадку. Main: обидва CLI 0, read-only, secscan чистий. Локальні attempt-3/{before,after} містять 647 + 647 перевірених за host manifests файлів, окремі незмінні harness stdout/stderr з hashes у archive-review.json. Офлайн verification → 0: усі 270 CLI-команд, повний CPU, профільні дельти, початкові/кінцеві semantic SQLite й результати/події збігаються. Cleanup обох завершено, процесів не лишилося.

| Випадок | wall mean до → після, ms | wall SD до / після | повний CPU mean до → після, ms | CPU SD до / після |
| --- | ---: | ---: | ---: | ---: |
| empty | 2267.27 → 2092.39 | 151.88 / 81.24 | 2903.37 → 2392.72 | 295.14 / 46.77 |
| live | 2633.77 → 2217.34 | 128.05 / 54.07 | 3383.19 → 2709.18 | 180.31 / 74.75 |
| finished | 2241.49 → 2023.74 | 66.18 / 133.66 | 2885.92 → 2420.62 | 150.57 / 156.92 |
| missing | 2493.17 → 2336.67 | 56.67 / 142.81 | 3206.74 → 2813.22 | 67.48 / 154.53 |
| pid-reused | 2442.62 → 2381.16 | 147.58 / 116.76 | 3177.21 → 2985.65 | 189.77 / 177.23 |
| unverifiable | 2455.33 → 2357.28 | 103.06 / 132.72 | 3218.45 → 2922.66 | 140.12 / 212.99 |

Повні values/min/max/SD, external wall/self CPU й профільні стадії — attempt-3/comparison.json та summary кожної серії. Різниця wall PID reuse лише 61.46 ms проти SD 147.58 / 116.76; unknown теж має помітний перетин розкиду. allCasesHaveFavorableMeans true означає арифметику середніх, не приймання за умовою про шум. Довільний поріг прискорення не вводиться.

Подальший детермінований дефект — друге productionStateContext при позиченій SQLite — виправлено в a592802 (context-review.md). Власний qa-red 80599710 (16 passed, 7 assertions 2 !== 1, CLI/child 1) → qa-green 37fff8df (23 passed, CLI/child 0). Повні context-* докази, build/comments 0. Наступна matched пара — a592802 проти 1212a13 з тим самим harness/conf/матрицею.

unit-history.json інвентаризує всі власні прогони з повними runId, SHA raw результатів, CLI/child, group/HOME, selection і завершенням. deployment-follow-up.txt — точний запропонований main текст відкритого пункту викладки; tasks.md редагує main.
