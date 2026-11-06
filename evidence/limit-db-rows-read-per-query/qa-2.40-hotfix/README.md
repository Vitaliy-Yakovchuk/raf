# QA 2.40: кандидат від робочого main

Кандидат — HEAD цього дерева після коміту доказів; перевірений код — `ae3864cfbe674c8e773b545a5b341a69a5b7bf1a`, нащадок `63902948590a2ec4679baa16eb126f549294b99b`. Наступний коміт містить лише докази. Сім доручених комітів перенесено одним backport-комітом `ecf0ae5d9c5b35218c76bdeefd4e54d7310643d1`; додаткових залежностей із develop немає. Збережено наявну діагностику health із main.

`node scripts/build.ts` → 0. Unit GREEN `9590831b-aa0e-488c-bee4-6fc8968836f1`: 14 файлів, 430 pass, CLI/child 0, timeout false, cleanup complete, knownRed/unexecuted/unknown порожні. Це явний відбір без одного baseline-файлу, а не твердження про GREEN усіх початкових 15 файлів.

Real-copy integration GREEN `d4baa0b1-e833-44ec-a818-98fdd05875cb`: CLI/child 0, 1711 repository-сценаріїв, 12590 вимірювань, max rowsRead=50. Схеми state18/bug2, sessions159, reminders378, bugs1698; backup та integrity пройшли. Test-run scopes у знімку0; синтетична unit-регресія перевіряє180 груп. Джерела `/srv/dev/raf-guard-copy-20261105` не змінено й не комітовано. Повні санітизовані метрики — `../qa-2.40-hotfix-real-copy/integration-green.scenarios.json.gz`.

Власні RED → fix → GREEN:

- Health `sqlite:1160ca8a7fed4733`, `src/health-summary-storage.ts:43`, 51/50: заміна scan sqlite_master на PRAGMA конкретної таблиці. Окремий assertion RED `167bfe95-13b7-4a14-bb30-10ffeb6d58a3`.
- v16 DROP `sqlite:47e3834c4481c669`, `src/state-store.ts:439`, 53/50; INSERT `sqlite:9a69e031fb0ca924`, там само, 120/50. Окремий assertion RED `f6bb5158-8413-42dc-aae6-0c21623dc68c`. Копіювання — keyset50 і точкові INSERT. DROP отримав чинний локальний бюджет512 для фіксованого DDL-каталогу, як ALTER RENAME, з обґрунтуванням у metadata; глобальна межа50 незмінна. Перевірено збереження0/120 резервувань, integrity і кожне вимірювання в межі запиту.
- Fixture часткового SQLite header відновлює файл через r+, без проміжного truncate до нуля; початкове падіння та наступний GREEN збережено.

Усі8 lazy-bootstrap падінь повторено на чистому `63902948`: run `1912a0be-fdb6-4ea4-8616-cdb692c4bc63`, 231 pass/8 fail. Код CLI, production-entry та цей тест у кандидата не змінені. Main записав окремий hotfix `fix-raf-lazy-bootstrap-catalog` у Git `c69067fd37c5cd7e25408f806ddfd7cc61eaa7ab`; задачі дослівно: «Відтворити 8 lazy-bootstrap падінь raf-main (baseline 63902948, run 1912a0be): 2 missing/corrupt catalog → `conf/raf-constants.json`, 6 fixture `guardMock` без `admitStateStore`». Початкові failed не приховано й не названо GREEN.

Моя помилка ізоляції: outer conf був симлінком; migration fixture скопіювала симлінк і записала спільний projects.json. Main відновив HEAD. Я прибрав симлінк та створив фізичну приватну копію conf; наступний успішний unit використовував її. Спільний projects.json не має моїх кінцевих правок. Перерваний запит без TestRunResult не зарахований; перед продовженням main підтвердив відсутність pending/active child на host.

`regression.json` містить точні14 файлів та executable/args для regression gate `verifyHotfixCandidate`. Integration виконано окремо: вона пише санітизовані докази, тому її не потрібно додавати до regression gate запечатаного snapshot. Файл lazy-bootstrap виключено лише через доведений baseline та окремий hotfix main, без послаблення assertions.

`qa.json` містить сценарії, findings, followUps і команди. Повні незмінені `*.TestRunResult.json` збережено окремо від CLI-кодів та отриманих capture stdout/stderr. Інструмент повертає об'єднаний потік, іноді обрізаний; це явно позначено, відсутність stderr не припускається. SHA256 виконаних src/scripts/test і patch unit-стану збережено.

Активацію виконує main. Після неї потрібне first-execution робочого runtime. Цей доказ охоплює repository читання, а не public CLI reconciliation/delivery із живими процесами. Проксі max(returnedRows,FULLSCAN_STEP+1) не вимірює всі indexed visits. Робочий main/prod ще не перевірено; 2.40 залишається відкритим.
