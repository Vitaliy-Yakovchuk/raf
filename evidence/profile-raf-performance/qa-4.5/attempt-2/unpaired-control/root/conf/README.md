# Налаштування проєктів

`projects.json` — профіль гілок і прив’язка середовищ кожного репозиторію. `null` означає відсутній етап; `environments` задає джерело версії, не команди чи дозволи створення інфраструктури. Це цільові налаштування, не доказ наявності гілок або стендів.

Порядок переходів — [product-release-flow](../openspec/specs/projects/orchestrator/product-release-flow/spec.md). Живі сесії й поточна діяльність зберігаються в SQLite raf, не в цьому файлі. `.gitmodules` задає отримання підмодулів, а не маршрут релізу.

`path` — main-підмодуль, `branchPaths` — точні шляхи робочих дерев. Для роботи вибирай branchPaths потрібної гілки, не path за замовчуванням. `usesSharedLibs` позначає споживачів. `shared-libs` має також pre-release/release для відповідних гілок продуктів.

Основні підмодулі завантажуються штатним Git. Додаткові каталоги — локальні Git worktree; для нового checkout їх треба створити за branchPaths із відповідних наявних refs, а за відсутності гілки — із джерела профілю. Створити локальне посилання shared-libs на однойменну гілку бібліотек; не замінювати наявний каталог і не перемикати зайняте дерево. Правило — [branch-directories](../openspec/specs/projects/orchestrator/branch-directories/spec.md).

`learning/`, `grok/` та `startups/` не є продуктовими проєктами: їх немає в projects.json, продуктовий flow і каталоги гілок до них не застосовуються.

`raf.json` — налаштування утиліти raf; початковий коефіцієнт EMA затверджено у Q55. Самі заміри живуть лише в SQLite.

`models.json` — каталог CLI, моделей, effort і максимальної складності та початкові значення перемикачів. Поточні enabled/disabled runner і ліміти зберігаються в SQLite raf; повторне читання конфігурації не скидає рішення main. Політика вибору — [model-routing](../openspec/changes/complete-raf-flow-contracts/specs/projects/raf/model-routing/spec.md). Наявність запису не доводить живу підтримку адаптера.

У models.json розділ routing задає порядок складностей, приклади класифікації, пріоритети CLI, переходи та можливі прив’язки ролей. Порожні списки пріоритетів/переходів і порожня мапа ролей означають відсутність таких явних налаштувань. Це змінювана політика конфігурації, не правила flow або вбудовані переваги raf.

Q61: команди raf runner enable/disable/list керують runner. initialEnabled у runners задає початковий стан; enabled у models — властивість каталогу, без окремої команди перемикання моделі.

Частини брифів запуску (runner × тип поточної задачі) — [briefs/README.md](briefs/README.md).

`raf-constants.json` — єдині визначення затверджених типів агентів/задач, результатів звіту, подій та їх видів ID, команд raf і посилань на значення параметрів. Переліки runners, моделей і складностей залишаються в models.json; вони не копіюються. Генерація CLI та help описана в projects/raf/cli-catalog; наявність команди в JSON ще не доводить її реалізації.

resourceWaitLevels у raf-constants.json визначає рівні очікування та їх пріоритет; resourceWait.grantIntervalMs у raf.json — глобальний інтервал видачі дозволів. recordDuration виключає resource wait зі статистики; requiresService позначає єдину команду, якій потрібна служба, — resource wait; решта команд працює прямими запитами до SQLite без служби (background-runtime «Межі служби raf»). reminderBindingActions — значення --event-action команд reminder add/update (активація або закриття за подією).

`temporary-exceptions.json` — єдине джерело тимчасових дозволів: межі, active, рішення власника та endCondition. Посилання в специфікації не діє після вимкнення, вилучення запису чи настання умови завершення.

`project-priorities.json` — порядок проєктів `projectOrder` і перелік призупинених `pausedProjects`, які main виключає з вибору роботи; джерело й адаптація старого списку зазначені всередині. Застосування — [agent-coordination](../openspec/specs/projects/orchestrator/agent-coordination/spec.md).

`flow.json` — єдині числові параметри flow: `unitTests` (мілісекунди та лічильники таймаутів), `resources` (частки, байти й нормалізований load), `retention` (мілісекунди), `documents` (рядки та діаграми), `startupContextReview.runsPerReview` (кількість завершених запусків між аналізами стартового контексту; 20 — рішення власника 2026-10-22, [startup-context-review](../openspec/changes/review-agent-startup-context/specs/projects/orchestrator/startup-context-review/spec.md)). `raf.json` містить `commandTiming.emaAlpha`, `commandTiming.sqliteOnlyMeanBudgetMs` та `resourceWait.grantIntervalMs`; ці значення не дублюються у flow чи коді. Історичні результати зберігають фактичні числа.

`raf.json#/state/fileName` визначає SQLite оперативного стану, `bugs.fileName` — окрему SQLite жуків/коментарів, `bugs.attachmentsDirectory` — кеш вкладень у ~/.raf. `bugs.attachmentCacheMaxBytes` — бюджет байтів кешу з очищенням за найдавнішим читанням агента, зафіксованим у базі жуків. `bugs.origin`, `actor`, `sections[]` (project, claim env, stand, назва запису секрету), строк токена, інтервал опитування, ліміт сторінки, timeout і `retry` — параметри синхронізації з dash; обґрунтування значень — design.md зміни add-raf-bug-sync. Синхронізація та ліниве завантаження — [bug-sync](../openspec/changes/add-raf-bug-sync/specs/projects/raf/bug-sync/spec.md); наявність шляхів не означає готовність реалізації.
