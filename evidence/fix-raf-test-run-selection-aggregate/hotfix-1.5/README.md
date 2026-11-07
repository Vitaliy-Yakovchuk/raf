# Hotfix 1.5 — індекс адрес сесій і аудит state-store

Аудит актуальності: чинний пункт 1.5 tasks.md і доручення main описують фактичний дефект schema 19. Proposal містить початкову мету 1.1–1.2; додатковий обсяг 1.5 явно заданий tasks.md і брифом. Суперечності чинним вимогам не знайдено. Пункт 9.1 лишається відкритим; активацію й archive цей виконавець не виконує.

Міграція 19→20 в наявній транзакції: `CREATE INDEX IF NOT EXISTS sessions_address_state ON sessions(address_id, state)`, потім user_version=20 і migration callback. Підтримувані версії [17,18,19,20]. Індекс створюється і для нової бази; ручний індекс main приймається ідемпотентно. Повторні transfer/ordinary opens не змінюють schema_version і не запускають callbacks. Фікстура 19 отримана видаленням єдиної зміни 20 (індексу) і встановленням user_version=19; у ній 243 сесії, серед них 120 історичних для кожної з двох адрес. Payload усіх 240 історичних сесій перевірений після міграції.

Пошук reminder session спочатку адресно читає не-finished сесію, за її відсутності — finished; відсутня адреса лишається undefined. Це зберігає пріоритет reserved/running/exited і прибирає сортування всієї історії `ORDER BY state = 'finished'`. Самого нового індексу недостатньо для усунення цього сортування. Регресія перевіряє SQL, фактично переданий prepare: EXPLAIN QUERY PLAN має SEARCH sessions USING без SCAN або TEMP B-TREE. Кожне спостережене читання lookup і reservation list має незмінений limit=50 і rowsRead≤50.

## Аудит інших SQL у src/state-store.ts

Переглянуто всі прямі prepare/exec та readDatabaseTable, зокрема предикати, індекси, кардинальність результатів і DDL.

| Сімейство | Індексний або сторінковий шлях |
| --- | --- |
| sessions за run_id, зміна/видалення/перевірка recipient | PRIMARY KEY(run_id); додаткова перевірка address_id лишається після точного ключа |
| sessions за address_id і state !=/<> finished | наявний UNIQUE sessions_active_address; не більше однієї чинної сесії адреси |
| sessions за address_id і state=running, включно claim result notice | новий sessions_address_state(address_id,state); його потребу також покриває міграція 20 |
| reminders, pending_intents, runners, quotas, command_timings | точні PRIMARY KEY(id/runner/command) |
| reminder_deliveries, delivery_claims, quota_leases | точні PRIMARY KEY(reminder_id/target/key), додатковий token не розширює відбір |
| result_notices UPDATE за run_id | result_notices_run_id із schema 19; наявна регресія 122 notices пройшла після міграції до 20 |
| result_notices claim/complete/delete | PRIMARY KEY(id); повний list використовує readDatabaseTable |
| resource_wait_state/resource_wait_protocol_state | PRIMARY KEY(singleton) |
| agent_launch_queues | PRIMARY KEY(state_domain,machine_id); старі queue entries читаються readDatabaseTable |
| raf_cost_profile update/get | повний складений PRIMARY KEY(scope,command,stage,executor); readRows — readDatabaseTable |
| списки sessions/active sessions, reminders, admission_reservations, pending_intents та notices | наявний readDatabaseTable: keyset rowid, ORDER BY rowid LIMIT 50; фільтрація/сортування поза SQL |
| task_reservation_runs list та task_reservations list | знайдено ще два необмежені .all(): зовнішній list runs і внутрішній list tasks/run. Замінено двома сторінковими читаннями readDatabaseTable, одним групуванням задач за run_id та сортуванням поза SQL. Buffer.compare UTF-8 зберігає SQLite BINARY порядок run_id/project/change_instance/task_id, всі дані повертаються |
| task_reservation_runs/task_reservations insert/delete, FK cascades і trigger session finished | PRIMARY KEY(run_id), UNIQUE(fence), task_reservations_run(run_id), ключ задач; чинні reservation regressions пройшли |
| schema/version probes | PRAGMA user_version і SELECT 1 каталогу LIMIT 1; міграції 19/20 індексів без data .all(); наявна міграція 16 переносить таблицю сторінками |

Нових незахищених повних data scans серед прямих запитів state-store після виправлення не знайдено. Це аудит цього модуля й ізольовані unit-докази, не твердження про живі дані всіх модулів. Метрика guard — max(returnedRows,FULLSCAN_STEP+1); приховані indexed visits вона не вимірює. Існуючі окремі DDL-бюджети міграції 16 не змінено, нових винятків чи лімітів не додано.

## Прогони

Стабільна група `fix-raf-test-run-selection-aggregate/sessions-address-index`, профіль node. Точні виклики в *.invocation.json; запис реєстру — test-group.json. Конфігурація додана in-place; її коміт належить main (реєстрація вже є в HEAD Orchestrator). Додані наявні state-store, result-notices-run-index і task-reservations тести; notice-тест адаптовано до цільової версії 20 зі збереженням усіх тверджень.

| Прогін | RunId | CLI / child | Результат | Група / наступна дія |
| --- | --- | --- | --- | --- |
| RED | a3fe56d4-51f6-4902-965a-7748f9399378 | 1 / 1 | assertions-failed, 4 knownRed: lookup fullscan243>50, reservation list120>50, два непідтримувані transfers19→20 | idle / implement |
| Hotfix | 92a6c54c-ba9e-4d9f-b9d4-772c63f2a266 | 0 / 0 | passed85/85, усі 4 knownRed виправлені | complete / complete |

RED виконаний до production змін на HEAD428c705bd4b2a35a9c648c6698da9897b501e96b. red.workspace.json / .patch / .regression-test.ts.txt фіксують початковий стан; hotfix.* фіксують виконаний production diff і остаточну регресію. Додаткову перевірку query plans додано до тієї ж регресії перед GREEN. RED містить assertion failure цільового DB scan, setup/import failure немає; відмови двох migration tests за відсутньою schema20 не є окремим доказом read-scan, тому на них цей доказ не спирається.

У двох прогонах cleanup.complete=true, remainingPids=[], timedOut=false, timeoutCount=0, unexecuted=[], unknown=[], removed=[]. Фінальний knownRed=[]. HOME/statePath у TestRunResult однакові, агрегат не скидався. Resource telemetry completeness=partial збережена без твердження про повне спостереження ресурсів.

Повні незмінені TestRunResult скопійовані з файлів, названих raf у stderr: red.test-run-result.json і hotfix.test-run-result.json. *.tool.json містять повний tool capture, *.stderr.txt — повний stderr, *.invocation.json — CLI exitCode окремо від child exitCode, команду та джерело. Обрізання tool output/TestRunResult немає. Попередження про чужі конфігурації і Dash збережені, вони не є результатом unit-тестів.

Додаткові перевірки: git diff --check →0, node scripts/check-comments.ts →0. Після GREEN production-код не змінювався. Наступна дія main: активація цього кандидата з міграцією 19→20, включно якщо ручний sessions_address_state уже існує. Живу базу, read guard і ліміт 50 виконавець не змінював.
