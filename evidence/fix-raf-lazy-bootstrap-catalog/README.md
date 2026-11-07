# fix-raf-lazy-bootstrap-catalog:1.1

Доручення: відтворити 8 падінь lazy-bootstrap, виправити читання каталогу та fixture без послаблення критеріїв. Вихідний HEAD hotfix — `438001902bd771b7daafe2acfd2ad04e272452a9`, нащадок baseline `63902948590a2ec4679baa16eb126f549294b99b`. Інших tracked-правок на початку не було; існував untracked symlink `node_modules`.

## Аудит

Чинні джерела: proposal/tasks цієї зміни; projects/raf/state-store «Захист робочої бази від іншої гілки raf» з усіма сценаріями лінивого CLI; projects/raf/cli-catalog «Зміна джерела після збірки»; core/process/test-first та unit-test-runs. Доручення актуальне: `readCatalogArtifact` на ENOENT запускав CatalogGenerator із source conf. `guardMock` не мав `admitStateStore`, який імпортує state-store.

Читання артефакту тепер лише читає та розбирає JSON; на відсутній/пошкоджений артефакт наявні CLI catch-гілки дають явну відмову. Явна збірка CatalogGenerator не змінена. Fixture доповнений функцією `admitStateStore`, що повертає callback, як реальний guard. Усі assertions цільового тесту незмінні.

## Прогони

Точні команди, SHA, відбір, стан групи, child/CLI exit codes, cleanup та хеші повних результатів — у `runs.json`. Оригінальні TestRunResult скопійовано з файлів RAF; вони не урізані й не реконструйовані. `*.cli-output.txt` зберігає відповідь інструмента, `*.stderr.txt` — доступний блок stderr, `*.cli-exit-code.txt` — код CLI окремо від child exitCode у JSON. Вивід інструмента RED/GREEN урізано; stderr RED є уривком і позначений у manifest. Частина RED diagnostics штатно має truncated=true; це поле оригіналу, сам TestRunResult повний.

- setup-failed: preflight `ENVIRONMENT_INVALID: dependenciesAvailable`, child не запускався; не зараховано як RED. Runtime перевіряє checks усіх raf-профілів, включно з `.qa-hotfix-candidate`/`.qa-main-baseline`, хоча відбір належить профілю node. Для передумов скопійовано наявні повні QA snapshots із raf-develop до тих самих відносних каталогів hotfix. Копії не виконувалися; цільовий прогін виконав власний test/state-migration-lazy-bootstrap.test.ts. Копії видалено після GREEN. Профілі, checks, QA HOME та агрегат не підмінялися.
- RED `9db42d1d-4f59-4191-8255-617fe6c968b3`: 231 pass / рівно 8 assertion failures, 0 setup/import diagnostics. Два заборонені conf-read і шість assertion-збоїв через неповний guardMock у дочірніх probes. CLI=1, child=1; без таймауту, cleanup complete, knownRed=8, unexecuted=unknown=0, idle, timeoutCount=0, nextAction=implement.
- GREEN `f163818d-03d7-4404-89d1-03e32cb06841`: 239 pass, diagnostics/knownRed/unexecuted/unknown порожні, CLI=child=0, без таймауту, cleanup complete, idle, timeoutCount=0, nextAction=complete. QA HOME той самий, що RED.

Групу додано in-place до conf/test-runs.json; її коміт належить main/автореєстрації, не виконавцю. Галочки tasks.md не змінювались. Активація main та archive залишаються окремими відкритими пунктами 1.2/9.1.

## Межі

Незареєстрований у unitFiles старий `test/missing-catalog-generate.test.ts` вимагає неявної генерації на missing artifact і суперечить дорученню; він не входив у цільовий baseline-відбір і не запускався. Його assertions не підганялися. Повідомлення main з причиною очікує delivery receipt; знахідка також включена у JSON-звіт; цей GREEN стосується тільки явно названої групи.
