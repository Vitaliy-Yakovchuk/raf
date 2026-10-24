# complete-raf-flow-contracts:Z.411

Виправлення: production-служба зберігає стан сесій і не виконує підтвердження звітів, відновлення reservations або фіналізацію запусків. Ці операції залишаються у командному/worker flow. Відновлення й наступні refresh служби більше не залежать від вичерпаного бюджету підтвердження звіту.

Writer lock відстежується за device/inode відкритого файла. Нормальне очищення, shutdown служби й синхронний exit handler прибирають лише цей файл; заміна стороннім writer зберігається. Перед публікацією індексу перевіряється володіння. Помилка startup спочатку надсилає власному child SIGTERM і чекає виходу; SIGKILL залишається fallback після cleanup grace, обмеженого наявним readinessTimeoutMs. Це не поновлює budget readiness.

## Перевірка

- Стала група `complete-raf-flow-contracts/z411`, той самий ізольований QA HOME у всіх прогонах; точні команди та відбір — [manifest.json](manifest.json).
- Перший запуск відмовив через неповний інвентар, наступний — через ресурсне навантаження. Вони не вважаються red.
- Перший виконаний red відтворив writer lock assertion failures, але S02 виявив неточний шлях fixture. Після виправлення fixture, без зміни production-коду, повторний red `2daa0402-d816-4fda-a5d9-28820a2b1e73` підтвердив три assertion failures: readiness, timeout lock, exit lock. [Повний результат](red.stdout.json).
- Hotfix `88014f0d-78a9-4e1f-aff9-482953eef062`: 6/6 passed, `knownRed=[]`, `unexecuted=[]`, `unknown=[]`, `groupState=complete`, `timeoutCount=0`, `cleanup.complete=true`, `timedOut=false`, `nextAction=complete`. [Повний результат](hotfix.stdout.json).
- Контрольні сценарії: закриті/прийняті запуски не перечитуються; звичайний stop очищає lock; стороння заміна lock зберігається; перерваний writer не публікує індекс.
- `node scripts/build.ts` і `git diff --check`: exit 0.

JSON TestRunResult збережені без змін. Для виконаних red і hotfix файли `*.stderr` містять точний stderr, а `*.cli.json` — код CLI й розміри потоків; child exitCode залишається у TestRunResult. Розміри перевірені. Початковий inventory refusal має окремо задокументовану відсутність stderr; він не використовується як доказ виконання тестів.

[workspace.json](workspace.json) містить SHA-256 точних власних source-файлів, patch і snapshot нового helper. Hotfix перевірений на HEAD `53f3c90a89710018dccbbab5edf8167d0165b2dc` із незакоміченим власним виправленням, яке згодом стало комітом `12152fba33fe2c16fde0dd2a5ccf4e0b8785d1f8`. Для red записано source-equivalent SHA та обмеження реконструкції HEAD зі спільної історії.

Вимоги звірено з proposal, Z.411 та повною вимогою background-runtime щодо належності report acceptance командам/воркерам. Живу службу виконавець не запускав і main не активував. Галочку Z.411 ставить raf після прийняття звіту; архівація не виконується, бо в зміні залишаються інші відкриті пункти.
