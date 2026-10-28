# fix-raf-removed-known-red-integration:1.1

Аудит proposal/tasks, core/process/test-first, core/process/unit-test-runs та
projects/raf/test-runs підтвердив актуальність дефекту на початковому HEAD
383c3c2c11750e182e8c6e11f2b47cc97634882b. Integration-блок відновлював
previous.knownRed/unexecuted без removed та обнуляв result.removed.
З іншим hotfix-виконавцем узгоджено завершення його правок src/test-runs.ts;
його існуючий unit-предикат та existsSync збережені без змін.

Виправлено лише integration-блок: за повного збору попередні ID відсутнього
файла, ID поза налаштованими файлами групи та незнайдені ID вибраного файла
переходять у removed, виходять з knownRed/unexecuted і зберігаються в lastResult.
Тестова фікстура створює справжній наявний файл поза групою; він лишається
в integrationFiles профілю. Файл, який залишається в групі, зберігає ID за
звуженого відбору. Поточні assertion failures не губляться. Без complete,
за protocol error, неповного cleanup або timeout старі ID не прибираються.
Unknown, політика часу та unit-гілка не змінені.

## Докази

Точні команди: red.command.txt та hotfix.command.txt. Це unit-тести
integration-гілки з ізольованими портами, без реального integration-прогону.
Група незмінна: fix-raf-removed-known-red-integration/unit;
відбір: test/test-run-integration-runtime.test.ts. Спільний конфіг не змінювався.

| Фаза | runId | CLI / child exitCode | outcome | passed / knownRed | groupState / nextAction |
| --- | --- | --- | --- | --- | --- |
| red | f6cfd0c5-313c-4dee-9e52-fc665129abac | 1 / 1 | assertions-failed | 12 / 3 | idle / implement |
| hotfix | 5b130d8e-b32b-40ea-b103-4ac9d91a3f44 | 0 / 0 | passed | 15 / 0 | complete / complete |

Red отримано до зміни рішення: падає саме outcome === passed та твердження
removed/knownRed нових сценаріїв. Setup/import failures немає.
В обох прогонах timedOut=false, timeoutCount=0, cleanup.complete=true,
remainingPids=[], unexecuted=[], unknown=[]. Зовнішній removed=[]:
видалені ID перевіряються всередині фікстур і не є ID unit-набору.
Green підтвердив усі три knownRed початкового red в тому самому агрегаті.

Повний незмінений JSON TestRunResult збережений у *.TestRunResult.json;
*.transport.json містять повні відповіді інструмента, *.stderr.txt — stderr
wrapper-а після JSON, *.cli-exit-code.txt — окремий код CLI. Обрізання немає.
*.head.txt, *.patch та *.workspace.txt фіксують SHA й незакомічені правки
на момент кожного запуску. Неіндексований node_modules існував до роботи.

HOME, statePath і tmpPath у command.environment обох результатів доводять
той самий ізольований QA HOME. STATE_CONTEXT_WARNING стосується довіреного
dispatcher; дочірній код працював у QA. Попередження про сторонню etchly-групу
не було причиною red чи setup failure. Raw великих child-логів не зберігалося.

npm run build пройшов з кодом 0 у тому самому QA HOME: build.meta.json,
build.stdout.txt, build.stderr.txt. Build включає перевірку коментарів;
git diff --check пройшов. Додаткової activation-перевірки це не замінює.

Виконано лише 1.1. Галочки не змінювались; 1.2 лишається відкритим,
archive не виконувався. Активацію та перенесення до develop виконує main
за конкретним дорученням цієї сесії.
