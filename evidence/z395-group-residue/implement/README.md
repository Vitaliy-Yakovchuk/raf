# Z.395.3 — незалежна реалізація

Доручення: `complete-raf-flow-contracts:Z.395.3`. Передумова Z.395.2 підтверджена в tasks.md: final-red `13d1b385-c811-43ff-bcba-088d8e4b8533`, 13 assertion-red та 16 green, timeoutCount 0. Предметний контракт актуальний; групу `complete-raf-flow-contracts/z395-group-residue` задають доручення та запис main у tasks.md від 2026-10-25. Старі команди `add-raf-test-run/unit` у дизайні не використані.

`initial-implementation.json` фіксує завершення незалежної початкової реалізації, її diff і fingerprint до першого читання підготовлених тестів. Після цього прочитано `test/test-run-group-residue-z395.test.ts`; тест не змінено. Уточнення після читання: exact ID, що залишається knownRed, не додається повторно до unexecuted.

Змінено тільки production-файл `src/test-runs.ts`:

- Події unit-runner перевіряються за фактичними files та exact testIds до імпорту фактів. Позавідбірні ID дають protocol/setup failure.
- Попередні knownRed/unexecuted очищує лише підтверджений pass: нормальне завершення, валідний повний протокол, відсутність setup failure та повний cleanup. Наявний removed використовує ті самі умови й лише повністю зібрані вибрані файли без `--only`.
- Зелений child із попередніми knownRed зберігає ненульовий результат групи, отримує `confirm-known-red` і очищену адресну діагностику без історичних assertion messages.

Ключ, SQLite, timeoutCount, recovery, profile/authorization/overlap/inFlight порти збережені; reset, інша HOME, друга історія чи автоматичний запуск залишку не додаються. Попередження main про майбутнє злиття hotfix Z.424 враховане мінімальним локальним diff без переформатування.

`before-run.json` містить точну дозволену команду, SHA/dirty snapshot, diff та SHA-256 джерел і конфігурації. Артефакти `run-*.transport.*` зберігають доступний транспорт і метадані CLI; `run-*.result.json` — незмінений JSON TestRunResult; `run-*.stderr.txt` — доступний stderr із явно описаною межею атрибуції. Підсумковий `summary.json` містить результат і межі доказу.

Unit не закриває реальний SQLite/runner/CLI стенд Z.395.4. Галочки дорученого пункту ставить raf; інші відкриті пункти не виконуються, архівація не застосовується. Push не виконується.
