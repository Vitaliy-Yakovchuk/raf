# Z.456 — discovery за testNamePattern

Доручення актуальне: reporter перелічував усі `allTests()` незалежно від налаштованого профілем `testNamePattern`. Регресія відтворює 180 старих пропущених тестів і 30 вибраних успішних. Вона перевіряє кінцеву класифікацію, discovery та expected inventory. Додаткові сценарії охоплюють вкладені назви, прапорці RegExp, точні IDs, явно skipped тести, відсутній і незбіглий pattern.

Виправлення читає ефективний `module.project.serializedConfig.testNamePattern`, який Vitest передає runner-у з урахуванням overrides. Порівняння повного імені через `String.match` відповідає Vitest runner. До discovery/expected потрапляє перетин pattern та точного відбору. Явно skipped усередині профілю залишаються unexecuted; порожня колекція не стає pass. Нових вимог чи обмежень немає.

Повні команди та результати: [manifest.json](manifest.json). Незмінені JSON TestRunResult, stderr, CLI exit code та повний transport збережені окремими файлами для кожного запуску. Workspace HEAD, незакомічені зміни та SHA256 власних файлів до прогонів записані у `*.workspace-before.txt`. У спільному дереві HEAD рухався через інші коміти; QA HOME й назва групи збережені.

| Прогін | runId | CLI / child | Результат |
| --- | --- | --- | --- |
| red | 241ca8fb-532d-4199-8401-4fe1bed1733a | 1 / 1 | assertions-failed: 5 red, 2 passed |
| hotfix | b9865696-b39d-4dda-a982-c30c156c11a3 | 0 / 0 | 7 passed |
| z416-protocol-size | ca74a699-bd9a-4524-a18f-c8cc285174a3 | 0 / 0 | 15 passed |
| add-raf-test-run/etchly-profiles | ca71af20-8ff5-43a4-9e86-17098be4860d | 0 / 0 | 98 passed |

Усі запуски: timedOut=false, timeoutCount=0, cleanup.complete=true, remainingPids=[]; unexecuted=[] і unknown=[]. Після hotfix/regressions knownRed=[], groupState=complete, nextAction=complete. Початковий red мав groupState=idle, nextAction=implement. Child отримав ізольований QA HOME з TestRunResult; попередження frozen CLI про робочий state збережені у stderr, вони не описують HOME дочірнього тесту. Метрики resourceUsage залишаються partial/unknown так, як повідомив wrapper; це не приховано.

Збірка каталогу в тому самому QA HOME завершилася CLI 0; `git diff --check` пройшов. Це unit-доказ; історичний Etchly-прогін повторно не запускався. Конфігурація групи змінена in-place після узгодження з main, її точний патч збережений у `conf-test-runs.patch`. Чужі файли та tasks.md не редагувалися. Інші пункти зміни відкриті, тому архівації немає.
