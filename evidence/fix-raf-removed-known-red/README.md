# fix-raf-removed-known-red:1.1

Аудит: proposal/tasks та чинні core/process/test-first, core/process/unit-test-runs,
projects/raf/test-runs і workspace-routing узгоджені з дефектом у src/test-runs.ts.
На початковому HEAD 9244c2b31b9c421544e187e311db93c5f4057f6f умова removed
не враховувала відсутній у workspace файл поза поточним відбором.

Виправлення зберігає умову повного збору, виключає --only, setup, timeout та
неповний cleanup. Відомі preflight-факти про наявність файла зберігаються;
відсутність факта в інвентарі додатково перевіряється за workspace pathname,
тому наявний файл поза профілем не вважається видаленим. Видалені ID не
видаються за виконані passed. П'ять нових unit-сценаріїв перевіряють ці межі.

## Прогони

Точні зовнішні команди: red.command.txt і hotfix.command.txt.
Група обох прогонів: fix-raf-removed-known-red/unit; QA HOME та агрегат ті самі.
Явний --files використано без зміни спільного conf/test-runs.json.
SHA і незакомічені зміни на момент запуску: red.head.txt/red.patch/red.workspace.txt
та hotfix.head.txt/hotfix.patch/hotfix.workspace.txt. node_modules був чужим
неіндексованим шляхом до початку роботи; він не входить до коміту.

| Фаза | runId | CLI / child | outcome | passed / knownRed | timeoutCount | groupState / nextAction |
| --- | --- | --- | --- | --- | --- | --- |
| red | 1dace902-84fd-44d1-9f8b-a08441184da3 | 1 / 1 | assertions-failed | 19 / 1 | 0 | idle / implement |
| hotfix | a7eb5f00-3784-4e80-9daa-8d76a7d2d8e0 | 0 / 0 | passed | 96 / 0 | 0 | complete / complete |

Початковий red: падає саме твердження result.outcome === passed у сценарії
видаленого файла зі старими knownRed та unexecuted. Setup/import failure немає.
Обидва прогони: timedOut=false, cleanup.complete=true, remainingPids=[],
unexecuted=[], unknown=[]; green очистив єдиний knownRed попереднього red.
Поточний removed зовнішньої групи порожній: усі її тести існують і виконані;
видалені ID перевіряються всередині регресійної фікстури.

*.TestRunResult.json містять повний незмінений JSON першого рядка transport.
*.stderr.txt містять решту виводу transport (діагностичний stderr wrapper-а).
*.transport.json зберігають повну відповідь інструмента без обрізання;
*.cli-exit-code.txt містять код CLI окремо від child exitCode в TestRunResult.
Попередження wrapper-а про operational context стосується довіреного dispatcher;
command.environment у кожному результаті доводить окремий QA HOME дочірнього коду.
Обидва виводи містять попередження про сторонню etchly integration-групу;
воно не є setup-помилкою чи причиною red.

Build робочого дерева: npm run build, CLI 0; перевірка коментарів входить у build.
Команда, незмінний QA HOME, stdout/stderr і код збережені в build.*.
git diff --check пройшов. Це не exact-snapshot activation gate.

Main повідомленням у цій сесії уточнив: після red/green і коміту подати succeeded;
exact-snapshot gates, CLI smoke, атомарну активацію та перенесення до develop
виконує main окремо. Активація або перенесення цим доказом не стверджуються.
Пункт 1.2 лишається відкритим; archive не виконувався. Галочки не змінювалися.
