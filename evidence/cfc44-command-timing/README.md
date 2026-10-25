# QA complete-raf-flow-contracts:4.4

Результат пункту — **failed**: I1–I5 пройдено, I6 **unexecuted**. Немає доказу EMA запуску до завершення справжнього payload. Галочку 4.4 не змінено; архівація не застосовується. Це технічний блокер, а не відкладення за рішенням власника.

## Спостереження

| Сценарій | Фактичний результат | Докази |
| --- | --- | --- |
| I1 | Свіжа SQLite: відсутній рядок → 100 → 120 → 113 → 387.8; alpha 0.1, потім 0.4 з conf. UTC між початком і завершенням запису. Один canonical key; різні адресні args не створили інших ключів. | [SQL/заміри](I1.json), [команди](I1.command.txt), I1-address-a/b.json та окремі stdout/stderr |
| I2 | Два справжні процеси, внески 200/600 після 100: один рядок EMA 155, допустимий серіалізований порядок. Обидва exit 0. Реальний writer lock: exit 1, SQLite 5, 273.25 мс, без зміни рядка або іншої бази. | [SQL, команди й коди](I2.json), [оператор](I2.command.txt), I2-a/b/lock.stdout/.stderr |
| I3 | Реальний CLI, обгортка commands/profile/health; missing null, збережений 0, бюджет stats 1000, зовнішніх команд null. Наступний процес бачить попередній внесок. Зміна alpha 0.4 застосовується; conf відновлено. Help 0 / невідомі args 1 без доступного conf/state і без запису. | [оператор](I3.command.txt), I3-snapshot/next/alpha-change/help/parser.json/.stdout/.stderr |
| I4 | Успіх 0 і штатна runtime-помилка 1 дають по одному реальному внеску. SIGKILL після підтвердженого відкриття SQLite не додає внеску. Заблокована SQLite: CLI 1, без fallback; файл-заглушка збережений. | [оператор](I4.command.txt), I4-success/runtime-error/crash/state-refusal.json/.stdout/.stderr, [файли](I4-refusal-files.json) |
| I5 | 120 поточних сесій, 1200 нагадувань, 16 нових CLI-процесів: усі 0, по одному внеску. EMA 227.0311462818 → **539.6890658746107 мс < 1000 мс**, alpha 0.1. Серія 11340.85 мс; середній wall 705.11 мс; фактичні duration, відновлені з SQL-переходів, 559.00–761.45 мс. | [обсяг, заміри й SQL](I5.json), [точна підготовка/серія](I5-ready.command.txt), I5-00…15.json/.stdout/.stderr; I5-ready.exit.json = 0 |
| I6 | Ізольований tmux, main attach 0. Після виправлення inventory запуск агента не дістався runner/payload. Єдина повторна спроба на data-диску: CLI 1 RESOURCE_WAIT_FAILED, live reader unknown protection, expected matching committed permit, retrySafe false. | [результат](I6.json), [команда/SQL/код](I6-agent-run.json), [повний stderr](I6-agent-run.stderr), [main attach](I6-main-attach.json), [ручний оператор](I6-operator.mjs) |

I5 cold означає новий CLI-процес після заповнення; OS cache не очищали. Наступні 15 процесів мають теплий OS cache. 120 поточних сесій і 10 активних/очікуваних нагадувань на сесію перевищують дев'ять спостережених активних агентів; історичних рядків для збільшення обсягу не додавали. База 1,110,016 байтів, 271 сторінка по 4096. Це перевірка бюджету із conf, без нового порога або кількості повторів у production policy.

## Походження та ізоляція

I1–I5: окрема копія **committed** 9acb35ab1d1992ba1d99ea2fe86e00e21b70f7b2, що містить реалізацію 4.3 a4dd05b6ac і попередні докази 75d421deca. Чужі незакомічені правки зі спільного workspace до копії не потрапили. [stand.json](stand.json) зберігає версії й fingerprints, [operator.source.txt](operator.source.txt) — підготовку. Build каталогу завершився 0 (build-ready.stdout/.stderr); CLI використовує native Node TypeScript entry з побудованим dist/catalog.json. Node v26.12.1, SQLite 3.54.0, Linux 7.0.0-30-generic, TypeScript 6.0.3, Git 2.53.0, tmux 3.6.

Кожному CLI передано власні HOME/RAF_QA_HOME, RAF_ORCHESTRATOR_ROOT і TMPDIR до першого відкриття. Успадковані RAF_* і TMUX змінні прибрано. SQLite I1/I2 і CLI SQLite перебували поза Git у /tmp/cfc44-knKBT1. У JSON кожної CLI-операції є точний argv, середовище без секретів, UTC/wall, CLI exit, signal та SQL before/after. Окремого payload у I1–I5 немає: childExitCode null, не вигаданий 0.

Фінальний I6: [stand-I6.json](stand-I6.json), product SHA 6ac90fc946beea135ddb2f524d80616e5a37ec27; лише fixture actor окремим комітом 8d3a56ec5e4303bcb9355855da028557ba160c42. Власні код/TMPDIR на /srv/dev/work/orchestrator/raf-develop/.cfc44-I6, SQLite/HOME поза Git /tmp/cfc44-knKBT1/I6-data-home, власні CODEX_HOME і tmux socket. Рішення runner/model/effort залишено raf; жодного підставного runner, копіювання auth або послаблення gate. Версія runner в I6.json; payload не запущений, child exit невідомий. [I6-effective-policy.json](I6-effective-policy.json) і admission у stderr фіксують чинні пороги.

Фінальна спроба: ресурс data-dev після резерву 153637851136 байтів, але normalizedLoad 1.55875 перевищує normal 1.2 / hotfix 1.5. Подальше очікування відмовило через reader runId **ee08e714-de16-40ac-a65f-c5a4f89f6d13**, pending confirmed resource permit. Cleanup launch claims/reservation/report — released, pending порожній. Tmux kill-server 0. Попередній tmpfs-блокер з іншими замірами збережено як I6-tmpfs-*; повторів після фінального data-дискового RESOURCE_WAIT_FAILED немає. Protection gate не обходили, чужих reader-процесів не завершували.

З main узгоджено методику стенду та межу повторного використання profile-raf-performance: його production service/test/bug матрицю тут не дублювали. Старі докази методики не зараховували як нове проходження I6; готового живого timing-доказу main не мав.

## Знайдені дефекти та unit

1. Синтетичний UNIT_OPERATION_FAILED був відсутній у fixture errorCodes після запровадження strict compiled catalog. Спершу red ee40457c-784f-4bc3-aee9-0f7d89cd4ec4, потім fixture-only реєстрація й green 816408fa-9fa8-4a34-9b04-361be657a04a (48). Assertions збережені; production errorCodes/cli validation не послаблювали. Перетин погоджено з виконавцем 12.4 та передано main.
2. Справжній gate відтворив stale source proofs cli/service-entry/etchly-inventory на поточному committed HEAD. Red 10d61b06-25ac-4bb0-bae2-6d54040f7b0e (3 assertions), перегляд актуальних import boundaries, оновлення точних SHA256, green 2f5efa12-c5fc-4941-b048-f94cc93dd248 (54). Коміт **cb701b1afd61fe22922455883d3c9eadf730c4db** також містить fixture fix.
3. Наступний gate виявив незареєстрованого споживача TypeScript у test-run-etchly-integration.ts. Перевірено використання лише parser/AST, без plugin/module execution. Red 66e4dc3d-4038-4ba5-b115-56994a32eb44 (1 assertion), точна прив'язка hash до library consumer, green **c7c97e71-bae1-4753-8c5c-c05a502cbfc0 (56)**. Коміт **6ac90fc946beea135ddb2f524d80616e5a37ec27**. Dynamic-loader scanner та захисні вимоги не послаблено.

Для всіх unit запусків незмінні group complete-raf-flow-contracts/raf-command-timing, files test/command-timing.test.ts, той самий агрегат/HOME. [unit-runs.json](unit-runs.json) містить точні дозволені команди, SHA (відновлені за reflog), незакомічені правки, runId, CLI/child, knownRed/unexecuted/unknown, timeout/cleanup і наступну дію. Усі red — assertions-failed, а не setup/import failures. Останній QA: CLI/child 0/0, cleanup complete, timeout false/count 0, group complete/nextAction complete, усі залишкові масиви порожні. Єдине джерело unit timeout conf/flow.json#/unitTests/timeoutMs = 1200000; винятків не застосовано.

Обмеження capture: exec_command повернув об'єднаний stdout/stderr. Повний незмінений TestRunResult кожного запуску збережено окремим *.TestRunResult.json, CLI код — у *.capture.json, первинний stream — у *.merged.txt або toolResult.output. **Окремий unit stderr недоступний**, його не відновлювали здогадками і не називали порожнім. Це передано main; повного виконання вимоги окремого stderr не стверджуємо. Для ручних CLI та I6 stdout/stderr збережені окремо.

## Невдалі підготовки та cleanup

Початкові setup спроби також збережено й не зараховано як red/pass: відсутня залежність build, успадкований RAF root, неправильний export/readConfiguration, save замість putSession, переповнення tmpfs, неправильна Git topology/sparse fixture та absorbed-submodule worktree. I6-data-setup.json фіксує невдалий isolated commit із великим видаленням через неправильний корінь; його скинуто лише в стенді до product SHA. I6-data-setup-fixed.json і фінальний fixtureDiff підтверджують рівно один actor-файл поверх продукту. Робочі репозиторії від цього не змінювалися. Product loader refusals винесені окремо: I6-gate-refused-* / I6-library-refused-* та виправлені через red.

[cleanup.json](cleanup.json): перевірка /proc за власними cwd не знайшла живих процесів; жоден чужий процес не завершували. Фінальний fixture git status порожній. Обидва власні стенди видалено після збереження SQL, stdout/stderr і версій. Unit HOME/агрегат не видаляли й не міняли. Робочих HOME, SQLite, служб і tmux не торкалися. Тривалості не писали до Git-журналу продукту; цей каталог містить лише QA-докази.

[review.json](review.json) — незалежна офлайн-перевірка узгодженості вже збережених фактів; команда node evidence/cfc44-command-timing/review-evidence.mjs, exit 0. Вона не запускає сценарії повторно і не замінює непройдений I6. Подальша необхідна дія залишається в наявному відкритому 4.4: отримати перевірений committed permit/стенд і виконати I6, зберігши живий timing-критерій. Інших tasks не додано.
