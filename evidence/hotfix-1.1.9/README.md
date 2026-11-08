# fix-raf-cli-live-latency:1.1.9

Власна реалізація на базі `30c89057f407b5d3d5c39c217429bbd816bc7c65`. Аудит proposal, пункту 1.1.9, живого таймлайна після 1.1.8 та чинних гарантій agent-adapters не виявив суперечностей. Інші пункти не виконувалися; галочки залишено raf. Зміна має відкритий пункт 1.1, тому архівації немає.

## Зміна

`resolveRunnerRoutingSnapshot` використовує чинний `selectModel` для визначення наступного кандидата і перевіряє його CLI. Якщо кандидат недоступний, наступний визначається тією самою політикою з урахуванням уже отриманих відмов. Успішний запуск не чекає CLI, які не можуть змінити вибір. Runner list і остаточна відмова отримують повний snapshot; warnings і причини відмов збережено. Модель, effort, quotas, preferences та transitions визначає наявна політика.

`bin/raf.ts` вмикає Node compile cache перед динамічним імпортом CLI. CPU health worker виконується після прийнятого handshake разом із уже відкладеною health settlement. Ownership, fenced reservation, native identity, одноразова доставка brief, його підтверджене прийняття, sandbox та перевірка hook залишаються перед успішною відповіддю. Нових production-лімітів чи таймаутів немає.

## Перевірки

Усі команди мають префікс `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf` і стабільну групу `--group fix-raf-cli-live-latency/live-latency`. Повні команди, runId, відбори, SHA/dirty fingerprints, результати та integrity — у `test-executions.json`, `workspace.json` і `TestRunResult-integrity.json`.

RED `d8519611-0b8a-4de6-9c80-c3d23e798382`, `--phase red --files test/launch-overhead.test.ts`: 1 passed, 3 assertions failed, CLI/child exit 1. Scaffold helper тоді відтворював попереднє паралельне очікування всіх CLI. Дві предметні відмови доводять зайві probes та неправильний для targeted routing порядок fallback. Третя була спрощеною часовою сумою, де всі 1714 мс до brief приписувалися сторонньому probe. Цю суму не використано для приймання загального бюджету; власну часову перевірку звужено до очікування стороннього probe, а загальний бюджет перевіряє production CLI.

GREEN `f445c3ec-33ad-4768-96ca-ab259ee76081`, `--phase hotfix --files test/launch-overhead.test.ts test/launch-timeline.test.ts test/cli-agent-run-startup.test.ts test/production-runner-readiness-qa.test.ts test/production-codex-delivery-qa.test.ts test/production-runtime.test.ts`: 61 passed. Підготовлені тести прочитано лише після завершення незалежної початкової реалізації; їх не змінювали.

Подальші адресні прогони уточнювали нову повну фікстуру, production-код після першого GREEN не змінювався:

- `hotfix-2`: 5 passed, перший cold CLI, ще без великої історії та повної діагностики.
- `hotfix-3`: 5 passed, додано cardinalities; timeline diagnostic обрізано. Виявлено, що успадкований `baseArgs: []` робив command-access порожнім. Ці два прогони не доводять повний бюджет.
- `hotfix-4`: 5 passed, чинні sandbox arguments, справжній Codex app-server для перевірки hook; implement route, overhead 2817 мс.
- `hotfix-5`: assertions failed, відсутній `briefs/tasks/hotfix.md` у власній фікстурі. Це помилка підготовки фікстури, не RED дефекту.
- `hotfix-6`: 5 passed, cold CLI `--type hotfix`, окремий worktree, refresh і commit-port, overhead 2388 мс.

Остаточний прогін додатково перевіряє наявність `hooks.state` у фактичному invocation: бюджет включає перевірений і trusted hook, а не тільки непорожній інтервал. RunId `03577e46-54bb-4eb2-a72d-0a6dc7311e68`: 5 passed; wall 9862 мс, runner 7408 мс, raf overhead 2454 мс < 3000. Його повний результат і компактний часовий доказ — `hotfix-7.TestRunResult.json` та `fixture-green.json`.

Формула: wall процесу CLI мінус виміряні інтервали `readiness-start → readiness-end` і `delivery-start → delivery-end`. Це той самий поділ raf/runner, що використовувався в передачі 1.1.8. Cold CLI включає імпорти, assignment/routing, compose, admission, worker, command-access, tmux, lifecycle, handshake, settle і response. Синтетичний runner має затримки screen 531 мс, nativeId 2816 мс і accepted brief 2624 мс; перевіряється порядок nativeId ≤ delivery ≤ handshake. Справжній Codex app-server працює лише в приватному QA HOME без credentials; модель не викликається. Неактивний agy має 941 мс version probe з профілю, але не потрібний вибраному codex.

Фікстура містить 406 історичних finished sessions із payload по 18 КБ, 486 notices (115 pending), 227 майбутніх reminders і 300 intents. Вона не відтворює сім активних живих агентів і host occupancy. Це доказ фікстури; живий повтор після активації виконує main. Час runner у фікстурі не є обіцянкою часу живого Codex.

У всіх прогонах timeout=false, cleanup complete, remainingPids порожній. Остаточний GREEN має knownRed/unexecuted/unknown порожні, groupState=complete, nextAction=complete, timeoutCount=0. Вихідні TestRunResult скопійовано без перетворення з названих raf файлів; stderr і CLI code збережено окремо від child exitCode. Повний stderr RED відновлено з оригінального tool output власної сесії, без повторного запуску; `red.tool-output.json` зберігає джерело. Історичне обрізання diagnostic у hotfix-3 позначено самим TestRunResult; остаточний diagnostic не обрізаний. Partial resourceUsage означає неповноту телеметрії піків ресурсів, не незавершення тестів.

`node scripts/build.ts` пройшов; `git diff --check` пройшов. Повторів заради stderr не було.

## Production-профіль і межі

`profile-preparation.mjs` робить read-only backup живої SQLite й вимірює services на приватній копії: 360 sessions, 445 notices, 333 intents. Живий state не змінюється; запусків агентів і читання credentials немає. Результат `preparation-profile.json`: повний routing 944.9 мс, targeted 81.6 мс; selection model/effort/reason збіглися. Сторонній agy version probe — 941.1 мс. Це предметний доказ усуненої роботи, а не живий бюджет agent run. Початкову діагностику з неіснуючою complexity `medium` виправлено на чинну `ordinary`; вона не використовується як доказ виграшу.

## Самоперевірка читабельності

Область: базова ревізія вище та власні fingerprints у `workspace.json`; `bin/raf.ts`, `createAppRuntime` (snapshot і launchAgent), `createProductionServices.routingSnapshot`, `runProductionWorker` (перенесений health виклик), `resolveRunnerRoutingSnapshot`, власні дві тестові фікстури та діагностичний script.

Новий routing-компонент має одну відповідальність: наповнити availability snapshot за політикою кандидата або для повної діагностики. Вхідні catalog/snapshot/probe/selection явні; єдині мутації — локальні cliAvailable/cliReasons/cliWarnings через record. Цикл просувається лише після unavailable, успіх повертається явно, повний шлях збирає remaining probes паралельно. App handler явно передає один modelRequest і той самий policy до snapshot та selectModel. Production closure лише читає protocol/quotas/enablement і передає probe, без прихованої зміни моделі. Worker health має видиме місце після handshake; усі попередні launch перевірки збережені. Тестова історія винесена в seedHistory, конфігурація runner — в configureRunners; головна перевірка читається як setup → cold launch → timings → guarantees → budget. Власні регресії fallback/warnings/full diagnostics та незмінені readiness/delivery тести підтвердили поведінку. Сусідній незмінений борг поза областю не перероблявся.

## Передача

Точні доповнення registry та стан in-place — `registry-handoff.json`; conf комітить main, його автоматичні registry коміти не є власними комітами виконавця. Галочки не змінено.

Коміт root-документа відхилений файловими межами: `.git/index.lock: Read-only file system`, CLI 128. Це не зайнятий index.lock; lock не видалявся. Точний patch і команда/помилка — `tasks.patch` і `root-document-commit.json`; root tasks.md уже змінено in-place й потребує коміту main.

Стан адресної доставки — `communication.json`. MESSAGE_NOT_ACCEPTED означає, що відповідне повідомлення не доставлене; атомарний JSON-звіт залишається передачею для приймання raf. Push та активацію не виконували.
