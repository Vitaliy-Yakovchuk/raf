# complete-raf-flow-contracts:9.5 — тести меж shared-libs

Доручення test-scaffold виконано без реалізації фічі. Аудит чинних workspace-routing та agent-adapters підтвердив актуальність дефекту: перевірена залежність тієї самої гілки не потрапляє до workspaceBoundaries/commitRepositories у src/app-runtime.ts. Відкритий пункт 9.6 належить іншому implement-виконавцю; tasks.md не змінено.

## Контракт і поверхня

- openspec/changes/complete-raf-flow-contracts/specs/projects/raf/workspace-routing/spec.md — «Робоче дерево за проєктом і гілкою» з усіма сценаріями, зокрема та сама гілка без fallback та «Проєкт без залежності shared-libs».
- openspec/changes/complete-raf-flow-contracts/specs/projects/raf/agent-adapters/spec.md — «Виконавець комітить свою роботу»: права дерева/Git, межі брифу, власні репозиторії.
- openspec/changes/add-raf-test-run/specs/core/process/feature-test-authoring/spec.md — чинна вимога «Агент тестів і каркаса», що дозволяє читання production-коду та вимагає власний red-прогін.
- openspec/specs/core/process/unit-test-runs/spec.md та openspec/changes/add-raf-test-run/specs/projects/raf/test-runs/spec.md — стабільна unit-група, реєстрація, ізоляція, загальний timeout.

Наявних повних сигнатур createAppRuntime, RuntimeLaunch, RuntimeServices.route, WorkspaceRouteResult.sharedLibrariesPath та AppRuntimeDependencies.resolveGitWriteBoundaries достатньо. Нових production-методів або класів немає, тому додаткового NotImplemented-каркаса не потрібно. Тестова fixture використовує існуючі порти, ізольовані тимчасові каталоги й symlink; Git-відомості, routing I/O, report preparation, state та adapter замінені unit doubles. Вона не запускає реальні Git, SQLite, tmux або runner. Справжні sandbox writable roots та прийняття живих commits цим unit-прогоном не доведені.

## Інваріанти

14 сценаріїв у test/shared-libs-launch-boundaries.test.ts:

- usesSharedLibs=true: для develop та release окремо перевірено канонічне дерево shared-libs, його git-dir/common-dir і репозиторій reported-commits. Launch, reservation, бриф, commitPaths та підготовлений контракт зберігають відповідні межі. Очікувані точні множини виключають іншу гілку, рекурсивну залежність, зайві roots та дублікати.
- usesSharedLibs=false або відсутній: навіть наявний локальний symlink не додає прав чи репозиторію бібліотеки й не запускає її перевірку.
- spec/design: перевірена залежність лишає код та Git-каталоги продукту/бібліотеки read-only; writable тільки доручені документи та Git Orchestrator.
- main/detached у залежній бібліотеці: відмова SHARED_LIBS_BRANCH_MISMATCH до report, reservation, brief і runner.

## Реєстрація і передача

Стабільна група всіх наступних етапів: `complete-raf-flow-contracts/shared-libs-launch-boundaries`.

Точний відбір: `test/shared-libs-launch-boundaries.test.ts`. [registration.json](registration.json) містить точні доповнення unitFiles/groups і передумови профілю node; main підтвердив реєстрацію в Orchestrator-коміті 27d6a88525. [before-red.json](before-red.json) містить фактичні SHA та конфігураційні fingerprints перед прогоном. Conf агент не редагував.

Автор виконав:

```sh
node /srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts test run --project raf --phase red --group complete-raf-flow-contracts/shared-libs-launch-boundaries --files test/shared-libs-launch-boundaries.test.ts
```

Результат: **assertions-failed**, 6 knownRed, 8 passed, 0 unexecuted/unknown, без setup/import failure. RunId `11f7179a-9bf7-46f8-87c9-a98d8ea0411a`, CLI/child exit **1/1**, 941 ms, timedOut=false, timeoutCount=0, cleanup.complete=true. Усі шість diagnostics мають kind=assertion: дві гілки × відсутнє дерево, Git-каталоги та репозиторій бібліотеки. Повний незмінений TestRunResult — [red-result.json](red-result.json); точна команда, exit та SHA — [red-command.json](red-command.json). Синтаксична перевірка `node --check test/shared-libs-launch-boundaries.test.ts` та `git diff --check` пройшли.

Main перевіряє цільові assertions перед передачею 9.6. Implement використовує ту саму команду з `--phase implement`; QA — з `--phase qa`. HOME та ledger визначає довірений канал raf, групу не перейменовувати й бюджет не скидати. Налаштований unit timeout — conf/flow.json#/unitTests/timeoutMs (1200000 на момент прогону).

Інші пункти зміни відкриті; sync/archive не застосовуються до цього доручення.
