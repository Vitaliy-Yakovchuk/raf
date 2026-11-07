# Передача 2.37

Доручення test-scaffold виконано; реалізації фічі немає. `src/database-read-limit.ts` задає повні типи й сигнатури локальної SQLite-поверхні. Усі чотири нові функції кидають `Error('NotImplemented')`. Реалізатор має використати сумісний shared-libs SQLite adapter або тонку локальну обгортку за design; каркас не підтверджує доступності native scanstatus у Node.

Незмінна група: `limit-db-rows-read-per-query/raf`.

Точний авторський відбір:

```sh
node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase red --group limit-db-rows-read-per-query/raf --files test/database-read-limit.test.ts
```

Профіль: `conf/test-runs.json#/projects/raf/profiles/node/unitFiles` доповнений `test/database-read-limit.test.ts`; `projects/raf/groups/limit-db-rows-read-per-query/raf` = `{"files":["test/database-read-limit.test.ts"],"profileId":"node"}`. Зміна внесена in-place; спільний conf комітить main, якому передано запис через raf agent message.

## Доказ RED

- Завершальний прогін: `red.TestRunResult.json`, runId `bdeb1ef6-a106-4732-87c0-d78b3eec00d1`, CLI code 1, `assertions-failed`, failureKinds `["assertions"]`, 39 knownRed, 0 passed/unexecuted/unknown; не timeout.
- `known-red.json` містить усі точні IDs (`file`, `name`) для наступного етапу. Показові цільові падіння: `shared matrix rejects 51 actual rows with stable diagnostic fields`, `state factory guards exported DatabaseSync without caller installation`, `bugs factory guards exported DatabaseSync without caller installation`, `health storage guards hidden scan on a supplied DatabaseSync`.
- `red.cli-capture.json` містить повний результат exec_command: CLI code, об'єднаний stdout/stderr без обрізання. `red.cli-diagnostics.txt` містить усі рядки поза stdout TestRunResult, зокрема stderr warnings Dash та шлях збереженого результату; інструмент не надає окремого маркування каналів. Діагностика TestRunResult: totalEntries=39, retainedEntries=39, omittedEntries=0, truncated=false; redacted=true за політикою raf.
- Перший прогін `red-initial.TestRunResult.json` виявив також три помилки підготовки `t.mock.env is not a function`. Це НЕ чистий RED. Виправлено явним встановленням/відновленням NODE_ENV; повтор виконано через зміну setup, а не заради stderr. Його початковий CLI-вивід у чаті був обрізаний; повний первинний TestRunResult збережений. Завершальний прогін не має цих помилок.
- Параметр phase=`red`, callerPhase=`test-scaffold` у результаті є різними полями за фактичним викликом і сесією.

## Покриття та інваріанти

39 адресних тестів перевіряють межі 0/49/50/51, власні межі 7/75 із justification, стабільні code/queryId/callsite/rowsRead/limit, NODE_ENV test/development/production, all/get/iterate/run/exec, індексні й повні scans із нульовим результатом, COUNT/SUM, join, UPDATE з читанням, приховування bound/row values у помилці, фактичні visits 0/1 для point lookup, скидання cached statement, окремий бюджет кожного exec statement, відсутність повторного виконання й подвійного обгортання. Власна межа не повинна витікати в наступний запит.

Фабрики openStateStore/openBugStore мають встановлювати guard до передачі handle; прямі prepare/exec на експортованих DatabaseSync не обходять його. Health та startup-context перевіряються також на переданих іззовні DatabaseSync. Списки стану/секцій жуків/pending startup IDs із fixture 120 записів мають зберігати всі елементи, а кожний внутрішній SQL — вкладатися у свою обґрунтовану межу. Нова state migration, bug v1 migration, maintenance source/backup copy/final integrity connections повинні проходити той самий guard; observation діє на фактичному SQL, а не на mock DB.

`observeDatabaseReads` — scoped observer виконань для перевірки реального scanstatus; не постійна історія SQL. Має підтримувати синхронну й асинхронну дію, не підміняти виконання/метрику. Не можна підставляти result.length, fullscan-only, VM steps, EXPLAIN estimate або повторно виконувати SQL. `metric: SQLITE_SCANSTAT_NVISIT` потребує справжнього binding та підтвердження у implement/QA. Перевищення не обіцяє rollback завершених write/exec; це не нова транзакційна вимога.

Інваріант адресного code review: rowsReadLimit, відмінний від 50, має непорожнє justification поруч з SQL; guard не має глобального bypass/автопідняття межі. Тест не вигадує окрему runtime-помилку для відсутнього justification, оскільки спільний сценарій вимагає відхилення такої зміни перевіркою коду.

Чинність звірено з proposal, спільною delta, raf delta, design (спільна реалізація, адаптери/вимірювання, матриця, кандидати перевищень), рядком raf inventory. Вимірювання production/внутрішніх scans і виправлення наявних перевищень належать 2.39/2.40 та тут не заявляються. Пункт 2.37 містить старе «без запуску unit»; конкретний бриф і чинний feature-test-authoring вимагають авторський red, тому його виконано. Tasks.md не змінено; 2.38 та інші пункти не закрито, sync/archive не виконувались.
