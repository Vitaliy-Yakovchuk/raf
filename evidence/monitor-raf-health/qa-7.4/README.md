# QA monitor-raf-health:7.4

Початковий unit QA: [unit-review.json](unit-review.json), runId `3844b20c-d809-4925-baef-2267807d8552`, 51 passed, CLI/child 0/0, timeoutCount 0, cleanup complete, knownRed/unexecuted/unknown порожні, groupState/nextAction complete. Повний незмінений TestRunResult, envelope CLI, stderr і CLI-код збережені окремими файлами. SHA та чужі незакомічені зміни під час запуску — [workspace-before-unit.json](workspace-before-unit.json). HOME та стабільна група monitor-raf-health/summary успадковані від переданого агрегату.

Аудит: proposal Why/What Changes/Non-goals, tasks 7.1–7.4 та «Джерела за етапом», повна вимога «Підсумок стану для main», design «Архітектура та стан»/«Вікно CPU та підсумок», адресні background-runtime/event-registry/reminders узгоджені. 7.3 закритий; його runtime-smoke прямо вказує liveWorkerQA=false. Потрібен незалежний живий прохід. Інші пункти відкриті; архівація не застосовується.

Main підтвердив відсутність готового стенда та погодив підготовку host-скрипта з подальшим review/запуском на чистому клоні. Скрипт `scripts/qa-health-summary-host.mjs` використовує ізоляцію та реальний CLI/tmux/worker за зразком CPU QA і чинний agentRunFixture. Синтетичний лише термінальний runner. Production HOME, секрети й мережеві провайдери не використовуються. Стендовий summaryIntervalMs=30000; production conf не змінюється, решта health/costProfile/timeout policy з джерельного conf. Фікстурні admission thresholds не перевіряють production admission.

Команда для main після review на чистому клоні:

```sh
node scripts/qa-health-summary-host.mjs /srv/dev/raf-mrh74-evidence-1
```

Матриця: CLI підтверджує service stopped; main offline; живий worker сам створює due і лишає pending; повернений main отримує рівно один факт через справжній tmux, runner його не отримує; worker завершується; три фактичні стендові інтервали без runtime-команд не створюють фактів; наступний CLI створює один delayed-період із фактичними межами, конкурентні повтори не дублюють доставку. Окремо перевіряються точна відмова missing recipient, health CONFIGURATION_INVALID із pointer при успішній stats та незмінні commands/profile.

До отримання та незалежного перегляду повних host-доказів пункт 7.4 залишається відкритим; unit pass не замінює стенда. Галочку tasks.md ставить raf.
