# fix-raf-load-admission 10.1

Виконавець: raf-flaq101-hotfix. Доручення: лише 10.1 та передане main уточнення щодо force close сесії exited із живим native/worker. Код: `5964028bbe1a470af96b48dabedfb93156c847a5`; регресійний scaffold закомічено до реалізації: `d3b42d0c700bad2d221c0b529975963fc7690112`, `388bdbb42663e94efeaa7c54f9c2eeb25f3585ab`.

## Аудит і причина

Звірено proposal Why/What Changes/Non-goals, tasks 10.1, профільні вимоги agent-run та чинний model-routing handoff із complete-raf-flow-contracts. Доручення актуальне: завершення reserved readiness failure створювало modelHandoff; його обробляв наступний сторонній CLI, який повторно визначав launchedBy зі свого caller. Finished-запис втрачав початкового адресата. Кешований process snapshot міг передувати старту нового native. Force close exited ішов одразу у finalize й отримував WORKER_RESULT_PENDING перед зупинкою живого native.

Виправлення не змінює затверджену передачу роботи після підтвердженої квоти чи завершення готового агента. Reserved startup refusal не створює handoff; старі aborted handoff очищаються без запуску. Автор фіксується у записі черги, переноситься у successor та зберігається у finished. Спостереження до startedAt/останнього спостереження відхиляються; старий кеш процесів оновлюється. Production observe/finalize і далі перевіряють worker перед завершенням. Force close exited перевіряє identity, фіксує reason та використовує штатний transport зупинки native й очікування worker. За незавершеної обробки повідомлення містить worker.log і команди відновлення/звірки.

## Прогони

Група незмінна: `fix-raf-load-admission/queue-lifecycle`, profileId `node`, лише `test/launch-queue-lifecycle.test.ts`. Main зареєстрував її в Orchestrator `d1d650d6c4`. В усіх прогонах той самий ізольований HOME `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`. Агрегат не скидався, відбір не звужувався.

| Доказ | runId | Фаза | Outcome | CLI / child | passed / knownRed | Група / наступна дія |
| --- | --- | --- | --- | --- | --- | --- |
| [red](red.TestRunResult.json) | fc614037-f900-42c9-aa8c-cd9472f733ea | red | assertions-failed | 1 / 1 | 0 / 9 | idle / implement |
| [hotfix-1](hotfix-1.TestRunResult.json) | 879101e3-e3ac-4688-870d-e75c96da6cb1 | hotfix | assertions-failed | 1 / 1 | 8 / 1 | idle / implement |
| [hotfix-2](hotfix-2.TestRunResult.json) | 3fcf306c-5eec-479b-9a50-e8f48d49b090 | hotfix | passed | 0 / 0 | 9 / 0 | complete / complete |
| [hotfix-3, фінальний код](hotfix-3.TestRunResult.json) | 838459a0-021e-439c-af27-9f52bce7ef51 | hotfix | passed | 0 / 0 | 9 / 0 | complete / complete |

Початкові дев'ять red — предметні падіння assertions/реалізації, не setup/import failure. Hotfix-1 виявив пропущений finishedAt у fake coordinator.finalize; додано часову мітку без послаблення перевірок зупинки native перед finalize. Hotfix-3 повторено після уточнення повідомлень відновлення worker.

Для кожного прогону є повний незмінений `*.TestRunResult.json`, окремі `*.stderr.txt`, `*.cli-exit-code.txt` та сирий результат інструмента `*.transport.json`. CLI повертає TestRunResult у stdout, launch-queue.waiting — у stderr; порядок їх відображення у transport може відрізнятися. Збережені рядки JSON і stderr перевірені побайтово проти transport. `*.workspace.json` містить точну команду, SHA, відбір, source SHA-256, outcome, cleanup/timeout, knownRed/unexecuted/unknown і стан групи; `*.workspace.patch` відтворює власний diff від scaffold HEAD. Для ранніх прогонів SHA/власний diff відновлено з Git та послідовності правок після прогону; миттєвого повного snapshot чужих незакомічених файлів немає. Фінальний перевірений вміст відповідає code commit вище.

В усіх чотирьох TestRunResult: timedOut false, timeoutCount 0, cleanup.complete true, remainingPids [], unexecuted [], unknown []. Часткова достовірність resourceUsage збережена як повернуто CLI; вона не видається за повний вимір піків.

Окремий [невдалий вхід](hotfix-entry-refused.json): помилково додана shell-команда редагування перед test run залишила виклик у sandbox, де він повернув PRODUCTION_ENTRY_FAILED/EROFS, CLI 1 до створення TestRunResult. Це не red/pass, дочірній тест не стартував. Після встановленої причини використано дозволену окрему просту команду; HOME/агрегат не змінювалися.

Додатково `git diff --check` і `node scripts/check-comments.ts` — CLI 0.

## Межі доказів і завершення

Production run 4390d639, worker 903652/native 903789 та спроби main close відомі з повідомлень main. У sandbox ці PID не видимі через /proc, production HOME/log/state.sqlite недоступні за профілем доступу. Прямого читання production SQLite або worker.log не було; процеси не завершувалися й стан не змінювався. Main повідомлено про завершення доступного дослідження. Валідація виправлення — ізольовані unit-регресії, activation/push виконує main.

Галочки 10.1 виконавець не змінює. Пункти 4.3 і 7.1 відкриті на момент завершення; інші пункти не виконувалися, sync/archive відсутні.
