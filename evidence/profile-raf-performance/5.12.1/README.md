# profile-raf-performance:5.12.1

Виконавець: raf-prp5121-hotfix; запуск 75029cfc-4f23-401e-a86e-8325c9d8cffb.
Результат доручення: **failed**, із виправленою реалізацією та 48/48 passed у дорученій основній регресії. Повного passed групи немає: CLI 1, outcome setup-failed через окремий Darwin-only live-тест. Галочки tasks.md не змінено; інші пункти зміни відкриті, sync/archive не виконувався.

## Аудит і авторизація

Коміт 841133ee945343b72400008045b591d3e9f7e1c6 є предком робочого HEAD.
Прочитано proposal Why/What Changes/Non-goals, вибраний tasks 5.12.1 та Джерела за етапом, core/process/test-first і unit-test-runs, add-raf-test-run delta test-runs, conf/briefs/README.md («Чужу unit-регресію»), застосовні autonomous-development/parallel-development та agent-report delta щодо retry/deadline/source freshness.

Приклад red у tasks суперечить правилу чужої регресії: initial-red чужої групи не надається. Виклики виконано з phase hotfix за кінцевою декларацією regressionGroups і підтвердженням main у цій сесії. Source: profile-raf-performance:5.12.1; target: complete-raf-flow-contracts/z393. QA HOME/state/tmp з TestRunResult збережено незмінними; SQLite не редагувалась і не читалась напряму.

Початкові п'ять файлів відхилено до spawn: GROUP_RENAME_REFUSED, runId dce5f958-b8d1-4705-a86b-9d6949680de2. report-confirmation-retry.test.ts уже належить z39398. Main адресно виключив цей файл із відбору; його **не перевірено**, z39398 не запускалась, групи не узгоджувались вручну. Main повідомив, що оформить follow-up із потрібним grant.

## Test-first і виправлення

До зміни коду два прогони підтвердили assertion у test/report-confirmation-runtime.test.ts:52:
runtime watcher retries a typed source race and busy writer without a file event.

Перший дозволений відбір чотирьох файлів: 47 passed / 1 knownRed, CLI 1 / child 1, assertions-failed (2c068685-58d3-40e2-9c1f-5158fe3ccf44).
Наступний адресний --only того самого knownRed підтвердив те саме падіння без зміни коду (5e5aca95-d180-4a67-aa09-a90872eb665d).
Це assertion failures, не setup/import і не первинний foreign --phase red.

Кожний fresh report read повторно викликав validAgentReport → loadCompiledCatalog → читання та JSON.parse dist/catalog.json (281985 байтів). Одна спроба виконує багато таких читань у межах 40ms тестового transition. readRetryReport тепер отримує локальний validationContext з одним compiled catalog до початку циклу та повторно використовує його для schema/status і result event. Ін'єктований request.catalog збережено. Глобального кешу немає; новий readRetryReport знову отримує свій catalog. Перевірки байтів JSON, source identity, current run, journal і Git ancestry не кешуються; configured deadlines/pollMs не змінені. Тести не змінювались.

Після виправлення: усі 48 тестів чотирьох файлів passed, child 0, knownRed [], unknown [], diagnostics [], cleanup.complete true, timedOut false; runId 0d136ec6-f974-492b-b3f1-5f8e1ba29bbb. Включно з core regression: a stable assignment mismatch after exhaustion cannot be accepted using an earlier source check.

Wrapper **CLI 1 / setup-failed**, а не passed: агрегат зберігає unexecuted:
test/assignment-identity-qa.test.ts::[identity-qa-live] actual ordinal task labels retain exact identity through completion archive and name reuse.

Main доручив рівно один додатковий прогін assignment-identity-qa.test.ts у тій самій групі. Він дав 3 passed, child 0 / CLI 1, setup-failed, runId d977fbb9-d4f4-41ee-a862-69647a323fe4. Той самий live ID лишився unexecuted: test/assignment-identity-qa.test.ts:77 явно skip на не-Darwin і вимагає filesystem type 26 (:83–84). Linux не підтверджує цей сценарій. Пропуск/очікування тесту не змінено, повторів немає.

Фінальний стан: timeoutCount 0, groupState idle, nextAction fix-setup, knownRed [], unknown [], unexecuted [Darwin-only ID]. Це не unit timeout exception. Main має розділити/узгодити platform-specific перевірку й окремо доручити retry file з правильним grant. Повний green групи не заявляється.

## Workspace і докази

refused, baseline, isolated-baseline: HEAD 0cbb10f1c84fa1d8460884c3bc7eb5755578c950.
Під час red у спільному дереві були чужі незакомічені cli/bootstrap/test-run правки; їх не змінював і не комітив.
Hotfix та inherited: HEAD f67ea61e52f0cae33025c49e0d5d2167c107587f з власним незакоміченим src/agent-report.ts (точний diff у tested.patch) та evidence. Спільний HEAD просунув інший виконавець о 04:52:37 UTC, після isolated-baseline (04:51:33) і до hotfix (04:53:01); це підтверджено git reflog. node_modules — наявний чужий untracked шлях.

Кожний *.stdout.json — повний незмінений публічний TestRunResult; *.stderr — stderr черги, *.cli-exit-code — код CLI, окремий від JSON exitCode дочірнього runner. *.tool.json зберігає незмінений результат інструмента з combined output. Канал цього покоління віддає потоки через legacy replay й видаляє його файли після читання; durable manifest у tmp відсутній. JSON і queue stderr розділено за фактичними повними рядками CLI, без обрізання, переказу полів чи відновлення зі SQLite. Caller-generated manifest.json містить команди, контекст і контрольні суми збережених байтів; він не видається за довірений host manifest.

git diff --check → 0. Нові коментарі не додавались. Повний build і додаткові unit-групи не запускались: вони не входили в доручення 5.12.1. Push/activation не виконувались.

Повідомлення main через agent message про baseline доставлено (receipt 779f73f1-e28b-4f67-9cc1-778399a42565); частина наступних спроб повідомлень відхилялась HANDLER_FAILED: Recipient composer contains unrelated input. Підсумок про фінальний Linux skip та затримку коміту через чужий index.lock доставлено (receipt 4db0235a-0d14-41c0-82b8-37e7d6dd8c48). Чужий lock не видалявся; перед повтором порту перевірено, що він зник. Директиви main про відбір отримано в цій сесії й виконано; недоставлені повідомлення не названо доставленими.
