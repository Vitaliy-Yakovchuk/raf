# fix-raf-missing-disk-estimate:1.1

Аудит: дефект актуальний на 216e435f8a30d8ac796990b8dd60505cad389a75. `production-runtime.resolveTask` формує попередній ключ `dev:<stat.dev>`, тоді як `reserve` вимірює файлові системи через `df` і повертає повний `admission.reservation.requested`. Після 216e435f черга передавала попередній `validation.requested`, тому resource-wait не знаходив оцінки під виміряним ID. Чинні resource-wait та resource-admission вимагають повної оцінки, очікування при достовірній нестачі і повторного резервування після permit; суперечностей із proposal немає.

Виправлено лише передачу requested: використовується останній admission (включно з повторним очікуванням після resource race). Розрахунок оцінок, перевірка UNKNOWN, пороги й повторне резервування залишаються чинними. Non-null requested гарантований попередньою перевіркою admission.level !== UNKNOWN.

Регресійний тест спочатку додано й запущено без виправлення: assertions-failed саме для нової перевірки виміряної оцінки замість provisional device IDs, 57 інших тестів passed. Після однорядкового виправлення 58 passed; налаштована група fix-raf-launch-queue-stall/queue — 210 passed. Тест перевіряє повний requested для двох файлових систем та оновлену оцінку другого очікування. Setup failure і таймаутів немає; усі cleanup complete, залишки порожні.

`runs.json` містить точні команди, runId, відбір, код CLI окремо від child exitCode, результат, cleanup, timeout і стан груп. Повні незмінені JSON TestRunResult та stderr збережені окремо; tool-result зберігає повну відповідь інструмента. Обрізання немає. QA HOME однаковий у трьох прогонах і задається raf test run; код поза ним не запускався. Patch/status файли фіксують незакомічений стан від базового SHA. `node_modules` — початковий чужий untracked шлях, до коміту не додається.

Групу зареєстровано адресно у conf/test-runs.json, автоматичний коміт orchestrator: 252b2b60905b85ca32136af856d7b8773ea5047b (conf: agent test group registrations (auto)); це не власний коміт виконавця. Tasks доповнено лише командами, checkbox 1.1 встановлює raf. Пункт 1.2 належить main, активація та archive цим дорученням не виконуються.
