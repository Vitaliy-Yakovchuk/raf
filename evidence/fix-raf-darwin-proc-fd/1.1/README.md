# fix-raf-darwin-proc-fd:1.1

Аудит: proposal.md, tasks.md та фактичний код узгоджені; шість операцій із відкритим fd використовували Linux-only шлях. Додано один спільний builder, серіалізований також у самодостатні hook/replay програми. Linux зберігає `/proc/self/fd/<fd>`, darwin отримує `/dev/fd/<fd>`. Інші правила transport не змінені.

Група всіх прогонів: `fix-raf-darwin-proc-fd/unit`, project `raf`; той самий стабільний QA HOME у повних TestRunResult. Точні команди, HEAD і незакомічений стан/хеші джерел у `*.workspace.json`. `*.TestRunResult.json` скопійовано байт у байт із повідомленого raf result path; `*.tool-result.json` зберігає повну відповідь shell tool. `*.stderr` містить stderr-частину після єдиного JSON stdout у об'єднаному виводі каналу, без обрізання. `*.cli-code.txt` — код CLI, окремо від `TestRunResult.exitCode` дочірнього runner-а.

| Фаза/доказ | runId | Результат | CLI / child | knownRed / unexecuted / unknown | Стан / наступна дія |
| --- | --- | --- | --- | --- | --- |
| red | 171bc6a7-25cb-488f-a60a-0e951d6320cb | assertions-failed: відсутній builder у тілі трьох тестів, без setup/import failure | 1 / 1 | 3 / 0 / 0 | idle / implement |
| hotfix-1 | c1bb391f-c315-43be-b778-f779e72a26f5 | 21 passed, 1 assertions-failed | 1 / 1 | 1 / 0 / 0 | idle / fix-implementation |
| hotfix-2 | d5acf6ba-54f7-4756-a807-12484bf7b59d | passed: 22 тести | 0 / 0 | 0 / 0 / 0 | complete / complete |

У всіх трьох timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[]. Red вибрав лише новий fd-файл; hotfix-1/2 додали існуючі output та lifetime файли (точний список у JSON).

Єдине падіння hotfix-1: існуюча production agent ps фікстура передавала неповний `commandTiming:{emaAlpha:0.1}` та не мала чинного `sqliteOnlyMeanBudgetMs`. Підготовка тепер читає commandTiming із копії conf/raf.json; assertions не змінені. Повтор із тим самим відбором і групою підтвердив усі 22 тести.

Живий запуск на Mac не виконувався: за дорученням його робить Mac після активації main. Пункт 1.2 відкритий; archive й активація не виконувалися. Галочки 1.1 виставляє raf за звітом. conf/test-runs.json із власною реєстрацією групи автоматично закомічено зовнішнім процесом; це не власний commit виконавця.
