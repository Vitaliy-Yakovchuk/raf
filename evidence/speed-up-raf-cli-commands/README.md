# speed-up-raf-cli-commands:1.1

Виправлено виклики OpenSpec на боці raf без винятку бюджету `agent run < 3000 ms`: назви архівів читаються через readdir; початкова перевірка доручення не дублюється; незмінні перевірені вхідні файли повторно використовують результат OpenSpec instructions. Читання файлів, schema/version, ідентичність каталогу, захист від symlink/race та повторна перевірка після ресурсного очікування збережені.

Інші знайдені витрати: повне читання завершених сесій для кожного повідомлення, зайві копії archive snapshot, повторні tmux-процеси, компіляція графа worker та послідовний пошук посилань у 178 MB файлів активних змін. Великі скани розподіляються між потоками за кількістю доступних CPU; для малих наборів лишається звичайне читання. Літеральність, перекриття, вкладені ключі та Unicode перевірені окремим тестом. Нових продуктових таймаутів, обмежень чи видимих статусів немає.

## Регресія

Команди виконувалися через виданий порт, з незмінним `--group speed-up-raf-cli-commands/latency` та QA HOME `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`.

- RED: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase red --group speed-up-raf-cli-commands/latency --files test/cli-latency.test.ts`. `red.TestRunResult.json`: справжні assertion failures (40 сканів, reminder 981 ms, ps 1622 ms), а не setup/import failure.
- Додаткові RED запуску й повторного парсингу: `red-launch-3s.TestRunResult.json`, `red-parse-once.TestRunResult.json`. Файли відбору й точні assertion IDs містяться у повних результатах. Початковий stderr цих старіших запусків збережений лише там, де є відповідний cli-артефакт; відсутню окрему копію не відтворювали з пам’яті.
- Фінальний відбір: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group speed-up-raf-cli-commands/latency`.
- `latency-final.TestRunResult.json`, runId `e1f5b7ed-53bb-45ed-bebf-290fa4232747`: **167 відібраних тестів пройшли, child exitCode=0**, cleanup complete, timedOut=false, unknown=[]; власних knownRed немає. Перевірені фактична нативна tmux-панель, UUID runner, доставка brief/повідомлення, захист HOME та перехід у finished. `agent close` виміряно після підтвердженого завершення runner.

| Команда | Фінальний тест, ms | Твердження бюджету, ms |
|---|---:|---:|
| reminder list | 284.529 | < 500 |
| agent ps | 611.505 | < 1000 |
| agent run | 2624.759 | < 3000 |
| agent message | 953.140 | < 3000 |
| agent close | 615.308 | < 3000 |

**Увесь агрегат latency не є PASS:** незмінений результат має outcome=assertions-failed, CLI exit=1, groupState=idle, nextAction=fix-implementation через 13 сторонніх knownRed (`production-launch-integration.test.ts`, `qa-tmux-stale-socket.test.ts`) та один старий unexecuted ID у production-launch-integration. Обидва сторонні файли виключені з налаштованого відбору; агрегат, назву групи та QA HOME не скидали. Ці записи не названі виправленими або успішними й не входять до доручення 1.1.

Окрема регресія стану: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-test-run-selection-aggregate/sessions-address-index`. `state-final.TestRunResult.json`, runId `43193082-2d90-4a69-8b66-f49f3500aae7`: **85 passed, outcome=passed, CLI=child=0, groupState=complete, nextAction=complete**, knownRed/unexecuted/unknown порожні, cleanup complete, без timeout. Чужу зміну до tasks не додавали.

Повні TestRunResult скопійовані байт у байт з названого raf tmp-файла. `*.cli.json` зберігають повну відповідь виконавчого інструмента; `*.cli.exit.txt` — CLI exit окремо від child exitCode у TestRunResult. `*.cli.stderr.txt` отримані з об’єднаного потоку інструмента вилученням JSON-рядка stdout; це не окреме OS-захоплення stderr. Обрізання відображення інструментом не підміняє повний JSON-файл. `test-runs-index.json` містить SHA256 і фактичний стан кожного збереженого результату.

## Копія живого стану

`scripts/profile-cli-latency.ts` використовує ізольовану QA-фікстуру: readonly SQLite backup, копії conf/openspec, справжні OpenSpec 1.14.3 і tmux та синтетичний task runner. Вихідний snapshot: `/tmp/srcc-profile/root`, `/tmp/srcc-profile/live-copy.sqlite`; **335 сесій, 132 зміни, 1351 архів, 402 result notices**. У приватній копії історичні процеси завершені, claims/queues очищені, повідомлення адресовані неактивному fixture-одержувачу; реєструється власний живий main. Ресурсні пороги лише цієї фікстури малі, щоб профілювати успішний запуск незалежно від навантаження хоста; production conf не змінено. Cleanup завершений, error/cleanupError відсутні у наведених успішних профілях.

Команда профілю: `HOME=/tmp/srcc-profile/qa-home RAF_QA_HOME=/tmp/srcc-profile/qa-home node scripts/profile-cli-latency.ts <artifact> --snapshot-root /tmp/srcc-profile/root --snapshot-state /tmp/srcc-profile/live-copy.sqlite`. Baseline додатково має `--before 407ce9b5349ddb872424b7786bfe9a7e0602560f`; він замінює власні змінені production-файли у приватній копії, використовує той самий harness та вхідні дані. Це профілювання, а не підміна unit-прогону.

| Команда | matched-before.json, ms | matched-after.json, ms |
|---|---:|---:|
| reminder list | 816 | 535 |
| agent ps | 949 | 500 |
| agent run | 23424 | 2725 |
| agent message | 1198 | 687 |
| agent close | 1015 | 629 |

`lazy-runtime-after.json` з тим самим фінальним кодом: reminder 489 ms, ps 465 ms, run 2808 ms, message 598 ms, close 472 ms. Один замір reminder на живій копії перевищив ціль 500 ms; його збережено, бюджет тестів не підвищено. Всі п’ять команд в обох фінальних профілях exit=0. `threaded-scan-profile.json` показує розклад: reference scan 164 ms замість 504 ms у `parallel-reads-live-trace.json`. Графи stage self/child/worker перекриваються, їхні суми не є загальним wall time.

Решта JSON — проміжні досліди. Файли з error/cleanupError, setup failures або падіннями бюджету не є доказами успіху; ранній `final-selected` зі старим винятком бюджету не є фінальним GREEN. `validated-workspace.json` називає HEAD і SHA256 фінальних незакомічених вихідних файлів. Точні проміжні patch-стани окремо не фіксувалися.

Додатково пройшли `node scripts/check-comments.ts`, `node scripts/build.ts` з ізольованим QA HOME та `git diff --check`.

## Передача документів

Власні root-документи proposal.md, tasks.md та .openspec.yaml записані без зміни галочки 1.1. Root `git add -f` відхилено: `fatal: Unable to create '/srv/dev/work/orchestrator/.git/index.lock': Read-only file system` (128); `commit --only` не зміг включити незареєстрований .openspec.yaml (1). Точний патч — `orchestrator-documents.patch`; підготовлено для main через agent message. Першу багаторядкову команду канал відхилив до доставки, після читання парсера патч надіслано однорядковим JSON-рядком. Однорядкова доставка завершилась MESSAGE_NOT_ACCEPTED (completed=[], identity changed); актуальну адресу main перевірено через agent ps перед повторною передачею. Фактичний receipt/помилка зберігається окремим доказом доставки. Активацію main не виконували.
