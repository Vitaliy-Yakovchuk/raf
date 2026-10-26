# Z.445 — Vitest integration без прив’язки до профілю

Аудит: Z.445 актуальний на e1361e77bc7a46c4f2c4464ea6304b4d2fb455c8. Дві перевірки validateProfileInventories дозволяли Vitest integration лише etchly/vitest-worker-d1-integration з точним worker cwd/argv. Другий preflight validateEtchlyIntegrationInventories також вимагав d1Command від browser-профілю. Це суперечило конфігурованим командам профілів за add-raf-test-run/specs/projects/raf/test-runs, вимога «Команда з профілю проєкту». Прибрано ці прив’язки; adapter/exactIds, ізоляція, inventory і безпечна команда перевіряються чинними перевірками.

Регресія написана до production-правок: browser etchly, перейменований worker і інший проєкт; валідація всього conf та незалежний unit-прогін, точна integration-команда і Etchly preflight. Виправлено хибний негативний тест: vitest-events є підтриманим адаптером; невідомий адаптер перевіряється unknown-events.

Докази: [runs.json](runs.json) містить точні команди, runId, відбір, CLI/child коди, outcome, timeout/cleanup, knownRed/unexecuted/unknown/removed, стан групи та наступну дію. Повні незмінені JSON TestRunResult збережено в *.result.json, stderr — окремо в *.stderr.txt, CLI — *.cli-code.txt; початковий transport output збережено у *.tool-result.json. Застереження STATE_CONTEXT_WARNING стосуються керівного CLI; command.environment підтверджує ізольований QA HOME тестів і однаковий HOME для red/hotfix. Нового HOME або скидання агрегату не було.

- red: 72 passed, 7 knownRed, assertions-failed; CLI/child 1; timeoutCount=0, cleanup повний.
- hotfix: 79 passed; CLI/child 0, knownRed/unexecuted/unknown порожні, complete/complete.
- add-raf-test-run/etchly-integration: 73 passed; CLI/child 0, повний cleanup, complete/complete.
- Додаткова add-raf-test-run/integration-profiles спершу: 87 passed і 1 assertion старої скасованої відмови для nonselected missing integration inventory. За прямою вказівкою main від 2026-10-26 видалено test/test-run-integration-runtime.test.ts «integration runtime: unit invocation checks stale integration inventory before reservation». Це виправлення помилкового тесту за test-first; production-поведінку до старого очікування не повертали. Повтор тієї самої групи: 87 passed, knownRed/unexecuted/unknown порожні, removed містить лише видалений тест, CLI/child 0, complete/complete. Жодного таймауту.

SHA й незакомічений стан: red.sha/red.workspace-status.txt + red-tests.patch; hotfix.sha/hotfix.workspace-status.txt + hotfix.workspace.patch; final.sha/final.workspace-status.txt + final.workspace.patch. Чужі зміни Z.444 та інші файли не включено до власних patch/коміту.

Відновлення конфігурації: [conf-test-runs.patch.json](conf-test-runs.patch.json) — точний JSON Patch двох вилучених записів з orchestrator 92ba7bce57267cb9bbb2ae1ddcd4b5103947304f^: browser-профіль і fix-preview-sso/browser-contracts. Conf поза дозволеним записом. Main письмово доручив передати patch у звіті й застосує після релізу. Сам patch не означає застосування чи живий browser-прогін. Зміна fix-preview-sso не входить до --tasks цього доручення.

Галочку Z.445 ставить raf. Інші задачі complete-raf-flow-contracts відкриті; sync/archive не виконуються. Спільні src/test-run-integration-profiles.ts та test/test-run-integration-profiles.test.ts передаються Z.447 після цього коміту.
