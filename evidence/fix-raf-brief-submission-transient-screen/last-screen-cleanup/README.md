# fix-raf-brief-submission-transient-screen:1.2

Кадр readiness/delivery зберігається у приватному `tmpRoot/.last-screens/<runId>/last-screen.txt`, окремо від теки запуску, яку прибирає `cleanupUnstarted`. Маскування та режими 0700/0600 збережено; таймаути, ліміти й flow не змінено.

Регресія `last-screen survives readiness failure and production cleanupUnstarted` виконує `runLaunchWrapper` з ізольованим транспортом, включно з підтвердженням stop/exit і видаленням report watcher, а потім справжній `createProductionServices(...).prepareReport(...).cleanupUnstarted()`. Після видалення runtime-артефактів читає кадр за шляхом із помилки, перевіряє маскування й недоторканність іншого запуску. Зовнішні провайдери не використовуються.

Первинний red: `20383393-3ee9-4982-9c89-cfea26dc2363`, CLI/child 1, assertions-failed: ENOENT при читанні кадру після production cleanup. 33 passed, 1 knownRed; setup/import failure немає. Підтвердження hotfix: `35881623-b9d7-4475-a569-601e26700b94`, CLI/child 0, 34 passed. В обох cleanup complete, timedOut=false, timeoutCount=0, unexecuted/unknown порожні. Фінально knownRed=[], groupState=complete, nextAction=complete.

Стабільна група та QA HOME успадковані від 1.1; агрегат не скидався. [summary.json](summary.json) містить точні команди й посилання на повні незмінені TestRunResult, stderr, окремий код CLI, транспорт та SHA/status/patch робочого дерева для кожного прогону. Патчі workspace також фіксують паралельні незакомічені правки; кодовий коміт містить лише власні шляхи. Сусідній тест 1.1 адаптовано за погодженням з автором тільки для отримання шляху з помилки; перевірки вмісту, часу й маскування збережено.

`test/agent-run-fixture.ts` виключає `.last-screens` зі списку тек запусків: збережений доказ не є живим запуском. Перевірки видалення runDir та завершення процесів залишаються.
