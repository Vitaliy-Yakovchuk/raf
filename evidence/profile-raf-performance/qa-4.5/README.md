# QA 4.5 — порівняння agent ps

Живе приймання ще не завершено. Перша пара не довела прискорення. Виявлений у цьому проході дефект подвійного відкриття SQLite виправлено за QA red → green у 535441d79f5b18d70442c9a7374c1037c428fee7. Main виконує окрему діагностику і нову пару на чистому клоні; unit не замінює ці результати.

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
