# 2.47 — видалення SQLite read guard

Область: raf-hotfix, базова ревізія `157f7d74709378d0ec063d70e45e12377ff7429d`, власні незакомічені зміни з `workspace.json` і `implementation.patch`. Нові файли мають SHA256 у manifest; перевірювана фінальна ревізія — коміт, який містить ці докази. Після фінального GREEN прибрано лише порожні рядки після видалених guard-викликів/assertions.

Аудит: початковий proposal суперечив новому охопленню, але tasks.md «Охоплення лише Cloudflare» містив дослівне рішення власника від 2026-11-07 і явний пункт 2.47. Main повідомлено receipt `f290d675-6130-4d40-8e05-5c0e5f061710`; перетинів немає, src/test-runs.ts не зачеплено. Перед завершенням proposal повторно прочитано: 2.45 вже прибрав SQLite raf з охоплення. Інші пункти, зокрема 2.48 і 9.1, відкриті; архівація не застосовується.

Видалено src/database-read-limit.ts, усі guardDatabase/withDatabaseReadQuery виклики, окремі обробники DB_ROWS_READ_LIMIT_EXCEEDED, guard-only тести й скрипт вимірювання. Нативні DatabaseSync.prepare/exec/createTagStore не підміняються продуктом. Індекси, адресні вибірки, підтримувані агрегати та keyset-запити споживачів збережено. Загальні iterateDatabaseTable/readDatabaseTable перенесено в src/database-table.ts; розмір сторінки 50 збережено як параметр пагінації, без відмови для більших читань. Метрики для регресій ефективності є лише у test/database-read-observer.ts, без перевірки межі чи помилок guard.

## Поведінка

Точні команди, runId, selection, CLI exit і child exitCode, timeout/cleanup, knownRed/unexecuted/unknown, groupState і nextAction — у runs.json. Оригінальні TestRunResult скопійовано без зміни з названих raf tmp-файлів. CLI-результат і отриманий stderr збережено окремо в *.cli.json і *.stderr.log. Інструмент об’єднав stdout/stderr та обрізав текст; це явно позначено, повні TestRunResult не обрізані. UUID назви tmp-файла відрізняється від runId усередині JSON.

- RED: assertions-failed, 4 цільові падіння (state/bugs: 120 > 50 та підміна нативних методів), 1 passed. Setup/import failure немає. Первинний файл регресії — red-regression.ts.txt; код продукту тоді відповідав базовій ревізії.
- Перший hotfix: 559 passed, 2 падіння старої fixture міграції через toVersion:18. Виправлено fixture на чинну STATE_SCHEMA_VERSION; кількість збережених reservations та PRAGMA integrity_check перевіряються й надалі. Видалено assertion про винятковий бюджет DDL, оскільки сам контракт guard скасовано.
- Фінальний hotfix тієї самої групи limit-db-rows-read-per-query/raf-remove-guard: 561 passed, 0 knownRed/unexecuted/unknown; complete/complete; timeoutCount 0, cleanup complete.
- Регресія fix-raf-test-run-selection-aggregate/completed-cleanup: 2 passed; speed-up-raf-cli-commands/latency: 6 passed. Обидві групи complete, timeout немає, cleanup complete, залишок порожній. Групу latency відновлено у реєстрі для наявного файла, оскільки адресної групи там не було.

Runner надав ізольований QA HOME; той самий HOME та група зберігалися між RED/GREEN. Попередження DB_ROWS_READ_LIMIT_EXCEEDED у stderr походять з чинного raf-main-b/src/archive-events-runtime.ts хостового runner, не з кандидата. Активацію/push виконує main окремо; ці докази не стверджують активації.

Реєстр conf/test-runs.json оновлено in-place, main отримав повідомлення receipt `508f9eb2-4dfb-466c-ace4-cb64488079cd` і взяв його коміт. Секція «Перевірка 2.47» у tasks.md була включена паралельним комітом raf; власних checkbox-комітів немає.

## Самоперевірка читабельності

Переглянуто весь зачеплений код від базової ревізії до власних правок manifest, без вимоги переробляти сусідній код.

- src/database-table.ts:iterateDatabaseTable/readDatabaseTable — один власник keyset-пагінації. Вхід database/table/after явний; rowid задає наступну сторінку, statement закривається у finally до yield, завершення визначає неповна сторінка. Перенесення повне, дубля/сумісної guard-обгортки немає. Регресія перевіряє 121 рядок із пропусками rowid та відновлення з курсора.
- src/state-store.ts:openStateStore, src/bug-store.ts:openBugStore, src/main-version-compatibility.ts і src/state-migration.ts — з’єднання створюються напряму, DDL міграції v16 читається як прямі db.exec. Прибрано обгортки з прихованою зміною методів. Потоки транзакцій, резервування backup та закриття ресурсів збережено; міграційні/compatibility та state/bug тести зелені.
- Зачеплені функції startup-context, health-*-storage, forced-close-metrics, resource-usage*, bug-attachment-cache, archive-events-runtime, agent-queue-state, test-run-runtime і test-run-queue-priority: видалено лише установку guard/особливу обробку його помилки або змінено адресу спільного table-reader. Основна відповідальність, дані й побічні ефекти залишилися явними.
- test/database-read-observer.ts:observeDatabaseReads/recordRead та prepare instrumentation — лише тестовий компонент збору SQLite stat. Явні окремі all/get/run послідовності: reset, нативний виклик, запис метрики, повернення результату. AsyncLocalStorage визначає область спостерігача; перевищення нічого не перериває. Тести індексів і latency використовують реальні метрики, їхні перевірки ефективності збережено без runtime guard.
- test/database-unrestricted-reads.test.ts: state/bugs сценарії явно створюють fixture, читають і змінюють 120 рядків усіма основними шляхами, перевіряють нативні методи та звільняють store/tmp у t.after. Решта тестових змін — нова адреса observer/table-reader, вилучення скасованого limit metadata, збереження предметних результатів та перевірок індексів.

Предметних порушень читабельності у власних правках не залишено. node scripts/check-comments.ts і git diff --check завершилися з кодом 0. Перевірки поведінки: 561 + 2 + 6 passed; вимірювання query plans/ефективності збережені, нових обмежень чи користувацьких елементів не додано.
