# fix-raf-activation-conf-churn:1.1

Група `fix-raf-activation-conf-churn/sealed-configuration`, файл `test/hotfix-activation-conf-churn.test.ts`. QA HOME не змінювався. Вивід `test run` не перенаправлявся. Повний `TestRunResult` скопійовано з файлу, який raf назвав рядком `RAF test run result`. Надрукований stdout інструмента обрізався; JSON-файли нижче повні.

RED: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase red --group fix-raf-activation-conf-churn/sealed-configuration --files test/hotfix-activation-conf-churn.test.ts`

- CLI exit 1, child outcome `assertions-failed`, runId `fe3885f9-4fdd-48a1-baa7-4ca08eb68fb6`
- knownRed: запечатаний реєстр (гейт не отримав `RAF_SEALED_CONFIGURATION_ROOT`) і зміна profile після green (`Hotfix snapshot fingerprint changed`)
- passed: зміна коду, реєстрація groups, зміна models
- cleanup complete, timedOut false, groupState idle, nextAction implement
- доказ: `red-test-run.json`

GREEN: та сама команда з `--phase hotfix`

- CLI exit 0, outcome `passed`, runId `cb0fb0cf-b79d-4d58-adac-793b8ae945b8`
- 5 passed, knownRed/unexecuted/unknown порожні, cleanup complete, groupState complete, nextAction complete
- доказ: `hotfix-test-run.json`

Проміжний прогін `2861e076-690b-42d8-86c8-475e65b24af1` впав на `require is not defined` у тесті після того, як гейти вже пройшли. Прогін `77df5883-2f2f-4cc9-ad5f-11d6f25351a5` впав на чужому коментарі в `src/codex-raf-command-access.ts`, який ламав fixture build. Коментар прибрано, файл не входить до цього коміту.
