# fix-raf-stale-known-red:1.1

Аудит: proposal.md та tasks.md узгоджені з фактичним дефектом у removed; skip_specs: true. Реалізовано лише 1.1. Відкритий 1.2 не доручено; галочки й archive не змінювались.

Стабільна unit-група: fix-raf-stale-known-red/unit. Відбір: test/test-runs.test.ts. Команди записані в *.command.txt. Конфігурація й QA HOME не змінювались; explicit files використовують зареєстрований node-профіль без нової реєстрації групи.

red.* — первинне цільове assertion-падіння разом із двома помилковими допоміжними твердженнями: один ID одночасно використовувався як knownRed та unexecuted, хоча агрегація усуває це дублювання. Дані допоміжних перевірок виправлено до реалізації; очікування продукту не послаблювались.

red-corrected.* — повторний red до зміни src/test-runs.ts: падає лише цільова регресія очищення ID існуючого файлу, прибраного з selection. Існування файлу представлено спостереженням preflight-фікстури kind=file; новий selection містить лише alpha/beta, попередній агрегат містить gamma. Додаткові перевірки: вилучення тесту з вибраного файлу, збереження ID при --only та неповному/setup-прогоні.

hotfix.* — підтвердження виправлення: passed, knownRed/unexecuted/unknown порожні, groupState=complete, nextAction=complete. Cleanup complete, timedOut=false, timeoutCount=0 в усіх прогонах. Після цього прибрано лише невикористаний import existsSync; це зафіксовано в code-commit.json.

Повний незмінений рядок TestRunResult кожного виклику збережено в *.TestRunResult.json, stderr окремо в *.stderr.txt, CLI exit окремо в *.cli-exit-code.txt (child exitCode міститься у TestRunResult). Повний отриманий transport — *.transport.json. Transport не віддає потоки окремими полями: перший рядок є JSON stdout, решта — stderr warnings. Жодного урізання transport/JSON/stderr немає. Workspace SHA, status та патч перед кожним прогоном — *.workspace.json та *.workspace.patch. Побічні warnings стосуються пропущених конфігурацій etchly; setup failure відсутній.

Код комітить лише довірений hotfix-порт. Штатну активацію, build, CLI smoke і перенесення до develop виконує main за workspace-routing; підтвердження активації має бути у фінальному JSON-звіті й повідомленні main, коміт сам не є активацією.
