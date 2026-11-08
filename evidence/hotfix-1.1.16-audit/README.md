# Аудит fix-raf-cli-live-latency:1.1.16

Дефект не підтвердився: критерій «Фаза в результаті має дорівнювати переданій --phase» вже виконано в самому первинному прогоні. Production-код, тести й реєстр не змінено; нових прогонів немає. Виправлення та RED/GREEN не виконувались, бо немає порушення контракту. Галочки виконавець не ставив, архівацію не виконував.

## Доказ

Повний незмінений результат — [original.TestRunResult.json](original.TestRunResult.json); походження, SHA256, команда, ревізія, відбір і коди попередника — [audit.json](audit.json). Це історичний доказ, а не новий прогін цього виконавця. У первинному stderr було обрізання; окремий повний stderr попередником не збережений і не реконструювався. CLI=1 взято з runs.json попередника; child exitCode=1 — із TestRunResult.

Run 6d2f9bc8-face-4e47-ba16-d52bf7f0e266: phase=red, callerPhase=hotfix, nextAction=implement, outcome=assertions-failed. Відбір test/cli-live-latency.test.ts, група fix-raf-cli-live-latency/live-latency. Cleanup complete=true, remainingPids=[], timedOut=false, unexecuted=[], unknown=[], timeoutCount=0, groupState=idle. KnownRed містить дві предметні регресії попередника: worker-launch-latency та cli-live-latency; це не регресії передачі фази й не доказ дефекту каналу. Поточний стан агрегату цим аудитом не перевірявся й не змінювався.

## Контракт і шлях даних

- openspec/specs/projects/raf/test-runs/spec.md:123–135: --phase вибирає підказку й мітку результату, може відрізнятися від фази виконавця.
- Там само:316–318: структурований результат посилається на integration-profile.md.
- openspec/changes/archive/2026-10-26-add-raf-test-run/integration-profile.md:67: «callerPhase з довіреного assignment або координувального контексту зберігає фактичну фазу caller».
- src/sandbox-test-run.ts, runSandboxTestCommand: parseTestRunArgs передає явний phase у requestArgs до wrapper, а локальний шлях передає вихідні argv до runTestRunCli. callerPhase окремо береться з assignment.phase.
- src/test-run-cli.ts, runTestRunCli: явний args.phase має пріоритет.
- src/test-runs.ts, baseResult: phase=request.phase; callerPhase=context.callerPhase. runTestRun: assertions у фазі red дають nextAction=implement, що відповідає переходу test-first до реалізації.

Попередній evidence/hotfix-1.1/verification-1.1.15/phase-finding.json помилково очікував callerPhase=red. Підміна цього поля фазою прогону приховала б фактичну фазу caller. Потрібна дія main — скоригувати/прибрати помилковий пункт, а не змінювати production.

## Рішення й самоперевірка

Висновок передано main двома підтвердженими повідомленнями; receipts і коди збережені в audit.json. Відповідь main у цій сесії: «висновок прийнято, 1.1.16 був помилкою main, пункт прибрано з tasks. Заверши звіт, коміть лише доказ аудиту».

Застосовано openspec/specs/projects/orchestrator/autonomous-development/spec.md, вимогу «Аудит та вилучення неактуальних змін». Результат пункту failed із причиною неактуальності, а не succeeded за невиконаний hotfix. Область самоперевірки читабельності production-функцій порожня: є лише доказ аудиту від ревізії в audit.json до власного коміту. Візуально звірено докази, контракт і простежуваність двох незалежних полів; перевірено байтову тотожність копії TestRunResult та git diff --check. Інші відкриті роботи зміни поза цим дорученням.
