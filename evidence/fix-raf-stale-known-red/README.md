# fix-raf-stale-known-red:1.1

Аудит: proposal.md та tasks.md узгоджені з фактичним дефектом у removed; skip_specs: true. Реалізовано лише 1.1. Відкритий 1.2 не доручено; галочки й archive не змінювались.

Стабільна unit-група: fix-raf-stale-known-red/unit. Відбір: test/test-runs.test.ts. Команди записані в *.command.txt. Конфігурація й QA HOME не змінювались; explicit files використовують зареєстрований node-профіль без нової реєстрації групи.

red.* — первинне цільове assertion-падіння разом із двома помилковими допоміжними твердженнями: один ID одночасно використовувався як knownRed та unexecuted, хоча агрегація усуває це дублювання. Дані допоміжних перевірок виправлено до реалізації; очікування продукту не послаблювались.

red-corrected.* — повторний red до зміни src/test-runs.ts: падає лише цільова регресія очищення ID існуючого файлу, прибраного з selection. Існування файлу представлено спостереженням preflight-фікстури kind=file; новий selection містить лише alpha/beta, попередній агрегат містить gamma. Додаткові перевірки: вилучення тесту з вибраного файлу, збереження ID при --only та неповному/setup-прогоні.

hotfix.* — підтвердження виправлення: passed, knownRed/unexecuted/unknown порожні, groupState=complete, nextAction=complete. Cleanup complete, timedOut=false, timeoutCount=0 в усіх прогонах. Після цього прибрано лише невикористаний import existsSync; це зафіксовано в code-commit.json.

Повний незмінений рядок TestRunResult кожного виклику збережено в *.TestRunResult.json, stderr окремо в *.stderr.txt, CLI exit окремо в *.cli-exit-code.txt (child exitCode міститься у TestRunResult). Повний отриманий transport — *.transport.json. Transport не віддає потоки окремими полями: повний JSON-рядок є stdout, решта рядків — stderr warnings (вони можуть з’являтися перед JSON або після). Жодного урізання transport/JSON/stderr немає. Workspace SHA, status та патч перед кожним прогоном — *.workspace.json та *.workspace.patch. Побічні warnings стосуються пропущених конфігурацій etchly; setup failure відсутній.

Код комітить лише довірений hotfix-порт. Штатну активацію, build, CLI smoke і перенесення до develop виконує main за workspace-routing; підтвердження активації має бути у фінальному JSON-звіті й повідомленні main, коміт сам не є активацією.

Нові обставини під час огляду: removed використовується також integrationRemoved; потрібне збереження чинної integration-семантики часткового відбору. integration-before.* фіксує падіння наявного narrowed-selection тесту в налаштованій групі add-raf-test-run/integration-profiles (unit-тести integration-рушія, без реальних провайдерів). Ця зміна не додавалася до tasks доручення. Після цільового assertion-падіння старий integration-предикат відокремлено від нового unit-предиката, import existsSync повернуто для нього. Нові вимоги/валідації/таймаути не додавалися.

Остаточні підтвердження: hotfix-final.* — 79/79 passed у fix-raf-stale-known-red/unit; integration-after.* — 94/94 passed у штатній add-raf-test-run/integration-profiles. Обидва прогони мають CLI 0, child exitCode 0, knownRed/unexecuted/unknown [], cleanup.complete=true, timedOut=false, timeoutCount=0, groupState=complete, nextAction=complete. Незмінні групи й QA HOME збережено. Після цих прогонів runtime більше не змінювався.

Main повідомлено про потребу призупинення попереднього кандидата: перша доставка відмовлена HANDLER_FAILED / Recipient composer contains unrelated input, completed=[], pending=[], retrySafe=true; наступний виклик підтверджено receiptId 91013e2a-fa3a-46d9-8a60-325d9d1b9007.
