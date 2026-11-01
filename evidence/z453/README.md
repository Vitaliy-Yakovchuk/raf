# complete-raf-flow-contracts:Z.453

Виправлено orphan handoff: коли starter підтверджено помер, а сесія все ще `reserved`, production reconcile зупиняє належний worker і його tmux runner, підтверджує завершення та передає звільнення task/resource claims чинному reconcile. Виклики підключено до `control.ps`, резервування нового запуску та reconcile черги. Живий starter зберігає handoff; невідоме спостереження або непідтверджена зупинка зберігають резерв. Перед побічними діями повторно перевіряються lease/fence, wrapper і стан сесії. Після зупинки очищується кеш спостережень поточного `ps`.

Таймаути й політики не додавались: використано наявні runner protocol budgets, перевірку OS ownership та зупинку власної tmux-сесії. Загальний reservation-layer, де живий wrapper може пережити caller, не змінено.

Аудит: доручення Z.453 у `openspec/changes/complete-raf-flow-contracts/tasks.md` актуальне; межі proposal Why/What Changes/Non-goals та чинний контракт `projects/raf/session-recovery` узгоджені з варіантом «зупинити й звільнити». Історичний стан wrapper main не зберіг, тому регресія перевіряє обидва стани wrapper. Справжній історичний run не змінювався; тест створює окремий OS worker і runner у fixture tmux server та викликає production services з ізольованою SQLite.

| Прогін | runId | Результат | CLI / child |
| --- | --- | --- | --- |
| red | d3a052fa-e7a7-415b-874b-3d3d58126a25 | assertions-failed: actual `reserved`, expected `finished`; 2 passed, 1 knownRed | 1 / 1 |
| hotfix | 76df918a-e7e1-42e1-b994-5f365e99c4bd | passed, 3/3 | 0 / 0 |
| hotfix-final | 1813b9c5-f8e0-4cf9-a54d-fd4b01c81e4f | passed, 98/98 | 0 / 0 |

Усі прогони мають `timedOut=false`, `cleanup.complete=true`, порожні remainingPids, `timeoutCount=0`, unexecuted і unknown. Після red: groupState idle, nextAction implement; після обох hotfix: complete/complete, knownRed порожній. Група `complete-raf-flow-contracts/z453` і QA HOME незмінні; фінальний відбір розширено тим самим списком `--files` на task-reservations та agent-queue-start-result.

П'ять фінальних регресій перевіряють живий worker з мертвим starter, живий starter, мертвий worker з живим runner, невдалу зупинку tmux зі збереженням claims і наступним успішним reconcile, невідоме спостереження без зупинки процесів. Перший сценарій також перевіряє resource claims і повторний `ps`.

Повні команди, відбір, SHA та незакомічені зміни, SHA-256 джерел і стан групи: [runs.json](runs.json). Повний diff власної реалізації й фінальної регресії від початкового HEAD: [source.patch](source.patch). Під час роботи інші виконавці рухали спільний HEAD; власна реалізація не змінювалася між двома hotfix, після фінального прогону джерела не редагувалися. Деталі обмежень фіксації SHA наведено в runs.json.

Повні незмінені об'єкти TestRunResult: [red](red.result.json), [hotfix](hotfix.result.json), [hotfix-final](hotfix-final.result.json). stderr і CLI exit code лежать окремо в однойменних `.stderr` та `.cli-exit-code`; `exitCode` усередині TestRunResult є кодом child.

Transport першого red урізав середину stdout. Повний результат відновлено з `lastResult` тієї самої QA SQLite до наступного прогону: [незмінений payload агрегату](red.group.json), а red.result.json містить дослівний JSON-підрядок lastResult. Усі поля й діагностики збережено, нічого не доповнювалося вручну. stderr збережено з наявного хвоста transport. [Первинний transport](red.transport.json) залишено разом із позначкою його truncation. Red не повторювався; групу/HOME не скидали. [Початкові три тести](red-regression.test.ts.txt) відтворено з фінального файла видаленням лише двох доданих після першого green сценаріїв.

`npm run build` в ізольованому QA HOME та `git diff --check` завершились кодом 0: [build.json](build.json). Реєстрацію групи в спільному conf включив main до e665c58d87bc8b70e6160337a8dfef2abfbbc63a; це не власний коміт виконавця. tasks.md не редагувався. Інші пункти зміни відкриті, архівація не виконується.
