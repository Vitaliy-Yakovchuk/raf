# Hotfix 1.6: close reserved launch

Аудит: чинний tasks.md:1.6 вимагає закриття reserved arcsm-1-1 без живих процесів. Реалізація до виправлення відхиляла цей стан у AgentControlService.closeSelected; вимоги projects/raf/session-recovery про доказ смерті, атомарне звільнення та відсутність автоматичного resume збережено. Proposal описує початкові 1.1–1.2, конкретний розширений обсяг 1.6 визначено дорученням та чинним tasks.md.

Стабільна група `fix-raf-test-run-selection-aggregate/reserved-close`, профіль node. QA HOME усіх чотирьох прогонів однаковий: `/tmp/raf-unit-1000/1ee10007bf6d5e71b39d6a2873064a767eeb928e7910599b166a0d60270ff685`. Base SHA і точні незакомічені snapshots — workspace.json, *workspace.patch, *regression.test.ts.txt. Повні незмінені результати скопійовані з файлів raf; *.tool.json зберігають отриманий tool output, *.stderr.txt — доступний stderr окремо, *.cli.json — CLI code окремо від child exitCode. У red-final/hotfix-first/hotfix-final tool output урізаний, але всі TestRunResult повні. Повторів лише заради логів немає.

| Етап | runId | Результат | CLI / child | Passed / knownRed |
|---|---|---|---|---|
| RED | 1a01bd94-2cd7-4353-be22-79c38a6c8d65 | assertions-failed | 1 / 1 | 1 / 8 |
| RED після розширення сценаріїв | 44056498-4fd5-4f6b-a26b-9672b62d2be9 | assertions-failed | 1 / 1 | 1 / 11 |
| Перше підтвердження | 54e09e5f-8431-4a48-b8f0-5741db843c00 | assertions-failed | 1 / 1 | 158 / 2 |
| Фінальне підтвердження | b4621277-6411-423e-88c5-a28da28e8850 | passed | 0 / 0 | 160 / 0 |

Для кожного прогону cleanup.complete=true, remainingPids=[], timedOut=false, timeoutCount=0, unexecuted/unknown/removed=[]. Фінальні knownRed=[], groupState=complete, nextAction=complete. Жоден setup/import failure не зараховано як RED.

RED команда (обидва прогони):

```sh
node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase red --group fix-raf-test-run-selection-aggregate/reserved-close --files test/agent-close-reserved.test.ts
```

Підтвердження (обидва прогони):

```sh
node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-test-run-selection-aggregate/reserved-close --files test/agent-close-reserved.test.ts test/agent-control.test.ts test/reservation-recovery-z401.test.ts test/agent-close-exit.test.ts test/task-reservations.test.ts
```

Регресія відтворює reserved з task/admission reservations через production control entry, без справжніх моделей чи керування процесами. Перевірено starting, handoff, worker без task lease, доказ відсутності, alive/unknown, живий starter при мертвому wrapper, перехід у running, зміну lease, rollback транзакції, повтор close, збереження чужого admission reservation та один agent.closed.

У першій RED фікстура гонки помилково змінювала сесію вже під час авторизації main. Уточнено тригер лише для probe процесів запуску, додано rollback і lease race; другий RED до реалізації підтвердив 11 падінь. Перше підтвердження виявило два падіння повторного close: finished worker уже не має launchContext. Виправлено порядок closeWorker — підтверджений вихід перевіряється до завантаження протоколу. Очікування тестів не послаблено.

Рішення повторно використовує чинний boot/process ownership probe із task-reservations. Вихід усіх записаних процесів перевіряється до транзакції; поточні session і task lease порівнюються з вибраними snapshots усередині транзакції. Там само фіналізуються сесія, task/admission reservations, повернення делегованої роботи, reminder effect і agent.closed. У finished observation зберігаються PID і час доказів. Запуск, який не дійшов до running, не отримує вигаданого succeeded.

Статичні перевірки: git diff --check та node scripts/check-comments.ts в тому самому ізольованому QA HOME — exit0. Registry conf/test-runs.json комітить main, запис передано через agent message. 1.6 checkbox ставить raf. 9.1 відкрита: main активує hotfix, штатно закриває живу reserved arcsm-1-1 і повторно доручає arcsm1.1. Цей виконавець не змінював живий стан, не активував hotfix і не архівував зміну.
