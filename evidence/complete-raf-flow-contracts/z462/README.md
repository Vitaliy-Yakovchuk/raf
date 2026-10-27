# Z.462 — перепідключення через stop → swap symlink → start

Чинний дефект підтверджено: production watchService уже спостерігає новий ready serviceEpoch, але після service_stopped клієнт робив лише один refreshEndpoint. У проміжку зупинки це null або старий epoch, тому завершувався RESOURCE_WAIT_FAILED замість очікування.

Фікс у runResourceWaitCommand чекає наявний watcher після service_stopped або закриття каналу до ready. Новий запит отримує новий ticket/epoch; старі frames не дають permit. Після ready автоматичного перепідключення немає. Скасування перериває очікування й прибирає канал/watcher. Без watcher terminal service_stopped зберігається без спроби запуску служби.

Докази (повний незмінений TestRunResult — *.result.json; команда, CLI та child exit окремо — *.cli.json; повний повернутий stderr — *.stderr.txt):

| Прогін | runId | Фактичний результат |
| --- | --- | --- |
| red | 38ac15d3-6e8b-4781-a25b-921f89ebe59d | 7 нових assertion failures: agent/test × no endpoint/old epoch/closed, cancellation; CLI/child 1/1 |
| hotfix-interrupted | 163f4406-9aa2-458d-aec1-4998a0b1ab37 | SIGINT від main, cleanup complete; не pass і не timeout |
| hotfix | 6bfa50ea-2236-4d29-9adb-10ae7cb0c80e | 105 passed, child 0; CLI 1 через 14 успадкованих knownRed поза відбором |
| integration-first | ecbc4d48-438c-4c15-af98-bdf588aee1ca | Нові 2 swap-сценарії passed; 2 старі stop-сценарії виявили втрату terminal diagnostic без watcher |
| terminal-stop-red | 9b6cb769-c2b6-47ea-8e25-6cbad2561d2c | Новий assertion failure terminal stop без watcher до відповідного виправлення; CLI/child 1/1 |
| final-unit | d1a8f0a5-2b1b-4b7f-9713-be3609f68fe4 | 106 passed, diagnostics [], child 0; CLI 1/outcome assertions-failed через ті самі 14 успадкованих knownRed поза відбором |
| final-integration | 71cc5089-407b-4739-90f0-dd88059fd9b8 | 4 passed, CLI/child 0/0, knownRed/unexecuted/unknown [], group complete |

Усі прогони мають timedOut=false і cleanup.complete=true. Unit group незмінна complete-raf-flow-contracts/resource-wait, timeoutCount=0; остаточні groupState=idle і nextAction=fix-implementation належать агрегату з 14 сторонніми knownRed, це не зелений агрегат. Усі 8 нових unit-регресій Z.462 підтверджено в passed; unexecuted/unknown порожні. Сторонні knownRed не скинуто й не виправлялись; main повідомлено. QA HOME однаковий у всіх результатах.

Перерваний hotfix мав хибну стару фікстуру Z.450: current змінювався на новий epoch, але watcher promise завершувався лише в stale-open-channel варіанті. Додано сповіщення watcher для closed/service-stopped; assertions незмінні. Після підтвердженого SIGINT і повного cleanup виконано повтор у тій самій групі/HOME.

Інтеграція використовує справжні процеси служби, Unix socket, OS identity/fence, SQLite queue/lastGrant і дві generation-теки. Після stop клієнт підтверджує спостереження недоступної служби та лишається живим, symlink атомарно перемикається, друга служба стартує з іншого cwd/PID/epoch. Agent/test отримують permit тільки нового epoch. Ресурсний snapshot керований фікстурою; це перевірка сервісного транспорту/перемикання, без запуску AI runner чи доступу до production HOME.

SHA і workspace: workspace.json фіксує спостережені HEAD (спільний HEAD рухався іншими агентами), red.workspace.patch — власні тести до зміни продукту, terminal-stop-red.workspace.patch — стан до другого фіксу, final.workspace.patch та summary.json — остаточний diff і SHA256 кожного власного code/test файла. Власний коміт указано у звіті. git diff --check і npm run check:comments пройшли.

Аудит: tasks.md:Z.462 і чинний resource-wait контракт підтверджують актуальність задачі. Змін flow/лімітів/конфігурації немає. tasks.md не редагував; інші пункти відкриті, архівація не виконується. Push/активацію не виконував.
