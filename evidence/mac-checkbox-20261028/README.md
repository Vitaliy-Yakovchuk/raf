# Mac checkbox hotfix, 2026-10-28

## Причина

На ef815c6f записувач `rows()` захоплював перший токен після checkbox буквально: `3.`/`4.`. Snapshot має `3`/`4`: OpenSpec 1.14.3 повертає позиційні ID та опис, що починається `3. `/`4. `; `assignment.tasks()` залишає цей ID, бо крапка перед пробілом не збігається з його шаблоном явного ID. Preflight записувача пропускав рядок як відсутній, не створював operation/commit, потім production `verifyAssignmentCompletion()` відхиляв звіт як «Пункт 3/4 досі відкритий».

- `original-rejections.json`: read-only витяг двох справжніх agent.report-rejected з result_notices робочої SQLite.
- `diagnosis.json`: історичні tasks до ручної галочки main; SHA256 записувача бази та фактичного покоління збігаються.
- `openspec-source.*`: справжній CLI OpenSpec підтверджує ID 3/4 та опис із крапкою. Поточні ручні галочки main не редагувались.
- `red.*`: два assertion failures саме «Пункт 3/4 досі відкритий», commits=[] та попередження про відсутній ID. Це відтворено в ізольованому реальному Git без паралельного автора; збій виникає до запису/коміту, а не через push чи гонку індексу.

## Зміна

Лише нормалізація токена цілого числа з кінцевою крапкою у `rows()`. Повний matched рядок, byte offsets, опис, CRLF і commit/index/recovery протокол збережені. Нових обмежень або таймаутів немає.

Регресії використовують production completion verifier із відповіддю OpenSpec заданого формату та реальний Git. Для 3 — LF; для 4 — Unicode/CRLF і чужий commit між побудовою кандидата та CAS. Перевіряються точний marker-only commit, HEAD/index/worktree, незмінні сусіди 3.2/30, збереження чужого commit та повтор без дубля.

## Перевірки

- RED, commit тестів 91d00c32: 2/2 цільових assertion failures.
- GREEN незмінних тестів: 2/2.
- `regression.*`: 70/70 checkbox-report/git/index, Z440, Z430, Z3939. Є штатні RAF_GIT_CALLS warnings, результат exit0.
- `build.*`: npm run build exit0 після npm ci з lock-файла (TypeScript 6.0.3).
- `cli-help.*`, `runtime-import.*`: exit0.
- `fixture-setup-failed.*`: перша помилка canonical temporary root на macOS, не зарахована RED; fixture виправлено realpath до цільового RED.
- `build-missing-dependency.*`: початковий missing TypeScript, не зараховано успішною збіркою.

Кожний прогін має повний stdout/stderr і фактичний exitCode в сусідньому result.json. raf_command/TestRunResult недоступні за прямим дорученням; наведені інтеграційні Git-перевірки виконані прямо node:test. Неперевірені тести не названо пройденими.

Публікація та застосування фіксуються окремо у `/Users/val/.raf/mac-start/20261028/artifacts/raf-mac-checkbox/`, фінальний статус — `/Users/val/.raf/mac-start/20261028/reports/raf-mac-checkbox.md`.
