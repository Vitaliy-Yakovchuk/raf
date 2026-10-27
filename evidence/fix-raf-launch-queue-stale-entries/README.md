# fix-raf-launch-queue-stale-entries:1.1

Виправлено конкретне вікно зависання живого клієнта: epoch watcher запускався лише після connect/enqueue. Якщо ticket старої служби не приходив, клієнт не бачив нову службу, а нові запити проходили. Watcher тепер охоплює підключення та очікування ticket; за нового epoch старе з’єднання закривається і клієнт реєструється повторно. З’єднання, яке завершило підключення вже після перемикання, теж закривається. Нових лімітів/таймаутів немає.

Історичні спостереження main (generation 122, два живі CLI, пізніші запуски та успішний повтор після SIGTERM) сумісні з цим дефектом, але без логів тих клієнтів точний історичний механізм не доведений. Регресія ізольовано відтворює pending enqueue старого epoch, потім новий запит same/lower tier. Після повернення ресурсів старий клієнт отримує permit першим, наступний — із чинним глобальним інтервалом. Пов’язані тести перевіряють також hotfix перед normal, FIFO, commit та невизначену доставку після ready.

Група `fix-raf-launch-queue-stale-entries/unit`, один незмінений QA HOME в обох результатах. Команди повністю збережені у `red.cli.json` і `hotfix.cli.json`; дочірній `exitCode` відокремлений від CLI-коду.

| Фаза | runId | Outcome | CLI / child | timeout / cleanup | Стан / наступна дія |
| --- | --- | --- | --- | --- | --- |
| red | 5f850940-2987-4bbc-a602-af10e19bd8fd | assertions-failed, 3 assertion failures | 1 / 1 | false / complete | idle / implement |
| hotfix | cdf48a77-8a9a-4311-9315-25cec2f58d35 | passed, 125 tests | 0 / 0 | false / complete | complete / complete |

Red містить 3 knownRed, unexecuted/unknown порожні. Hotfix має порожні knownRed/unexecuted/unknown/removed. timeoutCount=0 в обох. Setup/import failure не використовувався як red. Повні незмінені JSON — `red.result.json`, `hotfix.result.json`; stderr — окремі `*.stderr.txt`. Transport не обрізав результат. Облік resourceUsage частковий, що прямо позначено у результатах і не підміняється повним виміром.

`workspace.json` містить повний base SHA, хеші власних файлів і чесний опис спільного незакоміченого дерева. `red.source.ts.txt` і `regression.test.ts.txt` відтворюють власний red-контекст, `hotfix.patch` — точне виправлення. Сторонні правки до коміту не включаються.

Аудит актуальності: proposal/tasks і чинна projects/raf/resource-wait «Єдина пріоритетна черга служби» узгоджені. skip_specs=true; нових вимог немає. Галочку 1.1 ставить raf після succeeded. Спроби узгодити з main через agent message завершувалися HANDLER_FAILED / Recipient composer contains unrelated input, completed=[], pending=[], retrySafe=true; жодна не видається за доставлену. Main надіслав історичні спостереження в цю сесію.
