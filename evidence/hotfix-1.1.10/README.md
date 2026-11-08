# 1.1.10: успадкування compile cache і фікстура активного стану

Результат: фікстура production main CLI з п’ятьма вже запущеними агентами дає **2373.834 мс raf-overhead < 3000 мс**. Стара cold-hotfix фікстура дає **2811.779 мс**. Це приватні QA HOME; живий повтор після активації виконує main. Батьківський бюджет на цій новій фікстурі не виміряний, тому ці числа не доводять величину прискорення живого сервісу.

## Причина і зміна

`bin/raf.ts` вмикав Node compile cache лише у своєму процесі. `executeCommand` і detached worker не передавали його дочірнім Node-процесам. Перша власна регресія, написана до production-виправлення, довела це assertion-падінням: helper в ізольованому environment повертав відсутній `getCompileCacheDir()`.

`nodeHelperEnvironment` зберігає явно заданий cache/disable і додає каталог активного cache до environment helper-а. Його використовують звичайний executor та persistent wrapper; wrapper також публікує cache через `flushCompileCache()` перед запуском worker-а. Node сам визначає валідність записів за шляхом і версією. Нового кешування конфігурації, assignment, стану або результатів перевірок немає.

У `launchAgent` додано приватні часові мітки configuration/services/assignment/task-context/workspace/write-boundaries/selection. Мітки накопичуються в пам’яті й пишуться у вже наявний launch timeline після створення report directory. Це дозволяє розкласти наступний живий інтервал cli-start → brief-start без нових елементів інтерфейсу.

## Перевірка залежності від стану

`profile-preparation.mjs` читає лише SQLite backup живого state.sqlite; runtime пише тільки в тимчасову копію і видаляє її. Використано production adapter без підміни executor-а. Знімок містив 365 сесій (360 finished, 5 running), 450 notices і 333 intents. Збережені лише лічильники й тривалості, без payload сесій: [preparation-profile.json](preparation-profile.json).

| Дія на копії живого стану | мс |
| --- | ---: |
| Імпорт production runtime | 100.8 |
| Відкриття SQLite | 7.3 |
| Перевірка assignment цієї зміни через OpenSpec | 464.3 |
| Формування task context | 24.3 |
| Вибір цільового runner-а | 50.4 |
| Визначення main / hotfix шляху | 1.5 / 0.4 |

Це не відтворює всі 1568 мс старого живого запуску і не доводить, що лише compile cache пояснює весь розрив. Відкриття SQLite на цьому знімку коротке; найбільша виміряна частина підготовки — OpenSpec. Наступний живий запуск має нові мітки для точної локалізації залишку.

## Фікстура й гарантії

`test/launch-live-state.test.ts` і `test/launch-live-state-fixture.ts` запускають production CLI з зареєстрованого main шляху, worker, реальні tmux, resource admission, Codex sandbox, справжній Codex app-server для hook inspection, lifecycle та response. Спочатку запускаються п’ять агентів із різними task reservations; їхні сесії залишаються running до й після вимірюваного шостого запуску. Стан перед виміром: 406 історичних + 5 running сесій, 486 notices (115 pending), 227 reminders і 300 intents. Main шлях має власну копію production-коду, як при активації; він не підмінений develop entrypoint-ом.

Синтетичні тільки native screen/status і прийняття brief. Затримки збережено: перший екран 531 мс, status 2816 мс, прийняття brief 2624 мс; окремі assertions звіряють фактичні status/acceptance інтервали. Вимір віднімає лише readiness та delivery; усі інші етапи входять до raf-overhead. Перевіряються native identity перед delivery, delivery перед handshake, workspace-write policy і `hooks.state` у фактично запущених аргументах runner-а. Ліміти, таймаути й production-гарантії не змінено.

Остаточний вимір із п’ятьма активними агентами:

| Етап | мс |
| --- | ---: |
| wall | 9648.834 |
| readiness + delivery | 7275 |
| raf-overhead | **2373.834** |
| cli-start → brief-start | 616 |
| services-end → assignment-end | 469 |
| worker-start → command-access-start | 198 |
| command-access | 219 |

Повний розклад — diagnostics у [green-3.TestRunResult.json](green-3.TestRunResult.json).

## Виправлення помилки старої фікстури

Перший спільний прогін виявив подвійний status callback синтетичного runner-а. Два Enter під час `statusPending` планували два callbacks; другий очищав уже pasted brief, тому прийняття не наставало. Незмінені докази: [events](fixture-duplicate-status.events.jsonl), [timeline](fixture-duplicate-status.timeline.jsonl). Main підтвердив цю причину й дозволив правку `test/launch-budget.test.ts` повідомленням у сесії: guard `if (statusPending) continue` моделює один callback справжнього Codex. Бюджет, затримки та assertions старого тесту збережено. Історичний synthetic-codex.mjs не змінено.

## Прогони

Усі команди мають префікс `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf`, незмінну групу `fix-raf-cli-live-latency/live-latency` і той самий ізольований QA HOME, який визначає raf. Команди не перенаправляли вивід. Кожний `*.TestRunResult.json` — повна незмінена копія файла, названого raf у stderr; `*.stderr` та `*.cli-exit.json` збережено окремо. Результати й stderr не обрізані; первинний RED stderr відновлено з того самого tool-output, що прямо зазначено в його cli-exit metadata. Великі повторні tool results збережено для перевірки захоплення stderr.

| Доказ | Фаза й `--files` | runId | Результат |
| --- | --- | --- | --- |
| [red](red.TestRunResult.json) | red; test/launch-live-state.test.ts | b6285ad8-e9df-4b1b-8292-244dd4fa2608 | assertions-failed: helper без compile cache; CLI 1, child 1 |
| [green-1](green-1.TestRunResult.json) | hotfix; test/launch-live-state.test.ts test/launch-budget.test.ts | 5247b658-f4d3-452e-9ad1-1e94dea8019e | setup-failed: duplicate declaration у власній фікстурі; окремо стара фікстура зависла через подвійний status callback; main зупинив власний fixture worker PID 3910895 після identity-перевірки; cleanup complete |
| [green-2](green-2.TestRunResult.json) | hotfix; test/launch-live-state.test.ts | 047598e1-682c-4504-9ad1-43d54a838b13 | assertions-failed: invocation.json існує лише для hotfix; це не прийнятий бюджетний доказ. Виправлено читання реальних runner args; прибрано тимчасовий environment marker фонового runner-а |
| [green-3](green-3.TestRunResult.json) | hotfix; test/launch-live-state.test.ts test/launch-budget.test.ts | e1bb241f-a05c-438b-b542-cf1b5f210e70 | **3 passed**, CLI 0, child 0; обидва бюджети виконано |
| [compatibility](compatibility.TestRunResult.json) | hotfix; test/os-runtime.test.ts test/cli-agent-run-startup.test.ts test/launch-overhead.test.ts test/launch-timeline.test.ts | 4c08c77b-6bbd-41f6-9ac9-5be6c4d60561 | **39 passed**, CLI 0, child 0 |

У всіх прогонах timedOut=false і cleanup.complete=true, remainingPids=[]; timeoutCount=0. Остаточні два результати: knownRed/unexecuted/unknown=[], groupState=complete, nextAction=complete. ResourceUsage позначає неповноту обліку піків; це не використано як доказ повної ресурсної телеметрії. Чотири stderr warnings стосуються сторонніх etchly registry entries.

Базова ревізія: `6ea805b4e8f4f313471cee666409598231f89e18`. Під час фінальних прогонів спільний HEAD уже мав чужий незалежний коміт `ebbc1c7f9ed5c705c2944b5b744e13d0a11abca9`; власні правки були незакомічені. Початкові й фінальні SHA-256 файлів: [workspace.json](workspace.json), [workspace-final.json](workspace-final.json). Production-код після фінальних GREEN не змінювався. `node scripts/build.ts` і `git diff --check` пройшли.

## Реєстр, передача й читабельність

Реєстр доповнено in-place до першого RED: project=raf, node.unitFiles і groups[fix-raf-cli-live-latency/live-latency].files += test/launch-live-state.test.ts. Повна передача: [registry-handoff.json](registry-handoff.json); main підтвердив власний коміт e1eebc5f8e. Це не власний коміт виконавця. Helper-файл не є окремим unit entry.

Область самоперевірки: `nodeHelperEnvironment`, `executeCommand`, `launchPersistentWrapper`, `launchAgent`, нова фікстура й змінений `configureRunners` старої фікстури, від базової ревізії до власних фінальних правок. Helper має одну відповідальність і ранні повернення; явно задане environment не мутується. Executor лише передає результат helper-а. Wrapper явно готує environment, публікує cache і запускає child у попередньому порядку. `launchAgent` явно додає часові мітки до окремого локального масиву й публікує після створення run directory; існуючі перевірки та порядок запуску збережено. Фікстура послідовно готує дані, запускає п’ять агентів, вимірює шостого й перевіряє інваріанти; власні процеси прибирає існуючий identity-based fixture cleanup. Результат поведінкових перевірок — 42 passed у двох фінальних відборах. Нових службових підписів для користувача немає.

Живе значення 3.93 с не оголошується виправленим без запуску main після активації. Передача main: бюджетні GREEN, приватні мітки й потреба живого повтору; активація/push не виконувалися. Один agent message отримав MESSAGE_NOT_ACCEPTED, exit 1, через unrelated composer input; його не вважаємо доставленим. Подальше повідомлення про GREEN прийнято: receipt `46c0f61a-85d9-42d9-8f77-e0be8438bb4f`.
