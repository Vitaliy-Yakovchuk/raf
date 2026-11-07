# Hotfix 1.4 — індекс result_notices(run_id)

Аудит: пункт 1.4 tasks.md і доручення main відповідають фактичному коду: schema 18 створювала result_notices лише з PRIMARY KEY(id), а завершення сесії оновлює notices за run_id. Proposal описує початкові 1.1–1.2; обсяг цієї додаткової регресії визначено чинним 1.4 і підтвердженням main у сесії (schema 19 вільна, 18→19 має приймати вже наявний індекс). Суперечності з чинними вимогами не знайдено.

Виправлення: штатна транзакційна міграція 19 виконує `CREATE INDEX IF NOT EXISTS result_notices_run_id ON result_notices(run_id)` і змінює user_version тільки після DDL. Підтримка 17/18 збережена, додана 19; явний transfer не переноситься на звичайне відкриття. Індекс також створюється в новій базі. Guard та ліміт 50 не змінювались.

Регресія використовує 122 notices (120 чужих і два цільові). Після putSession(finished) обидва цільові notices отримують state/revision/finishedAt, чужі payload збережені повністю. Кожна спостережена SQL-операція завершення має limit=50 і rowsRead≤50. Фікстура schema 18 отримана видаленням єдиної зміни 19 (цього індексу) і встановленням user_version=18; таблиці відповідають schema 18. Перевірені обидва початкові стани індексу і повторні transfer/ordinary opens без зміни schema_version та без повторних migration callbacks.

Стабільна група `fix-raf-test-run-selection-aggregate/result-notices-run-index`, профіль node; конфігурація в test-group.json. Реєстр conf/test-runs.json комітить main, про доповнення повідомлено та отримано підтвердження коміту. До цієї ж групи додані наявні test/state-store.test.ts; єдина зміна їхнього твердження — очікуваний список підтримуваних версій [17,18,19].

| Прогін | RunId | CLI / child | Результат | Група / наступна дія |
| --- | --- | --- | --- | --- |
| RED | 200080ff-2a3c-466d-8f11-a6f7a475ae5a | 1 / 1 | 3 assertions failures: UPDATE notices 122>50, два відхилені transfers до ще непідтримуваної 19 | idle / implement |
| Hotfix, перша спроба | ec934d9d-47bc-4a7b-8ae3-815707379988 | 1 / 1 | 1 pass, 2 failures через помилку SQL перевірки індексу в новому тесті | idle / fix-implementation |
| Hotfix, підтвердження | 6b335793-b13e-4731-9cf2-7d4c54ac9f47 | 0 / 0 | passed, 23/23 | complete / complete |

У першій hotfix-спробі виправлення вже усунуло початковий full scan notices. Але запит самого тесту до sqlite_schema сканував 52 записи каталогу. Виправлено саме тест: перевірка кількості/назви індексу через PRAGMA index_list(result_notices) замість SELECT каталогу; перевірка колонки run_id через PRAGMA index_info залишилася. Твердження й поведінка не послаблені. Невдала спроба збережена, не названа GREEN.

У всіх трьох прогонах cleanup.complete=true, remainingPids=[], timedOut=false, timeoutCount=0, unexecuted=[], unknown=[], removed=[]. RED knownRed=3; перша hotfix-спроба knownRed=2; фінальна knownRed=[]. HOME і statePath однакові в усіх TestRunResult, агрегат не скидався.

Повні незмінені TestRunResult скопійовані з файлів, названих raf у stderr: red.test-run-result.json, hotfix-attempt-1.test-run-result.json, hotfix.test-run-result.json. Файли *.invocation.json містять точні команди, окремі CLI/child exit codes і вихідні адреси JSON. *.stderr.txt містять stderr із tool output; для RED stderr перенесений з показаного output, для hotfix збережено також повний tool capture (*.tool.json). Обрізання tool output або TestRunResult немає. Попередження про чужі конфігурації збережені й не підміняють результат. Resource-telemetry completeness=partial наведена в повних JSON; повноту цієї телеметрії не заявлено.

red.workspace.json і red.workspace.patch фіксують HEAD перед реалізацією (0cc68eb871e012d7e8c4b6038285d3f13436c3ba) і відсутність production diff; новий непроіндексований тест окремо в red.regression-test.ts.txt. hotfix.workspace.json / .patch та hotfix.regression-test.ts.txt фіксують виконаний код і тест остаточного прогону. Файли hotfix-attempt-1.* зберігають попередню версію тесту та production patch.

Додатково: git diff --check пройдено. Пункт 9.1 (активація main) відкритий, archive не виконується. Наступна дія main: активація кандидата з явною міграцією 18→19; існуючий ручний індекс не заважає міграції. Живу DB цей виконавець не змінював.
