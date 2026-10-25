# profile-raf-performance 2.4 — QA

Результат: доручені сценарії виконано. Живий Linux-стенд на чистому SHA `d12ca3d440c90ec7abfa1b1388cefe829699dc53`: **11 passed**, CLI **0**, зовнішній stderr порожній, cleanup complete, timeout відсутній. Main виконав стенд поза sandbox та передав read-only докази після secret scan (0 збігів). [Сирий summary](host-qa-d12ca3d/summary.json), [окремі CLI-коди й stderr](host-execution.json), [manifest](host-qa-d12ca3d.sha256): усі 33 SHA-256 локально звірено. Запуск: `node scripts/qa-cost-profile-host.ts /srv/dev/raf-profile-qa-evidence-d12ca3d`.

Стенд: Ubuntu 26.04.1 LTS, Linux 7.0.0-30-generic x86_64, Node v26.12.1, SQLite 3.54.0, tmux 3.6, Git 2.53.0, OpenSpec 1.14.3. Повні версії та шість conf fingerprints містяться в summary. Власні HOME/TMPDIR/SQLite; bugs опущено через підтримуваний no-sync контракт, runner синтетичний, але служба, tmux, worker і доставка production. Облікові дані не копіювалися; виклику моделі немає. Per-child CPU явно unavailable, загального повного CPU стенд не заявляє.

Живі перевірки:

- Порожній профіль, подальші commands/profile, збережена EMA; успішні command stats мають CLI 0, навмисна runtime-відмова CLI 1.
- Реальна служба start/status/stop, актуальність завершених етапів; усі scope command/service/worker, wall і self/child. Повторне читання не змінює завершений delivery-внесок.
- Production worker доставив brief рівно один раз. Restart служби та SIGKILL/restart не втратили завершені агрегати й не повторили доставку.
- Три конкурентні процеси пишуть у спільну SQLite. Self CPU 294.116 мс; незалежний process.cpuUsage envelope 298.033 мс. Недоступний helper CPU має null і пояснення.
- SIGKILL contributor зберіг завершені етапи, незавершений не фабрикувався, наступний процес доповнив ті самі агрегати.
- async_hooks зафіксував **0** PROCESSWRAP/Timeout/Immediate/TIMERWRAP для 40 меж профілю: додаткових spawn/poll профілю не виявлено.
- Whitelist полів та canary-перевірки: у профілі немає аргументів, brief, ідентичностей чи секретів. Навмисно пошкоджена primary SQLite дає явну помилку/ненульовий код, оригінальний файл збережено, fallback відсутній.

## Unit та виправлення в цьому запуску

Повні незмінені TestRunResult, tool envelopes, окремі CLI/child коди, точні команди, SHA/dirty provenance, selection, knownRed/unexecuted/unknown, timeout/cleanup, стан і nextAction усіх 12 прогонів — [run-index.json](run-index.json). Стабільні group/QA HOME/aggregate збережено між red, qa, змінами SHA і відбором.

- **profile-raf-performance/profile**, qa, runId `734ab306-0037-4891-96b3-a3c08cd3935e`: **130 passed**, CLI/child **0/0**, complete/complete. Чотири файли: raf-cost-profile, production-entry, production-service-ports, app-runtime. knownRed/unexecuted/unknown порожні; cleanup complete, timeout false.
- **complete-raf-flow-contracts/z387-regress**, qa, runId `02c0509e-bdea-4ad0-8e58-9738ecfb86e8`: **42 passed**, CLI/child **0/0**, complete/complete, порожні залишки.
- **complete-raf-flow-contracts/resource-wait**, qa, runId `3d2fe8d4-52af-4849-825b-e6105b8903b4`: зачеплені production-entry/service-ports **57 passed**, child **0**, CLI **1 assertions-failed** через збережені **12 чужих knownRed** (6 background-runtime, 5 service-entry, 1 service-host). Це **не pass усієї групи**. unexecuted/unknown порожні, cleanup complete, timeout false, idle/fix-implementation. За прямою вказівкою main ці старі дефекти лише зафіксовано, їхній агрегат не скинуто. Обидві чужі групи дозволені regressionGroups вибраного item 2.4.

Explicit red → fix → qa:

1. Invalid service budget створював SQLite до відмови. Red `691dd0cf-63ad-4240-abd9-5db0eb742dd8` → валідація service handlers до відкриття state в production-entry → відповідний тест зелений у наступних qa.
2. Дві застарілі recovery assertions суперечили background-runtime «Межі служби». Red `dabf142b-4ed1-4c82-9c5b-a26aa658a946` → точне збереження persisted session/reminder замість фіналізації службою → фінальний profile qa passed.
3. App fixture без readForcedCloseMetrics, UTC fixture після зміни health clock і застаріле очікування відсутності timing diagnostic: red `42a470b4-fa79-4ec3-9e42-56890d60f0bd` → чинні порти/UTC та явна redacted diagnostic зі збереженням primary error. Перша qa виявила неповну власну remediation assertion; виправлено без послаблення контракту, фінальна qa passed. Помилка fixture-порту не видається за продуктовий assertion-red; початковий setup failure не видається за red.
4. Живі red стенди [33c8c4a](host-red-33c8c4a/summary.json) та [e901144](host-red-e901144/summary.json): Git всередині main спричинив recursive copy, потім bugs.sections=[] відхилено чинним валідатором. Власні fixture виправлено separate-git-dir та підтримуваним optional bugs omission. Після цих виправлень живий d12ca3d passed. Первісні результати й manifest залишено незмінними.

Build, check:comments, host syntax і diff check мають код 0. Фінальний check:comments після завершення host script теж 0. Source-код після зеленого unit відбору не змінювався; наступні правки лише host fixture та докази.

## Межі доказів і завершення

Unit transport повертає об'єднаний output; незалежні байти stderr він не надає. Збережені повний tool envelope та весь незмінений JSON, але історичні *-stderr.txt є placeholder, **не доказом порожнього stderr**. Це явно описано в run-index. Живий host має справді окремі stdout/stderr файли. Ранні unit SHA відновлені з reflog; атомарних повних dirty snapshots на старті не було, тому чистий workspace для них не заявляється. Точний чистий SHA живого стенду підтверджено окремо.

Пункт 2.4 у tasks.md не змінювався: галочку ставить raf. У зміні лишаються інші відкриті пункти (4.x, 5.1), архівація не застосовується. Чужі незакомічені правки не включено. Push не виконувався.
