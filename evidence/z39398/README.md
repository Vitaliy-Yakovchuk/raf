# Z.393.9.8 — deadline після checkbox-коміту

Виконавець: raf-z39398-hotfix. Зміна: complete-raf-flow-contracts, лише Z.393.9.8.

## Причина та межі доказу

`createAssignmentIdentityAdapter.readSource` вже кешував авторитетний розбір незмінних захищених входів, але перевіряв кеш ПІСЛЯ subprocess `openspec --version`; стандартний executor також виконував `schema which`. Перевірка identity повторюється перед repair, checkbox, final-check, accept і всередині перевірок запису/остаточного приймання. Тому після готового checkbox-коміту кеш усував `instructions apply`, але не повторну вартість запуску CLI. Автоматичний наступний цикл починає ті самі gates заново з тим самим transition budget, тому постійна вартість спричиняла starvation, а не одноразове очікування. Сам checkbox-коміт не доводить проходження наступних gates.

Unit-відтворення використовує справжній тимчасовий Git, launch commit context, executor commit, checkbox-коміт та journal, звірку комітів/індексу і durable freshness. Час OpenSpec моделюється постійною вартістю КОЖНОГО виклику, а не одноразовою затримкою; transitionMs береться з чинного codex protocol (10000 ms), нових production-лімітів немає. S01/S02 задають 10%/13% бюджету на subprocess і 16% на completion. До виправлення обидва тричі поспіль завершуються stage=accept, cause=deadline без acceptance. Це відтворений механізм дефекту. Історичні run directories зі вхідного доручення недоступні цій sandbox-сесії: їхні точні wall-clock розклади та stage=final-check окремо не відтворено. Наведені у дорученні run IDs не видаються за заново перевірені live-запуски.

## Виправлення

Коміт `10c49f193e27768f4eee8ea47571ad1e0d30a7cf` переносить cache-hit перед CLI startup checks лише після свіжого guarded читання всіх входів. Стандартний executor додатково заново перевіряє canonical schema path і точний schema content hash. На cache-miss знову перевіряються OpenSpec 1.14.3, schema resolution і авторитетний apply. Source identity, input digest, race guards, SHA/index/report freshness, всі етапи confirmation та deadline залишаються чинними. S03 забороняє reuse після зміни опису задачі; S04 вимагає supported version після зміни parser input.

## Прогони

Команди, повний незмінений `TestRunResult`, CLI-код окремо від child exitCode, stderr і повний transport envelope лежать у файлах із відповідним префіксом. Транспорт exec_command об'єднує stdout та stderr: перший рядок — TestRunResult, залишок — stderr. У hotfix stderr містить тільки `launch-queue.waiting`, запис якого підтверджено у src/test-run-queue-runtime.ts:112 та src/test-run-reservations.ts:171. Envelope збережено без змін у cli.json; порожні stderr мають нуль байтів.

| Префікс | runId | Результат | CLI / child | Group / nextAction |
| --- | --- | --- | --- | --- |
| red-preflight | 58b635ad-b766-4c44-89ed-cbab7b9a4834 | setup-failed, CONFIGURATION_INVALID до spawn | 1 / null | unavailable / fix-setup |
| red | 7c58ac34-832e-49ea-a185-16aa0c8f1174 | assertions-failed: S01/S02; S03/S04 passed | 1 / 1 | idle / implement |
| hotfix | f1ca3440-5ff0-4ff5-aaa4-fdbda8d87909 | passed, 162 тести в 6 файлах | 0 / 0 | complete / complete |

Setup failure не зараховано як red. Main виправив відсутній файл у unitFiles, після чого наступний адресний red підтвердив assertion failure. Одна стабільна група `complete-raf-flow-contracts/z39398`, один QA HOME/SQLite aggregate, без скидання лічильників. Red SHA: `d98de5af4530bb5cffb1dff0c048ae324c41b565`, production identity-код незмінений. Test-first коміт: `9cf77f3c287228bb81b4deee43ebbb3f5ea62fee`. Hotfix SHA: `10c49f193e27768f4eee8ea47571ad1e0d30a7cf`, без незакоміченого implementation-коду; власна evidence-директорія та preexisting node_modules були untracked. Спільні сторонні коміти не включено до власного звіту.

Обидва виконані unit-прогони: timedOut=false, cleanup.complete=true, remainingPids=[], timeoutCount=0. Red: knownRed=2, unexecuted/unknown/removed порожні. Hotfix: knownRed/unexecuted/unknown/removed порожні, groupSnapshot=loaded. Повний expanded selection збережено у hotfix.stdout.json, початковий файл включений. `build.json`: npm run build і comment policy пройшли; git diff --check пройшов. Partial/unknown resource usage є телеметрією, не результатом пропущених тестів.

## Аудит і передача

Proposal та обраний item узгоджені з чинними source/commit/checkbox gates; суперечностей чи підстав знімати доручення не виявлено. Реалізація стосується повторної вартості source checks, не змінює confirmation flow, статусів або timeout config. Tasks.md виконавець не змінює: checkbox ставить raf за succeeded. На момент завершення залишаються інші відкриті пункти зміни (130 unchecked включно з цим), тому sync/archive не застосовується. Push/activation не виконувалися.
