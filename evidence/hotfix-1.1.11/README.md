# 1.1.11 — зайве очікування OpenSpec telemetry

База production: `3356e72258fd8d5f3ed5415566f5ae9121c95ee0`. Доручення актуальне: живий assignment займав 1303–1311 мс, бюджет raf-overhead не досягнуто. Предметний контракт — tasks.md:1.1.11, proposal.md і agent-run «Валідація доручення»; усі schema/source identity guards залишено.

Причина розриву з попередньою фікстурою: живий OpenSpec HOME має `telemetry.noticeSeen=true`. OpenSpec 1.14.3 перед поверненням CLI чекає мережевого flush телеметрії. Порожній fixture HOME цієї роботи не виконує, оскільки notice ще не показано. У `src/os-runtime.ts:executeCommand` внутрішні дочірні `openspec` отримують штатний `OPENSPEC_TELEMETRY=0`. HOME, schema selection, task parser, source guards, reservations, native identity, readiness, delivery, ліміти й таймаути не змінено. Решта executable зберігають передане середовище; caller environment не мутується.

[telemetry-profile.json](telemetry-profile.json) — незалежне порівняння справжнього OpenSpec в одному приватному HOME з noticeSeen=true: schema which 598.9 → 198.3 мс; instructions apply 642.4 → 282.1 мс. Коди 0, обсяги stdout однакові. Профіль використовує синтетичний anonymous ID; живий ID не зберігався.

## Живий обсяг і фікстура

[live-volume.json](live-volume.json) містить адресний інвентар: 106 активних змін, понад 2 МБ tasks.md, близько 221 КБ tasks.md limit-db-rows-read-per-query, розміри/відбитки JSON conf, розмір state.sqlite та агреговані SQL counts без payload. SQLite: 373 сесії, 5 активних, 458 notices, 416 reminders, 335 intents. Перевірка read-only не запускала живих агентів.

Нова фікстура використовує попередній production main CLI, реальні tmux/worker, sandbox, Codex app-server hook inspection, lifecycle, admission і response. Копіює всі активні openspec/changes; великий tasks.md додається до вибраної fixture change з окремими ID. Вона містить 107 активних змін, понад 2 МБ tasks.md загалом і ~221 КБ у вибраній зміні, 406 історичних та 5 активних агентів, 486 notices. Фінальне доповнення стану дає 416 reminders та 335 intents, із великими payload intents, як на живому стані. Конфігурація telemetry.noticeSeen=true відтворює доведену різницю HOME.

Runtime conf зберігає безпечні fixture overrides runners, проєктних шляхів, ресурсів і брифів; великий test-runs.json копіюється з поточного Orchestrator. Це не побайтова копія всього живого конфігу чи SQLite. Розміри й лічильники перевіряються окремо, не видаються за живий запуск. Синтетичні native screen/status і прийняття brief; їхні попередні затримки та всі assertions збережено. Бюджет віднімає лише readiness і delivery. Зміна shared helper — optional prepare callback та додаткова діагностика, без послаблення жодного assertion. Default другого параметра зберігає function.length=1 для node:test.

## Докази прогонів

Кожен `*.TestRunResult.json` — повна незмінена копія файла, названого raf. `*.stderr` відновлено дослівно з повного stderr tool output; stderr не обрізаний, хоча stdout великих JSON у tool output обрізався. CLI code збережено окремо від child exitCode у `*.cli-exit.json`. В усіх командах project=raf, незмінна group=`fix-raf-cli-live-latency/live-latency`; QA HOME автоматично визначив raf, він не змінювався для скидання агрегату.

- `red`: run `80422e8d-7462-4322-b79c-8a9738c0a03e`, phase red, `--files test/assignment-live-volume.test.ts`; assertion відсутнього telemetry opt-out, CLI/child=1. Production без фіксу.
- `red-volume`: run `5f1aae3a-0626-43f5-9cb8-dddd2c3ef962`, той самий відбір із доданою бюджетною регресією; два assertion failures, overhead **3411.261 мс**, assignment **1317 мс**, CLI/child=1. Production без фіксу. Повністю відтворено assignment живого запуску. Обсяг стану на цьому RED ще попередній (227 reminders, 300 intents); фінальна фікстура більша.
- `green-1`: run `876dde5b-3635-4b27-b6a2-4198ee6683f0`, phase hotfix, `--files test/assignment-live-volume.test.ts test/os-runtime.test.ts test/assignment-identity.test.ts test/launch-live-state.test.ts`; 105 passed, але outcome setup-failed через мій другий параметр shared helper, який node:test помилково трактував як callback. CLI/child=1. Нова бюджетна регресія пройшла: overhead **2377.492 мс**, assignment **506 мс**. Це не остаточний GREEN усього відбору. Сигнатуру виправлено, бюджетні файли повторно перевірено разом. Os-runtime та всі source identity регресії пройшли.

До остаточного тесту production та власні файли незакомічені на базовому HEAD; [workspace.json](workspace.json) містить їхні SHA-256 і перелік виключених чужих правок. Паралельні quality instrumentation файли не змінювалися і не включаються до власного коміту.

## Реєстр, передача та читабельність

[registry-handoff.json](registry-handoff.json) — повна передача: project=raf, profiles.node.unitFiles і groups[fix-raf-cli-live-latency/live-latency].files += test/assignment-live-volume.test.ts. Внесено in-place до RED; спільний реєстр комітить main. Helper не є окремим unit entry.

Область самоперевірки від базової ревізії: executeCommand, verifyLiveStateBudget, нові verifyLiveVolumeBudget/seedLivePlanningVolume/seedAdditionalState і telemetry regression. ExecuteCommand додає одне явне правило середовища за назвою executable; аргументи, stdin, exit/stderr, оброблення помилок і профілювання збережені. Prepare callback явно отримує fixture і повертає тільки діагностику; джерело змін стану видно в аргументі. Seed-компоненти окремо готують planning files і SQLite extra rows; SQL statements закриваються, cleanup всього запуску залишається у shared fixture. Основний вимір і assertions використовують попередній компонент без дублювання production launch logic. Немає нових користувацьких підписів чи обмежень. Build та diff --check пройшли.

[message-failures.json](message-failures.json) зберігає два `MESSAGE_NOT_ACCEPTED`, CLI 1: composer main містив unrelated input, completed=[], pending=[message-acceptance]; remediation — перевірити прийняття перед повтором і raf help agent message. Ці повідомлення не доставлені й не вважаються рішенням main. Атомарний звіт не залежить від доставки.

Активацію, push та живий повтор виконує main разом із паралельною quality instrumentation зміною. Живий бюджет <3 с тут не заявляється. Пункт 1.1 залишається відкритим, тому архівація не виконується.

## Остаточний GREEN

[green-final.TestRunResult.json](green-final.TestRunResult.json), run `3a70fa56-6b91-4327-bb5f-e8aac4fe7cef`: `node /srv/dev/work/orchestrator/raf-main/bin/raf.ts test run --project raf --phase hotfix --group fix-raf-cli-live-latency/live-latency --files test/assignment-live-volume.test.ts test/launch-live-state.test.ts`. **4 passed**, outcome=passed, CLI=0, child=0; knownRed/unexecuted/unknown=[], groupState=complete, nextAction=complete, timeoutCount=0, timedOut=false, cleanup.complete=true, remainingPids=[]. Попередні os-runtime/identity 102 перевірки залишаються passed у green-1; їх не повторювали після зміни лише fixture callback/seed. ResourceUsage має partial/unknown completeness; повних пікових ресурсів цей доказ не стверджує.

Фінальний великий fixture: 107 активних змін, tasks.md разом 2 066 765 байтів, вибраний tasks.md 221 542 байти; 406 historical + 5 running sessions, 486 notices, **416 reminders, 335 intents**. Поле `size` у shared diagnostic описує базову фікстуру; додаткові 189 reminders/35 intents враховані в `planningVolume.state`.

| Фікстура | raf-overhead, мс | assignment, мс | worker → command-access, мс | command-access, мс |
| --- | ---: | ---: | ---: | ---: |
| Живий обсяг + noticeSeen, без фіксу (RED) | 3411.261 | 1317 | 253 | 279 |
| Живий обсяг + noticeSeen, фінальний більший state (GREEN) | **2657.772** | **520** | 255 | 270 |
| Попередня live-state, фінальний GREEN | 2583.881 | 489 | 239 | 275 |

Workspace SHA і власні файли відповідають workspace.json; після остаточного тесту production і fixture code не змінювалися. Непрохідний green-1 збережено, не видано за повний pass. Група й QA HOME сталі в усіх прогонах. Фінальний conf fingerprint змінився через паралельну реєстрацію іншої зміни, відбір і timeoutCount збережено.

Документ tasks.md доповнено лише секцією перевірки 1.1.11, без зміни галочок. Власний root-коміт відмовив: CLI 128, `fatal: Unable to create '/srv/dev/work/orchestrator/.git/index.lock': Read-only file system`. Це відмова доступу, не зайнятий індекс; lock не видалявся. [tasks.patch](tasks.patch) — точний патч для main, [orchestrator-commit-blocker.json](orchestrator-commit-blocker.json) — команда/помилка. Документ уже внесено in-place, main має закомітити його разом зі спільним реєстром.

Остаточну передачу main доставлено: CLI 0, accepted=true, receipt `dd2ca156-32e1-4a03-8290-62fcf0ac0d5f`. Вона містить SHA code commit `2171018a38de2df43b9a3781463fa6c3d89a4751`, registry additions, точний tasks.patch, root commit access blocker та необхідність спільної активації/живого повтору. [completion.json](completion.json) фіксує receipt і залишок. Перший виклик commit port із директорією доказів відхилено (CLI1: Explicit hotfix file paths required); повтор із кожним власним файлом явно успішний, чужих файлів не комічено.
