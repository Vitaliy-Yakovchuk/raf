# complete-raf-flow-contracts:12.4

Реалізовано компіляцію каталогу за нормативною JSON Schema, семантичну перевірку references/defaults/examples/bindings, атомарну публікацію, help/parser/діагностику зі спільного snapshot. Brief/report/event validators отримують compiled catalog вибраного покоління; runner enablement далі зберігається в SQLite.

Код: `1f283c5bc929ccd4c22210c7c17a7c310843bdab` (raf-develop). Спільні production-runtime.ts/production-entry.ts закомічено окремим index лише з власними hunks; model-routing hunks іншого виконавця залишено йому. task-context.ts передано cfc92 після власного коміту.

Conf-патч передано main файлами conf-raf-constants.patch.json і raf-constants.target.json; main застосував його комітом Orchestrator `7f48f01582e5df16d9b5a01270cdb2040c299491`. Локально conf не редагувався. Поточний conf семантично збігається з переданим target; порядок ключів/форматування може відрізнятися. prepare-conf.mjs документує міграцію чинних metadata/errorCodes, не виконується runtime. Оригінальна схема з 12.2 скопійована у src/catalog.schema.json.

## Unit

Стабільна група: `complete-raf-flow-contracts/catalog-generator`, implement, project raf. Відбір завжди `--files test/catalog-generator.test.ts`. Команда дослівно записана у кожному run-N/command.txt. QA HOME/SQLite агрегат не змінювалися; переданий red 12.3: `ad7c370f-6897-44fc-92ad-55e3dff5a75f`, 42 NotImplemented, за повідомленням main. Підготовлений тест не читався до незалежної початкової реалізації та не редагувався.

| Запуск | runId | CLI / child exit | Результат | Стан / дія |
| --- | --- | --- | --- | --- |
| 1 | 68727dae-f8e8-435d-8bb7-6ab2a7770563 | 1 / 1 | 39 pass, 3 knownRed | idle / fix-implementation |
| 2 | 2fd58416-d225-461c-a834-ecd4718cb83d | 0 / 0 | 42 pass, 0 knownRed | complete / complete |
| 3 | 6f7e3688-e171-4b08-bf6a-d7be80e34a52 | 0 / 0 | 42 pass, 0 knownRed | complete / complete |

У всіх трьох: timedOut=false, cleanup.complete=true, remainingPids=[], unexecuted=[], unknown=[], removed=[], timeoutCount=0. У run-3 ресурсний облік має completeness=partial (RAM) / unknown (disk), як дослівно в TestRunResult; це не доказ повного вимірювання ресурсів.

Три дефекти першої реалізації: предметна перевірка фази помилково була всередині загального parser; повідомлення schema pattern не містило хибного reference; передчасна перевірка зовнішніх IDs приховувала pointer місця використання. Виправлено код, не тести. Run-3 повторено після додаткового підключення brief/service/worker, з уже закоміченим власним кодом. Чужі unit-регресії не запускалися.

run-N/TestRunResult.json містить повний незмінений JSON результату; stderr.txt зберігає stderr окремо, cli-exit.json — код CLI окремо від exitCode child у JSON. tool-result.json зберігає незмінений transport result. exec_command повертає об'єднаний текст stdout/stderr: run-1/2 містили лише один повний JSON і не мали додаткових stderr-байтів; у run-3 перший рядок — повний TestRunResult, наступний — повідомлення launch-queue.waiting, яке src/test-run-reservations.ts пише через writeStderr. Його відокремлено без переформатування; весь об'єднаний текст також збережено.

run-2/workspace.json і run-3/workspace.json містять SHA та незакомічений стан до прогону; diff поруч фіксує спільне дерево, включно з явно чужими правками. run-3 базується на `016af97e13eaac8f81031e0468dd317092e23301`, що включає власний код 1f283c5; own-code.diff.json окремо відтворює лише наш коміт. У run-1 початковий workspace snapshot до прогону не був збережений: workspace-after-run.json чесно позначає пізнішу фіксацію після трьох виправлень; його не слід видавати за точний початковий стан.

## Інші перевірки

build-final.json: `npm run build`, CLI 0, comments policy та production catalog build успішні. Артефакт не комітиться (dist ігнорується); його SHA256 перед фінальним unit міститься в run-3/workspace.json.

snapshot-smoke.mjs / smoke-final.json: перевірено відмову від читання live conf при складанні пам'ятки; статуси report, події та джерело report schema слідують переданому snapshot. Каталог подій і report-константи перевірено з навмисно зміненими IDs у власній копії. Тимчасову теку прибрано. production-runtime імпортується; git diff --check для реалізації успішний. Diff-знімки збережені без втрати байтів у JSON (поле text), оскільки пробіли порожніх контекстних рядків є частиною формату Git diff. Ця перевірка не запускає service, runner або integration flow.

Tasks.md та archive не змінювалися: інші пункти зміни відкриті; галочку 12.4 ставить raf після приймання звіту. Push не виконувався.
