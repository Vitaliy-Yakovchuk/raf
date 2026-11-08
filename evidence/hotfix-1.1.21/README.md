# Hotfix 1.1.21

Аудит: пункт актуальний, CommonJS eval Worker викликається з великих активних OpenSpec-дерев через pruneArchivedChangeTestGroups. Production launcher у src/production-runtime.ts передає --input-type=module, успадкований Worker. Видалення шляху втратило б чинне паралельне сканування; виправлення замінює лише два require на статичні ESM-імпорти.

Спочатку звичайний виклик scanner пройшов (initial-baseline). Тест уточнено до фактичного production-контексту --input-type=module до зміни production-коду. RED: assertions-failed із require is not defined in ES module scope, не setup/import failure. Після фіксу GREEN: 5/5, обидва файли групи, включно з великим скануванням і архіваційним збереженням посилань. Новий тест перевіряє також порожній stderr, вкладені, буквальні, Unicode ключі та пропуск відсутнього файла.

Повні незмінені TestRunResult: initial-baseline.TestRunResult.json, red.TestRunResult.json, green.TestRunResult.json. Команди, SHA, незакомічені зміни, runId, відбір, CLI/child exitCode і стан групи: runs.json. Усі прогони використовували той самий ізольований QA HOME. Timeout відсутній, cleanup complete, GREEN knownRed/unexecuted/unknown порожні, nextAction complete. Результати не означають активацію main чи живий повтор agent run.

Stderr збережено окремо в *.stderr за видимим виводом CLI (для baseline/red відновлено ті самі спостережені рядки попереджень і шлях результату). Повні JSON копіювалися з оголошених RAF файлів; результат не залежить від можливого обрізання відображення CLI. Сторонні попередження конфігурації etchly/stitchly не належать цьому дефекту.

Самоперевірка читабельності: scanner зберігає одну відповідальність і той самий потік даних paths/keys → found → parentPort; зміна завантаження залежностей явна, без нових станів, режимів, обмежень чи приховування помилок. Регресія явно створює два файли, запускає реальний ESM процес, перевіряє результат та прибирає власну фікстуру. Предметне приймання: початкова помилка усунена, семантика великих сканувань збережена 5 тестами. git diff --check успішний.

Документ tasks.md: власний коміт у корені Orchestrator недоступний, CLI 128: fatal: Unable to create '/srv/dev/work/orchestrator/.git/index.lock': Read-only file system. Точний патч tasks.patch передано main разом із реєстрацією групи (вже внесена in-place); доставка accepted, receiptId f6c26b14-5c67-432a-b4d0-07a495d0af77. Main комітить реєстр і документ; ці коміти не є власними. Галочки не змінено; інші задачі відкриті, архівація не застосовується.
