Пункт `repair-raf-mac-bootstrap:34.4` виправлено перевіркою наявності `config.projects[projectId]` у справжньому runtime preflight до звернення до groups/profiles і будь-яких дій із файловим станом. Відсутній профіль дає `ENVIRONMENT_INVALID`, setup-failed і точну адресу `conf/test-runs.json#/projects/trumpet: project profile is missing`; spawn не виконується. Нових команд, обмежень чи контрактів немає.

Аудит: пункт 34.4 і proposal.md узгоджуються з чинними projects/raf/test-runs, вимогами «Команда з профілю проєкту» (сценарій «Немає придатного профілю») та «Перевірки середовища перед запуском». Дефект підтверджено на поточному коді RED. Main погодив редагування preflight біля рядка 201; ділянку обмежених читань біля 490–500 не змінено.

Група незмінна: `repair-raf-mac-bootstrap/missing-project-profile`. Відбір — один файл `test/test-run-missing-project-profile.test.ts`, три тести для preset, --files і --only. Тести викликають справжній runtime preflight через CLI-обгортку, перевіряють діагностику, CLI 1, відсутність spawn, транзакцій і створення QA HOME у фікстурі. Unit-прогони здійснено лише через дозволений raf test run; QA HOME обох запусків однаковий, його точний шлях містять результати.

| Фаза | runId | outcome | CLI / child exitCode | knownRed / unexecuted / unknown | Стан / наступна дія |
| --- | --- | --- | --- | --- | --- |
| red | dc9cf6b7-9f3d-4ccb-bc36-cf98b70d6c73 | assertions-failed | 1 / 1 | 3 / 0 / 0 | idle / implement |
| hotfix | 014a46f2-08c5-410c-8381-215568bb8121 | passed, 3/3 | 0 / 0 | 0 / 0 / 0 | complete / complete |

Обидва: timedOut false, timeoutCount 0, cleanup complete, remainingPids []. RED — саме assertion failures, без setup/import failure. Повні незмінені результати скопійовано з названих raf файлів: [red.TestRunResult.json](red.TestRunResult.json), [hotfix.TestRunResult.json](hotfix.TestRunResult.json). Їх звірено зі stdout; урізання немає. `*.tool.json` зберігають повернення інструмента; `*.stderr.txt` — окремий stderr, `*.cli-exit-code.txt` — код CLI окремо від child exitCode у TestRunResult. Команди — `*.command.txt`, виконаний HEAD — `*.head.txt`, незакомічені правки — `*.workspace.patch`. RED patch відтворює новий тест; GREEN patch містить лише виправлення preflight. Код тесту зафіксовано комітом `75cf61d845ff2fa19d9a74410b2dd12520a526ef` до реалізації. `git diff --check` і `node scripts/check-comments.ts` завершилися кодом 0.

Реєстрацію unitFiles/groups додано in-place у спільний conf/test-runs.json; точні записи — [conf-registration.json](conf-registration.json). Main повідомлено receipt `f2997e1c-ccdb-4810-a994-3ad4692fb43e`; коміт цього реєстру належить main за чинною процедурою implement.md.

Власні два рядки metadata групи/результатів додано до tasks.md без галочки. Root Git commit недоступний: `fatal: Unable to create '/srv/dev/work/orchestrator/.git/index.lock': Read-only file system`, CLI 128. [Точний патч](orchestrator-tasks.patch), [помилка](orchestrator-commit-error.txt) передані main; [підтвердження доставки](main-handoff.tool.json), receipt `53ed6361-a9c0-448a-9bfa-9652099d2a66`, CLI 0. Це передача документів для коміту, код і докази комітить виконавець через довірений порт.

Відкриті пункти всієї зміни 4, 12, 31.3 залишено поза обсягом; archive не застосовується. Галочку 34.4 ставить raf після succeeded. Активація, push і Mac runtime перевірка до доручення не входять.
